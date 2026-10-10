"""Host differences for text pipes, pinned to mocked Windows and macOS."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from xueness import process_runtime
from xueness.bundled_plugins.git.actions import _git, _nul_paths
from xueness.bundled_plugins.git.git_api import GitApiError
from xueness.bundled_plugins.memory import editor
from xueness.bundled_plugins.sessions.operator_cli import list_sessions
from xueness.bundled_plugins.shell import tooling
from xueness.bundled_plugins.workflows.workflow_cli import execute as execute_workflow
from xueness.core import Store


_GBK_OUTPUT = '本机输出'.encode('gbk')
_HOSTS = (('win32', 'nt'), ('darwin', 'posix'))
_NATIVE_WINDOWS = os.name == 'nt'


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
            # Omitted errors follow the shared replacement policy even when the
            # caller picked a non-UTF-8 encoding. Explicit errors=strict stays.
            self.assertEqual(seen[2]['errors'], 'replace')
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

    def test_text_stdin_and_universal_newlines_survive_owned_execution(self):
        command = [sys.executable, '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()+b"\\r\\nnext\\r")']
        result = process_runtime.run_external(
            subprocess.run, command, capture_output=True, text=True,
            input='价格 €', errors='strict', timeout=10)
        self.assertEqual(result.stdout, '价格 €\nnext\n')
        self.assertEqual(result.stderr, '')

    def test_subprocess_bytes_decode_as_utf8_on_windows_and_macos(self):
        decoded = {}
        for platform_name, os_name in _HOSTS:
            with self.subTest(platform=platform_name), \
                 mock.patch.object(process_runtime.sys, 'platform', platform_name), \
                 mock.patch.object(process_runtime.os, 'name', os_name):
                decoded[os_name] = process_runtime.decode_subprocess_output(_GBK_OUTPUT)
                self.assertEqual(decoded[os_name], tooling._decode_output(_GBK_OUTPUT))
                self.assertEqual(process_runtime.decode_subprocess_output('本机输出'.encode()), '本机输出')
                self.assertEqual(
                    process_runtime.decode_subprocess_output('本机输出'.encode('utf-16')),
                    '本机输出')
                self.assertNotEqual(decoded[os_name], '本机输出')
                self.assertIn('\ufffd', decoded[os_name])
        self.assertEqual(decoded['nt'], decoded['posix'])
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


def _gbk_read_text(original):
    def read_text(self, encoding=None, errors=None, newline=None):
        # Chinese Windows resolves omitted encodings to GBK. macOS is exercised
        # with the same omission so a non-UTF-8 locale cannot drop the file.
        kwargs = {'encoding': 'gbk' if encoding is None else encoding, 'errors': errors}
        if newline is not None:
            kwargs['newline'] = newline
        return original(self, **kwargs)
    return read_text


_real_fdopen = os.fdopen


def _gbk_crlf_fdopen(fd, mode='r', buffering=-1, encoding=None, errors=None,
                     newline=None, closefd=True, opener=None):
    if 'b' not in mode:
        if encoding is None:
            encoding = 'gbk'
        if newline is None:
            newline = '\r\n'
    return _real_fdopen(fd, mode, buffering, encoding, errors, newline, closefd, opener)


class LocaleTextTests(unittest.TestCase):
    def test_memory_track_stays_utf8_lf_when_the_locale_is_gbk(self):
        content = '价格 €\n下一行'
        for platform_name in ('win32', 'darwin'):
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                workspace = base / 'project'
                workspace.mkdir()
                memory = base / 'memory'
                memory.mkdir()
                ctx = {'project_dir': workspace, 'state_dir': base / 'state',
                       'store': Store(base / 'sessions'), 'workspace_roots': (workspace,)}
                parts = ['api', 'memory', 'tracks', 'key']
                with mock.patch.dict(os.environ, {'XUENESS_MEMORY_ROOT': str(memory)}), \
                     mock.patch.object(sys, 'platform', platform_name):
                    status, document = editor.dispatch('GET', parts, {'root': str(workspace)}, {}, ctx)
                    self.assertEqual(status, 200)
                    with mock.patch('xueness.bundled_plugins.memory.editor.os.fdopen', side_effect=_gbk_crlf_fdopen):
                        status, saved = editor.dispatch(
                            'POST', parts, {'root': str(workspace)},
                            {**document, 'content': content, 'confirmed': True}, ctx)
                    self.assertEqual(status, 200, saved)
                    self.assertEqual(saved['content'], content)
                    raw = editor._path(ctx, 'key').read_bytes()
                self.assertEqual(raw.decode('utf-8'), content)
                self.assertNotIn(b'\r', raw)

    def test_session_list_and_workflow_plan_keep_utf8_under_gbk_locale(self):
        payload = '{"task": "价格 €", "root": "/tmp/ws"}'
        self.assertRaises(UnicodeDecodeError, payload.encode('utf-8').decode, 'gbk')
        original = Path.read_text
        for platform_name in ('win32', 'darwin'):
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                workspace = base / 'workspace'
                workspace.mkdir()
                store = Store(base / 'state')
                session = store.new('价格 €', workspace)
                plan = base / 'plan.json'
                plan.write_bytes(json.dumps(
                    {'name': '价格 €', 'nodes': [{'id': 'run', 'argv': ['echo', 'ok']}]},
                    ensure_ascii=False).encode('utf-8'))
                args = SimpleNamespace(state=base / 'flows', cmd='workflow', action='create',
                                       file=plan, root=workspace, reuse=None)
                with mock.patch.object(sys, 'platform', platform_name), \
                     mock.patch.object(Path, 'read_text', _gbk_read_text(original)):
                    listed = list_sessions(store, root=workspace)
                    created = execute_workflow(args)
                self.assertEqual([item['id'] for item in listed], [session['id']])
                self.assertEqual(created['plan']['name'], '价格 €')


class WindowsPathAliasTests(unittest.TestCase):
    def test_windows_aliases_are_outside_the_workspace_and_macos_keeps_the_name(self):
        from xueness.bundled_plugins.files import builtin_tools, windows_paths
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'notes.txt').write_text('kept', encoding='utf-8')
            aliases = ('notes.txt.', 'notes.txt ', 'dir/CON.txt', 'prn', 'COM1.log',
                       'LPT9', r'sub\AUX.txt', 'file.txt:stream', '...')
            with mock.patch.object(windows_paths.os, 'name', 'nt'), \
                    mock.patch.object(builtin_tools.os, 'name', 'nt'):
                for name in aliases:
                    with self.subTest(platform='win32', name=name):
                        self.assertIsNotNone(windows_paths.windows_relative_alias(name))
                        with self.assertRaisesRegex(PermissionError, 'path outside workspace'):
                            builtin_tools.path_in(root, name)
                self.assertIsNone(windows_paths.windows_relative_alias('subdir/notes.txt'))
                self.assertIsNone(windows_paths.windows_relative_alias('COM10.txt'))
                self.assertIsNone(windows_paths.windows_relative_alias('dir/../notes.txt'))
            for platform_name, os_name in (('darwin', 'posix'), ('linux', 'posix')):
                with self.subTest(platform=platform_name), \
                        mock.patch.object(sys, 'platform', platform_name), \
                        mock.patch.object(windows_paths.os, 'name', os_name), \
                        mock.patch.object(builtin_tools.os, 'name', os_name):
                    self.assertIsNone(windows_paths.windows_relative_alias('notes.txt.'))
                    if not _NATIVE_WINDOWS:
                        self.assertEqual(builtin_tools.path_in(root, 'notes.txt.').name, 'notes.txt.')
