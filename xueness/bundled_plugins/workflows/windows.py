"""Windows pipe streaming and owned command-tree cancellation."""
import os
import queue
import subprocess
import threading
import time
from ...process_runtime import spawn_external, run_external


def terminate_tree(proc):
    if proc.poll() is None:
        run_external(subprocess.run, ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=8,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)


def execute_command(store, record, spec, cwd, logpath, env, start):
    # Windows selectors only handle sockets. A bounded reader queue drains a
    # real pipe while the owner independently observes cancel and timeout.
    env = {**env, **{k: v for k, v in os.environ.items()
                    if k.upper() in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')}}
    proc = spawn_external(subprocess.Popen, spec['argv'], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    store.update(record['id'], lambda r: r['nodes'][spec['id']].update(pid=proc.pid))
    chunks = queue.Queue(maxsize=32)
    stopped = threading.Event()

    def put(chunk):
        while not stopped.is_set():
            try:
                chunks.put(chunk, timeout=.1)
                return
            except queue.Full:
                pass

    def read():
        try:
            while not stopped.is_set():
                chunk = proc.stdout.read1(8192)
                if not chunk:
                    break
                put(chunk)
        finally:
            put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reason, total, exited_at = None, 0, None
    try:
        with logpath.open('wb') as stream:
            while True:
                if store.load(record['id'])['control'] == 'cancel':
                    reason = 'cancelled'
                    break
                if time.monotonic() - start >= spec['timeout']:
                    reason = 'timeout'
                    break
                try:
                    chunk = chunks.get(timeout=.05)
                except queue.Empty:
                    if proc.poll() is not None:
                        exited_at = exited_at or time.monotonic()
                        if time.monotonic()-exited_at > .5:
                            break
                    continue
                if chunk is None:
                    break
                if total < 2_000_000:
                    stream.write(chunk[:2_000_000-total])
                    stream.flush()
                total += len(chunk)
        if reason:
            terminate_tree(proc)
        else:
            proc.wait(timeout=2)
        return {'status': 'cancelled' if reason == 'cancelled' else
                'completed' if not reason and proc.returncode == 0 else 'failed',
                'exit_code': proc.returncode, 'error': reason or '',
                'duration': time.monotonic()-start, 'log_capped': total > 2_000_000}
    finally:
        stopped.set()
        terminate_tree(proc)
        reader.join(timeout=3)
        proc.stdout.close()
