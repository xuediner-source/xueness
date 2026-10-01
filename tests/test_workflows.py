import json
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from xueness.workflows import WorkflowStore, ProviderGovernor, drive, validate_plan, ACTIVE
from xueness.bundled_plugins.workflows import tools as workflow_tools
from xueness.bundled_plugins.workflows.dsl import compile_workflow_script
from xueness.tool_contract import bind_execution


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)
        self.store = WorkflowStore(self.root / 'state')

    def node(self, id, code='print("ok")', **extra):
        return dict(id=id, argv=[sys.executable, '-c', code], **extra)

    def wait(self, wid, predicate=lambda r: r['status'] not in ACTIVE, seconds=12):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            r = self.store.load(wid)
            if predicate(r):
                return r
            time.sleep(.03)
        self.fail('workflow did not reach expected state: ' + str(self.store.load(wid)))

    def test_real_background_dag_failure_then_resume_without_replaying_success(self):
        plan = {'nodes': [self.node('first', 'from pathlib import Path; p=Path("count"); p.write_text(p.read_text()+"x" if p.exists() else "x")'),
                          self.node('second', 'from pathlib import Path; assert Path("ready").exists()', needs=['first'])]}
        r = self.store.create(plan, self.root)
        self.store.launch(r['id'], approved=True)
        r = self.wait(r['id'])
        self.assertEqual(r['status'], 'failed')
        self.assertEqual(r['nodes']['first']['status'], 'completed')
        (self.root/'ready').touch()
        self.store.launch(r['id'], approved=True)
        r = self.wait(r['id'])
        self.assertEqual(r['status'], 'completed')
        self.assertEqual((self.root/'count').read_text(), 'x')
        self.assertEqual(r['nodes']['second']['attempts'], 2)

    def test_cancel_terminates_command_and_keeps_bounded_log(self):
        r = self.store.create({'nodes': [self.node('slow', 'import time; print("started", flush=True); time.sleep(30)')]}, self.root)
        self.store.launch(r['id'], approved=True)
        self.wait(r['id'], lambda r: bool(r['nodes']['slow'].get('pid')))
        self.store.control(r['id'], 'cancel')
        r = self.wait(r['id'])
        self.assertEqual(r['status'], 'cancelled')
        self.assertEqual(r['nodes']['slow']['status'], 'cancelled')

    def test_real_timeout_and_logs(self):
        r = self.store.create({'nodes': [self.node('slow', 'import time; print("hello", flush=True); time.sleep(3)', timeout=.2)]}, self.root)
        self.store.launch(r['id'], approved=True)
        r = self.wait(r['id'])
        self.assertEqual(r['status'], 'failed')
        self.assertEqual(r['nodes']['slow']['error'], 'timeout')
        self.assertIn('hello', self.store.log(r['id'], 'slow')['output'])

    def test_workflow_agent_fake_provider_mode_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'invalid node fields'):
            self.store.create({'nodes': [
                {'id': 'agent', 'kind': 'agent', 'prompt': 'inspect workspace', 'fake': True}
            ]}, self.root)

    def test_invalid_dag_and_approval(self):
        for plan in ({'nodes': [self.node('a', needs=['b'])]}, {'nodes': [self.node('a'), self.node('a')]},
                     {'nodes': [self.node('a', cwd='..')]}, {'nodes': [self.node('a')], 'concurrency': True}):
            with self.assertRaises(ValueError):
                self.store.create(plan, self.root)
        r = self.store.create({'nodes': [self.node('a')]}, self.root)
        with self.assertRaises(ValueError):
            self.store.launch(r['id'])
        self.assertEqual(self.store.load(r['id'])['status'], 'created')

    def test_reuse_invalidates_changed_node_and_descendants(self):
        plan = {'nodes': [self.node('a'), self.node('b', needs=['a']), self.node('c')]}
        r = self.store.create(plan, self.root)
        self.store.launch(r['id'], approved=True)
        self.wait(r['id'])
        plan['nodes'][0]['argv'][-1] = 'print("changed")'
        new = self.store.create(plan, self.root, r['id'])
        self.assertEqual(new['nodes']['a']['status'], 'pending')
        self.assertEqual(new['nodes']['b']['status'], 'pending')
        self.assertEqual(new['nodes']['c']['reused_from'], r['id'])

    def test_reuse_invalidates_when_workspace_files_change(self):
        (self.root/'input.txt').write_text('before')
        r = self.store.create({'nodes': [self.node('a')]}, self.root)
        self.store.launch(r['id'], approved=True)
        self.wait(r['id'])
        (self.root/'input.txt').write_text('after')
        new = self.store.create({'nodes': [self.node('a')]}, self.root, r['id'])
        self.assertFalse(new['reuse_cache_valid'])
        self.assertEqual(new['nodes']['a']['status'], 'pending')

    def test_actor_ask_user_pauses_and_answer_resumes_same_transcript(self):
        plan = {'nodes': [{'id': 'actor', 'kind': 'agent',
                           'prompt': 'ask_operator: Which file should I inspect?', 'fake': True}]}
        with self.assertRaisesRegex(ValueError, 'invalid node fields'):
            self.store.create(plan, self.root)

    def test_plan_is_declarative_and_writable_actor_requires_explicit_opt_in(self):
        with self.assertRaises(ValueError):
            validate_plan({'nodes': [{'id': 'a', 'kind': 'agent', 'prompt': 'ok', 'script': '__import__("os").system("x")'}]}, self.root)
        with self.assertRaises(ValueError):
            validate_plan({'nodes': [{'id': 'a', 'kind': 'command', 'argv': ['true'], 'writable': True}]}, self.root)
        clean = validate_plan({'nodes': [{'id': 'a', 'kind': 'agent', 'prompt': 'inspect', 'writable': True}]}, self.root)
        self.assertIs(clean['nodes'][0]['writable'], True)
        with self.assertRaisesRegex(ValueError, 'invalid node fields'):
            validate_plan({'nodes': [{'id': 'a', 'kind': 'agent', 'prompt': 'inspect', 'fake': True}]}, self.root)

    def test_safe_workflow_dsl_compiles_phases_parallel_and_pipeline(self):
        plan = compile_workflow_script('''
name = "Review and verify"
phase("Review")
reviews = parallel([agent("inspect API"), agent("review tests")])
phase("Implement")
pipeline([reviews, agent("implement the findings"), agent("verify the change")])
''', self.root)
        self.assertEqual(plan['name'], 'Review and verify')
        self.assertEqual([node['phase'] for node in plan['nodes']],
                         ['Review', 'Review', 'Implement', 'Implement'])
        self.assertEqual(plan['nodes'][2]['needs'], ['agent_001', 'agent_002'])
        self.assertEqual(plan['nodes'][3]['needs'], ['agent_003'])

    def test_workflow_dsl_rejects_code_execution_and_nonliteral_calls(self):
        invalid = (
            'import os\nagent("inspect")',
            'agent("inspect").__class__',
            'agent(open("secret"))',
            'while True:\n    agent("loop")',
            'agent(f"{__import__(\\"os\\")}")',
        )
        for script in invalid:
            with self.subTest(script=script), self.assertRaises(ValueError):
                compile_workflow_script(script, self.root)

    def test_workflow_run_and_background_exec_use_exact_exec_gate_subjects(self):
        calls = []
        class GateStub:
            def check(self, kind, subject, call_id=None):
                calls.append((kind, subject, call_id))
                raise PermissionError('approval required')
        class SessionStore:
            directory = self.store.state
        context = {'state_dir': self.store.state, 'store': SessionStore(), 'registry': None}
        record = self.store.create({'nodes': [self.node('a')]}, self.root)
        with bind_execution(**context):
            with self.assertRaises(PermissionError):
                workflow_tools._run(self.root, GateStub(), {'workflow_id': record['id'],
                                    'allow_real': False, 'plan_digest': record['plan_digest']},
                                    {'root': str(self.root)}, 'call-1')
            with self.assertRaises(PermissionError):
                workflow_tools._background_exec(self.root, GateStub(), {'argv': ['echo', 'hello']},
                                                {'root': str(self.root)}, 'call-2')
        self.assertEqual(calls, [
            ('exec', '{"allow_real":false,"approved":true,"plan_digest":"' + record['plan_digest'] +
             '","workflow_id":"' + record['id'] + '"}', 'call-1'),
            ('exec', '["echo","hello"]', 'call-2'),
        ])

    def test_workflow_run_obeys_web_host_real_provider_ceiling_without_blocking_cli_gate(self):
        from xueness.core import Gate
        from xueness.web import WebGate, pending_denials

        record = self.store.create({'nodes': [
            {'id': 'agent', 'kind': 'agent', 'prompt': 'inspect'}
        ]}, self.root)
        args = {'workflow_id': record['id'], 'allow_real': True,
                'plan_digest': record['plan_digest']}
        session = {'root': str(self.root)}

        class SessionStore:
            directory = self.store.state

        context = {'state_dir': self.store.state, 'store': SessionStore(), 'registry': None}
        with bind_execution(**context):
            web_gate = WebGate(self.root, 'web-session', {}, threading.Lock(), session=session)
            web_gate.allow_real = False
            with patch.object(WorkflowStore, 'launch') as launch:
                denied = workflow_tools._run(self.root, web_gate, args, session, 'web-call')
                self.assertEqual(denied, {'ok': False, 'error': 'real provider disabled by host'})
                launch.assert_not_called()
                journal = {'messages': [{'tool_calls': [{'id': 'web-call', 'function': {
                    'name': 'workflow_run', 'arguments': json.dumps(args)}}]}],
                    'results': {'web-call': denied}}
                self.assertEqual(pending_denials(journal), [])

            subject = workflow_tools._run_subject(args)
            approved = {'web-session': {'exec': {'web-call': subject}}}
            web_gate = WebGate(self.root, 'web-session', approved, threading.Lock(), session=session)
            web_gate.allow_real = True
            with patch.object(WorkflowStore, 'launch', return_value={'status': 'queued'}) as launch:
                result = workflow_tools._run(self.root, web_gate, args, session, 'web-call')
                self.assertEqual(result['workflow'], {'status': 'queued'})
                launch.assert_called_once_with(record['id'], approved=True, allow_real=True,
                                               expected_digest=record['plan_digest'])

            # Local CLI provider authorization is supplied by the CLI caller;
            # its Gate intentionally has no web-host flag to infer.
            cli_gate = Gate(self.root, allow_exec=True)
            with patch.object(WorkflowStore, 'launch', return_value={'status': 'queued'}) as launch:
                result = workflow_tools._run(self.root, cli_gate, args, session, 'cli-call')
                self.assertEqual(result['workflow'], {'status': 'queued'})
                launch.assert_called_once_with(record['id'], approved=True, allow_real=True,
                                               expected_digest=record['plan_digest'])

    def test_workflow_model_tools_are_bound_to_the_active_workspace(self):
        class GateStub:
            def check(self, kind, subject, call_id=None):
                return None
        other = self.root / 'other'
        other.mkdir()
        record = self.store.create({'nodes': [self.node('a')]}, other)
        class SessionStore:
            directory = self.store.state
        with bind_execution(state_dir=self.store.state, store=SessionStore(), registry=None):
            with self.assertRaises(PermissionError):
                workflow_tools._status(self.root, GateStub(), {'workflow_id': record['id']},
                                       {'root': str(self.root)}, 'status-1')

    def test_workflow_plan_digest_prevents_stale_approval_after_amend(self):
        class GateStub:
            def __init__(self): self.calls = []
            def check(self, kind, subject, call_id=None):
                self.calls.append((kind, subject, call_id))
        record = self.store.create({'nodes': [self.node('a')]}, self.root)
        old_digest = record['plan_digest']
        self.store.amend(record['id'], {'nodes': [self.node('a', 'print("new")')]}, self.root)
        class SessionStore:
            directory = self.store.state
        gate = GateStub()
        with bind_execution(state_dir=self.store.state, store=SessionStore(), registry=None):
            with self.assertRaises(ValueError):
                workflow_tools._run(self.root, gate, {'workflow_id': record['id'],
                    'allow_real': False, 'plan_digest': old_digest}, {'root': str(self.root)}, 'old-call')
        self.assertEqual(gate.calls, [])

    def test_workflow_plan_digest_is_rechecked_inside_launch_lock(self):
        record = self.store.create({'nodes': [self.node('a')]}, self.root)
        class SessionStore:
            directory = self.store.state
        class RacingGate:
            def check(inner, kind, subject, call_id=None):
                self.store.amend(record['id'], {'nodes': [self.node('a', 'print("raced")')]}, self.root)
        with bind_execution(state_dir=self.store.state, store=SessionStore(), registry=None):
            with self.assertRaisesRegex(ValueError, 'changed after approval'):
                workflow_tools._run(self.root, RacingGate(), {'workflow_id': record['id'],
                    'allow_real': False, 'plan_digest': record['plan_digest']},
                    {'root': str(self.root)}, 'race')
        self.assertEqual(self.store.load(record['id'])['status'], 'created')

    def test_provider_governor_round_robins_workflows_and_uses_aimd_cooldown(self):
        governor = ProviderGovernor(self.store.state, default_limit=1)
        key = 'provider-a:model-x'
        governor.enqueue(key, 'workflow-a', 'a1')
        governor.enqueue(key, 'workflow-a', 'a2')
        governor.enqueue(key, 'workflow-b', 'b1')
        self.assertTrue(governor.try_acquire(key, 'a1'))
        self.assertFalse(governor.try_acquire(key, 'a2'))
        governor.finish(key, 'a1', None)
        self.assertFalse(governor.try_acquire(key, 'a2'))
        self.assertTrue(governor.try_acquire(key, 'b1'))
        governor.finish(key, 'b1', False)
        state = __import__('json').loads((self.store.state/'.workflow-provider-governor.json').read_text())
        bucket = state['buckets'][key]
        self.assertEqual(bucket['limit'], 1)
        self.assertGreater(bucket['cooldown_until'], time.time())
        self.assertTrue(any(row['id'] == 'a2' for row in bucket['queue']))

    def test_provider_governor_uses_typed_retry_after_without_penalizing_neutral_errors(self):
        governor = ProviderGovernor(self.store.state, default_limit=3)
        key = 'provider-b:model-y'
        governor.enqueue(key, 'workflow-c', 'neutral')
        self.assertTrue(governor.try_acquire(key, 'neutral'))
        governor.finish(key, 'neutral', None)
        governor.enqueue(key, 'workflow-c', 'rate-limited')
        self.assertTrue(governor.try_acquire(key, 'rate-limited'))
        governor.finish(key, 'rate-limited', None, congestion=True, retry_after=.25)
        state = __import__('json').loads((self.store.state/'.workflow-provider-governor.json').read_text())
        bucket = state['buckets'][key]
        self.assertEqual(bucket['limit'], 1)
        self.assertGreaterEqual(bucket['cooldown_until'] - time.time(), .20)

    def test_disabling_workflows_pauses_at_node_boundary(self):
        from xueness.plugin_runtime import set_enabled
        record = self.store.create({'nodes': [self.node('first'), self.node('second', needs=['first'])]}, self.root)
        self.store.update(record['id'], lambda row: row.update(status='queued'))
        called = []
        def execute(store, row, spec):
            called.append(spec['id'])
            set_enabled(self.store.state, 'workflows', False)
            return {'status': 'completed'}
        try:
            drive(self.store, record['id'], execute)
        finally:
            set_enabled(self.store.state, 'workflows', True)
        settled = self.store.load(record['id'])
        self.assertEqual(settled['status'], 'paused')
        self.assertEqual(called, ['first'])
        self.assertEqual(settled['nodes']['second']['status'], 'pending')

    def test_disabling_workflows_finishes_current_nodes_but_starts_no_more(self):
        from xueness.plugin_runtime import set_enabled
        plan = {'concurrency': 2, 'nodes': [self.node('a'), self.node('b'), self.node('c')]}
        record = self.store.create(plan, self.root)
        self.store.update(record['id'], lambda row: row.update(status='queued'))
        both_started = threading.Barrier(2)
        called = []
        lock = threading.Lock()
        def execute(store, row, spec):
            with lock:
                called.append(spec['id'])
            both_started.wait(timeout=5)
            if spec['id'] == 'a':
                set_enabled(self.store.state, 'workflows', False)
            time.sleep(.05)
            return {'status': 'completed'}
        try:
            drive(self.store, record['id'], execute)
        finally:
            set_enabled(self.store.state, 'workflows', True)
        settled = self.store.load(record['id'])
        self.assertEqual(settled['status'], 'paused')
        self.assertEqual(set(called), {'a', 'b'})
        self.assertEqual({settled['nodes'][key]['status'] for key in ('a', 'b')}, {'completed'})
        self.assertEqual(settled['nodes']['c']['status'], 'pending')

    def test_pause_dynamic_concurrency_and_recovery_lease(self):
        r = self.store.create({'nodes': [self.node(str(i)) for i in range(4)], 'concurrency': 1}, self.root)
        self.store.update(r['id'], lambda row: row.update(status='queued'))
        release = threading.Event()
        started, lock = [], threading.Lock()
        def execute(store, record, spec):
            with lock:
                started.append(spec['id'])
            release.wait(5)
            return {'status': 'completed'}
        owner = threading.Thread(target=drive, args=(self.store, r['id'], execute))
        owner.start()
        self.wait(r['id'], lambda r: len(started) == 1)
        with self.assertRaises(BlockingIOError):
            self.store.control(r['id'], 'recover')
        self.store.control(r['id'], 'concurrency', 3)
        self.wait(r['id'], lambda r: len(started) == 3)
        lowered = self.store.control(r['id'], 'concurrency', 1)
        self.assertEqual(lowered['concurrency'], 1)
        self.assertEqual(sum(n['status'] == 'running' for n in lowered['nodes'].values()), 3)
        self.store.control(r['id'], 'pause')
        release.set(); owner.join(5)
        self.assertFalse(owner.is_alive())
        row = self.store.load(r['id'])
        self.assertEqual(row['status'], 'paused')
        self.assertEqual(row['nodes']['3']['status'], 'pending')
        self.assertEqual(len(started), 3)

    def test_stale_recovery_preserves_uncertain_results(self):
        r = self.store.create({'nodes': [self.node('a')]}, self.root)
        self.store.update(r['id'], lambda row: (row.update(status='running'), row['nodes']['a'].update(status='running')))
        r = self.store.control(r['id'], 'recover')
        self.assertEqual(r['nodes']['a']['status'], 'interrupted')
        self.assertEqual(r['status'], 'interrupted')

    def test_disjoint_command_directories_really_run_in_parallel(self):
        for name in ('a', 'b'):
            (self.root/name).mkdir()
        code = 'from pathlib import Path; import time; Path("start").touch(); time.sleep(.4); Path("end").touch()'
        r = self.store.create({'nodes': [self.node('a', code, cwd='a'), self.node('b', code, cwd='b')]}, self.root)
        self.store.launch(r['id'], approved=True)
        r = self.wait(r['id'])
        self.assertEqual(r['status'], 'completed')
        starts = [(self.root/n/'start').stat().st_mtime for n in ('a', 'b')]
        ends = [(self.root/n/'end').stat().st_mtime for n in ('a', 'b')]
        self.assertLess(max(starts), min(ends))

    def test_same_directory_commands_are_serialized(self):
        code = 'from pathlib import Path; import time; p=Path("mutex"); f=p.open("x"); time.sleep(.1); f.close(); p.unlink()'
        r = self.store.create({'nodes': [self.node('a', code), self.node('b', code)]}, self.root)
        self.store.launch(r['id'], approved=True)
        self.assertEqual(self.wait(r['id'])['status'], 'completed')


if __name__ == '__main__': unittest.main()
