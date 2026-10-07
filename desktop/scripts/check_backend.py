"""Exercise the actual bundled backend, HTTP isolation and shutdown on each OS."""
import argparse
import base64
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DIAGNOSTIC_TAIL_CHARS = 8000
sys.path.insert(0, str(ROOT))
from xueness.plugin_runtime import PLUGIN_IDS

EXPECTED_PLUGIN_IDS = set(PLUGIN_IDS)
EXPECTED_FEATURE_IDS = {
    feature['id']
    for plugin_id in PLUGIN_IDS
    for feature in json.loads(
        (ROOT/'xueness/bundled_plugins'/plugin_id/'manifest.json').read_text(encoding='utf-8')
    )['features']
}


def _assert_plugin_catalog(plugins):
    plugin_ids = [plugin.get('id') for plugin in plugins]
    feature_ids = [feature.get('id') for plugin in plugins for feature in plugin.get('features', [])]
    assert len(plugin_ids) == len(PLUGIN_IDS) and set(plugin_ids) == EXPECTED_PLUGIN_IDS, plugin_ids
    assert len(feature_ids) == len(EXPECTED_FEATURE_IDS) and set(feature_ids) == EXPECTED_FEATURE_IDS, feature_ids


def _text(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    return str(value)


def _print_tail(label, value, limit=DIAGNOSTIC_TAIL_CHARS):
    rendered = _text(value)
    print(f'[{label}] tail ({min(len(rendered), limit)} chars):', flush=True)
    print(rendered[-limit:] if rendered else '<empty>', flush=True)


def _workflow_log_tail(data, wid):
    path = data/'state/workflows'/f'{wid}.native.log'
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - DIAGNOSTIC_TAIL_CHARS * 4))
            raw = stream.read()
    except FileNotFoundError:
        return f'<no workflow log at {path}>'
    except OSError as exc:
        return f'<could not read workflow log at {path}: {type(exc).__name__}: {exc}>'
    return raw.decode('utf-8', 'replace')[-DIAGNOSTIC_TAIL_CHARS:]


def _process_alive(pid):
    if type(pid) is not int or pid <= 0:
        return None
    if os.name == 'nt':
        try:
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.restype = wintypes.BOOL
            handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False if ctypes.get_last_error() == 87 else None
            try:
                code = wintypes.DWORD()
                kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
                kernel.GetExitCodeProcess.restype = wintypes.BOOL
                if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return None
                return code.value == 259  # STILL_ACTIVE
            finally:
                kernel.CloseHandle(handle)
        except Exception:
            return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


def _process_image(pid):
    """Query one fixture PID without enumerating unrelated processes."""
    if os.name != 'nt' or type(pid) is not int or pid <= 0:
        return None
    try:
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        kernel.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return f'<OpenProcess error {ctypes.get_last_error()}>'
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(buffer))
            if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return f'<QueryFullProcessImageNameW error {ctypes.get_last_error()}>'
            return buffer.value
        finally:
            kernel.CloseHandle(handle)
    except Exception as exc:
        return f'<{type(exc).__name__}: {exc}>'


