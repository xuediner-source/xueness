"""Host differences for text pipes, pinned to mocked Windows and macOS."""
import subprocess
import sys
import unittest
from unittest import mock

from xueness import process_runtime
from xueness.bundled_plugins.git.actions import _git, _nul_paths
from xueness.bundled_plugins.git.git_api import GitApiError
from xueness.bundled_plugins.shell import tooling


_GBK_OUTPUT = '本机输出'.encode('gbk')
_HOSTS = (('win32', 'nt'), ('darwin', 'posix'))


class SubprocessTextTests(unittest.TestCase):
    def _hosts(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name):
                with mock.patch.object(process_runtime.sys, 'platform', platform_name), \
                     mock.patch.object(process_runtime.os, 'name', os_name):
                    yield platform_name, os_name

    def test_text_pipes_are_utf8_on_windows_and_macos_unless_the_caller_overrides(self):
        for _platform, _os_name in self._hosts():
            seen = []

            def factory(*args, **kwargs):
                seen.append(kwargs)
                return subprocess.CompletedProcess(args, 0, '', '')

            process_runtime.run_external(factory, ['echo'], text=True)
            process_runtime.run_external(factory, ['echo'], text=True, errors='strict')
            process_runtime.run_external(factory, ['echo'], text=True, encoding='gbk')
            process_runtime.run_external(factory, ['echo'])
            process_runtime.spawn_external(factory, ['echo'], universal_newlines=True)
            self.assertEqual(seen[0]['encoding'], 'utf-8')
            self.assertEqual(seen[0]['errors'], 'replace')
            self.assertEqual(seen[1]['encoding'], 'utf-8')
            self.assertEqual(seen[1]['errors'], 'strict')
            self.assertEqual(seen[2]['encoding'], 'gbk')
            self.assertNotIn('errors', seen[2])
            self.assertNotIn('encoding', seen[3])
            self.assertEqual(seen[4]['encoding'], 'utf-8')
            self.assertEqual(seen[4]['errors'], 'replace')

    def test_invalid_utf8_text_is_replaced_and_strict_still_raises(self):
        command = [sys.executable, '-c', 'import sys; sys.stdout.buffer.write(b"\\xff")']
        replaced = process_runtime.run_external(
            subprocess.run, command, capture_output=True, text=True, timeout=10)
        self.assertIn('\ufffd', replaced.stdout)
        with self.assertRaises(UnicodeDecodeError):
            process_runtime.run_external(
                subprocess.run, command, capture_output=True, text=True, errors='strict', timeout=10)

    def test_oem_bytes_decode_on_windows_and_stay_untranslated_on_macos(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), \
                 mock.patch.object(process_runtime.sys, 'platform', platform_name), \
                 mock.patch.object(process_runtime.os, 'name', os_name), \
                 mock.patch.object(process_runtime, 'windows_oem_encoding', return_value='gbk'):
                decoded = process_runtime.decode_subprocess_output(_GBK_OUTPUT)
                self.assertEqual(decoded, tooling._decode_output(_GBK_OUTPUT))
                self.assertEqual(process_runtime.decode_subprocess_output('本机输出'.encode()), '本机输出')
                if os_name == 'nt':
                    self.assertEqual(decoded, '本机输出')
                else:
                    self.assertNotIn('本机输出', decoded)
                    self.assertIn('\ufffd', decoded)
        with mock.patch.object(process_runtime.os, 'name', 'posix'), self.assertRaises(OSError):
            process_runtime.windows_oem_encoding()


class GitMutationEncodingTests(unittest.TestCase):
    def test_invalid_utf8_paths_fail_closed_on_windows_and_macos(self):
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name):
                seen = {}

                def fake_run(argv, **kwargs):
                    seen['errors'] = kwargs['errors']
                    seen['encoding'] = kwargs['encoding']
                    b'\xff'.decode(kwargs['encoding'], kwargs['errors'])
                    return subprocess.CompletedProcess(argv, 0, 'notes.txt\0', '')

                with mock.patch.object(process_runtime.sys, 'platform', platform_name), \
                     mock.patch.object(process_runtime.os, 'name', os_name), \
                     mock.patch('xueness.bundled_plugins.git.actions.subprocess.run', side_effect=fake_run), \
                     self.assertRaises(GitApiError) as caught:
                    _nul_paths('/workspace', ['ls-files', '-z'])
                self.assertEqual(caught.exception.status, 400)
                self.assertEqual(seen, {'encoding': 'utf-8', 'errors': 'strict'})

    def test_valid_nul_paths_round_trip(self):
        def fake_run(argv, **kwargs):
            self.assertEqual(kwargs['errors'], 'strict')
            if argv[1] == 'rev-parse':
                return subprocess.CompletedProcess(argv, 0, 'abc\n', '')
            return subprocess.CompletedProcess(argv, 0, 'Notes.md\0notes.md\0', '')

        with mock.patch('xueness.bundled_plugins.git.actions.subprocess.run', side_effect=fake_run):
            self.assertEqual(_nul_paths('/workspace', ['ls-files', '-z']), {'Notes.md', 'notes.md'})
            self.assertEqual(_git('/workspace', ['rev-parse', 'HEAD']), 'abc')
