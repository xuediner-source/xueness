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
    for worker, _ in workers:
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            break
        try:
            worker.wait(timeout=remaining)
        except TimeoutError:
            pass
        except Exception:
            # Host group/Job Object termination is the final cleanup boundary.
            pass
