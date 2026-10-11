"""On-demand owned Node worker with cancellation and plugin lifecycle cleanup."""
from __future__ import annotations
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid
from . import state

_LOCK = threading.RLock()
_WORKERS = {}
MAX_LINE = 8_000_000
IMPORT_ENV = frozenset({'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'QODER_ACCESS_TOKEN', 'QODER_USER_ID',
                        'ANTIGRAVITY_CLIENT_ID', 'ANTIGRAVITY_CLIENT_SECRET'})


class SubscriptionRequestError(ValueError):
    """Sanitized bridge failure, retaining machine-readable upstream cause."""
    def __init__(self, message, info=None):
        super().__init__(str(message)[:700])
        info = info if isinstance(info, dict) else {}
        categories = {'authentication_failed', 'rate_limited', 'timeout', 'connection_failed',
                      'upstream_failure', 'invalid_response', 'request_rejected', 'request_failed',
                      'endpoint_not_found', 'quota_exhausted', 'unsupported_region', 'context_overflow'}
        self.category = info.get('category') if info.get('category') in categories else 'request_failed'
        status = info.get('status')
        self.status = status if type(status) is int and 100 <= status <= 599 else None


class Worker:
    def __init__(self, state_dir):
        from ...process_runtime import spawn_external, note_owned_process
        self.state_dir = str(Path(state_dir).absolute())
        self.lock = threading.RLock()
        self.pending = {}
        self.closed = threading.Event()
        env = {key: value for key, value in os.environ.items()
               if not re.search(r'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL', key, re.I) or key in IMPORT_ENV}
        env['XUENESS_SUBSCRIPTIONS_STORE'] = str(state.directory(state_dir, create=True))
        if os.environ.get('XUENESS_DESKTOP_NODE'):
            env['ELECTRON_RUN_AS_NODE'] = '1'
        command = [os.environ.get('XUENESS_DESKTOP_NODE') or 'node', str(state.PACKAGE / 'worker.mjs')]
        self.process = spawn_external(subprocess.Popen, command, env=env, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                                      cwd=str(state.directory(state_dir)))
        note_owned_process(self.process)
        self.reader = threading.Thread(target=self._read, name='xueness-subscriptions-read', daemon=True)
        self.monitor = threading.Thread(target=self._monitor, name='xueness-subscriptions-policy', daemon=True)
        self.reader.start()
        self.monitor.start()

    def _read(self):
        try:
            while not self.closed.is_set():
                raw = self.process.stdout.readline(MAX_LINE + 1)
                if not raw:
                    break
                if len(raw) > MAX_LINE or not raw.endswith(b'\n'):
                    break
                value = json.loads(raw)
                if not isinstance(value, dict):
                    break
                with self.lock:
                    waiter = self.pending.get(value.get('id'))
                if waiter:
                    # The reader must never accumulate unbounded streamed text.
                    try:
                        waiter.put(value, timeout=0.5)
                    except queue.Full:
                        break
        except (OSError, ValueError):
            pass
        finally:
            self.close()

    def _monitor(self):
        while not self.closed.wait(0.25):
            try:
                state.require_available(self.state_dir)
            except (ValueError, OSError):
                self.close()
                return

    def _send(self, value):
        raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        if len(raw) > MAX_LINE:
            raise ValueError('subscription request exceeds size limit')
        with self.lock:
            if self.closed.is_set() or self.process.poll() is not None:
                raise SubscriptionRequestError('subscription worker unavailable', {'category': 'connection_failed'})
            self.process.stdin.write(raw)
            self.process.stdin.flush()

    def call(self, action, provider, data=None, on_chunk=None):
        from ..providers import cancel_watch
        state.require_available(self.state_dir)
        request_id = uuid.uuid4().hex
        waiter = queue.Queue(maxsize=256)
        with self.lock:
            if self.closed.is_set():
                raise SubscriptionRequestError('subscription worker unavailable', {'category': 'connection_failed'})
            self.pending[request_id] = waiter
        completed = False
        try:
            self._send({'id': request_id, 'action': action, 'provider': provider, 'data': data or {}})
            deadline = time.monotonic() + (610 if action == 'generate' else 125)
            while True:
                state.require_available(self.state_dir)
                cancel_watch.raise_if_active()
                if self.closed.is_set():
                    raise SubscriptionRequestError('subscription worker stopped', {'category': 'connection_failed'})
                if time.monotonic() >= deadline:
                    raise SubscriptionRequestError('subscription request timed out', {'category': 'timeout'})
                try:
                    value = waiter.get(timeout=0.2)
                except queue.Empty:
                    continue
                if 'chunk' in value:
                    if on_chunk:
                        on_chunk(value['chunk'])
                    continue
                completed = True
                if value.get('error'):
                    raise SubscriptionRequestError(value['error'], value.get('errorInfo'))
                return value.get('result', {})
        finally:
            if not completed and not self.closed.is_set():
                try:
                    self._send({'action': 'abort', 'target': request_id})
                except (OSError, RuntimeError, SubscriptionRequestError):
                    pass
            with self.lock:
                self.pending.pop(request_id, None)

    def close(self):
        from ...process_runtime import terminate_process_tree, forget_owned_process
        with self.lock:
            if self.closed.is_set():
                return
            self.closed.set()
            try:
                self.process.stdin.close()
            except OSError:
                pass
        # Only this worker's process object can be terminated, never other clients.
        try:
            terminate_process_tree(self.process, grace=0.5)
        finally:
            forget_owned_process(self.process)
            try:
                self.process.stdout.close()
            except OSError:
                pass


def call(state_dir, action, provider, data=None, on_chunk=None, *, start=True):
    state.require_available(state_dir)
    key = str(Path(state_dir).absolute())
    with _LOCK:
        worker = _WORKERS.get(key)
        if worker is not None and worker.closed.is_set():
            _WORKERS.pop(key, None)
            worker = None
        if worker is None:
            if not start:
                return {}
            worker = _WORKERS[key] = Worker(state_dir)
    return worker.call(action, provider, data, on_chunk)


def shutdown(state_dir):
    key = str(Path(state_dir).absolute())
    with _LOCK:
        worker = _WORKERS.pop(key, None)
    if worker:
        worker.close()


def running(state_dir):
    with _LOCK:
        worker = _WORKERS.get(str(Path(state_dir).absolute()))
        return bool(worker and not worker.closed.is_set())
