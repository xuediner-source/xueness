"""Safe session metadata mutations; workspaces and journals are never erased."""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from ...core import Store
from ...session_lease import lease
from ...resources import _is_link, replace_file

MAX_TITLE = 120
TASK_AUTO_ARCHIVE_DAY_OPTIONS = (3, 7, 14, 30)
_READ_STATE_DIR = ".xueness-session-read"
_READ_STATE_LOCKS = {}
_READ_STATE_LOCKS_GUARD = threading.Lock()


def validate_title(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("title must be 1..120 characters")
    title = value.strip()
    if not title or len(title) > MAX_TITLE or any(ord(char) < 32 or ord(char) == 127 for char in title):
        raise ValueError("title must be 1..120 printable characters")
    return title


def _live_path(store: Store, sid: str) -> Path:
    path = store._path(sid)  # validates the identifier before any filesystem access
    if _is_link(path):
        raise ValueError("session file is a symbolic link")
    return path


def _audit(session: dict, action: str, **details: str) -> None:
    session.setdefault("management_history", []).append({
        "action": action, "at": datetime.now(timezone.utc).isoformat(), **details,
    })


def _read_state_lock(store: Store, sid: str):
    key = str(store.directory.resolve()) + "/" + sid
    with _READ_STATE_LOCKS_GUARD:
        lock = _READ_STATE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _READ_STATE_LOCKS[key] = lock
        return lock


def _read_state_path(store: Store, sid: str, *, create: bool = False) -> Path:
    store._path(sid)
    directory = store.directory / _READ_STATE_DIR
    if _is_link(directory):
        raise ValueError("session read state directory is a symbolic link")
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    return directory / f"{sid}.json"


def _load_read_state(store: Store, sid: str) -> dict | None:
    try:
        path = _read_state_path(store, sid)
        if _is_link(path) or not path.is_file():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    through = value.get("readThroughMtimeNs")
    viewed_at = value.get("viewedAt")
    if (type(through) is not int or through < 0
            or type(viewed_at) not in (int, float) or viewed_at < 0):
        return None
    return {"readThroughMtimeNs": through, "viewedAt": float(viewed_at)}


def mark_viewed(store: Store, sid: str) -> None:
    """Record which on-disk revision was visible when a session was opened.

    The watermark is kept outside the journal file so reads do not refresh its
    activity mtime. A later journal write invalidates the read mark until the
    operator opens the new revision.
    """
    with _read_state_lock(store, sid):
        with lease(store, sid):
            source = _live_path(store, sid)
            observed_mtime_ns = source.stat().st_mtime_ns
            now = time.time()
            previous = _load_read_state(store, sid)
            if (previous is not None
                    and previous["readThroughMtimeNs"] == observed_mtime_ns
                    and now - previous["viewedAt"] < 60):
                return
            path = _read_state_path(store, sid, create=True)
            if _is_link(path):
                raise ValueError("session read state is a symbolic link")
            fd, temporary = tempfile.mkstemp(prefix=f".{sid}.", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    if hasattr(os, "fchmod"):
                        os.fchmod(stream.fileno(), 0o600)
                    else:
                        os.chmod(temporary, 0o600)
                    json.dump({"readThroughMtimeNs": observed_mtime_ns, "viewedAt": now}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                replace_file(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)


def _archive_candidate(session: dict, mtime_ns: int, *, cutoff_ns: int,
                       cutoff_seconds: float, read_state: dict | None,
                       running_ids: set[str], sid: str, has_pending) -> bool:
    if sid in running_ids or session.get("status") != "completed":
        return False
    if session.get("pinned") is True or session.get("pending_question"):
        return False
    if has_pending:
        try:
            if has_pending(session):
                return False
        except Exception:
            # A malformed or newly-added pending-action representation must
            # fail closed; history listing itself can still proceed.
            return False
    if mtime_ns > cutoff_ns or read_state is None:
        return False
    if read_state["readThroughMtimeNs"] < mtime_ns:
        return False
    return read_state["viewedAt"] <= cutoff_seconds


def archive_stale(store: Store, older_than_days: int, *, running_ids=(), has_pending=None) -> list[str]:
    """Soft-archive only old completed sessions the operator has actually read.

    Unread, pinned, pending, running, malformed, symlinked, and cross-process
    locked sessions stay live. Every archived session remains restorable.
    """
    if type(older_than_days) is not int or older_than_days not in TASK_AUTO_ARCHIVE_DAY_OPTIONS:
        raise ValueError("invalid task auto-archive retention")
    running = set(running_ids)
    now = time.time()
    cutoff_seconds = now - older_than_days * 24 * 60 * 60
    cutoff_ns = int(cutoff_seconds * 1_000_000_000)
    archived: list[str] = []
    try:
        paths = sorted(store.directory.glob("[0-9a-f]" * 32 + ".json"))
    except OSError:
        return archived
    for source in paths:
        sid = source.stem
        if _is_link(source) or not re.fullmatch(r"[0-9a-f]{32}", sid):
            continue
        try:
            mtime_ns = source.stat().st_mtime_ns
            if mtime_ns > cutoff_ns:
                continue
            session = store.load(sid)
            read_state = _load_read_state(store, sid)
            if not _archive_candidate(session, mtime_ns, cutoff_ns=cutoff_ns,
                                      cutoff_seconds=cutoff_seconds, read_state=read_state,
                                      running_ids=running, sid=sid, has_pending=has_pending):
                continue
            with lease(store, sid):
                # Re-read mutable state under the cross-process lease before moving.
                current = store._path(sid)
                mtime_ns = current.stat().st_mtime_ns
                session = store.load(sid)
                read_state = _load_read_state(store, sid)
                if not _archive_candidate(session, mtime_ns, cutoff_ns=cutoff_ns,
                                          cutoff_seconds=cutoff_seconds, read_state=read_state,
                                          running_ids=running, sid=sid, has_pending=has_pending):
                    continue
                archive(store, sid)
                archived.append(sid)
                marker = _read_state_path(store, sid)
                if not _is_link(marker):
                    marker.unlink(missing_ok=True)
        except (BlockingIOError, FileExistsError, FileNotFoundError, OSError, ValueError,
                json.JSONDecodeError):
            continue
    return archived


def rename(store: Store, sid: str, title: str) -> dict:
    _live_path(store, sid)
    session = store.load(sid)
    old_title = session.get("title") or session["task"]
    if old_title != title:
        _audit(session, "renamed", previous_title=old_title, title=title)
        session["title"] = title
        store.save(session)
    return session


def list_summaries(store: Store) -> list[dict]:
    summaries = store.list()
    for summary in summaries:
        session = store.load(summary["id"])
        summary["title"] = session.get("title") or session["task"]
        summary["pinned"] = session.get("pinned") is True
        summary["root"] = session.get("root", "")
        summary["updatedAt"] = datetime.fromtimestamp(
            store._path(summary["id"]).stat().st_mtime, timezone.utc
        ).isoformat()
    return summaries


def archive(store: Store, sid: str) -> dict:
    """Hide the session from active history without deleting its audit or workspace.

    The archive is outside Store.list's live glob. The caller must hold the
    context lock, session lease, and reject running sessions before invoking
    this function. The queue lock serializes the move and sidecar deletion with
    concurrent enqueue requests.
    """
    from .queue import MessageQueue

    queue = MessageQueue(store)
    with queue.session_lock(sid):
        source = _live_path(store, sid)
        session = store.load(sid)
        archive_dir = store.directory / "deleted-sessions"
        if _is_link(archive_dir):
            raise ValueError("archive directory is a symbolic link")
        archive_dir.mkdir(mode=0o700, exist_ok=True)
        destination = archive_dir / source.name
        if destination.exists() or _is_link(destination):
            raise FileExistsError("session archive already exists")
        # Validate the sidecar before changing the session journal. A malformed
        # or redirected entry must not be followed or silently orphaned.
        queue._check_discardable_locked(sid)
        _audit(session, "deleted")
        # Save the audit before the atomic move; neither the workspace nor the
        # archived JSON is removed. A move error leaves the live session intact.
        store.save(session)
        os.rename(source, destination)
        try:
            queue._discard_locked(sid)
        except (OSError, ValueError):
            # Keep the queue and live session paired if sidecar removal fails.
            try:
                os.rename(destination, source)
            except OSError as rollback_error:
                raise OSError("queue cleanup failed and session archive rollback failed") from rollback_error
            raise
    # A later restore starts a fresh retention period. Do not let a stale
    # pre-archive read watermark make the restored task disappear immediately.
    try:
        marker = _read_state_path(store, sid)
        if not _is_link(marker):
            marker.unlink(missing_ok=True)
    except (OSError, ValueError):
        # Read markers are auxiliary. Never turn a completed atomic archive
        # into a reported failure because its best-effort cleanup failed.
        pass
    return session


def pin(store: Store, sid: str, pinned: bool) -> dict:
    """Toggle the sidebar pin flag on a live session; both directions are audited."""
    _live_path(store, sid)
    session = store.load(sid)
    session["pinned"] = bool(pinned)
    _audit(session, "pinned" if pinned else "unpinned")
    store.save(session)
    return session


def list_archived(store: Store) -> list[dict]:
    """Summarize archived sessions, newest archive first, capped at 200.

    The archive directory is operator-facing disk state, so every entry is
    treated as untrusted: symlinks, non-session names and unparsable JSON are
    skipped rather than raised over.
    """
    archive_dir = store.directory / "deleted-sessions"
    if _is_link(archive_dir) or not archive_dir.exists():
        return []
    entries: list[dict] = []
    for path in sorted(archive_dir.glob("*.json")):
        if _is_link(path):
            continue
        stem = path.stem
        if not re.fullmatch(r"[0-9a-f]{32}", stem):
            continue
        try:
            session = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(session, dict):
            continue
        archived_at = None
        for record in session.get("management_history") or []:
            if isinstance(record, dict) and record.get("action") == "deleted" and isinstance(record.get("at"), str):
                archived_at = record["at"]
        if archived_at is None:
            try:
                archived_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            except OSError:
                continue
        entries.append({
            "id": stem,
            "task": session.get("task", ""),
            "title": session.get("title") or session.get("task", ""),
            "archivedAt": archived_at,
        })
    # ISO timestamps in one timezone sort lexicographically by instant.
    entries.sort(key=lambda entry: entry["archivedAt"], reverse=True)
    return entries[:200]


def restore(store: Store, sid: str) -> dict:
    """Move an archived session back into the live list, keeping its audit."""
    try:
        live = store._path(sid)  # validates the identifier before any filesystem access
    except ValueError as exc:
        raise ValueError("invalid session id") from exc
    archive_dir = store.directory / "deleted-sessions"
    if _is_link(archive_dir):
        raise ValueError("archive directory is a symbolic link or reparse point")
    source = archive_dir / live.name
    if _is_link(source) or not source.exists():
        raise ValueError("session is not archived")
    if live.exists() or _is_link(live):
        raise ValueError("a live session with this id already exists")
    session = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(session, dict) or session.get("id") != sid:
        raise ValueError("invalid archived session identity")
    _audit(session, "restored")
    # Write the audit back into the archived copy before the atomic move, so
    # the record survives a crash between the two steps. The archive directory
    # doubles as a Store here to reuse the atomic tmp+replace write.
    Store(archive_dir).save(session)
    os.rename(source, live)
    return session
