"""Request budgeting and local tool protocols retain the execution boundary."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from xueness.core import Gate, Store, run
from xueness.tool_registry import tool_schemas, dispatch
from xueness.tool_contract import bind_execution
from xueness.bundled_plugins.providers import lightweight as lw


def call(name, arguments, cid='call1'):
    return {'role': 'assistant', 'content': '', 'tool_calls': [
        {'id': cid, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}


class ScriptedProvider:
    runtime_profile = 'lightweight'
    context_window = 8192
    max_output_tokens = 1024
    tool_calling = 'native'
    compatibility = {}

    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    def complete(self, messages, tools):
        self.requests.append((copy.deepcopy(messages), copy.deepcopy(tools)))
        reply = next(self.replies)
        return reply(messages, tools) if callable(reply) else reply


class LightweightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'workspace'
        self.root.mkdir()
        self.store = Store(Path(self.tmp.name) / 'state')
        self.gate = Gate(self.root)
        self.provider = ScriptedProvider([])

    def session(self, task='Read a file'):
        return self.store.new(task, self.root)

    def test_curated_tools_and_provider_copy(self):
        catalog, tools = lw.select_tools(tool_schemas(), self.session(), self.gate, self.provider)
        self.assertGreater(len(catalog), len(tools))
        self.assertEqual({lw.tool_name(t) for t in tools},
                         {'read', 'write', 'edit', 'exec', 'ask_user', 'tool_search', 'tool_result_read'})
        prepared = lw.prepare_provider(self.provider)
        prepared.compatibility['streamUsage'] = False
        self.assertEqual(self.provider.compatibility, {})

    def test_small_window_reduces_initial_tools(self):
        self.provider.context_window = 2048
        self.provider.max_output_tokens = 512
        _, tools = lw.select_tools(tool_schemas(), self.session(), self.gate, self.provider)
        self.assertEqual({lw.tool_name(t) for t in tools}, {'read', 'exec', 'ask_user', 'tool_search'})
        _, stats = lw.prompt_view(self.session()['messages'], tools, self.provider)
        self.assertLessEqual(stats['estimatedInputTokens'], stats['inputBudgetTokens'])

    def test_readonly_lightweight_catalog_hides_mutations(self):
        session = self.session()
        session['read_only'] = True
        gate = Gate(self.root, mode='plan')
        catalog, tools = lw.select_tools(tool_schemas(), session, gate, self.provider)
        names = {lw.tool_name(s) for s in catalog}
        self.assertFalse(names & {'write', 'edit', 'exec', 'workflow_create'})
        self.assertIn('grep', {lw.tool_name(s) for s in tools})

    def test_discovery_respects_gate_and_disabled_plugins(self):
        self.gate.disallow = frozenset({'todo_write'})
        session = self.session()
        catalog, _ = lw.select_tools(tool_schemas(), session, self.gate)
        with bind_execution(store=self.store, state_dir=self.store.directory, tool_catalog=catalog):
            result = dispatch(self.root, self.gate, 'tool_search', {'query': 'todo'}, session)
        self.assertTrue(result['ok'])
        self.assertIn('todo_read', session['discovered_tools'])
        self.assertNotIn('todo_write', session['discovered_tools'])

    def test_full_result_pagination_not_cross_session(self):
        session = self.session()
        session['results']['large'] = {'ok': True, 'output': '字' * 3000}
        with bind_execution(store=self.store, state_dir=self.store.directory):
            result = dispatch(self.root, self.gate, 'tool_result_read', {'tool_call_id': 'large', 'offset': 1200, 'limit': 200}, session)
            missing = dispatch(self.root, self.gate, 'tool_result_read', {'tool_call_id': 'other'}, session)
            bad = dispatch(self.root, self.gate, 'tool_result_read', {'tool_call_id': 'large', 'offset': True}, session)
        self.assertTrue(result['ok'])
        self.assertEqual(result['nextOffset'], 1400)
        self.assertEqual(len(result['output_untrusted']), 200)
        self.assertFalse(missing['ok'])
        self.assertFalse(bad['ok'])

    def test_read_file_page_unicode_and_denial(self):
        (self.root / 'data.txt').write_text('甲乙丙丁' * 5000)
        page = dispatch(self.root, self.gate, 'read', {'path': 'data.txt', 'offset': 2, 'limit': 4})
        self.assertEqual(page['output'], '丙丁甲乙')
        self.assertEqual(page['nextOffset'], 6)
        self.assertFalse(dispatch(self.root, self.gate, 'read', {'path': '../secret'})['ok'])

    def test_budget_includes_tools_and_cjk_without_mutating_history(self):
        session = self.session('中文任务，请查看代码。')
        for i in range(24):
            session['messages'] += [call('read', {'path': 'x'}, f'c{i}'),
                                    {'role': 'tool', 'tool_call_id': f'c{i}', 'content': '中' * 7000}]
        session['messages'].append({'role': 'user', 'content': '最新任务，保留此句。'})
        original = copy.deepcopy(session['messages'])
        _, tools = lw.select_tools(tool_schemas(), session, self.gate)
        view, stats = lw.prompt_view(session['messages'], tools, self.provider)
        self.assertEqual(session['messages'], original)
        self.assertLessEqual(stats['estimatedInputTokens'], stats['inputBudgetTokens'])
        self.assertGreater(stats['omittedMessages'], 0)
        self.assertIn(original[1], view)
        self.assertEqual(view[-1], original[-1])
        ids = {c['id'] for m in view for c in m.get('tool_calls', [])}
        self.assertEqual(ids, {m['tool_call_id'] for m in view if m['role'] == 'tool'})

    def test_huge_human_input_pauses_without_calling_model(self):
        session = self.session('中文' * 20000)
        result = run(session, self.store, self.provider, self.gate)
        self.assertEqual(result['status'], 'paused')
        self.assertIn('context budget', result['pause_reason'])
        self.assertEqual(self.provider.requests, [])
        self.assertEqual(result['messages'][1]['content'], '中文' * 20000)

    def test_native_discovery_next_turn_and_unverified_plain_answer(self):
        provider = ScriptedProvider([call('tool_search', {'query': 'todo'}),
                                     call('todo_read', {}, 'call2'),
                                     {'role': 'assistant', 'content': 'There are no todos.'}])
        result = run(self.session(), self.store, provider, self.gate)
        self.assertNotIn('todo_read', {lw.tool_name(s) for s in provider.requests[0][1]})
        self.assertIn('todo_read', {lw.tool_name(s) for s in provider.requests[1][1]})
        self.assertTrue(result['results']['call2']['ok'])
        self.assertEqual(result['status'], 'needs_review')
        self.assertFalse(result['completion']['verified'])
        self.assertEqual(result['completion']['summary'], 'There are no todos.')

    def test_unadvertised_native_mutation_is_never_dispatched(self):
        provider = ScriptedProvider([call('todo_write', {'items': []}), {'role': 'assistant', 'content': 'Stopped'}])
        result = run(self.session(), self.store, provider, self.gate)
        self.assertFalse(result['results']['call1']['ok'])
        self.assertIn('not active', result['results']['call1']['error'])

    def test_json_tool_call_still_needs_write_approval(self):
        provider = ScriptedProvider([{'role': 'assistant', 'content': json.dumps({'tool': 'write', 'arguments': {'path': 'denied.txt', 'content': 'hello'}})},
                                     {'role': 'assistant', 'content': '{"answer":"Write was denied.","evidence":[]}'}])
        provider.tool_calling = 'json'
        result = run(self.session(), self.store, provider, self.gate)
        self.assertFalse((self.root / 'denied.txt').exists())
        self.assertEqual(next(iter(result['results'].values()))['error'], 'denied')
        self.assertEqual(result['status'], 'needs_review')
        for messages, _ in provider.requests:
            self.assertTrue(all(m['role'] in ('system', 'user', 'assistant') for m in messages))

    def test_json_protocol_repair_is_bounded_without_side_effects(self):
        provider = ScriptedProvider([{'role': 'assistant', 'content': 'I could call {"tool":"exec","arguments":{"command":"true"}}.'}]*2)
        provider.tool_calling = 'json'
        result = run(self.session(), self.store, provider, self.gate)
        self.assertEqual(result['steps'], 2)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(result['results'], {})
        self.assertIn('invalid tool envelope', provider.requests[1][0][0]['content'])

    def test_json_strict_envelope_and_unknown_tool_rejected(self):
        for content in ('{"tool":"exec","arguments":{},"extra":true}', '{"tool":"unknown","arguments":{}}', '{"tool":"read","arguments":[]}'):
            reply = lw.decode_text_response({'content': content}, tool_schemas())
            self.assertIn('_protocol_error', reply)
            self.assertNotIn('tool_calls', reply)

    def test_json_valid_evidence_remains_required(self):
        (self.root / 'a').write_text('truth')
        def finish(messages, tools):
            cid = next(m['content'].split('(', 1)[1].split(')', 1)[0] for m in messages if 'UNTRUSTED tool result (' in m.get('content', ''))
            return {'role': 'assistant', 'content': json.dumps({'answer': 'Read truth', 'evidence': [{'tool_call_id': cid, 'observation': 'file contained truth'}]})}
        provider = ScriptedProvider([{'role': 'assistant', 'content': '{"tool":"read","arguments":{"path":"a"}}'}, finish])
        provider.tool_calling = 'json'
        result = run(self.session(), self.store, provider, self.gate)
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['completion']['verified'])

    def test_context_overflow_retries_request_once_not_tool_effects(self):
        class Overflow(RuntimeError):
            context_overflow = True
        def overflow(messages, tools):
            raise Overflow()
        provider = ScriptedProvider([overflow, {'role': 'assistant', 'content': 'done', '_request_attempts': 1}])
        result = run(self.session(), self.store, provider, self.gate)
        self.assertEqual(len(provider.requests), 2)
        self.assertEqual(result['results'], {})
        self.assertTrue(result['runtime_budget']['overflowRetry'])
        self.assertEqual(1, result['runtime_activity']['retryCount'])

    def test_profile_validation_and_resume(self):
        self.assertEqual(lw.profile_for({'runtime_profile': 'lightweight'}, SimpleNamespace()), 'lightweight')
        with self.assertRaises(ValueError):
            lw.profile_for({}, self.provider, True)
        with self.assertRaises(ValueError):
            lw.profile_for({}, SimpleNamespace(tool_calling='json'), 'standard')

    def test_native_object_arguments_normalize_without_changing_original(self):
        response = call('read', {'path': 'a'})
        response['tool_calls'][0]['function']['arguments'] = {'path': 'a'}
        normalized = lw.normalize_native_response(response)
        self.assertEqual(json.loads(normalized['tool_calls'][0]['function']['arguments']), {'path': 'a'})
        self.assertIsInstance(response['tool_calls'][0]['function']['arguments'], dict)

    def test_workspace_guidance_is_context_only_and_refreshed(self):
        (self.root / 'AGENTS.md').write_text('Use our test script.')
        provider = ScriptedProvider([{'role': 'assistant', 'content': 'Inspect first'}])
        session = self.session()
        result = run(session, self.store, provider, self.gate)
        self.assertEqual(result['workspace_instruction_sources'], ['AGENTS.md'])
        self.assertTrue(any('Use our test script.' in m.get('content', '') for m in provider.requests[0][0]))
        self.assertFalse(any('Use our test script.' in m.get('content', '') for m in result['messages']))


if __name__ == '__main__':
    unittest.main()
