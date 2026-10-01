import base64
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
        self.assertEqual(resolve_shell(), '/bin/sh')
        for value in ('/bin/sh -c echo bad', '/tmp/custom-shell', '', None, 0, {}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate('general', {'defaultShell':value})

    def test_open_consumes_selected_shell_and_preserves_existing_terminal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            ctx = build_context(root/'state', root/'runs', root)
            self.addCleanup(ctx['terminals'].close)
            session = ctx['store'].new('terminal fixture', root)
            selected = '/bin/bash' if any(item['id'] == '/bin/bash' for item in available_shells()) else '/bin/sh'
            update_settings(ctx['state_dir'], lambda data: data.setdefault('general', {}).update(defaultShell=selected))
            status, result = dispatch('POST', ['api','terminals'], {}, {'session_id':session['id'], 'open':True}, ctx)
            self.assertEqual(status, 200)
            term = ctx['terminals'].items[result['id']]
            self.assertEqual(term.shell, selected)
            term.write("printf 'PROFILE_%s=%s\\n' READY \"$0\"\n")
            deadline = time.monotonic()+5
            while time.monotonic() < deadline:
                output = base64.b64decode(term.read(0)['data']).decode(errors='replace')
                if f'PROFILE_READY={selected}' in output:
                    break
                time.sleep(.03)
            else:
                self.fail('the selected shell did not execute the PTY command')
            update_settings(ctx['state_dir'], lambda data: data['general'].update(defaultShell='/bin/sh'))
            self.assertEqual(term.shell, selected)


if __name__ == '__main__':
    unittest.main()
