"""Remote SSH commands stay POSIX-quoted, and declared Windows hosts are refused.

The local host is mocked as both Windows and macOS. Nothing here opens a
network connection or runs ssh.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

# Import before any test patches subprocess.run. process_runtime records the
# real runner at import; a first import that happens under a patch would treat
# that patch as the real runner and spawn a process anyway.
import xueness.process_runtime  # noqa: F401
from xueness.bundled_plugins.remote import plugin as remote
from xueness.tool_contract import bind_execution


_HOSTS = (('win32', 'nt'), ('darwin', 'posix'))
_ROW = {'id': 'node', 'host': 'host.example', 'user': 'operator', 'port': 22, 'directory': '.'}


def _completed():
    return mock.Mock(returncode=0, stdout='', stderr='')


class RemoteHostSystemTests(unittest.TestCase):
    def _exec(self, state, row, argv, gate):
        args = {'connection': row['id'], 'connection_digest': remote._digest(row), 'argv': argv}
        with bind_execution(state_dir=state):
            return remote._exec(Path(state), gate, args, None, 'call-1')

    def test_local_ssh_creationflags_follow_windows_and_macos(self):
        # Patch only the flag helper's os.name. Path() during a full exec would
        # otherwise try to build a WindowsPath on this POSIX host.
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), \
                    mock.patch.object(remote.os, 'name', os_name), \
                    mock.patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
                self.assertEqual(remote._ssh_creationflags(), 0x08000000 if os_name == 'nt' else 0)

    def test_absent_system_stays_posix_and_quotes_on_windows_and_macos(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                row = {**_ROW, 'directory': '/srv/my project'}
                remote._atomic_write_json(state / 'remote-connections.json', [row])
                loaded = remote._load(state)[0]
                self.assertNotIn('system', loaded)
                self.assertEqual(remote._digest(loaded), remote._digest(row))
                gate = mock.Mock()
                flags = {'value': None}
                original_flags = remote._ssh_creationflags

                def creationflags():
                    with mock.patch.object(remote.os, 'name', os_name), \
                            mock.patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
                        flags['value'] = original_flags()
                    return flags['value']

                with mock.patch.object(remote, '_ssh_creationflags', side_effect=creationflags), \
                        mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as run:
                    self._exec(state, loaded, ['echo', 'hello world', 'a&b'], gate)
                gate.check.assert_called_once()
                command = run.call_args.args[0][-1]
                self.assertIn("cd -- '/srv/my project' && exec ", command)
                self.assertIn("'hello world'", command)
                self.assertIn("'a&b'", command)
                self.assertNotIn('StrictHostKeyChecking=no', run.call_args.args[0])
                self.assertEqual(run.call_args.kwargs['creationflags'],
                                 0x08000000 if os_name == 'nt' else 0)
                self.assertEqual(flags['value'], run.call_args.kwargs['creationflags'])

    def test_windows_remote_is_refused_before_ssh_on_windows_and_macos(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                row = {**_ROW, 'system': 'windows'}
                remote._atomic_write_json(state / 'remote-connections.json', [row])
                loaded = remote._load(state)[0]
                gate = mock.Mock()
                with mock.patch.object(remote.shlex, 'join', side_effect=AssertionError('quoted')), \
                        mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as run:
                    with self.assertRaises(ValueError) as caught:
                        self._exec(state, loaded, ['cmd', '/c', 'echo a&whoami'], gate)
                message = str(caught.exception)
                self.assertIn('Windows', message)
                self.assertIn('cmd', message)
                self.assertIn('PowerShell', message)
                run.assert_not_called()
                gate.check.assert_not_called()

    def test_invalid_system_is_rejected_and_explicit_posix_still_runs(self):
        with self.assertRaisesRegex(ValueError, 'invalid remote system'):
            remote._validate({**_ROW, 'system': 'cmd'})
        with self.assertRaisesRegex(ValueError, 'invalid remote fields'):
            remote._validate({**_ROW, 'shell': 'powershell'})
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                row = {**_ROW, 'system': 'posix'}
                remote._atomic_write_json(state / 'remote-connections.json', [row])
                with mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as run:
                    self._exec(state, remote._load(state)[0], ['printf', '%s', 'ok'], mock.Mock())
                self.assertIn('printf', run.call_args.args[0][-1])

    def test_http_save_keeps_windows_when_the_client_omits_system(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            remote._atomic_write_json(state / 'remote-connections.json', [{**_ROW, 'system': 'windows'}])
            ctx = {'state_dir': state}
            status, body = remote.dispatch('POST', ['api', 'remote'], {}, dict(_ROW), ctx)
            self.assertEqual(status, 200, body)
            self.assertEqual(body['connection']['system'], 'windows')
            status, listed = remote.dispatch('GET', ['api', 'remote'], {}, {}, ctx)
            self.assertEqual(status, 200)
            self.assertEqual(listed['connections'][0]['system'], 'windows')
            cleared = {**_ROW, 'system': 'posix'}
            status, body = remote.dispatch('POST', ['api', 'remote'], {}, cleared, ctx)
            self.assertEqual(status, 200, body)
            self.assertEqual(body['connection']['system'], 'posix')
            status, body = remote.dispatch('POST', ['api', 'remote'], {}, {**_ROW, 'system': 'cmd'}, ctx)
            self.assertEqual(status, 400, body)

    def test_cli_save_and_exec_refuse_a_declared_windows_host(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                workspace = state / 'workspace'
                workspace.mkdir()
                save = mock.Mock(state=state, remote_action='save', id='node', host='host.example',
                                 user='operator', port=22, directory='.', system='windows')
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(0, remote.execute_cli(save))
                again = mock.Mock(state=state, remote_action='save', id='node', host='host.example',
                                  user='operator', port=22, directory='/srv/app', system=None)
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(0, remote.execute_cli(again))
                self.assertEqual(remote._load(state)[0]['system'], 'windows')
                self.assertEqual(remote._load(state)[0]['directory'], '/srv/app')
                run = mock.Mock(state=state, remote_action='exec', id='node', root=workspace,
                                allow_exec=True, argv=['--', 'echo', 'a&b'])
                error = io.StringIO()
                with mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as ssh, \
                        redirect_stderr(error):
                    self.assertEqual(1, remote.execute_cli(run))
                ssh.assert_not_called()
                self.assertIn('PowerShell', error.getvalue())
                payload = json.loads(error.getvalue())
                self.assertIn('Windows', payload['error'])

    def test_cli_exec_drops_the_plugin_lock_before_ssh_on_windows_and_macos(self):
        repo = Path(remote.__file__).resolve().parents[3]
        probe = (
            'import os, sys\n'
            'from xueness import file_lock\n'
            'fd = os.open(sys.argv[1], os.O_RDWR)\n'
            'try:\n'
            '    file_lock.flock(fd, file_lock.LOCK_EX | file_lock.LOCK_NB)\n'
            'except BlockingIOError:\n'
            '    sys.exit(2)\n'
            'else:\n'
            '    file_lock.flock(fd, file_lock.LOCK_UN)\n'
            '    sys.exit(0)\n'
            'finally:\n'
            '    os.close(fd)\n'
        )
        real_run = subprocess.run
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                workspace = state / 'workspace'
                workspace.mkdir()
                remote._atomic_write_json(state / 'remote-connections.json', [dict(_ROW)])
                depth = {'n': 0}
                real_lock = remote._config_lock
                original_flags = remote._ssh_creationflags

                @contextmanager
                def tracking(state_dir):
                    depth['n'] += 1
                    try:
                        with real_lock(state_dir):
                            yield
                    finally:
                        depth['n'] -= 1

                def creationflags():
                    with mock.patch.object(remote.os, 'name', os_name), \
                            mock.patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True):
                        return original_flags()

                seen = {}

                def run(*args, **kwargs):
                    seen['depth'] = depth['n']
                    seen['flags'] = kwargs.get('creationflags')
                    lock_path = state / '.plugin-state.lock'
                    env = os.environ.copy()
                    env['PYTHONPATH'] = str(repo) + os.pathsep + env.get('PYTHONPATH', '')
                    # The ssh stand-in is patched onto subprocess.run. The lock
                    # probe has to use the runner saved before that patch.
                    child = real_run(
                        [sys.executable, '-c', probe, str(lock_path)],
                        env=env, capture_output=True, text=True, timeout=15)
                    seen['child'] = child.returncode
                    seen['child_err'] = child.stderr
                    return _completed()

                run_cli = mock.Mock(state=state, remote_action='exec', id='node', root=workspace,
                                    allow_exec=True, argv=['--', 'echo', 'a&b'])
                with mock.patch.object(remote, '_config_lock', tracking), \
                        mock.patch.object(remote, '_ssh_creationflags', side_effect=creationflags), \
                        mock.patch.object(remote.subprocess, 'run', side_effect=run), \
                        redirect_stdout(io.StringIO()):
                    self.assertEqual(0, remote.execute_cli(run_cli))
                self.assertEqual(seen['depth'], 0, seen.get('child_err'))
                self.assertEqual(seen['child'], 0, seen.get('child_err'))
                self.assertEqual(seen['flags'], 0x08000000 if os_name == 'nt' else 0)

    def test_cli_exec_refuses_a_connection_saved_after_the_lock_drops(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            workspace = state / 'workspace'
            workspace.mkdir()
            remote._atomic_write_json(state / 'remote-connections.json', [dict(_ROW)])
            real_load = remote._load
            calls = {'n': 0}

            def load(path):
                calls['n'] += 1
                rows = real_load(path)
                if calls['n'] == 1:
                    remote._atomic_write_json(
                        Path(path) / 'remote-connections.json',
                        [{**rows[0], 'directory': '/elsewhere'}])
                return rows

            run = mock.Mock(state=state, remote_action='exec', id='node', root=workspace,
                            allow_exec=True, argv=['--', 'echo', 'hi'])
            error = io.StringIO()
            with mock.patch.object(remote, '_load', side_effect=load), \
                    mock.patch.object(remote.subprocess, 'run', return_value=_completed()) as ssh, \
                    redirect_stderr(error):
                self.assertEqual(1, remote.execute_cli(run))
            ssh.assert_not_called()
            self.assertIn('connection changed', error.getvalue())
            self.assertGreaterEqual(calls['n'], 2)


if __name__ == '__main__':
    unittest.main()
