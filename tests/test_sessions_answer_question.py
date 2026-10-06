"""HTTP contract for the opt-in sessions.answer_question_experimental API."""
import hashlib
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import web
from xueness.bundled_plugins.sessions import answer_question
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import set_enabled


QUESTION = 'Which workspace should I update?'


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class AnswerQuestionRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project',
                                     allow_real=False, csrf='answer-csrf')
        self.server = _start(self.ctx)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        session = self.ctx['store'].new('test task', self.ctx['web_runs'])
        self.sid = session['id']
        self._make_pending(session)
        self.ctx['store'].save(session)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _make_pending(self, session, *, text=QUESTION, call_id='ask-call-1'):
        session['messages'].append({
            'role': 'assistant', 'content': '',
            'tool_calls': [{'id': call_id, 'type': 'function',
                            'function': {'name': 'ask_user',
                                         'arguments': json.dumps({'question': text})}}],
        })
        session.setdefault('results', {})[call_id] = {
            'ok': True, 'awaiting_user': True, 'question': text,
        }
        session['pending_question'] = text
        session['status'] = 'awaiting_user'
        return session

    def _enable(self, active=True):
        save_settings(self.ctx['state_dir'], {
            'general': {'sessionsAnswerQuestionEnabled': active},
        })

    def _request(self, method, path, data=None, *, csrf=True):
        body = None if data is None else json.dumps(data).encode('utf-8')
        headers = {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if csrf:
            headers['X-CSRF-Token'] = 'answer-csrf'
        request = urllib.request.Request(self.base + path, data=body,
                                         headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read()
            finally:
                exc.close()
            return exc.code, json.loads(raw) if raw else {}

    def _get_question(self):
        return self._request('GET', f'/api/sessions/{self.sid}/question')

    def _answer(self, question_id, answer, *, csrf=True):
        return self._request('POST', f'/api/sessions/{self.sid}/answer-question',
                             {'questionId': question_id, 'answer': answer}, csrf=csrf)

    def test_get_is_default_off_and_returns_stable_question_when_enabled(self):
        code, payload = self._get_question()
        self.assertEqual(code, 200)
        self.assertEqual(payload, {'id': self.sid, 'enabled': False, 'question': None})

        self._enable()
        code, payload = self._get_question()
        self.assertEqual(code, 200)
        self.assertTrue(payload['enabled'])
        self.assertEqual(payload['question']['text'], QUESTION)
        self.assertRegex(payload['question']['id'], r'^q-[0-9a-f]{64}$')
        self.assertEqual(answer_question._question_id(
            self.ctx['store'].load(self.sid), QUESTION), payload['question']['id'])

    def test_answer_is_saved_once_and_same_retry_is_idempotent(self):
        self._enable()
        _, question = self._get_question()
        question_id = question['question']['id']
        code, accepted = self._answer(question_id, '  ~/workspace  ')
        self.assertEqual(code, 200)
        self.assertEqual(accepted, {'id': self.sid, 'status': 'paused',
                                    'questionId': question_id, 'accepted': True,
                                    'alreadyAnswered': False})
        session = self.ctx['store'].load(self.sid)
        self.assertIsNone(session['pending_question'])
        self.assertEqual(session['messages'][-1], {
            'role': 'user', 'content': 'Operator answer: ~/workspace',
        })
        self.assertEqual(session['question_answer_records'][question_id],
                         hashlib.sha256(b'~/workspace').hexdigest())

        code, replay = self._answer(question_id, '~/workspace')
        self.assertEqual(code, 200)
        self.assertTrue(replay['alreadyAnswered'])
        self.assertEqual(len(self.ctx['store'].load(self.sid)['messages']),
                         len(session['messages']))

        code, conflict = self._answer(question_id, '~/other')
        self.assertEqual(code, 409)
        self.assertEqual(conflict['errorCode'],
                         'sessions.answer_question.answer_conflict')
        self.assertEqual(len(self.ctx['store'].load(self.sid)['messages']),
                         len(session['messages']))

    def test_same_text_in_later_turn_gets_a_new_id_and_old_id_is_stale(self):
        self._enable()
        _, first = self._get_question()
        first_id = first['question']['id']
        self.assertEqual(self._answer(first_id, 'first answer')[0], 200)

        session = self.ctx['store'].load(self.sid)
        session['messages'].append({'role': 'assistant', 'content': 'I need one more detail.'})
        self._make_pending(session, text=QUESTION, call_id='ask-call-2')
        self.ctx['store'].save(session)
        _, second = self._get_question()
        second_id = second['question']['id']
        self.assertNotEqual(first_id, second_id)

        code, stale = self._answer(first_id, 'first answer')
        self.assertEqual(code, 200)  # prior answer replay remains idempotent
        self.assertTrue(stale['alreadyAnswered'])
        code, stale = self._answer(first_id, 'different')
        self.assertEqual(code, 409)
        self.assertEqual(stale['errorCode'],
                         'sessions.answer_question.answer_conflict')
        code, accepted = self._answer(second_id, 'second answer')
        self.assertEqual(code, 200)
        self.assertFalse(accepted['alreadyAnswered'])

    def test_legacy_question_id_fallback_includes_current_turn_context(self):
        first = self.ctx['store'].load(self.sid)
        first['messages'] = first['messages'][:2]
        first['results'] = {}
        first['pending_question'] = QUESTION
        first['status'] = 'awaiting_user'
        first_id = answer_question._question_id(first, QUESTION)

        later = json.loads(json.dumps(first))
        later['messages'].append({'role': 'user', 'content': 'Operator answer: first'})
        later['messages'].append({'role': 'assistant', 'content': 'Continuing.'})
        later['steps'] = 1
        second_id = answer_question._question_id(later, QUESTION)
        self.assertNotEqual(first_id, second_id)

    def test_an_unanswered_old_question_id_is_stale(self):
        self._enable()
        _, first = self._get_question()
        first_id = first['question']['id']
        session = self.ctx['store'].load(self.sid)
        self._make_pending(session, text=QUESTION, call_id='ask-call-2')
        self.ctx['store'].save(session)

        code, payload = self._answer(first_id, 'outdated')
        self.assertEqual(code, 409)
        self.assertEqual(payload['errorCode'], 'sessions.answer_question.question_stale')
        self.assertEqual(self.ctx['store'].load(self.sid)['status'], 'awaiting_user')

    def test_invalid_answers_and_exact_payload_shape_are_rejected(self):
        self._enable()
        _, current = self._get_question()
        question_id = current['question']['id']
        for data in ({'questionId': question_id, 'answer': ''},
                     {'questionId': question_id, 'answer': '  '},
                     {'questionId': question_id, 'answer': 'x' * 5001},
                     {'questionId': question_id, 'answer': 'x', 'extra': True},
                     {'questionId': 'not-a-question-id', 'answer': 'x'}):
            with self.subTest(data=str(data)[:80]):
                code, _ = self._request('POST', f'/api/sessions/{self.sid}/answer-question', data)
                self.assertEqual(code, 400)
        # The API limits the trimmed answer, consistent with core.answer_session.
        code, accepted = self._answer(question_id, ' ' + 'x' * 5000 + ' ')
        self.assertEqual(code, 200)
        self.assertTrue(accepted['accepted'])

    def test_post_keeps_csrf_and_plugin_gates(self):
        self._enable()
        _, current = self._get_question()
        question_id = current['question']['id']
        code, _ = self._answer(question_id, 'answer', csrf=False)
        self.assertEqual(code, 403)

        set_enabled(self.ctx['state_dir'], 'sessions', False)
        code, _ = self._get_question()
        self.assertEqual(code, 403)
        set_enabled(self.ctx['state_dir'], 'sessions', True)

    def test_workspace_boundary_is_rechecked(self):
        self._enable()
        session = self.ctx['store'].load(self.sid)
        session['root'] = str(Path(self.temp.name) / 'outside')
        self.ctx['store'].save(session)
        code, payload = self._get_question()
        self.assertEqual(code, 400)
        self.assertEqual(payload['errorCode'],
                         'sessions.answer_question.workspace_not_permitted')

    def test_storage_failure_does_not_report_an_accepted_answer(self):
        self._enable()
        _, current = self._get_question()
        question_id = current['question']['id']
        with patch.object(self.ctx['store'], 'save', side_effect=OSError('disk full')):
            code, payload = self._answer(question_id, 'answer')
        self.assertEqual(code, 503)
        self.assertEqual(payload['errorCode'],
                         'sessions.answer_question.storage_unavailable')
        persisted = self.ctx['store'].load(self.sid)
        self.assertEqual(persisted['status'], 'awaiting_user')
        self.assertEqual(persisted['pending_question'], QUESTION)


if __name__ == '__main__':
    unittest.main()
