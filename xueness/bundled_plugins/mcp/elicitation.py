"""MCP elicitation (client capability ``elicitation/create``).

The switch is fail-closed. A server must set ``elicitation`` to exactly
``true`` before initialize advertises the capability. Anything else —
missing, false, or a string — leaves the capability off, and a server that
asks anyway receives a JSON-RPC error. No request is suspended.

While a tool call is in flight the server may send ``elicitation/create``.
The requested schema is the flat object from the 2025-06-18 spec: string
(optional format email/uri/date/date-time, minLength/maxLength), number or
integer (minimum/maximum), boolean, and string enum (enumNames). Nested
values, other types, password-like formats, and anything over the limits
below are declined. The diagnostic record stores a code and the server id,
never the schema body and never the operator's answer.

Answers exist only in the JSON-RPC result that is written back to that MCP
server. They are not copied into the session, the pending file, logs, or
diagnostics. Plan mode, subagents, workflows (including the expert
workflow), automation, the full-screen TUI, a non-interactive CLI, and
app-server turns decline immediately.
"""
from __future__ import annotations

import json
import math
import re
import sys
import threading
import time
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

from ...resources import _atomic_write_json, _is_link

ELICITATION_PROTOCOL = "2025-06-18"
USER_WAIT_SECONDS = 600.0

MAX_MESSAGE = 2000
MAX_PROPERTIES = 16
MAX_ENUM = 32
MAX_STRING = 4000
MAX_NAME = 64
MAX_TITLE = 120
MAX_DESCRIPTION = 400
MAX_ENUM_VALUE = 200
MAX_DIAGNOSTICS = 50
_CLI_ATTEMPTS = 5

_STRING_FORMATS = frozenset({"email", "uri", "date", "date-time"})
_PASSWORD_TOKENS = frozenset({
    "password", "secret", "token", "credential", "api-key", "apikey",
    "api_key", "passwd", "passphrase",
})
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}\Z")
_SESSION_RE = re.compile(r"[0-9a-f]{32}\Z")
_UNATTENDED_PREFIXES = (
    "xueness.bundled_plugins.workflows",
    "xueness.bundled_plugins.automation",
    "xueness.bundled_plugins.remote.app_server",
    "xueness.bundled_plugins.subagents",
    "xueness.bundled_plugins.sessions.cli_tui",
)
_CLI_MODULE = "xueness.bundled_plugins.sessions.cli"
_BENIGN_THREADS = frozenset({"xueness-browser-output"})

_LOCK = threading.RLock()
_PENDING: dict = {}
_DIAGNOSTICS: list = []


class _Waiter:
    def __init__(self, public: dict):
        self.public = public
        self.event = threading.Event()
        self.action = None
        self.content = None


def elicitation_enabled(server) -> bool:
    """True only for an explicit per-server opt-in."""
    return isinstance(server, dict) and server.get("elicitation") is True


def initialize_capabilities(server) -> dict:
    """Capabilities object for ``initialize``. Empty unless the switch is on."""
    if elicitation_enabled(server):
        return {"elicitation": {}}
    return {}


def bind_client(client, session, state_dir) -> None:
    """Point one live connection at the session that is allowed to answer."""
    client._elicitation_session = session if isinstance(session, dict) else None
    client._elicitation_state_dir = state_dir


def is_server_request(message) -> bool:
    """A JSON-RPC request the server expects us to answer (not a notification)."""
    if not isinstance(message, dict) or not isinstance(message.get("method"), str):
        return False
    ident = message.get("id")
    if isinstance(ident, bool) or ident is None:
        return False
    if isinstance(ident, int):
        return True
    return isinstance(ident, str) and 1 <= len(ident) <= 128 and all(32 <= ord(ch) < 127 for ch in ident)


def reset_state() -> None:
    """Drop in-memory waiters. Tests call this so a failed wait cannot linger."""
    with _LOCK:
        waiters = list(_PENDING.values())
        _PENDING.clear()
        _DIAGNOSTICS.clear()
    for waiter in waiters:
        waiter.content = None
        waiter.action = "cancel"
        waiter.event.set()


def diagnostics():
    """Recent codes only. Safe to serialize: no schemas and no answers."""
    with _LOCK:
        return [dict(item) for item in _DIAGNOSTICS]


