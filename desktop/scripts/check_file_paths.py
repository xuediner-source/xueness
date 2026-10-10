"""Exercise workspace paths through real frozen tool calls on Windows and macOS.

The model fixture is loopback-only and all settings, sessions and files live in
temporary data. No user state or external model credentials are used.
"""
import argparse
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
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--executable', type=Path, default=ROOT / 'desktop/runtime/backend' /
                        ('xueness-backend.exe' if os.name == 'nt' else 'xueness-backend'))
    parser.add_argument('--assets', type=Path, default=ROOT / 'webapp/dist')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='xueness-absolute-path-', ignore_cleanup_errors=True) as temporary:
        data = Path(temporary) / 'data'
        root = data / 'workspace'
        root.mkdir(parents=True)
        sample = root / 'sample.txt'
        sample.write_text('before 中文', encoding='utf-8')
        written = root / 'written.txt'
        outside = data / 'outside.txt'
        outside.write_text('outside sentinel', encoding='utf-8')
        steps = [
            ('read', {'path': str(sample)}),
            ('list', {'path': str(root)}),
            ('glob', {'path': root.as_posix(), 'pattern': '*.txt'}),
            ('grep', {'path': str(root), 'pattern': 'before', 'include': '*.txt'}),
            ('write', {'path': str(written), 'content': 'original'}),
            ('edit', {'path': written.as_posix(), 'old': 'original', 'new': 'changed'}),
            ('read', {'path': str(written)}),
        ]
        calls = []

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if self.path != '/v1/chat/completions':
                    self.send_error(404)
                    return
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                index = len(calls)
                if index < len(steps):
                    name, arguments = steps[index]
                    call = {'id': f'call_absolute_{index}', 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}
                    calls.append(call)
                    message = {'role': 'assistant', 'content': None, 'tool_calls': [call]}
                    finish = 'tool_calls'
                else:
                    message = {'role': 'assistant', 'content': json.dumps({
                        'summary': 'All seven absolute-path tool calls were checked.',
                        'evidence': [{'tool_call_id': call['id'], 'observation': 'tool succeeded'}
                                     for call in calls]})}
                    finish = 'stop'
                if body.get('stream'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    delta = dict(message)
                    if 'tool_calls' in delta:
                        delta['tool_calls'] = [dict(call, index=0) for call in delta['tool_calls']]
                    for value in ({'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                                  {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]}):
                        self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                    self.wfile.write(b'data: [DONE]\n\n')
                else:
                    encoded = json.dumps({'choices': [{'index': 0, 'message': message,
                                                       'finish_reason': finish}]}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)

        model = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        token = secrets.token_hex(32)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('XUENESS_API_', 'XUENESS_SEARCH_', 'XUENESS_MODEL'))}
        env.update(XUENESS_DESKTOP_TOKEN=token, XUENESS_ALLOW_REAL='1',
                   XUENESS_ALLOW_LOOPBACK_HTTP='1', PYTHONUTF8='1')
        proc = subprocess.Popen([str(args.executable), '--data', str(data), '--assets', str(args.assets)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', env=env,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        output = queue.Queue()
        threading.Thread(target=lambda: [output.put(line) for line in proc.stdout], daemon=True).start()
        errors = []
        threading.Thread(target=lambda: errors.extend(proc.stderr.read().splitlines()), daemon=True).start()
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                ready = json.loads(output.get(timeout=max(.01, deadline - time.monotonic())))
                if ready.get('type') == 'ready':
                    break
            else:
                raise AssertionError('compiled backend did not become ready')
            origin = ready['url']

            def request(path, body=None):
                payload = json.dumps(body).encode() if body is not None else None
                headers = {'X-Xueness-Desktop-Token': token, 'Content-Type': 'application/json'}
                if payload is not None:
                    headers['X-CSRF-Token'] = request('/api/csrf')['csrfToken']
                req = urllib.request.Request(origin + path, data=payload, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=60) as response:
                        return json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    if '/file?' in path:
                        raise
                    raise AssertionError(f'isolated HTTP {exc.code} {path}: ' +
                                         exc.read().decode('utf-8')) from exc

            status = request('/api/desktop/status')
            assert status['frozen'] and status['desktop'], status
            provider = request('/api/providers', {'id': 'absolute-path-fixture', 'name': 'absolute-path fixture',
                               'baseUrl': f'http://127.0.0.1:{model.server_port}/v1',
                               'model': 'path-fixture', 'apiKey': 'fixture-only'})
            pid = provider.get('id') or provider['provider']['id']
            session = request('/api/sessions', {
                'task': 'Verify the supplied file tool sequence and cite its results.',
                'root': str(root), 'provider_id': pid, 'model': 'path-fixture'})
            sid = session['id']
            result = request(f'/api/sessions/{sid}/run', {
                'permission_mode': 'yolo', 'acknowledge_yolo': True,
                'provider_id': pid, 'model': 'path-fixture',
                'runtime_profile': 'standard', 'steps': 12, 'max_wall_seconds': 45})
            stored = json.loads((data / 'state' / f'{sid}.json').read_text(encoding='utf-8'))
            assert len(calls) == len(steps), (len(calls), result)
            for call in calls:
                tool_result = stored['results'][call['id']]
                assert tool_result['ok'], (call['function']['name'], tool_result)
            assert stored['results'][calls[0]['id']]['output'] == 'before 中文'
            assert stored['results'][calls[-1]['id']]['output'] == 'changed'
            assert written.read_text(encoding='utf-8') == 'changed'
            assert stored['status'] == 'completed', stored['status']
            assert stored.get('completion', {}).get('status') == 'verified', stored.get('completion')
            for name in (str(sample), sample.as_posix(), 'sample.txt'):
                preview = request(f'/api/sessions/{sid}/file?' + urllib.parse.urlencode({'path': name}))
                assert preview['text'] == 'before 中文', preview
            denied = [str(outside), '../outside.txt']
            if os.name == 'nt':
                denied.extend((str(sample) + ':stream', str(root / 'NUL.txt'),
                               root.drive + 'sample.txt', str(sample) + '.'))
            for name in denied:
                try:
                    request(f'/api/sessions/{sid}/file?' + urllib.parse.urlencode({'path': name}))
                except urllib.error.HTTPError as exc:
                    assert exc.code == 400, exc.code
                else:
                    raise AssertionError('invalid path was accepted: ' + name)
            assert outside.read_text(encoding='utf-8') == 'outside sentinel'
            print(json.dumps({'frozen': True, 'isolated_state': True,
                              'successful_tool_calls': [name for name, _ in steps],
                              'absolute_and_relative_previews': 3, 'rejected_invalid_paths': len(denied),
                              'completion_status': stored.get('completion', {}).get('status'),
                              'session_status': stored['status']}, ensure_ascii=False), flush=True)
        except Exception:
            print('\n'.join(errors[-8:]))
            raise
        finally:
            if proc.poll() is None:
                proc.stdin.write('{"type":"shutdown"}\n')
                proc.stdin.flush()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            model.shutdown()
            model.server_close()
            model_thread.join(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                stream.close()


if __name__ == '__main__':
    main()
