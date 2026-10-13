"""Project an existing Xueness journal into the v4 conversation shape.

The runtimes plugin owns the wire projection, while the sessions plugin owns
the journal.  This module is intentionally read-only: it never creates a
second transcript and never turns an absent provider/tool record into a fake
assistant result.  A caller can pass the result of ``Store.load`` directly to
``session_to_rows`` or ``session_to_snapshot``.

The journal predates v4 and does not persist per-message timestamps or numeric
row ids.  For those two required wire fields we use deterministic values:
``createdAt`` is the journal's optional timestamp when present and ``0`` when
the source has no timestamp, while ``rowId`` is a stable hash of the session
and message identity.  A future writer may persist ``_v4_row_id`` and this
projector will honor it.  The deterministic fallback keeps replay stable and
does not claim that an event happened at the time of projection.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime
from typing import Any, Iterable, Mapping


MAX_TEXT = 256 * 1024
MAX_ROWS = 60
_EPOCH = 0


def _text(value: Any, *, limit: int = MAX_TEXT) -> str:
    """Return bounded display text without leaking an object's repr."""
    if isinstance(value, str):
        return value[:limit]
    if value is None:
        return ""
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = ""
    return encoded[:limit]


def _identity(session_id: str, value: Any, ordinal: int) -> str:
    raw = value if isinstance(value, str) and value else f"legacy:{ordinal}"
    return f"{session_id}:{raw}"


def _row_id(session_id: str, message: Mapping[str, Any], ordinal: int,
            suffix: str = "") -> int:
    stored = message.get("_v4_row_id")
    if not suffix and type(stored) is int and stored >= 0:
        return stored
    identity = _identity(session_id, message.get("_message_id"), ordinal) + suffix
    # 2**53-1 is exactly representable in JavaScript and is comfortably below
    # the protocol's numeric row-id limit.  Zero is reserved for no row.
    value = int.from_bytes(hashlib.sha256(identity.encode("utf-8")).digest()[:7], "big")
    return max(1, value & ((1 << 53) - 1))


def _timestamp(value: Any) -> int | float | None:
    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed.timestamp() * 1000
        except (ValueError, OverflowError):
            pass
    return None


def _created_at(session: Mapping[str, Any], message: Mapping[str, Any]) -> int | float:
    del session  # Session creation is not evidence of a message's creation time.
    for key in ("_created_at", "createdAt", "created_at", "timestamp"):
        value = _timestamp(message.get(key))
        if value is not None:
            return value
    # The source journal has no timestamp field.  Keep this deterministic;
    # callers can distinguish unknown source time from projection time (zero).
    return _EPOCH


def _turn_id(message: Mapping[str, Any], ordinal: int) -> str:
    value = message.get("_turn_id")
    return value if isinstance(value, str) and value else f"turn-{max(1, ordinal)}"


def _base(session_id: str, session: Mapping[str, Any], message: Mapping[str, Any],
          ordinal: int, suffix: str = "") -> dict[str, Any]:
    identity = message.get("_message_id")
    row: dict[str, Any] = {
        "rowId": _row_id(session_id, message, ordinal, suffix),
        "turnId": _turn_id(message, ordinal),
        "entityId": (identity if isinstance(identity, str) and identity
                      else f"legacy-{ordinal}"),
        "productTurnId": _turn_id(message, ordinal),
        "visibility": "visible",
        "createdAt": _created_at(session, message),
        "createdAtSeq": ordinal,
    }
    return row


