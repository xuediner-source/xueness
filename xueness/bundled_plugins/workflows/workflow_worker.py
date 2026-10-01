"""Detached owner for local workflows; controls persist independently of the UI."""
import sys
from ...workflows import WorkflowStore, drive

if __name__ == '__main__':
    store = WorkflowStore(sys.argv[1])
    wid = sys.argv[2]
    try:
        drive(store, wid)
    except Exception:
        store.update(wid, lambda r: r.update(status='interrupted'))
        raise
