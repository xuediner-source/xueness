"""Windows pipe streaming and owned command-tree cancellation."""
import queue
import subprocess
import threading
import time
from ...process_runtime import spawn_external


def terminate_tree(proc):
    from ...process_runtime import terminate_process_tree
    terminate_process_tree(proc, grace=2.0)


def execute_command(store, record, spec, cwd, logpath, env, start):
    # Windows selectors only handle sockets. A bounded reader queue drains a
    # real pipe while the owner independently observes cancel and timeout.
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

    reader = None
    reason, total, exited_at = None, 0, None
    proc = spawn_external(subprocess.Popen, spec['argv'], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        # A failed PID write still owns this process and must clean it up.
        store.update(record['id'], lambda r: r['nodes'][spec['id']].update(pid=proc.pid))
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
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
        try:
            terminate_tree(proc)
        finally:
            if reader is not None and reader.ident is not None:
                reader.join(timeout=3)
            proc.stdout.close()