def _display_messages(session: Mapping[str, Any]) -> list[tuple[Mapping[str, Any], int | None]]:
    """Match the sessions conversation display order, including compaction."""
    active = session.get("messages")
    active = active if isinstance(active, list) else []
    archived = session.get("archived_messages")
    archived = archived if isinstance(archived, list) else []
    hidden = session.get("history_hidden_message_ids", [])
    hidden = set(hidden) if isinstance(hidden, list) and all(isinstance(v, str) for v in hidden) else set()

    if not archived:
        return [(item, index) for index, item in enumerate(active)
                if isinstance(item, Mapping)]

    rows: list[tuple[Mapping[str, Any], int | None]] = []
    for item in archived:
        if not isinstance(item, Mapping):
            continue
        if item.get("_message_id") not in hidden:
            rows.append((item, None))
    start = 1 if active and isinstance(active[0], Mapping) and active[0].get("role") == "system" else 0
    if (start < len(active) and isinstance(active[start], Mapping)
            and active[start].get("_semantic_summary") is True):
        start += 1
    rows.extend((item, index) for index, item in enumerate(active[start:], start)
                if isinstance(item, Mapping))

    # Compaction may leave an archived copy and an active copy with the same
    # message identity.  Prefer the active copy unless it is clearly a
    # truncation marker; this mirrors conversation_snapshot.py.
    positions: dict[str, int] = {}
    unique: list[tuple[Mapping[str, Any], int | None]] = []
    for item, active_index in rows:
        identity = item.get("_message_id")
        if not isinstance(identity, str) or not identity:
            unique.append((item, active_index))
            continue
        existing = positions.get(identity)
        if existing is None:
            positions[identity] = len(unique)
            unique.append((item, active_index))
            continue
        old, old_index = unique[existing]
        if active_index is not None and not _truncated(item):
            unique[existing] = (item, active_index)
        elif old_index is not None and _truncated(old) and active_index is None:
            unique[existing] = (item, None)
    return unique


def _truncated(message: Mapping[str, Any]) -> bool:
    content = message.get("content")
    if not isinstance(content, str):
        return False
    lowered = content.lower()
    return any(marker in lowered for marker in (
        "[old output masked;", "[truncated in context]", "[truncated in journal",
        "[output truncated", "… [truncated]"))


def _result_text(result: Any) -> str:
    if isinstance(result, Mapping):
        for key in ("output", "content", "message", "text", "error"):
            if isinstance(result.get(key), str):
                return result[key][:MAX_TEXT]
    return _text(result, limit=MAX_TEXT)


def _tool_status(result: Any, session: Mapping[str, Any], call_id: str,
                 pending_ids: set[str]) -> str:
    # The host's pending_denials resolver handles permission classification
    # and later successful retries. Policy denials remain errors.
    if call_id in pending_ids:
        return "pendingApproval"
    if isinstance(result, Mapping):
        if result.get("ok") is True or result.get("status") in {"success", "succeeded", "completed"}:
            return "success"
        if result.get("ok") is False or result.get("error"):
            if "cancel" in str(result.get("error", "")).lower():
                return "cancelled"
            return "error"
    if session.get("status") in {"paused", "stopped", "needs_review", "interrupted"}:
        return "cancelled"
    return "running"


def _tool_row(session_id: str, session: Mapping[str, Any], message: Mapping[str, Any],
              ordinal: int, call: Mapping[str, Any], results: Mapping[str, Any],
              pending_ids: set[str]) -> dict[str, Any]:
    call_id = call.get("id")
    call_id = call_id if isinstance(call_id, str) and call_id else f"call-{ordinal}"
    function = call.get("function")
    function = function if isinstance(function, Mapping) else {}
    name = function.get("name")
    name = name if isinstance(name, str) and name else "unknown"
    args = function.get("arguments", "")
    if not isinstance(args, str):
        args = _text(args, limit=MAX_TEXT)
    result = results.get(call_id) if isinstance(results, Mapping) else None
    status = _tool_status(result, session, call_id, pending_ids)
    row = _base(session_id, session, message, ordinal, f":tool:{call_id}")
    row.update({"kind": "toolCall", "toolCallId": call_id, "toolName": name,
                "status": status, "inputText": args})
    response_id = message.get("_message_id")
    if isinstance(response_id, str) and response_id:
        row["assistantResponseId"] = response_id
    try:
        parsed = json.loads(args)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, Mapping):
        row["input"] = parsed
        row["subject"] = _text(parsed.get("path") or parsed.get("command") or parsed.get("argv"), limit=200)
    if result is not None:
        row["output"] = {"text": _result_text(result)}
        # Preserve the actual JSON outcome when bounded; do not manufacture a
        # success/failure object from the rendered text.
        encoded = json.dumps(result, ensure_ascii=False, default=str)
        if len(encoded) <= MAX_TEXT:
            row["result"] = json.loads(encoded)
    if status == "pendingApproval":
        row["approvalInteractionId"] = "approval:" + call_id
    if status == "error":
        message_text = _result_text(result) or "tool failed"
        from ...events import error_code
        row["error"] = {"code": "tool.failed", "message": message_text[:4000]}
        row["errorCode"] = error_code(False, str(result.get("error", ""))) if isinstance(result, Mapping) else "tool.failed"
    timing = next((entry for entry in reversed(session.get("tool_timings") or [])
                   if isinstance(entry, Mapping) and entry.get("tool_call_id") == call_id), {})
    seconds = timing.get("seconds")
    if type(seconds) in (int, float) and math.isfinite(seconds) and seconds >= 0:
        row["durationMs"] = seconds * 1000
    for field, aliases in (("startedAt", ("startedAt", "started_at")),
                           ("endedAt", ("endedAt", "ended_at", "completed_at"))):
        for source in (timing, call, result if isinstance(result, Mapping) else {}):
            value = next((_timestamp(source.get(key)) for key in aliases
                          if _timestamp(source.get(key)) is not None), None)
            if value is not None:
                row[field] = value
                break
    return row


