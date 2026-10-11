"""Goal continuations use ordinary persisted turns and respect host stops."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from xueness.core import Gate, Store, run
from xueness.bundled_plugins.planning import goal_driver, session_goal


class GoalRuntimeIntegrationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'workspace'
        self.root.mkdir()
        self.store = Store(Path(temp.name) / 'state')
        self.session = self.store.new('What is 2 + 2?', self.root)
        session_goal.set_goal(self.session, 'Give the answer and a brief explanation', state_dir=self.store.directory)
        self.store.save(self.session)

    def test_two_round_continuation_is_saved_and_closes_active_turn(self):
        class Provider:
            tool_calling = 'native'
            def __init__(self):
                self.calls = 0
                self.prompts = []
            def complete(self, messages, tools):
                self.calls += 1
                self.prompts.append(messages)
                return {'role': 'assistant', 'content': '4' if self.calls == 1 else '4, because adding two pairs yields four.'}
        provider = Provider()
        verdicts = [({'passed': False, 'reason': 'Explanation missing', 'remaining': ['Explain the addition'], 'evidenceIds': []}, {}),
                    ({'passed': True, 'reason': 'Answer and explanation are present', 'remaining': [], 'evidenceIds': ['answer']}, {})]
        with mock.patch.object(goal_driver, '_verify', side_effect=verdicts):
            result = run(self.session, self.store, provider, Gate(self.root), max_steps=2)
        self.assertEqual(provider.calls, 2)
        self.assertEqual(result['goal']['status'], 'complete')
        self.assertEqual(result['goal']['runtime']['rounds'], 2)
        self.assertNotIn('active_turn_id', result)
        humans = [m for m in result['messages'] if m.get('role') == 'user']
        self.assertEqual([m['_turn_id'] for m in humans], ['turn-1', 'turn-2'])
        self.assertEqual(self.store.load(result['id'])['goal'], result['goal'])
        self.assertTrue(all(not any(k.startswith('_') for k in m) for p in provider.prompts for m in p))

    def test_user_stop_never_requests_verification_or_continuation(self):
        provider = mock.Mock(spec=['tool_calling', 'complete'], tool_calling='native')
        with mock.patch.object(goal_driver, '_verify') as verifier:
            result = run(self.session, self.store, provider, Gate(self.root), should_stop=lambda: True)
        provider.complete.assert_not_called()
        verifier.assert_not_called()
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['goal']['status'], 'paused')

    def test_exhausted_cumulative_wall_budget_spends_no_new_request(self):
        self.session['goal']['runtime']['elapsedSeconds'] = 600
        self.store.save(self.session)
        provider = mock.Mock(spec=['tool_calling', 'complete'], tool_calling='native')
        result = run(self.session, self.store, provider, Gate(self.root))
        provider.complete.assert_not_called()
        self.assertEqual(result['goal']['status'], 'budget_limited')
        self.assertEqual(self.store.load(result['id'])['goal']['status'], 'budget_limited')


if __name__ == '__main__':
    unittest.main()