def _filtered_workflow_env():
    """Mirror the exact environment passed by workflows._execute/windows.py."""
    env = {k: v for k, v in os.environ.items()
           if k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT')}
    import sys
    sys.path.insert(0, str(ROOT))
    from xueness.process_runtime import windows_environment
    return windows_environment(env)


def _query_fixture_processes(pid, label):
    """Ask CIM only for the supplied fixture PID and its direct children."""
    if os.name != 'nt' or type(pid) is not int or pid <= 0:
        return
    script = (f"$root={pid}; $rows=@(Get-CimInstance Win32_Process "
              f"-Filter \"ProcessId = $root OR ParentProcessId = $root\" | "
              "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); "
              "if($rows.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $rows -Compress}")
    argv = ['powershell.exe', '-NoProfile', '-Command', script]
    kwargs = dict(cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                  stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    print(f'[process identity] {label}: root_pid={pid} image={_process_image(pid)}', flush=True)
    try:
        probe = subprocess.Popen(argv, **kwargs)
    except Exception as exc:
        print(f'[process identity] {label}: CIM probe spawn failed: {type(exc).__name__}: {exc}', flush=True)
        return
    try:
        stdout, stderr = probe.communicate(timeout=8)
        print(f'[process identity] {label}: CIM exit={probe.returncode}', flush=True)
    except subprocess.TimeoutExpired as exc:
        stdout, stderr = exc.output, exc.stderr
        before = _process_alive(probe.pid)
        cleanup = _stop_process_tree(probe)
        try:
            stdout, stderr = probe.communicate(timeout=5)
        except subprocess.TimeoutExpired as final:
            stdout = final.output if final.output is not None else stdout
            stderr = final.stderr if final.stderr is not None else stderr
        print(f'[process identity] {label}: CIM timed_out=True pid={probe.pid} alive_before_kill={before}; {cleanup}', flush=True)
    _print_tail(f'{label} CIM fixture process records', stdout)
    _print_tail(f'{label} CIM stderr', stderr)


def _taskkill_tree(pid):
    if os.name != 'nt' or type(pid) is not int or pid <= 0:
        return 'tree kill is only available on Windows'
    try:
        result = subprocess.run(
            ['taskkill', '/PID', str(pid), '/T', '/F'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=10,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        output = '\n'.join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        return f'exit={result.returncode}; {output or "no taskkill output"}'
    except subprocess.TimeoutExpired as exc:
        return 'taskkill timed out; ' + _text(exc.stderr)[-1000:]
    except OSError as exc:
        return f'taskkill failed: {type(exc).__name__}: {exc}'


def _stop_process_tree(proc, child_pids=()):
    """Kill and reap a timed-out process tree, then verify known child PIDs."""
    messages = []
    pids = []
    for pid in (proc.pid, *child_pids):
        if type(pid) is int and pid > 0 and pid not in pids:
            pids.append(pid)
    if os.name == 'nt':
        for pid in pids:
            if _process_alive(pid) is not False:
                messages.append(f'taskkill PID {pid}: {_taskkill_tree(pid)}')
    elif proc.poll() is None:
        try:
            proc.terminate()
        except OSError as exc:
            messages.append(f'terminate failed: {type(exc).__name__}: {exc}')
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        messages.append('parent still alive after tree kill; forced parent kill')
        try:
            proc.kill()
        except OSError as exc:
            messages.append(f'parent kill failed: {type(exc).__name__}: {exc}')
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            messages.append('parent did not exit after forced kill')
    if os.name != 'nt':
        for pid in pids[1:]:
            if _process_alive(pid):
                try:
                    os.kill(pid, 9)
                except OSError as exc:
                    messages.append(f'child PID {pid} kill failed: {type(exc).__name__}: {exc}')
    alive = {pid: _process_alive(pid) for pid in pids}
    messages.append(f'known PID liveness after cleanup: {alive}')
    return '; '.join(messages) or f'known PID liveness after cleanup: {alive}'


def _run_command_probe(label, argv, cwd=None, env=None):
    """Run a bounded comparison command from the independent Python parent."""
    cwd = Path(cwd or ROOT)
    env = os.environ.copy() if env is None else env
    print(f'[command probe] {label}: cwd={cwd} env_key_count={len(env)} '
          f'argv={json.dumps(argv, ensure_ascii=False)}', flush=True)
    kwargs = dict(cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                  stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
                  env=env)
    if os.name == 'nt':
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        child = subprocess.Popen(argv, **kwargs)
    except Exception as exc:
        print(f'[command probe] {label}: spawn failed: {type(exc).__name__}: {exc}', flush=True)
        return
    timed_out = False
    try:
        stdout, stderr = child.communicate(timeout=5)
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout, stderr = exc.output, exc.stderr
        before = _process_alive(child.pid)
        print(f'[command probe] {label}: process_image={_process_image(child.pid)}', flush=True)
        _query_fixture_processes(child.pid, f'command probe {label}')
        cleanup = _stop_process_tree(child)
        try:
            stdout, stderr = child.communicate(timeout=8)
        except subprocess.TimeoutExpired as second:
            stdout = second.output if second.output is not None else stdout
            stderr = second.stderr if second.stderr is not None else stderr
            cleanup += '; ' + _stop_process_tree(child)
            try:
                stdout, stderr = child.communicate(timeout=5)
            except subprocess.TimeoutExpired as final:
                stdout = final.output if final.output is not None else stdout
                stderr = final.stderr if final.stderr is not None else stderr
        print(f'[command probe] {label}: timed_out=True pid={child.pid} alive_before_kill={before}; {cleanup}', flush=True)
    except Exception as exc:
        stdout, stderr = '', f'{type(exc).__name__}: {exc}'
        cleanup = _stop_process_tree(child)
        print(f'[command probe] {label}: communicate failed; {cleanup}', flush=True)
    else:
        print(f'[command probe] {label}: timed_out=False pid={child.pid} exit={child.returncode}', flush=True)
    if not timed_out and child.poll() is None:
        cleanup = _stop_process_tree(child)
        print(f'[command probe] {label}: unexpected live parent after communicate; {cleanup}', flush=True)
    _print_tail(f'command probe {label} stdout', stdout)
    _print_tail(f'command probe {label} stderr', stderr)
    print(f'[command probe] {label}: final_pid_alive={_process_alive(child.pid)}', flush=True)


def _run_foreground_worker(executable, state, wid):
    """Run one fixture-owned frozen worker and capture its diagnostic trace."""
    argv = [str(executable), '--worker', 'workflow', str(state), wid]
    env = {**os.environ, 'XUENESS_DESKTOP_SMOKE_TRACE': '1'}
    kwargs = dict(cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                  text=True, encoding='utf-8', errors='replace')
    if os.name == 'nt':
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    print(f'[foreground worker] argv={json.dumps(argv, ensure_ascii=False)}', flush=True)
    child = subprocess.Popen(argv, **kwargs)
    try:
        stdout, stderr = child.communicate(timeout=5)
        print(f'[foreground worker] pid={child.pid} timed_out=False exit={child.returncode}', flush=True)
    except subprocess.TimeoutExpired as exc:
        stdout, stderr = exc.output, exc.stderr
        before = _process_alive(child.pid)
        row = None
        try:
            row = json.loads((Path(state)/'workflows'/f'{wid}.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            pass
        node_pid = row.get('nodes', {}).get('native', {}).get('pid') if isinstance(row, dict) else None
        print(f'[foreground worker] process_image={_process_image(child.pid)} '
              f'node_image={_process_image(node_pid)}', flush=True)
        _query_fixture_processes(child.pid, 'foreground frozen worker')
        if type(node_pid) is int and node_pid > 0:
            _query_fixture_processes(node_pid, 'foreground frozen workflow command')
        cleanup = _stop_process_tree(child, (node_pid,))
        try:
            stdout, stderr = child.communicate(timeout=8)
        except subprocess.TimeoutExpired as second:
            stdout = second.output if second.output is not None else stdout
            stderr = second.stderr if second.stderr is not None else stderr
            cleanup += '; ' + _stop_process_tree(child, (node_pid,))
            try:
                stdout, stderr = child.communicate(timeout=5)
            except subprocess.TimeoutExpired as final:
                stdout = final.output if final.output is not None else stdout
                stderr = final.stderr if final.stderr is not None else stderr
        print(f'[foreground worker] timed_out=True pid={child.pid} alive_before_kill={before} node_pid={node_pid}; {cleanup}', flush=True)
    _print_tail('foreground worker stdout', stdout)
    _print_tail('foreground worker stderr', stderr)
    print(f'[foreground worker] final worker_alive={_process_alive(child.pid)}', flush=True)
    return row if 'row' in locals() else None


def _print_workflow_snapshot(data, label, state):
    wid = state.get('id') if isinstance(state, dict) else None
    node = state.get('nodes', {}).get('native', {}) if isinstance(state, dict) else {}
    pid = node.get('pid') if isinstance(node, dict) else None
    alive = _process_alive(pid)
    print(f'[{label}] workflow_id={wid} status={state.get("status") if isinstance(state, dict) else None} '
          f'node_status={node.get("status") if isinstance(node, dict) else None} '
          f'child_pid={pid} child_alive={alive} child_image={_process_image(pid)}', flush=True)
    if type(pid) is int and pid > 0:
        _query_fixture_processes(pid, label)
    if wid:
        _print_tail(f'{label} isolated workflow log', _workflow_log_tail(data, wid))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--executable', type=Path)
    parser.add_argument('--force-exit', action='store_true', help='verify owned task cleanup after abrupt host loss')
    args = parser.parse_args()
    executable = args.executable or ROOT/'desktop/runtime/backend'/('xueness-backend.exe' if os.name == 'nt' else 'xueness-backend')
    with tempfile.TemporaryDirectory(prefix='xueness-frozen-check-', ignore_cleanup_errors=True) as temporary:
        data = Path(temporary)/'data'
        token = secrets.token_hex(32)
        host_env = {key: value for key, value in os.environ.items()
                    if key != 'XUENESS_DESKTOP_SMOKE_TRACE'}
        host_env.update({'XUENESS_DESKTOP_TOKEN': token, 'XUENESS_ALLOW_REAL': '0', 'PYTHONTZPATH': ''})
        proc = subprocess.Popen([str(executable), '--data', str(data), '--assets', str(ROOT/'webapp/dist')],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', env=host_env)
        output = queue.Queue()
        threading.Thread(target=lambda: [output.put(line) for line in proc.stdout], daemon=True).start()
        errors = []
        threading.Thread(target=lambda: errors.extend(proc.stderr.read().splitlines()), daemon=True).start()
        try:
            ready_deadline = time.monotonic() + 45
            while True:
                ready = json.loads(output.get(timeout=max(0.01, ready_deadline - time.monotonic())))
                if ready.get('type') != 'update-policy':
                    break
                if time.monotonic() >= ready_deadline:
                    raise TimeoutError('backend ready deadline exceeded')
            assert ready['type'] == 'ready', ready
            url = ready['url']

            def request(path, body=None):
                payload = json.dumps(body).encode() if body is not None else None
                headers = {'X-Xueness-Desktop-Token': token, 'Content-Type': 'application/json'}
                if payload is not None:
                    headers['X-CSRF-Token'] = json.loads(request('/api/csrf'))['csrfToken']
                req = urllib.request.Request(url+path, data=payload, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=15) as response:
                        return response.read()
                except urllib.error.HTTPError as exc:
                    # This fixture owns all request state. Keep the real server
                    # error visible instead of reducing it to an HTTP status.
                    _print_tail(f'isolated HTTP {exc.code} {path}', exc.read(), limit=2000)
                    raise

            try:
                urllib.request.urlopen(url+'/api/health', timeout=5)
                raise AssertionError('unauthenticated desktop access accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            assert json.loads(request('/api/health'))['ok']
            assert b'assets/' in request('/')
            plugins = json.loads(request('/api/plugins'))['plugins']
            _assert_plugin_catalog(plugins)
            assert any(p['id'] == 'desktop' for p in plugins)
            status = json.loads(request('/api/desktop/status'))
            assert status['desktop'] and status['frozen']
            workspace = data/'workspace'
            session = json.loads(request('/api/sessions', {'task': 'packaged terminal smoke', 'root': str(workspace)}))
            sid = session.get('id') or session['session']['id']
            for terminal_round in range(3):
                term = json.loads(request('/api/terminals', {'session_id': sid, 'open': True}))
                def terminal_wait(marker):
                    deadline = time.monotonic()+10
                    while time.monotonic() < deadline:
                        tail = json.loads(request(f"/api/terminals/{term['id']}"))
                        if marker in base64.b64decode(tail['data']):
                            return
                        time.sleep(.1)
                    raise AssertionError('packaged terminal did not produce '+marker.decode())

                # Markers must occur in shell output, never merely echoed input.
                command = "Write-Output ('XUENESS_' + 'TERMINAL_OK')\r" if os.name == 'nt' else "printf 'XUENESS_%s\\n' TERMINAL_OK\n"
                request(f"/api/terminals/{term['id']}/input", {'text': command})
                terminal_wait(b'XUENESS_TERMINAL_OK')
                running = ("Write-Output ('XUENESS_' + 'INTERRUPT_READY'); Start-Sleep -Seconds 30\r"
                           if os.name == 'nt' else "printf 'XUENESS_%s\\n' INTERRUPT_READY; sleep 30\n")
                request(f"/api/terminals/{term['id']}/input", {'text': running})
                terminal_wait(b'XUENESS_INTERRUPT_READY')
                request(f"/api/terminals/{term['id']}/input", {'text': '\x03'})
                after = ("Write-Output ('XUENESS_' + 'AFTER_INTERRUPT')\r" if os.name == 'nt'
                         else "printf 'XUENESS_%s\\n' AFTER_INTERRUPT\n")
                request(f"/api/terminals/{term['id']}/input", {'text': after})
                terminal_wait(b'XUENESS_AFTER_INTERRUPT')
                request(f"/api/terminals/{term['id']}/close", {})
                print(f'PASS: frozen terminal interrupt/resume/close round {terminal_round+1}/3', flush=True)
            argv = ['powershell.exe', '-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '工作流_OK'"] if os.name == 'nt' else ['/bin/sh', '-c', "printf '工作流_OK\\n'"]
            automation_response = json.loads(request('/api/automations', {
                'enabled': False,
                'timezone': 'Asia/Shanghai',
                'schedule': '0 9 * * *',
                'workflow': {'root': str(workspace), 'nodes': [{'id': 'timezone', 'argv': argv}]},
            }))
            automation = automation_response['automation']
            assert automation.get('enabled') is False, automation
            assert automation.get('timezone') == 'Asia/Shanghai', automation
            assert isinstance(automation.get('nextRunAt'), (int, float)), automation
            print(f"PASS: packaged timezone data ({automation['timezone']}, nextRunAt={automation['nextRunAt']})", flush=True)
            workflow = json.loads(request('/api/workflows', {'root': str(workspace), 'plan': {'nodes': [{'id': 'native', 'argv': argv}]}}))
            def workflow_failure(state):
                # All records, logs and command roots in this diagnostic belong
                # to this script's temporary fixture.
                _print_workflow_snapshot(data, 'primary workflow at failure', state)
                if state.get('status') in ('queued', 'running', 'stopping', 'pausing'):
                    try:
                        request(f"/api/workflows/{state['id']}/cancel", {})
                        cancel_deadline = time.monotonic() + 5
                        while time.monotonic() < cancel_deadline:
                            stopped_state = json.loads(request(f"/api/workflows/{state['id']}"))
                            if stopped_state.get('status') not in ('queued', 'running', 'stopping', 'pausing'):
                                break
                            time.sleep(.1)
                        _print_workflow_snapshot(data, 'primary workflow after cancel attempt', stopped_state)
                    except Exception as exc:
                        print(f'[primary workflow cleanup] cancel/status failed: {type(exc).__name__}: {exc}', flush=True)

                try:
                    if os.name == 'nt':
                        _run_command_probe('cmd.exe ASCII', ['cmd.exe', '/d', '/c', 'echo XUENESS_ASCII_OK'])
                        _run_command_probe('PowerShell ASCII', [
                            'powershell.exe', '-NoProfile', '-Command', "Write-Output 'XUENESS_ASCII_OK'"])
                        _run_command_probe('PowerShell original Unicode workflow argv', argv)
                        _run_command_probe('PowerShell original Unicode workflow argv (filtered workflow env)',
                                           argv, cwd=workspace, env=_filtered_workflow_env())
                    else:
                        _run_command_probe('POSIX original workflow argv', argv)
                except Exception as exc:
                    print(f'[command probes] diagnostic error: {type(exc).__name__}: {exc}', flush=True)
                try:
                    diagnostic_root = data/'runs/diagnostic'
                    diagnostic_root.mkdir(parents=True, exist_ok=True)
                    diagnostic = json.loads(request('/api/workflows', {
                        'root': str(diagnostic_root), 'plan': {'nodes': [{'id': 'native', 'argv': argv}]}}))
                    diagnostic['status'] = 'queued'
                    path = data/'state/workflows'/f"{diagnostic['id']}.json"
                    path.write_text(json.dumps(diagnostic, ensure_ascii=False), encoding='utf-8')
                    _run_foreground_worker(executable, data/'state', diagnostic['id'])
                    final_diagnostic = json.loads(path.read_text(encoding='utf-8'))
                    _print_workflow_snapshot(data, 'foreground diagnostic fixture', final_diagnostic)
                except Exception as exc:
                    print(f'[foreground diagnostic fixture] diagnostic error: {type(exc).__name__}: {exc}', flush=True)
                raise AssertionError(('packaged workflow failed; see bounded process and fixture diagnostics above', state))
            request(f"/api/workflows/{workflow['id']}/start", {'approve': True})
            deadline = time.monotonic()+30
            while time.monotonic() < deadline:
                state = json.loads(request(f"/api/workflows/{workflow['id']}"))
                if state['status'] == 'completed':
                    break
                if state['status'] in ('failed', 'cancelled', 'interrupted'):
                    workflow_failure(state)
                time.sleep(.1)
            else:
                workflow_failure(state)
            assert '工作流_OK' in json.loads(request(f"/api/workflows/{workflow['id']}/logs/native"))['output']
            # Plugin gating keeps the baseline window/catalog available for recovery.
            request('/api/plugins/desktop', {'enabled': False})
            try:
                request('/api/desktop/status')
                raise AssertionError('disabled desktop feature accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            _assert_plugin_catalog(json.loads(request('/api/plugins'))['plugins'])
            slow_argv = ['powershell.exe', '-NoProfile', '-Command', "Start-Sleep -Seconds 3; Set-Content 'late-write' 'bad'"] if os.name == 'nt' else ['/bin/sh', '-c', 'sleep 3; touch late-write']
            slow = json.loads(request('/api/workflows', {'root': str(workspace), 'plan': {'nodes': [{'id': 'slow', 'argv': slow_argv}]}}))
            request(f"/api/workflows/{slow['id']}/start", {'approve': True})
            deadline = time.monotonic()+10
            while time.monotonic() < deadline:
                if json.loads(request(f"/api/workflows/{slow['id']}"))['nodes']['slow'].get('pid'):
                    break
                time.sleep(.1)
            else:
                raise AssertionError('cleanup test never started its command')
            if args.force_exit:
                proc.kill()
                proc.wait(timeout=15)
            else:
                proc.stdin.write('{"type":"shutdown"}\n'); proc.stdin.flush()
                assert proc.wait(timeout=15) == 0
            time.sleep(3.5)
            assert not (workspace/'late-write').exists(), 'desktop exit left an owned workflow command running'
            print(f'PASS: frozen runtime, authenticated HTTP, UI, {len(PLUGIN_IDS)} plugins, real PTY/ConPTY, workflow worker, gating and '+('forced-exit cleanup' if args.force_exit else 'shutdown'))
        except Exception:
            print('\n'.join(errors[-12:]))
            raise
        finally:
            if proc.poll() is None:
                try:
                    print(f'[backend cleanup] {_stop_process_tree(proc)}', flush=True)
                except Exception as exc:
                    print(f'[backend cleanup] tree termination failed: {type(exc).__name__}: {exc}', flush=True)
            for name in ('stdin', 'stdout', 'stderr'):
                stream = getattr(proc, name, None)
                if stream is not None:
                    try:
                        stream.close()
                    except (OSError, ValueError) as exc:
                        print(f'[backend cleanup] close {name} failed: {type(exc).__name__}: {exc}', flush=True)


if __name__ == '__main__':
    main()
