"""Offline regression checks for the planning-owned goal driver."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.planning import goal_driver, session_goal


class GoalDriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.session = {
            'id': 'a' * 32,
            'task': '把首屏渲染降到 1 秒内',
            'status': 'completed',
            'messages': [
                {'role': 'system', 'content': 'system'},
                {'role': 'user', 'content': '把首屏渲染降到 1 秒内', '_turn_id': 'turn-1'},
                {'role': 'assistant', 'content': 'The measured render time is 0.7 seconds.',
                 '_message_id': 'answer-1', '_turn_id': 'turn-1'},
            ],
            'provider_usage': [],
            'completion': {'summary': 'The measured render time is 0.7 seconds.',
                           'turn_id': 'turn-1', 'delivery_status': 'not_assessed',
                           'delivery_checks': {}},
        }
        session_goal.set_goal(self.session, self.session['task'], state_dir=self.state,
                              budget={'maxRounds': 3, 'maxWallSeconds': 100, 'maxTokens': 1000})

    def account_one_round(self, tokens=10):
        self.session['provider_usage'].append({'usage': {'total_tokens': tokens}})

    def test_independent_verifier_can_complete_without_a_completion_phrase(self):
        before = goal_driver.before_run(self.session, self.state)
        self.assertTrue(before['enabled'])
        self.assertEqual(before['deadline_seconds'], 100)
        self.assertEqual(before['token_budget_remaining'], 1000)
        self.account_one_round()
        with patch.object(goal_driver, '_verify', return_value=(
                {'passed': True, 'reason': 'The measured value is below the stated limit.',
                 'remaining': [], 'evidenceIds': ['answer:answer-1']},
                {'total_tokens': 5})):
            result = goal_driver.after_run(self.session, object(), self.state, None, None,
                                           lambda: False, None, 1.0)
        self.assertEqual(result['action'], 'stop')
        self.assertEqual(session_goal.current(self.session)['status'], 'complete')
        self.assertEqual(session_goal.current(self.session)['runtime']['reportedTokens'], 15)
        check = self.session['completion']['delivery_checks']['planning']
        self.assertTrue(next(item for item in check['items'] if item['id'] == 'session_goal')['passed'])

    def test_delivery_failure_continues_with_host_missing_items(self):
        before = goal_driver.before_run(self.session, self.state)
        self.account_one_round()
        self.session['completion']['delivery_status'] = 'failed'
        self.session['completion']['delivery_checks'] = {'planning': {
            'status': 'failed', 'items': [{'id': 'report', 'label': '报告',
                                          'passed': False, 'missing': ['缺少摘要']} ]}}
        with patch.object(goal_driver, '_verify') as verifier:
            result = goal_driver.after_run(self.session, object(), self.state, None, None,
                                           lambda: False, None, 1.0)
        verifier.assert_not_called()
        self.assertEqual(result['action'], 'continue')
        self.assertIn('缺少摘要', result['prompt'])
        self.assertEqual(session_goal.current(self.session)['status'], 'active')

    def test_missing_usage_blocks_a_token_budget(self):
        goal_driver.before_run(self.session, self.state)
        result = goal_driver.after_run(self.session, object(), self.state, None, None,
                                       lambda: False, None, 2.0)
        self.assertEqual(result['action'], 'stop')
        self.assertEqual(session_goal.current(self.session)['status'], 'budget_limited')
        self.assertIn('未报告完整 token 用量', session_goal.current(self.session)['runtime']['reason'])

    def test_pause_and_explicit_resume_are_the_only_budget_reset(self):
        runtime = session_goal.current(self.session)['runtime']
        runtime.update(rounds=2, reportedTokens=500, elapsedSeconds=80)
        self.session['goal']['runtime'] = runtime
        session_goal.transition(self.session, 'pause', state_dir=self.state)
        self.assertEqual(goal_driver.before_run(self.session, self.state)['enabled'], False)
        resumed = session_goal.transition(self.session, 'resume', state_dir=self.state)
        self.assertEqual(resumed['status'], 'active')
        self.assertEqual(resumed['runtime']['reportedTokens'], 0)
        self.assertEqual(resumed['runtime']['elapsedSeconds'], 0)

    def test_round_budget_stops_after_one_unverified_final_answer(self):
        goal = session_goal.current(self.session)
        goal['budget']['maxRounds'] = 1
        self.session['goal'] = goal
        goal_driver.before_run(self.session, self.state)
        self.account_one_round()
        with patch.object(goal_driver, '_verify', return_value=(
                {'passed': False, 'reason': 'The target is not yet evidenced.',
                 'remaining': ['Show a verified measurement.'], 'evidenceIds': ['answer:answer-1']},
                {'total_tokens': 5})):
            result = goal_driver.after_run(self.session, object(), self.state, None, None,
                                           lambda: False, None, 1.0)
        self.assertEqual(result['action'], 'stop')
        self.assertEqual(session_goal.current(self.session)['status'], 'budget_limited')


if __name__ == '__main__':
    unittest.main()
