"""Desktop plugin policy, parent-pipe cancellation and real portable locks."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from xueness import file_lock, plugin_runtime, web
from xueness.bundled_plugins.desktop.bridge import DesktopBridge
from xueness.bundled_plugins.settings import workspaces_api
from xueness.bundled_plugins.files.instructions import load_workspace_instructions


class DesktopTests(unittest.TestCase):
    def test_windows_runtime_environment_restores_os_paths_without_inheriting_credentials(self):
        from xueness.process_runtime import windows_environment
        original = {'Path': 'explicit-tool-path', 'APPDATA': 'explicit-profile'}
        with patch.dict(os.environ, {'PATH': 'host-path', 'APPDATA': 'host-profile',
                                    'SYSTEMDRIVE': 'C:', 'PSMODULEPATH': 'system-modules',
                                    'API_KEY': 'test-only-placeholder', 'PRIVATE_SETTING': 'private'}, clear=True):
            env = windows_environment(original)
        self.assertEqual(env['Path'], 'explicit-tool-path')
        self.assertNotIn('PATH', env)
        self.assertEqual(env['APPDATA'], 'explicit-profile')
        self.assertEqual(env['SYSTEMDRIVE'], 'C:')
        self.assertEqual(env['PSMODULEPATH'], 'system-modules')
        self.assertNotIn('API_KEY', env)
        self.assertNotIn('PRIVATE_SETTING', env)
        self.assertEqual(original, {'Path': 'explicit-tool-path', 'APPDATA': 'explicit-profile'})

    @unittest.skipUnless(os.name == 'nt', 'native Windows DLL search path')
    def test_external_spawn_restores_global_dll_directory_after_failure(self):
        import ctypes
        from ctypes import wintypes
        from xueness.process_runtime import spawn_external
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetDllDirectoryW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
        kernel.SetDllDirectoryW.argtypes = [wintypes.LPCWSTR]
        def current():
            buffer = ctypes.create_unicode_buffer(32768)
            kernel.GetDllDirectoryW(len(buffer), buffer)
            return buffer.value
        original = current()
        with tempfile.TemporaryDirectory() as temporary:
            try:
                self.assertTrue(kernel.SetDllDirectoryW(temporary))
                def failing():
                    self.assertEqual(current(), '')
                    raise RuntimeError('creation failed')
                with patch.object(sys, 'frozen', True, create=True), self.assertRaisesRegex(RuntimeError, 'creation failed'):
                    spawn_external(failing)
                self.assertEqual(current(), temporary)
            finally:
                kernel.SetDllDirectoryW(original or None)

    def test_native_workflow_worker_entrypoint_completes_and_releases_its_lease(self):
        from xueness.workflows import WorkflowStore
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = WorkflowStore(root/'state')
            record = store.create({'nodes': [{'id': 'native', 'argv': [sys.executable, '-c', 'print("worker ready")']}]}, root)
            store.update(record['id'], lambda row: row.update(status='queued'))
            result = subprocess.run([sys.executable, '-m', 'xueness.workflow_worker', str(store.state), record['id']],
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
            self.assertEqual(store.load(record['id'])['status'], 'completed')
            self.assertIn('worker ready', store.log(record['id'], 'native')['output'])
            with store.lock(record['id'], '.runner', blocking=False):
                pass

    @unittest.skipUnless(os.name == 'nt', 'native Windows PowerShell workflow')
    def test_source_workflow_worker_completes_powershell_unicode_command(self):
        import importlib.util
        from xueness.workflows import WorkflowStore
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('desktop_fixture_cleanup', root/'desktop/scripts/check_backend.py')
        cleanup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cleanup)
        with tempfile.TemporaryDirectory(prefix='xueness-source-worker-windows-') as temporary:
            fixture = Path(temporary)
            workspace = fixture/'工作流工作区'
            workspace.mkdir()
            store = WorkflowStore(fixture/'state')
            argv = ['powershell.exe', '-NoProfile', '-Command',
                    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '工作流_OK'"]
            record = store.create({'nodes': [{'id': 'native', 'argv': argv, 'timeout': 5}]}, workspace)
            store.update(record['id'], lambda row: row.update(status='queued'))
            worker = subprocess.Popen(
                [sys.executable, '-m', 'xueness.workflow_worker', str(store.state), record['id']],
                cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                try:
                    stdout, stderr = worker.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    node_pid = store.load(record['id'])['nodes']['native'].get('pid')
                    detail = cleanup._stop_process_tree(worker, (node_pid,))
                    self.fail('source PowerShell workflow did not terminate: '+detail)
                self.assertEqual(worker.returncode, 0, stderr.decode('utf-8', 'replace'))
                self.assertEqual(store.load(record['id'])['status'], 'completed')
                self.assertIn('工作流_OK', store.log(record['id'], 'native')['output'])
            finally:
                if worker.poll() is None:
                    node_pid = store.load(record['id'])['nodes']['native'].get('pid')
                    cleanup._stop_process_tree(worker, (node_pid,))
                worker.stdout.close(); worker.stderr.close()

    def test_disabling_desktop_while_dialog_is_open_prevents_directory_grant(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project, selected = base/'project', base/'selected'
            project.mkdir(); selected.mkdir()
            ctx = web.build_context(base/'state', base/'runs', project)
            self.addCleanup(ctx['terminals'].close)
            class Local:
                client_address = ('127.0.0.1', 1000)
            ctx['handler'] = Local()
            def choose(initial):
                plugin_runtime.set_enabled(ctx['state_dir'], 'desktop', False)
                return str(selected)
            ctx['desktop_choose_directory'] = choose
            status, _ = workspaces_api.dispatch('POST', ['api', 'workspaces', 'native-picker'], {}, {}, ctx)
            self.assertEqual(status, 403)
            self.assertNotIn(selected, workspaces_api.selected_roots(ctx))

    @unittest.skipUnless(os.name == 'nt', 'native Windows handle boundary')
    def test_windows_guidance_rejects_junction_and_loads_unicode_path(self):
        from xueness.core import Gate
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'项目'
            root.mkdir()
            (root/'AGENTS.md').write_text('工作区指导', encoding='utf-8')
            text, sources = load_workspace_instructions(root, {}, Gate(root, disallow=set()))
            self.assertEqual(sources, ['AGENTS.md'])
            self.assertIn('工作区指导', text)
            outside = Path(temporary)/'outside'
            outside.mkdir()
            (outside/'AGENTS.md').write_text('must not load', encoding='utf-8')
            result = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(root/'linked'), str(outside)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            session = {'messages': [{'role': 'assistant', 'tool_calls': [{'id': 'r', 'function': {'name': 'read', 'arguments': {'path': 'linked/file.txt'}}}]}], 'results': {'r': {'ok': True, 'path': 'linked/file.txt'}}}
            text, sources = load_workspace_instructions(root, session, Gate(root, disallow=set()))
            self.assertEqual(sources, ['AGENTS.md'])
            self.assertNotIn('must not load', text)

    def test_parent_disconnect_unblocks_a_pending_native_dialog(self):
        stream = io.StringIO()
        bridge = DesktopBridge(stream)
        errors = []
        def choose():
            try:
                bridge.choose_directory('/project')
            except RuntimeError as exc:
                errors.append(str(exc))
        worker = threading.Thread(target=choose)
        worker.start()
        deadline = time.monotonic()+2
        while not stream.getvalue() and time.monotonic() < deadline:
            time.sleep(.005)
        message = json.loads(stream.getvalue())
        self.assertEqual(message['type'], 'dialog')
        bridge.receive({'id': 'unrelated', 'path': '/must-not-register'})
        self.assertTrue(worker.is_alive())
        bridge.close()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, ['desktop directory picker failed'])

    def test_disabled_desktop_hides_native_picker_but_keeps_recovery_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ctx = web.build_context(root/'state', root/'runs', root)
            self.addCleanup(ctx['terminals'].close)
            class Local:
                client_address = ('127.0.0.1', 1000)
            ctx['handler'] = Local()
            ctx['desktop_choose_directory'] = lambda initial: self.fail('disabled plugin opened a dialog')
            plugin_runtime.set_enabled(ctx['state_dir'], 'desktop', False)
            status, capability = workspaces_api.dispatch('GET', ['api', 'workspaces', 'native-picker'], {}, {}, ctx)
            self.assertEqual(status, 200)
            self.assertFalse(capability['available'])
            status, _ = plugin_runtime.dispatch_http('GET', ['api', 'desktop', 'status'], {}, {}, ctx)
            self.assertEqual(status, 403)
            status, catalog = plugin_runtime.dispatch_http('GET', ['api', 'plugins'], {}, {}, ctx)
            self.assertEqual(status, 200)
            self.assertIn('desktop', {p['id'] for p in catalog['plugins']})

    def test_file_lock_excludes_a_second_process_and_releases_on_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'state.lock'
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            script = 'from xueness import file_lock as f; import os,sys; d=os.open(sys.argv[1],os.O_RDWR);\ntry: f.flock(d,f.LOCK_EX|f.LOCK_NB)\nexcept BlockingIOError: sys.exit(2)'
            try:
                file_lock.flock(fd, file_lock.LOCK_EX)
                proc = subprocess.run([sys.executable, '-c', script, str(path)], capture_output=True, timeout=5)
                self.assertEqual(proc.returncode, 2, proc.stderr)
            finally:
                os.close(fd)
            proc = subprocess.run([sys.executable, '-c', script, str(path)], capture_output=True, timeout=5)
            self.assertEqual(proc.returncode, 0, proc.stderr)
