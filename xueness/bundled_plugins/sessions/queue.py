"""Durable, bounded FIFO for user messages submitted while a session is running.

Queue records live beside the session store in their own atomic files. A chat
request can therefore enqueue or cancel a future turn without rewriting the
session journal while the active model stream is saving it.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import uuid

from ... import file_lock
from ...resources import _protect_private_file, replace_file


SCHEMA = 1
MAX_PENDING_ITEMS = 20
MAX_ITEM_BYTES = 6 * 1024 * 1024
MAX_PENDING_BYTES = 12 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
HISTORY_LIMIT = 40
HISTORY_PREVIEW_CHARS = 500
ACTIVE_STATUSES = frozenset({"queued", "running", "paused"})
FINAL_STATUSES = frozenset({"completed", "needs_review", "failed", "cancelled"})
VALID_STATUSES = ACTIVE_STATUSES | FINAL_STATUSES
_SESSION_ID = re.compile(r"[0-9a-f]{32}\Z")
_QUEUE_ID = re.compile(r"[0-9a-f]{32}\Z")
_REPARSE_POINT = 0x400
_THREAD_LOCKS = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class QueueConflict(ValueError):
    """The queue item changed state before the requested operation."""


class MessageQueue:
    def __init__(self, store, lock=None):
        self.store = store
        self.directory = Path(store.directory) / "session-message-queues"
        # ctx.lock is a plain, non-reentrant Lock in production. Queue methods
        # use their own shared per-path RLock plus an OS file lock, so callers
        # never deadlock by wrapping snapshot()/cancel() in ctx.lock.
        lock_key = os.path.normcase(os.path.abspath(str(self.directory / ".locks")))
        with _THREAD_LOCKS_GUARD:
            self.lock = _THREAD_LOCKS.setdefault(lock_key, threading.RLock())

    @staticmethod
    def _is_reparse(path):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
        return (stat.S_ISLNK(info.st_mode)
                or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT))

    @classmethod
    def _check_directory(cls, path):
        if cls._is_reparse(path):
            raise ValueError("message queue path is a reparse point")
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("message queue path is not a directory")

    def _path(self, session_id):
        if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
            raise ValueError("invalid session id")
        return self.directory / (session_id + ".json")

    def _ensure_directory(self):
        self._check_directory(self.directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._check_directory(self.directory)
        locks = self.directory / ".locks"
        self._check_directory(locks)
        locks.mkdir(mode=0o700, exist_ok=True)
        self._check_directory(locks)

    @contextmanager
    def _locked(self, session_id):
        self._path(session_id)  # validate before deriving a lock path
        lock_path = self.directory / ".locks" / (session_id + ".lock")
        with self.lock:
            self._ensure_directory()
            if self._is_reparse(lock_path):
                raise ValueError("invalid message queue lock")
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
            flags |= getattr(os, "O_BINARY", 0)
            fd = os.open(lock_path, flags, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or self._is_reparse(lock_path):
                    raise ValueError("invalid message queue lock")
                file_lock.flock(fd, file_lock.LOCK_EX)
                yield
            finally:
                os.close(fd)

    @contextmanager
    def session_lock(self, session_id):
        """Serialize all queue-file changes for one session across processes."""
        with self._locked(session_id):
            yield

    def _read(self, session_id):
        path = self._path(session_id)
        self._check_directory(self.directory)
        try:
            info = path.lstat()
        except FileNotFoundError:
            return {"schema": SCHEMA, "items": []}
        if self._is_reparse(path) or not stat.S_ISREG(info.st_mode):
            raise ValueError("invalid message queue file")
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError("message queue file is too large")
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            fd = os.open(path, flags)
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode):
                    raise ValueError("invalid message queue file")
                raw = stream.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                raise ValueError("message queue file is too large")
            record = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("message queue file is invalid") from exc
        if (not isinstance(record, dict) or record.get("schema") != SCHEMA
                or type(record.get("accepting", False)) is not bool
                or not isinstance(record.get("items"), list)):
            raise ValueError("message queue file is invalid")
        items = record["items"]
        if len(items) > MAX_PENDING_ITEMS + HISTORY_LIMIT:
            raise ValueError("message queue has too many records")
        ids = set()
        for item in items:
            if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                    or not _QUEUE_ID.fullmatch(item["id"]) or item["id"] in ids
                    or item.get("status") not in VALID_STATUSES
                    or not isinstance(item.get("text"), str)):
                raise ValueError("message queue item is invalid")
            ids.add(item["id"])
            if len(item["text"].encode("utf-8")) > MAX_ITEM_BYTES:
                raise ValueError("message queue item is too large")
            prepared = item.get("prepared")
            if prepared is not None and not isinstance(prepared, dict):
                raise ValueError("message queue context is invalid")
        return {"schema": SCHEMA, "accepting": record.get("accepting", False), "items": items}

    def _atomic_save(self, session_id, record):
        self._ensure_directory()
        path = self._path(session_id)
        if self._is_reparse(path):
            raise ValueError("invalid message queue file")
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise ValueError("message queue is full")
        fd, temporary = tempfile.mkstemp(prefix=".queue-", dir=str(self.directory))
        try:
            # Queue contents include raw user prompts and prepared context.
            # Apply the private-file ACL to the already-open temp file before
            # writing any of those bytes; a failure leaves the previous queue
            # record intact and the empty temporary file is cleaned below.
            _protect_private_file(fd)
            stream = os.fdopen(fd, "wb")
            fd = None
            with stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            replace_file(temporary, path)
        finally:
            if fd is not None:
                os.close(fd)
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _trim_history(items):
        active = []
        history = []
        for item in items:
            if item["status"] in ACTIVE_STATUSES:
                active.append(item)
            else:
                history.append(item)
        if len(history) > HISTORY_LIMIT:
            history = history[-HISTORY_LIMIT:]
        return active + history

    @staticmethod
    def _editable_prefix(item):
        prepared = item.get('prepared')
        if not isinstance(prepared, dict):
            return None
        prepared_text = prepared.get('text')
        prefix = prepared.get('edit_prefix')
        if prefix is None and prepared_text == item.get('text'):
            prefix = item.get('text')
        if (not isinstance(prefix, str) or not prefix or len(prefix) > 5000
                or prefix != item.get('text') or not isinstance(prepared_text, str)
                or not prepared_text.startswith(prefix)):
            return None
        return prefix

    @staticmethod
    def _public_item(item, position=None):
        public = {key: item[key] for key in ("id", "text", "status", "created_at", "updated_at")
                  if key in item}
        prepared = item.get('prepared')
        public['editable'] = item.get('status') in ('queued', 'paused') and (
            prepared is None or MessageQueue._editable_prefix(item) is not None)
        if position is not None:
            public["position"] = position
        if isinstance(item.get("pause_reason"), str):
            public["pause_reason"] = item["pause_reason"][:500]
        completion = item.get("completion")
        if isinstance(completion, dict):
            public["completion"] = {
                key: completion[key] for key in (
                    "status", "verified", "tool_execution_status", "delivery_status")
                if key in completion
            }
        return public

    def snapshot(self, session_id):
        with self._locked(session_id):
            return self._snapshot_locked(session_id)

    def _snapshot_locked(self, session_id):
        items = self._read(session_id)["items"]
        active = [item for item in items if item["status"] in ACTIVE_STATUSES]
        history = [item for item in items if item["status"] in FINAL_STATUSES]
        queued_position = 0
        pending = []
        for item in active:
            if item["status"] in ("queued", "paused"):
                queued_position += 1
                pending.append(self._public_item(item, queued_position))
            else:
                pending.append(self._public_item(item, 0))
        return {
            "queued_messages": pending,
            "queue_history": [self._public_item(item) for item in history[-HISTORY_LIMIT:]],
        }

    def enqueue(self, session_id, text, prepared=None, *, active_run=False):
        if not isinstance(text, str) or not text.strip():
            raise ValueError("message must contain text")
        size = len(text.encode("utf-8"))
        prepared_text = prepared.get("text") if isinstance(prepared, dict) else None
        if prepared_text is not None:
            if not isinstance(prepared_text, str):
                raise ValueError("prepared input is invalid")
            size += len(prepared_text.encode("utf-8"))
        if size > MAX_ITEM_BYTES:
            raise ValueError("queued message is too large")
        if prepared is not None:
            try:
                json.dumps(prepared, ensure_ascii=False)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError("prepared input is invalid") from exc
        with self._locked(session_id):
            return self._enqueue_locked(session_id, text, prepared,
                                        active_run=active_run)

    def _enqueue_locked(self, session_id, text, prepared=None, *, active_run=False):
        record = self._read(session_id)
        items = self._trim_history(record["items"])
        active = [item for item in items if item["status"] in ACTIVE_STATUSES]
        if active_run and not record.get("accepting"):
            # A live worker may already be closing or pausing its FIFO.
            # An enqueue must never reopen it after the worker's last check.
            raise QueueConflict("message queue is closing; retry after the run settles")
        if not record.get("accepting") and not active:
            raise QueueConflict("message queue is not accepting messages")
        if len(active) >= MAX_PENDING_ITEMS:
            raise ValueError("message queue is full")
        pending_size = sum(
            len(item["text"].encode("utf-8"))
            + len((item.get("prepared") or {}).get("text", "").encode("utf-8"))
            for item in active
        )
        size = len(text.encode("utf-8"))
        prepared_text = prepared.get("text") if isinstance(prepared, dict) else None
        if prepared_text is not None:
            size += len(prepared_text.encode("utf-8"))
        if pending_size + size > MAX_PENDING_BYTES:
            raise ValueError("message queue is full")
        item = {
            "id": uuid.uuid4().hex,
            "text": text,
            "status": "queued" if record.get('accepting') else "paused",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if prepared is not None:
            item["prepared"] = prepared
        items.insert(len(active), item)
        self._atomic_save(session_id, {"schema": SCHEMA,
                                       "accepting": record.get("accepting", False),
                                       "items": items})
        position = 1 + sum(1 for row in active if row["status"] in ("queued", "paused"))
        return self._public_item(item, position)

    def get(self, session_id, queue_id):
        if not isinstance(queue_id, str) or not _QUEUE_ID.fullmatch(queue_id):
            return None
        with self._locked(session_id):
            return next((item for item in self._read(session_id)["items"]
                         if item["id"] == queue_id), None)

    def claim_next(self, session_id):
        with self._locked(session_id):
            record = self._read(session_id)
            item = next((row for row in record["items"] if row["status"] == "queued"), None)
            if item is None:
                return None
            item["status"] = "running"
            item["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._atomic_save(session_id, record)
            return dict(item)

    def edit(self, session_id, queue_id, text, expected_text, current_queue_id=None):
        with self._locked(session_id):
            return self._edit_locked(session_id, queue_id, text, expected_text, current_queue_id)

    def _edit_locked(self, session_id, queue_id, text, expected_text, current_queue_id=None):
        if not isinstance(queue_id, str) or not _QUEUE_ID.fullmatch(queue_id):
            raise ValueError('invalid queue id')
        if (not isinstance(text, str) or not 1 <= len(text.strip()) <= 5000
                or '\x00' in text or not isinstance(expected_text, str) or len(expected_text) > 5000):
            raise ValueError('message must be 1..5000 characters')
        text = text.strip()
        record = self._read(session_id)
        item = next((row for row in record['items'] if row['id'] == queue_id), None)
        if item is None:
            raise FileNotFoundError('queued message not found')
        if item['status'] not in ('queued', 'paused') or queue_id == current_queue_id:
            raise QueueConflict('queued message is already claimed')
        if item['text'] != expected_text:
            raise QueueConflict('queued message changed; refresh before editing')
        prepared = item.get('prepared')
        updated_prepared = None
        if prepared is not None:
            prefix = self._editable_prefix(item)
            if prefix is None:
                raise QueueConflict('this message needs fresh context preparation; cancel it and send again')
            updated_prepared = {**prepared, 'text': text + prepared['text'][len(prefix):], 'edit_prefix': text}
        replacement_size = len(text.encode('utf-8')) + len((updated_prepared or {}).get('text', '').encode('utf-8'))
        other_size = sum(len(row['text'].encode('utf-8')) + len((row.get('prepared') or {}).get('text', '').encode('utf-8'))
                         for row in record['items'] if row['id'] != queue_id and row['status'] in ACTIVE_STATUSES)
        if replacement_size > MAX_ITEM_BYTES or replacement_size + other_size > MAX_PENDING_BYTES:
            raise ValueError('queued message is too large')
        item['text'] = text
        if updated_prepared is not None:
            item['prepared'] = updated_prepared
        item['updated_at'] = datetime.now(timezone.utc).isoformat()
        self._atomic_save(session_id, record)
        return {'id': queue_id, 'item': self._public_item(item)}

    def update(self, session_id, queue_id, status, completion=None):
        if status not in VALID_STATUSES:
            raise ValueError("invalid queue status")
        with self._locked(session_id):
            record = self._read(session_id)
            item = next((row for row in record["items"] if row["id"] == queue_id), None)
            if item is None:
                return None
            item["status"] = status
            item["updated_at"] = datetime.now(timezone.utc).isoformat()
            if completion is not None:
                item["completion"] = {
                    key: completion[key] for key in (
                        "status", "verified", "tool_execution_status", "delivery_status")
                    if key in completion
                }
            if status in FINAL_STATUSES:
                text = item.get("text", "")
                item["text"] = text[:HISTORY_PREVIEW_CHARS]
                item.pop("prepared", None)
            items = self._trim_history(record["items"])
            self._atomic_save(session_id, {"schema": SCHEMA,
                                           "accepting": record.get("accepting", False),
                                           "items": items})
            return self._public_item(item)

    def cancel(self, session_id, queue_id, claimed_id=None):
        with self._locked(session_id):
            return self._cancel_locked(session_id, queue_id, claimed_id)

    def _cancel_locked(self, session_id, queue_id, claimed_id=None):
        record = self._read(session_id)
        item = next((row for row in record["items"] if row["id"] == queue_id), None)
        if item is None:
            return "not_found"
        if item["status"] not in ("queued", "paused") or queue_id == claimed_id:
            return "claimed"
        item["status"] = "cancelled"
        item["updated_at"] = datetime.now(timezone.utc).isoformat()
        item.pop("prepared", None)
        item["text"] = item.get("text", "")[:HISTORY_PREVIEW_CHARS]
        self._atomic_save(session_id, {"schema": SCHEMA,
                                       "accepting": record.get("accepting", False),
                                       "items": self._trim_history(record["items"])})
        remaining = sum(1 for row in record["items"] if row["status"] in ACTIVE_STATUSES)
        return {"removed": True, "id": queue_id, "remaining": remaining}

    def discard(self, session_id):
        """Drop queue state after the owning session is archived/deleted."""
        with self._locked(session_id):
            self._discard_locked(session_id)

    def _check_discardable_locked(self, session_id):
        path = self._path(session_id)
        if self._is_reparse(path):
            raise ValueError("invalid message queue file")
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("invalid message queue file")

    def _discard_locked(self, session_id):
        """Drop sidecar while caller holds ``session_lock(session_id)``."""
        self._check_discardable_locked(session_id)
        try:
            self._path(session_id).unlink()
        except FileNotFoundError:
            pass

    def set_accepting(self, session_id, accepting):
        with self._locked(session_id):
            record = self._read(session_id)
            record["accepting"] = bool(accepting)
            self._atomic_save(session_id, record)
            return record

    def pause_pending(self, session_id, reason=None):
        with self._locked(session_id):
            record = self._read(session_id)
            now = datetime.now(timezone.utc).isoformat()
            for item in record["items"]:
                if item["status"] in ("queued", "running"):
                    item["status"] = "paused"
                    item["updated_at"] = now
                if item["status"] == "paused" and reason:
                    item["pause_reason"] = str(reason)[:500]
            record["accepting"] = False
            self._atomic_save(session_id, record)
            return record

    def resume_pending(self, session_id, current_id=None):
        with self._locked(session_id):
            record = self._read(session_id)
            for item in record["items"]:
                if item["status"] in ("paused", "running") and item["id"] != current_id:
                    item["status"] = "queued"
                    item.pop("pause_reason", None)
                    item["updated_at"] = datetime.now(timezone.utc).isoformat()
                elif item["id"] == current_id and item["status"] == "paused":
                    item["status"] = "running"
                    item.pop("pause_reason", None)
                    item["updated_at"] = datetime.now(timezone.utc).isoformat()
            record["accepting"] = True
            self._atomic_save(session_id, record)
            return record

    def close_if_empty(self, session_id):
        """Atomically stop accepting new messages once the FIFO is drained."""
        with self._locked(session_id):
            record = self._read(session_id)
            pending = any(item["status"] in ACTIVE_STATUSES for item in record["items"])
            if not pending:
                record["accepting"] = False
                self._atomic_save(session_id, record)
            return pending


def reconcile_inactive(ctx, queue, session_id):
    """Mark stale active rows paused when no process holds the session lease.

    This changes only the queue sidecar, never the session journal. A later
    explicit run resumes the same claimed message from its journal marker.
    """
    from ... import web
    # Keep the same lock order as archive/delete: context lock, session lease,
    # then queue lock. Re-check liveness under the lease so a late detail or
    # enqueue request cannot recreate a sidecar after archival.
    with ctx["lock"]:
        if session_id in ctx.get("running", set()):
            return True
        try:
            with web.lease(ctx["store"], session_id):
                try:
                    ctx["store"].load(session_id)
                except (OSError, ValueError):
                    return False
                if session_id not in ctx.get("running", set()):
                    queue.pause_pending(session_id)
        except BlockingIOError:
            # Another backend process owns the live run.
            return True
    return True


def dispatch(method, parts, query, data, ctx):
    """Sessions HTTP API for enqueueing and cancelling future user turns."""
    if len(parts) not in (4, 5) or parts[:2] != ["api", "sessions"] or parts[3] != "queue":
        return None
    from ... import plugin_runtime
    if not plugin_runtime.is_enabled(ctx.get("state_dir"), "sessions"):
        return 403, {"error": "plugin disabled or dependency unavailable: sessions", "plugin": "sessions"}
    sid = parts[2]
    if not isinstance(sid, str) or not _SESSION_ID.fullmatch(sid):
        return 404, {"error": "session not found"}
    store = ctx["store"]
    queue = MessageQueue(store, ctx.get("lock"))
    try:
        session = store.load(sid)
    except (OSError, ValueError):
        return 404, {"error": "session not found"}

    if len(parts) == 5:
        queue_id = parts[4]
        if method == 'PATCH':
            if not isinstance(data, dict) or set(data) != {'text', 'expectedText'}:
                return 400, {'error': 'expected text and expectedText'}
            from .answer_question import _validate_workspace
            try:
                with ctx['lock']:
                    with queue.session_lock(sid):
                        session = store.load(sid)
                        _validate_workspace(ctx, session)
                        return 200, queue._edit_locked(sid, queue_id, data['text'], data['expectedText'], session.get('current_queue_item_id'))
            except FileNotFoundError:
                return 404, {'error': 'queued message not found'}
            except QueueConflict as error:
                return 409, {'error': str(error)}
            except (ValueError, UnicodeError) as error:
                return 400, {'error': str(error)}
            except OSError:
                return 503, {'error': 'cannot update message queue'}
        if method != "DELETE":
            return 405, {"error": "method not allowed"}
        if data and (not isinstance(data, dict) or data):
            return 400, {"error": "queue deletion accepts no body"}
        try:
            with queue.session_lock(sid):
                session = store.load(sid)
                result = queue._cancel_locked(
                    sid, queue_id, session.get("current_queue_item_id"))
        except FileNotFoundError:
            return 404, {"error": "session not found"}
        except (OSError, ValueError):
            return 500, {"error": "cannot update message queue"}
        if result == "not_found":
            return 404, {"error": "queued message not found"}
        if result == "claimed":
            return 409, {"error": "queued message is already claimed"}
        return 200, result

    if method == "GET":
        try:
            if not reconcile_inactive(ctx, queue, sid):
                return 404, {"error": "session not found"}
            with queue.session_lock(sid):
                store.load(sid)
                return 200, queue._snapshot_locked(sid)
        except FileNotFoundError:
            return 404, {"error": "session not found"}
        except (OSError, ValueError):
            return 500, {"error": "cannot read message queue"}
    if method != "POST":
        return 405, {"error": "method not allowed"}
    body = data if isinstance(data, dict) else {}
    if set(body) - {"text", "prepared_token"}:
        return 400, {"error": "expected text and optional prepared_token only"}
    text = body.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 5000:
        return 400, {"error": "message must be 1..5000 characters"}
    token = body.get("prepared_token")
    if token is not None and (not isinstance(token, str) or len(token) > 128):
        return 400, {"error": "prepared input invalid or expired"}
    from . import http_routes
    try:
        if not reconcile_inactive(ctx, queue, sid):
            return 404, {"error": "session not found"}
    except (OSError, ValueError):
        return 500, {"error": "cannot reconcile message queue"}
    with ctx["lock"]:
        with queue.session_lock(sid):
            try:
                session = store.load(sid)
            except (OSError, ValueError):
                return 404, {"error": "session not found"}
            active = sid in ctx.get("running", set())
            try:
                snapshot = queue._snapshot_locked(sid)
            except (OSError, ValueError):
                return 500, {"error": "cannot read message queue"}
            if not active and not snapshot["queued_messages"]:
                return 409, {"error": "message queue is available only during an active run or while queued turns remain"}
            if session.get("pending_question") or session.get("status") == "awaiting_user":
                return 409, {"error": "answer the pending question before queueing another message"}
            prepared = None
            if token is not None:
                try:
                    prepared = http_routes._consume_prepared(ctx, token, session["root"])
                    active_context = ctx.get("running_context", {}).get(sid, {})
                    current_selection = active_context.get("model_selection") or session.get("model_selection") or {}
                    cached_selection = (prepared.get("metadata") or {}).get("modelSelection") or {}
                    if any(cached_selection.get(key) != current_selection.get(key)
                           for key in ("provider_id", "model", "reasoning_effort")):
                        return 409, {"error": "queued turn must use the active model selection"}
                    prepared_remote = http_routes._prepared_remote(ctx, prepared)
                    current_remote = active_context.get("remote_connection", session.get("remote_connection"))
                    if prepared_remote != current_remote:
                        return 409, {"error": "queued turn must use the active remote connection"}
                    prepared = {"text": prepared["text"], "metadata": prepared["metadata"],
                                "goal": prepared.get("goal"),
                                **({'edit_prefix': prepared['edit_prefix']} if 'edit_prefix' in prepared else {})}
                except (KeyError, TypeError, ValueError) as exc:
                    return 400, {"error": str(exc) if "prepared" not in str(exc).lower()
                                 else "prepared input invalid or expired"}
            try:
                item = queue._enqueue_locked(sid, text, prepared, active_run=active)
            except QueueConflict as exc:
                return 409, {"error": str(exc)}
            except (OSError, ValueError) as exc:
                return 413 if "too large" in str(exc).lower() or "full" in str(exc).lower() else 400, {"error": str(exc)}
    return 202, {"id": item["id"], "item": item}