def pending_public(session_id):
    """The request the UI may render, or None. Never includes an answer."""
    with _LOCK:
        waiter = _PENDING.get(session_id)
        if waiter is None or waiter.event.is_set():
            return None
        return _public_copy(waiter.public)


def resolve(session_id, rpc_id, action, content=None):
    """Record the operator's choice for a waiting request.

    Returns ``ok``, ``missing``, ``mismatch``, or ``(invalid, code, field)``.
    Invalid content is not retained. The successful return value does not
    include the content; only the waiting tool-call thread reads it, and only
    so it can hand that JSON-RPC result to the MCP server.
    """
    if action not in ("accept", "decline", "cancel"):
        return ("invalid", "action", None)
    with _LOCK:
        waiter = _PENDING.get(session_id)
        if waiter is None or waiter.event.is_set():
            return "missing"
        if waiter.public.get("id") != rpc_id:
            return "mismatch"
        if action == "accept":
            clean, code, field = validate_content(waiter.public.get("requestedSchema"), content)
            if code:
                return ("invalid", code, field)
            waiter.content = clean
        else:
            waiter.content = None
        waiter.action = action
        waiter.event.set()
        return "ok"


def response_for(client, message):
    """Build the JSON-RPC response for one server request. Never raises."""
    try:
        return _response_for(client, message)
    except Exception:
        _note(_server_id(getattr(client, "server", None)), "internal")
        ident = message.get("id") if isinstance(message, dict) else None
        if not is_server_request(message):
            return None
        return _rpc_result(ident, "decline")


def classify_audience(session, *, modules, thread_name, stdin_is_tty, state_dir):
    """``web``, ``cli``, or ``unattended``. Unknown contexts are unattended."""
    if _session_unattended(session) or _thread_unattended(thread_name) or _modules_unattended(modules):
        return "unattended"
    if _CLI_MODULE in modules:
        return "cli" if stdin_is_tty else "unattended"
    sid = session.get("id") if isinstance(session, dict) else None
    if isinstance(sid, str) and _SESSION_RE.fullmatch(sid) and state_dir is not None:
        return "web"
    return "unattended"


def prompt_cli(schema, message, server_name, read_line, write):
    """Ask for each field on the line-oriented CLI. ``/decline`` and ``/cancel`` stop.

    The prompts name the field. The value the operator types is not printed
    back and is not written anywhere except the returned content object.
    """
    write("MCP server %s is asking for a few details." % server_name)
    write("不要在这里填写密码或密钥。 Do not enter a password or secret.")
    write(message)
    write("Enter /decline to refuse or /cancel to dismiss.")
    content = {}
    required = set(schema.get("required") or [])
    for name, spec in schema.get("properties", {}).items():
        label = spec.get("title") or name
        for _attempt in range(_CLI_ATTEMPTS):
            raw = read_line(_field_prompt(label, spec))
            if raw is None:
                return "cancel", None
            command = raw.strip().lower()
            if command == "/decline":
                return "decline", None
            if command == "/cancel":
                return "cancel", None
            if raw == "" and name not in required:
                break
            parsed = _parse_cli_value(spec, raw)
            if parsed is None:
                write("That value does not match this field. Try again.")
                continue
            content[name] = parsed
            break
        else:
            return "cancel", None
    clean, code, _field = validate_content(schema, content)
    if code:
        return "cancel", None
    return "accept", clean


def validate_requested(params):
    """Return ``(schema, message, None)`` or ``(None, None, code)``."""
    if not isinstance(params, dict):
        return None, None, "invalid_schema"
    message = params.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE:
        return None, None, "over_limit" if isinstance(message, str) and len(message) > MAX_MESSAGE else "invalid_schema"
    if any(ord(ch) < 32 and ch not in "\n\t" or ord(ch) == 127 for ch in message):
        return None, None, "invalid_schema"
    schema = params.get("requestedSchema")
    normalized, code = _normalize_schema(schema)
    if code:
        return None, None, code
    return normalized, message, None


