"""Detailed local tuning changes actual prompt/tool behavior within the Gate."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from xueness.core import Store, Gate, run
from xueness.tool_registry import tool_schemas, dispatch
from xueness.tool_contract import bind_execution
from xueness.bundled_plugins.providers.lightweight_config import validate_options, effective_options
from xueness.bundled_plugins.providers import lightweight as lw
from tests.test_lightweight_runtime import ScriptedProvider, call


class LightweightSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'work'
        self.root.mkdir()
        self.store = Store(Path(self.temp.name) / 'state')
        self.gate = Gate(self.root)

    def provider(self, **options):
        return SimpleNamespace(context_window=8192, max_output_tokens=1024,
                               lightweight_options=options, tool_calling='native')

    def test_tuning_rejects_unbounded_unknown_bool_and_nonfinite_values(self):
        for options in ({'reserveTokens': True}, {'optionalContextChars': -1}, {'fileReadChars': 12001},
                        {'topP': 0}, {'temperature': float('nan')}, {'temperature': 10 ** 1000}, {'seed': -1},
                        {'overflowRetry': 1}, {'initialTools': 'all'}, {'apiKey': 'not-allowed'}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                validate_options(options)
        with self.assertRaises(ValueError):
            validate_options({'temperature': 0.1}, 'anthropic')

    def test_auto_reserve_and_explicit_budget_leaves_space_for_required_input(self):
        self.assertEqual(effective_options(context=2048, output=512)['reserveTokens'], 128)
        self.assertEqual(effective_options(context=8192, output=1024)['reserveTokens'], 512)
        with self.assertRaisesRegex(ValueError, '256'):
            effective_options(value={'reserveTokens': 1500}, context=2048, output=512)
        _, stats = lw.prompt_view(self.store.new('inspect', self.root)['messages'], [], self.provider(reserveTokens=768))
        self.assertEqual(stats['inputBudgetTokens'], 6400)
        self.assertEqual(stats['safetyReserveTokens'], 768)

    def test_minimal_core_discovery_limits_respect_readonly_gate(self):
        session = self.store.new('task', self.root)
        session['discovered_tools'] = ['grep', 'glob', 'list']
        _, schemas = lw.select_tools(tool_schemas(), session, self.gate,
                                     self.provider(initialTools='minimal', maxDiscoveredTools=1))
        names = {lw.tool_name(s) for s in schemas}
        self.assertIn('list', names)
        self.assertNotIn('grep', names)
        self.assertNotIn('write', names)
        _, schemas = lw.select_tools(tool_schemas(), session, self.gate,
                                     self.provider(initialTools='core', maxDiscoveredTools=0))
        self.assertNotIn('tool_search', {lw.tool_name(s) for s in schemas})
        session['read_only'] = True
        _, schemas = lw.select_tools(tool_schemas(), session, self.gate, self.provider(initialTools='core'))
        self.assertFalse({lw.tool_name(s) for s in schemas} & {'write', 'edit', 'exec'})

    def test_optional_context_zero_omits_memory_but_keeps_original_and_latest_verbatim(self):
        session = self.store.new('最初的人类任务', self.root)
        session['messages'].append({'role': 'user', 'content': '最新的人类输入'})
        view, _ = lw.prompt_view(session['messages'], [], self.provider(optionalContextChars=0), injected=['private optional fixture'])
        text = json.dumps(view, ensure_ascii=False)
        self.assertNotIn('private optional fixture', text)
        self.assertIn('最初的人类任务', text)
        self.assertIn('最新的人类输入', text)

    def test_result_window_is_configurable_without_journal_rewrite(self):
        message = {'role': 'tool', 'tool_call_id': 'call', 'content': json.dumps({'ok': True, 'output': '字' * 1800})}
        original = dict(message)
        short = lw._window_result(message, 500)
        long = lw._window_result(message, 3000)
        self.assertLess(len(short['content']), len(long['content']))
        self.assertIn('full_result_tool_call_id', short['content'])
        self.assertEqual(message, original)

    def test_file_and_result_default_page_sizes_apply_only_in_lightweight(self):
        (self.root / 'file.txt').write_text('字' * 1000)
        session = self.store.new('read', self.root)
        session['runtime_profile'] = 'lightweight'
        session['lightweight_options'] = {'fileReadChars': 256, 'resultPageChars': 128}
        session['results']['old'] = {'ok': True, 'output': 'word' * 1000}
        with bind_execution(store=self.store, state_dir=self.store.directory):
            page = dispatch(self.root, self.gate, 'read', {'path': 'file.txt'}, session)
            result = dispatch(self.root, self.gate, 'tool_result_read', {'tool_call_id': 'old'}, session)
        self.assertEqual(len(page['output']), 256)
        self.assertEqual(page['nextOffset'], 256)
        self.assertEqual(len(result['output_untrusted']), 128)
        session['runtime_profile'] = 'standard'
        with bind_execution(store=self.store, state_dir=self.store.directory):
            page = dispatch(self.root, self.gate, 'read', {'path': 'file.txt'}, session)
        self.assertEqual(len(page['output']), 1000)

    def test_search_results_cap_activates_only_configured_count_without_permission(self):
        session = self.store.new('find', self.root)
        session.update(runtime_profile='lightweight', lightweight_options={'toolSearchResults': 1, 'maxDiscoveredTools': 1})
        with bind_execution(store=self.store, state_dir=self.store.directory, tool_catalog=tool_schemas()):
            result = dispatch(self.root, self.gate, 'tool_search', {'query': 'todo'}, session)
            session['lightweight_options']['maxDiscoveredTools'] = 0
            refused = dispatch(self.root, self.gate, 'tool_search', {'query': 'todo'}, session)
        self.assertEqual(len(result['tools']), 1)
        self.assertEqual(len(session['discovered_tools']), 1)
        self.assertFalse(refused['ok'])

    def test_step_cap_and_json_repair_zero_stop_without_extra_request(self):
        session = self.store.new('read', self.root)
        provider = ScriptedProvider([call('read', {'path': 'missing'})])
        provider.lightweight_options = {'stepLimit': 1}
        run(session, self.store, provider, self.gate, max_steps=8)
        self.assertEqual(len(provider.requests), 1)
        session = self.store.new('read', self.root)
        provider = ScriptedProvider([{'content': 'ambiguous prose'}])
        provider.tool_calling = 'json'
        provider.lightweight_options = {'jsonRepairAttempts': 0}
        result = run(session, self.store, provider, self.gate, max_steps=8)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(len(provider.requests), 1)
        self.assertEqual(result['results'], {})

    def test_expired_run_discards_late_response_before_writes_and_keeps_provider_private(self):
        now = [10.0]
        observed = []
        class Provider:
            runtime_profile = 'lightweight'
            lightweight_options = {'wallTimeSeconds': 1}
            request_deadline = 12345.0
            def complete(self, messages, tools):
                observed.append(self.request_deadline)
                now[0] = 12.0
                return call('write', {'path': 'late.txt', 'content': 'must not execute'})
        provider = Provider()
        session = self.store.new('write after response', self.root)
        with patch('xueness.core.time.monotonic', side_effect=lambda: now[0]):
            result = run(session, self.store, provider, Gate(self.root, allow_write=True))
        self.assertEqual(observed, [11.0])
        self.assertEqual(provider.request_deadline, 12345.0)
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['results'], {})
        self.assertFalse((self.root / 'late.txt').exists())
        self.assertEqual(result['steps'], 0)
        self.assertEqual(result['runtime_activity']['phase'], 'stopped')


if __name__ == '__main__':
    unittest.main()
