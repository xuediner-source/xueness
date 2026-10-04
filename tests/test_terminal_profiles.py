import base64
import os
import re
import tempfile
import time
import unittest
from pathlib import Path

from xueness.web import build_context
from xueness.bundled_plugins.settings.preferences import validate
from xueness.bundled_plugins.settings.settings_store import update_settings
from xueness.bundled_plugins.terminal.shells import available_shells, resolve_shell, SHELL_PATHS
from xueness.bundled_plugins.terminal.terminals import dispatch


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
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        ctx = build_context(root/'state', root/'runs', root)
        # unittest cleanups run last-in-first-out: close the shell before its
        # current working directory is removed on Windows.
        self.addCleanup(ctx['terminals'].close)
        session = ctx['store'].new('terminal fixture', root)
        selected = ('/bin/bash' if os.name != 'nt' and
                    any(item['id'] == '/bin/bash' for item in available_shells())
                    else resolve_shell())
        update_settings(ctx['state_dir'], lambda data: data.setdefault('general', {}).update(defaultShell=selected))
        status, result = dispatch('POST', ['api','terminals'], {}, {'session_id':session['id'], 'open':True}, ctx)
        self.assertEqual(status, 200)
        term = ctx['terminals'].items[result['id']]
        self.assertEqual(term.shell, selected)
        term.resize(90, 30)

        def wait_for(text):
            output = ''
            end = time.monotonic()+5
            while time.monotonic() < end:
                output = base64.b64decode(term.read(0)['data']).decode(errors='replace')
                if text in output:
                    return output
                time.sleep(.03)
            self.fail('the selected shell did not return expected output: '+output)

        def wait_for_prompt_after(text):
            end = time.monotonic()+5
            output = ''
            while time.monotonic() < end:
                output = base64.b64decode(term.read(0)['data']).decode(errors='replace')
                plain = re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\\\))', '', output)
                marker = plain.rfind(text)
                if marker >= 0 and re.search(r'(?:PS )?[A-Za-z]:\\[^>\r\n]*>', plain[marker+len(text):]):
                    return output
                time.sleep(.03)
            self.fail('the selected shell did not return to its prompt after interrupt: '+output)

        if os.name == 'nt':
            shell_name = Path(selected).name.casefold()
            if shell_name == 'cmd.exe':
                term.write('set ready=READY & call echo PROFILE_%%ready%%\r\n')
                wait_for('PROFILE_READY')
                term.write('echo PROFILE_SIZE_BEGIN & mode con & echo PROFILE_SIZE_END\r\n')
                output = wait_for('PROFILE_SIZE_END')
                size_report = output.split('PROFILE_SIZE_BEGIN', 1)[-1].split('PROFILE_SIZE_END', 1)[0]
                dimensions = re.findall(r'\b\d+\b', size_report)
                self.assertIn('30', dimensions)
                self.assertIn('90', dimensions)
                running = 'set status=RUNNING & call echo PROFILE_%%status%% & ping -n 31 127.0.0.1 >NUL\r\n'
                after_interrupt = 'set suffix=INTERRUPT & call echo AFTER_%%suffix%%\r\n'
            else:
                term.write("$r='PROFILE'; Write-Output ($r+'_READY')\r\n")
                wait_for('PROFILE_READY')
                term.write('Write-Output "SIZE=$($Host.UI.RawUI.WindowSize.Height)x$($Host.UI.RawUI.WindowSize.Width)"\r\n')
                wait_for('SIZE=30x90')
                running = "$r='PROFILE'; Write-Output ($r+'_RUNNING'); Start-Sleep -Seconds 30\r\n"
                after_interrupt = "$r='AFTER'; Write-Output ($r+'_INTERRUPT')\r\n"
        else:
            term.write("printf 'PROFILE_READY=%s\\n' \"$0\"; stty size\n")
            output = wait_for(f'PROFILE_READY={selected}')
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
        else:
            self.assertIsNotNone(term.proc.poll())
        self.assertTrue(term.closed)
        self.assertFalse(term.reader.is_alive())


if __name__ == '__main__':
    unittest.main()
