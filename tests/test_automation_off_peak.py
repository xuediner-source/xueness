"""Off-peak (闲时) queue behaviour: window, claims, approval, history and boundaries.

Everything runs on an injected clock, an isolated state directory and a local fake
workflow launch: no network, no real model and no scheduler thread.
"""
from datetime import datetime, timezone
from io import StringIO
import argparse
import contextlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from xueness import plugin_runtime
from xueness.bundled_plugins.automation import off_peak
from xueness.bundled_plugins.automation.off_peak import OffPeakQueue, in_window, next_window_open
from xueness.bundled_plugins.automation.plugin import dispatch, execute_cli, register_cli
from xueness.bundled_plugins.automation.scheduler import Automations
from xueness.bundled_plugins.workflows.workflows import WorkflowStore
from xueness.core import Gate, Store
from xueness.plugin_runtime import PluginDisabled, dispatch_http, set_enabled
from xueness.tool_contract import bind_execution
from xueness.tool_registry import dispatch as tool_dispatch

TZ = 'Asia/Shanghai'
#: Local midnight of a fixed date, so window maths never depends on the runner clock.
MIDNIGHT = int(datetime(2026, 10, 5, 0, 0, tzinfo=ZoneInfo(TZ)).timestamp())
WINDOW = {'start': '00:00', 'end': '08:00'}


def at(hour, minute=0, day=0):
    return MIDNIGHT + day * 86_400 + hour * 3_600 + minute * 60


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


class FakeLaunch:
    """Records every launch and leaves the run in an active (queued) state."""

    def __init__(self, state, error=None):
        self.state = state
        self.error = error
        self.calls = []

    def __call__(self, workflow_id, approved=False, allow_real=False, expected_digest=None):
        self.calls.append({'workflowId': workflow_id, 'approved': approved, 'allowReal': allow_real})
        if self.error is not None:
            raise self.error
        return WorkflowStore(self.state).update(
            workflow_id, lambda record: record.update(status='queued'))


class OffPeakTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / 'state'
        self.state.mkdir()
        self.root = self.base / 'work'
        self.root.mkdir()
        self.now = at(1)

    def queue(self, allow_real=True, idle_check=None, now=None):
        return OffPeakQueue(self.state, clock=Clock(self.now if now is None else now),
                            allow_real_host=allow_real, idle_check=idle_check)

    def task(self, **overrides):
        data = {'prompt': '整理本周的构建日志', 'name': '周报', 'root': str(self.root),
                'confirm': True, 'allowReal': True}
        data.update(overrides)
        return self.queue().add(data)

    def statuses(self, outcomes):
        return [item['status'] for item in outcomes]

    # --------------------------------------------------------------- queue edits

    def test_add_list_cancel_round_trip(self):
        first = self.task()
        second = self.task(name='清理')
        queue = self.queue()
        self.assertEqual([row['id'] for row in queue.list()], [first['id'], second['id']])
        self.assertEqual(queue.get(first['id'])['status'], 'queued')
        self.assertEqual(queue.cancel(second['id'])['status'], 'cancelled')
        self.assertEqual([row['status'] for row in queue.list()], ['queued', 'cancelled'])
        self.assertEqual(queue.overview()['settings']['window'], WINDOW)
        with self.assertRaises(ValueError):
            queue.cancel('missing')

    def test_add_rejects_unsafe_input_and_unknown_fields(self):
        for data in ({'root': str(self.root)},
                     {'prompt': 'x', 'root': str(self.base / 'missing')},
                     {'prompt': 'x', 'root': 'relative/path'},
                     {'prompt': 'x' * 5001, 'root': str(self.root)},
                     {'prompt': 'x', 'root': str(self.root), 'onlyWhenIdle': 'yes'},
                     {'prompt': 'x', 'root': str(self.root), 'deadlineSeconds': 5},
                     {'prompt': 'x', 'root': str(self.root), 'confirm': 'yes'},
                     {'prompt': 'x', 'root': str(self.root),
                      'window': {'start': '25:00', 'end': '06:00'}},
                     {'prompt': 'x', 'root': str(self.root), 'timezone': 'Nowhere/City'},
                     {'prompt': 'x', 'root': str(self.root), 'import': 'os'}):
            with self.assertRaises(ValueError, msg=json.dumps(data)):
                self.queue().add(data)
        self.assertEqual(self.queue().list(), [])

    def test_queue_capacity_and_window_settings_are_data_only(self):
        for index in range(off_peak.MAX_TASKS):
            self.task(name='t%d' % index)
        with self.assertRaises(ValueError):
            self.task(name='overflow')
        queue = self.queue()
        self.assertEqual(queue.settings(), {'window': WINDOW, 'timezone': None})
        saved = queue.save_settings({'window': {'start': '22:00', 'end': '06:00'}, 'timezone': TZ})
        self.assertEqual(saved['window']['start'], '22:00')
        self.assertEqual(queue.settings()['timezone'], TZ)
        with self.assertRaises(ValueError):
            queue.save_settings({'window': {'start': '22:00', 'end': '22:00'}})
        with self.assertRaises(ValueError):
            queue.save_settings({'schedule': '* * * * *'})

    def test_oversized_and_corrupt_state_files_are_refused(self):
        (self.state / 'offpeak.json').write_bytes(b'[' + b' ' * off_peak.MAX_QUEUE_BYTES + b']')
        with self.assertRaises(ValueError):
            self.queue().list()
        (self.state / 'offpeak.json').write_text('{not json', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.queue().list()
        (self.state / 'offpeak.json').write_text('{"id": "not-a-list"}', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.queue().list()
        (self.state / 'offpeak.json').write_text('[]', encoding='utf-8')
        (self.state / 'offpeak-settings.json').write_text('{"window": {"schedule": "*"}}',
                                                          encoding='utf-8')
        with self.assertRaises(ValueError):
            self.queue().settings()

    def test_history_entries_stay_bounded(self):
        row = self.task()
        for index in range(off_peak.MAX_HISTORY + 10):
            off_peak._append_history(row, {'id': 'x%d' % index, 'at': index, 'status': 'claimed'})
        self.assertEqual(len(row['history']), off_peak.MAX_HISTORY)
        self.assertEqual(row['history'][-1]['id'], 'x%d' % (off_peak.MAX_HISTORY + 9))

    # -------------------------------------------------------------- idle windows

    def test_window_spans_midnight_and_reports_the_next_opening(self):
        night = {'start': '22:00', 'end': '06:00'}
        self.assertTrue(in_window(at(23, 30), night, TZ))
        self.assertTrue(in_window(at(5, 59), night, TZ))
        self.assertFalse(in_window(at(6), night, TZ))
        self.assertFalse(in_window(at(12), night, TZ))
        self.assertEqual(next_window_open(at(12), night, TZ), at(22))
        self.assertEqual(next_window_open(at(23), night, TZ), at(22, day=1))
        self.assertTrue(in_window(at(0), WINDOW, TZ))
        self.assertFalse(in_window(at(8), WINDOW, TZ))
        self.assertEqual(next_window_open(at(1), WINDOW, TZ), at(0, day=1))

    def test_window_reads_the_local_wall_clock_not_utc(self):
        local_one_am = at(1)
        self.assertEqual(datetime.fromtimestamp(local_one_am, timezone.utc).hour, 17)
        self.assertTrue(in_window(local_one_am, WINDOW, TZ))
        self.assertFalse(in_window(local_one_am, {'start': '17:00', 'end': '18:00'}, TZ))
        self.assertTrue(in_window(local_one_am, {'start': '17:00', 'end': '18:00'}, 'UTC'))

    # -------------------------------------------------------------- window ticks

    def test_task_waits_for_the_window_then_claims_exactly_once(self):
        created = self.task()
        launch = FakeLaunch(self.state)
        with patch.object(WorkflowStore, 'launch', launch):
            self.assertEqual(self.queue(now=at(9, 30)).tick(), [])
            self.assertEqual(self.queue().get(created['id'])['status'], 'queued')
            self.assertEqual(launch.calls, [])
            outcomes = self.queue(now=at(0, 5, day=1)).tick()
            self.assertEqual(self.statuses(outcomes), ['started'])
            row = self.queue().get(created['id'])
            self.assertEqual(row['status'], 'running')
            # One entry per attempt, updated in place like the cron history.
            self.assertEqual([item['status'] for item in row['history']], ['started'])
            self.assertEqual(row['history'][0]['id'], row['runId'])
            self.assertEqual(row['history'][0]['workflowId'], row['workflowId'])
            self.assertEqual(len(launch.calls), 1)
            self.assertEqual(launch.calls[0]['approved'], True)
            self.assertEqual(launch.calls[0]['allowReal'], True)
            # A second pass in the same window must not run the task twice.
            self.assertEqual(self.queue(now=at(0, 6, day=1)).tick(), [])
            self.assertEqual(self.queue(now=at(0, 7, day=1)).tick(), [])
            self.assertEqual(len(launch.calls), 1)
            self.assertEqual(self.queue().get(created['id'])['status'], 'running')

    def test_unattended_run_needs_approval_and_the_host_provider_gate(self):
        unapproved = self.task(confirm=False)
        launch = FakeLaunch(self.state)
        with patch.object(WorkflowStore, 'launch', launch):
            outcomes = self.queue().tick()
            self.assertEqual(self.statuses(outcomes), ['awaiting_approval'])
            self.assertEqual(outcomes[0]['error'], 'operator approval is required')
            held = self.queue().get(unapproved['id'])
            self.assertEqual(held['status'], 'queued')
            self.assertGreater(held['holdUntil'], self.now)
            self.assertEqual(self.queue().tick(), [])
            self.assertEqual(launch.calls, [])
            no_real = self.task(name='需真实服务商', allowReal=False)
            self.assertEqual(self.statuses(self.queue(allow_real=False).tick()),
                             ['awaiting_approval'])
            self.assertEqual(self.queue().get(no_real['id'])['history'][-1]['error'],
                             'real provider disabled by host')
            self.assertEqual(launch.calls, [])

    def test_approving_a_queued_task_makes_it_eligible_again(self):
        row = self.task(confirm=False)
        queue = self.queue()
        launch = FakeLaunch(self.state)
        with patch.object(WorkflowStore, 'launch', launch):
            queue.tick()
            approved = queue.approve(row['id'], allow_real=True, confirmed=True)
            self.assertTrue(approved['approved'])
            self.assertIsNone(approved['holdUntil'])
            self.assertEqual(self.statuses(self.queue().tick()), ['started'])
            self.assertEqual(len(launch.calls), 1)
        with self.assertRaises(ValueError):
            self.queue().approve(row['id'], confirmed=False)

    def test_only_when_idle_waits_for_a_quiet_host(self):
        self.task(name='空闲才跑', onlyWhenIdle=True)
        with patch.object(WorkflowStore, 'launch', FakeLaunch(self.state)):
            self.assertEqual(self.queue(idle_check=lambda: False).tick(), [])
            self.assertEqual(self.queue().list()[0]['status'], 'queued')
            self.assertEqual(self.statuses(self.queue(idle_check=lambda: True).tick()), ['started'])
        self.assertEqual(self.queue().list()[0]['status'], 'running')

    def test_launch_failure_and_timeout_are_recorded_in_history(self):
        row = self.task()
        refused = FakeLaunch(self.state, error=ValueError('real model execution is not enabled'))
        with patch.object(WorkflowStore, 'launch', refused):
            self.assertEqual(self.statuses(self.queue().tick()), ['failed'])
        after = self.queue().get(row['id'])
        self.assertEqual(after['status'], 'queued')
        self.assertEqual(after['history'][-1]['status'], 'failed')
        self.assertIn('real model execution', after['history'][-1]['error'])
        self.assertGreater(after['holdUntil'], at(8))

        hanging = self.task(name='卡住的跑')
        with patch.object(WorkflowStore, 'launch', FakeLaunch(self.state)):
            self.assertEqual(self.statuses(self.queue().tick()), ['started'])
        running = self.queue().get(hanging['id'])
        self.assertEqual(running['deadlineSeconds'], off_peak.DEFAULT_DEADLINE)
        self.assertEqual(self.queue(now=at(1, 30)).tick(), [])
        self.assertEqual(self.queue().get(hanging['id'])['status'], 'running')
        self.assertEqual(self.statuses(self.queue(now=at(7, 59)).tick()), ['failed'])
        settled = self.queue().get(hanging['id'])
        self.assertEqual(settled['status'], 'failed')
        self.assertIn('timed out', settled['history'][-1]['error'])
        self.assertEqual(WorkflowStore(self.state).load(settled['workflowId'])['status'],
                         'stopping')

    def test_completed_workflow_settles_the_task(self):
        row = self.task()
        launch = FakeLaunch(self.state)
        with patch.object(WorkflowStore, 'launch', launch):
            self.queue().tick()
            running = self.queue().get(row['id'])
            WorkflowStore(self.state).update(running['workflowId'],
                                             lambda record: record.update(status='completed'))
            self.assertEqual(self.statuses(self.queue().tick()), ['completed'])
            self.assertEqual(self.queue().tick(), [])
            self.assertEqual(len(launch.calls), 1)
        done = self.queue().get(row['id'])
        self.assertEqual(done['status'], 'completed')
        self.assertEqual(done['history'][-1]['status'], 'completed')

    def test_cancel_stops_a_running_task_and_rejects_reuse(self):
        row = self.task()
        with patch.object(WorkflowStore, 'launch', FakeLaunch(self.state)):
            self.queue().tick()
        cancelled = self.queue().cancel(row['id'])
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertEqual(WorkflowStore(self.state).load(cancelled['workflowId'])['status'],
                         'stopping')
        with self.assertRaises(ValueError):
            self.queue().run_now(row['id'])
        with self.assertRaises(ValueError):
            self.queue().approve(row['id'], confirmed=True)

    def test_cancel_during_launch_stops_the_published_workflow(self):
        row = self.task()
        entered, release = threading.Event(), threading.Event()
        outcomes, errors = [], []

        def blocked_launch(store, workflow_id, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError('launch barrier timed out')
            return FakeLaunch(self.state)(workflow_id, **kwargs)

        def tick():
            try:
                outcomes.extend(self.queue().tick())
            except BaseException as error:
                errors.append(error)

        with patch.object(WorkflowStore, 'launch', blocked_launch):
            worker = threading.Thread(target=tick)
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                cancelled = self.queue().cancel(row['id'])
                self.assertEqual(cancelled['status'], 'cancelled')
                self.assertIsNotNone(cancelled['workflowId'])
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.statuses(outcomes), ['cancelled'])
        final = self.queue().get(row['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual(WorkflowStore(self.state).load(final['workflowId'])['status'], 'stopping')
        self.assertEqual(self.queue().tick(), [])

    def test_cancel_during_create_never_launches_the_workflow(self):
        row = self.task()
        create = WorkflowStore.create

        def cancelling_create(store, *args, **kwargs):
            run = create(store, *args, **kwargs)
            self.queue().cancel(row['id'])
            return run

        with patch.object(WorkflowStore, 'create', cancelling_create), patch.object(WorkflowStore, 'launch') as launch:
            self.assertEqual(self.statuses(self.queue().tick()), ['cancelled'])
            launch.assert_not_called()
        final = self.queue().get(row['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual(WorkflowStore(self.state).load(final['workflowId'])['status'], 'cancelled')

    def test_launch_failure_cannot_requeue_a_cancelled_task(self):
        row = self.task()

        def cancelled_failure(store, workflow_id, **kwargs):
            self.queue().cancel(row['id'])
            raise OSError('launch failed after cancellation')

        with patch.object(WorkflowStore, 'launch', cancelled_failure):
            self.assertEqual(self.statuses(self.queue().tick()), ['cancelled'])
        final = self.queue().get(row['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertIsNone(final['holdUntil'])
        self.assertEqual(self.queue().tick(), [])

    def test_run_now_skips_the_window_but_never_the_gates(self):
        waiting = self.task(confirm=False)
        held = self.queue(now=at(15)).run_now(waiting['id'])
        self.assertEqual(held['status'], 'awaiting_approval')
        self.assertEqual(self.queue().get(waiting['id'])['status'], 'queued')
        ready = self.task(name='立即跑')
        launch = FakeLaunch(self.state)
        with patch.object(WorkflowStore, 'launch', launch):
            self.assertEqual(self.queue(now=at(15)).run_now(ready['id'])['status'], 'started')
            self.assertEqual(len(launch.calls), 1)
        self.assertEqual(self.queue().get(ready['id'])['status'], 'running')
        with self.assertRaises(ValueError):
            self.queue().run_now(ready['id'])

    # -------------------------------------------------------------- plugin edges

    def test_disabled_plugin_closes_queue_http_and_cli(self):
        row = self.task()
        set_enabled(self.state, 'automation', False)
        queue = self.queue()
        with self.assertRaises(PluginDisabled):
            queue.tick()
        with self.assertRaises(PluginDisabled):
            queue.add({'prompt': 'later', 'root': str(self.root)})
        for method, parts in (('GET', ['api', 'automation', 'offpeak']),
                              ('POST', ['api', 'automation', 'offpeak']),
                              ('DELETE', ['api', 'automation', 'offpeak', row['id']]),
                              ('GET', ['api', 'automation', 'offpeak', 'settings'])):
            code, body = dispatch_http(method, parts, {}, {'confirmed': True},
                                       {'state_dir': self.state})
            self.assertEqual(code, 403, body)
            self.assertEqual(body['plugin'], 'automation')
        self.assertEqual(dispatch('GET', ['api', 'automation', 'offpeak'], {}, {},
                                  {'state_dir': self.state})[0], 403)
        set_enabled(self.state, 'automation', True)
        set_enabled(self.state, 'workflows', False)
        code, body = dispatch_http('GET', ['api', 'automation', 'offpeak'], {}, {},
                                   {'state_dir': self.state})
        self.assertEqual(code, 403)
        self.assertEqual(body['plugin'], 'automation')
        blocked = next(item for item in plugin_runtime.catalog(self.state)
                       if item['id'] == 'automation')
        self.assertEqual(blocked['blockedBy'], ['workflows'])
        self.assertFalse(blocked['effective'])
        set_enabled(self.state, 'workflows', True)
        self.assertEqual(self.queue().get(row['id'])['status'], 'queued')

    def test_http_surface_serves_queue_cancel_and_approval_rules(self):
        ctx = {'state_dir': self.state, 'allow_real': False}
        self.assertEqual(dispatch('GET', ['api', 'automation', 'offpeak'], {}, {}, ctx)[0], 200)
        code, body = dispatch('POST', ['api', 'automation', 'offpeak'], {},
                              {'prompt': '整理日志', 'root': str(self.root)}, ctx)
        self.assertEqual(code, 201)
        task_id = body['task']['id']
        self.assertFalse(body['task']['approved'])
        self.assertEqual(dispatch('POST', ['api', 'automation', 'offpeak', task_id, 'approve'], {},
                                  {'confirmed': True, 'allowReal': True}, ctx)[0], 403)
        self.assertEqual(dispatch('POST', ['api', 'automation', 'offpeak', task_id, 'approve'], {},
                                  {'allowReal': False}, ctx)[0], 400)
        code, body = dispatch('POST', ['api', 'automation', 'offpeak', task_id, 'approve'], {},
                              {'confirmed': True}, ctx)
        self.assertEqual(code, 200)
        self.assertTrue(body['task']['approved'])
        code, body = dispatch('GET', ['api', 'automation', 'offpeak', 'settings'], {}, {}, ctx)
        self.assertEqual((code, body['settings']['window']), (200, WINDOW))
        code, body = dispatch('POST', ['api', 'automation', 'offpeak', 'settings'], {},
                              {'window': {'start': '01:00', 'end': '05:00'}}, ctx)
        self.assertEqual((code, body['settings']['window']['start']), (200, '01:00'))
        code, body = dispatch('DELETE', ['api', 'automation', 'offpeak', task_id], {}, {}, ctx)
        self.assertEqual((code, body['cancelled']), (200, task_id))
        self.assertEqual(dispatch('PUT', ['api', 'automation', 'offpeak'], {}, {}, ctx)[0], 405)
        self.assertEqual(dispatch('POST', ['api', 'automation', 'offpeak', 'missing', 'run'], {},
                                  {}, ctx)[0], 400)
        self.assertEqual(dispatch('GET', ['api', 'automations'], {}, {}, ctx)[0], 200)
        self.assertIsNone(dispatch('GET', ['api', 'sessions'], {}, {}, ctx))

    def test_cli_offpeak_group_queues_lists_and_cancels(self):
        parser = argparse.ArgumentParser(prog='xueness')
        parser.add_argument('--state', type=Path)
        register_cli(parser.add_subparsers(dest='cmd'))

        def run(*argv):
            args = parser.parse_args(['--state', str(self.state), 'automation', 'offpeak']
                                     + list(argv))
            out, err = StringIO(), StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = execute_cli(args)
            return code, out.getvalue(), err.getvalue()

        code, text, _ = run('add', '整理日志', '--root', str(self.root))
        self.assertEqual((code, '"status": "queued"' in text), (0, True), text)
        task_id = self.queue().list()[0]['id']
        code, text, _ = run('settings', '--start', '02:00', '--end', '04:00', '--timezone', TZ)
        self.assertEqual(code, 0, text)
        self.assertEqual(self.queue().settings()['window'], {'start': '02:00', 'end': '04:00'})
        code, text, _ = run('list')
        self.assertEqual((code, task_id in text), (0, True), text)
        code, _, err = run('approve', task_id)
        self.assertEqual((code, '--approve-execution' in err), (1, True), err)
        code, text, _ = run('approve', task_id, '--approve-execution')
        self.assertEqual(code, 0, text)
        self.assertTrue(self.queue().get(task_id)['approved'])
        code, text, _ = run('cancel', task_id)
        self.assertEqual((code, json.loads(text)['cancelled']), (0, task_id))
        self.assertEqual(self.queue().get(task_id)['status'], 'cancelled')
        code, _, err = run('run-now', task_id)
        self.assertEqual((code, '已开始或已结束' in err), (1, True), err)
        set_enabled(self.state, 'automation', False)
        code, _, err = run('list')
        self.assertEqual((code, 'plugin disabled' in err), (1, True), err)

    def test_cron_schedules_keep_working_next_to_the_queue(self):
        store = Automations(self.state)
        item = store.save({'name': 'test', 'enabled': False, 'schedule': '* * * * *',
                           'workflow': {'root': str(self.root),
                                        'nodes': [{'id': 'a', 'argv': ['echo', 'hi']}]}})
        self.task()
        store.approve(item['id'])
        with patch.object(WorkflowStore, 'launch', FakeLaunch(self.state)):
            self.assertEqual(store.run(item['id'])['status'], 'started')
        self.assertEqual(len(self.queue().list()), 1)
        self.assertEqual(self.queue().overview()['tasks'][0]['name'], '周报')

    # ------------------------------------------------------------------ the tool

    def test_tool_queues_only_for_operator_approval_and_respects_the_gate(self):
        store = Store(self.state)
        args = {'prompt': '整理日志', 'name': '工具'}
        with bind_execution(store=store, state_dir=self.state):
            denied = tool_dispatch(self.root, Gate(self.root), 'offpeak_create', dict(args))
            self.assertFalse(denied['ok'])
            self.assertEqual(denied['error'], 'denied')
            self.assertEqual(self.queue().list(), [])
            queued = tool_dispatch(self.root, Gate(self.root, allow_exec=True), 'offpeak_create',
                                   dict(args))
            self.assertTrue(queued['ok'], queued)
            self.assertEqual(queued['queuePosition'], 1)
        row = self.queue().list()[0]
        self.assertEqual(row['root'], str(self.root.resolve()))
        self.assertEqual(row['prompt'], '整理日志')
        self.assertFalse(row['approved'])
        self.assertEqual(row['status'], 'queued')
        set_enabled(self.state, 'automation', False)
        with bind_execution(store=store, state_dir=self.state):
            self.assertEqual(tool_dispatch(self.root, Gate(self.root, allow_exec=True),
                                           'offpeak_create', dict(args)),
                             {'ok': False, 'error': 'plugin disabled'})
        self.assertEqual(len(self.queue().list()), 1)

    def test_route_owner_tool_owner_and_manifest_registration(self):
        for parts in (['api', 'automation', 'offpeak'],
                      ['api', 'automation', 'offpeak', 'x', 'run'],
                      ['api', 'automation', 'offpeak', 'settings'],
                      ['api', 'automations']):
            self.assertEqual(plugin_runtime.route_owner(parts), 'automation', parts)
        self.assertEqual(plugin_runtime.tool_owner('offpeak_create'), 'automation')
        manifest = plugin_runtime._manifests()['automation']
        self.assertIn('off_peak', manifest['modules'])
        self.assertIn('automation/offpeak', manifest['httpFamilies'])
        self.assertIn('offpeak_create', manifest['tools'])
        self.assertIn('automation.off_peak', [item['id'] for item in manifest['features']])


if __name__ == '__main__':
    unittest.main()