def validate_content(schema, content):
    """Return ``(clean, None, None)`` or ``(None, code, field)``."""
    if not isinstance(schema, dict) or not isinstance(content, dict):
        return None, "type", None
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None, "type", None
    required = schema.get("required") or []
    clean = {}
    for name, spec in properties.items():
        if name not in content:
            if name in required:
                return None, "required", name
            continue
        value = content[name]
        if value is None:
            return None, "type", name
        checked, code = _check_value(spec, value)
        if code:
            return None, code, name
        clean[name] = checked
    extra = [key for key in content if key not in properties]
    if extra:
        field = extra[0] if isinstance(extra[0], str) and len(extra[0]) <= MAX_NAME else None
        return None, "unexpected", field
    return clean, None, None


def dispatch(method, parts, query, data, ctx):
    """``GET/POST /api/sessions/<id>/elicitation``. Host checks happen in the host."""
    if len(parts) != 4 or parts[:2] != ["api", "sessions"] or parts[3] != "elicitation":
        return None
    session_id = parts[2]
    if not isinstance(session_id, str) or not _SESSION_RE.fullmatch(session_id):
        return 404, {"error": "session not found"}
    if method == "GET":
        public = pending_public(session_id)
        if public is None:
            _delete_public(ctx.get("state_dir"), session_id)
        return 200, {"pending": public}
    if method != "POST":
        return 405, {"error": "method not allowed"}
    if not isinstance(data, dict):
        return 400, {"error": "invalid elicitation response"}
    action = data.get("action")
    outcome = resolve(session_id, data.get("id"), action, data.get("content"))
    if outcome == "ok":
        return 200, {"ok": True, "action": action}
    if outcome == "missing":
        return 409, {"error": "no elicitation is waiting"}
    if outcome == "mismatch":
        return 409, {"error": "elicitation request mismatch"}
    _code, code, field = outcome
    body = {"error": "invalid elicitation content", "code": code}
    if isinstance(field, str):
        body["field"] = field
    return 400, body


# --- schema -----------------------------------------------------------------


def _normalize_schema(schema):
    if not isinstance(schema, dict):
        return None, "invalid_schema"
    allowed_root = {"type", "properties", "required", "additionalProperties", "title", "description"}
    if set(schema) - allowed_root:
        return None, "invalid_schema"
    if schema.get("type") != "object":
        return None, "invalid_schema"
    if "additionalProperties" in schema and schema.get("additionalProperties") is not False:
        return None, "invalid_schema"
    properties = schema.get("properties")
    if not isinstance(properties, dict) or len(properties) > MAX_PROPERTIES:
        return None, "over_limit" if isinstance(properties, dict) else "invalid_schema"
    normalized = {}
    for name, spec in properties.items():
        if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
            return None, "invalid_schema"
        if _password_token(name):
            return None, "password_format"
        field, code = _normalize_field(spec)
        if code:
            return None, code
        normalized[name] = field
    required = schema.get("required", [])
    if required is None:
        required = []
    if not isinstance(required, list) or len(required) > len(normalized):
        return None, "invalid_schema"
    seen = set()
    for item in required:
        if not isinstance(item, str) or item not in normalized or item in seen:
            return None, "invalid_schema"
        seen.add(item)
    public = {"type": "object", "properties": normalized, "required": list(required)}
    for key, limit in (("title", MAX_TITLE), ("description", MAX_DESCRIPTION)):
        if key not in schema:
            continue
        text = schema.get(key)
        if not isinstance(text, str) or not text.strip() or len(text) > limit:
            return None, "over_limit" if isinstance(text, str) and len(text) > limit else "invalid_schema"
        public[key] = text
    return public, None


def _normalize_field(spec):
    if not isinstance(spec, dict):
        return None, "invalid_schema"
    title = spec.get("title")
    if isinstance(title, str) and _password_token(title):
        return None, "password_format"
    kind = spec.get("type")
    if kind == "string" and "enum" in spec:
        return _normalize_enum(spec)
    if kind == "string":
        return _normalize_string(spec)
    if kind in ("number", "integer"):
        return _normalize_number(spec, kind)
    if kind == "boolean":
        return _normalize_boolean(spec)
    return None, "invalid_schema"


def _shared_text(spec, allowed):
    if set(spec) - allowed:
        return None, "invalid_schema"
    extra = {}
    for key, limit in (("title", MAX_TITLE), ("description", MAX_DESCRIPTION)):
        if key not in spec:
            continue
        text = spec.get(key)
        if not isinstance(text, str) or not text.strip() or len(text) > limit:
            return None, "over_limit" if isinstance(text, str) and len(text) > limit else "invalid_schema"
        extra[key] = text
    return extra, None


