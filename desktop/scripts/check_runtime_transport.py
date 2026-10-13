"""Verify runtime workers in a real native backend using disposable fixtures.

No operator configuration, external network endpoint or model is used. Run
once against the backend payload and again with --node-executable pointing
at the packaged Electron executable to verify its managed Node boundary.
"""
from __future__ import annotations

import argparse
import base64
from collections import deque
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from xueness import process_runtime

DOMAIN = b'Xueness external package v1\0'
MAX_FRAME = 1_048_576
TEXT = 'Native runtime fixture: 中文 OK'
PROMPT = 'Read the disposable runtime fixture'
LEAK_KEY = 'XUENESS_SMOKE_OPERATOR_SECRET'


PYTHON_AGENT = r'''
import json, os, sys
from pathlib import Path
Path('python-runtime.json').write_text(json.dumps({
    'executable': sys.executable, 'pid': os.getpid(), 'cwd': str(Path.cwd()),
    'version': sys.version.split()[0],
    'secretPresent': 'XUENESS_SMOKE_OPERATOR_SECRET' in os.environ,
    'hostStatePresent': 'XUENESS_PI_LITE_STATE_DIR' in os.environ,
}), encoding='utf-8')
def send(item):
    print(json.dumps({'jsonrpc': '2.0', **item}), flush=True)
def read():
    line = sys.stdin.readline()
    if not line: raise SystemExit(0)
    value = json.loads(line)
    with open('python-requests.jsonl', 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(value) + '\n')
    return value
for method in ('initialize', 'session/new', 'session/prompt'):
    request = read()
    assert request['method'] == method
    if method == 'initialize':
        send({'id': request['id'], 'result': {'protocolVersion': 1, 'agentCapabilities': {}}})
    elif method == 'session/new':
        send({'id': request['id'], 'result': {'sessionId': 'native-fixture'}})
    else:
        send({'id': 'permission', 'method': 'session/request_permission', 'params': {
            'sessionId': 'native-fixture', 'toolCall': {'toolCallId': 'fixture'},
            'options': [{'optionId': 'allow', 'kind': 'allow_once', 'name': 'Allow'}]}})
        assert read()['result']['outcome']['outcome'] == 'cancelled'
        for unsupported in ('fs/write_text_file', 'terminal/create'):
            send({'id': unsupported, 'method': unsupported, 'params': {'sessionId': 'native-fixture'}})
            assert read()['error']['code'] == -32601
        send({'method': 'session/update', 'params': {'sessionId': 'native-fixture', 'update': {
            'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': TEXT_VALUE}}}})
        send({'id': request['id'], 'result': {'stopReason': 'end_turn'}})
        read()
'''.replace('TEXT_VALUE', repr(TEXT))


NODE_AGENT = r'''
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync('node-runtime.json', JSON.stringify({
  executable: process.execPath, pid: process.pid, cwd: process.cwd(),
  version: process.versions.node, electronVersion: process.versions.electron || null,
  secretPresent: Object.hasOwn(process.env, 'XUENESS_SMOKE_OPERATOR_SECRET'),
  hostStatePresent: Object.hasOwn(process.env, 'XUENESS_PI_LITE_STATE_DIR'),
}));
const send = item => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...item})+'\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync('node-requests.jsonl', JSON.stringify(request)+'\n');
  if (request.method === 'initialize') {
    send({id:request.id, result:{protocolVersion:1, agentCapabilities:{}}});
  } else if (request.method === 'session/new') {
    send({id:request.id, result:{sessionId:'native-fixture'}});
  } else if (request.method === 'session/prompt') {
    promptId = request.id;
    send({id:'permission', method:'session/request_permission', params:{
      sessionId:'native-fixture', toolCall:{toolCallId:'fixture'},
      options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
  } else if (request.id === 'permission') {
    if (request.result.outcome.outcome !== 'cancelled') throw Error('permission allowed');
    send({id:'fs/write_text_file',method:'fs/write_text_file',params:{sessionId:'native-fixture'}});
  } else if (request.id === 'fs/write_text_file') {
    if (request.error.code !== -32601) throw Error('filesystem allowed');
    send({id:'terminal/create',method:'terminal/create',params:{sessionId:'native-fixture'}});
  } else if (request.id === 'terminal/create') {
    if (request.error.code !== -32601) throw Error('terminal allowed');
    send({method:'session/update',params:{sessionId:'native-fixture',update:{
      sessionUpdate:'agent_message_chunk', content:{type:'text',text:TEXT_VALUE}}}});
    send({id:promptId,result:{stopReason:'end_turn'}});
  } else { throw Error('unexpected protocol frame'); }
});
'''.replace('TEXT_VALUE', json.dumps(TEXT))


