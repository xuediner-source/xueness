import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from xueness import web, plugin_runtime
from xueness.tool_contract import bind_execution
from xueness.bundled_plugins.planning import tooling
from xueness.bundled_plugins.sessions import answer_question, structured_questions as questions
from xueness.session_lease import lease

CARDS = [{'id': 'destination', 'header': '部署位置', 'question': '你要部署在哪里？',
          'options': [{'label': '本机', 'description': '仅在当前设备运行'}, {'label': '服务器', 'description': '发布到已配置的服务器'}]}]


class StructuredQuestionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project', allow_real=False)
        session = self.ctx['store'].new('Deploy app', self.ctx['web_runs'])
        self.sid = session['id']
        gate = Mock()
        with bind_execution(state_dir=self.ctx['state_dir'], store=self.ctx['store']):
            result = tooling._ask_user(self.ctx['web_runs'], gate, {'question': '选择部署位置', 'questions': CARDS}, session, 'ask-1')
        gate.check.assert_called_once_with('ask_user', '')
        session['messages'].append({'role': 'assistant', 'content': '', 'tool_calls': [
            {'id': 'ask-1', 'function': {'name': 'ask_user', 'arguments': '{}'}}]})
        session['results']['ask-1'] = result
        session['status'] = 'awaiting_user'
        session['pending_question'] = result['question']
        self.ctx['store'].save(session)
        self.qid = self.get()[1]['question']['id']

    def get(self):
        return answer_question.dispatch('GET', ['api', 'sessions', self.sid, 'question'], {}, None, self.ctx)

    def submit(self, answers=None, qid=None):
        return answer_question.dispatch('POST', ['api', 'sessions', self.sid, 'answer-question'], {},
                                        {'questionId': qid or self.qid, 'answers': answers if answers is not None else {'destination': {'selected': ['本机']}}}, self.ctx)

    def test_cards_are_available_in_all_appearances_without_enabling_legacy_experiment(self):
        status, payload = self.get()
        self.assertEqual(status, 200)
        self.assertTrue(payload['enabled'])
        self.assertEqual(payload['question']['questions'][0]['id'], 'destination')
        self.assertFalse(answer_question.enabled(self.ctx))

    def test_explicit_answer_is_idempotent_and_does_not_grant_approvals(self):
        session = self.ctx['store'].load(self.sid)
        session['approvals'] = [{'kind': 'write', 'subject': 'only-existing'}]
        self.ctx['store'].save(session)
        status, result = self.submit()
        self.assertEqual(status, 200)
        self.assertFalse(result['alreadyAnswered'])
        saved = self.ctx['store'].load(self.sid)
        self.assertEqual(saved['status'], 'paused')
        self.assertIsNone(saved['pending_question'])
        self.assertIn('[destination] 部署位置: 本机', saved['messages'][-1]['content'])
        self.assertEqual(saved['approvals'], session['approvals'])
        self.assertTrue(self.submit()[1]['alreadyAnswered'])
        self.assertEqual(self.ctx['store'].load(self.sid)['messages'], saved['messages'])
        self.assertEqual(self.submit({'destination': {'text': 'other host'}})[0], 409)

    def test_invalid_missing_unknown_and_multiple_single_choices_preserve_pending_state(self):
        for answers in ({}, {'wrong': {'text': 'hello'}}, {'destination': {'selected': []}},
                        {'destination': {'selected': ['not a choice']}}, {'destination': {'selected': ['本机', '服务器']}},
                        {'destination': {'text': 'x' * 1001}}, {'destination': {'selected': ['本机', '本机']}}):
            self.assertEqual(self.submit(answers)[0], 400)
            self.assertEqual(self.ctx['store'].load(self.sid)['status'], 'awaiting_user')

    def test_freeform_unicode_answer_uses_code_points(self):
        self.assertEqual(self.submit({'destination': {'text': '😀' * 1000}})[0], 200)

    def test_option_changes_invalidate_the_question_identity(self):
        session = self.ctx['store'].load(self.sid)
        session['results']['ask-1']['questions'][0]['options'][0]['label'] = '桌面'
        self.ctx['store'].save(session)
        self.assertNotEqual(self.get()[1]['question']['id'], self.qid)
        self.assertEqual(self.submit()[0], 409)

    def test_busy_cross_process_and_disabled_planning_are_rejected(self):
        self.ctx['running'].add(self.sid)
        self.assertEqual(self.submit()[0], 409)
        self.ctx['running'].remove(self.sid)
        with lease(self.ctx['store'], self.sid):
            self.assertEqual(self.submit()[0], 409)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'planning', False)
        self.assertEqual(self.submit()[0], 403)
        self.assertFalse(self.get()[1]['enabled'])

    def test_schema_remains_simple_and_is_bound_to_effective_plugins(self):
        schema = next(row for row in plugin_runtime.tool_schemas(self.ctx['state_dir']) if row['function']['name'] == 'ask_user')
        self.assertEqual(schema['function']['parameters']['required'], ['question'])
        self.assertIn('questions', schema['function']['parameters']['properties'])
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        schema = next(row for row in plugin_runtime.tool_schemas(self.ctx['state_dir']) if row['function']['name'] == 'ask_user')
        self.assertNotIn('questions', schema['function']['parameters']['properties'])

    def test_disabling_planning_does_not_expose_unusable_choice_controls(self):
        from xueness.bundled_plugins.settings.settings_store import save_settings
        save_settings(self.ctx['state_dir'], {'general': {'sessionsAnswerQuestionEnabled': True}})
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'planning', False)
        status, payload = self.get()
        self.assertEqual(status, 200)
        self.assertTrue(payload['enabled'])
        self.assertNotIn('questions', payload['question'])

    def test_bounds_and_duplicate_option_ids_are_rejected(self):
        for changed in ([CARDS[0]] * 4, [CARDS[0]] * 2, [{**CARDS[0], 'isSecret': True}],
                        [{**CARDS[0], 'options': [{'label': 'Other', 'description': ''}, {'label': '本机', 'description': ''}]}]):
            with self.assertRaises(ValueError):
                questions.normalize_questions(changed)

    def test_gate_refusal_precedes_question_preparation(self):
        gate = Mock()
        gate.check.side_effect = PermissionError('denied')
        with bind_execution(state_dir=self.ctx['state_dir'], store=self.ctx['store']):
            with self.assertRaises(PermissionError):
                tooling._ask_user(self.ctx['web_runs'], gate, {'question': 'need permission', 'questions': CARDS}, {}, 'denied')
