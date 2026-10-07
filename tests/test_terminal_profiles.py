import base64
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
import threading
from unittest.mock import Mock, patch

from xueness.web import build_context
from xueness.bundled_plugins.settings.preferences import validate
from xueness.bundled_plugins.settings.settings_store import update_settings
from xueness.bundled_plugins.terminal.shells import available_shells, resolve_shell, SHELL_PATHS
from xueness.bundled_plugins.terminal.terminals import dispatch
from xueness.bundled_plugins.terminal.windows import WindowsTerminal


class WindowsTerminalCloseTests(unittest.TestCase):
    def terminal(self, proc):
        term = WindowsTerminal.__new__(WindowsTerminal)
        term.proc, term.reader = proc, Mock()
        term.lock, term.close_lock = threading.RLock(), threading.Lock()
        term.closed, term.disposed = False, False
        term.write_lock = threading.Lock()
        return term

    def test_successful_and_repeated_close_disposes_once(self):
        proc = Mock()
        proc.isalive.return_value = False
        term = self.terminal(proc)
        with patch('xueness.process_runtime.run_external') as fallback:
            term.close()
            term.close()
        proc.close.assert_called_once_with(force=True)
        fallback.assert_not_called()
        term.reader.join.assert_called_once_with(timeout=3)
        self.assertTrue(term.disposed)

    def test_native_close_failure_terminates_only_owned_process_and_rechecks_exit(self):
        proc = Mock(pid=4312)
        proc.close.side_effect = [OSError('Could not terminate the child'), None]
        proc.isalive.side_effect = [True, False, False]
        term = self.terminal(proc)
        with patch('xueness.process_runtime.run_external') as fallback:
            term.close()
        self.assertEqual(fallback.call_args.args[1],
                         ['taskkill.exe', '/PID', '4312', '/T', '/F'])
        self.assertIs(fallback.call_args.kwargs['check'], False)
        self.assertEqual(fallback.call_args.kwargs['timeout'], 5)
        self.assertEqual(proc.isalive.call_count, 3)
        self.assertTrue(term.disposed)

    def test_still_alive_after_fallback_is_an_error_and_can_retry(self):
        proc = Mock(pid=4312)
        proc.isalive.return_value = True
        term = self.terminal(proc)
        with patch('xueness.process_runtime.run_external'), self.assertRaises(OSError):
            term.close()
        self.assertFalse(term.disposed)
        term.reader.join.assert_called_once_with(timeout=3)

    def test_exited_shell_still_disposes_without_killing_a_process(self):
        proc = Mock()
        proc.close.side_effect = [OSError('already exited'), None]
        proc.isalive.return_value = False
        term = self.terminal(proc)
        term.closed = True
        with patch('xueness.process_runtime.run_external') as fallback:
            term.close()
        fallback.assert_not_called()
        self.assertTrue(term.disposed)

    def test_ctrl_c_signals_only_the_owned_live_console(self):
        proc = Mock(pid=4312)
        term = self.terminal(proc)
        with patch('xueness.bundled_plugins.terminal.windows_interrupt.interrupt') as signal:
            term.write('echo hello\r')
            signal.assert_not_called()
            term.write('\x03')
        proc.write.assert_called_with('\x03')
        signal.assert_called_once_with(4312)

    def test_closed_or_exited_terminal_does_not_launch_an_interrupt_helper(self):
        proc = Mock()
        proc.isalive.return_value = False
        term = self.terminal(proc)
        with patch('xueness.bundled_plugins.terminal.windows_interrupt.interrupt') as signal:
            term.write('\x03')
            term.closed = True
            with self.assertRaises(ValueError):
                term.write('\x03')
        signal.assert_not_called()

    def test_console_helper_is_fixed_isolated_and_reports_failure(self):
        from xueness.bundled_plugins.terminal.windows_interrupt import interrupt
        import sys
        for frozen in (False, True):
            with self.subTest(frozen=frozen), \
                    patch.object(sys, 'frozen', frozen, create=True), \
                    patch('xueness.process_runtime.run_external',
                          side_effect=OSError('attach failed')) as run:
                with self.assertRaises(OSError):
                    interrupt(4312)
            args = run.call_args.args[1]
            self.assertEqual(args[0], sys.executable)
            self.assertEqual(args[-1], '4312')
            if frozen:
                self.assertEqual(args[1:3], ['--worker', 'terminal-interrupt'])
            else:
                self.assertEqual(Path(args[1]).name, 'windows_interrupt.py')
            self.assertEqual(run.call_args.kwargs['timeout'], 5)
            self.assertIs(run.call_args.kwargs['check'], True)
        for invalid in (True, 0, -1, '4312', '4312); bad()', 2**32):
            with self.subTest(pid=invalid), self.assertRaises(ValueError):
                interrupt(invalid)