def _native_arch(value):
    return {'amd64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64'}.get(value.lower(), value.lower())


def _payload(executable):
    directory = executable.parent
    manifest_path = directory / 'runtime-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    assert manifest['platform'] == sys.platform, 'backend platform does not match the executing host'
    assert _native_arch(manifest['architecture']) == _native_arch(platform.machine()), 'backend architecture mismatch'
    assert (directory / '_internal').is_dir(), 'expected a real PyInstaller onedir payload'
    rows = manifest['files']
    assert isinstance(rows, list) and rows, 'native runtime manifest is empty'
    own_row = next(row for row in rows if row['path'] == executable.name)
    assert hashlib.sha256(executable.read_bytes()).hexdigest() == own_row['sha256'], 'backend binary digest changed'
    forbidden = {'plugin-state.json', 'external-package-trust.json', 'runtime-state.json', '.env'}
    private_directories = {'state', 'sessions', 'external-packages', 'providers', 'provider-profiles'}
    for row in rows:
        path = Path(row['path'])
        assert not path.is_absolute() and '..' not in path.parts, 'unsafe payload manifest path'
        private_path = 'bundled_plugins' not in path.parts and bool(set(path.parts) & private_directories)
        assert path.name not in forbidden and not private_path, 'operator state in frozen payload'
    return {'platform': manifest['platform'], 'architecture': manifest['architecture'],
            'python': manifest['python'], 'binarySha256': own_row['sha256'], 'operatorStateInPayload': False}


def _environment(home, python_executable=None, node_executable=None):
    permitted = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'}
    env = {key: value for key, value in os.environ.items() if key.upper() in permitted}
    env.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(home / 'config'),
               XDG_DATA_HOME=str(home / 'data'), APPDATA=str(home / 'roaming'), LOCALAPPDATA=str(home / 'local'),
               PYTHONUTF8='1', PYTHONIOENCODING='utf-8', XUENESS_ALLOW_REAL='0')
    env[LEAK_KEY] = 'disposable-environment-sentinel'
    if python_executable:
        env['XUENESS_EXTERNAL_PYTHON'] = str(python_executable)
    if node_executable:
        env['XUENESS_DESKTOP_NODE'] = str(node_executable)
    return env


