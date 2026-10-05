"""``/dwf``: dynamic workflow runs stay durable records with one session owner.

The suite pins the three faces (chat ``/dwf``, ``xueness workflow dwf``, the web
route) to one implementation, and the guarantees that make that safe: session
attribution, server-side status, cancellations that settle instead of lying,
resume through the existing launch path, and a refusal whenever the plugin, the
workspace fence or an explicit approval is missing.
"""
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.cli import main
from xueness.core import Store
from xueness.plugin_runtime import dispatch_http, entrypoint, route_owner, set_enabled
from xueness.tool_contract import bind_execution
from xueness.workflows import ACTIVE, WorkflowStore, drive
from xueness.bundled_plugins.workflows import dynamic_runs, tools as workflow_tools
from xueness.bundled_plugins.workflows.dynamic_runs import DynamicRunError


class GateStub:
    def check(self, *args):
        return None


class DynamicRunTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.base = Path(holder.name)
        self.state = self.base / 'state'
        self.project = self.base / 'project'
        self.web_runs = self.base / 'webruns'
        self.outside = self.base / 'outside'
        for directory in (self.project, self.web_runs, self.outside):
            directory.mkdir()
        self.root = self.project
        self.sessions = Store(self.state)
        self.workflows = WorkflowStore(self.state)
        self.session = self.sessions.new('demo task', self.root)
        self.sid = self.session['id']
        self.releases = {}
        self.drivers = []
        self.addCleanup(self.release_all)

    def release_all(self):
        for event in list(self.releases.values()):
            event.set()
        # A daemon driver must not outlive the temporary state directory it writes.
        for thread in self.drivers:
            thread.join(timeout=10)

    def wait_for(self, predicate, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                if predicate():
                    return True
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(.03)
        self.fail('workflow state never reached the expected condition')

    def node(self, id, code='print("ok")', **extra):
        return dict(id=id, argv=[sys.executable, '-c', code], **extra)

    def create(self, *, owner=True, status=None, root=None, nodes=None, name='Demo run'):
        record = self.workflows.create({'name': name, 'nodes': nodes or [self.node('a')]},
                                       root or self.root,
                                       owner_session=self.sid if owner else None)
        if status:
            self.workflows.update(record['id'], lambda row: row.update(status=status))
        return record['id']

    def inflight(self, **kwargs):
        """A run driven right now, holding the runner lock exactly like the worker."""
        wid = self.create(status='queued', **kwargs)
        release = threading.Event()
        self.releases[wid] = release

        def execute(store, row, spec):
            release.wait(timeout=20)
            return {'status': 'completed'}

        thread = threading.Thread(target=drive, args=(self.workflows, wid, execute), daemon=True)
        self.drivers.append(thread)
        thread.start()
        self.wait_for(lambda: self.workflows.load(wid)['status'] == 'running')
        return wid

    def settle(self, wid):
        self.releases[wid].set()
        return self.wait_for(lambda: self.workflows.load(wid)['status'] not in ACTIVE)

    def view(self, wid):
        runs = dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs']
        return next(run for run in runs if run['id'] == wid)

    def refuse(self, call, *args, **kwargs):
        with self.assertRaises(DynamicRunError) as caught:
            call(*args, **kwargs)
        return caught.exception

    def invoke(self, args, text=''):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch('sys.stdin', io.StringIO(text)):
            code = main(['--state', str(self.state), *args])
        return code, out.getvalue(), err.getvalue()

    def web_ctx(self, **extra):
        ctx = {'state_dir': self.state, 'store': self.sessions, 'running': set(),
               'web_runs': self.web_runs, 'project_dir': self.project}
        ctx.update(extra)
        return ctx

    # -- attribution and listing ------------------------------------------------

    def test_listing_follows_the_session_and_falls_back_to_its_workspace(self):
        tagged = self.create()
        shared = self.create(owner=False)
        elsewhere = self.create(owner=False, root=self.outside)
        listed = {run['id']: run['attribution']
                  for run in dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs']}
        self.assertEqual(listed, {tagged: 'session', shared: 'workspace'})
        self.assertNotIn(elsewhere, listed)

    def test_a_run_tagged_to_another_session_stays_private_to_it(self):
        mine = self.create()
        other = self.sessions.new('other task', self.root)
        listed = {run['id'] for run in dynamic_runs.list_runs(self.state, self.sessions, other['id'])['runs']}
        self.assertNotIn(mine, listed)
        self.assertIn(mine, {run['id'] for run in
                             dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs']})

    def test_listing_carries_the_fields_the_command_promised(self):
        wid = self.create(name='Index build')
        run = self.view(wid)
        self.assertEqual(run['id'], wid)
        self.assertEqual(run['name'], 'Index build')
        self.assertEqual(run['status'], 'created')
        self.assertRegex(run['startedAt'], r'^\d{4}-\d{2}-\d{2}T')
        self.assertRegex(run['updatedAt'], r'^\d{4}-\d{2}-\d{2}T')
        self.assertEqual(run['requiresApproval'], True)
        self.assertEqual(run['resumable'], False)
        self.assertEqual(run['resumeRefusal']['reason'], 'not_started')
        self.assertEqual(dynamic_runs.list_runs(self.state, self.sessions, self.sid)['inFlight'], 0)

    def test_status_and_resumability_are_decided_by_the_server(self):
        stale = self.create(status='running')            # active record, no live owner
        settled = self.create(status='completed')
        running = self.inflight()
        agents = self.create(nodes=[dict(id='think', kind='agent', prompt='inspect')])
        self.assertEqual((self.view(stale)['stale'], self.view(stale)['resumable']), (True, True))
        self.assertEqual((self.view(running)['inFlight'], self.view(running)['resumable']), (True, False))
        self.assertEqual(self.view(running)['resumeRefusal']['reason'], 'already_running')
        self.assertEqual(self.view(settled)['resumeRefusal']['reason'], 'already_completed')
        self.assertEqual(self.view(agents)['requiresRealModel'], True)

    def test_awaiting_actor_run_is_not_resumed_by_dwf(self):
        waiting = self.create(status='awaiting_user')
        self.assertEqual(self.view(waiting)['resumeRefusal']['reason'], 'awaiting_actor_answer')
        error = self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid, waiting)
        self.assertEqual((error.reason, error.status), ('awaiting_actor_answer', 409))

    # -- cancellation ----------------------------------------------------------

    def test_cancel_without_a_run_id_takes_the_only_in_flight_run(self):
        wid = self.inflight()
        result = dynamic_runs.cancel(self.state, self.sessions, self.sid)
        self.assertEqual((result['run']['id'], result['run']['status']), (wid, 'stopping'))
        self.assertEqual(self.workflows.load(wid)['control'], 'cancel')
        self.settle(wid)
        self.assertEqual(self.workflows.load(wid)['status'], 'cancelled')

    def test_cancel_without_a_run_id_refuses_when_several_are_in_flight(self):
        first, second = self.create(status='running'), self.create(status='running')
        error = self.refuse(dynamic_runs.cancel, self.state, self.sessions, self.sid)
        self.assertEqual((error.reason, error.status), ('ambiguous', 409))
        self.assertEqual({item['id'] for item in error.extra['candidates']}, {first, second})
        for wid in (first, second):
            self.assertEqual(self.workflows.load(wid)['status'], 'running')

    def test_cancel_without_a_run_id_says_so_when_nothing_is_running(self):
        wid = self.create(status='completed')
        error = self.refuse(dynamic_runs.cancel, self.state, self.sessions, self.sid)
        self.assertEqual(error.reason, 'none_in_flight')
        self.assertEqual([run['id'] for run in error.extra['runs']], [wid])

    def test_cancelling_a_finished_run_is_refused_with_a_reason(self):
        wid = self.create(status='completed')
        error = self.refuse(dynamic_runs.cancel, self.state, self.sessions, self.sid, wid)
        self.assertEqual((error.reason, error.status), ('not_active', 409))

    def test_cancel_is_idempotent_and_never_rewrites_a_settled_run(self):
        wid = self.inflight()
        dynamic_runs.cancel(self.state, self.sessions, self.sid, wid)
        self.settle(wid)
        before = self.workflows.load(wid)
        again = dynamic_runs.cancel(self.state, self.sessions, self.sid, wid)
        self.assertTrue(again['alreadyCancelled'])
        after = self.workflows.load(wid)
        self.assertEqual(after['events'], before['events'])
        self.assertEqual(after['status'], 'cancelled')

    def test_cancel_rejects_an_unattributed_or_malformed_run_id(self):
        elsewhere = self.create(owner=False, root=self.outside)
        self.assertEqual(self.refuse(dynamic_runs.cancel, self.state, self.sessions, self.sid,
                                     elsewhere).reason, 'not_found')
        self.assertEqual(self.refuse(dynamic_runs.cancel, self.state, self.sessions, self.sid,
                                     'nope').reason, 'invalid_run')

    # -- resumption ------------------------------------------------------------

    def test_resume_reuses_the_existing_recovery_and_launch_path(self):
        marker = 'resumed.txt'
        wid = self.create(status='running', nodes=[
            self.node('write', f'from pathlib import Path; Path("{marker}").write_text("again")')])
        resumed = dynamic_runs.resume(self.state, self.sessions, self.sid, wid, approved=True)
        self.assertEqual(resumed['action'], 'resume')
        self.assertIn(resumed['run']['status'], ACTIVE | {'completed'})
        self.wait_for(lambda: self.workflows.load(wid)['status'] == 'completed')
        self.assertEqual((self.root / marker).read_text(), 'again')

    def test_resume_refusals_are_structured(self):
        self.assertEqual(self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid,
                                     '0' * 32).reason, 'not_found')
        running = self.inflight()
        self.assertEqual(self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid,
                                     running).reason, 'already_running')
        completed = self.create(status='completed')
        self.assertEqual(self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid,
                                     completed).reason, 'already_completed')
        error = self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid,
                            self.create(status='running'))
        self.assertEqual((error.reason, error.status), ('approval_required', 403))

    def test_resume_of_an_agent_plan_still_needs_the_host_real_model_switch(self):
        wid = self.create(status='running', nodes=[dict(id='think', kind='agent', prompt='inspect')])
        error = self.refuse(dynamic_runs.resume, self.state, self.sessions, self.sid, wid, approved=True)
        self.assertEqual((error.reason, error.status), ('model_execution_disabled', 403))
        with mock.patch.object(WorkflowStore, 'launch',
                               return_value=self.workflows.load(wid)) as launch:
            dynamic_runs.resume(self.state, self.sessions, self.sid, wid, approved=True, allow_real=True)
        self.assertEqual(launch.call_args.kwargs['allow_real'], True)

    def test_disabled_plugin_refuses_every_dwf_face(self):
        self.create()
        self.addCleanup(set_enabled, self.state, 'workflows', True)
        set_enabled(self.state, 'workflows', False)
        error = self.refuse(dynamic_runs.list_runs, self.state, self.sessions, self.sid)
        self.assertEqual((error.reason, error.status), ('plugin_disabled', 403))
        status, body = dispatch_http('GET', ['api', 'workflows', 'dwf'], {'session': [self.sid]}, {},
                                     self.web_ctx())
        self.assertEqual((status, body['plugin']), (403, 'workflows'))
        code, out, err = self.invoke(['workflow', 'dwf', 'list', '--session', self.sid])
        self.assertEqual((code, out), (1, ''))
        self.assertIn('workflows', err)
        set_enabled(self.state, 'workflows', True)
        self.assertEqual(len(dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs']), 1)

    # -- the three faces -------------------------------------------------------

    def test_http_route_is_owned_by_workflows_and_shares_the_implementation(self):
        wid = self.create()
        self.assertEqual(route_owner(['api', 'workflows', 'dwf']), 'workflows')
        status, listed = dispatch_http('GET', ['api', 'workflows', 'dwf'], {'session': [self.sid]}, {},
                                       self.web_ctx())
        self.assertEqual((status, [run['id'] for run in listed['runs']]), (200, [wid]))
        status, body = dispatch_http('POST', ['api', 'workflows', 'dwf', 'resume'], {},
                                     {'session': self.sid, 'runId': wid}, self.web_ctx())
        self.assertEqual((status, body['refusal']['reason']), (409, 'not_started'))
        self.assertEqual(dispatch_http('POST', ['api', 'workflows', 'dwf', 'list'], {},
                                       {'session': self.sid}, self.web_ctx())[0], 405)
        self.assertEqual(dispatch_http('GET', ['api', 'workflows', 'dwf', 'cancel'], {}, {},
                                       self.web_ctx())[0], 405)

    def test_http_resume_without_a_run_id_is_a_client_error(self):
        self.create(status='running')
        status, body = dispatch_http('POST', ['api', 'workflows', 'dwf', 'resume'], {},
                                     {'session': self.sid}, self.web_ctx())
        self.assertEqual((status, body['error']), (400, 'resume requires runId'))

    def test_http_never_manages_a_workspace_outside_the_server_fence(self):
        outside_session = self.sessions.new('outside task', self.outside)
        self.create(root=self.outside)
        status, body = dispatch_http('GET', ['api', 'workflows', 'dwf'],
                                     {'session': [outside_session['id']]}, {}, self.web_ctx())
        self.assertEqual((status, body['refusal']['reason']), (403, 'workspace_not_allowed'))

    def test_cli_face_prints_the_same_payload_and_refuses_with_exit_one(self):
        wid = self.create()
        code, out, err = self.invoke(['workflow', 'dwf', 'list', '--session', self.sid])
        self.assertEqual((code, [run['id'] for run in json.loads(out)['runs']]), (0, [wid]), err)
        code, out, err = self.invoke(['workflow', 'dwf', 'resume', wid, '--session', self.sid])
        self.assertEqual((code, json.loads(out)['refusal']['reason']), (1, 'not_started'))
        code, out, err = self.invoke(['workflow', 'dwf', 'list', '--session', 'zz'])
        self.assertEqual((code, json.loads(out)['refusal']['reason']), (1, 'invalid_session'))

    def test_chat_slash_only_forwards_to_the_same_implementation(self):
        wid = self.create()
        hook = entrypoint('workflows').dynamic_runs_command
        listed = hook(self.state, self.sessions, self.session, 'list')
        self.assertEqual([run['id'] for run in listed['runs']], [wid])
        self.assertEqual(dynamic_runs.chat(self.state, self.sessions, self.session, ''), listed)
        self.assertEqual(self.refuse(dynamic_runs.chat, self.state, self.sessions, self.session,
                                     'explode').reason, 'invalid_arguments')
        self.assertEqual(self.refuse(dynamic_runs.chat, self.state, self.sessions, self.session,
                                     'resume').reason, 'invalid_arguments')
        self.assertEqual(self.refuse(dynamic_runs.chat, self.state, self.sessions, {},
                                     'list').reason, 'session_not_found')

    def test_chat_loop_lists_runs_over_the_real_command_path(self):
        self.create(name='Listed in chat')
        code, out, err = self.invoke(['chat', self.sid], text='/dwf list\n/exit\n')
        self.assertEqual(code, 0, err)
        self.assertIn('Listed in chat', err)
        self.assertIn('created', err)

    # -- the stamping that makes a run "dynamic" -------------------------------

    def test_workflow_tools_stamp_the_session_that_started_the_run(self):
        session = {'id': self.sid, 'root': str(self.root)}
        with bind_execution(state_dir=self.state, store=self.sessions, registry=None):
            created = workflow_tools._create(self.root, GateStub(),
                                             {'plan': {'nodes': [self.node('a')]}}, session, 'call-1')
        wid = created['workflow']['id']
        self.assertEqual(self.workflows.load(wid)['owner_session'], self.sid)
        self.assertEqual(self.view(wid)['attribution'], 'session')

    def test_an_untrusted_owner_value_is_never_stamped(self):
        self.assertIsNone(dynamic_runs.owner_session_id({'id': '../escape'}))
        self.assertIsNone(dynamic_runs.owner_session_id({'id': self.sid.upper()}))
        self.assertIsNone(dynamic_runs.owner_session_id(None))
        self.assertEqual(dynamic_runs.owner_session_id({'id': self.sid}), self.sid)

    def test_a_record_beyond_the_command_s_expectations_is_ignored_not_fatal(self):
        wid = self.create()
        self.workflows.update(wid, lambda row: row.update(owner_session='f' * 32))
        self.assertEqual(dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs'], [])
        self.workflows.update(wid, lambda row: row.pop('owner_session'))
        self.assertEqual([run['id'] for run in
                          dynamic_runs.list_runs(self.state, self.sessions, self.sid)['runs']], [wid])


if __name__ == '__main__':
    unittest.main()
