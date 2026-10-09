"""sessions.cancel_receipt: stop says what it actually cancelled.

The default stop body stays {id, stopping, status, cancelled_tasks}. The
receipt is an extra object on the same 200, and only when the flag is true.
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import web
from xueness.bundled_plugins.sessions import cancel_receipt
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import set_enabled


LEGACY_KEYS = {'id', 'stopping', 'status', 'cancelled_tasks'}


class BuildTests(unittest.TestCase):
    def test_outcomes(self):
        idle = cancel_receipt.build('sid', busy=False, tasks=[])
        self.assertEqual(idle['outcome'], 'idle')
        self.assertEqual(idle['reason'], 'nothing_running')
        self.assertEqual(idle['works'], [{
            'workId': 'sid', 'kind': 'session', 'outcome': 'idle',
        }])

        rejected = cancel_receipt.build('sid', busy=False, tasks=[{
            'workId': 'task-1', 'outcome': 'rejected', 'summary': 'secret prompt',
        }])
        self.assertEqual(rejected['outcome'], 'rejected')
        self.assertEqual(rejected['reason'], 'not_running')
        self.assertEqual(rejected['works'][1], {
            'workId': 'task-1', 'kind': 'task', 'outcome': 'rejected',
            'reason': 'not_running',
        })
        self.assertNotIn('secret prompt', json.dumps(rejected))

        cancelled = cancel_receipt.build('sid', busy=False, tasks=[
            {'workId': 'task-1', 'outcome': 'cancelled'},
            {'workId': 'task-2', 'outcome': 'rejected'},
        ])
        self.assertEqual(cancelled['outcome'], 'cancelled')
        self.assertNotIn('reason', cancelled)

        busy = cancel_receipt.build('sid', busy=True, tasks=[
            {'workId': 'task-1', 'outcome': 'cancelled'},
        ])
        self.assertEqual(busy['outcome'], 'stop_requested')
        self.assertEqual(busy['works'][0]['outcome'], 'stop_requested')
        self.assertEqual(busy['works'][1]['outcome'], 'cancelled')

    def test_work_id_is_a_short_printable_copy(self):
        raw = 'task-\n' + ('p' * 100)
        body = cancel_receipt.build('s', busy=False, tasks=[{
            'workId': raw, 'outcome': 'cancelled',
        }])
        copied = body['works'][1]['workId']
        self.assertNotIn('\n', copied)
        self.assertLessEqual(len(copied), cancel_receipt.MAX_WORK_ID)
        self.assertTrue(copied.startswith('task-'))

    def test_flag_requires_real_true(self):
        self.assertFalse(cancel_receipt.enabled(None))
        self.assertFalse(cancel_receipt.enabled({}))


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class _Registry:
    def __init__(self, tasks, cancel_result=False):
        self.tasks = tasks
        self.cancel_result = cancel_result
        self.cancelled = []

    def list(self, parent):
        return [dict(task) for task in self.tasks if task.get('parent', parent) == parent]

    def cancel(self, task_id):
        self.cancelled.append(task_id)
        return self.cancel_result


class StopReceiptRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project',
                                     allow_real=False, csrf='test-csrf-token')
        self.server = _start(self.ctx)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.sid = self.ctx['store'].new('test task', self.ctx['web_runs'])['id']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _enable(self, enabled=True):
        save_settings(self.ctx['state_dir'],
                      {'general': {'sessionsCancelReceiptEnabled': enabled}})

    def _stop(self, sid=None, csrf='test-csrf-token', method='POST'):
        sid = self.sid if sid is None else sid
        header = {'Content-Type': 'application/json'}
        if csrf is not None:
            header['X-CSRF-Token'] = csrf
        data = b'{}' if method == 'POST' else None
        req = urllib.request.Request(self.base + f'/api/sessions/{sid}/stop',
                                     data=data, headers=header, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read()
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    body = {'error': raw.decode('utf-8', 'replace')}
                return exc.code, body
            finally:
                exc.close()

    def test_flag_off_keeps_the_legacy_body(self):
        live = self.ctx['task_registry'].record(
            'task-off', parent_session=self.sid, agent='a', prompt='hidden', root='/tmp')
        code, payload = self._stop()
        self.assertEqual(code, 200)
        self.assertEqual(set(payload), LEGACY_KEYS)
        self.assertEqual(payload['id'], self.sid)
        self.assertFalse(payload['stopping'])
        self.assertEqual(payload['cancelled_tasks'], [live['id']])
        self.assertEqual(self.ctx['task_registry'].get(live['id'])['status'], 'cancelled')
        self.assertNotIn('hidden', json.dumps(payload))

    def test_idle_receipt(self):
        self._enable(True)
        code, payload = self._stop()
        self.assertEqual(code, 200)
        self.assertTrue(LEGACY_KEYS <= set(payload))
        self.assertEqual(payload['schema'], 'xueness.cancel-receipt.v1')
        self.assertEqual(payload['feature'], 'sessions.cancel_receipt')
        self.assertEqual(payload['outcome'], 'idle')
        self.assertEqual(payload['reason'], 'nothing_running')
        self.assertFalse(payload['stopping'])
        self.assertEqual(payload['cancelled_tasks'], [])

    def test_running_session_is_stop_requested(self):
        self._enable(True)
        with self.ctx['lock']:
            self.ctx['running'].add(self.sid)
        code, payload = self._stop()
        self.assertEqual(code, 200, payload)
        self.assertTrue(payload['stopping'])
        self.assertEqual(payload['outcome'], 'stop_requested')
        self.assertNotIn('reason', payload)
        self.assertIn(self.sid, self.ctx['stop_requested'])
        self.assertEqual(payload['works'][0], {
            'workId': self.sid, 'kind': 'session', 'outcome': 'stop_requested',
        })

    def test_live_task_is_cancelled_and_finished_tasks_are_ignored(self):
        self._enable(True)
        registry = self.ctx['task_registry']
        live = registry.record('task-live', parent_session=self.sid, agent='a',
                               prompt='do not copy this prompt', root='/tmp')
        done = registry.record('task-done', parent_session=self.sid, agent='a',
                               prompt='also private', root='/tmp')
        registry.finish(done['id'], ok=True, summary='private summary')
        other = registry.record('task-other', parent_session='f' * 32, agent='a',
                                prompt='other', root='/tmp')
        code, payload = self._stop()
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload['cancelled_tasks'], [live['id']])
        self.assertEqual(payload['outcome'], 'cancelled')
        self.assertEqual(registry.get(live['id'])['status'], 'cancelled')
        self.assertEqual(registry.get(done['id'])['status'], 'completed')
        self.assertEqual(registry.get(other['id'])['status'], 'running')
        encoded = json.dumps(payload)
        self.assertNotIn('do not copy', encoded)
        self.assertNotIn('private summary', encoded)
        self.assertEqual([row['workId'] for row in payload['works'] if row['kind'] == 'task'],
                         [live['id']])

    def test_cancel_false_is_rejected_and_does_not_change_cancelled_tasks(self):
        self._enable(True)
        long_id = 'task-\n' + ('a' * 90)
        self.ctx['task_registry'] = _Registry(
            [{'id': long_id, 'status': 'running', 'parent': self.sid,
              'summary': 'secret prompt text'}],
            cancel_result=False)
        code, payload = self._stop()
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload['cancelled_tasks'], [])
        self.assertEqual(payload['outcome'], 'rejected')
        self.assertEqual(payload['reason'], 'not_running')
        task_row = payload['works'][1]
        self.assertEqual(task_row['outcome'], 'rejected')
        self.assertEqual(task_row['reason'], 'not_running')
        self.assertNotIn('\n', task_row['workId'])
        self.assertLessEqual(len(task_row['workId']), 80)
        self.assertNotIn('secret prompt text', json.dumps(payload))
        self.assertEqual(self.ctx['task_registry'].cancelled, [long_id])

    def test_flag_toggles_without_restart_and_rejects_non_booleans(self):
        self._enable(True)
        self.assertIn('outcome', self._stop()[1])
        self._enable(False)
        self.assertEqual(set(self._stop()[1]), LEGACY_KEYS)
        save_settings(self.ctx['state_dir'],
                      {'general': {'sessionsCancelReceiptEnabled': 'true'}})
        self.assertEqual(set(self._stop()[1]), LEGACY_KEYS)
        code, payload = self._stop_settings({'sessionsCancelReceiptEnabled': True})
        self.assertEqual(code, 200, payload)
        self.assertEqual(self._stop()[1]['outcome'], 'idle')
        code, payload = self._stop_settings({'sessionsCancelReceiptEnabled': 'yes'})
        self.assertEqual(code, 400)
        self.assertIn('sessionsCancelReceiptEnabled', payload['error'])

    def _stop_settings(self, values):
        req = urllib.request.Request(
            self.base + '/api/settings/general',
            data=json.dumps({'values': values}).encode(),
            headers={'Content-Type': 'application/json',
                     'X-CSRF-Token': 'test-csrf-token'})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def test_missing_session_csrf_and_disabled_plugin(self):
        self._enable(True)
        code, payload = self._stop('a' * 32)
        self.assertEqual(code, 404)
        self.assertEqual(payload['error'], 'session not found')
        code, payload = self._stop(csrf=None)
        self.assertEqual(code, 403)
        set_enabled(self.ctx['state_dir'], 'sessions', False)
        code, payload = self._stop()
        self.assertEqual(code, 403)
        self.assertIn('plugin', payload)
        set_enabled(self.ctx['state_dir'], 'sessions', True)
        self.assertEqual(self._stop()[0], 200)

    def test_get_is_not_the_stop_route(self):
        self._enable(True)
        code, payload = self._stop(method='GET')
        self.assertEqual(code, 404)
        self.assertNotIn('outcome', payload)