def _normalize_string(spec):
    extra, code = _shared_text(spec, {"type", "title", "description", "format", "minLength", "maxLength"})
    if code:
        return None, code
    field = {"type": "string", **extra}
    if "format" in spec:
        fmt = spec.get("format")
        if not isinstance(fmt, str):
            return None, "invalid_schema"
        if _password_token(fmt) or "password" in fmt.casefold():
            return None, "password_format"
        if fmt not in _STRING_FORMATS:
            return None, "invalid_schema"
        field["format"] = fmt
    bounds, code = _length_bounds(spec)
    if code:
        return None, code
    field.update(bounds)
    return field, None


def _normalize_enum(spec):
    extra, code = _shared_text(spec, {"type", "title", "description", "enum", "enumNames"})
    if code:
        return None, code
    values = spec.get("enum")
    if not isinstance(values, list) or not values or len(values) > MAX_ENUM:
        return None, "over_limit" if isinstance(values, list) else "invalid_schema"
    clean = []
    for item in values:
        if not isinstance(item, str) or not item or len(item) > MAX_ENUM_VALUE or item in clean:
            return None, "over_limit" if isinstance(item, str) and len(item) > MAX_ENUM_VALUE else "invalid_schema"
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in item):
            return None, "invalid_schema"
        clean.append(item)
    field = {"type": "string", "enum": clean, **extra}
    if "enumNames" in spec:
        names = spec.get("enumNames")
        if not isinstance(names, list) or len(names) != len(clean):
            return None, "invalid_schema"
        labels = []
        for item in names:
            if not isinstance(item, str) or not item.strip() or len(item) > MAX_ENUM_VALUE:
                return None, "over_limit" if isinstance(item, str) and len(item) > MAX_ENUM_VALUE else "invalid_schema"
            labels.append(item)
        field["enumNames"] = labels
    return field, None


def _normalize_number(spec, kind):
    extra, code = _shared_text(spec, {"type", "title", "description", "minimum", "maximum"})
    if code:
        return None, code
    field = {"type": kind, **extra}
    bounds = {}
    for key in ("minimum", "maximum"):
        if key not in spec:
            continue
        number = _finite_number(spec.get(key))
        if number is None or abs(number) > 1e12:
            return None, "over_limit" if _finite_number(spec.get(key)) is not None else "invalid_schema"
        bounds[key] = number
    if "minimum" in bounds and "maximum" in bounds and bounds["minimum"] > bounds["maximum"]:
        return None, "invalid_schema"
    field.update(bounds)
    return field, None


def _normalize_boolean(spec):
    extra, code = _shared_text(spec, {"type", "title", "description"})
    if code:
        return None, code
    return {"type": "boolean", **extra}, None


def _length_bounds(spec):
    bounds = {}
    for key in ("minLength", "maxLength"):
        if key not in spec:
            continue
        value = spec.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_STRING:
            return None, "over_limit" if isinstance(value, int) and not isinstance(value, bool) and value > MAX_STRING else "invalid_schema"
        bounds[key] = value
    if bounds.get("minLength", 0) > bounds.get("maxLength", MAX_STRING):
        return None, "invalid_schema"
    return bounds, None


def _check_value(spec, value):
    kind = spec.get("type")
    if "enum" in spec:
        if not isinstance(value, str) or value not in spec["enum"]:
            return None, "enum"
        return value, None
    if kind == "string":
        if not isinstance(value, str) or "\x00" in value:
            return None, "type"
        if len(value) < spec.get("minLength", 0) or len(value) > spec.get("maxLength", MAX_STRING):
            return None, "length"
        fmt = spec.get("format")
        if fmt and not _format_ok(fmt, value):
            return None, "format"
        return value, None
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None, "type"
        if kind == "integer" and not isinstance(value, int):
            return None, "type"
        number = int(value) if kind == "integer" else float(value) if isinstance(value, float) else value
        if "minimum" in spec and number < spec["minimum"]:
            return None, "range"
        if "maximum" in spec and number > spec["maximum"]:
            return None, "range"
        return number, None
    if kind == "boolean":
        if not isinstance(value, bool):
            return None, "type"
        return value, None
    return None, "type"


