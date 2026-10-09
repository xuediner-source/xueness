"""Per-path write locks: one writer per resolved path, shared by all mutators.

Why this exists: two sessions can run at once (the web layer only serialises
*writes to one session*, not across sessions), and the workspace is shared. Two
``write`` calls aimed at ``notes.md`` -- one through a relative path, one through
a symlinked directory -- used to race with nothing between them. The last write
won, silently, and the loser's tool result still said ``ok``.

The lock key is the **resolved absolute path**, so ``a/../notes.md``,
``./notes.md`` and a symlink that lands on ``notes.md`` all contend for the same
lock. Windows and macOS compare that key without case, because those file
systems do. Linux keeps the case. The key is fixed when the lock is acquired,
so a later symlink swap cannot drop a different path. Anything coarser
(per-session, per-run) would not catch the shared file.

Scope and limits, stated plainly:

* In-process only. A second ``xueness`` process, or a shell command the agent
  runs itself, is not covered. This closes the tool-level race; it is not a
  filesystem lock and must not be described as one.
* Reentrant per owner: one run writing the same file twice is normal and must
  not deadlock against itself.
* Held for the duration of the write, released in ``finally`` -- a raising
  handler cannot strand a lock.
"""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path


def _fold_host_path(text: str) -> str:
    """Match filesystem identity: case-insensitive on Windows and macOS."""
    if os.name == "nt":
        return os.path.normcase(text)
    if sys.platform == "darwin":
        return text.casefold()
    return text


class WriteLocks:
    """A registry of resolved-path -> owner, guarded by one process-wide lock.

    ``owner`` is any stable identifier for the writer; sessions use their id.
    """

    def __init__(self):
        self._guard = threading.Lock()
        #: resolved path string -> set of owners currently holding it
        self._holders: dict[str, set] = {}
        #: (owner, stable spelling) -> key captured at acquire time
        self._acquired: dict[tuple, str] = {}

    def _key(self, path) -> str:
        """Resolved absolute path, so every spelling of one file maps to one key."""
        return _fold_host_path(os.path.normpath(str(Path(path).resolve())))

    def _stable(self, path) -> str:
        """Spelling identity that does not follow symlinks, for the acquire pin."""
        return _fold_host_path(os.path.normpath(os.path.abspath(os.fspath(path))))

    def acquire(self, path, owner) -> bool:
        """Take the lock, or report that someone else holds it.

        Re-acquiring as the same owner always succeeds: a run that writes a file
        twice is not a conflict with itself.
        """
        key = self._key(path)
        stable = self._stable(path)
        with self._guard:
            holders = self._holders.setdefault(key, set())
            if holders and owner not in holders:
                return False
            holders.add(owner)
            self._acquired[(owner, stable)] = key
            return True

    def release(self, path, owner) -> None:
        """Drop this owner's hold; a no-op when it held nothing."""
        stable = self._stable(path)
        with self._guard:
            key = self._acquired.pop((owner, stable), None)
            if key is None:
                key = self._key(path)
            holders = self._holders.get(key)
            if not holders:
                return
            holders.discard(owner)
            if not holders:
                # Remove the entry entirely so the map cannot grow without bound.
                self._holders.pop(key, None)
                stale = [pin for pin, held in self._acquired.items() if held == key]
                for pin in stale:
                    self._acquired.pop(pin, None)

    def holder(self, path):
        """One current holder, or ``None``. Diagnostics and tests only."""
        key = self._key(path)
        with self._guard:
            holders = self._holders.get(key)
            if not holders:
                return None
            return sorted(holders)[0]

    def clear(self) -> None:
        """Drop every lock. For tests and shutdown; not a normal code path."""
        with self._guard:
            self._holders.clear()
            self._acquired.clear()


#: Process-wide locks for the builtin write/edit tools.
DEFAULT_LOCKS = WriteLocks()


def owner_for(session) -> str:
    """Stable lock owner for a session dict.

    Falls back to a fixed name when a caller passes no session (direct
    ``execute()`` calls in tests), which keeps those calls serialising against
    each other rather than escaping the lock entirely.
    """
    if isinstance(session, dict):
        sid = session.get("id")
        if isinstance(sid, str) and sid:
            return sid
    return "anonymous"
