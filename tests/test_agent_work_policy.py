"""Exercise plugin guidance through actual, isolated standard/lightweight runs."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from xueness import plugin_runtime
from xueness.core import Gate, Store, run
from xueness.bundled_plugins.planning import plugin, work_policy
from xueness.bundled_plugins.planning.session_goal import set_goal
from xueness.bundled_plugins.providers.lightweight import prompt_view


def call(name, args):
    return {'content': '', 'tool_calls': [{'id': 'actual-call', 'type': 'function',
            'function': {'name': name, 'arguments': json.dumps(args)}}]}


class Provider:
    context_window = 8192
    max_output_tokens = 512
    tool_calling = 'native'
    compatibility = {}

    def __init__(self, replies, profile='standard', after_request=None):
        self.replies = iter(replies)
        self.runtime_profile = profile
        self.requests = []
        self.after_request = after_request

    def complete(self, messages, tools):
        self.requests.append(copy.deepcopy(messages))
        if self.after_request:
            self.after_request(len(self.requests))
        return next(self.replies)


class AgentWorkPolicyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'workspace'
        self.root.mkdir()
        self.store = Store(Path(temp.name) / 'state')

    def test_ordinary_chat_receives_the_selected_policy_without_extra_calls_or_goals(self):
        for profile, expected in (('standard', work_policy.STANDARD),
                                  ('lightweight', work_policy.LIGHTWEIGHT)):
            with self.subTest(profile=profile):
                session = self.store.new('你好，请打个招呼。', self.root)
                provider = Provider([{'content': '你好！'}], profile)
                original_provider = copy.deepcopy(provider.__dict__)
                result = run(session, self.store, provider, Gate(self.root), max_steps=2)
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(len(provider.requests), 1)
                self.assertIn(expected, provider.requests[0][0]['content'])
                self.assertEqual(result['results'], {})
                self.assertFalse(result['completion']['verified'])
                self.assertNotIn('goal', result)
                self.assertFalse(result.get('delivery_requirements'))
                self.assertEqual(provider.runtime_profile, original_provider['runtime_profile'])
                self.assertEqual(provider.max_output_tokens, 512)
                self.assertEqual(provider.compatibility, {})
                self.assertNotIn(work_policy.HEADER, self.store.load(result['id'])['messages'][0]['content'])

    def test_disabling_planning_between_requests_removes_rules_on_next_request(self):
        (self.root / 'note.txt').write_text('actual content', encoding='utf-8')
        for profile in ('standard', 'lightweight'):
            with self.subTest(profile=profile):
                plugin_runtime.set_enabled(self.store.directory, 'planning', True)
                session = self.store.new('Read note.txt', self.root)
                def disable(number):
                    if number == 1:
                        plugin_runtime.set_enabled(self.store.directory, 'planning', False)
                provider = Provider([call('read', {'path': 'note.txt'}), {'content': 'Read it.'}],
                                    profile, disable)
                run(session, self.store, provider, Gate(self.root), max_steps=2)
                self.assertIn(work_policy.HEADER, provider.requests[0][0]['content'])
                self.assertNotIn(work_policy.HEADER, provider.requests[1][0]['content'])
                self.assertTrue(session['results']['actual-call']['ok'])

    def test_successful_tool_evidence_does_not_override_incomplete_delivery(self):
        (self.root / 'note.txt').write_text('actual content', encoding='utf-8')
        session = self.store.new('Read note.txt and provide the output file', self.root)
        session['delivery_requirements'] = [{'id': 'output', 'label': 'Expected file',
            'path': 'missing-output.txt', 'contains': ['required item'], 'min_links': 1}]
        provider = Provider([call('read', {'path': 'note.txt'}), {'content': json.dumps({
            'summary': 'Read note.txt.', 'evidence': [{'evidence_id': 'E1',
            'observation': 'The file contains actual content.'}]})}])
        result = run(session, self.store, provider, Gate(self.root), max_steps=2)
        self.assertTrue(result['completion']['tool_execution_success'])
        self.assertEqual(result['completion']['delivery_status'], 'failed')
        self.assertEqual(result['status'], 'needs_review')
        self.assertFalse((self.root / 'missing-output.txt').exists())

    def test_existing_report_guidance_and_goal_remain_within_plugin_budget(self):
        session = self.store.new('Write a research report to report.md', self.root)
        set_goal(session, 'Specific requested outcome ' * 150, state_dir=self.store.directory)
        for profile in ('standard', 'lightweight'):
            session['runtime_profile'] = profile
            block = plugin.completion_instructions(session)
            self.assertIn('call delivery_plan', block)
            self.assertIn('会话目标：Specific requested outcome', block)
            self.assertTrue(block.endswith('/“Goal achieved”；未达成请说明剩余工作并继续。）'))
            self.assertLessEqual(len(block), 6000)

    def test_policy_is_fixed_and_does_not_interpolate_or_mutate_session_data(self):
        session = {'runtime_profile': 'lightweight', 'task': 'UNTRUSTED_TASK_SENTINEL',
                   'results': {'call': {'output': 'UNTRUSTED_TOOL_SENTINEL'}},
                   'read_only': True, 'permission_mode': 'plan'}
        original = copy.deepcopy(session)
        policy = work_policy.instructions(session)
        self.assertEqual(policy, work_policy.LIGHTWEIGHT)
        self.assertNotIn('UNTRUSTED_', policy)
        self.assertEqual(session, original)
        self.assertLess(len(policy), 850)
        self.assertLess(len(work_policy.STANDARD), 2200)

    def test_lightweight_input_budget_accounts_for_work_rules_without_rewriting_history(self):
        session = self.store.new('Inspect the current behavior', self.root)
        original = copy.deepcopy(session['messages'])
        provider = Provider([], 'lightweight')
        provider.context_window = 2048
        session['runtime_profile'] = 'lightweight'
        view, stats = prompt_view(session['messages'], [], provider,
                                  host_instructions=plugin_runtime.completion_instructions(
                                      self.store.directory, session))
        self.assertIn(work_policy.LIGHTWEIGHT, view[0]['content'])
        self.assertLessEqual(stats['estimatedInputTokens'], stats['inputBudgetTokens'])
        self.assertEqual(session['messages'], original)

    def test_work_guidance_does_not_authorize_a_write_in_plan_mode(self):
        session = self.store.new('Inspect and plan a change', self.root)
        provider = Provider([call('write', {'path': 'must-not-exist.txt', 'content': 'bad'})])
        result = run(session, self.store, provider, Gate(self.root, mode='plan'), max_steps=1)
        self.assertIn(work_policy.HEADER, provider.requests[0][0]['content'])
        self.assertFalse(result['results']['actual-call']['ok'])
        self.assertFalse((self.root / 'must-not-exist.txt').exists())


if __name__ == '__main__':
    unittest.main()