class JsonChild:
    """Read bounded JSONL without letting a stuck worker hang acceptance."""
    def __init__(self, argv, cwd, env):
        options = {'cwd': cwd, 'env': env, 'stdin': subprocess.PIPE, 'stdout': subprocess.PIPE,
                   'stderr': subprocess.PIPE, 'bufsize': 0}
        if os.name == 'nt':
            options['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        else:
            options['start_new_session'] = True
        self.proc = subprocess.Popen(argv, **options)
        process_runtime.note_owned_process(self.proc, group=os.name != 'nt')
        self.lines = queue.Queue(maxsize=32)
        self.errors = deque(maxlen=4)
        self.threads = [threading.Thread(target=self._read, daemon=True),
                        threading.Thread(target=self._stderr, daemon=True)]
        for thread in self.threads:
            thread.start()

    def _read(self):
        try:
            while True:
                raw = self.proc.stdout.readline(MAX_FRAME + 2)
                if not raw:
                    self.lines.put(None, timeout=1)
                    return
                if len(raw) > MAX_FRAME + 1 or not raw.endswith(b'\n'):
                    raise ValueError('worker produced an invalid JSONL frame')
                self.lines.put(json.loads(raw), timeout=1)
        except Exception as exc:
            try:
                self.lines.put(exc, timeout=1)
            except queue.Full:
                pass

    def _stderr(self):
        try:
            while True:
                raw = self.proc.stderr.read(2048)
                if not raw:
                    return
                self.errors.append(raw.decode('utf-8', 'replace'))
        except (OSError, ValueError):
            pass

    def send(self, value):
        self.proc.stdin.write((json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
        self.proc.stdin.flush()

    def receive(self, timeout=25):
        try:
            value = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError('native worker timed out; ' + ''.join(self.errors)[-2000:]) from None
        if isinstance(value, Exception):
            raise value
        assert isinstance(value, dict), 'native worker exited before responding; ' + ''.join(self.errors)[-2000:]
        return value

    def finish(self):
        self.proc.stdin.close()
        assert self.proc.wait(timeout=12) == 0, 'native worker exited unsuccessfully; ' + ''.join(self.errors)[-2000:]
        process_runtime.forget_owned_process(self.proc)

    def close(self):
        # Preserve unreaped group ownership on a failed POSIX worker.
        if self.proc.returncode is None:
            assert process_runtime.terminate_process_tree(self.proc, group=os.name != 'nt', grace=0.2), 'fixture worker tree cleanup failed'
        process_runtime.forget_owned_process(self.proc)
        for name in ('stdin', 'stdout', 'stderr'):
            stream = getattr(self.proc, name)
            if stream is not None and not stream.closed:
                stream.close()
        for thread in self.threads:
            thread.join(timeout=1)


class LocalProvider:
    def __init__(self):
        self.requests = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                assert 0 < size < MAX_FRAME, 'unbounded fixture request'
                body = json.loads(self.rfile.read(size))
                fixture.requests.append({'path': self.path, 'body': body})
                events = [
                    {'choices': [{'delta': {'reasoning_content': 'Fixture reasoning'}, 'finish_reason': None}]},
                    {'choices': [{'delta': {'content': TEXT}, 'finish_reason': None}]},
                    {'choices': [{'delta': {}, 'finish_reason': 'stop'}]},
                ]
                raw = b''.join(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode('utf-8')
                               for event in events) + b'data: [DONE]\n\n'
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/v1'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def _pi_worker(command, state, workspace, env):
    fixture = LocalProvider()
    try:
        profiles = state / 'providers'
        profiles.mkdir()
        (profiles / 'native-fixture.json').write_text(json.dumps({
            'id': 'native-fixture', 'name': 'Disposable native fixture', 'protocol': 'openai',
            'baseUrl': fixture.base, 'model': 'fixture-model', 'apiKey': '', 'runtimeProfile': 'lightweight',
        }), encoding='utf-8')
        child = JsonChild([*command, '--state', str(state), 'pi-lite-worker'], workspace, env)
        try:
            envelope = {'version': 1, 'requestId': 'native-request', 'sessionId': 'native-session',
                        'method': 'turn/start'}
            child.send({**envelope, 'payload': {'providerId': 'native-fixture', 'expectedBase': fixture.base,
                       'messages': [{'role': 'user', 'content': PROMPT}], 'tools': [], 'timeoutSeconds': 10}})
            frames = []
            for _ in range(16):
                frame = child.receive()
                assert all(frame.get(key) == value for key, value in envelope.items()), 'worker response identity mismatch'
                assert frame.get('ok') is True, frame
                frames.append(frame['payload'])
                if frame['payload'].get('type') == 'result':
                    break
            else:
                raise AssertionError('frozen pi-lite worker did not finish')
            assert ''.join(frame.get('text', '') for frame in frames if frame['type'] == 'text-delta') == TEXT
            assert ''.join(frame.get('text', '') for frame in frames if frame['type'] == 'reasoning-delta') == 'Fixture reasoning'
            assert TEXT in json.dumps(frames[-1]['result'], ensure_ascii=False), 'final provider result missing'
            child.finish()
        finally:
            child.close()
        assert len(fixture.requests) == 1 and fixture.requests[0]['path'] == '/v1/chat/completions', fixture.requests
        assert fixture.requests[0]['body']['messages'] == [{'role': 'user', 'content': PROMPT}]
        return {'worker': 'same frozen backend executable', 'providerRequests': 1,
                'reasoningAndTextDeltas': True, 'utf8Result': True, 'network': '127.0.0.1 fixture'}
    finally:
        fixture.close()


def _cli(command, state, workspace, env, args, *, success=True):
    options = {'cwd': workspace, 'env': env, 'capture_output': True, 'timeout': 25}
    if os.name == 'nt':
        options['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    result = subprocess.run([*command, '--state', str(state), 'extension-package', *args], **options)
    if not success:
        assert result.returncode != 0, 'invalid signature was accepted by the frozen verifier'
        return None
    assert result.returncode == 0, 'frozen package CLI failed; ' + result.stderr.decode('utf-8', 'replace')[-2000:]
    return json.loads(result.stdout)


def _package(workspace, runtime, private):
    package_id = 'native-' + runtime + '-fixture'
    entrypoint = 'agent.py' if runtime == 'python' else 'agent.cjs'
    manifest = {'apiVersion': 1, 'id': package_id, 'version': '1.0.0', 'transport': 'acp-stdio',
                'runtime': runtime, 'entrypoint': entrypoint, 'capabilities': ['command']}
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xueness-package.json', json.dumps(manifest))
        archive.writestr(entrypoint, PYTHON_AGENT if runtime == 'python' else NODE_AGENT)
    data = output.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    path = workspace / (package_id + '.zip')
    path.write_bytes(data)
    signature = {'keyId': 'native-fixture-key', 'signature': base64.b64encode(
        private.sign(DOMAIN + digest.encode('ascii'))).decode('ascii')}
    signature_path = workspace / (package_id + '.signature.json')
    signature_path.write_text(json.dumps(signature), encoding='utf-8')
    return package_id, path, digest, signature_path


def _acp_worker(command, state, workspace, env, runtime, package_id, digest, expected_executable):
    child = JsonChild([*command, '--state', str(state), 'mcp-acp-worker', package_id, digest], workspace, env)
    try:
        def rpc(rid, method, params):
            child.send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
            response = child.receive()
            assert response.get('id') == rid and 'error' not in response, response
            return response['result']

        hello = rpc(1, 'initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                    'clientInfo': {'name': 'native-fixture', 'version': '1'}})
        assert hello['serverInfo']['name'] == 'Xueness ACP adapter'
        assert [tool['name'] for tool in rpc(2, 'tools/list', {})['tools']] == ['agent_prompt']
        result = rpc(3, 'tools/call', {'name': 'agent_prompt', 'arguments': {'prompt': PROMPT}})
        assert result['content'] == [{'type': 'text', 'text': TEXT}], result
        child.finish()
    finally:
        child.close()
    identity = json.loads((workspace / (runtime + '-runtime.json')).read_text(encoding='utf-8'))
    assert not process_runtime._pid_alive(identity['pid']), 'managed ACP source child survived its completed call'
    assert Path(identity['cwd']).resolve() == workspace, 'source package escaped the fixture workspace'
    assert not identity['secretPresent'] and not identity['hostStatePresent'], 'operator environment crossed ACP boundary'
    assert Path(identity['executable']).is_file(), 'managed runtime identity is not an executable'
    if expected_executable:
        assert Path(identity['executable']).resolve() == expected_executable.resolve(), 'managed runtime ignored the supplied executable'
    requests = [json.loads(line) for line in (workspace / (runtime + '-requests.jsonl')).read_text(encoding='utf-8').splitlines()]
    assert [row.get('method') for row in requests[:3]] == ['initialize', 'session/new', 'session/prompt']
    assert requests[0]['params']['clientCapabilities'] == {} and requests[1]['params']['mcpServers'] == []
    assert Path(requests[1]['params']['cwd']).resolve() == workspace
    assert requests[2]['params']['prompt'] == [{'type': 'text', 'text': PROMPT}]
    assert requests[3]['result']['outcome']['outcome'] == 'cancelled'
    assert [row['error']['code'] for row in requests[4:]] == [-32601, -32601]
    return {'facade': 'same frozen backend executable', 'managedRuntime': identity['executable'],
            'runtimeSource': ('operator-installed external Python' if runtime == 'python' else
                              'supplied Electron' if identity.get('electronVersion') else 'supplied Node'),
            'runtimeVersion': identity['version'], 'electronVersion': identity.get('electronVersion'),
            'clientPermissions': 'denied', 'filesystemAndTerminalRequests': 'refused',
            'operatorCredentialsPassed': False, 'sourceChildExited': True, 'utf8Result': True}


def _signed_packages(command, state, workspace, env, python_executable, node_executable):
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError:
        raise AssertionError('the acceptance runner requires cryptography to sign its disposable fixtures') from None
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    fingerprint = hashlib.sha256(public).hexdigest()
    pinned = _cli(command, state, workspace, env, ['trust-key', 'native-fixture-key',
                  '--public-key', base64.b64encode(public).decode('ascii'), '--fingerprint', fingerprint])
    assert pinned['fingerprint'] == fingerprint
    checks = {}
    for runtime, interpreter in [('python', python_executable), ('node', node_executable)]:
        package_id, path, digest, signature = _package(workspace, runtime, private)
        bad = workspace / (runtime + '-bad-signature.json')
        bad.write_text(json.dumps({'keyId': 'native-fixture-key',
                                  'signature': base64.b64encode(bytes(64)).decode('ascii')}), encoding='utf-8')
        _cli(command, state, workspace, env, ['review', str(path), '--sha256', digest, '--signature', str(bad)], success=False)
        installed = _cli(command, state, workspace, env, ['install', str(path), '--sha256', digest, '--signature', str(signature)])
        assert installed['provenance']['kind'] == 'ed25519' and not installed['enabled'], installed
        assert not (workspace / (runtime + '-runtime.json')).exists(), 'installation executed source code'
        enabled = _cli(command, state, workspace, env, ['enable', package_id, '--sha256', digest, '--grant', 'command'])
        assert enabled['enabled'] and enabled['grants'] == ['command']
        checks[runtime] = _acp_worker(command, state, workspace, env, runtime, package_id, digest, interpreter)
        disabled = _cli(command, state, workspace, env, ['disable', package_id, '--sha256', digest])
        assert not disabled['enabled']
        child = JsonChild([*command, '--state', str(state), 'mcp-acp-worker', package_id, digest], workspace, env)
        try:
            child.send({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}})
            assert 'error' in child.receive(), 'disabled source package remained callable'
            child.finish()
        finally:
            child.close()
    checks['ed25519'] = {'frozenVerifierLoaded': True, 'validSignatureAccepted': True,
                         'invalidSignatureRejected': True, 'installExecutedSource': False}
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path, default=ROOT / 'desktop/runtime/backend' /
                        ('xueness-backend.exe' if os.name == 'nt' else 'xueness-backend'))
    parser.add_argument('--python-executable', type=Path, help='explicit external Python used by source packages')
    parser.add_argument('--node-executable', type=Path, help='packaged Electron executable or a native Node executable')
    parser.add_argument('--report', type=Path, help='save a platform-specific JSON acceptance report')
    args = parser.parse_args()
    executable = args.executable.expanduser().resolve()
    python_executable = args.python_executable.expanduser().resolve() if args.python_executable else None
    node = args.node_executable or shutil.which('node')
    node_executable = Path(node).expanduser().resolve() if node else None
    assert executable.is_file(), f'frozen backend does not exist: {executable}'
    assert node_executable and node_executable.is_file(), 'provide --node-executable to verify managed Node packages'
    if python_executable:
        assert python_executable.is_file(), 'specified external Python does not exist'
    report = {'platform': sys.platform, 'architecture': _native_arch(platform.machine()), 'backend': str(executable),
              'status': 'failed', 'checks': {}, 'limitations': ['Python source packages require an external Python interpreter.']}
    try:
        report['checks']['nativePayload'] = _payload(executable)
        with tempfile.TemporaryDirectory(prefix='xueness-runtime-native-') as temporary:
            root = Path(temporary).resolve()
            state, home, workspace = root / 'state', root / 'home', root / 'workspace'
            for directory in (state, home, workspace):
                directory.mkdir()
            (state / 'plugin-state.json').write_text(json.dumps({'apiVersion': 1, 'enabled': {'updates': False}}), encoding='utf-8')
            env = _environment(home, python_executable, node_executable)
            command = [str(executable)]
            report['checks']['piLite'] = _pi_worker(command, state, workspace, env)
            report['checks'].update(_signed_packages(command, state, workspace, env, python_executable, node_executable))
            report['checks']['isolation'] = {'state': 'disposable explicit directory', 'home': 'disposable directory',
                                              'providerCalls': 'local fixture only', 'paidModelCalls': 0}
        report['status'] = 'passed'
    except Exception as exc:
        report['failure'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: {sys.platform}/{platform.machine()} frozen Pi worker, Ed25519 verifier, Python/Node ACP facade and isolated state')
    print('External Python: ' + report['checks']['python']['managedRuntime'])
    print('Managed Node/Electron: ' + report['checks']['node']['managedRuntime'])


if __name__ == '__main__':
    main()
