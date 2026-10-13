"""Single-task ACP v1 client for an explicitly configured external agent.

This boundary does not implement the host's read-only ``task`` contract. An
ACP agent owns its own model and tools; no filesystem or terminal capability
is advertised, and every permission request is denied. Protocol and process
failures use fixed diagnostics without exposing child output or credentials.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

from ...process_runtime import (
    ProcessCancelled, forget_owned_process, note_owned_process,
    spawn_external, terminate_process_tree,
)

MAX_FRAME_BYTES = 1_000_000
MAX_OUTPUT_BYTES = 256_000
MAX_PROMPT_BYTES = 128_000
MAX_FRAMES = 4096
QUEUE_LIMIT = 32
_EOF = object()


class AcpAdapterError(RuntimeError):
    """Safe external-agent failure, with no raw child payload in its text."""


class AcpCancelled(ProcessCancelled):
    """The external task was cancelled and its process has been reclaimed."""


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _constant(_value):
    raise ValueError('non-finite JSON number')


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('non-finite JSON number')
    return result


def _valid_id(value):
    return ((type(value) is int and -(2**53) < value < 2**53)
            or (isinstance(value, str) and 0 < len(value) <= 128))


def _frame(line):
    try:
        item = json.loads(line.decode('utf-8'), object_pairs_hook=_pairs,
                          parse_constant=_constant, parse_float=_finite_float)
    except (ValueError, UnicodeError, RecursionError):
        raise AcpAdapterError('ACP invalid JSON frame') from None
    if not isinstance(item, dict) or item.get('jsonrpc') != '2.0':
        raise AcpAdapterError('ACP invalid protocol frame')
    if set(item) - {'jsonrpc', 'id', 'method', 'params', 'result', 'error'}:
        raise AcpAdapterError('ACP invalid protocol envelope')
    if 'method' in item:
        if (not isinstance(item['method'], str) or not item['method']
                or len(item['method']) > 128
                or 'result' in item or 'error' in item
                or ('params' in item and not isinstance(item['params'], dict))
                or ('id' in item and not _valid_id(item['id']))):
            raise AcpAdapterError('ACP invalid request envelope')
    elif (not _valid_id(item.get('id'))
          or ('result' in item) == ('error' in item) or 'params' in item):
        raise AcpAdapterError('ACP invalid response envelope')
    if 'error' in item:
        error = item['error']
        if (not isinstance(error, dict) or type(error.get('code')) is not int
                or not isinstance(error.get('message'), str)):
            raise AcpAdapterError('ACP invalid error envelope')
    return item


class _Client:
    def __init__(self, argv, cwd, timeout, should_stop, env):
        self.argv = argv
        self.cwd = cwd
        self.deadline = time.monotonic() + timeout
        self.should_stop = should_stop
        self.launch_env = env
        self.proc = None
        self.job = None
        self.closed = threading.Event()
        self.frames = queue.Queue(maxsize=QUEUE_LIMIT)
        self.writes = queue.Queue(maxsize=2)
        self.reader_error = None
        self.threads = []
        self.session_id = None
        self.output = []
        self.output_size = 0
        self.frame_count = 0

    def _check(self):
        if self.should_stop is not None and self.should_stop():
            raise AcpCancelled('ACP task cancelled')
        if time.monotonic() >= self.deadline:
            raise AcpAdapterError('ACP task timed out')
        if self.reader_error is not None:
            raise self.reader_error

    def start(self):
        self._check()
        # Only runtime variables cross the boundary. Installed agents must
        # resolve credentials through their own explicitly configured home.
        permitted = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
                     'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'}
        env = {key: value for key, value in os.environ.items()
               if key.upper() in permitted}
        env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
        env.update(self.launch_env)
        options = {'stdin': subprocess.PIPE, 'stdout': subprocess.PIPE,
                   'stderr': subprocess.PIPE, 'shell': False, 'bufsize': -1,
                   'cwd': self.cwd, 'env': env}
        factory = subprocess.Popen
        if os.name == 'nt':
            from .windows_process import ProcessTreeJob, windows_creationflags
            self.job = ProcessTreeJob()
            options['creationflags'] = windows_creationflags()

            def factory(*args, **kwargs):
                self.proc = subprocess.Popen(*args, **kwargs)
                return self.proc
        else:
            options['start_new_session'] = True
        try:
            self.proc = spawn_external(factory, self.argv, **options)
            note_owned_process(self.proc, group=os.name != 'nt')
            if self.job is not None:
                self.job.assign_and_resume(self.proc)
        except Exception:
            raise AcpAdapterError('ACP process startup failed') from None
        for target in (self._read, self._write, self._drain_stderr):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self.threads.append(thread)

    def _enqueue(self, value):
        try:
            self.frames.put(value, timeout=0.1)
        except queue.Full:
            self.reader_error = AcpAdapterError('ACP frame queue limit exceeded')

    def _read(self):
        try:
            while not self.closed.is_set():
                line = self.proc.stdout.readline(MAX_FRAME_BYTES + 1)
                if not line:
                    self._enqueue(_EOF)
                    return
                if len(line) > MAX_FRAME_BYTES or not line.endswith(b'\n'):
                    raise AcpAdapterError('ACP frame size or framing limit exceeded')
                self._enqueue(_frame(line))
                if self.reader_error is not None:
                    return
        except AcpAdapterError as exc:
            self.reader_error = exc
        except Exception:
            if not self.closed.is_set():
                self.reader_error = AcpAdapterError('ACP stdout failed')

    def _write(self):
        while not self.closed.is_set():
            try:
                body, done, status = self.writes.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                remaining = memoryview(body)
                while remaining:
                    written = self.proc.stdin.write(remaining)
                    if not written:
                        raise OSError('closed stdin')
                    remaining = remaining[written:]
                self.proc.stdin.flush()
            except Exception:
                status.append(AcpAdapterError('ACP stdin failed'))
            finally:
                done.set()

    def _drain_stderr(self):
        # Discard diagnostics in bounded chunks: untrusted stderr must not
        # become tool output, an exception message, or unbounded storage.
        try:
            while not self.closed.is_set() and self.proc.stderr.read(4096):
                pass
        except Exception:
            pass

    def send(self, message):
        self._check()
        body = (json.dumps(message, ensure_ascii=False, allow_nan=False,
                           separators=(',', ':')) + '\n').encode('utf-8')
        if len(body) > MAX_FRAME_BYTES:
            raise AcpAdapterError('ACP outgoing frame limit exceeded')
        done, status = threading.Event(), []
        try:
            self.writes.put_nowait((body, done, status))
        except queue.Full:
            raise AcpAdapterError('ACP write queue limit exceeded') from None
        while not done.wait(0.1):
            self._check()
        self._check()
        if status:
            raise status[0]

    def _notification(self, item):
        if item['method'] != 'session/update':
            return
        params = item.get('params', {})
        if (self.session_id is None or params.get('sessionId') != self.session_id
                or not isinstance(params.get('update'), dict)):
            raise AcpAdapterError('ACP update session mismatch')
        update = params['update']
        if update.get('sessionUpdate') != 'agent_message_chunk':
            return
        content = update.get('content')
        if not isinstance(content, dict):
            raise AcpAdapterError('ACP invalid assistant content')
        if content.get('type') != 'text':
            return
        text = content.get('text')
        if not isinstance(text, str):
            raise AcpAdapterError('ACP invalid assistant text')
        self.output_size += len(text.encode('utf-8'))
        if self.output_size > MAX_OUTPUT_BYTES:
            raise AcpAdapterError('ACP assistant output limit exceeded')
        self.output.append(text)

    def _answer(self, item):
        if item['method'] == 'session/request_permission':
            params = item.get('params', {})
            if self.session_id is None or params.get('sessionId') != self.session_id:
                raise AcpAdapterError('ACP permission session mismatch')
            response = {'result': {'outcome': {'outcome': 'cancelled'}}}
        else:
            # Includes fs/read_text_file, fs/write_text_file, terminal/create,
            # terminal/output, terminal/kill and all other client requests.
            response = {'error': {'code': -32601,
                                  'message': 'Client capability unavailable'}}
        self.send({'jsonrpc': '2.0', 'id': item['id'], **response})

    def request(self, request_id, method, params):
        self.send({'jsonrpc': '2.0', 'id': request_id,
                   'method': method, 'params': params})
        while True:
            self._check()
            try:
                item = self.frames.get(timeout=0.1)
            except queue.Empty:
                continue
            self._check()
            if item is _EOF:
                raise AcpAdapterError('ACP process closed before response')
            self.frame_count += 1
            if self.frame_count > MAX_FRAMES:
                raise AcpAdapterError('ACP frame count limit exceeded')
            if 'method' in item:
                if 'id' in item:
                    self._answer(item)
                else:
                    self._notification(item)
                continue
            if type(item['id']) is not type(request_id) or item['id'] != request_id:
                raise AcpAdapterError('ACP response ID mismatch')
            if 'error' in item:
                raise AcpAdapterError('ACP agent request failed')
            if not isinstance(item['result'], dict):
                raise AcpAdapterError('ACP invalid result')
            return item['result']

    def cancel(self):
        # Best-effort notification; authoritative cleanup is the process tree.
        # Never block on a child that refuses to read during cancellation.
        if self.session_id is not None and not self.closed.is_set():
            message = {'jsonrpc': '2.0', 'method': 'session/cancel',
                       'params': {'sessionId': self.session_id}}
            body = (json.dumps(message) + '\n').encode('utf-8')
            try:
                self.writes.put_nowait((body, threading.Event(), []))
            except queue.Full:
                pass

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        failed = False
        if self.job is not None:
            try:
                self.job.terminate_and_close()
            except Exception:
                failed = True
                self.job.close()
        if self.proc is not None:
            try:
                # Avoid poll() before this call: an unreaped POSIX leader
                # preserves ownership of its group even after stdout closes.
                if not terminate_process_tree(self.proc, group=os.name != 'nt', grace=0.5):
                    failed = True
            except Exception:
                failed = True
            if not failed:
                forget_owned_process(self.proc)
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:
                    pass
        for thread in self.threads:
            thread.join(timeout=0.2)
        if failed:
            raise AcpAdapterError('ACP process cleanup failed')


def run_agent(argv, cwd, prompt, *, timeout=60, should_stop=None, env=None) -> str:
    """Run one external ACP v1 task and reclaim its child on every outcome.

    ``argv`` and ``cwd`` must come from the operator's verified launch spec,
    not a model-supplied command. No parent transcript, tools, model settings,
    filesystem service or permission grants are forwarded to the child.
    """
    if (not isinstance(argv, (tuple, list)) or not argv or len(argv) > 128
            or any(not isinstance(part, str) or not part or '\x00' in part
                   for part in argv)
            or sum(len(part.encode('utf-8')) for part in argv) > 32_768):
        raise ValueError('ACP command must be a bounded argv array')
    if (not isinstance(prompt, str) or not prompt
            or len(prompt.encode('utf-8')) > MAX_PROMPT_BYTES):
        raise ValueError('ACP prompt must be bounded nonempty text')
    if (type(timeout) not in (int, float) or not math.isfinite(timeout)
            or not 0 < timeout <= 600):
        raise ValueError('ACP timeout must be between 0 and 600 seconds')
    if should_stop is not None and not callable(should_stop):
        raise ValueError('ACP stop callback must be callable')
    if env is None:
        env = {}
    if (not isinstance(env, dict) or set(env) - {'ELECTRON_RUN_AS_NODE'}
            or any(value != '1' for value in env.values())):
        raise ValueError('ACP launch environment is not allowed')
    try:
        path = Path(cwd).resolve(strict=True)
        if not path.is_dir():
            raise ValueError('not a directory')
    except (TypeError, OSError, ValueError):
        raise ValueError('ACP working directory is unavailable') from None
    client = _Client(list(argv), str(path), timeout, should_stop, dict(env))
    try:
        client.start()
        result = client.request(1, 'initialize', {
            'protocolVersion': 1, 'clientCapabilities': {},
            'clientInfo': {'name': 'xueness-external-agent', 'version': '1.0.0'},
        })
        if type(result.get('protocolVersion')) is not int or result['protocolVersion'] != 1:
            raise AcpAdapterError('ACP unsupported protocol version')
        result = client.request(2, 'session/new', {'cwd': str(path), 'mcpServers': []})
        session_id = result.get('sessionId')
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            raise AcpAdapterError('ACP invalid session identity')
        client.session_id = session_id
        result = client.request(3, 'session/prompt', {
            'sessionId': session_id, 'prompt': [{'type': 'text', 'text': prompt}],
        })
        client._check()
        reason = result.get('stopReason')
        if reason == 'cancelled':
            raise AcpCancelled('ACP agent cancelled task')
        if reason != 'end_turn':
            raise AcpAdapterError('ACP agent did not complete task')
        return ''.join(client.output)
    except AcpCancelled:
        client.cancel()
        raise
    except AcpAdapterError:
        raise
    except Exception:
        raise AcpAdapterError('ACP task failed') from None
    finally:
        client.close()