def session_to_rows(session: Mapping[str, Any], *, session_id: str | None = None,
                    tail: int = MAX_ROWS) -> list[dict[str, Any]]:
    """Convert journal messages and recorded tool results to v4 rows.

    System prompts remain private model context.  Every visible row is backed
    by a journal message or a recorded tool call; missing results stay in a
    pending/running state and do not receive invented output text.
    """
    sid = session_id or session.get("id")
    if not isinstance(sid, str) or not sid:
        raise ValueError("session id is required for stable row projection")
    from ...web import pending_denials
    pending_ids = {item["tool_call_id"] for item in pending_denials(session)}
    results = session.get("results")
    results = dict(results) if isinstance(results, Mapping) else {}
    displayed = _display_messages(session)
    # Some old journals only have tool messages. They are recorded outcomes,
    # too; prefer the current results table when both sources exist.
    for message, _ in displayed:
        if message.get("role") == "tool" and isinstance(message.get("tool_call_id"), str):
            try:
                value = json.loads(message.get("content", ""))
            except (ValueError, TypeError):
                value = message.get("content")
            if value is not None:
                results.setdefault(message["tool_call_id"], value)
    active = session.get("messages") or []
    streams = {record["id"]: record for record in session.get("stream_history", [])
               if isinstance(record, Mapping) and isinstance(record.get("id"), str)}
    live = session.get("streaming")
    if isinstance(live, Mapping) and isinstance(live.get("id"), str):
        streams[live["id"]] = live
    linked = {}
    for record in streams.values():
        index = record.get("final_message_index")
        if (type(index) is int and 0 <= index < len(active)
                and isinstance(active[index], Mapping) and active[index].get("role") == "assistant"
                and record.get("text", "") == active[index].get("content", "")):
            linked[index] = record
    reasoning = {record["message_index"]: record["text"] for record in session.get("reasoning_history", [])
                 if isinstance(record, Mapping) and type(record.get("message_index")) is int
                 and isinstance(record.get("text"), str)}
    projected: list[dict[str, Any]] = []

    def add(row, message, index):
        # Never turn an archived display index or live stream into an edit
        # target. All three fields refer to the same Store read.
        row.update(messageId=message.get("_message_id") or row["entityId"], messageIndex=index)
        projected.append(row)

    consumed_streams = set()
    current_turn, user_seen = "turn-1", False
    for ordinal, (item, active_index) in enumerate(displayed, 1):
        role = item.get("role")
        if role == "system":
            continue
        explicit_turn = item.get("_turn_id")
        if isinstance(explicit_turn, str) and explicit_turn:
            current_turn = explicit_turn
        elif role == "user" and user_seen and item.get("_input_kind") != "guide":
            current_turn = f"turn-{int(current_turn[5:]) + 1}" if current_turn.startswith("turn-") and current_turn[5:].isdigit() else f"turn-{ordinal}"
        if role == "user":
            user_seen = True
        item = {**item, "_turn_id": current_turn}
        if role == "user":
            row = _base(sid, session, item, ordinal)
            origin = "synthetic" if item.get("_input_kind") == "guide" else "realUser"
            row.update({"kind": "userInput", "text": _text(item.get("content")), "origin": origin})
            if isinstance(item.get("_source_command_id"), str):
                row["sourceCommandId"] = item["_source_command_id"]
            add(row, item, active_index)
            continue
        if role == "assistant":
            content = _text(item.get("content"))
            calls = item.get("tool_calls")
            calls = calls if isinstance(calls, list) else []
            stream = linked.get(active_index)
            anchor = item
            state = "complete"
            if stream is not None:
                consumed_streams.add(stream["id"])
                anchor = {**item, "_message_id": "stream:" + stream["id"]}
                state = "interrupted" if stream.get("interrupted") else "complete"
            thought = reasoning.get(active_index) or (stream or {}).get("reasoning", "")
            if thought:
                row = _base(sid, session, anchor, ordinal, ":reasoning")
                row.update(kind="reasoning", text=_text(thought), state=state)
                row["assistantResponseId"] = anchor.get("_message_id") or row["entityId"]
                add(row, item, active_index)
            if content or not calls:
                row = _base(sid, session, anchor, ordinal)
                row.update({"kind": "assistantText", "text": content, "state": state})
                response_id = anchor.get("_message_id")
                if isinstance(response_id, str) and response_id:
                    row["assistantResponseId"] = response_id
                selection = session.get("model_selection")
                if isinstance(selection, Mapping) and isinstance(selection.get("model"), str):
                    row["model"] = selection["model"]
                annotations = session.get("message_annotations")
                annotation = annotations.get(str(active_index), {}) if isinstance(annotations, Mapping) else {}
                annotation = annotation if isinstance(annotation, Mapping) else {}
                if annotation.get("feedback") in {"like", "dislike"}:
                    row["feedback"] = annotation["feedback"]
                add(row, item, active_index)
            for index, call in enumerate(calls):
                if isinstance(call, Mapping):
                    tool = _tool_row(sid, session, item, ordinal, call, results, pending_ids)
                    tool["archivedForCompaction"] = active_index is None
                    add(tool, item, active_index)
            continue
    for offset, record in enumerate(streams.values(), len(displayed) + 1):
        if record["id"] in consumed_streams:
            continue
        # Completed streams without a verified final link may have been
        # compacted. The saved messages remain authoritative: no second answer.
        if record.get("status") == "completed":
            continue
        stream_id = "stream:" + record["id"]
        turn = record.get("_turn_id") or record.get("turn_id")
        if not turn and record is live:
            turn = next((item.get("_turn_id") for item in reversed(active)
                         if isinstance(item, Mapping) and item.get("_turn_id")), None)
        anchor = {"_message_id": stream_id, "_turn_id": turn or (current_turn if record is live else stream_id)}
        state = "streaming" if record is live and record.get("status") == "streaming" else "interrupted"
        for kind, key, suffix in (("reasoning", "reasoning", ":reasoning"),
                                   ("assistantText", "text", "")):
            text = record.get(key)
            if not isinstance(text, str) or not text:
                continue
            row = _base(sid, session, anchor, offset, suffix)
            row.update(kind=kind, text=_text(text), state=state,
                       streamId=record["id"], assistantResponseId=stream_id)
            add(row, anchor, None)
    if isinstance(tail, bool) or not isinstance(tail, int) or tail < 1:
        raise ValueError("tail must be a positive integer")
    for index, row in enumerate(projected, 1):
        # Presentation order is separate from stable hashed row identity.
        row["createdAtSeq"] = index
    return projected[-tail:]


