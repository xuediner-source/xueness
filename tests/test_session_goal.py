"""会话目标（planning.session_goal）的状态、注入、主机核验与三张入口门禁。

所有测试使用确定性 provider 与隔离状态目录，绝不访问真实模型。
"""
import argparse
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest.mock import patch

from xueness import plugin_runtime, web
from xueness.bundled_plugins.planning import session_goal
from xueness.bundled_plugins.planning.session_goal import GoalError
from xueness.bundled_plugins.sessions import cli as sessions_cli
from xueness.bundled_plugins.sessions import http_routes
from xueness.core import Gate, Store, run
from xueness.plugin_runtime import set_enabled


class AnswerProvider:
    def __init__(self, content):
        self.content = content

    def complete(self, messages, tools):
        return {'role': 'assistant', 'content': self.content}


class Refusal:
    """Stand-in for argparse: records the refusal, then exits like the CLI."""

    def __init__(self):
        self.message = None

    def error(self, message):
        self.message = message
        raise SystemExit(2)


class GoalStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.store = Store(self.state)
        self.session = self.store.new('解释一下二分查找', self.root)

    def set(self, text, **kwargs):
        return session_goal.set_goal(self.session, text, state_dir=self.state, **kwargs)

    def test_first_goal_is_active_and_later_writes_need_confirmation(self):
        record = self.set('让网页在 1 秒内打开')
        self.assertEqual(record['status'], 'active')
        self.assertEqual([item['action'] for item in record['history']], ['set'])
        with self.assertRaises(GoalError) as refused:
            self.set('换一个目标')
        self.assertEqual(refused.exception.status, 409)
        self.assertIn('--target-replace', str(refused.exception))
        self.assertEqual(session_goal.current(self.session)['text'], '让网页在 1 秒内打开')
        replaced = self.set('换一个目标', replace=True)
        self.assertEqual([item['action'] for item in replaced['history']], ['set', 'replace'])

    def test_goal_text_is_a_bounded_non_empty_string(self):
        for rejected in ('', '   ', '字' * (session_goal.MAX_GOAL_CHARS + 1), None, 7):
            with self.subTest(rejected=repr(rejected)[:20]):
                with self.assertRaises(GoalError):
                    self.set(rejected)
        self.assertIsNone(session_goal.current(self.session))

    def test_corrupt_stored_goals_are_dropped_instead_of_trusting_state(self):
        for raw in ({'text': 'x' * 6000, 'status': 'active'},
                    {'text': 'ok', 'status': 'done'},
                    {'text': ' ', 'status': 'active'},
                    'a string instead of an object'):
            with self.subTest(raw=str(raw)[:40]):
                self.session['goal'] = raw
                self.assertIsNone(session_goal.current(self.session))
                self.assertEqual(session_goal.reminder(self.session), '')

    def test_a_broken_history_does_not_lose_a_usable_goal(self):
        self.session['goal'] = {'text': '首屏低于 1 秒', 'status': 'active',
                                'setAt': '', 'updatedAt': '', 'history': 'not-a-list'}
        goal = session_goal.current(self.session)
        self.assertEqual(goal['text'], '首屏低于 1 秒')
        self.assertEqual(goal['history'], [])

    def test_disabled_planning_refuses_writes(self):
        set_enabled(self.state, 'planning', False)
        for call in (lambda: self.set('任何目标'),
                     lambda: session_goal.clear_goal(self.session, state_dir=self.state)):
            with self.assertRaises(GoalError) as refused:
                call()
            self.assertEqual(refused.exception.status, 403)

    def test_clear_keeps_the_record_and_history_and_refuses_an_empty_slot(self):
        self.set('让网页在 1 秒内打开')
        cleared = session_goal.clear_goal(self.session, state_dir=self.state)
        self.assertEqual(cleared['status'], 'cleared')
        self.assertEqual([item['action'] for item in cleared['history']], ['set', 'clear'])
        self.assertEqual(cleared['text'], '让网页在 1 秒内打开')
        self.assertIsNone(session_goal.public(self.session))
        with self.assertRaises(GoalError) as refused:
            session_goal.clear_goal(self.session, state_dir=self.state)
        self.assertEqual(refused.exception.status, 404)
        self.set('清除后可以重新设定', source='http')


class ReminderInjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.store = Store(self.state)
        self.session = self.store.new('解释一下二分查找', self.root)
        session_goal.set_goal(self.session, '把首屏渲染降到 1 秒内', state_dir=self.state)

    def joined(self):
        return '\n'.join(plugin_runtime.completion_instructions(self.state, self.session))

    def test_active_goal_is_restated_and_an_achieved_one_is_silent(self):
        self.assertIn('会话目标：把首屏渲染降到 1 秒内', self.joined())
        self.assertIn('目标已完成', self.joined())
        self.session['goal']['status'] = 'achieved'
        self.assertNotIn('把首屏渲染降到 1 秒内', self.joined())
        self.session['goal']['status'] = 'cleared'
        self.assertNotIn('把首屏渲染降到 1 秒内', self.joined())

    def test_reminder_stays_bounded_and_shows_the_truncation(self):
        session_goal.set_goal(self.session, '标' * session_goal.MAX_GOAL_CHARS,
                              state_dir=self.state, replace=True)
        reminder = session_goal.reminder(self.session)
        self.assertLessEqual(len(reminder), session_goal.REMINDER_CHARS)
        self.assertTrue(reminder.startswith('会话目标：'))
        self.assertIn('…', reminder)

    def test_disabled_planning_injects_nothing(self):
        set_enabled(self.state, 'planning', False)
        self.assertNotIn('把首屏渲染降到 1 秒内', self.joined())


class CompletionVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.store = Store(self.state)

    def finish(self, prompt, content, goal=None):
        session = self.store.new(prompt, self.root)
        if goal is not None:
            session_goal.set_goal(session, goal, state_dir=self.state)
            self.store.save(session)
        return run(session, self.store, AnswerProvider(content), Gate(self.root))

    def planning_checks(self, result):
        checks = result['completion']['delivery_checks']['planning']
        item = next((row for row in checks['items'] if row['id'] == 'session_goal'), None)
        return item, checks

    def test_silent_finish_is_reported_instead_of_assumed_done(self):
        result = self.finish('你好，请用一句中文打招呼。', '你好！有什么可以帮你的？',
                             goal='把首屏降到 1 秒内')
        self.assertEqual(result['status'], 'needs_review')
        item, checks = self.planning_checks(result)
        self.assertFalse(item['passed'])
        self.assertIn('目标已完成', item['missing'][0])
        self.assertEqual(checks['status'], 'failed')
        self.assertEqual(session_goal.current(result)['status'], 'active')
        self.assertEqual(self.store.load(result['id'])['goal']['status'], 'active')

    def test_explicit_declaration_achieves_the_goal_and_completes_the_run(self):
        for content in ('目标已完成：首屏 0.8 秒。', 'Goal achieved. The page renders in 0.8s.'):
            with self.subTest(content=content):
                result = self.finish('你好，请用一句中文打招呼。', content, goal='把首屏降到 1 秒内')
                self.assertEqual(result['status'], 'completed')
                item, checks = self.planning_checks(result)
                self.assertTrue(item['passed'])
                # 交付清单本身仍未登记，所以整体不冒领「交付检查通过」，只记录目标达成。
                self.assertEqual(checks['status'], 'not_assessed')
                self.assertEqual(checks['goal'], {'status': 'achieved', 'text': '把首屏降到 1 秒内'})
                self.assertEqual(session_goal.current(result)['status'], 'achieved')
                self.assertEqual(self.store.load(result['id'])['goal']['status'], 'achieved')

    def test_negated_declaration_does_not_achieve_the_goal(self):
        result = self.finish('你好，请用一句中文打招呼。', '我还没确认目标已完成，需要人工复核。',
                             goal='把首屏降到 1 秒内')
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(session_goal.current(result)['status'], 'active')

    def test_a_session_without_goal_is_assessed_as_before(self):
        result = self.finish('你好，请用一句中文打招呼。', '你好！')
        self.assertEqual(result['status'], 'completed')
        item, checks = self.planning_checks(result)
        self.assertIsNone(item)
        self.assertEqual(checks['status'], 'not_assessed')

    def test_delivery_failure_and_goal_pass_take_the_worse_verdict(self):
        item, checks = {}, {}
        delivery = {'status': 'failed', 'items': [{'id': 'r', 'label': '报告', 'passed': False,
                                                  'missing': ['缺少内容：结论']}], 'reason': '交付未齐'}
        goal = session_goal.verify({'goal': {'text': '把首屏降到 1 秒内', 'status': 'active',
                                            'setAt': '', 'updatedAt': '', 'history': []}},
                                  '目标已完成')
        merged = session_goal.merge_completion_check(delivery, goal)
        self.assertEqual(merged['status'], 'failed')
        self.assertEqual([row['id'] for row in merged['items']], ['r', 'session_goal'])
        self.assertEqual(merged['reason'], '交付未齐')
        self.assertEqual(session_goal.merge_completion_check(delivery, None), delivery)

    def test_disabled_planning_verifies_nothing(self):
        session = self.store.new('你好', self.root)
        session_goal.set_goal(session, '把首屏降到 1 秒内', state_dir=self.state)
        self.store.save(session)
        set_enabled(self.state, 'planning', False)
        result = run(session, self.store, AnswerProvider('你好！'), Gate(self.root))
        self.assertEqual(result['status'], 'completed')
        self.assertNotIn('planning', result['completion']['delivery_checks'])


class CliEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.store = Store(self.state)
        self.session = self.store.new('整理一份报告', self.root)
        parser = argparse.ArgumentParser(prog='xueness')
        parser.add_argument('--state', type=Path)
        self.parser = parser
        plugin_runtime.register_cli_parsers(parser.add_subparsers(dest='cmd'))

    def parse(self, *tokens):
        return self.parser.parse_args(['--state', str(self.state), *tokens])

    def goal_cli(self, *tokens):
        args = self.parse('goal', '--session', self.session['id'], *tokens)
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = plugin_runtime.entrypoint('planning').execute_cli(args)
        return code, out.getvalue() + err.getvalue()

    def test_target_flags_are_offered_by_run_and_chat(self):
        for command in ('run', 'chat'):
            with self.subTest(command=command):
                args = self.parse(command, '--target', '让页面更快', self.session['id'])
                self.assertEqual(args.target, '让页面更快')
                self.assertFalse(args.target_replace)
                self.assertTrue(self.parse(command, '--target', 'x', '--target-replace',
                                           self.session['id']).target_replace)

    def apply(self, args, parser):
        sessions_cli._apply_cli_target(args, parser, self.store, self.session)
        return parser

    def test_target_refuses_to_overwrite_until_replace_is_given(self):
        session_goal.set_goal(self.session, '第一个目标', state_dir=self.state)
        self.store.save(self.session)
        refused = Refusal()
        with self.assertRaises(SystemExit):
            self.apply(self.parse('run', '--target', '第二个目标', self.session['id']), refused)
        self.assertIn('--target-replace', refused.message)
        self.assertEqual(session_goal.current(self.session)['text'], '第一个目标')
        self.assertEqual(self.store.load(self.session['id'])['goal']['text'], '第一个目标')
        self.apply(self.parse('run', '--target', '第二个目标', '--target-replace',
                              self.session['id']), Refusal())
        self.assertEqual(session_goal.current(self.session)['text'], '第二个目标')
        self.assertEqual(self.store.load(self.session['id'])['goal']['text'], '第二个目标')

    def test_no_flag_is_a_no_op_and_disabled_plugin_refuses(self):
        self.apply(self.parse('run', self.session['id']), Refusal())
        self.assertIsNone(session_goal.current(self.session))
        set_enabled(self.state, 'planning', False)
        refused = Refusal()
        with self.assertRaises(SystemExit):
            self.apply(self.parse('run', '--target', '任何目标', self.session['id']), refused)
        self.assertIn('planning', refused.message)

    def test_goal_command_shows_sets_replaces_and_clears(self):
        code, shown = self.goal_cli()
        self.assertEqual(code, 0)
        self.assertIsNone(json.loads(shown)['goal'])
        code, payload = self.goal_cli('set', '把', '报告', '写完')
        self.assertEqual(code, 0)
        goal = json.loads(payload)['goal']
        self.assertEqual(goal['text'], '把 报告 写完')
        self.assertEqual(goal['status'], 'active')
        self.assertEqual(goal['history'][-1]['source'], 'cli')
        code, refused = self.goal_cli('set', '换一个')
        self.assertEqual(code, 1)
        self.assertIn('--target-replace', refused)
        self.assertEqual(json.loads(self.goal_cli('replace', '换一个')[1])['goal']['text'], '换一个')
        self.assertEqual(json.loads(self.goal_cli('clear')[1])['goal']['status'], 'cleared')
        self.assertEqual(plugin_runtime.cli_owner('goal'), 'planning')

    def test_goal_command_refuses_when_planning_is_disabled(self):
        set_enabled(self.state, 'planning', False)
        code, output = self.goal_cli('set', '任何目标')
        self.assertEqual(code, 1)
        self.assertIn('planning', output)

    def test_a_malformed_session_id_reports_instead_of_crashing(self):
        args = self.parse('goal', '--session', 'not-a-session-id', 'set', '任何目标')
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = plugin_runtime.entrypoint('planning').execute_cli(args)
        self.assertEqual(code, 1)
        self.assertIn('session id', out.getvalue() + err.getvalue())

    def test_an_unknown_session_id_is_reported_not_raised(self):
        args = self.parse('goal', '--session', 'f' * 32, 'show')
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = plugin_runtime.entrypoint('planning').execute_cli(args)
        self.assertEqual(code, 1)
        self.assertIn('404', out.getvalue() + err.getvalue())


class HttpGoalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / 'state'
        self.ctx = web.build_context(self.state, base / 'runs', base / 'project',
                                     csrf='test', allow_real=True)
        self.ctx['workspace_roots'] = ()
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.base_url = 'http://127.0.0.1:' + str(self.server.server_address[1])
        self.store = self.ctx['store']
        self.session = self.store.new('把首屏降到 1 秒内', self.ctx['web_runs'])
        self.sid = self.session['id']

    def request(self, path, method='GET', data=None, csrf=True):
        body = None if data is None else json.dumps(data).encode()
        headers = {'Content-Type': 'application/json',
                   **({'X-CSRF-Token': 'test'} if csrf else {})}
        req = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def goal(self):
        return self.request(f'/api/sessions/{self.sid}/goal')[1]['goal']

    def test_post_get_and_delete_round_trip_with_the_confirm_before_replace_rule(self):
        self.assertIsNone(self.goal())
        code, created = self.request(f'/api/sessions/{self.sid}/goal', 'POST', {'text': '首屏低于 1 秒'})
        self.assertEqual(code, 200)
        self.assertEqual(created['goal']['status'], 'active')
        self.assertEqual(self.request(f'/api/sessions/{self.sid}')[1]['goal']['text'], '首屏低于 1 秒')
        self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'POST', {'text': '换一个'})[0], 409)
        code, replaced = self.request(f'/api/sessions/{self.sid}/goal', 'POST',
                                      {'text': '换一个', 'replace': True})
        self.assertEqual(code, 200)
        self.assertEqual([item['action'] for item in replaced['goal']['history']], ['set', 'replace'])
        self.assertEqual({item['source'] for item in replaced['goal']['history']}, {'http'})
        code, cleared = self.request(f'/api/sessions/{self.sid}/goal', 'DELETE')
        self.assertEqual(code, 200)
        self.assertEqual(cleared['goal']['status'], 'cleared')
        self.assertIsNone(self.request(f'/api/sessions/{self.sid}')[1]['goal'])

    def test_mutations_require_csrf_and_bodies_are_exact(self):
        self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'POST',
                                      {'text': 'x'}, csrf=False)[0], 403)
        self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'DELETE', csrf=False)[0], 403)
        for bad in ({}, {'text': ''}, {'text': 'x', 'allow_write': True},
                    {'text': 'x', 'replace': 'yes'}, {'text': 5}):
            with self.subTest(body=bad):
                self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'POST', bad)[0], 400)

    def test_ids_that_are_not_sessions_are_not_ours(self):
        for sid in ('deadbeef', '0' * 31, 'x' * 32):
            with self.subTest(sid=sid):
                self.assertEqual(self.request(f'/api/sessions/{sid}/goal')[0], 404)
        self.assertEqual(self.request(f'/api/sessions/{self.sid}missing/goal')[0], 404)

    def test_a_valid_id_without_a_session_is_missing_not_empty(self):
        missing = '%032x' % 424242
        self.assertEqual(self.request(f'/api/sessions/{missing}/goal')[0], 404)
        self.assertEqual(self.request(f'/api/sessions/{missing}/goal', 'POST',
                                      {'text': 'x'})[0], 404)

    def test_disabled_planning_closes_the_route_and_the_session_view(self):
        self.request(f'/api/sessions/{self.sid}/goal', 'POST', {'text': '首屏低于 1 秒'})
        set_enabled(self.state, 'planning', False)
        code, refused = self.request(f'/api/sessions/{self.sid}/goal')
        self.assertEqual(code, 403)
        self.assertEqual(refused['plugin'], 'planning')
        self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'POST', {'text': 'x'})[0], 403)
        self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'DELETE')[0], 403)
        self.assertIsNone(self.request(f'/api/sessions/{self.sid}')[1]['goal'])
        set_enabled(self.state, 'planning', True)
        self.assertEqual(self.goal()['text'], '首屏低于 1 秒')

    def test_a_running_session_cannot_have_its_goal_changed(self):
        self.request(f'/api/sessions/{self.sid}/goal', 'POST', {'text': '首屏低于 1 秒'})
        with self.ctx['lock']:
            self.ctx['running'].add(self.sid)
        try:
            self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'POST',
                                         {'text': 'x'})[0], 409)
            self.assertEqual(self.request(f'/api/sessions/{self.sid}/goal', 'DELETE')[0], 409)
        finally:
            with self.ctx['lock']:
                self.ctx['running'].discard(self.sid)
        self.assertEqual(self.goal()['text'], '首屏低于 1 秒')

    def test_composer_goal_flag_needs_planning_and_becomes_the_session_goal(self):
        with patch.dict(os.environ, {'XUENESS_PROVIDER': 'openai',
                                     'XUENESS_API_BASE': 'https://api.example.test/v1',
                                     'XUENESS_MODEL': 'gpt-4o', 'XUENESS_API_KEY': 'goal-test-key',
                                     'ANTHROPIC_API_KEY': ''}):
            set_enabled(self.state, 'planning', False)
            code, refused = self.request('/api/composer/prepare', 'POST',
                                        {'text': '把首屏降到 1 秒内', 'input': {'goal': True}})
            self.assertEqual(code, 403)
            self.assertEqual(refused['error'], 'plugin disabled or dependency unavailable: planning')
            set_enabled(self.state, 'planning', True)
            code, prepared = self.request('/api/composer/prepare', 'POST',
                                         {'text': '把首屏降到 1 秒内', 'input': {'goal': True}})
            self.assertEqual(code, 200)
            self.assertTrue(prepared['goal'])
            code, created = self.request('/api/sessions', 'POST',
                                        {'task': '把首屏降到 1 秒内', 'root': prepared['root'],
                                         'prepared_token': prepared['token']})
            self.assertEqual(code, 200)
            goal = self.request(f"/api/sessions/{created['id']}/goal")[1]['goal']
            self.assertEqual(goal['text'], '把首屏降到 1 秒内')
            self.assertEqual(goal['history'][-1]['source'], 'composer')

    def test_an_unflagged_composer_submission_leaves_the_slot_empty(self):
        with patch.dict(os.environ, {'XUENESS_PROVIDER': 'openai',
                                     'XUENESS_API_BASE': 'https://api.example.test/v1',
                                     'XUENESS_MODEL': 'gpt-4o', 'XUENESS_API_KEY': 'goal-test-key',
                                     'ANTHROPIC_API_KEY': ''}):
            code, prepared = self.request('/api/composer/prepare', 'POST',
                                         {'text': '解释一下二分查找', 'input': {}})
            self.assertEqual(code, 200)
            self.assertFalse(prepared['goal'])
            code, created = self.request('/api/sessions', 'POST',
                                        {'task': '解释一下二分查找', 'root': prepared['root'],
                                         'prepared_token': prepared['token']})
            self.assertEqual(code, 200)
            self.assertIsNone(self.request(f"/api/sessions/{created['id']}/goal")[1]['goal'])


