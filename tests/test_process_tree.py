"""Process-tree termination for Windows and macOS, through one helper.

Windows is taskkill /T /F. POSIX, including macOS, is killpg on a session this
process created. Both are mocked here; the live tests run on the current host
and only fork when that host is POSIX.
"""
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from xueness import process_runtime
from xueness.bundled_plugins.shell import tooling
from xueness.bundled_plugins.workflows import desktop_lifecycle
from xueness.core import Gate
from xueness.tool_contract import bind_execution


def _proc_state(pid):
    """None if pid is gone, 'Z' if it is only a zombie, else a state letter."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except OSError:
        return 'R'
    stat = Path('/proc') / str(pid) / 'stat'
    if stat.exists():
        try:
            raw = stat.read_text(encoding='ascii', errors='replace')
        except OSError:
            return None
        return raw[raw.rfind(')') + 2:].split()[0]
    listing = subprocess.run(
        ['ps', '-o', 'state=', '-p', str(pid)],
        capture_output=True, text=True, timeout=5, check=False)
    text = (listing.stdout or '').strip()
    if not text:
        return None
    return 'Z' if text[:1] == 'Z' else text[:1]


def _not_running(pid, seconds=2.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if _proc_state(pid) in (None, 'Z'):
            return True
        time.sleep(0.05)
    return _proc_state(pid) in (None, 'Z')


def _kill_leader(pid):
    try:
        if os.getpgid(pid) == pid:
            os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        return
    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):
        pass


class ProcessTreeSignalTests(unittest.TestCase):
    def setUp(self):
        # Simulated POSIX branches need their APIs even on a Windows runner.
        # All group signals in this class are mocked, never sent to real PIDs.
        for target, name, value in ((signal, 'SIGKILL', 9), (os, 'killpg', None)):
            if not hasattr(target, name):
                patcher = mock.patch.object(target, name, value, create=True)
                patcher.start()
                self.addCleanup(patcher.stop)

    def test_windows_fallback_does_not_require_posix_signals(self):
        from types import SimpleNamespace
        proc = mock.Mock(pid=4242, returncode=None)
        proc.wait.side_effect = [subprocess.TimeoutExpired(['child'], 0), 0]
        with mock.patch.object(process_runtime.os, 'name', 'nt'), \
             mock.patch.object(process_runtime, 'signal', SimpleNamespace(SIGTERM=15)), \
             mock.patch.object(process_runtime, '_windows_tree'):
            self.assertTrue(process_runtime.terminate_process_tree(proc, grace=0))
        proc.kill.assert_called_once_with()

    def test_reaped_process_is_not_signaled_on_either_platform(self):
        for os_name in ('posix', 'nt'):
            with self.subTest(os_name=os_name):
                proc = mock.Mock()
                proc.pid = 4242
                proc.returncode = 0
                with mock.patch.object(process_runtime.os, 'name', os_name), \
                     mock.patch.object(process_runtime.os, 'killpg') as killpg, \
                     mock.patch.object(process_runtime, 'run_external') as run:
                    self.assertTrue(process_runtime.terminate_process_tree(proc, group=True))
                killpg.assert_not_called()
                run.assert_not_called()
                proc.terminate.assert_not_called()
                proc.kill.assert_not_called()

    def test_posix_leader_uses_killpg_and_windows_uses_taskkill(self):
        for os_name in ('posix', 'nt'):
            with self.subTest(os_name=os_name):
                proc = mock.Mock()
                proc.pid = 4242
                proc.returncode = None
                proc.wait.side_effect = subprocess.TimeoutExpired(['x'], 0)
                with mock.patch.object(process_runtime.os, 'name', os_name), \
                     mock.patch.object(process_runtime.os, 'killpg') as killpg, \
                     mock.patch.object(process_runtime, 'run_external') as run:
                    process_runtime.terminate_process_tree(proc, group=True, grace=0)
                if os_name == 'posix':
                    self.assertEqual(
                        [call.args for call in killpg.call_args_list],
                        [(4242, signal.SIGTERM), (4242, signal.SIGKILL)])
                    run.assert_not_called()
                else:
                    killpg.assert_not_called()
                    self.assertEqual(
                        run.call_args.args[1],
                        ['taskkill.exe', '/PID', '4242', '/T', '/F'])
                    self.assertIs(run.call_args.kwargs['check'], False)
                    self.assertEqual(run.call_args.kwargs['timeout'], 5)
                    self.assertNotIn('shell', run.call_args.kwargs)

    def test_non_leader_does_not_kill_its_process_group(self):
        proc = mock.Mock()
        proc.pid = 4242
        proc.returncode = None
        proc.wait.return_value = 0
        with mock.patch.object(process_runtime.os, 'name', 'posix'), \
             mock.patch.object(process_runtime.os, 'killpg') as killpg:
            process_runtime.terminate_process_tree(proc, group=False, grace=0)
        killpg.assert_not_called()
        proc.terminate.assert_called_once_with()

    def test_non_integer_pid_never_becomes_a_taskkill_argument(self):
        proc = mock.Mock()
        proc.pid = '4242; calc.exe'
        proc.returncode = None
        proc.wait.return_value = 0
        with mock.patch.object(process_runtime.os, 'name', 'nt'), \
             mock.patch.object(process_runtime, 'run_external') as run:
            process_runtime.terminate_process_tree(proc, grace=0)
        run.assert_not_called()
        proc.terminate.assert_called_once_with()
        for value in ('4242; calc.exe', '4242 & calc', True, 0, -1, 2**32, os.getpid()):
            with self.subTest(pid=value), \
                 mock.patch.object(process_runtime, 'run_external') as run, \
                 self.assertRaises(ValueError):
                process_runtime.signal_process_tree(value)
            run.assert_not_called()

    def test_terminate_pid_matches_the_platform_and_refuses_bad_ids(self):
        for bad in ('77', '77; calc', True, 0, 1, -5, 2**32, os.getpid()):
            with self.subTest(pid=bad):
                self.assertFalse(process_runtime.terminate_pid(bad, group=True))
        with mock.patch.object(process_runtime.os, 'name', 'nt'), \
             mock.patch.object(process_runtime, 'run_external') as run, \
             mock.patch.object(process_runtime, '_pid_alive', return_value=False):
            self.assertTrue(process_runtime.terminate_pid(424242, grace=5))
        self.assertEqual(run.call_args.args[1][:4], ['taskkill.exe', '/PID', '424242', '/T'])
        with mock.patch.object(process_runtime.os, 'name', 'posix'), \
             mock.patch.object(process_runtime.os, 'killpg') as killpg, \
             mock.patch.object(process_runtime.os, 'kill') as kill, \
             mock.patch.object(process_runtime, '_pid_alive', return_value=False):
            self.assertTrue(process_runtime.terminate_pid(424242, group=True, grace=5))
            self.assertTrue(process_runtime.terminate_pid(424243, group=False, grace=5))
        killpg.assert_called_once_with(424242, signal.SIGTERM)
        kill.assert_called_once_with(424243, signal.SIGTERM)

    def _owned_timeout(self, os_name):
        proc = mock.Mock()
        proc.pid = 5150
        proc.args = ['sleep']
        proc.returncode = None
        proc.stdin = None
        proc.__enter__ = mock.Mock(return_value=proc)
        proc.__exit__ = mock.Mock(return_value=False)

        def communicate(*args, **kwargs):
            raise subprocess.TimeoutExpired(proc.args, 0.1)

        proc.communicate.side_effect = communicate
        proc.wait.side_effect = subprocess.TimeoutExpired(proc.args, 0)
        seen = []
        original = process_runtime.run_external

        def route(factory, *args, **kwargs):
            if args and isinstance(args[0], list) and args[0][:1] == ['taskkill.exe']:
                seen.append(list(args[0]))
                return subprocess.CompletedProcess(args[0], 0, '', '')
            return original(factory, *args, **kwargs)

        with mock.patch.object(process_runtime.os, 'name', os_name), \
             mock.patch.object(process_runtime, 'spawn_external', return_value=proc), \
             mock.patch.object(process_runtime.os, 'killpg') as killpg, \
             mock.patch.object(process_runtime, 'run_external', side_effect=route):
            with self.assertRaises(subprocess.TimeoutExpired):
                process_runtime.run_external(
                    subprocess.run, ['sleep'], capture_output=True, text=True, timeout=0.2)
        return seen, killpg, proc

    def test_mocked_timeout_uses_taskkill_on_windows_and_killpg_on_posix(self):
        seen, killpg, proc = self._owned_timeout('nt')
        self.assertEqual(seen, [['taskkill.exe', '/PID', '5150', '/T', '/F']])
        killpg.assert_not_called()
        proc.terminate.assert_not_called()
        seen, killpg, proc = self._owned_timeout('posix')
        self.assertEqual(seen, [])
        self.assertEqual(
            [call.args for call in killpg.call_args_list],
            [(5150, signal.SIGTERM), (5150, signal.SIGKILL)])


class OwnedProcessCleanupTests(unittest.TestCase):
    def test_release_stops_a_tracked_session_leader(self):
        proc = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(60)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        process_runtime.note_owned_process(proc, group=os.name != 'nt')
        try:
            process_runtime.release_owned_processes()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.fail('tracked sleeper was still running after release')
        finally:
            if proc.poll() is None:
                _kill_leader(proc.pid)
                proc.wait(timeout=2)

    @unittest.skipIf(os.name == 'nt', 'POSIX session leaders are exercised with fork')
    def test_run_timeout_kills_the_session_grandchild(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'pids'
            script = (
                'import os, sys, time\n'
                'child = os.fork()\n'
                'if child == 0:\n'
                '    time.sleep(120)\n'
                '    os._exit(0)\n'
                'open(sys.argv[1], "w", encoding="ascii").write("%s\\n%s\\n" % (os.getpid(), child))\n'
                'time.sleep(120)\n'
            )
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process_runtime.run_external(
                        subprocess.run, [sys.executable, '-c', script, str(path)],
                        capture_output=True, text=True, timeout=5)
                self.assertTrue(path.exists(), 'child did not record pids before the timeout')
                leader, grandchild = [int(line) for line in path.read_text(encoding='ascii').split()]
                self.assertTrue(_not_running(leader), 'session leader still running')
                self.assertTrue(_not_running(grandchild), 'grandchild still running')
            finally:
                if path.exists():
                    for line in path.read_text(encoding='ascii').split():
                        _kill_leader(int(line))

    @unittest.skipIf(os.name == 'nt', 'POSIX session leaders are exercised with fork')
    def test_shell_cancel_kills_the_grandchild_and_reports_command_cancelled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'pids'
            script = (
                'import os, sys, time\n'
                'child = os.fork()\n'
                'if child == 0:\n'
                '    time.sleep(120)\n'
                '    os._exit(0)\n'
                'open(sys.argv[1], "w", encoding="ascii").write("%s\\n%s\\n" % (os.getpid(), child))\n'
                'time.sleep(120)\n'
            )
            try:
                with bind_execution(should_stop=lambda: path.exists()):
                    result = tooling._exec(
                        root, Gate(root, allow_exec=True),
                        {'argv': [sys.executable, '-c', script, str(path)]}, None, 'cancel-1')
                self.assertFalse(result['ok'])
                self.assertEqual(result['error_code'], 'command_cancelled')
                self.assertFalse(result['retryable'])
                self.assertEqual(result['argv'][0], sys.executable)
                leader, grandchild = [int(line) for line in path.read_text(encoding='ascii').split()]
                self.assertTrue(_not_running(leader))
                self.assertTrue(_not_running(grandchild))
            finally:
                if path.exists():
                    for line in path.read_text(encoding='ascii').split():
                        _kill_leader(int(line))


class GatewayExitTests(unittest.TestCase):
    def test_desktop_shutdown_stops_recorded_commands_then_the_worker(self):
        for os_name, group in (('posix', True), ('nt', False)):
            with self.subTest(os_name=os_name):
                worker = mock.Mock()
                worker.poll.return_value = None
                store = mock.Mock()
                store.load.return_value = {'nodes': {
                    'live': {'status': 'running', 'pid': 77},
                    'done': {'status': 'completed', 'pid': 88},
                    'bad': {'status': 'running', 'pid': '77; calc'},
                }}
                with mock.patch.object(desktop_lifecycle.os, 'name', os_name), \
                     mock.patch('xueness.process_runtime.terminate_pid') as terminate_pid, \
                     mock.patch('xueness.process_runtime.terminate_process_tree') as terminate_tree:
                    with desktop_lifecycle._lock:
                        desktop_lifecycle._workers[worker] = (store, 'wid')
                    try:
                        desktop_lifecycle.shutdown()
                    finally:
                        with desktop_lifecycle._lock:
                            desktop_lifecycle._workers.pop(worker, None)
                terminate_pid.assert_called_once_with(77, group=group, grace=0.5)
                terminate_tree.assert_called_once_with(worker, group=False, grace=1.0)
                store.control.assert_called_once_with('wid', 'cancel')

    def test_keyboard_interrupt_closes_the_web_server_and_releases_children(self):
        from xueness import web
        server = mock.Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with mock.patch.object(web, 'build_context', return_value={}), \
             mock.patch.object(web, 'create_server', return_value=server), \
             mock.patch('xueness.process_runtime.release_owned_processes') as release:
            self.assertEqual(web.main(['--host', '127.0.0.1', '--port', '9']), 0)
        server.serve_forever.assert_called_once_with()
        server.server_close.assert_called_once_with()
        release.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