def _phase(session: Mapping[str, Any]) -> str:
    status = session.get("status")
    if status in {"pending", "draft"}:
        return "draft"
    if status == "running" or (isinstance(session.get("streaming"), Mapping)
                               and session["streaming"].get("status") == "streaming"):
        return "running"
    if status == "completed":
        return "completedSuccess"
    if status in {"paused", "stopped", "needs_review", "interrupted"}:
        return "completedInterrupted"
    if status in {"provider_error", "error"}:
        return "error"
    return "error"


def session_to_control(session: Mapping[str, Any]) -> dict[str, Any]:
    phase = _phase(session)
    active = phase == "running"
    ended = phase in {"completedSuccess", "completedInterrupted", "error"}
    return {
        "phase": phase,
        "sessionEnded": ended,
        "canStop": active,
        "stopState": "stoppable" if active else "idle",
        "stopTargetKind": "assistant" if active else "unknown",
        "activeWorks": [],
        "lastError": None,
        "apiRetry": None,
    }


def session_to_config(session: Mapping[str, Any]) -> dict[str, Any]:
    selection = session.get("model_selection")
    selection = selection if isinstance(selection, Mapping) else {}
    provider = selection.get("provider_id") or selection.get("provider") or ""
    model = selection.get("model") or ""
    return {
        "provider": provider if isinstance(provider, str) else "",
        "model": model if isinstance(model, str) else "",
        "thought": selection.get("reasoning_effort", "") if isinstance(selection.get("reasoning_effort", ""), str) else "",
        "thoughtLevels": [],
        "followupMode": session.get("followup_mode") if session.get("followup_mode") in {"queue", "guide"} else "queue",
        "mode": session.get("mode") if session.get("mode") in {"build", "edit", "plan", "yolo"} else "build",
    }


