"""sessions.auto_title: one generated short title after the first settled answer."""
import json
import io
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.cli import main as cli_main
from xueness.core import Gate, Store, run
from xueness.bundled_plugins.providers.default_selection import save as save_default
from xueness.bundled_plugins.providers.provider import OpenAICompatible
from xueness.bundled_plugins.providers.providers_api import dispatch as dispatch_provider
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


class BoundTitleProvider(OpenAICompatible):
    """Real adapter type with a deterministic local transport for lifecycle tests."""

    def __init__(self):
        super().__init__(base='https://models.example.test/v1', model='bound-model',
                         key='fixture-only-key')
        self.title_models = []

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        first = messages[0] if isinstance(messages, list) and messages else {}
        if (isinstance(first, dict) and first.get('role') == 'system'
                and 'short conversation title' in str(first.get('content'))):
            self.title_models.append(self.model)
            content = json.dumps({'title': '绑定模型命名'}, ensure_ascii=False)
            if on_delta is not None:
                on_delta(content)
            return {'content': content, '_finish_reason': 'stop'}
        return {'content': json.dumps({'summary': ANSWER, 'evidence': []}, ensure_ascii=False),
                '_finish_reason': 'stop'}


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

    def test_manual_rename_landing_at_commit_wins_the_atomic_update(self):
        provider = TitleProvider()
        original_update = self.store.update
        renamed = False

        def rename_before_update(sid, mutate):
            nonlocal renamed
            if not renamed:
                renamed = True
                rename(self.store, sid, '刚刚手动改名')
            return original_update(sid, mutate)

        # The operator rename lands after the model answer but before the
        # generated title transaction reads the journal for its final update.
        with patch.object(self.store, 'update', side_effect=rename_before_update):
            self.assertIsNone(self.generate(provider))
        fresh = self.reload()
        self.assertEqual(fresh['title'], '刚刚手动改名')
        self.assertEqual(fresh['title_source'], 'manual')

    def test_renaming_to_the_existing_task_text_still_marks_it_manual(self):
        renamed = rename(self.store, self.session['id'], TASK)
        self.assertEqual(renamed['title'], TASK)
        self.assertEqual(renamed['title_source'], 'manual')
        provider = TitleProvider()
        self.assertIsNone(self.generate(provider))
        self.assertEqual(provider.calls, [])

    def test_queued_worker_rechecks_plugins_before_resolving_or_requesting(self):
        queued = []

        class DeferredThread:
            def __init__(self, target, args=(), kwargs=None, **options):
                self.target = target
                self.args = args
                self.kwargs = kwargs or {}

            def start(self):
                queued.append(self)

        with patch.object(auto_title.threading, 'Thread', DeferredThread):
            auto_title.settle_auto_title(
                self.session, self.store, provider=BoundTitleProvider(),
                allow_model_requests=True)
        self.assertEqual(len(queued), 1)

        plugin_runtime.set_enabled(self.state, 'providers', False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, 'providers', True)
        with patch('xueness.provider_config.resolve') as resolve:
            queued[0].target(*queued[0].args, **queued[0].kwargs)
            resolve.assert_not_called()
        self.assertNotIn(self.session['id'], auto_title._SCHEDULED)

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
        with patch('xueness.provider_config.resolve') as resolve:
            auto_title.settle_auto_title(
                standard, self.store, provider=BoundTitleProvider(),
                allow_model_requests=True, synchronous=True)
            resolve.assert_not_called()
        self.assertEqual(self.reload().get('title'), '绑定模型命名')

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
        provider = BoundTitleProvider()
        with patch('xueness.provider_config.resolve') as resolve:
            run(self.store.load(self.session['id']), self.store, provider, Gate(self.root))
            deadline = time.monotonic() + 15
            fresh = self.reload()
            while fresh.get('title_source') != 'generated' and time.monotonic() < deadline:
                time.sleep(0.05)
                fresh = self.reload()
            resolve.assert_not_called()
        self.assertEqual(fresh.get('title'), '绑定模型命名')
        self.assertEqual(fresh.get('title_source'), 'generated')
        self.assertEqual(provider.title_models, ['bound-model'])

    def test_normal_cli_bound_provider_keeps_automatic_title_enabled(self):
        provider = BoundTitleProvider()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('xueness.provider_config.resolve', return_value=provider) as resolve, \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main([
                '--state', str(self.state), 'run', '--prompt', 'Say hello',
                '--root', str(self.root), '--output-format', 'json',
            ])
        self.assertEqual(code, 0, stderr.getvalue())
        resolve.assert_called_once()
        result = json.loads(stdout.getvalue())
        fresh = self.store.load(result['id'])
        deadline = time.monotonic() + 10
        while fresh.get('title_source') != 'generated' and time.monotonic() < deadline:
            time.sleep(0.05)
            fresh = self.store.load(result['id'])
        self.assertEqual(fresh.get('title'), '绑定模型命名')
        self.assertEqual(provider.title_models, ['bound-model'])

    def test_fake_provider_does_not_resolve_a_saved_real_default_for_title(self):
        from xueness.provider import FakeProvider

        status, _ = dispatch_provider('POST', ['api', 'providers'], {}, {
            'id': 'configured', 'name': 'Configured',
            'baseUrl': 'https://models.example.test/v1', 'model': 'paid-default',
            'apiKey': 'fixture-only-key',
        }, {'state_dir': self.state})
        self.assertEqual(status, 200)
        save_default(self.state, {'providerId': 'configured', 'model': 'paid-default'})
        fake_session = self.store.new(TASK, self.root)
        self.store.save(fake_session)

        def complete_fixture(session, *_args, **_kwargs):
            session['messages'].append({'role': 'assistant', 'content': ANSWER})
            session['status'] = 'completed'
            return session

        with patch('xueness.core._drive_run', side_effect=complete_fixture), \
                patch('xueness.provider_config.resolve') as resolve:
            run(fake_session, self.store, FakeProvider(), Gate(self.root))
            resolve.assert_not_called()
        saved = self.store.load(fake_session['id'])
        self.assertIsNone(saved.get('title_source'))
        self.assertNotIn(fake_session['id'], auto_title._SCHEDULED)


if __name__ == '__main__':
    unittest.main()
