"""Default-off, session-turn tool-call budget owned by the tools plugin."""
import json
import multiprocessing
import tempfile
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from unittest import TestCase

from xueness.bundled_plugins.tools import call_budget
from xueness.core import Gate, Store
from xueness.tool_contract import bind_context, bind_execution, get_context
from xueness.tool_registry import dispatch


def _reserve_from_process(state_dir, sid, call_id):
    store = Store(Path(state_dir))
    session = store.load(sid)
    with bind_execution(store=store, state_dir=Path(state_dir),
                        session=session, tool_name='read',
                        tool_gate_kind='read', tool_call_id=call_id):
        return call_budget.reserve(Path(state_dir), session, store, call_id)


class ToolCallBudgetTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.state.mkdir()
        self.root = base / 'project'
        self.root.mkdir()
        (self.root / 'note.txt').write_text('hello\n', encoding='utf-8')
        self.store = Store(self.state)
        self.session = {'id': 'f' * 32, 'status': 'pending', 'steps': 0,
                        'root': str(self.root),
                        'messages': [{'role': 'user', 'content': 'task'}],
                        'results': {}}
        self.gate = Gate(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def configure(self, *, enabled=True, limit=100):
        (self.state / 'settings.json').write_text(json.dumps({
            'general': {
                'toolsCallBudgetEnabled': enabled,
                'toolsCallBudgetLimit': limit,
            },
        }), encoding='utf-8')

    def call(self, name='read', *, session=None):
        with bind_execution(store=self.store, state_dir=self.state):
            return dispatch(self.root, self.gate, name, {'path': 'note.txt'},
                            self.session if session is None else session)

    def test_feature_is_off_without_persisting_or_changing_results(self):
        result = self.call()
        self.assertTrue(result['ok'], result)
        self.assertNotIn('call_budget', result)
        self.assertNotIn(call_budget.SESSION_FIELD, self.session)

    def test_budget_reserves_before_handler_and_returns_permanent_exhaustion(self):
        self.configure(limit=2)
        first = self.call()
        second = self.call()
        self.assertEqual(first['call_budget']['used'], 1)
        self.assertEqual(second['call_budget']['used'], 2)
        target = self.root / 'note.txt'
        original_read_text = Path.read_text
        read_attempts = []

        def track_target_read(path, *args, **kwargs):
            if path.resolve() == target.resolve():
                read_attempts.append(path)
            return original_read_text(path, *args, **kwargs)

        with self.subTest('file read does not happen after exhaustion'):
            from unittest.mock import patch
            with patch.object(Path, 'read_text', track_target_read):
                denied = self.call()
        self.assertEqual(read_attempts, [])
        self.assertEqual(denied['error_code'], 'tool_call_budget_exhausted')
        self.assertFalse(denied['retryable'])
        self.assertEqual(denied['call_budget']['remaining'], 0)
        self.assertEqual(call_budget.project_session(
            self.state, self.session, self.store)['used'], 2)

    def test_gate_refusal_does_not_spend_budget(self):
        self.configure(limit=1)
        denied = dispatch(self.root, Gate(self.root, disallow=('read',)), 'read',
                          {'path': 'note.txt'}, self.session)
        self.assertEqual(denied['error_code'], 'permission_denied')
        self.assertNotIn(call_budget.SESSION_FIELD, self.session)

    def test_resume_keeps_counter_and_new_user_turn_resets_it(self):
        self.configure(limit=1)
        self.store.save(self.session)
        self.assertTrue(self.call()['ok'])
        resumed = self.store.load(self.session['id'])
        blocked = self.call(session=resumed)
        self.assertEqual(blocked['error_code'], 'tool_call_budget_exhausted')
        resumed['messages'].append({'role': 'user', 'content': 'next turn'})
        self.store.save(resumed)
        status = call_budget.project_session(self.state, resumed, self.store)
        self.assertEqual(status['turn_id'], 'turn-2')
        self.assertEqual(status['used'], 0)
        self.assertEqual(self.call(session=resumed)['call_budget']['used'], 1)

    def test_parallel_calls_reserve_atomically(self):
        self.configure(limit=3)

        def invoke(_):
            return self.call()

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(invoke, range(8)))
        self.assertEqual(sum(result.get('ok') is True for result in results), 3)
        self.assertEqual(sum(result.get('error_code') == 'tool_call_budget_exhausted'
                             for result in results), 5)
        self.assertEqual(call_budget.project_session(
            self.state, self.session, self.store)['used'], 3)

    def test_sessionless_calls_share_only_the_bound_execution_scope(self):
        self.configure(limit=1)
        with bind_execution(state_dir=self.state):
            first = dispatch(self.root, self.gate, 'read', {'path': 'note.txt'}, None)
            second = dispatch(self.root, self.gate, 'read', {'path': 'note.txt'}, None)
        self.assertEqual(first['call_budget']['scope'], 'execution')
        self.assertEqual(first['call_budget']['used'], 1)
        self.assertEqual(second['error_code'], 'tool_call_budget_exhausted')
        self.assertFalse((self.state / ('e' * 32 + '.json')).exists())

    def test_in_memory_child_session_keeps_its_own_turn_budget(self):
        self.configure(limit=1)
        from xueness.bundled_plugins.subagents.runner import _NullStore

        parent = {'id': 'a' * 32, 'messages': [
            {'role': 'user', 'content': 'parent'}], 'root': str(self.root)}
        self.store.save(parent)
        child_store = _NullStore(self.state)
        child = {'id': 'sub-' + 'b' * 32, 'messages': [
            {'role': 'user', 'content': 'child'}], 'root': str(self.root)}
        with bind_execution(store=self.store, state_dir=self.state, session=parent,
                            tool_name='task', tool_gate_kind='planning',
                            tool_call_id='parent-task'):
            self.assertIsNone(call_budget.reserve(
                self.state, parent, self.store, 'parent-task'))
        with bind_execution(store=child_store, state_dir=self.state, session=child,
                            tool_name='read', tool_gate_kind='read',
                            tool_call_id='child-read'):
            self.assertIsNone(call_budget.reserve(
                self.state, child, child_store, 'child-read'))
        with bind_execution(store=child_store, state_dir=self.state, session=child,
                            tool_name='read', tool_gate_kind='read',
                            tool_call_id='child-read-2'):
            blocked = call_budget.reserve(
                self.state, child, child_store, 'child-read-2')
        self.assertEqual(blocked['error_code'], 'tool_call_budget_exhausted')
        self.assertEqual(call_budget.project_session(
            self.state, parent, self.store)['used'], 1)
        self.assertEqual(child[call_budget.SESSION_FIELD]['used'], 1)

    def test_repeated_reservation_for_one_call_id_is_deduplicated(self):
        self.configure(limit=4)
        with bind_execution(store=self.store, state_dir=self.state,
                            session=self.session, tool_name='read',
                            tool_gate_kind='read', tool_call_id='same-call'):
            self.assertIsNone(call_budget.reserve(self.state, self.session,
                                                  self.store, 'same-call'))
            self.assertIsNone(call_budget.reserve(self.state, self.session,
                                                  self.store, 'same-call'))
        self.assertEqual(self.session[call_budget.SESSION_FIELD]['used'], 1)

    def test_reused_call_id_in_same_execution_scope_is_charged_in_new_turn(self):
        self.configure(limit=3)
        self.store.save(self.session)
        execution_scope = {}
        with bind_execution(store=self.store, state_dir=self.state,
                            session=self.session, execution_scope=execution_scope,
                            tool_name='read', tool_gate_kind='read'):
            self.assertIsNone(call_budget.reserve(
                self.state, self.session, self.store, 'reused-call-id'))
            self.session['messages'].append(
                {'role': 'user', 'content': 'next turn'})
            self.store.save(self.session)
            self.assertEqual(call_budget._turn_id(self.session), 'turn-2')
            self.assertIsNone(call_budget.reserve(
                self.state, self.session, self.store, 'reused-call-id'))
        self.assertEqual(self.session[call_budget.SESSION_FIELD],
                         {'turn_id': 'turn-2', 'used': 1})

    def test_stale_turn_with_previously_reserved_call_id_is_still_rejected(self):
        self.configure(limit=3)
        self.store.save(self.session)
        stale = self.store.load(self.session['id'])
        execution_scope = {}
        with bind_execution(store=self.store, state_dir=self.state,
                            session=stale, execution_scope=execution_scope,
                            tool_name='read', tool_gate_kind='read'):
            self.assertIsNone(call_budget.reserve(
                self.state, stale, self.store, 'reused-call-id'))
            current = self.store.load(self.session['id'])
            current['messages'].append(
                {'role': 'user', 'content': 'next turn'})
            self.store.save(current)
            denied = call_budget.reserve(
                self.state, stale, self.store, 'reused-call-id')
        self.assertEqual(denied['error_code'], 'tool_call_budget_unavailable')
        self.assertFalse(denied['retryable'])

    def test_compatibility_context_filters_ephemeral_scope(self):
        from xueness.tool_contract import ToolContext

        context = ToolContext(store=self.store, state_dir=self.state,
                              registry=object())
        with bind_execution(store=self.store, state_dir=self.state,
                            execution_scope={'private': object()}):
            with bind_context(context):
                got = get_context()
        self.assertIs(got.store, self.store)
        self.assertEqual(got.state_dir, self.state)
        self.assertIs(got.registry, context.registry)
        self.assertFalse(hasattr(got, 'execution_scope'))

    def test_status_endpoint_returns_current_turn_projection_with_workspace_check(self):
        self.configure(limit=5)
        self.call()
        self.store.save(self.session)
        ctx = {'state_dir': self.state, 'store': self.store,
               'workspace_roots': (self.root,), 'project_dir': self.root,
               'web_runs': self.state}
        from xueness import plugin_runtime
        old_index = plugin_runtime._ROUTE_INDEX
        plugin_runtime._ROUTE_INDEX = None
        try:
            status = plugin_runtime.dispatch_http(
                'GET', ['api', 'tools', 'call-budget'],
                {'session': [self.session['id']]}, {}, ctx)
            self.assertEqual(status[0], 200)
            self.assertEqual(status[1]['turn_id'], 'turn-1')
            self.assertEqual(status[1]['used'], 1)
            denied = plugin_runtime.dispatch_http(
                'GET', ['api', 'tools', 'call-budget'],
                {'session': [self.session['id']]}, {},
                {**ctx, 'workspace_roots': (), 'project_dir': self.state})
        finally:
            plugin_runtime._ROUTE_INDEX = old_index
        self.assertEqual(denied[0], 404)

    def test_stale_snapshot_cannot_overwrite_or_reset_persistent_quota(self):
        self.configure(limit=1)
        self.store.save(self.session)
        first_snapshot = self.store.load(self.session['id'])
        second_snapshot = self.store.load(self.session['id'])
        with bind_execution(store=self.store, state_dir=self.state,
                            session=first_snapshot, tool_name='read',
                            tool_gate_kind='read', tool_call_id='copy-a'):
            first = call_budget.reserve(self.state, first_snapshot, self.store,
                                        'copy-a')
        with bind_execution(store=self.store, state_dir=self.state,
                            session=second_snapshot, tool_name='read',
                            tool_gate_kind='read', tool_call_id='copy-b'):
            second = call_budget.reserve(self.state, second_snapshot, self.store,
                                         'copy-b')
        self.assertIsNone(first)
        self.assertEqual(second['error_code'], 'tool_call_budget_exhausted')
        self.assertEqual(call_budget.project_session(
            self.state, first_snapshot, self.store)['used'], 1)

    def test_old_turn_snapshot_cannot_start_calls_against_a_new_turn(self):
        self.configure(limit=2)
        self.store.save(self.session)
        old_turn = self.store.load(self.session['id'])
        new_turn = self.store.load(self.session['id'])
        new_turn['messages'].append({'role': 'user', 'content': 'next turn'})
        self.store.save(new_turn)
        with bind_execution(store=self.store, state_dir=self.state,
                            session=old_turn, tool_name='read',
                            tool_gate_kind='read', tool_call_id='stale-turn'):
            denied = call_budget.reserve(self.state, old_turn, self.store,
                                         'stale-turn')
        self.assertEqual(denied['error_code'], 'tool_call_budget_unavailable')
        self.assertEqual(call_budget.project_session(
            self.state, new_turn, self.store)['turn_id'], 'turn-2')

    def test_corrupt_sidecar_makes_status_endpoint_unavailable(self):
        self.configure(limit=3)
        self.store.save(self.session)
        directory = self.state / call_budget._BUDGET_DIR
        directory.mkdir(mode=0o700)
        (directory / (self.session['id'] + '.json')).write_text(
            '{"turn_id":"turn-1","used":-1}', encoding='utf-8')
        context = {'state_dir': self.state, 'store': self.store,
                   'workspace_roots': (self.root,), 'project_dir': self.root,
                   'web_runs': self.state}
        result = call_budget.dispatch_http(
            'GET', ['api', 'tools', 'call-budget'],
            {'session': [self.session['id']]}, {}, context)
        self.assertEqual(result[0], 503)

    def test_separate_processes_share_one_persistent_quota(self):
        self.configure(limit=1)
        self.store.save(self.session)
        context = multiprocessing.get_context('spawn')
        with ProcessPoolExecutor(max_workers=2, mp_context=context) as pool:
            futures = [pool.submit(_reserve_from_process, str(self.state),
                                   self.session['id'], call_id)
                       for call_id in ('process-a', 'process-b')]
            results = [future.result() for future in futures]
        self.assertEqual(sum(result is None for result in results), 1)
        self.assertEqual(sum(isinstance(result, dict) and
                             result.get('error_code') == 'tool_call_budget_exhausted'
                             for result in results), 1)

    def test_corrupt_current_budget_record_fails_closed(self):
        self.configure(limit=3)
        self.session[call_budget.SESSION_FIELD] = {
            'turn_id': 'turn-1', 'used': '3'}
        result = self.call()
        self.assertEqual(result['error_code'], 'tool_call_budget_unavailable')
        self.assertFalse(result['retryable'])

    def test_corrupt_execution_scope_counter_fails_closed(self):
        import threading

        self.configure(limit=1)
        scope = {'tools.call_budget': {
            'used': 'not-an-int', 'call_ids': set(), 'lock': threading.RLock()}}
        with bind_execution(state_dir=self.state, execution_scope=scope):
            result = dispatch(self.root, self.gate, 'read', {'path': 'note.txt'}, None)
        self.assertEqual(result['error_code'], 'tool_call_budget_unavailable')
        self.assertFalse(result['retryable'])

    def test_core_run_budget_stops_mcp_skill_and_subagent_before_effect(self):
        from xueness.core import run

        class Provider:
            def __init__(self, tool_call):
                self.tool_call = tool_call
                self.sent = False

            def complete(self, _messages, _tools):
                if self.sent:
                    return {'content': 'done'}
                self.sent = True
                return {'content': '', 'tool_calls': [
                    {'id': 'count-read', 'type': 'function', 'function': {
                        'name': 'read', 'arguments': '{"path":"note.txt"}'}},
                    self.tool_call,
                ]}

        scenarios = (
            ('skill_read', '{"id":"skill-a"}', 'skill'),
            ('mcp__srv__lookup', '{}', 'mcp'),
            ('task', '{"prompt":"inspect the workspace"}', 'task'),
        )
        for name, arguments, kind in scenarios:
            with self.subTest(kind=kind):
                self.configure(limit=1)
                session = self.store.new('inspect', self.root)
                touched = []
                provider = Provider({'id': 'budgeted-' + kind, 'type': 'function',
                                     'function': {'name': name,
                                                  'arguments': arguments}})
                mcp_tools = ([{'type': 'function', 'function': {'name': name}}]
                             if kind == 'mcp' else None)
                subagents = [{'id': 'reader', 'name': 'Reader'}] if kind == 'task' else None
                result = run(
                    session, self.store, provider,
                    Gate(self.root, allow_mcp=True), max_steps=1,
                    skill_reader=(lambda _sid: touched.append('skill') or {'ok': True}),
                    mcp_tools=mcp_tools,
                    mcp_call=lambda *_args: touched.append('mcp') or {'ok': True},
                    subagents=subagents)
                blocked = result['results']['budgeted-' + kind]
                self.assertEqual(blocked['error_code'], 'tool_call_budget_exhausted')
                self.assertFalse(blocked['retryable'])
                self.assertEqual(touched, [])
                self.assertEqual(result['status'], 'needs_review')
                if kind == 'task':
                    self.assertEqual(result.get('task_runs', []), [])

    def test_invalid_skill_read_arguments_do_not_consume_budget(self):
        from xueness.core import run

        self.configure(limit=2)
        session = self.store.new('read a skill', self.root)
        class Provider:
            def complete(self, _messages, _tools):
                return {'content': '', 'tool_calls': [{
                    'id': 'invalid-skill', 'type': 'function',
                    'function': {'name': 'skill_read', 'arguments': '{"id":""}'}}]}
        run(session, self.store, Provider(), Gate(self.root), max_steps=1,
            skill_reader=lambda _sid: {'ok': True})
        self.assertNotIn(call_budget.SESSION_FIELD, session)

    def test_status_endpoint_does_not_report_previous_turn_as_current_usage(self):
        self.configure(limit=4)
        self.session[call_budget.SESSION_FIELD] = {'turn_id': 'turn-1', 'used': 4}
        self.session['messages'].append({'role': 'user', 'content': 'new'})
        status = call_budget.project_session(self.state, self.session)
        self.assertEqual(status['turn_id'], 'turn-2')
        self.assertEqual(status['used'], 0)
        self.assertEqual(status['remaining'], 4)