class TerminalProfileTests(unittest.TestCase):
    def test_catalog_and_validation_accept_only_fixed_shell_profiles(self):
        profiles = available_shells()
        self.assertTrue(profiles)
        self.assertTrue(all(profile['id'] in SHELL_PATHS for profile in profiles))
        expected_default = SHELL_PATHS[0] if os.name == 'nt' else '/bin/sh'
        self.assertEqual(resolve_shell(), expected_default)
        for value in ('/bin/sh -c echo bad', '/tmp/custom-shell', '', None, 0, {}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate('general', {'defaultShell':value})

    def test_open_consumes_selected_shell_and_preserves_existing_terminal(self):
        self.exercise_profile()

    @unittest.skipUnless(os.name == 'nt', 'native Windows shell profiles')
    def test_other_windows_shell_profiles_interrupt_and_close_their_children(self):
        for item in available_shells():
            if item['id'] != resolve_shell():
                with self.subTest(shell=item['id']):
                    self.exercise_profile(item['id'])

    def exercise_profile(self, profile=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        ctx = build_context(root/'state', root/'runs', root)
        # unittest cleanups run last-in-first-out: close the shell before its
        # current working directory is removed on Windows.
        self.addCleanup(ctx['terminals'].close)
        session = ctx['store'].new('terminal fixture', root)
        selected = profile or ('/bin/bash' if os.name != 'nt' and
                    any(item['id'] == '/bin/bash' for item in available_shells())
                    else resolve_shell())
        update_settings(ctx['state_dir'], lambda data: data.setdefault('general', {}).update(defaultShell=selected))
        status, result = dispatch('POST', ['api','terminals'], {}, {'session_id':session['id'], 'open':True}, ctx)
        self.assertEqual(status, 200)
        term = ctx['terminals'].items[result['id']]
        self.assertEqual(term.shell, selected)
        term.resize(90, 30)

        answered_da = False
        answered_cursor = 0

        def read_output():
            nonlocal answered_da, answered_cursor
            value = base64.b64decode(term.read(0)['data']).decode(errors='replace')
            # The real frontend's xterm replies to terminal capability/cursor
            # requests. A headless ConPTY must provide the same handshake.
            if os.name == 'nt':
                if not answered_da and '\x1b[c' in value:
                    term.write('\x1b[?1;2c')
                    answered_da = True
                count = value.count('\x1b[6n')
                if count > answered_cursor:
                    term.write('\x1b[1;1R' * (count - answered_cursor))
                    answered_cursor = count
            return value

        def wait_for(text):
            output = ''
            end = time.monotonic()+5
            while time.monotonic() < end:
                output = read_output()
                if text in output:
                    return output
                time.sleep(.03)
            self.fail('the selected shell did not return expected output: '+output)

        def wait_for_prompt_after(text):
            end = time.monotonic()+5
            output = ''
            while time.monotonic() < end:
                output = read_output()
                plain = re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\\\))', '', output)
                marker = plain.rfind(text)
                if marker >= 0 and re.search(r'(?:PS )?[A-Za-z]:\\[^>\r\n]*>', plain[marker+len(text):]):
                    return output
                time.sleep(.03)
            self.fail('the selected shell did not return to its prompt after interrupt: '+output)

        native_shell = None
        if os.name == 'nt':
            shell_name = Path(selected).name.casefold()
            if shell_name == 'cmd.exe':
                term.write('set ready=READY & call echo PROFILE_%%ready%%\r')
                wait_for('PROFILE_READY')
                term.write('set "size=SIZE" & call echo PROFILE_%%size%%_BEGIN & mode con & call echo PROFILE_%%size%%_END\r')
                output = wait_for('PROFILE_SIZE_END')
                size_report = output.split('PROFILE_SIZE_BEGIN', 1)[-1].split('PROFILE_SIZE_END', 1)[0]
                dimensions = re.findall(r'\b\d+\b', size_report)
                self.assertIn('30', dimensions)
                self.assertIn('90', dimensions)
                running = 'set status=RUNNING & call echo PROFILE_%%status%% & ping -n 31 127.0.0.1 >NUL\r'
                after_interrupt = 'set suffix=INTERRUPT & call echo AFTER_%%suffix%%\r'
            else:
                # xterm sends CR for Enter. CRLF also sends a second raw key to
                # PSReadLine and can leave the following line in continuation mode.
                term.write("$r='PROFILE'; Write-Output ($r+'_READY'); Write-Output ('SHELL_PID='+$PID)\r")
                wait_for('PROFILE_READY')
                end = time.monotonic()+5
                match = None
                while time.monotonic() < end:
                    match = re.search(r'SHELL_PID=(\d+)', read_output())
                    if match:
                        break
                    time.sleep(.03)
                self.assertIsNotNone(match)
                import ctypes
                from ctypes import wintypes
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
                kernel.OpenProcess.restype = wintypes.HANDLE
                kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
                kernel.GetExitCodeProcess.restype = wintypes.BOOL
                kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                kernel.CloseHandle.restype = wintypes.BOOL
                native_shell = kernel.OpenProcess(0x1000, False, int(match.group(1)))
                self.assertTrue(native_shell)
                self.addCleanup(kernel.CloseHandle, native_shell)
                term.write('Write-Output "SIZE=$($Host.UI.RawUI.WindowSize.Height)x$($Host.UI.RawUI.WindowSize.Width)"\r')
                wait_for('SIZE=30x90')
                running = "$r='PROFILE'; Write-Output ($r+'_RUNNING'); Start-Sleep -Seconds 30\r"
                after_interrupt = "$r='AFTER'; Write-Output ($r+'_INTERRUPT')\r"
        else:
            term.write("printf 'PROFILE_READY=%s\\n' \"$0\"; stty size\n")
            wait_for(f'PROFILE_READY={selected}')
            # PTY reads may split the shell's printf from stty's later output.
            # Shell readiness alone does not establish that resize was applied.
            output = wait_for('30 90')
            self.assertIn('30 90', output)
            running = "printf 'PROFILE_%s\\n' RUNNING; sleep 30\n"
            after_interrupt = "printf 'AFTER_%s\\n' INTERRUPT\n"

        term.write(running)
        wait_for('PROFILE_RUNNING')
        term.write('\x03')
        if os.name == 'nt':
            wait_for_prompt_after('PROFILE_RUNNING')
        term.write(after_interrupt)
        wait_for('AFTER_INTERRUPT')

        alternatives = [item['id'] for item in available_shells() if item['id'] != selected]
        update_settings(ctx['state_dir'], lambda data: data['general'].update(
            defaultShell=alternatives[0] if alternatives else selected))
        self.assertEqual(term.shell, selected)
        ctx['terminals'].close()
        if os.name == 'nt':
            self.assertFalse(term.proc.isalive())
            if native_shell:
                exit_code = wintypes.DWORD()
                self.assertTrue(kernel.GetExitCodeProcess(native_shell, ctypes.byref(exit_code)))
                self.assertNotEqual(exit_code.value, 259, 'the actual shell was orphaned after closing its launcher')
        else:
            self.assertIsNotNone(term.proc.poll())
        self.assertTrue(term.closed)
        self.assertFalse(term.reader.is_alive())


if __name__ == '__main__':
    unittest.main()
