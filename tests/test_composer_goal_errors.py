"""Composer 提交的目标被 planning 拒绝时，每条 HTTP 路径都要给出目标自己的状态码。

覆盖首轮创建、跟进轮次与运行中排队的后续轮次：非法目标（空、超过 5000 字、来源
未知）必须是 400，planning 关闭必须是 403，两者都不能落到通用 500、别的路径文案
（如「session workspace mismatch」或服务商配置指引），也不能把会话写成半成品。
全部使用隔离状态目录、本地 fixture provider 与被替换的运行入口，不访问网络、
不调用真实模型。
"""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import web
from xueness.bundled_plugins.planning import plugin as planning_plugin
from xueness.bundled_plugins.planning import session_goal
from xueness.bundled_plugins.planning.session_goal import GoalError
from xueness.bundled_plugins.sessions.queue import MessageQueue
from xueness.plugin_runtime import set_enabled
from tests.fake_provider_fixture import inject_provider

#: planning 的目标上限与 HTTP 各层的文本上限同为 5000，所以超长提交先在入口被挡住；
#: 越靠近 planning 的那条检查用它的真实拒绝验证状态映射，不放宽任何真实上限。
TOO_LONG = session_goal.MAX_GOAL_CHARS + 1
DISABLED = {'error': 'plugin disabled or dependency unavailable: planning',
            'plugin': 'planning', 'code': 'forbidden', 'status': 403}
TOO_LONG_BODY = {'error': '会话目标最长 5000 个字符', 'code': 'bad_request', 'status': 400}


