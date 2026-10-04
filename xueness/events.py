"""Xueness Event Protocol v1 — the harness's own session/tool event wire.

This module is the *source of truth* for timeline events. The legacy
``core.session_events`` shape (and the ZCode V4 conversation snapshot projected
from it) is a downgraded consumer, not the origin.

Design rules, all enforced by ``tests/test_events_v1.py`` against the frozen
golden file ``tools/protocol-v1-golden.json``:

* Pure derivation. Nothing here writes the journal or mutates the session.
* ``seq`` starts at 1 and is dense over the derived list, so a client can hand
  back ``nextCursor`` (== last seen ``seq``) and resume incrementally.
* Payloads carry truncated summaries, path/argv labels and ok/error flags only.
  File bodies and memory text never appear here.
* stdlib only.

See ``docs/xueness-event-protocol-v1.md`` for the frozen contract.
"""

from __future__ import annotations
import re

SCHEMA_EVENT = "xueness.event.v1"
SCHEMA_ENVELOPE = "xueness.events.v1"
PROTOCOL_VERSION = 1

#: Bound on how many events an unpaginated caller can pull in one response.
DEFAULT_LIMIT = 200
MAX_LIMIT = 500

_ERR_DENIED = "xueness.error.denied"
_ERR_CANCELLED = "xueness.error.cancelled"
_ERR_NOT_FOUND = "xueness.error.not_found"
_ERR_INVALID = "xueness.error.invalid_argument"
_ERR_TOOL_FAILED = "xueness.error.tool_failed"

#: Stable, documented error code used by the HTTP layer for bad query params.
ERROR_INVALID_ARGUMENT = _ERR_INVALID


def error_code(ok: bool, error: str) -> str:
    """Map a legacy ``(ok, error)`` pair to a stable v1 error code.

    Deterministic and order-sensitive: the first matching rule wins, exactly as
    section 4 of the contract specifies. Kept a pure function so both the
    derivation and the tests share one implementation.
    """
    if ok:
        return ""
    text = (error or "").strip().lower()
    if not text:
        return _ERR_TOOL_FAILED
    if text == "denied" or text.startswith("denied"):
        return _ERR_DENIED
    if "cancel" in text:
        # Covers both "cancelled" and "canceled".
        return _ERR_CANCELLED
    if "not found" in text or "no such" in text:
        return _ERR_NOT_FOUND
    if "invalid" in text or "required" in text:
        return _ERR_INVALID
    return _ERR_TOOL_FAILED


def _subject(name: str, arguments: str) -> str:
    """Short path/argv label for a tool call. Never file contents.

    Mirrors the legacy ``core._event_subject`` vocabulary so the v1 stream keeps
    the same readable subject for existing tools.
    """
    import json

    try:
        args = json.loads(arguments or "{}")
    except (ValueError, TypeError):
        return ""
    if not isinstance(args, dict):
        return ""
    if name in ("read", "list", "write", "edit"):
        subject = args.get("path", "")
    elif name in ("glob", "grep"):
        subject = args.get("path", ".")
    elif name == "exec":
        argv = args.get("argv", [])
        subject = (
            json.dumps(argv, ensure_ascii=False, separators=(",", ":"))
            if isinstance(argv, list) and all(isinstance(item, str) for item in argv)
            else ""
        )
    else:
        subject = ""
    return str(subject)[:200]