def _format_ok(fmt, value) -> bool:
    if not value:
        return False
    if fmt == "email":
        if len(value) > 254 or any(ch.isspace() for ch in value) or value.count("@") != 1:
            return False
        local, _, domain = value.partition("@")
        return bool(local and domain and "." in domain and not domain.startswith(".") and not domain.endswith("."))
    if fmt == "uri":
        if any(ch.isspace() for ch in value):
            return False
        parts = urlsplit(value)
        return bool(parts.scheme and re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", parts.scheme) and (parts.netloc or parts.path))
    if fmt == "date":
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            return False
        return parsed.isoformat() == value
    if fmt == "date-time":
        text = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            datetime.fromisoformat(text)
        except ValueError:
            return False
        return True
    return False


def _parse_cli_value(spec, raw):
    if "enum" in spec:
        if raw in spec["enum"]:
            return raw
        if raw.isdigit():
            index = int(raw) - 1
            values = spec["enum"]
            if 0 <= index < len(values):
                return values[index]
        return None
    kind = spec.get("type")
    if kind == "boolean":
        token = raw.strip().lower()
        if token in ("y", "yes", "true", "1"):
            return True
        if token in ("n", "no", "false", "0"):
            return False
        return None
    if kind == "integer":
        try:
            if isinstance(raw, str) and (raw.startswith("+") or "." in raw or raw.lower().startswith(("nan", "inf"))):
                return None
            return int(raw.strip())
        except (TypeError, ValueError):
            return None
    if kind == "number":
        try:
            number = float(raw.strip())
        except (TypeError, ValueError):
            return None
        if not math.isfinite(number):
            return None
        return number
    if kind == "string":
        return raw
    return None


def _field_prompt(label, spec) -> str:
    if "enum" in spec:
        labels = spec.get("enumNames") or spec["enum"]
        choices = ", ".join("%d) %s" % (index + 1, name) for index, name in enumerate(labels))
        return "%s [%s]: " % (label, choices)
    if spec.get("type") == "boolean":
        return "%s [y/n]: " % label
    return "%s: " % label


# --- audience and transport -------------------------------------------------


def _response_for(client, message):
    if not is_server_request(message):
        return None
    ident = message.get("id")
    server = getattr(client, "server", None)
    server_id = _server_id(server)
    if message.get("method") != "elicitation/create":
        _note(server_id, "unsupported")
        return _rpc_error(ident, -32601, "method not found")
    if not elicitation_enabled(server):
        _note(server_id, "disabled")
        return _rpc_error(ident, -32601, "elicitation is disabled")
    schema, message_text, code = validate_requested(message.get("params"))
    if code:
        _note(server_id, code)
        return _rpc_result(ident, "decline")
    session = getattr(client, "_elicitation_session", None)
    state_dir = getattr(client, "_elicitation_state_dir", None)
    audience = classify_audience(
        session,
        modules=_stack_modules(),
        thread_name=threading.current_thread().name,
        stdin_is_tty=_stdin_is_tty(),
        state_dir=state_dir,
    )
    if audience == "unattended":
        _note(server_id, "unattended")
        return _rpc_result(ident, "decline")
    if audience == "cli":
        action, content = prompt_cli(schema, message_text, _server_name(server), input, _write_cli)
        if action != "accept":
            _note(server_id, "declined" if action == "decline" else "cancelled")
        return _rpc_result(ident, action, content if action == "accept" else None)
    session_id = session.get("id")
    public = {
        "id": ident,
        "serverId": server_id,
        "serverName": _server_name(server),
        "message": message_text,
        "requestedSchema": schema,
        "expiresAt": int(time.time() + USER_WAIT_SECONDS),
    }
    action, content = _wait(session_id, state_dir, public, USER_WAIT_SECONDS)
    if action == "timeout":
        _note(server_id, "timeout")
        action = "cancel"
    elif action in ("decline", "cancel"):
        _note(server_id, "declined" if action == "decline" else "cancelled")
    return _rpc_result(ident, action if action in ("accept", "decline", "cancel") else "cancel",
                       content if action == "accept" else None)


def _wait(session_id, state_dir, public, timeout):
    waiter = _Waiter(public)
    with _LOCK:
        current = _PENDING.get(session_id)
        if current is not None and not current.event.is_set():
            _note(public.get("serverId") or "", "busy")
            return "decline", None
        _PENDING[session_id] = waiter
    _write_public(state_dir, session_id, public)
    try:
        signaled = waiter.event.wait(timeout)
        with _LOCK:
            action = waiter.action
            content = waiter.content
            waiter.content = None
        if not signaled or action not in ("accept", "decline", "cancel"):
            return "timeout", None
        return action, content
    finally:
        with _LOCK:
            if _PENDING.get(session_id) is waiter:
                _PENDING.pop(session_id, None)
        _delete_public(state_dir, session_id)


def _session_unattended(session) -> bool:
    if not isinstance(session, dict):
        return True
    if session.get("permission_mode") == "plan" or session.get("mode") == "plan":
        return True
    if session.get("read_only") is True or session.get("parent"):
        return True
    sid = session.get("id")
    return isinstance(sid, str) and sid.startswith("sub-")


def _thread_unattended(name) -> bool:
    return isinstance(name, str) and name.startswith("xueness-") and name not in _BENIGN_THREADS


def _modules_unattended(modules) -> bool:
    for name in modules:
        if any(name == prefix or name.startswith(prefix + ".") for prefix in _UNATTENDED_PREFIXES):
            return True
    return False


def _stack_modules():
    import inspect
    names = []
    for frame in inspect.stack():
        names.append(frame.frame.f_globals.get("__name__") or "")
    return names


def _stdin_is_tty() -> bool:
    try:
        return bool(sys.stdin.isatty())
    except Exception:
        return False


def _write_cli(text) -> None:
    print(text, file=sys.stderr)


def _password_token(value) -> bool:
    token = value.casefold().replace(" ", "").replace("-", "").replace("_", "")
    folded = value.casefold()
    if folded in _PASSWORD_TOKENS or token in {item.replace("-", "").replace("_", "") for item in _PASSWORD_TOKENS}:
        return True
    return "password" in folded or "passwd" in folded or "passphrase" in folded


def _finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    return float(value) if isinstance(value, float) else value


def _server_id(server) -> str:
    if isinstance(server, dict) and isinstance(server.get("id"), str):
        return server["id"][:MAX_NAME]
    return ""


def _server_name(server) -> str:
    raw = ""
    if isinstance(server, dict):
        candidate = server.get("name")
        if not isinstance(candidate, str) or not candidate.strip():
            candidate = server.get("id")
        if isinstance(candidate, str):
            raw = candidate
    cleaned = "".join(ch for ch in raw if ch >= " " and ch != "\x7f").strip()
    return cleaned[:120] or "MCP"


def _public_copy(public) -> dict:
    return {
        "id": public.get("id"),
        "serverId": public.get("serverId"),
        "serverName": public.get("serverName"),
        "message": public.get("message"),
        "requestedSchema": public.get("requestedSchema"),
        "expiresAt": public.get("expiresAt"),
    }


def _pending_path(state_dir, session_id):
    if state_dir is None or not _SESSION_RE.fullmatch(session_id):
        return None
    root = Path(state_dir)
    directory = root / "mcp-elicitations"
    path = directory / (session_id + ".json")
    if _is_link(root) or _is_link(directory) or _is_link(path):
        return None
    return path


def _write_public(state_dir, session_id, public) -> None:
    path = _pending_path(state_dir, session_id)
    if path is None:
        return
    try:
        _atomic_write_json(path, _public_copy(public))
    except (OSError, ValueError):
        return


def _delete_public(state_dir, session_id) -> None:
    path = _pending_path(state_dir, session_id)
    if path is None or not path.exists():
        return
    try:
        path.unlink()
    except OSError:
        return


def _note(server_id, code) -> None:
    if not isinstance(code, str) or not code:
        return
    row = {"at": int(time.time()), "serverId": str(server_id or "")[:MAX_NAME], "code": code[:64]}
    with _LOCK:
        _DIAGNOSTICS.append(row)
        del _DIAGNOSTICS[:-MAX_DIAGNOSTICS]


def _rpc_result(ident, action, content=None):
    result = {"action": action}
    if action == "accept":
        result["content"] = content if isinstance(content, dict) else {}
    return {"jsonrpc": "2.0", "id": ident, "result": result}


def _rpc_error(ident, code, message):
    return {"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}}