def session_to_usage(session: Mapping[str, Any]) -> dict[str, Any]:
    totals = {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0}
    records = session.get("provider_usage")
    if isinstance(records, list):
        for record in records:
            if not isinstance(record, Mapping):
                continue
            usage = record.get("usage")
            if not isinstance(usage, Mapping):
                continue
            aliases = {
                "inputTokens": ("inputTokens", "input_tokens", "prompt_tokens"),
                "outputTokens": ("outputTokens", "output_tokens", "completion_tokens"),
                "cacheReadTokens": ("cacheReadTokens", "cache_read_tokens", "cache_read_input_tokens"),
                "cacheWriteTokens": ("cacheWriteTokens", "cache_write_tokens", "cache_creation_input_tokens"),
            }
            for target, keys in aliases.items():
                for key in keys:
                    value = usage.get(key)
                    if isinstance(value, (int, float)) and value >= 0:
                        totals[target] += value
                        break
    return {"contextWindow": None, "cumulative": totals}


def session_to_snapshot(session: Mapping[str, Any], *, log_epoch: str = "",
                        seq: int = 0, revision: int = 0, tail: int = MAX_ROWS,
                        before: int | None = None) -> dict[str, Any]:
    """Build the v4 snapshot fields backed by one journal read."""
    sid = session.get("id")
    if not isinstance(sid, str) or not sid:
        raise ValueError("session id is required")
    all_rows = session_to_rows(session, session_id=sid, tail=2**53 - 1)
    end = len(all_rows) if before is None else before
    if type(end) is not int or not 0 <= end <= len(all_rows):
        raise ValueError("invalid conversation page cursor")
    start = max(0, end - tail)
    rows = all_rows[start:end]
    from ..sessions.message_actions import revision as message_revision
    # Completion facts are local presentation metadata, not invented v4 row kinds.
    outcomes = []
    records = session.get("completion_history") or []
    records = [record for record in records if isinstance(record, Mapping)]
    completion = session.get("completion")
    if isinstance(completion, Mapping) and completion and completion not in records:
        records.append(completion)
    for turn in dict.fromkeys(row["turnId"] for row in rows):
        last = next(row for row in reversed(all_rows) if row["turnId"] == turn)
        if last not in rows:
            continue
        for index, record in enumerate(records[-200:]):
            if record.get("turn_id", all_rows[-1]["turnId"] if all_rows else "turn-1") != turn:
                continue
            outcomes.append({"afterRowId": last["rowId"], "turnId": turn,
                "id": f"completion:{turn}:{index}", "verified": record.get("verified") is True,
                "summary": _text(record.get("summary")), "status": record.get("status"),
                "toolExecutionStatus": record.get("tool_execution_status"),
                "deliveryStatus": record.get("delivery_status")})
    return {
        "protocolVersion": 1,
        "sessionId": sid,
        "logEpoch": log_epoch,
        "seq": seq,
        "revision": revision,
        "control": session_to_control(session),
        "config": session_to_config(session),
        "usage": session_to_usage(session),
        "rows": {"window": rows, "totalCount": len(all_rows),
                 "firstRowId": rows[0].get("rowId") if rows else None},
        "meta": {"rowOrder": [row["rowId"] for row in rows], "outcomes": outcomes,
                 "window": {"start": start, "end": end, "total": len(all_rows),
                            "hasOlder": start > 0, "olderCursor": start if start > 0 else None,
                            "messageRevision": message_revision(session),
                            "prefixRevision": hashlib.sha256(json.dumps(all_rows[:start], sort_keys=True,
                                ensure_ascii=True, separators=(",", ":")).encode("ascii")).hexdigest(),
                            "historyRevision": session.get("history_revision", 0)},
                 "pendingQuestion": _text(session.get("pending_question")) if end == len(all_rows) else ""},
    }


__all__ = [
    "MAX_ROWS", "session_to_config", "session_to_control", "session_to_rows",
    "session_to_snapshot", "session_to_usage",
]
