"""Xueness runtime profiles and the versioned JSONL seam.

Durable session execution remains in the existing agent loop.  The optional
pi-lite sidecar uses this same data contract at its process boundary: a small
profile selector and strict, one-object-per-line frames.
The framing is Xueness-native; it is not the ZCode app-server wire protocol
(which omits ``jsonrpc`` and uses a different session/event contract). No state
document can name an import path or executable command.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Mapping, TypedDict

from ...resources import _atomic_write_json, _is_link


PROTOCOL_VERSION = 1
PROTOCOL_NAME = "xueness.runtime.v1"
STATE_FILENAME = "runtime-state.json"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_METHOD = re.compile(r"^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$")


# Keep this table immutable in spirit: callers receive copies from
# ``normalize_selection`` and cannot inject a module path or command.
_PROFILE_ROWS = {
    "zcode-full": {
        "profile": "zcode-full",
        "loop": "xueness-standard",
        "name": "完整工作台",
        "description": "Xueness 标准会话、工具、审批与事件工作台（完整协议适配档）。",
        "capabilities": ["xueness-app-server", "xueness-session", "xueness-events", "commands", "stream", "replay"],
        "compatibility": {"zcodeAppServer": False, "zcodeV4Events": False},
    },
    "pi-lite": {
        "profile": "pi-lite",
        "loop": "xueness-lightweight",
        "name": "轻量档位",
        "description": "Xueness 本地轻量 Agent loop，优先降低上下文与资源开销。",
        "capabilities": ["xueness-agent-loop", "tools", "stream", "replay", "xueness-local-sidecar"],
        "compatibility": {"piAgentCore": False, "deepseekHarness": False},
    },
}
PROFILES = tuple(_PROFILE_ROWS)


def provider_profile(profile: str) -> str:
    """Map a named mode to an existing Xueness provider loop.

    The mapping preserves the current product behavior during migration; it
    does not instantiate the ZCode or Pi runtimes named by the profile IDs.
    """
    normalize_selection(profile)
    return "lightweight" if profile == "pi-lite" else "standard"


class RuntimeRequest(TypedDict):
    version: int
    requestId: str
    sessionId: str
    method: str
    payload: dict[str, Any]


class RuntimeResponse(TypedDict, total=False):
    version: int
    requestId: str
    sessionId: str
    method: str
    payload: dict[str, Any]
    ok: bool
    error: dict[str, Any]


class StreamChunk(TypedDict, total=False):
    """Provider-neutral streaming chunk vocabulary."""

    type: str
    index: int
    text: str
    id: str
    name: str
    argumentsDelta: str
    block: Any
    usage: dict[str, Any]
    reason: str
    replayState: "ReplayEnvelope"


class ToolCall(TypedDict, total=False):
    """A tool call stays paired with its eventual completion status."""

    id: str
    name: str
    arguments: Any
    status: str
    result: Any


class ReplayEnvelope(TypedDict, total=False):
    """Opaque provider metadata with an explicit versioned outer shell."""

    version: int
    response: Any
    blocks: list[Any]


_STREAM_TYPES = frozenset({
    "block-start", "text-delta", "reasoning-delta", "tool-call-delta",
    "block-end", "usage", "finish", "error",
})
_TOOL_STATUSES = frozenset({"pending", "running", "completed", "failed", "cancelled"})


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _string(value: Any, label: str, *, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ValueError(f"{label} must be a non-empty string")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise ValueError(f"{label} has invalid format")
    return value


def _version(value: Any) -> int:
    if type(value) is not int or value != PROTOCOL_VERSION:
        raise ValueError(f"unsupported protocol version: {value!r}")
    return value


def validate_replay_envelope(value: Any) -> ReplayEnvelope:
    item = _object(value, "replay envelope")
    if set(item) - {"version", "response", "blocks"}:
        raise ValueError("unknown replay envelope fields")
    _version(item.get("version"))
    if "response" not in item:
        raise ValueError("replay envelope response is required")
    blocks = item.get("blocks")
    if blocks is not None and not isinstance(blocks, list):
        raise ValueError("replay envelope blocks must be an array")
    return item  # type: ignore[return-value]


def validate_stream_chunk(value: Any) -> StreamChunk:
    item = _object(value, "stream chunk")
    if set(item) - {"type", "index", "text", "id", "name", "argumentsDelta", "block", "usage", "reason", "replayState"}:
        raise ValueError("unknown stream chunk fields")
    kind = _string(item.get("type"), "stream chunk type")
    if kind not in _STREAM_TYPES:
        raise ValueError("unknown stream chunk type")
    if "index" in item and (type(item["index"]) is not int or item["index"] < 0):
        raise ValueError("stream chunk index must be a non-negative integer")
    if kind in {"text-delta", "reasoning-delta"} and not isinstance(item.get("text"), str):
        raise ValueError("text stream chunks require text")
    if kind == "tool-call-delta":
        _string(item.get("id"), "tool-call id")
        if "name" in item:
            _string(item["name"], "tool-call name")
        if not isinstance(item.get("argumentsDelta"), str):
            raise ValueError("tool-call chunks require argumentsDelta")
    if kind == "usage" and not isinstance(item.get("usage"), dict):
        raise ValueError("usage stream chunks require usage")
    if kind == "finish":
        _string(item.get("reason"), "finish reason")
        if "replayState" in item:
            validate_replay_envelope(item["replayState"])
    return item  # type: ignore[return-value]


def validate_tool_call(value: Any) -> ToolCall:
    item = _object(value, "tool call")
    if set(item) - {"id", "name", "arguments", "status", "result"}:
        raise ValueError("unknown tool call fields")
    _string(item.get("id"), "tool call id")
    _string(item.get("name"), "tool call name")
    if "arguments" not in item:
        raise ValueError("tool call arguments are required")
    if "status" in item and item["status"] not in _TOOL_STATUSES:
        raise ValueError("unknown tool call status")
    return item  # type: ignore[return-value]


def _validate_frame(value: Any, *, response: bool) -> dict[str, Any]:
    item = _object(value, "runtime response" if response else "runtime request")
    allowed = {"version", "requestId", "sessionId", "method", "payload"}
    if response:
        allowed |= {"ok", "error"}
    if set(item) - allowed:
        raise ValueError("unknown runtime frame fields")
    _version(item.get("version"))
    _string(item.get("requestId"), "requestId", pattern=_ID)
    _string(item.get("sessionId"), "sessionId", pattern=_ID)
    _string(item.get("method"), "method", pattern=_METHOD)
    if not isinstance(item.get("payload"), dict):
        raise ValueError("runtime frame payload must be an object")
    if response:
        if "ok" not in item or type(item["ok"]) is not bool:
            raise ValueError("runtime response ok must be boolean")
        if item["ok"] and "error" in item:
            raise ValueError("successful runtime response cannot include error")
        if not item["ok"] and "error" not in item:
            raise ValueError("failed runtime response requires error")
        if "error" in item:
            error = _object(item["error"], "runtime response error")
            if set(error) - {"code", "message", "details"}:
                raise ValueError("unknown runtime response error fields")
            _string(error.get("code"), "runtime error code", pattern=_METHOD)
            _string(error.get("message"), "runtime error message")
    return item


def validate_request(value: Any) -> RuntimeRequest:
    return _validate_frame(value, response=False)  # type: ignore[return-value]


def validate_response(value: Any) -> RuntimeResponse:
    return _validate_frame(value, response=True)  # type: ignore[return-value]


def encode_jsonl(value: Mapping[str, Any]) -> str:
    """Encode one strict protocol object and exactly one LF terminator."""
    if not isinstance(value, Mapping):
        raise ValueError("JSONL frame must be an object")
    try:
        encoded = json.dumps(dict(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("JSONL frame is not JSON-safe") from exc
    if "\n" in encoded or "\r" in encoded:
        raise ValueError("JSONL frame contains a line break")
    return encoded + "\n"


def decode_jsonl(line: str | bytes) -> dict[str, Any]:
    """Decode one line, rejecting blank/multi-line/non-object input."""
    if isinstance(line, bytes):
        try:
            line = line.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("JSONL frame must be UTF-8") from exc
    if not isinstance(line, str) or not line:
        raise ValueError("JSONL frame must contain exactly one line")
    raw = line[:-1] if line.endswith("\n") else line
    if "\n" in raw or "\r" in raw:
        raise ValueError("JSONL frame must contain exactly one line")
    if not raw.strip():
        raise ValueError("JSONL frame must not be blank")

    def reject_constant(value):
        raise ValueError(f"invalid JSON constant: {value}")

    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("JSON number is out of range")
        return parsed

    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate JSON field: {key}")
            value[key] = item
        return value

    try:
        value = json.loads(raw, parse_constant=reject_constant, parse_float=finite_float,
                           object_pairs_hook=unique_object)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError("invalid JSONL frame") from exc
    return _object(value, "JSONL frame")


def encode_request(value: RuntimeRequest) -> str:
    return encode_jsonl(validate_request(value))


def decode_request(line: str | bytes) -> RuntimeRequest:
    return validate_request(decode_jsonl(line))


def encode_response(value: RuntimeResponse) -> str:
    return encode_jsonl(validate_response(value))


def decode_response(line: str | bytes) -> RuntimeResponse:
    return validate_response(decode_jsonl(line))


def normalize_selection(profile: str) -> dict[str, Any]:
    """Return a safe profile selection; no mappings or module names are accepted."""
    if not isinstance(profile, str) or profile not in _PROFILE_ROWS:
        raise ValueError("profile must be one of: " + ", ".join(PROFILES))
    row = _PROFILE_ROWS[profile]
    return {"profile": row["profile"], "loop": row["loop"],
            "capabilities": list(row["capabilities"]),
            "compatibility": dict(row["compatibility"])}


def profile_rows(active: str | None = None) -> list[dict[str, Any]]:
    rows = []
    for profile in PROFILES:
        row = normalize_selection(profile)
        row = {"id": profile, "name": _PROFILE_ROWS[profile]["name"],
               "description": _PROFILE_ROWS[profile]["description"], **row}
        row["active"] = profile == active
        rows.append(row)
    return rows


def state_path(state_dir: Path | str) -> Path:
    state = Path(state_dir)
    if _is_link(state):
        raise ValueError("runtime state directory must not be a symlink or reparse point")
    state.mkdir(parents=True, exist_ok=True)
    path = state / STATE_FILENAME
    if _is_link(path):
        raise ValueError("runtime state must not be a symlink or reparse point")
    return path


def load_selection(state_dir: Path | str) -> str:
    path = state_path(state_dir)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return PROFILES[0]
    if len(raw) > 65536:
        raise ValueError("runtime state is too large")
    try:
        item = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("invalid runtime state") from exc
    item = _object(item, "runtime state")
    if set(item) - {"apiVersion", "profile"} or item.get("apiVersion") != PROTOCOL_VERSION:
        raise ValueError("invalid runtime state version")
    selection = normalize_selection(item.get("profile"))
    return selection["profile"]


def save_selection(state_dir: Path | str, profile: str) -> dict[str, Any]:
    selection = normalize_selection(profile)
    _atomic_write_json(state_path(state_dir), {"apiVersion": PROTOCOL_VERSION,
                                               "profile": selection["profile"]})
    return selection
