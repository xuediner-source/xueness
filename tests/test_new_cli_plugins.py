"""CLI surfaces for onboarding, named SSH and source updates."""
import argparse
import io
import json
import os
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.bundled_plugins.onboarding import plugin as onboarding
from xueness.bundled_plugins.browser import plugin as browser
from xueness.bundled_plugins.remote import plugin as remote
from xueness.bundled_plugins.updates import plugin as updates
from xueness.tool_contract import bind_execution
from xueness import plugin_runtime


class NewCliPluginTests(unittest.TestCase):
    def test_browser_session_is_reused_and_screenshot_uses_one_exec_gate(self):
        class Gate:
            def __init__(self): self.checks = []
            def check(self, kind, subject, call_id): self.checks.append((kind, subject, call_id))
        class Broker:
            def __init__(self): self.calls = []
            def call(self, command):
                self.calls.append(command)
                return {'ok': True, 'url': 'https://example.com/', 'text': 'page',
                        'imageDataUrl': 'data:image/png;base64,iVBORw0KGgo='}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / 'state', Path(tmp) / 'root'
            state.mkdir(); root.mkdir()
            plugin_runtime.set_enabled(state, 'browser', True)
            broker = Broker()
            gate = Gate()
            with mock.patch.object(browser, '_broker', return_value=broker), \
                 bind_execution(state_dir=state):
                browser._call('navigate', root, gate, {'url': 'https://example.com/'}, None, 'n1')
                browser._call('fill', root, gate, {'selector': '#q', 'text': 'safe'}, None, 'f1')
                browser._call('click', root, gate, {'selector': '#go'}, None, 'c1')
                browser._call('screenshot', root, gate, {}, None, 's1')
            self.assertEqual(['navigate', 'fill', 'click', 'screenshot'],
                             [call['action'] for call in broker.calls])
            self.assertEqual(['exec', 'exec', 'exec', 'exec'],
                             [item[0] for item in gate.checks])
            self.assertEqual(450 * 1024, broker.calls[-1]['maxPngBytes'])
            self.assertNotIn('output', broker.calls[-1])
            self.assertEqual([], list(root.iterdir()))

    def test_browser_screenshot_payload_is_bounded_png_data_url(self):
        import base64
        class Gate:
            def check(self, kind, subject, call_id): self.checks.append(kind)
            def __init__(self): self.checks = []
        class Broker:
            def call(self, command):
                png = b'\x89PNG\r\n\x1a\n' + b'x' * 32
                return {'ok': True, 'imageDataUrl': 'data:image/png;base64,' +
                        base64.b64encode(png).decode('ascii')}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / 'state', Path(tmp) / 'root'
            state.mkdir(); root.mkdir()
            plugin_runtime.set_enabled(state, 'browser', True)
            gate = Gate()
            with mock.patch.object(browser, '_broker', return_value=Broker()), bind_execution(state_dir=state):
                result = browser._call('screenshot', root, gate, {}, None, 'shot')
            self.assertTrue(result['imageDataUrl'].startswith('data:image/png;base64,'))
            self.assertEqual(['exec'], gate.checks)
            self.assertEqual([], list(root.iterdir()))

    def test_browser_rejects_oversized_screenshot_payload(self):
        import base64
        class Gate:
            def check(self, kind, subject, call_id): pass
        class Broker:
            def call(self, command):
                png = b'\x89PNG\r\n\x1a\n' + b'x' * (browser.MAX_SCREENSHOT_PNG + 1)
                return {'ok': True, 'imageDataUrl': 'data:image/png;base64,' +
                        base64.b64encode(png).decode('ascii')}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / 'state', Path(tmp) / 'root'
            state.mkdir(); root.mkdir()
            plugin_runtime.set_enabled(state, 'browser', True)
            with mock.patch.object(browser, '_broker', return_value=Broker()), bind_execution(state_dir=state):
                with self.assertRaisesRegex(RuntimeError, 'invalid screenshot'):
                    browser._call('screenshot', root, Gate(), {}, None, 'oversized')

    def test_browser_disable_hook_closes_owned_worker(self):
        broker = mock.Mock()
        key = str(Path('/tmp/xueness-browser-test').resolve())
        with mock.patch.dict(browser._BROKERS, {key: broker}):
            browser.shutdown(key)
        broker.close.assert_called_once_with()

    def test_onboarding_stores_hidden_key_but_never_prints_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(state=Path(tmp), language='en', id='local', name='Local',
                protocol='anthropic', base_url='https://api.anthropic.com/v1', model='claude-test',
                capabilities='image,pdf', api_key_env=None)
            out, err = io.StringIO(), io.StringIO()
            with mock.patch('sys.stdin.isatty', return_value=True), \
                 mock.patch.object(onboarding.getpass, 'getpass', return_value='do-not-print-key'), \
                 redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(0, onboarding.execute_cli(args))
            self.assertNotIn('do-not-print-key', out.getvalue() + err.getvalue())
            result = json.loads(out.getvalue())
            self.assertTrue(result['provider']['hasKey'])
            profile = Path(tmp) / 'providers' / 'local.json'
            self.assertIn('do-not-print-key', profile.read_text())
            self.assertEqual(0o600, profile.stat().st_mode & 0o777)

    def test_remote_cli_keeps_host_verification_and_uses_exact_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            save = argparse.Namespace(state=state, remote_action='save', id='staging', host='build.example',
                                      user='deploy', port=2222, directory='/srv/project')
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, remote.execute_cli(save))
            denied = argparse.Namespace(state=state, remote_action='exec', id='staging', root=Path(tmp),
                                        allow_exec=False, argv=['--', 'printf', '%s', 'hello world'])
            with mock.patch('xueness.cli._approval_prompt', return_value='n'), \
                 mock.patch.object(remote.subprocess, 'run') as run:
                with redirect_stderr(io.StringIO()):
                    self.assertEqual(1, remote.execute_cli(denied))
                run.assert_not_called()

            approved = argparse.Namespace(**{**vars(denied), 'allow_exec': True})
            completed = mock.Mock(returncode=0, stdout='hello world', stderr='')
            output = io.StringIO()
            with mock.patch.object(remote.subprocess, 'run', return_value=completed) as run, \
                 redirect_stdout(output):
                self.assertEqual(0, remote.execute_cli(approved))
            command = run.call_args.args[0]
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertNotIn('StrictHostKeyChecking=no', command)
            self.assertEqual('hello world', json.loads(output.getvalue())['output'])
            self.assertIn("'hello world'", command[-1])

    def test_remote_cli_state_is_jail_and_digest_binds_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            remote._atomic_write_json(state / 'remote-connections.json', [
                {'id': 'node', 'host': 'host.example', 'user': 'operator', 'port': 22, 'directory': '.'}])
            row = remote._load(state)[0]
            args = {'connection': 'node', 'connection_digest': remote._digest(row), 'argv': ['echo', 'ok']}
            class Gate:
                def check(self, kind, subject, call_id):
                    self.seen = (kind, json.loads(subject), call_id)
            gate = Gate()
            with mock.patch.object(remote.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='', stderr='')) as run:
                with bind_execution(state_dir=state):
                    remote._exec(Path(tmp), gate, args, None, 'call-7')
            self.assertEqual(('exec', args, 'call-7'), gate.seen)
            self.assertNotIn('StrictHostKeyChecking=no', run.call_args.args[0])
            args['connection_digest'] = 'stale'
            with bind_execution(state_dir=state), self.assertRaisesRegex(ValueError, 'connection changed'):
                remote._exec(Path(tmp), gate, args, None, 'call-8')

    def test_updates_require_explicit_flag_and_dirty_checkout_refuses_before_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', '-C', str(root), 'init', '-q', '-b', 'main'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.email=test@example.com',
                            '-c', 'user.name=test', 'commit', '--allow-empty', '-qm', 'init'], check=True)
            (root / 'local.txt').write_text('pending')
            with mock.patch.object(updates, '_configured_origin', return_value='main'), \
                 mock.patch.object(updates, '_git', wraps=updates._git) as git:
                with self.assertRaisesRegex(ValueError, 'local changes'):
                    updates.apply(root)
                self.assertFalse(any(call.args[1] == 'fetch' for call in git.call_args_list))
        args = argparse.Namespace(update_action='apply', allow_update=False)
        with mock.patch.object(updates, '_repo_root') as repo:
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(1, updates.execute_cli(args))
            repo.assert_not_called()
            self.assertIn('--allow-update', stderr.getvalue())

    def test_update_remote_url_filter_rejects_helpers_and_embedded_credentials(self):
        self.assertTrue(updates._safe_origin('https://github.com/xueness/xueness.git'))
        self.assertTrue(updates._safe_origin('git@github.com:xueness/xueness.git'))
        for remote_url in ('ext::sh -c evil', '/tmp/fake.git', 'https://user:secret@host/x.git'):
            with self.subTest(remote=remote_url):
                self.assertFalse(updates._safe_origin(remote_url))

    def test_update_check_uses_read_only_origin_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', '-C', str(root), 'init', '-q', '-b', 'main'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.email=test@example.com',
                            '-c', 'user.name=test', 'commit', '--allow-empty', '-qm', 'init'], check=True)
            subprocess.run(['git', '-C', str(root), 'remote', 'add', 'origin',
                            'https://example.com/xueness.git'], check=True)
            head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], check=True,
                                  capture_output=True, text=True).stdout.strip()
            subprocess.run(['git', '-C', str(root), 'update-ref', 'refs/remotes/origin/main', head], check=True)
            subprocess.run(['git', '-C', str(root), 'branch', '--set-upstream-to=origin/main', 'main'],
                           check=True, capture_output=True)
            actual_git = updates._git
            seen = []
            def no_network(repo, *argv, **kwargs):
                seen.append(argv)
                if argv[0] == 'ls-remote':
                    return SimpleNamespace(stdout=f'{head}\trefs/heads/main\n',
                                            stderr='', returncode=0)
                return actual_git(repo, *argv, **kwargs)
            with mock.patch.object(updates, '_git', side_effect=no_network):
                result = updates.check(root)
            self.assertEqual('same', result['relation'])
            self.assertFalse(result['originDiffers'])
            self.assertTrue(any(call[0] == 'ls-remote' for call in seen))
            self.assertFalse(any(call[0] == 'fetch' for call in seen))


if __name__ == '__main__':
    unittest.main()
