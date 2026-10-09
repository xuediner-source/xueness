"""Real Windows ConPTY terminals, backed by the bundled pywinpty runtime."""
import base64
import os
from pathlib import Path
import sys
import threading
import time
import uuid
from .shells import resolve_shell


class WindowsTerminal:
    def __init__(self, root, session_id, shell=None):
        from winpty import PtyProcess
        from winpty.enums import Backend
        self.shell = resolve_shell(shell)
        argv = ([sys.executable, '--worker', 'terminal-shell', self.shell]
                if getattr(sys, 'frozen', False) else
                [sys.executable, str(Path(__file__).with_name('windows_shell.py')), self.shell])
        env = {k: v for k, v in os.environ.items() if k.upper() in
               ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
                'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')}
        from ...process_runtime import spawn_external
        self.proc = spawn_external(PtyProcess.spawn, argv, cwd=str(root),
                                     dimensions=(28, 100), backend=Backend.ConPTY, env=env)
        self.id, self.session_id = uuid.uuid4().hex, session_id
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.close_lock = threading.Lock()
        self.disposed = False
        self.buffer, self.offset = bytearray(), 0
        self.touched, self.closed = time.monotonic(), False
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            while not self.closed:
                chunk = self.proc.read(8192)
                if not chunk:
                    if not self.proc.isalive():
                        break
                    time.sleep(.03)
                    continue
                with self.lock:
                    self.buffer.extend(chunk.encode('utf-8', 'replace'))
                    excess = max(0, len(self.buffer)-1_000_000)
                    if excess:
                        del self.buffer[:excess]
                        self.offset += excess
        except (OSError, EOFError):
            pass
        finally:
            with self.lock:
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
        with self.write_lock, self.close_lock, self.lock:
            if self.closed:
                raise ValueError('terminal is closed')
            self.touched = time.monotonic()
            self.proc.write(text)
            if text == '\x03' and self.proc.isalive():
                from .windows_interrupt import interrupt
                interrupt(self.proc.pid)

    def resize(self, cols, rows):
        if type(cols) is not int or type(rows) is not int or not 10 <= cols <= 500 or not 2 <= rows <= 200:
            raise ValueError('invalid terminal dimensions')
        with self.lock:
            if not self.closed:
                self.proc.setwinsize(rows, cols)

    def close(self):
        # Reader EOF is different from disposing the ConPTY resources. Serialize
        # explicit/broker shutdown so repeated closes cannot race the sockets.
        with self.close_lock:
            if self.disposed:
                return
            with self.lock:
                self.closed = True
            try:
                # The ConPTY root is our launcher; terminate its owned tree
                # before pywinpty can kill only the launcher and orphan its shell.
                if self.proc.isalive():
                    from ...process_runtime import signal_process_tree
                    signal_process_tree(self.proc.pid)
                    # Windows termination is asynchronous. taskkill returning
                    # does not prove that the owned process handle is signaled.
                    deadline = time.monotonic() + 2
                    while self.proc.isalive():
                        if time.monotonic() >= deadline:
                            raise OSError('the owned terminal process did not exit')
                        time.sleep(.05)
                # pywinpty.isalive() sets its closed flag on process exit,
                # although the reader/listener sockets still need disposal.
                self.proc.closed = False
                try:
                    self.proc.close(force=True)
                except (OSError, ValueError):
                    if self.proc.isalive():
                        raise
                    self.proc.closed = False
                    self.proc.close(force=True)
                self.disposed = True
            finally:
                self.reader.join(timeout=3)
