"""Full-context and cut-off responses must not become completion or tool intent."""
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from xueness.core import Gate, Store, run
from xueness.bundled_plugins.providers import lightweight as lw
from xueness.bundled_plugins.providers.activity import RequestActivity, public_activity
from xueness.bundled_plugins.providers.context_budget import calibration_factor, observe_usage
from xueness.bundled_plugins.providers.provider import (
    _read_openai_stream, _read_anthropic_stream, _with_reported_usage,
)
from xueness.bundled_plugins.providers.response_metadata import incomplete_reason, reported_usage
from xueness.events import derive_events
from tests.test_lightweight_runtime import ScriptedProvider, call


def sse(items):
    return io.BytesIO((''.join('data: ' + (item if isinstance(item, str) else json.dumps(item))
                              + '\n\n' for item in items)).encode())


class ResponseMetadataTests(unittest.TestCase):
    def test_anthropic_cut_off_arguments_keep_limit_without_executable_intent(self):
        metadata = {}
        _, calls, _ = _read_anthropic_stream(sse([
            {'type': 'content_block_start', 'index': 0, 'content_block': {
                'type': 'tool_use', 'id': 'c1', 'name': 'write'}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {
                'type': 'input_json_delta', 'partial_json': '{"path":'}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens'}},
            {'type': 'message_stop'}]), None, lambda: None, finish_metadata=metadata)
        self.assertEqual(calls, [])
        self.assertEqual(metadata['_finish_reason'], 'length')
    def test_stream_retains_limit_cache_and_reasoning_details(self):
        metadata = {}
        text, calls, usage = _read_openai_stream(sse([
            {'choices': [{'delta': {'content': 'unfinished'}, 'finish_reason': None}]},
            {'choices': [{'delta': {}, 'finish_reason': 'length'}]},
            {'choices': [], 'usage': {'prompt_tokens': 65453, 'completion_tokens': 84,
                'prompt_tokens_details': {'cached_tokens': 64000, 'private': 'secret'},
                'completion_tokens_details': {'reasoning_tokens': 84}}}, '[DONE]']),
            None, lambda: None, finish_metadata=metadata)
        self.assertEqual(metadata, {'_finish_reason': 'length'})
        self.assertEqual(text, 'unfinished')
        self.assertEqual(calls, [])
        self.assertEqual(usage['prompt_tokens_details'], {'cached_tokens': 64000})
        self.assertEqual(usage['completion_tokens_details'], {'reasoning_tokens': 84})
        provider = SimpleNamespace(context_window=65536, max_output_tokens=6144)
        self.assertEqual(incomplete_reason('length', usage, provider), 'context_limit')

    def test_usage_does_not_invent_missing_or_accept_booleans(self):
        self.assertEqual(reported_usage({'prompt_tokens': True, 'private': 'secret',
                                        'completion_tokens': -1}), {})
        provider = SimpleNamespace(context_window=65536, max_output_tokens=6144)
        self.assertEqual(incomplete_reason('length', None, provider), 'generation_limit')
        self.assertEqual(incomplete_reason('length', {'completion_tokens': 6144}, provider), 'output_limit')

    def test_json_fallback_keeps_finish_and_rejects_message_metadata_spoof(self):
        result = _with_reported_usage({'content': 'text', '_finish_reason': 'stop',
                                      '_usage': {'prompt_tokens': 123}},
                                     {'choices': [{'finish_reason': 'length'}]})
        self.assertEqual(result['_finish_reason'], 'length')
        self.assertNotIn('_usage', result)
        self.assertEqual(_with_reported_usage({'content': 'hi', '_finish_reason': 'stop'}, {})['content'], 'hi')
        self.assertNotIn('_finish_reason', _with_reported_usage({'content': 'hi', '_finish_reason': 'stop'}, {}))

    def test_unknown_finish_is_not_copied_into_public_telemetry(self):
        result = _with_reported_usage({'content': 'text'}, {'choices': [{'finish_reason': 'private-secret'}]})
        self.assertEqual(result['_finish_reason'], 'unknown')
        self.assertEqual(public_activity({'phase': 'paused', 'finishReason': {'secret': 1}}), {'phase': 'paused'})

    def test_anthropic_cached_input_occupies_context_and_limit_survives(self):
        metadata = {}
        _, _, usage = _read_anthropic_stream(sse([
            {'type': 'message_start', 'message': {'usage': {'input_tokens': 100,
                'cache_read_input_tokens': 5000, 'cache_creation_input_tokens': 200}}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens'},
             'usage': {'output_tokens': 1024}}, {'type': 'message_stop'}]),
            None, lambda: None, finish_metadata=metadata)
        self.assertEqual(metadata['_finish_reason'], 'length')
        self.assertEqual(usage['prompt_tokens'], 5300)
        session = {}
        RequestActivity(session).complete({'content': ''}, usage)
        self.assertEqual(session['runtime_activity']['reportedInputTokens'], 5300)
        self.assertEqual(session['runtime_activity']['reportedCachedTokens'], 5000)


class BudgetRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'workspace'
        self.root.mkdir()
        self.store = Store(Path(self.tmp.name) / 'state')
        self.provider = ScriptedProvider([])

    def test_every_human_correction_survives_history_pressure_and_system_prefix_is_stable(self):
        session = self.store.new('Inspect the project, do not publish.', self.root)
        session['messages'] += [call('read', {'path': 'README.md'}, 'old'),
            {'role': 'tool', 'tool_call_id': 'old', 'content': json.dumps({'ok': True, 'output': 'x' * 30000})},
            {'role': 'user', 'content': 'Also preserve config.json and never change credentials.'}]
        for i in range(15):
            session['messages'] += [call('read', {'path': f'file{i}'}, f'c{i}'),
                {'role': 'tool', 'tool_call_id': f'c{i}', 'content': json.dumps({'ok': False, 'error': 'not found', 'output': 'x' * 4000})}]
        session['messages'].append({'role': 'user', 'content': 'Continue the inspection.'})
        original = copy.deepcopy(session['messages'])
        view, stats = lw.prompt_view(session['messages'], [], self.provider, max_chars=8500)
        short, _ = lw.prompt_view(original[:2], [], self.provider)
        self.assertEqual(view[0], short[0])
        self.assertEqual(session['messages'], original)
        for message in original:
            if message['role'] == 'user':
                self.assertIn(message, view)
        self.assertGreater(stats['checkpointChars'], 0)
        checkpoint = next(m['content'] for m in view if 'extractive history checkpoint' in str(m['content']))
        self.assertIn('tool_call_id', checkpoint)
        self.assertIn('not found', checkpoint)
        self.assertLessEqual(stats['estimatedInputTokens'], stats['inputBudgetTokens'])
        ids = {c['id'] for m in view for c in m.get('tool_calls', [])}
        self.assertEqual(ids, {m['tool_call_id'] for m in view if m['role'] == 'tool'})

    def test_disabled_providers_do_not_start_requests_or_calibration(self):
        from xueness import plugin_runtime
        plugin_runtime.set_enabled(self.store.directory, 'providers', False)
        session = self.store.new('你好', self.root)
        result = run(session, self.store, self.provider, Gate(self.root), max_steps=1)
        self.assertEqual(result['status'], 'paused')
        self.assertEqual(self.provider.requests, [])
        self.assertNotIn('runtime_budget_calibration', result)

    def test_oversized_intermediate_requirement_is_not_silently_dropped(self):
        session = self.store.new('Hello', self.root)
        session['messages'] += [{'role': 'user', 'content': '必需约束' * 12000},
                                {'role': 'assistant', 'content': 'ack'},
                                {'role': 'user', 'content': 'Continue'}]
        result = run(session, self.store, self.provider, Gate(self.root), max_steps=1)
        self.assertEqual(result['status'], 'paused')
        self.assertEqual(self.provider.requests, [])

    def test_reported_usage_corrects_underestimate_without_subtracting_cache(self):
        session = {'runtime_budget': {'baseEstimatedInputTokens': 1000}}
        observe_usage(session, self.provider, {'prompt_tokens': 2000, 'prompt_tokens_details': {'cached_tokens': 1800}})
        factor = calibration_factor(session['runtime_budget_calibration'], self.provider)
        self.assertGreater(factor, 2)
        view, stats = lw.prompt_view([{'role': 'user', 'content': 'Hello'}], [], self.provider,
                                    calibration=session['runtime_budget_calibration'])
        self.assertGreater(stats['estimatedInputTokens'], stats['baseEstimatedInputTokens'])
        self.assertNotIn('1800', json.dumps(session['runtime_budget_calibration']))
        changed = copy.copy(self.provider)
        changed.model = 'different-model'
        self.assertEqual(calibration_factor(session['runtime_budget_calibration'], changed), 1)

    def test_calibration_never_reduces_safety_or_fabricates_usage(self):
        session = {'runtime_budget': {'baseEstimatedInputTokens': 1000}}
        observe_usage(session, self.provider, None)
        self.assertNotIn('runtime_budget_calibration', session)
        observe_usage(session, self.provider, {'prompt_tokens': 500})
        self.assertEqual(calibration_factor(session['runtime_budget_calibration'], self.provider), 1)

    def test_search_preview_preserves_sources_and_unverified_provenance(self):
        rows = [{'title': 'Source', 'url': 'https://example.org/article', 'description': 'Relevant.'}]
        rows = rows * 30
        message = {'role': 'tool', 'tool_call_id': 'search1', 'content': json.dumps({
            'ok': True, 'sourceType': 'search_model', 'output': rows,
            'provenance': {'urlsVerified': False}})}
        original = copy.deepcopy(message)
        result = json.loads(lw._window_result(message)['content'])
        self.assertEqual(len(result['sources_untrusted']), 1)
        self.assertEqual(result['sources_untrusted'][0]['url'], rows[0]['url'])
        self.assertFalse(result['provenance']['urlsVerified'])
        self.assertEqual(result['full_result_tool_call_id'], 'search1')
        self.assertEqual(message, original)

    def test_json_repair_and_host_guidance_count_toward_calibrated_budget(self):
        messages = [{'role': 'user', 'content': 'Hello'}]
        self.provider.tool_calling = 'json'
        _, plain = lw.prompt_view(messages, [], self.provider)
        _, repair = lw.prompt_view(messages, [], self.provider, repair='修复说明' * 100,
                                  host_instructions=['宿主要求' * 100])
        self.assertGreater(repair['estimatedInputTokens'], plain['estimatedInputTokens'])
        self.assertLessEqual(repair['estimatedInputTokens'] + repair['reservedOutputTokens']
                             + repair['safetyReserveTokens'], self.provider.context_window)


class TruncationRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'state')
        self.session = self.store.new('你好', self.root)

    def test_cut_off_tool_call_never_executes_even_when_arguments_are_valid(self):
        reply = {**call('write', {'path': 'must-not-exist', 'content': 'unsafe'}), '_finish_reason': 'length'}
        provider = ScriptedProvider([reply])
        result = run(self.session, self.store, provider, Gate(self.root, allow_write=True), max_steps=2)
        self.assertEqual(result['status'], 'paused')
        self.assertEqual(result['completion']['status'], 'incomplete')
        self.assertFalse((self.root / 'must-not-exist').exists())
        self.assertFalse(any(m.get('tool_calls') for m in result['messages']))
        self.assertEqual(len(provider.requests), 1)
        self.assertEqual(result['runtime_activity']['terminationReason'], 'generation_limit')

    def test_json_truncation_preserves_answer_prefix_without_repair_loop(self):
        provider = ScriptedProvider([{'content': '{"answer":"保留已有正文', '_finish_reason': 'length'}])
        provider.tool_calling = 'json'
        result = run(self.session, self.store, provider, Gate(self.root), max_steps=3)
        self.assertEqual(result['messages'][-1]['content'], '保留已有正文')
        self.assertEqual(len(provider.requests), 1)
        self.assertFalse(result['completion']['verified'])
        self.assertEqual(result['completion']['status'], 'incomplete')
        self.assertIn('incomplete', [e.get('status') for e in derive_events(result) if e.get('type') == 'session.completion'])

    def test_invalid_surrogate_in_partial_json_never_breaks_journal_persistence(self):
        provider = ScriptedProvider([{'content': '{"answer":"safe\\ud800","evidence":[]}',
                                     '_finish_reason': 'length'}])
        provider.tool_calling = 'json'
        result = run(self.session, self.store, provider, Gate(self.root), max_steps=1)
        self.assertEqual(result['messages'][-1]['content'], 'safe')
        self.assertEqual(self.store.load(result['id'])['status'], 'paused')

    def test_reasoning_only_limit_is_not_treated_as_completed(self):
        provider = ScriptedProvider([{'content': '', '_finish_reason': 'length',
                                     '_usage': {'completion_tokens': 1024}}])
        result = run(self.session, self.store, provider, Gate(self.root), max_steps=1)
        self.assertEqual(result['completion']['error_code'], 'generation_output_limit')
        self.assertEqual(result['status'], 'paused')

    def test_continue_keeps_partial_output_and_does_not_replay_request(self):
        provider = ScriptedProvider([{'content': 'First part.', '_finish_reason': 'length'},
                                     {'content': 'Second part.', '_finish_reason': 'stop'}])
        run(self.session, self.store, provider, Gate(self.root), max_steps=2)
        self.session['messages'].append({'role': 'user', 'content': '继续'})
        result = run(self.session, self.store, provider, Gate(self.root), max_steps=2)
        self.assertEqual(len(provider.requests), 2)
        self.assertIn({'role': 'assistant', 'content': 'First part.'}, provider.requests[1][0])
        self.assertEqual(result['messages'][-1]['content'], 'Second part.')
        self.assertNotEqual(result['completion']['status'], 'incomplete')

    def test_filtered_and_unknown_termination_never_claim_success(self):
        for reason in ('content_filter', 'unknown', 'context_limit'):
            session = self.store.new('你好', self.root)
            provider = ScriptedProvider([{'content': 'partial', '_finish_reason': reason}])
            result = run(session, self.store, provider, Gate(self.root), max_steps=1)
            self.assertEqual(result['status'], 'paused')
            self.assertFalse(result['completion']['verified'])

    def test_context_limit_resume_shrinks_request_before_calling_model(self):
        provider = ScriptedProvider([{'content': 'partial', '_finish_reason': 'context_limit'},
                                     {'content': 'continued', '_finish_reason': 'stop'}])
        run(self.session, self.store, provider, Gate(self.root), max_steps=1)
        self.session['messages'].append({'role': 'user', 'content': '继续'})
        result = run(self.session, self.store, provider, Gate(self.root), max_steps=1)
        self.assertLess(result['runtime_budget']['inputBudgetTokens'], 6656)
        self.assertEqual(len(provider.requests), 2)
        self.assertNotIn('runtime_context_recovery', result)


if __name__ == '__main__':
    unittest.main()