class ComposerHelperTests(unittest.TestCase):
    """Sessions only forwards a flagged input; planning decides what a goal is."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.store = Store(self.state)
        self.ctx = {'state_dir': self.state, 'store': self.store}
        self.session = self.store.new('任务', Path(self.temp.name))

    def apply(self, prepared, text='原话'):
        http_routes._apply_prepared_goal(self.ctx, self.session, prepared, text)

    def test_only_a_boolean_goal_flag_from_the_prepared_cache_registers(self):
        for prepared in ({'text': '扩展后的输入', 'metadata': {}},
                        {'text': '扩展后的输入', 'metadata': {}, 'goal': False}):
            with self.subTest(prepared=prepared):
                self.apply(prepared)
                self.assertIsNone(session_goal.current(self.session))
        self.apply({'text': '扩展后的输入', 'metadata': {}, 'goal': True})
        goal = session_goal.current(self.session)
        self.assertEqual(goal['text'], '原话')
        self.assertEqual(goal['history'][-1]['source'], 'composer')

    def test_disabled_planning_leaves_the_session_untouched(self):
        set_enabled(self.state, 'planning', False)
        self.apply({'text': 'x', 'metadata': {}, 'goal': True})
        self.assertIsNone(session_goal.current(self.session))


if __name__ == '__main__':
    unittest.main()
