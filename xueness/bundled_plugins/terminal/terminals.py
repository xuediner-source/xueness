"""Bounded local PTY broker. Every shell is explicitly opened by its operator."""
import base64
import os
from pathlib import Path
import signal
import select
import struct
import subprocess
import sys
import threading
import time
import uuid
from .shells import available_shells, resolve_shell

if os.name != 'nt':
    import fcntl
    import pty
    import termios


class Terminal:
    def __init__(self, root, session_id, shell=None):
        self.shell = resolve_shell(shell)
        self.id, self.session_id = uuid.uuid4().hex, session_id
        self.lock = threading.RLock()
        self.buffer, self.offset = bytearray(), 0
        self.touched = time.monotonic()
        self.master, slave = pty.openpty()
        self.closed = False
        self.write_lock = threading.Lock()
        os.set_blocking(self.master, False)
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL')}
        env['TERM'] = 'xterm-256color'
        try:
            worker_argv = ([sys.executable, '--worker', 'terminal', self.shell]
                           if getattr(sys, 'frozen', False) else
                           [sys.executable, str(Path(__file__).with_name('terminal_worker.py')), self.shell])
            self.proc = subprocess.Popen(worker_argv,
                                         cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave,
                                         start_new_session=True)
        except Exception:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        self.resize(100, 28)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            while True:
                if not select.select([self.master], [], [], .2)[0]:
                    if self.proc.poll() is not None:
                        break
                    continue
                try:
                    chunk = os.read(self.master, 8192)
                except BlockingIOError:
                    continue
                if not chunk:
                    break
                with self.lock:
                    self.buffer.extend(chunk)
                    excess = max(0, len(self.buffer)-1_000_000)
                    if excess:
                        del self.buffer[:excess]
                        self.offset += excess
        except OSError:
            pass
        finally:
            try:
                os.killpg(self.proc.pid, signal.SIGHUP)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)
            with self.lock:
                if not self.closed:
                    os.close(self.master)
                    self.closed = True

    def read(self, cursor):
        with self.lock:
            self.touched = time.monotonic()
            start = min(max(cursor-self.offset, 0), len(self.buffer))
            data = bytes(self.buffer[start:start+65536])
            return {'id': self.id, 'session_id': self.session_id,
                    'data': base64.b64encode(data).decode(), 'cursor': self.offset+start+len(data),
                    'truncated': cursor < self.offset, 'closed': self.closed}

    def write(self, text):
        if not isinstance(text, str) or len(text.encode()) > 65536:
            raise ValueError('terminal input too large')
        with self.write_lock:
            payload = memoryview(text.encode())
            deadline = time.monotonic() + 2
            while payload:
                with self.lock:
                    if self.closed:
                        raise ValueError('terminal is closed')
                    self.touched = time.monotonic()
                    try:
                        count = os.write(self.master, payload)
                    except BlockingIOError:
                        count = 0
                payload = payload[count:]
                if payload:
                    if time.monotonic() >= deadline:
                        raise ValueError('terminal input backpressure; input may be partially delivered')
                    time.sleep(.01)

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 10 <= cols <= 500 or not 2 <= rows <= 200:
            raise ValueError('invalid terminal dimensions')
        with self.lock:
            if not self.closed:
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def close(self):
        with self.lock:
            if self.closed:
                return
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            self.proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            self.proc.wait(timeout=2)
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        self.reader.join(timeout=2)


class Broker:
    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def open(self, root, session_id, shell=None):
        with self.lock:
            for tid, term in list(self.items.items()):
                if term.closed or time.monotonic()-term.touched > 1800:
                    term.close()
                    del self.items[tid]
            if len(self.items) >= 4:
                raise ValueError('at most four terminals may be open')
            if os.name == 'nt':
                from .windows import WindowsTerminal
                term = WindowsTerminal(root, session_id, shell)
            else:
                term = Terminal(root, session_id, shell)
            self.items[term.id] = term
            return term

    def close(self):
        with self.lock:
            for term in self.items.values():
                term.close()
            self.items.clear()


def dispatch(method, parts, query, data, ctx):
    if parts[:2] != ['api', 'terminals']:
        return None
    from ...web import _allowed_root
    broker = ctx['terminals']
    try:
        if parts == ['api', 'terminals', 'shells'] and method == 'GET':
            return 200, {'shells': available_shells()}
        if len(parts) == 2:
            if method == 'POST':
                if data.get('open') is not True:
                    raise ValueError('explicit shell opening is required')
                session = ctx['store'].load(data.get('session_id'))
                from ..settings.workspaces_api import allowed_roots
                root = _allowed_root(Path(session['root']), ctx['web_runs'], ctx['project_dir'], allowed_roots(ctx))
                from ..settings.settings_store import load_settings
                shell = load_settings(ctx['state_dir']).get('general', {}).get('defaultShell')
                term = broker.open(root, session['id'], shell)
                return 200, {'id': term.id, 'session_id': session['id']}
            if method == 'GET':
                with broker.lock:
                    return 200, {'terminals': [{'id': t.id, 'session_id': t.session_id, 'closed': t.closed} for t in broker.items.values()]}
        term = broker.items.get(parts[2]) if len(parts) >= 3 else None
        if term is None:
            return 404, {'error': 'terminal not found'}
        if method == 'GET' and len(parts) == 3:
            cursor = int(query.get('cursor', ['0'])[0])
            if cursor < 0:
                raise ValueError('invalid cursor')
            return 200, term.read(cursor)
        if method == 'POST' and len(parts) == 4:
            if parts[3] == 'input':
                term.write(data.get('text'))
            elif parts[3] == 'resize':
                term.resize(data.get('cols'), data.get('rows'))
            elif parts[3] == 'close':
                term.close()
            else:
                return 404, {'error': 'terminal operation not found'}
            return 200, {'ok': True}
        return 405, {'error': 'method not allowed'}
    except (OSError, ValueError, TypeError):
        return 400, {'error': 'invalid terminal operation or unavailable workspace'}
