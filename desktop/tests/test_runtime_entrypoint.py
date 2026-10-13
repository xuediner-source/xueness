"""Frozen worker routing uses the same plugin CLI without scanning values."""
import unittest
from unittest.mock import patch
from desktop import entrypoint


class RuntimeEntrypointTests(unittest.TestCase):
    def test_alternate_build_python_reexecutes_native_guards_and_metadata_collection(self):
        from desktop.scripts import build_backend
        from pathlib import Path
        alternate = str(Path('other-python.exe').resolve())
        with patch.object(build_backend.sys, 'argv', ['build_backend.py', '--python', alternate]), \
                patch.object(build_backend.subprocess, 'run') as launch, \
                patch.object(build_backend, '_validate_native_target') as validate:
            build_backend.main()
        launch.assert_called_once_with([alternate, str(Path(build_backend.__file__).resolve())],
                                       cwd=build_backend.ROOT, check=True)
        validate.assert_not_called()

    def test_trusted_worker_and_package_cli_dispatched_with_bound_state(self):
        for command in ('pi-lite-worker', 'mcp-acp-worker', 'extension-package'):
            argv = ['backend', '--state', 'isolated-state', command]
            with patch.object(entrypoint.sys, 'argv', argv), patch('xueness.cli.main', return_value=17) as cli:
                self.assertEqual(entrypoint.main(), 17)
                cli.assert_called_once_with(argv[1:])

    def test_option_values_and_unknown_commands_do_not_select_a_worker(self):
        for argv in (['--state', 'pi-lite-worker', '--data', 'data'], ['--data', 'mcp-acp-worker'],
                     ['--state'], ['--state', 'state', 'other-worker']):
            self.assertFalse(entrypoint._plugin_cli_request(argv))
        self.assertTrue(entrypoint._plugin_cli_request(['--state=state', '--language=en', 'pi-lite-worker']))

    def test_explicit_cli_dispatch_uses_static_cli_registry(self):
        with patch.object(entrypoint.sys, 'argv', ['backend', '--cli', '--state', 'state', 'plugins', 'list']), \
                patch('xueness.cli.main', return_value=0) as cli:
            self.assertEqual(entrypoint.main(), 0)
            cli.assert_called_once_with(['--state', 'state', 'plugins', 'list'])


if __name__ == '__main__':
    unittest.main()