class GoalHttpHarness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / 'project'
        self.project.mkdir()
        self.state = base / 'state'
        self.ctx = web.build_context(self.state, base / 'runs', self.project,
                                     csrf='test', allow_real=True)
        self.ctx['workspace_roots'] = ()
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)
        self.base_url = 'http://127.0.0.1:' + str(self.server.server_address[1])
        self.store = self.ctx['store']
        env = patch.dict(os.environ, {
            'XUENESS_PROVIDER': 'openai',
            'XUENESS_API_BASE': 'https://api.example.test/v1',
            'XUENESS_MODEL': 'gpt-4o',
            'XUENESS_API_KEY': 'goal-error-test-key',
            'ANTHROPIC_API_KEY': '',
        })
        env.start()
        self.addCleanup(env.stop)

    def request(self, path, method='POST', data=None):
        body = None if data is None else json.dumps(data).encode()
        headers = {'Content-Type': 'application/json', 'X-CSRF-Token': 'test'}
        req = urllib.request.Request(self.base_url + path, data=body, headers=headers,
                                     method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def prepare(self, text):
        """One composer input flagged as a goal, bound to the default project root."""
        return self.request('/api/composer/prepare', data={'text': text,
                                                           'input': {'goal': True}})

    def goal_of(self, sid):
        code, body = self.request(f'/api/sessions/{sid}/goal', method='GET')
        self.assertEqual(code, 200, body)
        return body['goal']

    def session_in_project(self, task='把首屏降到 1 秒内'):
        return self.store.new(task, self.project)['id']


class SubmittedGoalTests(GoalHttpHarness):
    """首轮与跟进轮次的提交入口。"""

    def test_first_turn_refuses_an_over_long_goal_and_creates_no_session(self):
        before = self.store.list()
        code, prepared = self.prepare('解释一下二分查找')
        self.assertEqual(code, 200, prepared)
        code, body = self.request('/api/sessions', data={
            'task': '目' * TOO_LONG, 'root': prepared['root'],
            'prepared_token': prepared['token']})
        self.assertEqual(code, 400)
        self.assertIn('1..5000', body['error'])
        self.assertEqual(self.store.list(), before)

    def test_first_turn_reports_the_goal_limit_planning_enforces(self):
        before = self.store.list()
        code, prepared = self.prepare('解释一下二分查找')
        self.assertEqual(code, 200, prepared)
        with patch.object(web, '_MAX_TASK', TOO_LONG + 10):
            code, body = self.request('/api/sessions', data={
                'task': '目' * TOO_LONG, 'root': prepared['root'],
                'prepared_token': prepared['token']})
        self.assertEqual(code, 400)
        self.assertEqual(body, TOO_LONG_BODY)
        self.assertEqual(self.store.list(), before)

    def test_first_turn_refuses_a_goal_when_planning_is_closed(self):
        before = self.store.list()
        code, prepared = self.prepare('把首屏降到 1 秒内')
        self.assertEqual(code, 200, prepared)
        set_enabled(self.state, 'planning', False)
        code, body = self.request('/api/sessions', data={
            'task': '把首屏降到 1 秒内', 'root': prepared['root'],
            'prepared_token': prepared['token']})
        self.assertEqual(code, 403)
        self.assertEqual(body, DISABLED)
        self.assertEqual(self.store.list(), before)

    def test_first_turn_records_a_legal_goal(self):
        code, prepared = self.prepare('把首屏降到 1 秒内')
        self.assertEqual(code, 200, prepared)
        code, created = self.request('/api/sessions', data={
            'task': '把首屏降到 1 秒内', 'root': prepared['root'],
            'prepared_token': prepared['token']})
        self.assertEqual(code, 200, created)
        goal = self.goal_of(created['id'])
        self.assertEqual(goal['text'], '把首屏降到 1 秒内')
        self.assertEqual(goal['status'], 'active')
        self.assertEqual(goal['history'][-1]['source'], 'composer')

    def test_follow_up_turn_reports_the_goal_refusal_without_provider_guidance(self):
        sid = self.session_in_project()
        before = self.store.load(sid)
        code, prepared = self.prepare('把接口超时降到 200 毫秒')
        self.assertEqual(code, 200, prepared)
        # HTTP 各层的消息上限先挡住 5001 字，这里用 planning 真正的拒绝验证状态映射。
        with patch.object(planning_plugin, 'apply_session_goal',
                          side_effect=GoalError('会话目标最长 5000 个字符')):
            code, body = self.request(f'/api/sessions/{sid}/messages', data={
                'text': '把接口超时降到 200 毫秒', 'prepared_token': prepared['token']})
        self.assertEqual(code, 400)
        self.assertEqual(body, TOO_LONG_BODY)
        self.assertEqual(self.store.load(sid), before)

    def test_follow_up_turn_refuses_an_over_long_goal_and_writes_nothing(self):
        sid = self.session_in_project()
        before = self.store.load(sid)
        code, prepared = self.prepare('把接口超时降到 200 毫秒')
        self.assertEqual(code, 200, prepared)
        code, body = self.request(f'/api/sessions/{sid}/messages', data={
            'text': '目' * TOO_LONG, 'prepared_token': prepared['token']})
        self.assertEqual(code, 400)
        self.assertEqual(self.store.load(sid), before)
        self.assertIsNone(self.goal_of(sid))

    def test_follow_up_turn_refuses_a_goal_when_planning_is_closed(self):
        sid = self.session_in_project()
        before = self.store.load(sid)
        code, prepared = self.prepare('把接口超时降到 200 毫秒')
        self.assertEqual(code, 200, prepared)
        set_enabled(self.state, 'planning', False)
        code, body = self.request(f'/api/sessions/{sid}/messages', data={
            'text': '把接口超时降到 200 毫秒', 'prepared_token': prepared['token']})
        self.assertEqual(code, 403)
        self.assertEqual(body, DISABLED)
        self.assertEqual(self.store.load(sid), before)

    def test_follow_up_turn_records_a_legal_goal(self):
        sid = self.session_in_project()
        code, prepared = self.prepare('把接口超时降到 200 毫秒')
        self.assertEqual(code, 200, prepared)
        code, body = self.request(f'/api/sessions/{sid}/messages', data={
            'text': '把接口超时降到 200 毫秒', 'prepared_token': prepared['token']})
        self.assertEqual(code, 200, body)
        goal = self.goal_of(sid)
        self.assertEqual(goal['text'], '把接口超时降到 200 毫秒')
        self.assertEqual(goal['history'][-1]['source'], 'composer')
        saved = self.store.load(sid)
        self.assertEqual(saved['messages'][-1]['role'], 'user')
        self.assertEqual(saved['messages'][-1]['content'], '把接口超时降到 200 毫秒')

    def test_an_unflagged_submission_still_ignores_planning_state(self):
        sid = self.session_in_project()
        code, prepared = self.request('/api/composer/prepare',
                                      data={'text': '解释一下二分查找', 'input': {}})
        self.assertEqual(code, 200, prepared)
        set_enabled(self.state, 'planning', False)
        code, body = self.request(f'/api/sessions/{sid}/messages', data={
            'text': '解释一下二分查找', 'prepared_token': prepared['token']})
        self.assertEqual(code, 200, body)
        set_enabled(self.state, 'planning', True)
        self.assertIsNone(self.goal_of(sid))


class QueuedGoalTurnTests(GoalHttpHarness):
    """运行期间排队的后续轮次：拒绝必须发生在写入与模型调用之前。"""

    def setUp(self):
        super().setUp()
        self.model_calls = []

    def run_turn(self, sid):
        def no_cost_run(session, store, provider, gate, steps, max_chars, **kwargs):
            self.model_calls.append(session['id'])
            session.update(status='completed', steps=1, mode='build',
                           completion={'verified': True, 'summary': 'ok'},
                           pending_question=None, todos=[], hook_log=[])
            store.save(session)
            return session

        with patch('xueness.web.run', side_effect=no_cost_run), \
                inject_provider(ctx=self.ctx):
            return self.request(f'/api/sessions/{sid}/run', data={'provider': 'real',
                                                                 'steps': 1})

    def queue_goal(self, sid, text, expanded='扩展后的排队输入'):
        queue = MessageQueue(self.store)
        queue.set_accepting(sid, True)
        return queue.enqueue(sid, text, prepared={'text': expanded, 'metadata': {},
                                                 'goal': True})

    def test_queued_turn_reports_goal_refusals_instead_of_a_workspace_error(self):
        sid = self.session_in_project()
        self.assertEqual(self.run_turn(sid)[0], 200)
        self.model_calls.clear()
        before = self.store.load(sid)
        self.queue_goal(sid, '把接口超时降到 200 毫秒')
        # 排队入口的 5000 字上限同样先于 planning，所以这里注入 planning 真实的
        # 超长拒绝，验证它不会被写成「session workspace mismatch」。
        with patch.object(planning_plugin, 'apply_session_goal',
                          side_effect=GoalError('会话目标最长 5000 个字符')):
            code, body = self.run_turn(sid)
        self.assertEqual(code, 400)
        self.assertEqual(body, TOO_LONG_BODY)
        self.assertEqual(self.model_calls, [])
        saved = self.store.load(sid)
        self.assertEqual(saved['messages'], before['messages'])
        self.assertIsNone(self.goal_of(sid))

    def test_queued_turn_refuses_when_planning_is_closed(self):
        sid = self.session_in_project()
        self.assertEqual(self.run_turn(sid)[0], 200)
        self.model_calls.clear()
        before = self.store.load(sid)
        self.queue_goal(sid, '把接口超时降到 200 毫秒')
        set_enabled(self.state, 'planning', False)
        code, body = self.run_turn(sid)
        self.assertEqual(code, 403)
        self.assertEqual(body, DISABLED)
        self.assertEqual(self.model_calls, [])
        self.assertEqual(self.store.load(sid)['messages'], before['messages'])

    def test_queued_turn_records_a_legal_goal(self):
        sid = self.session_in_project()
        self.assertEqual(self.run_turn(sid)[0], 200)
        self.queue_goal(sid, '把接口超时降到 200 毫秒')
        code, body = self.run_turn(sid)
        self.assertEqual(code, 200, body)
        goal = self.goal_of(sid)
        self.assertEqual(goal['text'], '把接口超时降到 200 毫秒')
        self.assertEqual(goal['history'][-1]['source'], 'composer')
        saved = self.store.load(sid)
        self.assertEqual(saved['messages'][-1]['content'], '扩展后的排队输入')


if __name__ == '__main__':
    unittest.main()
