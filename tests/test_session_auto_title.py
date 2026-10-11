"""sessions.auto_title: one generated short title after the first settled answer."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.core import Gate, Store, run
from xueness.bundled_plugins.sessions import auto_title
from xueness.bundled_plugins.sessions.session_management import rename, validate_title
from xueness.bundled_plugins.settings.settings_store import save_settings

TASK = '帮我把报告重命名为最终版并归档'
ANSWER = '已把报告重命名为最终版并归档。'
TITLE = '报告重命名归档'


class TitleProvider:
    """Deterministic naming-call fixture; records every request it receives."""

    def __init__(self, content=None, error=None, finish='stop'):
        self.content = content if content is not None else json.dumps(
            {'title': TITLE}, ensure_ascii=False)
        self.error = error
        self.finish = finish
        self.calls = []

    def complete(self, messages, tools):
        self.calls.append({'messages': messages, 'tools': tools})
        if self.error is not None:
            raise self.error
        return {'content': self.content, '_finish_reason': self.finish}


class RunAndTitleProvider:
    """Answers the real run driver and the naming call from one fixture."""

    def __init__(self):
        # Shallow-copied per naming request, so shared mutable state records calls.
        self.title_calls = []

    def complete(self, messages, tools):
        first = messages[0] if messages else {}
        if isinstance(first, dict) and first.get('role') == 'system' \
                and 'short conversation title' in str(first.get('content')):
            self.title_calls.append([message.get('role') for message in messages])
            return {'content': json.dumps({'title': '演示短标题'}, ensure_ascii=False),
                    '_finish_reason': 'stop'}
        return {'content': ANSWER, '_finish_reason': 'stop'}


class AutoTitleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / 'state'
        self.root = Path(temp.name) / 'workspace'
        self.root.mkdir()
        self.store = Store(self.state)
        self.session = self.store.new(TASK, self.root)
        self.session['messages'].append({'role': 'assistant', 'content': ANSWER})
        self.store.save(self.session)

    def generate(self, provider):
        return auto_title.generate_and_store(self.session['id'], self.store, self.state,
                                             provider=provider)

    def reload(self):
        return self.store.load(self.session['id'])

    def test_default_on_and_first_answer_generates_bounded_title(self):
        self.assertTrue(auto_title.enabled(self.state))
        provider = TitleProvider()
        self.assertEqual(self.generate(provider), TITLE)
        fresh = self.reload()
        self.assertEqual(fresh['title'], TITLE)
        self.assertEqual(fresh['title_source'], 'generated')
        self.assertTrue(fresh.get('title_generated_at'))
        self.assertTrue(validate_title(fresh['title']))
        # Generated titles are never regenerated while they stand.
        second = TitleProvider(content=json.dumps({'title': '另一个标题'}, ensure_ascii=False))
        self.assertIsNone(self.generate(second))
        self.assertEqual(second.calls, [])
        self.assertEqual(self.reload()['title'], TITLE)
        # The naming request is tool-free, structured and bounded.
        self.assertEqual(len(provider.calls), 1)
        call = provider.calls[0]
        self.assertEqual(call['tools'], [])
        self.assertEqual([message['role'] for message in call['messages']], ['system', 'user'])
        self.assertIn(str(auto_title.MAX_TITLE_CHARS), call['messages'][0]['content'])
        payload = json.loads(call['messages'][1]['content'])
        self.assertEqual(set(payload), {'task', 'userMessage', 'assistantReply'})
        self.assertEqual(payload['userMessage'], TASK)
        self.assertEqual(payload['assistantReply'], ANSWER)

    def test_manual_rename_is_never_overwritten(self):
        renamed = rename(self.store, self.session['id'], '我的归档任务')
        self.assertEqual(renamed['title'], '我的归档任务')
        self.assertEqual(renamed['title_source'], 'manual')
        provider = TitleProvider()
        self.assertIsNone(self.generate(provider))
        self.assertEqual(provider.calls, [])
        fresh = self.reload()
        self.assertEqual(fresh['title'], '我的归档任务')
        self.assertEqual(fresh['title_source'], 'manual')

    def test_disabled_toggle_or_plugin_never_starts_a_request(self):
        save_settings(self.state, {'general': {'sessionsAutoTitleEnabled': False}})
        self.assertFalse(auto_title.enabled(self.state))
        with patch('xueness.provider_config.resolve') as resolve:
            auto_title.settle_auto_title(self.session, self.store, synchronous=True)
            resolve.assert_not_called()
        self.assertIsNone(self.reload().get('title'))

        save_settings(self.state, {'general': {}})
        self.assertTrue(auto_title.enabled(self.state))
        plugin_runtime.set_enabled(self.state, 'providers', False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, 'providers', True)
        self.assertFalse(auto_title.enabled(self.state))
        with patch('xueness.provider_config.resolve') as resolve:
            auto_title.settle_auto_title(self.session, self.store, synchronous=True)
            resolve.assert_not_called()
        self.assertIsNone(self.reload().get('title'))

        plugin_runtime.set_enabled(self.state, 'sessions', False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, 'sessions', True)
        self.assertFalse(auto_title.enabled(self.state))

    def test_child_sessions_never_get_automatic_titles(self):
        """Delegated children keep their task name; no thread touches their journal."""
        child = dict(self.session)
        child['parent'] = self.session['id']
        child['delegation'] = {'taskId': 'task-probe', 'parentSessionId': self.session['id'],
                               'rootSessionId': self.session['id']}
        self.assertTrue(auto_title.is_child_session(child))
        with patch('xueness.provider_config.resolve') as resolve:
            auto_title.settle_auto_title(child, self.store, synchronous=True)
            resolve.assert_not_called()
        self.assertIsNone(self.reload().get('title'))
        # Forks are root sessions: the fork_parent marker must not exclude them.
        fork = dict(self.session)
        fork['fork_parent'] = {'sessionId': self.session['id']}
        self.assertFalse(auto_title.is_child_session(fork))

    def test_lightweight_profile_never_gets_automatic_titles(self):
        """The lightweight profile's bounded request budget excludes naming calls."""
        light = dict(self.session)
        light['runtime_profile'] = 'lightweight'
        with patch('xueness.provider_config.resolve') as resolve:
            auto_title.settle_auto_title(light, self.store, synchronous=True)
            resolve.assert_not_called()
        self.assertIsNone(self.reload().get('title'))
        standard = dict(self.session)
        standard['runtime_profile'] = 'standard'
        with patch('xueness.provider_config.resolve', return_value=None) as resolve:
            auto_title.settle_auto_title(standard, self.store, synchronous=True)
            self.assertEqual(resolve.call_count, 1)

    def test_failures_are_silent_and_bounded(self):
        provider = TitleProvider(error=RuntimeError('quota exhausted'))
        for _ in range(auto_title.MAX_FAILURES_PER_SESSION):
            self.assertIsNone(self.generate(provider))
        fresh = self.reload()
        self.assertIsNone(fresh.get('title'))
        self.assertIsNone(fresh.get('title_source'))
        self.assertTrue(auto_title.needs_title(fresh))
        # The failure cap stops further requests even for a healthy provider.
        healthy = TitleProvider()
        self.assertIsNone(self.generate(healthy))
        self.assertEqual(healthy.calls, [])
        self.assertEqual(self.reload().get('title'), None)

    def test_unusable_answers_keep_the_original_title(self):
        for content in ('', '{"summary": "not a title"}', 'word ' * 40):
            with self.subTest(content=content):
                provider = TitleProvider(content=content)
                self.assertIsNone(self.generate(provider))
                fresh = self.reload()
                self.assertIsNone(fresh.get('title'))
                self.assertTrue(auto_title.needs_title(fresh))
        non_stop = TitleProvider(finish='tool_use')
        self.assertIsNone(self.generate(non_stop))
        self.assertIsNone(self.reload().get('title'))

    def test_model_answer_validation(self):
        cases = {
            '{"title": "整理季度报告"}': '整理季度报告',
            '```json\n{"title": "整理季度报告"}\n```': '整理季度报告',
            '整理季度报告': '整理季度报告',
            '"整理季度报告"': '整理季度报告',
            '「整理季度报告」': '整理季度报告',
            '{"title": "  多   行  标题 "}': '多 行 标题',
            '{"title": "' + '字' * 41 + '"}': '字' * 40,
            '{"title": ""}': None,
            '{"title": "bad\\u0007title"}': None,
            '{"title": 3}': None,
            'word ' * 41: None,
            '': None,
            None: None,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(auto_title.title_from_model(raw), expected)

    def test_run_settlement_generates_title_once(self):
        provider = RunAndTitleProvider()
        with patch('xueness.provider_config.resolve', return_value=provider):
            run(self.store.load(self.session['id']), self.store, provider, Gate(self.root))
            deadline = time.monotonic() + 15
            fresh = self.reload()
            while fresh.get('title_source') != 'generated' and time.monotonic() < deadline:
                time.sleep(0.05)
                fresh = self.reload()
        self.assertEqual(fresh.get('title'), '演示短标题')
        self.assertEqual(fresh.get('title_source'), 'generated')
        self.assertGreaterEqual(len(provider.title_calls), 1)
        self.assertEqual(provider.title_calls[0], ['system', 'user'])


if __name__ == '__main__':
    unittest.main()
