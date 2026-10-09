"""Track only workflow workers launched by this desktop host.

CLI workers in the same state directory are deliberately outside this set.
POSIX workers also detect parent loss, including a host that was force killed.
"""
import os
import threading
import time

_workers = {}
_lock = threading.Lock()


def owner_gone():
    owner = os.environ.get('XUENESS_DESKTOP_OWNER_PID')
    return os.name != 'nt' and bool(owner) and str(os.getppid()) != owner


def register(worker, store, wid):
    if not os.environ.get('XUENESS_DESKTOP_HOST'):
        threading.Thread(target=worker.wait, daemon=True).start()
        return
    with _lock:
        _workers[worker] = (store, wid)
    def reap():
        worker.wait()
        with _lock:
            _workers.pop(worker, None)
    threading.Thread(target=reap, daemon=True).start()


def _stop_recorded_commands(store, wid):
    """Stop command sessions this host's worker still has marked running."""
    try:
        record = store.load(wid)
    except (OSError, ValueError):
        return
    nodes = record.get('nodes') if isinstance(record, dict) else None
    if not isinstance(nodes, dict):
        return
    from ...process_runtime import terminate_pid
    for node in nodes.values():
        if not isinstance(node, dict) or node.get('status') != 'running':
            continue
        pid = node.get('pid')
        if isinstance(pid, int) and 1 < pid < 2**32 and pid != os.getpid():
            # POSIX commands are session leaders. Windows taskkill /T follows
            # the process tree from that pid.
            terminate_pid(pid, group=os.name != 'nt', grace=0.5)


def shutdown():
    with _lock:
        workers = list(_workers.items())
    for worker, (store, wid) in workers:
        if worker.poll() is None:
            try:
                store.control(wid, 'cancel')
            except (OSError, ValueError):
                pass
    deadline = time.monotonic()+2
    for worker, (store, wid) in workers:
        remaining = deadline-time.monotonic()
        if remaining > 0:
            try:
                worker.wait(timeout=remaining)
            except TimeoutError:
                pass
            except Exception:
                # A stuck worker is force-stopped below; do not skip the others.
                pass
        # Read command pids before killing the worker so a SIGKILL cannot
        # orphan session-leader grandchildren.
        try:
            _stop_recorded_commands(store, wid)
        except (OSError, ValueError):
            pass
        if worker.poll() is None:
            from ...process_runtime import terminate_process_tree
            try:
                terminate_process_tree(worker, group=False, grace=1.0)
            except (OSError, ValueError):
                pass
