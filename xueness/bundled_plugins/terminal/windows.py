"""Real Windows ConPTY terminals, backed by the bundled pywinpty runtime."""
import base64
import os
import re
import subprocess
import threading
import time
import uuid
from .shells import resolve_shell


class WindowsTerminal:
    def __init__(self, root, session_id, shell=None):
        from winpty import PtyProcess
        from winpty.enums import Backend
        self.shell = resolve_shell(shell)
        argv = [self.shell]
        if self.shell.lower().endswith(('powershell.exe', 'pwsh.exe')):
            argv.extend(['-NoLogo', '-NoProfile'])
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
        self.win32_input = False
        self.input_mode_tail = ''
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
                    self._observe_input_mode(chunk)
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

    def _observe_input_mode(self, chunk):
        """Track ConPTY's requested key protocol across split output chunks."""
        text = self.input_mode_tail + chunk
        for match in re.finditer(r'\x1b\[\?([0-9;]{1,48})([hl])|\x1bc', text):
            if match.group(1) is None:
                self.win32_input = False
            elif any(int(p) == 9001 for p in match.group(1).split(';') if p):
                self.win32_input = match.group(2) == 'h'
        self.input_mode_tail = text[-64:]

    def write(self, text):
        if not isinstance(text, str) or len(text.encode()) > 65536:
            raise ValueError('terminal input too large')
        with self.write_lock, self.lock:
            if self.closed:
                raise ValueError('terminal is closed')
            self.touched = time.monotonic()
            if text == '\x03' and self.win32_input:
                # ConPTY mode 9001 needs KEY_EVENT_RECORD-style input for Ctrl+C.
                # Keep the modifier down/up events paired so it cannot stay held.
                text = ('\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_'
                        '\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_')
            self.proc.write(text)

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
                try:
                    self.proc.close(force=True)
                except (OSError, ValueError):
                    # pywinpty can fail to terminate a still-live Windows shell.
                    # Only fall back for this terminal's owned process, and never
                    # treat an unsuccessful taskkill as successful cleanup.
                    if self.proc.isalive():
                        from ...process_runtime import run_external
                        env = {k: v for k, v in os.environ.items() if k.upper() in
                               ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC')}
                        run_external(subprocess.run,
                                     ['taskkill.exe', '/PID', str(self.proc.pid), '/T', '/F'],
                                     env=env, capture_output=True, timeout=5, check=False)
                        if self.proc.isalive():
                            raise
                    self.proc.close(force=True)
                self.disposed = True
            finally:
                self.reader.join(timeout=3)
