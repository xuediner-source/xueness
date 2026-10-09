"""remote.handshake: probe, negotiate, then run. Default off.

The local host is mocked as both Windows and macOS. Nothing here opens a
network connection or runs ssh. Reference: ZCode v3.14.3
packages/server/src/remote/handshake.ts, detectEnv.ts, ssh-backend.ts,
remotePlatformSupport.ts, and packages/zcode-server-cli control errors.
"""
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.bundled_plugins.remote import handshake, plugin as remote
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.tool_contract import bind_execution


_HOSTS = (('win32', 'nt'), ('darwin', 'posix'))
_ROW = {'id': 'node', 'host': 'host.example', 'user': 'operator', 'port': 22,
        'directory': '/srv/my project'}


def _completed(stdout='', stderr='', code=0):
    return mock.Mock(returncode=code, stdout=stdout, stderr=stderr)


def _hello(platform='Linux', arch='x86_64', kernel='Linux', banner='motd line'):
    lines = []
    if banner:
        lines.append(banner)
    lines.extend([handshake.BEGIN, platform, arch, kernel, handshake.END])
    return '\n'.join(lines) + '\n'


class HandshakeParseTests(unittest.TestCase):
    def test_probe_script_has_no_operator_data_and_no_redirection(self):
        script = handshake.PROBE_COMMAND
        self.assertIn(handshake.BEGIN, script)
        self.assertIn(handshake.END, script)
        self.assertNotIn('/srv/my project', script)
        self.assertNotIn('secret-argv', script)
        self.assertNotIn('>', script)
        self.assertNotIn('&', script)
        self.assertEqual(script, (
            "printf '%s\\n' xueness-hello-begin\n"
            "uname -s\n"
            "uname -m\n"
            "xueness_kernel_ostype=$(cat /proc/sys/kernel/ostype || true)\n"
            "printf '%s\\n' \"$xueness_kernel_ostype\"\n"
            "printf '%s\\n' xueness-hello-end\n"
        ))

    def test_banner_crlf_and_kernel_override(self):
        parsed = handshake.parse_hello(_hello(platform='Darwin\r', arch='aarch64\r', kernel='Linux\r'))
        view = handshake.negotiate(parsed)
        self.assertEqual(view['platform'], 'linux')
        self.assertEqual(view['reportedPlatform'], 'darwin')
        self.assertTrue(view['platformCorrected'])
        self.assertEqual(view['arch'], 'arm64')
        self.assertEqual(view['reportedArch'], 'aarch64')
        self.assertEqual(view['capabilities'], ['posix-shell'])
        self.assertEqual(view['shell'], 'posix')
        self.assertTrue(view['accepted'])

    def test_windows_family_normalizes_before_the_command(self):
        for raw in ('Windows_NT', 'MINGW64_NT-10.0', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0'):
            with self.subTest(raw=raw):
                view = handshake.negotiate(handshake.parse_hello(_hello(platform=raw, kernel='')))
                self.assertEqual(view['platform'], 'win32')
                self.assertEqual(view['shell'], 'unsupported')
                self.assertEqual(view['capabilities'], [])
                self.assertFalse(view['accepted'])

    def test_preamble_limit_and_rejected_tokens(self):
        ok = ['banner'] * 31 + [handshake.BEGIN, 'Linux', 'x86_64', '', handshake.END]
        self.assertEqual(handshake.parse_hello('\n'.join(ok) + '\n')['platform'], 'Linux')
        blocked = ['banner'] * 32 + [handshake.BEGIN, 'Linux', 'x86_64', 'Linux', handshake.END]
        self.assertIsNone(handshake.parse_hello('\n'.join(blocked) + '\n'))
        self.assertIsNone(handshake.parse_hello(_hello(platform='Linux;id')))
        self.assertIsNone(handshake.parse_hello('no marker\n'))
        self.assertIsNone(handshake.parse_hello(_hello().replace(handshake.END, 'nope')))
        self.assertIsNone(handshake.parse_hello('x\0' + _hello()))

    def test_diagnostics_keep_the_tail_and_drop_controls(self):
        text = ('A' * 3000) + 'ENDMARK' + '\x1b[31m\x00\r'
        cleaned = handshake.bound_text(text)
        self.assertLessEqual(len(cleaned), handshake.MAX_DIAGNOSTIC_CHARS)
        self.assertTrue(cleaned.endswith('ENDMARK'))
        self.assertNotIn('\x1b', cleaned)
        self.assertNotIn('\x00', cleaned)
        self.assertEqual(handshake.bound_text('保持\n\t空白'), '保持\n\t空白')
        self.assertEqual(handshake.bound_text(None), '')

    def test_transport_classification_and_closed_probe(self):
        host_key = handshake.decide(255, 'banner\n', 'Host key verification failed.\n')
        self.assertFalse(host_key['accepted'])
        failure = host_key['result']['failure']
        self.assertEqual(failure['code'], 'ssh_host_key')
        self.assertFalse(failure['retryable'])
        auth = handshake.decide(255, '', 'Permission denied (publickey).')
        self.assertEqual(auth['result']['error_code'], 'ssh_auth')
        self.assertFalse(auth['result']['failure']['retryable'])
        refused = handshake.decide(255, '', 'ssh: connect to host example port 22: Connection refused')
        self.assertEqual(refused['result']['error_code'], 'ssh_unavailable')
        self.assertTrue(refused['result']['failure']['retryable'])
        timed = handshake.decide(255, '', 'Connection timed out')
        self.assertEqual(timed['result']['error_code'], 'ssh_timeout')
        invalid = handshake.decide(0, 'just a banner\n', '')
        self.assertEqual(invalid['result']['error_code'], 'handshake_invalid')
        self.assertFalse(invalid['result']['failure']['retryable'])
        self.assertNotIn('retryable', invalid['result'])
        self.assertIsInstance(invalid['result']['error'], str)


class HandshakeExecTests(unittest.TestCase):
    def _enable(self, state, value=True):
        save_settings(state, {'general': {handshake.SETTINGS_KEY: value}})

    def _exec(self, state, row, argv, gate=None):
        args = {'connection': row['id'], 'connection_digest': remote._digest(row), 'argv': argv}
        with bind_execution(state_dir=state):
            return remote._exec(Path(state), gate or mock.Mock(), args, None, 'call-1')

    def _row(self, state, **extra):
        row = {**_ROW, **extra}
        remote._atomic_write_json(state / 'remote-connections.json', [row])
        return remote._load(state)[0]

    def test_flag_off_keeps_the_single_command_on_windows_and_macos(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                for stored in ({}, {'general': {handshake.SETTINGS_KEY: 'true'}},
                               {'general': {handshake.SETTINGS_KEY: 1}},
                               {'general': []}):
                    save_settings(state, stored)
                    row = self._row(state)
                    flags = {}
                    original = remote._ssh_creationflags

                    def creationflags(original=original, os_name=os_name):
                        with mock.patch.object(remote.os, 'name', os_name), \
                                mock.patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
                            flags['value'] = original()
                        return flags['value']

                    with mock.patch.object(remote, '_ssh_creationflags', side_effect=creationflags), \
                            mock.patch.object(remote.subprocess, 'run', return_value=_completed(stdout='out')) as run:
                        result = self._exec(state, row, ['echo', 'hello world'])
                    self.assertEqual(run.call_count, 1)
                    command = run.call_args.args[0][-1]
                    self.assertIn("cd -- '/srv/my project'", command)
                    self.assertIn('echo', command)
                    self.assertNotIn(handshake.BEGIN, command)
                    self.assertEqual(set(result), {'ok', 'exit_code', 'output'})
                    self.assertEqual(result['output'], 'out')
                    self.assertEqual(flags['value'], 0x08000000 if os_name == 'nt' else 0)
                    self.assertNotIn('API_KEY', run.call_args.kwargs['env'])

    def test_enabled_probe_then_command_on_windows_and_macos(self):
        # creationflags for both local hosts are covered by the next test.
        # Patching os.name around Path() would build a WindowsPath on Linux.
        for platform_name, _os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                self._enable(state)
                row = self._row(state)
                calls = []

                def run(*args, **kwargs):
                    calls.append((args[0], kwargs))
                    if len(calls) == 1:
                        return _completed(stdout=_hello(), stderr='noise')
                    return _completed(stdout='ran', stderr='err')

                with mock.patch.dict(remote.os.environ, {'API_KEY': 'sekret', 'SAFE_VAR': 'ok'}, clear=False), \
                        mock.patch.object(remote.subprocess, 'run', side_effect=run):
                    result = self._exec(state, row, ['echo', 'secret-argv', 'a&b'])
                self.assertEqual(len(calls), 2)
                probe, command = calls[0][0][-1], calls[1][0][-1]
                self.assertEqual(probe, handshake.PROBE_COMMAND)
                self.assertNotIn('secret-argv', probe)
                self.assertNotIn('/srv/my project', probe)
                self.assertNotIn('a&b', probe)
                self.assertIn("cd -- '/srv/my project'", command)
                self.assertIn('secret-argv', command)
                self.assertIn("'a&b'", command)
                self.assertEqual(calls[0][1]['timeout'], handshake.PROBE_TIMEOUT_SECONDS)
                self.assertEqual(calls[1][1]['timeout'], remote._COMMAND_TIMEOUT)
                for argv, kwargs in calls:
                    self.assertIn('BatchMode=yes', argv)
                    self.assertIn('StrictHostKeyChecking=yes', argv)
                    self.assertNotIn('API_KEY', kwargs['env'])
                    self.assertEqual(kwargs['env']['SAFE_VAR'], 'ok')
                self.assertTrue(result['ok'])
                self.assertTrue(result['executed'])
                self.assertEqual(result['output'], 'ranerr')
                self.assertEqual(result['handshake']['platform'], 'linux')
                self.assertEqual(result['handshake']['arch'], 'x64')
                self.assertEqual(result['handshake']['capabilities'], ['posix-shell'])
                self.assertNotIn('retryable', result)
                json.dumps(result)

    def test_os_name_patch_does_not_cover_path_construction(self):
        # Patching os.name around Path() builds a WindowsPath on Linux.
        # creationflags are checked through the helper, the same way BE-1 does.
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                self._enable(state)
                row = self._row(state)
                original = remote._ssh_creationflags
                seen = []

                def creationflags(original=original, os_name=os_name):
                    with mock.patch.object(remote.os, 'name', os_name), \
                            mock.patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
                        flag = original()
                    seen.append(flag)
                    return flag

                def run(*args, **kwargs):
                    if len(seen) == 1:
                        return _completed(stdout=_hello(platform='FreeBSD', arch='amd64', kernel=''))
                    return _completed(stdout='ok')

                with mock.patch.object(remote, '_ssh_creationflags', side_effect=creationflags), \
                        mock.patch.object(remote.subprocess, 'run', side_effect=run):
                    result = self._exec(state, row, ['printf', '%s', 'ok'])
                self.assertEqual(seen, [0x08000000 if os_name == 'nt' else 0] * 2)
                self.assertEqual(result['handshake']['platform'], 'freebsd')
                self.assertEqual(result['handshake']['arch'], 'x64')

    def test_probed_windows_and_transport_errors_do_not_send_the_command(self):
        cases = (
            ('windows_nt', _completed(stdout=_hello(platform='Windows_NT', kernel='')), 'capability_unsupported', False),
            ('mingw', _completed(stdout=_hello(platform='MINGW64_NT-10.0', kernel='')), 'capability_unsupported', False),
            ('cygwin', _completed(stdout=_hello(platform='CYGWIN_NT-10.0', kernel='')), 'capability_unsupported', False),
            ('hostkey', _completed(code=255, stderr='Host key verification failed.\n'), 'ssh_host_key', False),
            ('auth', _completed(code=255, stderr='Permission denied (publickey).'), 'ssh_auth', False),
            ('refused', _completed(code=255, stderr='Connection refused'), 'ssh_unavailable', True),
            ('invalid', _completed(stdout='just a banner\n'), 'handshake_invalid', False),
            ('closed', _completed(code=255, stdout='partial', stderr='ssh: exited'), 'handshake_closed', True),
            ('nonzero_hello', _completed(code=1, stdout=_hello(), stderr=''), 'handshake_closed', False),
        )
        for platform_name, os_name in _HOSTS:
            for name, proc, code, retryable in cases:
                with self.subTest(platform=platform_name, case=name), tempfile.TemporaryDirectory() as temporary:
                    state = Path(temporary)
                    self._enable(state)
                    row = self._row(state)
                    with mock.patch.object(remote.subprocess, 'run', return_value=proc) as run:
                        result = self._exec(state, row, ['echo', 'secret-argv'])
                    self.assertEqual(run.call_count, 1)
                    self.assertNotIn('secret-argv', run.call_args.args[0][-1])
                    self.assertFalse(result['ok'])
                    self.assertFalse(result['executed'])
                    self.assertEqual(result['error_code'], code)
                    self.assertIsInstance(result['error'], str)
                    self.assertEqual(result['failure']['retryable'], retryable)
                    self.assertNotIn('retryable', result)
                    self.assertNotIn('secret-argv', json.dumps(result))
                    if code == 'capability_unsupported':
                        self.assertIn('cmd', result['error'])
                        self.assertIn('PowerShell', result['error'])
                        self.assertEqual(result['handshake']['platform'], 'win32')

    def test_exit_zero_hello_ignores_stderr_that_looks_like_ssh(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self._enable(state)
            row = self._row(state)
            answers = [
                _completed(stdout=_hello(), stderr='Host key verification failed.\n'),
                _completed(stdout='ran'),
            ]

            def run(*args, **kwargs):
                return answers.pop(0)

            with mock.patch.object(remote.subprocess, 'run', side_effect=run) as patched:
                result = self._exec(state, row, ['true'])
            self.assertEqual(patched.call_count, 2)
            self.assertTrue(result['ok'])
            self.assertEqual(result['output'], 'ran')

    def test_connection_edited_during_the_probe_is_not_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self._enable(state)
            row = self._row(state)

            def run(*args, **kwargs):
                remote._atomic_write_json(
                    state / 'remote-connections.json', [{**row, 'host': 'other.example'}])
                return _completed(stdout=_hello())

            with mock.patch.object(remote.subprocess, 'run', side_effect=run) as patched:
                with self.assertRaisesRegex(ValueError, 'connection changed'):
                    self._exec(state, row, ['echo', 'secret-argv'])
            self.assertEqual(patched.call_count, 1)
            self.assertNotIn('secret-argv', patched.call_args.args[0][-1])

    def test_darwin_on_a_linux_kernel_still_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self._enable(state)
            row = self._row(state)
            answers = [
                _completed(stdout=_hello(platform='Darwin', arch='arm64', kernel='Linux')),
                _completed(stdout='ran'),
            ]

            def run(*args, **kwargs):
                return answers.pop(0)

            with mock.patch.object(remote.subprocess, 'run', side_effect=run):
                result = self._exec(state, row, ['true'])
            self.assertTrue(result['handshake']['platformCorrected'])
            self.assertEqual(result['handshake']['platform'], 'linux')
            self.assertEqual(result['handshake']['reportedPlatform'], 'darwin')
            self.assertEqual(result['output'], 'ran')

    def test_probe_timeout_and_missing_client_hide_the_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self._enable(state)
            row = self._row(state)
            secret = ['ssh', 'secret-argv-do-not-leak']
            exc = subprocess.TimeoutExpired(secret, handshake.PROBE_TIMEOUT_SECONDS, output='partial', stderr='\x1b[31mbad')
            with mock.patch.object(remote.subprocess, 'run', side_effect=exc) as run:
                result = self._exec(state, row, ['echo', 'secret-argv-do-not-leak'])
            self.assertEqual(run.call_count, 1)
            self.assertEqual(result['error_code'], 'ssh_timeout')
            self.assertTrue(result['failure']['retryable'])
            self.assertFalse(result['executed'])
            blob = json.dumps(result)
            self.assertNotIn('secret-argv-do-not-leak', blob)
            self.assertNotIn('\x1b', blob)
            self.assertIn('bad', result['diagnostics']['stderr'])
            with mock.patch.object(remote.subprocess, 'run', side_effect=FileNotFoundError(2, 'No such file', '/usr/bin/ssh')):
                missing = self._exec(state, row, ['echo', 'secret-argv-do-not-leak'])
            self.assertEqual(missing['error'], 'ssh client unavailable')
            self.assertNotIn('/usr/bin/ssh', json.dumps(missing))
            self.assertNotIn('retryable', missing)

    def test_command_timeout_reports_partial_output_without_the_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            self._enable(state)
            row = self._row(state)
            calls = {'n': 0}

            def run(*args, **kwargs):
                calls['n'] += 1
                if calls['n'] == 1:
                    return _completed(stdout=_hello())
                raise subprocess.TimeoutExpired(
                    ['ssh', 'secret-argv-do-not-leak'], remote._COMMAND_TIMEOUT,
                    output='partial-out', stderr='partial-err')

            with mock.patch.object(remote.subprocess, 'run', side_effect=run):
                result = self._exec(state, row, ['echo', 'secret-argv-do-not-leak'])
            self.assertEqual(calls['n'], 2)
            self.assertTrue(result['executed'])
            self.assertEqual(result['error_code'], 'command_timeout')
            self.assertTrue(result['failure']['retryable'])
            self.assertIn('partial-out', result['output'])
            self.assertNotIn('secret-argv-do-not-leak', json.dumps(result))
            self.assertNotIn('retryable', result)

    def test_declared_windows_and_a_denied_gate_never_ssh(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                self._enable(state)
                windows = self._row(state, system='windows')
                gate = mock.Mock()
                with mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as run:
                    with self.assertRaises(ValueError) as caught:
                        self._exec(state, windows, ['cmd', '/c', 'echo'], gate)
                self.assertIn('PowerShell', str(caught.exception))
                run.assert_not_called()
                gate.check.assert_not_called()
                posix = self._row(state, system='posix')
                denied = mock.Mock()
                denied.check.side_effect = PermissionError('approval required')
                with mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as run:
                    with self.assertRaises(PermissionError):
                        self._exec(state, posix, ['echo', 'x'], denied)
                run.assert_not_called()

    def test_cli_exit_codes_distinguish_probe_failure_timeout_and_command_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            workspace = state / 'workspace'
            workspace.mkdir()
            self._enable(state)
            remote._atomic_write_json(state / 'remote-connections.json', [dict(_ROW)])

            def cli():
                return mock.Mock(state=state, remote_action='exec', id='node', root=workspace,
                                 allow_exec=True, argv=['--', 'echo', 'secret-argv'])

            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(remote.subprocess, 'run', return_value=_completed(
                    code=255, stderr='Permission denied (publickey).')), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(1, remote.execute_cli(cli()))
            self.assertEqual(out.getvalue(), '')
            payload = json.loads(err.getvalue())
            self.assertEqual(payload['error_code'], 'ssh_auth')
            self.assertFalse(payload['executed'])
            self.assertNotIn('secret-argv', err.getvalue())

            out, err = io.StringIO(), io.StringIO()
            answers = [
                _completed(stdout=_hello()),
                _completed(code=3, stdout='nope'),
            ]

            def run(*args, **kwargs):
                return answers.pop(0)

            with mock.patch.object(remote.subprocess, 'run', side_effect=run), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(2, remote.execute_cli(cli()))
            self.assertEqual(err.getvalue(), '')
            body = json.loads(out.getvalue())
            self.assertFalse(body['ok'])
            self.assertEqual(body['output'], 'nope')
            self.assertEqual(body['handshake']['capabilities'], ['posix-shell'])

            out, err = io.StringIO(), io.StringIO()
            calls = {'n': 0}

            def timeout(*args, **kwargs):
                calls['n'] += 1
                if calls['n'] == 1:
                    return _completed(stdout=_hello())
                raise subprocess.TimeoutExpired(['ssh', 'secret-argv'], 40, output='partial')

            with mock.patch.object(remote.subprocess, 'run', side_effect=timeout), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(1, remote.execute_cli(cli()))
            self.assertEqual(out.getvalue(), '')
            payload = json.loads(err.getvalue())
            self.assertEqual(payload['error_code'], 'command_timeout')
            self.assertTrue(payload['executed'])
            self.assertNotIn('output', payload)
            self.assertNotIn('secret-argv', err.getvalue())

    def test_corrupt_settings_leave_the_command_path_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / 'settings.json').write_text('{', encoding='utf-8')
            self.assertFalse(handshake.enabled(state))
            self.assertFalse(handshake.enabled(None))
            row = self._row(state)
            with mock.patch.object(remote.subprocess, 'run', return_value=_completed(stdout='plain')) as run:
                result = self._exec(state, row, ['echo', 'ok'])
            self.assertEqual(run.call_count, 1)
            self.assertNotIn(handshake.BEGIN, run.call_args.args[0][-1])
            self.assertEqual(result, {'ok': True, 'exit_code': 0, 'output': 'plain'})


if __name__ == '__main__':
    unittest.main()