def derive_events(session: dict) -> list[dict]:
    """Deterministically derive the v1 event list from a stored session journal.

    Event order follows the journal: status, then per-message expansion
    (tool.call / tool.result / assistant.text / turn.user), then completion, then
    pending_question. ``seq`` is dense from 1 in that order.
    """
    session_id = str(session.get("id", ""))
    out: list[dict] = []

    def emit(event_type: str, **fields) -> None:
        event = {
            "schema": SCHEMA_EVENT,
            "seq": len(out) + 1,
            "sessionId": session_id,
            "type": event_type,
        }
        event.update(fields)
        out.append(event)

    emit(
        "session.status",
        status=session.get("status"),
        steps=session.get("steps", 0),
        mode=session.get("mode") or "",
    )

    results = session.get("results") or {}
    results = results if isinstance(results, dict) else {}
    subjects: dict = {}
    names: dict = {}
    messages = session.get("messages") or []
    turn = 1
    completion_history = session.get('completion_history')
    by_turn = {}
    if isinstance(completion_history, list):
        for record in completion_history[-200:]:
            if (isinstance(record, dict) and isinstance(record.get('turn_id'), str)
                    and re.fullmatch(r'turn-[1-9][0-9]*', record['turn_id'])):
                by_turn.setdefault(record['turn_id'], []).append(record)

    def emit_completion(record):
        evidence = record.get('evidence')
        count = record.get('evidence_count')
        fields = dict(verified=record.get('verified') is True,
                      summary=str(record.get('summary', ''))[:500],
                      evidenceCount=count if type(count) is int and count >= 0 else
                      len(evidence) if isinstance(evidence, list) else 0)
        optional = (
            ('status', 'status', ('verified', 'unverified', 'not_applicable')),
            ('tool_execution_status', 'toolExecutionStatus', ('succeeded', 'failed', 'incomplete', 'not_applicable')),
            ('delivery_status', 'deliveryStatus', ('passed', 'failed', 'not_assessed')),
        )
        for source, target, allowed in optional:
            if isinstance(record.get(source), str) and record[source] in allowed:
                fields[target] = record[source]
        if isinstance(record.get('turn_id'), str) and re.fullmatch(r'turn-[1-9][0-9]*', record['turn_id']):
            fields['turnId'] = record['turn_id']
        emit('session.completion', **fields)

    def settle_turn():
        for record in by_turn.get(f'turn-{turn}', ()):
            emit_completion(record)
    # The first user message is the task itself and is rendered separately, so
    # it never becomes a turn.user event; later user turns do.
    first_user_seen = False
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                function = call.get("function", {}) or {}
                name = str(function.get("name", ""))
                subject = _subject(name, function.get("arguments", ""))
                call_id = str(call.get("id", ""))
                subjects[call_id] = subject
                names[call_id] = name
                emit(
                    "tool.call",
                    turnId=f"turn-{turn}",
                    toolCallId=call_id,
                    name=name,
                    subject=subject,
                )
            if message.get("content"):
                emit(
                    "assistant.text",
                    turnId=f"turn-{turn}",
                    preview=str(message["content"])[:500],
                )
        elif role == "tool":
            call_id = str(message.get("tool_call_id", ""))
            result = results.get(call_id, {})
            ok = bool(result.get("ok")) if isinstance(result, dict) else False
            error = str(result.get("error", ""))[:120] if isinstance(result, dict) else ""
            emit(
                "tool.result",
                turnId=f"turn-{turn}",
                toolCallId=call_id,
                name=names.get(call_id, ""),
                subject=subjects.get(call_id, ""),
                ok=ok,
                errorCode=error_code(ok, error),
                error=error,
            )
        elif role == "user":
            if not first_user_seen:
                first_user_seen = True
                continue
            settle_turn()
            turn += 1
            content = message.get('content', '')
            if isinstance(content, list):
                content = '\n'.join(item['text'] for item in content
                                    if isinstance(item, dict) and item.get('type') == 'text'
                                    and isinstance(item.get('text'), str))
            emit("turn.user", turnId=f"turn-{turn}", preview=str(content)[:500])

    completion = session.get("completion")
    settle_turn()
    if isinstance(completion, dict) and completion and completion.get('turn_id') not in by_turn:
        emit_completion(completion)
    if session.get("pending_question"):
        emit("session.pending_question", question=str(session["pending_question"])[:1000])

    return out


def head_seq(events: list[dict]) -> int:
    """Highest ``seq`` in a derived list (0 when empty)."""
    return events[-1]["seq"] if events else 0


def page_events(session: dict, events: list[dict], cursor: int, limit: int) -> dict:
    """Build the v1 response envelope for a cursor/limit window.

    ``cursor`` is the last ``seq`` the client already has. ``head`` always
    reports the full derived list so the client can tell it is caught up.
    A ``cursor`` past ``head`` is not an error; it yields an empty page.
    """
    limit = max(1, min(int(limit), MAX_LIMIT))
    cursor = int(cursor)
    remaining = [event for event in events if event["seq"] > cursor]
    window = remaining[:limit]
    next_cursor = window[-1]["seq"] if window else cursor
    return {
        "schema": SCHEMA_ENVELOPE,
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": str(session.get("id", "")),
        "status": session.get("status"),
        "steps": session.get("steps", 0),
        "mode": session.get("mode") or "",
        "events": window,
        "cursor": cursor,
        "nextCursor": next_cursor,
        "head": head_seq(events),
        "hasMore": len(remaining) > len(window),
    }


def sse_body(events: list[dict]) -> bytes:
    """Render events as a Server-Sent Events body.

    Each event contributes ``id`` (its ``seq``, so a reconnecting client can
    resume), ``event`` (the type) and ``data`` (the JSON payload), followed by a
    blank line. Shared by the HTTP route so the JSON and SSE paths cannot drift.
    """
    import json

    chunks = []
    for event in events:
        chunks.append("id: " + str(event.get("seq", "")))
        chunks.append("event: " + str(event.get("type", "message")))
        chunks.append("data: " + json.dumps(event, ensure_ascii=False))
        chunks.append("")
    return ("\n".join(chunks) + "\n").encode() if chunks else b""
