"""Private parent pipe for window-owned dialogs; no renderer-supplied paths."""
import json
import queue
import threading
import uuid


class DesktopBridge:
    def __init__(self, output):
        self.output, self.pending = output, {}
        self.lock = threading.Lock()
        self.closed = False

    def send(self, message):
        with self.lock:
            self.output.write(json.dumps(message, ensure_ascii=False)+'\n')
            self.output.flush()

    def choose_directory(self, initial_root=None):
        response = queue.Queue(maxsize=1)
        request_id = uuid.uuid4().hex
        with self.lock:
            if self.closed:
                raise RuntimeError('desktop host disconnected')
            self.pending[request_id] = response
        try:
            self.send({'type': 'dialog', 'id': request_id, 'initialRoot': initial_root})
            result = response.get(timeout=600)
            if result.get('error'):
                raise RuntimeError('desktop directory picker failed')
            value = result.get('path')
            if value is not None and (not isinstance(value, str) or len(value) > 4096):
                raise RuntimeError('invalid desktop directory selection')
            return value
        except queue.Empty:
            raise RuntimeError('desktop directory picker timed out') from None
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def receive(self, message):
        with self.lock:
            target = self.pending.get(message.get('id'))
            if target is not None and target.empty():
                target.put_nowait(message)

    def close(self):
        with self.lock:
            self.closed = True
            for target in self.pending.values():
                if target.empty():
                    target.put_nowait({'error': 'disconnected'})
