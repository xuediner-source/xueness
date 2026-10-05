"""Safe session-history forks from verified, closed user turns.

Only the current retained message prefix is considered. ``archived_messages``
is intentionally ignored because compaction does not preserve enough ordering
information to splice it back into a transcript without guessing.
"""
from __future__ import annotations

from contextlib import contextmanager
import copy
import errno
import hashlib
import json
import os
import re
import stat
import threading
import uuid
from pathlib import Path

from ...core import SYSTEM, Store
from ...session_lease import lease
from .session_management import validate_title

MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_MESSAGES = 5000
MAX_MESSAGE_CHARS = 2_000_000
MAX_CALLS = 2000
MAX_CALLS_PER_MESSAGE = 64
MAX_CALL_ID_CHARS = 200
MAX_TOOL_NAME_CHARS = 256
MAX_ARGUMENT_CHARS = 250_000
MAX_PREFIX_BYTES = 4 * 1024 * 1024
MAX_PREVIEW_CHARS = 240
_REVISION_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CHECKPOINT_RE = re.compile(r"[0-9a-f]{32}\Z")


class ForkError(ValueError):
    """An expected fork refusal, with its HTTP status for the API adapter."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _valid_text(value, limit: int, *, allow_empty=False) -> bool:
    return (isinstance(value, str) and len(value) <= limit
            and (allow_empty or bool(value.strip()))
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _read_snapshot(store: Store, sid: str) -> tuple[dict, str]:
    path = store._path(sid)
    if path.is_symlink():
        raise ForkError("session file is a symbolic link")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        raise ForkError("session not found", 404) from None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ForkError("session file is a symbolic link") from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ForkError("session file is not regular")
        if info.st_size > MAX_SOURCE_BYTES:
            raise ForkError("session journal exceeds fork size limit", 413)
        chunks = []
        remaining = MAX_SOURCE_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    finally:
        os.close(fd)
    if len(raw) > MAX_SOURCE_BYTES:
        raise ForkError("session journal exceeds fork size limit", 413)
    try:
        session = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ForkError("session journal is invalid JSON") from None
    if not isinstance(session, dict) or session.get("id") != sid:
        raise ForkError("session journal is invalid")
    if (not isinstance(session.get("task"), str) or not session["task"].strip()
            or len(session["task"]) > 5000
            or not _valid_text(session.get("root"), 4096)):
        raise ForkError("session task or workspace is invalid")
    messages = session.get("messages")
    if not isinstance(messages, list) or len(messages) > MAX_SOURCE_MESSAGES:
        raise ForkError("session message count exceeds fork limit", 413)
    source_results = session.get("results")
    if source_results is not None and not isinstance(source_results, dict):
        raise ForkError("session results are invalid")
    source_results = source_results if isinstance(source_results, dict) else {}
    return session, "sha256:" + hashlib.sha256(raw).hexdigest()


@contextmanager
def _locked_source(ctx: dict, sid: str):
    """Hold the local running lock and cross-process lease for one snapshot."""
    store = ctx["store"]
    lock = ctx.get("lock")
    if lock is None:
        lock = threading.RLock()
    lock.acquire()
    try:
        if sid in ctx.get("running", ()):
            raise ForkError("session run already in progress", 409)
        try:
            with lease(store, sid):
                # A run can only enter ctx['running'] while holding this lock.
                # The second check documents and protects future lock changes.
                if sid in ctx.get("running", ()):
                    raise ForkError("session run already in progress", 409)
                session, revision = _read_snapshot(store, sid)
                if session.get("streaming"):
                    raise ForkError("session has an active or interrupted stream", 409)
                yield session, revision
        except BlockingIOError:
            raise ForkError("session is in use by another process", 409) from None
    finally:
        lock.release()


def _canonical_message(message: dict) -> dict:
    role = message.get("role")
    if role not in ("system", "user", "assistant", "tool"):
        raise ForkError("session contains an unsupported message role")
    content = message.get("content")
    if content is not None and (not isinstance(content, str) or len(content) > MAX_MESSAGE_CHARS):
        raise ForkError("session message content exceeds fork limits", 413)
    if role in ("system", "user", "tool") and not isinstance(content, str):
        raise ForkError("session message content is invalid")
    if role == "system":
        # Every non-leading system row is excluded from the fork. Compaction
        # summaries are generated text and may summarize turns past a boundary.
        return {"role": "system", "content": content}
    if role == "user":
        return {"role": "user", "content": content}
    if role == "tool":
        call_id = message.get("tool_call_id")
        if not _valid_text(call_id, MAX_CALL_ID_CHARS):
            raise ForkError("session tool result has an invalid call id")
        return {"role": "tool", "tool_call_id": call_id, "content": content}

    clean = {"role": "assistant", "content": content if isinstance(content, str) else ""}
    calls = message.get("tool_calls")
    if calls is not None:
        if not isinstance(calls, list) or len(calls) > MAX_CALLS_PER_MESSAGE:
            raise ForkError("session tool call list exceeds fork limits", 413)
        if calls:
            canonical_calls = []
            for call in calls:
                if not isinstance(call, dict) or call.get("type") != "function":
                    raise ForkError("session contains an invalid tool call")
                call_id = call.get("id")
                function = call.get("function")
                if (not _valid_text(call_id, MAX_CALL_ID_CHARS)
                        or not isinstance(function, dict)
                        or not _valid_text(function.get("name"), MAX_TOOL_NAME_CHARS)
                        or not isinstance(function.get("arguments"), str)
                        or len(function["arguments"]) > MAX_ARGUMENT_CHARS):
                    raise ForkError("session contains an invalid tool call")
                try:
                    arguments = json.loads(function["arguments"] or "{}")
                except (json.JSONDecodeError, TypeError):
                    raise ForkError("session tool call arguments are invalid JSON") from None
                if not isinstance(arguments, dict):
                    raise ForkError("session tool call arguments must be an object")
                canonical_calls.append({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": function["name"], "arguments": function["arguments"]},
                })
            clean["tool_calls"] = canonical_calls
    return clean


def _has_pending_approvals(messages: list[dict], results: dict) -> bool:
    # Reuse the same policy that powers approval controls and new-turn guards.
    # A denied call in the prefix is historical context, but its approval must
    # not become a new grant opportunity on the fork.
    from ...web import pending_denials
    try:
        return bool(pending_denials({"messages": messages, "results": results}))
    except (AttributeError, KeyError, TypeError, ValueError):
        return True


def _history_truncation(session: dict, messages: list[dict]) -> tuple[bool, str | None]:
    archived = session.get("archived_messages")
    compacted = session.get("compactions")
    has_archived = isinstance(archived, list) and bool(archived)
    has_drops = isinstance(compacted, list) and any(
        isinstance(item, dict) and (type(item.get("removed")) is int and item["removed"] > 0
                                    or type(item.get("masked")) is int and item["masked"] > 0)
        for item in compacted
    )
    has_summary = any(
        isinstance(message, dict) and message.get("role") == "system"
        and isinstance(message.get("content"), str)
        and message["content"].startswith("Older history compacted;")
        for message in messages[1:]
    )
    truncated = has_archived or has_drops or has_summary
    reason = ("Only the current retained messages are used. Compaction archives have no reliable "
              "cross-turn order, so archived messages and generated system summaries are omitted.") if truncated else None
    return truncated, reason


def _boundaries(session: dict, revision: str) -> dict:
    raw_messages = session.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages or len(raw_messages) > MAX_SOURCE_MESSAGES:
        raise ForkError("session messages are invalid or exceed fork limits", 413)
    source_results = session.get("results")
    if source_results is not None and not isinstance(source_results, dict):
        raise ForkError("session results are invalid")
    source_results = source_results if isinstance(source_results, dict) else {}
    all_call_ids: set[str] = set()
    completed_results: dict = {}
    active_user: dict | None = None
    pending_calls: dict[str, dict] = {}
    boundaries = []
    turn = 0
    total_calls = 0
    copied_cost = len(json.dumps({"role": "system", "content": SYSTEM},
                                 ensure_ascii=False, separators=(",", ":"))) + 2
    copied_prefix: list[dict] = []
    copyable = True
    boundaries_truncated = False
    trailing_unclosed = False
    awaiting_answer = False

    if not isinstance(raw_messages[0], dict) or raw_messages[0].get("role") != "system":
        raise ForkError("session does not begin with a system message")

    for index, raw in enumerate(raw_messages):
        if not isinstance(raw, dict):
            trailing_unclosed = True
            break
        message = _canonical_message(raw)
        role = message["role"]
        if role == "system":
            # Do not copy original or compacted system text. New sessions use
            # the current canonical system prompt from core.SYSTEM.
            continue
        encoded_size = len(json.dumps(message, ensure_ascii=False, separators=(",", ":")))
        if copyable:
            if copied_cost + encoded_size + 1 <= MAX_PREFIX_BYTES:
                copied_prefix.append(message)
                copied_cost += encoded_size + 1
            else:
                copyable = False
                boundaries_truncated = True

        if role == "user":
            is_answer = awaiting_answer and not pending_calls and message['content'].startswith('Operator answer: ')
            if active_user is not None and not is_answer:
                # A new user row cannot close a turn whose assistant/calls did
                # not finish. Stop here and retain only older safe boundaries.
                trailing_unclosed = True
                break
            turn += 1
            active_user = message
            pending_calls = {}
            awaiting_answer = False
            continue

        if active_user is None:
            # Tool output or assistant text without a user is never a boundary.
            trailing_unclosed = True
            break
        if role == "assistant":
            calls = message.get("tool_calls") or []
            if calls:
                if pending_calls:
                    trailing_unclosed = True
                    break
                total_calls += len(calls)
                if total_calls > MAX_CALLS:
                    raise ForkError("session tool call count exceeds fork limit", 413)
                for call in calls:
                    cid = call["id"]
                    if cid in all_call_ids:
                        trailing_unclosed = True
                        break
                    all_call_ids.add(cid)
                    pending_calls[cid] = call
                if trailing_unclosed:
                    break
                continue
            if pending_calls:
                trailing_unclosed = True
                break
            # A no-tool assistant row closes this user turn. Include only
            # boundaries whose retained prefix is bounded and approval-free.
            prefix = [{"role": "system", "content": SYSTEM}, *copied_prefix]
            prefix_results = {cid: copy.deepcopy(source_results[cid]) for cid in completed_results
                              if cid in source_results}
            if copyable and not _has_pending_approvals(prefix, prefix_results):
                token_source = f"xueness-fork-v1\0{revision}\0{index}\0{turn}".encode("utf-8")
                token = "fb1-" + hashlib.sha256(token_source).hexdigest()
                user_content = active_user.get("content") or ""
                preview = " ".join(user_content.split())[:MAX_PREVIEW_CHARS]
                boundaries.append({"token": token, "turn": turn, "endIndex": index,
                                   "preview": preview})
            active_user = None
            pending_calls = {}
            continue

        if role == "tool":
            cid = message["tool_call_id"]
            if cid not in pending_calls or cid in completed_results:
                trailing_unclosed = True
                break
            if not isinstance(source_results.get(cid), dict):
                trailing_unclosed = True
                break
            result = source_results[cid]
            try:
                if len(json.dumps(result, ensure_ascii=False, separators=(",", ":"))) > MAX_MESSAGE_CHARS:
                    raise ForkError("tool result exceeds fork limits", 413)
            except (TypeError, ValueError):
                trailing_unclosed = True
                break
            completed_results[cid] = result
            if (pending_calls[cid]['function']['name'] == 'ask_user'
                    and result.get('awaiting_user') is True):
                awaiting_answer = True
            del pending_calls[cid]
            continue

        trailing_unclosed = True
        break

    if active_user is not None or pending_calls:
        trailing_unclosed = True
    # A stale persisted `running` status can mean the process died after writing
    # its final-looking assistant row but before settling the turn. Keep older
    # boundaries available, but never offer that tail as a completed turn.
    last_non_system = next((i for i in range(len(raw_messages) - 1, -1, -1)
                            if isinstance(raw_messages[i], dict)
                            and raw_messages[i].get("role") != "system"), None)
    if (session.get("status") == "running" and boundaries
            and boundaries[-1]["endIndex"] == last_non_system):
        boundaries.pop()
        trailing_unclosed = True
    history_truncated, reason = _history_truncation(session, raw_messages)
    if trailing_unclosed:
        unclosed_reason = "The current tail has no complete user turn; only earlier closed turns can be forked."
    else:
        unclosed_reason = None
    return {
        "sourceId": session["id"],
        "revision": revision,
        "boundaries": boundaries,
        "historyTruncated": history_truncated,
        "truncationReason": reason,
        "hasUnclosedTurn": trailing_unclosed,
        "boundariesTruncated": boundaries_truncated,
        "boundaryLimitReason": ("Some later closed turns exceed the fork transcript size limit and are not offered."
                                if boundaries_truncated else None),
        "unclosedReason": unclosed_reason,
    }


def _validate_workspace(ctx: dict, session: dict) -> Path:
    root = Path(session["root"])
    try:
        from ...web import _allowed_root
        from ..settings.workspaces_api import allowed_roots
        root = _allowed_root(root, Path(ctx["web_runs"]), Path(ctx["project_dir"]), allowed_roots(ctx))
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        raise ForkError("session workspace is no longer permitted", 403) from None
    if not root.is_dir():
        raise ForkError("session workspace is unavailable", 409)
    return root


def _safe_model_config(source: dict) -> dict:
    config = {}
    selection = source.get("model_selection")
    if selection is not None:
        if not isinstance(selection, dict):
            raise ForkError("session model selection is invalid")
        if set(selection) - {"provider_id", "model", "reasoning_effort"}:
            raise ForkError("session model selection is invalid")
        for key, value in selection.items():
            if value is not None and not _valid_text(value, 256):
                raise ForkError("session model selection is invalid")
        config["model_selection"] = dict(selection)
    profile = source.get("runtime_profile")
    if profile is not None:
        if profile not in ("standard", "lightweight"):
            raise ForkError("session runtime profile is invalid")
        config["runtime_profile"] = profile
    return config


def _make_fork(store: Store, source: dict, revision: str, boundary: dict,
               *, title: str | None, root: Path, checkpoint: dict | None = None) -> dict:
    end_index = boundary["endIndex"]
    messages = source["messages"]
    copied_messages = []
    referenced_ids = set()
    for raw in messages[:end_index + 1]:
        clean = _canonical_message(raw)
        if clean["role"] == "system":
            continue
        copied_messages.append(clean)
        for call in clean.get("tool_calls", []):
            referenced_ids.add(call["id"])
    # Re-run pair validation on exactly the chosen prefix. This means malformed
    # trailing data can never leak into a fork created at an earlier boundary.
    result_map = source.get("results")
    if not isinstance(result_map, dict):
        result_map = {}
    selected_results = {}
    tool_ids = {message["tool_call_id"] for message in copied_messages if message["role"] == "tool"}
    for cid in tool_ids:
        result = result_map.get(cid)
        if not isinstance(result, dict):
            raise ForkError("selected boundary has an unpaired tool result")
        selected_results[cid] = copy.deepcopy(result)
    if referenced_ids != tool_ids or any(cid not in selected_results for cid in referenced_ids):
        raise ForkError("selected boundary contains a partial tool call")

    system_message = {"role": "system", "content": SYSTEM}
    all_messages = [system_message, *copied_messages]
    encoded = json.dumps(all_messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_PREFIX_BYTES:
        raise ForkError("selected transcript exceeds fork size limit", 413)
    if _has_pending_approvals(all_messages, selected_results):
        raise ForkError("selected boundary contains pending approvals", 400)

    truncated, reason = _history_truncation(source, messages)
    source_title = source.get("title") or source["task"]
    if title is None:
        default_title = "Fork: " + source_title.strip()
        title = validate_title(default_title[:120])
    else:
        title = validate_title(title)
    fork_id = uuid.uuid4().hex
    parent = {
        "sourceId": source["id"],
        "sourceRevision": revision,
        "turn": boundary["turn"],
        "endIndex": boundary["endIndex"],
        "historyTruncated": truncated,
        "truncationReason": reason,
    }
    if checkpoint:
        # The workspace snapshot this fork was derived from; rewinding the
        # shared workspace to it stays an explicit git.rewind action.
        parent["checkpointId"] = checkpoint["checkpointId"]
        parent["checkpointTurn"] = checkpoint["turn"]
    child = {
        "id": fork_id,
        "task": source["task"],
        "title": title,
        "root": str(root.resolve()),
        "status": "pending",
        "messages": all_messages,
        "results": selected_results,
        "compactions": [],
        "archived_messages": [],
        "steps": 0,
        "completion": None,
        "todos": [],
        "pending_question": None,
        "fork_parent": parent,
    }
    child.update(_safe_model_config(source))
    store.save(child)
    return {"session": {"id": fork_id, "status": "pending", "root": child["root"],
                         "title": title},
            "sourceId": source["id"],
            "boundary": {"turn": boundary["turn"], "preview": boundary["preview"]},
            "historyTruncated": truncated,
            "truncationReason": reason,
            "forkParent": dict(parent)}


def get_boundaries(ctx: dict, sid: str) -> dict:
    """Return revision-bound safe boundaries under both source locks."""
    with _locked_source(ctx, sid) as (session, revision):
        _validate_workspace(ctx, session)
        return _boundaries(session, revision)


def fork_at(ctx: dict, sid: str, *, revision: str, boundary_token: str,
            title: str | None = None) -> dict:
    """Fork exactly one fresh server-derived boundary without running anything."""
    if not isinstance(revision, str) or not _REVISION_RE.fullmatch(revision):
        raise ForkError("invalid session revision")
    if not _valid_text(boundary_token, 80):
        raise ForkError("invalid fork boundary token")
    if title is not None:
        try:
            title = validate_title(title)
        except ValueError as exc:
            raise ForkError(str(exc)) from None
    with _locked_source(ctx, sid) as (source, current_revision):
        if revision != current_revision:
            raise ForkError("session changed; refresh fork boundaries", 409)
        _validate_workspace(ctx, source)
        index = _boundaries(source, current_revision)
        boundary = next((item for item in index["boundaries"]
                         if item["token"] == boundary_token), None)
        if boundary is None:
            raise ForkError("fork boundary is no longer safe or was not offered", 409)
        return _make_fork(ctx["store"], source, current_revision, boundary,
                          title=title, root=Path(source["root"]).resolve())


def fork_at_checkpoint(ctx: dict, sid: str, *, checkpoint: str | None = None,
                       latest: bool = False, turn: int | None = None,
                       title: str | None = None, enforce_workspace: bool = False) -> dict:
    """Fork the closed turns before one automatic per-turn workspace snapshot.

    ``git.turn_checkpoints`` snapshots the workspace *before* turn N changes
    anything, so the matching transcript is every turn up to N-1. Files are not
    touched here: the source and the fork share one workspace, and restoring it
    is ``git.rewind``'s job. The chosen snapshot is recorded on the fork so the
    two stay linked.
    """
    if type(latest) is not bool:
        raise ForkError("latest must be a boolean")
    if checkpoint is not None and latest:
        raise ForkError("choose either a checkpoint id or --latest, not both")
    if checkpoint is not None and not _valid_text(checkpoint, 32):
        raise ForkError("invalid checkpoint id")
    if turn is not None and (type(turn) is not int or turn < 1):
        raise ForkError("turn must be a positive integer")
    if title is not None:
        try:
            title = validate_title(title)
        except ValueError as exc:
            raise ForkError(str(exc)) from None
    with _locked_source(ctx, sid) as (source, revision):
        root = Path(source["root"]).resolve(strict=True)
        if not root.is_dir():
            raise ForkError("session workspace is unavailable", 409)
        if enforce_workspace:
            root = _validate_workspace(ctx, source)
        from ..git.turn_checkpoints import RewindError, records, resolve
        try:
            if turn is not None:
                chosen = next((item for item in records(source) if item.get("turn") == turn), None)
                if chosen is None:
                    raise ForkError("requested turn has no workspace checkpoint", 409)
            else:
                chosen = resolve(source, checkpoint=checkpoint, latest=latest)
        except RewindError as exc:
            raise ForkError(str(exc), exc.status) from None
        snapshot_turn = chosen.get("turn")
        checkpoint_id = chosen.get("checkpointId")
        if not isinstance(checkpoint_id, str) or not _CHECKPOINT_RE.fullmatch(checkpoint_id):
            raise ForkError("checkpoint record is invalid", 409)
        if type(snapshot_turn) is not int or snapshot_turn < 2:
            raise ForkError("that checkpoint has no earlier turn to fork from", 409)
        index = _boundaries(source, revision)
        boundary = next((item for item in index["boundaries"]
                         if item["turn"] == snapshot_turn - 1), None)
        if boundary is None:
            raise ForkError("the turn before that checkpoint is not a safe closed boundary", 409)
        linked = {"checkpointId": checkpoint_id, "turn": snapshot_turn}
        result = _make_fork(ctx["store"], source, revision, boundary,
                            title=title, root=root, checkpoint=linked)
        result["checkpoint"] = linked
        return result


def fork_turn(ctx: dict, sid: str, *, turn: int | None = None,
              title: str | None = None, enforce_workspace: bool = False) -> dict:
    """CLI adapter: choose a server-derived ordinal, or the latest safe one."""
    if turn is not None and (type(turn) is not int or turn < 1):
        raise ForkError("turn must be a positive integer")
    if title is not None:
        try:
            title = validate_title(title)
        except ValueError as exc:
            raise ForkError(str(exc)) from None
    with _locked_source(ctx, sid) as (source, revision):
        root = Path(source["root"]).resolve(strict=True)
        if not root.is_dir():
            raise ForkError("session workspace is unavailable", 409)
        if enforce_workspace:
            root = _validate_workspace(ctx, source)
        index = _boundaries(source, revision)
        candidates = index["boundaries"]
        boundary = (next((item for item in candidates if item["turn"] == turn), None)
                    if turn is not None else (candidates[-1] if candidates else None))
        if boundary is None:
            if turn is not None:
                raise ForkError("requested turn is not a safe closed boundary")
            raise ForkError("session has no safe closed turn to fork")
        return _make_fork(ctx["store"], source, revision, boundary,
                          title=title, root=root)
