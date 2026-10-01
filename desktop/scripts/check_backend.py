"""Exercise the actual bundled backend, HTTP isolation and shutdown on each OS."""
import argparse
import base64
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--executable', type=Path)
    parser.add_argument('--force-exit', action='store_true', help='verify owned task cleanup after abrupt host loss')
    args = parser.parse_args()
    executable = args.executable or ROOT/'desktop/runtime/backend'/('xueness-backend.exe' if os.name == 'nt' else 'xueness-backend')
    with tempfile.TemporaryDirectory(prefix='xueness-frozen-check-') as temporary:
        data = Path(temporary)/'data'
        token = secrets.token_hex(32)
        proc = subprocess.Popen([str(executable), '--data', str(data), '--assets', str(ROOT/'webapp/dist')],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', env={**os.environ, 'XUENESS_DESKTOP_TOKEN': token, 'XUENESS_ALLOW_REAL': '0'})
        output = queue.Queue()
        threading.Thread(target=lambda: [output.put(line) for line in proc.stdout], daemon=True).start()
        errors = []
        threading.Thread(target=lambda: errors.extend(proc.stderr.read().splitlines()), daemon=True).start()
        try:
            ready = json.loads(output.get(timeout=45))
            assert ready['type'] == 'ready', ready
            url = ready['url']

            def request(path, body=None):
                payload = json.dumps(body).encode() if body is not None else None
                headers = {'X-Xueness-Desktop-Token': token, 'Content-Type': 'application/json'}
                if payload is not None:
                    headers['X-CSRF-Token'] = json.loads(request('/api/csrf'))['csrfToken']
                req = urllib.request.Request(url+path, data=payload, headers=headers)
                with urllib.request.urlopen(req, timeout=15) as response:
                    return response.read()

            try:
                urllib.request.urlopen(url+'/api/health', timeout=5)
                raise AssertionError('unauthenticated desktop access accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            assert json.loads(request('/api/health'))['ok']
            assert b'assets/' in request('/')
            plugins = json.loads(request('/api/plugins'))['plugins']
            assert len(plugins) == 27 and any(p['id'] == 'desktop' for p in plugins)
            status = json.loads(request('/api/desktop/status'))
            assert status['desktop'] and status['frozen']
            workspace = data/'workspace'
            session = json.loads(request('/api/sessions', {'task': 'packaged terminal smoke', 'root': str(workspace)}))
            sid = session.get('id') or session['session']['id']
            term = json.loads(request('/api/terminals', {'session_id': sid, 'open': True}))
            # The marker must occur in shell output, never merely echoed input.
            command = "Write-Output ('XUENESS_' + 'TERMINAL_OK')\r\n" if os.name == 'nt' else "printf 'XUENESS_%s\\n' TERMINAL_OK\n"
            request(f"/api/terminals/{term['id']}/input", {'text': command})
            deadline = time.monotonic()+10
            while time.monotonic() < deadline:
                tail = json.loads(request(f"/api/terminals/{term['id']}"))
                if b'XUENESS_TERMINAL_OK' in base64.b64decode(tail['data']):
                    break
                time.sleep(.1)
            else:
                raise AssertionError('packaged interactive terminal did not respond')
            request(f"/api/terminals/{term['id']}/close", {})
            argv = ['powershell.exe', '-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '工作流_OK'"] if os.name == 'nt' else ['/bin/sh', '-c', "printf '工作流_OK\\n'"]
            workflow = json.loads(request('/api/workflows', {'root': str(workspace), 'plan': {'nodes': [{'id': 'native', 'argv': argv}]}}))
            request(f"/api/workflows/{workflow['id']}/start", {'approve': True})
            deadline = time.monotonic()+15
            while time.monotonic() < deadline:
                state = json.loads(request(f"/api/workflows/{workflow['id']}"))
                if state['status'] == 'completed':
                    break
                if state['status'] in ('failed', 'cancelled'):
                    raise AssertionError(('packaged workflow failed', state))
                time.sleep(.1)
            else:
                raise AssertionError('packaged workflow worker did not finish')
            assert '工作流_OK' in json.loads(request(f"/api/workflows/{workflow['id']}/logs/native"))['output']
            # Plugin gating keeps the baseline window/catalog available for recovery.
            request('/api/plugins/desktop', {'enabled': False})
            try:
                request('/api/desktop/status')
                raise AssertionError('disabled desktop feature accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            assert len(json.loads(request('/api/plugins'))['plugins']) == 27
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
            print('PASS: frozen runtime, authenticated HTTP, UI, 27 plugins, real PTY/ConPTY, workflow worker, gating and '+('forced-exit cleanup' if args.force_exit else 'shutdown'))
        except Exception:
            print('\n'.join(errors[-12:]))
            raise
        finally:
            if proc.poll() is None:
                proc.kill(); proc.wait(timeout=5)
            proc.stdin.close(); proc.stdout.close(); proc.stderr.close()


if __name__ == '__main__':
    main()
