"""``/compact``: a hand-asked compaction uses the deterministic bounded prompt view.

Nothing here calls a model. The tests pin what the product promises instead: the
same implementation behind chat, CLI and HTTP, an operator note that reaches the
compactor and the recorded digest, the kernel invariants that survive a manual
run (system prompt, original task, every user turn verbatim, call/result pairs
whole, dropped text archived), a budget that stays inside the profile's own
context budget, and refusals for a session that is running, leased, unknown, or
owned by a disabled plugin.
"""
import io
import json
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import tempfile
from unittest import mock

from xueness.cli import main
from xueness.core import Store, SYSTEM
from xueness.plugin_runtime import dispatch_http, route_owner, set_enabled
from xueness.session_lease import lease
from xueness.bundled_plugins.sessions import manual_compact
from xueness.bundled_plugins.sessions.manual_compact import CompactError

BIG = 'tool output line\n' * 600          # ~9 KB of survivable tool text
NOTE = 'keep the failing tests and the reverted patch'


def transcript(turns=6):
    messages = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': 'demo task'}]
    for index in range(turns):
        call_id = f'call-{index}'
        messages.append({'role': 'assistant', 'content': f'step {index}',
                         'tool_calls': [{'id': call_id, 'type': 'function',
                                         'function': {'name': 'read', 'arguments': '{"path":"a"}'}}]})
        messages.append({'role': 'tool', 'tool_call_id': call_id, 'content': BIG})
        messages.append({'role': 'user', 'content': f'my {index}th requirement'})
    return messages


def tiny():
    return [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': 'demo task'},
            {'role': 'assistant', 'content': 'done'}]


class ManualCompactTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.base = Path(holder.name)
        self.state = self.base / 'state'
        self.root = self.base / 'workspace'
        self.root.mkdir()
        self.store = Store(self.state)
        self.session = self.store.new('demo task', self.root)
        self.sid = self.session['id']
        self.put(transcript())

    def put(self, messages, **extra):
        session = self.store.load(self.sid)
        session['messages'] = messages
        session.update(extra)
        self.store.save(session)
        return session

    def chars(self, messages):
        return len(json.dumps(messages, ensure_ascii=False))

    def live(self):
        return self.store.load(self.sid)

    def compact(self, instructions=None, source='cli', **kwargs):
        return manual_compact.compact_leased(self.store, self.sid, instructions,
                                             state_dir=self.state, source=source, **kwargs)

    def refuse(self, *args, **kwargs):
        with self.assertRaises(CompactError) as caught:
            self.compact(*args, **kwargs)
        return caught.exception

    def invoke(self, args, text=''):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch('sys.stdin', io.StringIO(text)):
            code = main(['--state', str(self.state), *args])
        return code, out.getvalue(), err.getvalue()

    def web_ctx(self, **extra):
        ctx = {'state_dir': self.state, 'store': self.store, 'running': set(),
               'web_runs': self.base / 'webruns', 'project_dir': self.root}
        ctx.update(extra)
        return ctx

    # -- the compaction itself -------------------------------------------------

    def test_a_manual_compaction_uses_the_deterministic_compactor(self):
        before = self.chars(self.live()['messages'])
        report = self.compact(NOTE)
        self.assertEqual((report['ok'], report['compacted'], report['source']), (True, True, 'cli'))
        self.assertEqual(report['before']['chars'], before)
        self.assertEqual(report['budget'], manual_compact.DEFAULT_MAX_CHARS)
        self.assertLess(report['after']['chars'], report['budget'])
        self.assertTrue(report['withinBudget'])
        self.assertGreater(report['dropped'] + report['masked'], 0)

    def test_every_user_turn_survives_verbatim_and_the_journal_keeps_the_rest(self):
        original = self.live()['messages']
        wanted = [message['content'] for message in original if message.get('role') == 'user']
        self.compact('保留失败用例')
        session = self.live()
        kept = [message['content'] for message in session['messages'] if message.get('role') == 'user']
        self.assertEqual(kept, wanted)
        self.assertEqual(session['messages'][0]['content'], SYSTEM)
        archived = session['archived_messages']
        self.assertGreater(len(archived), 0)
        for message in original:
            if message.get('role') in ('tool', 'assistant'):
                self.assertTrue(message in session['messages'] or message in archived)

    def test_call_and_result_pairs_are_never_split(self):
        self.compact('pairing check')
        session = self.live()
        results = {message.get('tool_call_id') for message in session['messages']
                   if message.get('role') == 'tool'}
        for message in session['messages']:
            for call in message.get('tool_calls') or []:
                self.assertIn(call['id'], results)

    def test_the_operator_note_reaches_the_compactor_and_the_record(self):
        report = self.compact(NOTE)
        self.assertEqual((report['instructions']['provided'], report['instructions']['chars']),
                         (True, len(NOTE)))
        self.assertEqual(report['instructions']['digest'], NOTE)
        record = self.live()['compactions'][-1]
        self.assertEqual((record['manual'], record['source'], record['instructions']),
                         (True, 'cli', NOTE))
        self.assertEqual(report['compactions'], [record])
        digest = [message for message in self.live()['messages']
                  if message.get('role') == 'system' and 'Older history compacted' in message['content']]
        self.assertEqual(len(digest), 1)
        self.assertIn('operator note: ' + NOTE, digest[0]['content'])

    def test_instructions_are_bounded_before_anything_is_written(self):
        error = self.refuse('x' * (manual_compact.MAX_INSTRUCTIONS + 1))
        self.assertEqual((error.reason, error.status), ('instructions_too_long', 400))
        self.assertEqual(self.refuse('bad\x00note').reason, 'invalid_instructions')
        self.assertEqual(self.refuse(123).reason, 'invalid_instructions')
        self.assertEqual(self.live()['compactions'], [])
        self.assertIs(self.compact('   ')['instructions']['provided'], False)

    def test_a_window_already_inside_its_budget_is_left_untouched(self):
        self.put(tiny())
        path = self.store._path(self.sid)
        before = path.read_text()
        report = self.compact('nothing to do')
        self.assertEqual((report['compacted'], report['reason']), (False, 'nothing_to_compact'))
        self.assertEqual(path.read_text(), before)
        self.assertEqual(report['compactions'], [])

    def test_a_journal_with_nothing_to_drop_stays_a_no_op(self):
        self.put([{'role': 'system', 'content': SYSTEM}])
        self.assertEqual(self.compact()['reason'], 'nothing_to_compact')

    # -- budgets ---------------------------------------------------------------

    def test_the_target_is_the_smaller_of_the_operating_budget_and_a_forced_shrink(self):
        self.put(transcript(turns=2))                 # ~24 KB: under 24000? no -- above it only a little
        current = self.chars(self.live()['messages'])
        report = self.compact()
        self.assertEqual(report['budget'], min(manual_compact.DEFAULT_MAX_CHARS,
                                               int(current * manual_compact.SHRINK_RATIO)))
        self.assertLess(report['budget'], current)
        self.assertLess(report['after']['chars'], current)

    def test_lightweight_stays_under_the_budget_its_profile_computed(self):
        budget = {'profile': 'lightweight', 'inputBudgetTokens': 9000, 'checkpointChars': 0}
        self.put(transcript(), runtime_profile='lightweight', runtime_budget=dict(budget))
        report = self.compact('small model')
        self.assertLessEqual(report['budget'], 9000 * manual_compact.LIGHTWEIGHT_CHARS_PER_TOKEN)
        self.assertLessEqual(report['budget'], manual_compact.DEFAULT_MAX_CHARS)
        self.assertLess(report['after']['chars'], report['before']['chars'])
        # compaction bounds the view; it never rewrites the profile's budget plan
        self.assertEqual(self.live()['runtime_budget'], budget)

    def test_an_override_cannot_widen_the_standard_bound(self):
        current = self.chars(self.live()['messages'])
        report = self.compact(budget=manual_compact.DEFAULT_MAX_CHARS + 8000)
        self.assertEqual(report['budget'], min(manual_compact.DEFAULT_MAX_CHARS,
                                               int(current * manual_compact.SHRINK_RATIO)))
        self.assertEqual(self.refuse(budget=7).reason, 'invalid_budget')

    # -- concurrency, lifecycle and the plugin switch --------------------------

    def test_a_session_another_writer_holds_is_refused_not_queued(self):
        blocked = threading.Event()
        finished = threading.Event()

        def hold():
            with lease(self.store, self.sid):
                blocked.set()
                finished.wait(timeout=10)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(blocked.wait(timeout=5))
        try:
            error = self.refuse()
        finally:
            finished.set()
            thread.join(timeout=5)
        self.assertEqual((error.reason, error.status), ('session_busy', 409))
        self.assertEqual(self.live()['compactions'], [])

    def test_the_chat_face_compacts_the_session_the_loop_already_leases(self):
        report = manual_compact.chat(self.store, self.live(), 'keep tests', state_dir=self.state)
        self.assertEqual((report['source'], report['compacted']), ('chat', True))
        self.put(tiny())
        no_op = manual_compact.chat(self.store, self.live(), None, state_dir=self.state)
        self.assertEqual(no_op['reason'], 'nothing_to_compact')
        with self.assertRaises(CompactError) as caught:
            manual_compact.chat(self.store, {}, None, state_dir=self.state)
        self.assertEqual((caught.exception.reason, caught.exception.status), ('session_not_found', 404))

    def test_unknown_or_malformed_sessions_are_refused(self):
        for sid, reason, status in (('0' * 32, 'session_not_found', 404),
                                    ('not-an-id', 'invalid_session', 400)):
            with self.assertRaises(CompactError) as caught:
                manual_compact.compact_leased(self.store, sid, None, state_dir=self.state)
            self.assertEqual((caught.exception.reason, caught.exception.status), (reason, status))
        with self.assertRaises(CompactError) as caught:
            manual_compact.compact_leased(self.store, self.sid, None, state_dir=self.state,
                                          source='telegram')
        self.assertEqual(caught.exception.reason, 'invalid_source')

    def test_the_sessions_plugin_switch_gates_every_face(self):
        self.addCleanup(set_enabled, self.state, 'sessions', True)
        set_enabled(self.state, 'sessions', False)
        self.assertEqual(self.refuse().reason, 'plugin_disabled')
        status, body = dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {}, {},
                                     self.web_ctx())
        self.assertEqual((status, body['plugin']), (403, 'sessions'))

    # -- the three faces -------------------------------------------------------

    def test_http_route_is_owned_by_sessions_and_shares_the_implementation(self):
        self.assertEqual(route_owner(['api', 'sessions', self.sid, 'compact']), 'sessions')
        status, report = dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {},
                                       {'instructions': NOTE}, self.web_ctx())
        self.assertEqual(status, 200)
        self.assertEqual((report['source'], report['compacted']), ('http', True))
        self.assertEqual(self.live()['compactions'][-1]['instructions'], NOTE)
        refused = dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {},
                                {'instructions': 'x' * 3000}, self.web_ctx())
        self.assertEqual((refused[0], refused[1]['refusal']['reason']), (400, 'instructions_too_long'))

    def test_http_input_boundaries(self):
        self.assertEqual(dispatch_http('GET', ['api', 'sessions', self.sid, 'compact'], {}, {},
                                        self.web_ctx())[0], 405)
        self.assertEqual(dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {},
                                       {'text': 'x'}, self.web_ctx()),
                         (400, {'error': 'expected only an instructions string'}))
        self.assertEqual(dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {},
                                       {'instructions': 5}, self.web_ctx())[0], 400)
        self.assertIsNone(dispatch_http('POST', ['api', 'sessions', 'zz', 'compact'], {},
                                        {}, self.web_ctx()))

    def test_a_running_session_is_refused_before_the_lease_is_taken(self):
        status, body = dispatch_http('POST', ['api', 'sessions', self.sid, 'compact'], {}, {},
                                     self.web_ctx(running={self.sid}))
        self.assertEqual((status, body['reason']), (409, 'run_in_progress'))
        self.assertEqual(self.live()['compactions'], [])

    def test_cli_reports_a_compaction_a_no_op_and_a_refusal_as_json(self):
        code, out, err = self.invoke(['sessions', 'compact', self.sid, '--instructions', NOTE])
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)['compacted'])
        self.put(tiny())
        code, out, err = self.invoke(['sessions', 'compact', self.sid])
        report = json.loads(out)
        self.assertEqual((code, report['compacted'], report['reason']), (0, False, 'nothing_to_compact'))
        code, out, err = self.invoke(['sessions', 'compact', '0' * 32])
        refusal = json.loads(out)
        self.assertEqual((code, refusal['status'], refusal['refusal']['reason']),
                         (1, 404, 'session_not_found'))

    def test_chat_loop_compacts_over_the_real_command_path(self):
        code, out, err = self.invoke(['chat', self.sid], text='/compact 保留失败用例\n/exit\n')
        self.assertEqual(code, 0, err)
        self.assertIn('已压缩', err)
        record = self.live()['compactions'][-1]
        self.assertEqual((record['manual'], record['source'], record['instructions']),
                         (True, 'chat', '保留失败用例'))

    def test_chat_loop_still_takes_the_next_turn_after_a_compaction(self):
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)
        self.put(transcript(turns=3))
        code, out, err = self.invoke(['chat', self.sid], text='/compact keep tests\n继续\n/exit\n')
        self.assertEqual(code, 0, err)
        session = self.live()
        self.assertEqual(session['compactions'][-1]['source'], 'chat')
        self.assertIn('继续', [message['content'] for message in session['messages']
                              if message.get('role') == 'user'])


if __name__ == '__main__':
    unittest.main()
