import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from xueness.bundled_plugins.browser import runtime


class BrowserRuntimeTests(unittest.TestCase):
    def test_probe_normalizes_untrusted_output_without_leaking_paths(self):
        for value, code, expected in [
            ({'available': True, 'browser': 'Chrome'}, 0, {'available': True, 'browser': 'Chrome', 'reason': None}),
            ({'reason': 'browser_missing'}, 0, {'available': False, 'browser': None, 'reason': 'browser_missing'}),
            ({'reason': 'driver_missing'}, 1, {'available': False, 'browser': None, 'reason': 'driver_missing'}),
            ([], 0, {'available': False, 'browser': None, 'reason': 'runtime_missing'}),
            ({'available': True, 'browser': 'C:/private/profile'}, 0, {'available': False, 'browser': None, 'reason': 'runtime_missing'}),
        ]:
            with self.subTest(value=value), patch('xueness.process_runtime.spawn_external', return_value=subprocess.CompletedProcess([], code, json.dumps(value), '')):
                self.assertEqual(runtime.browser_runtime(), expected)

    def test_worker_uses_desktop_node_and_does_not_inherit_credentials(self):
        with patch.dict(os.environ, {'XUENESS_DESKTOP_NODE': 'fixture.exe', 'MODEL_API_KEY': 'private-fixture', 'ACCESS_TOKEN': 'private-fixture', 'LOCALAPPDATA': 'fixture-data'}, clear=True):
            env = runtime.worker_environment()
            self.assertEqual(env['ELECTRON_RUN_AS_NODE'], '1')
            self.assertEqual(env['LOCALAPPDATA'], 'fixture-data')
            self.assertNotIn('MODEL_API_KEY', env)
            self.assertNotIn('ACCESS_TOKEN', env)
            self.assertEqual(runtime.worker_command('--probe')[0], 'fixture.exe')

    @unittest.skipUnless(shutil.which('node'), 'Node runtime is unavailable')
    def test_driver_probe_does_not_launch_a_browser_or_create_profile(self):
        # Stub driver throws if any actual browser launch is attempted.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver = root/'driver.mjs'
            driver.write_text('export const chromium = { executablePath: () => "missing-fixture-browser", launchPersistentContext: () => { throw new Error("unexpected browser launch"); } };', encoding='utf-8')
            executable = root/'fixture-browser.exe'
            executable.write_bytes(b'fixture, never executed')
            env = runtime.worker_environment()
            env.update({'XUENESS_DESKTOP_PLAYWRIGHT': str(driver), 'XUENESS_BROWSER_EXECUTABLE': str(executable)})
            bridge = Path(runtime.__file__).with_name('bridge.mjs')
            result = subprocess.run([shutil.which('node'), str(bridge), '--probe'], cwd=root, env=env, capture_output=True, encoding='utf-8', timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)['available'])
            self.assertEqual({path.name for path in root.iterdir()}, {'driver.mjs', 'fixture-browser.exe'})


if __name__ == '__main__':
    unittest.main()
