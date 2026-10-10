"""Xueness local Web UI (loopback-only MVP, stdlib only).

Serves a single self-contained page plus a small JSON API. The server binds
127.0.0.1 only, validates Host/Origin against loopback, requires a
same-origin CSRF token for every state-changing method, and never takes
blanket allow-write/allow-edit/allow-exec from the browser. Writes, edits,
and subprocesses run only after an explicit per-action approval that is
consumed on first use. Request intake is bounded: an oversized body is 413,
a stalled header or body is 408, and every gateway failure is a JSON object
with ``error``, ``code``, and ``status``.

Real providers are never reachable with a key sent over HTTP: the ``real``
option selects a model configured on the server. The server enables online
runs by default; ``XUENESS_ALLOW_REAL=0`` disables them explicitly.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import mimetypes
import os
import secrets
import socket
import threading
import traceback
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .bundled_plugins.sessions.plan_mode import (
    is_permission_mode, is_remote_exec_subject, permission_mode_error,
)
from .core import (
    BINARY_PREVIEW_SUFFIXES, Store, answer_session, append_user_turn, call_mcp, execute,
    mcp_subject, path_in, record_approval, run, session_events, workspace_files,
    workspace_image_preview, workspace_preview,
)
from .core import KNOWN_TOOLS as _core_known_tools
from .core import parse_disallow_list as _core_parse_disallow_list
from .plugins import activate
from . import plugin_sdk, task_registry
from . import events as events_protocol, session_management, provider_config, plugin_runtime
from .session_lease import lease
from .http_contract import HANDLED_RESPONSE, normalize_error

HOST = "127.0.0.1"
DEFAULT_PORT = 8137
#: Env override for container runtimes. Non-loopback binds require
#: XUENESS_ALLOW_REMOTE=1 (explicit opt-in); otherwise startup refuses.
#: Inside Docker the app binds 0.0.0.0 *in the container net namespace* while
#: compose publishes only on host 127.0.0.1, so the host surface stays loopback.
HOST_ENV = "XUENESS_HOST"
ALLOW_REMOTE_ENV = "XUENESS_ALLOW_REMOTE"
import re as _re

_SID_PATTERN = _re.compile(r"[0-9a-f]{32}")
_MAX_BODY = 1_000_000
_MAX_COMPOSER_BODY = 6_000_000
_MAX_TASK = 5000
# Idle and absolute limits for reading a request. They bound a slow client
# that trickles bytes; they are not applied to the handler once the body has
# been accepted. A long model run does not touch the socket until it replies.
_HEADER_IDLE_SECONDS = 15
_HEADER_DEADLINE_SECONDS = 20
_BODY_IDLE_SECONDS = 15
_BODY_DEADLINE_SECONDS = 30
_RESPONSE_IDLE_SECONDS = 60
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_ALLOWED_FETCH_SITES = frozenset({"none", "same-origin"})
# Fixed phrases only. Protocol errors must not echo the request line.
_PROTOCOL_ERRORS = {
    400: ("bad_request", "bad request"),
    408: ("request_timeout", "request timed out"),
    411: ("length_required", "Content-Length is required"),
    413: ("payload_too_large", "request body is too large"),
    414: ("uri_too_long", "request uri too long"),
    417: ("expectation_failed", "Expect is not supported"),
    431: ("request_header_fields_too_large", "request headers are too large"),
    500: ("internal_error", "internal error"),
    501: ("not_implemented", "method not implemented"),
    505: ("http_version_not_supported", "http version not supported"),
}

# Vite copies ``public/`` to the dist root by original filename. These are the
# only root-level files the server will serve, with their content types; an
# allowlist rather than a directory listing keeps this from turning into a
# general file server.
_ROOT_STATIC_FILES = {
    "/xueness-mark.svg": ("xueness-mark.svg", "image/svg+xml"),
    "/favicon.ico": ("favicon.ico", "image/x-icon"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon_512@2x.png": ("icon_512@2x.png", "image/png"),
    "/third-party-notices.txt": ("third-party-notices.txt", "text/plain; charset=utf-8"),
}


def _valid_sid(value: str) -> bool:
    return bool(_SID_PATTERN.fullmatch(value or ""))


def _loopback_host(hostname: str) -> bool:
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _split_host(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if value.startswith("["):  # [::1]:port
        return value[1:].split("]", 1)[0]
    if value.count(":") == 1:  # host:port
        return value.rsplit(":", 1)[0]
    if ":" in value:  # bare IPv6 literal without brackets
        return value
    return value


def _origin_authority(raw: str):
    """Loopback origin as ``(hostname, port)``, or None when it is not usable.

    A path or query on Referer is normal. Userinfo, a non-loopback host, an
    explicit port of 0, and control characters are not. Port 0 must not fall
    through to the scheme default, or ``Host: 127.0.0.1:0`` would compare
    equal to ``http://127.0.0.1``.
    """
    if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw):
        return None
    try:
        parsed = urllib.parse.urlsplit(raw.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.username is not None or parsed.password is not None or "%" in parsed.hostname:
        return None
    if not _loopback_host(parsed.hostname):
        return None
    try:
        parsed_port = parsed.port
    except ValueError:
        return None
    if parsed_port is None:
        port = 443 if parsed.scheme == "https" else 80
    elif 1 <= parsed_port <= 65535:
        port = parsed_port
    else:
        return None
    return parsed.hostname.lower(), port


def _header_values(headers, name) -> list:
    values = headers.get_all(name) if hasattr(headers, "get_all") else None
    if values is None:
        raw = headers.get(name) if hasattr(headers, "get") else None
        return [] if raw is None else [raw]
    return list(values)


def _origin_ok(headers) -> bool:
    hosts = _header_values(headers, "Host")
    if len(hosts) != 1:
        return False
    expected = _parse_authority(hosts[0])
    if expected is None:
        return False
    for key in ("Origin", "Referer"):
        values = _header_values(headers, key)
        if len(values) > 1:
            return False
        if not values or not values[0]:
            continue
        if _origin_authority(values[0]) != expected:
            return False
    return True


def _parse_authority(value: str):
    value = (value or "").strip()
    if (not value or any(char in value for char in " /\\?#@\t\r\n%")
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        return None
    try:
        parsed = urllib.parse.urlsplit("//" + value)
    except ValueError:
        return None
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment):
        return None
    hostname = parsed.hostname.lower()
    if not _loopback_host(hostname):
        return None
    if value.startswith("["):
        end = value.find("]")
        rest = value[end + 1:] if end != -1 else ""
        has_port = rest.startswith(":")
    else:
        has_port = ":" in value
    if not has_port:
        return hostname, 80
    try:
        parsed_port = parsed.port
    except ValueError:
        return None
    if parsed_port is None or not 1 <= parsed_port <= 65535:
        return None
    return hostname, parsed_port


def _host_ok(headers) -> bool:
    # ``get`` returns only the first value. A second Host must not be ignored.
    values = _header_values(headers, "Host")
    return len(values) == 1 and _parse_authority(values[0]) is not None


def _fetch_site_ok(headers) -> bool:
    """Browsers tag cross-site loopback calls; non-browser clients omit the header.

    ``Sec-Fetch-Site`` is a forbidden request header, so page script cannot
    clear a ``cross-site`` or ``same-site`` value. The app is served from this
    origin, so ``same-origin`` and ``none`` (address-bar navigation) stay.
    Another port on 127.0.0.1 is ``same-site`` and must not archive or mark
    sessions via a side-effecting GET. A second header is not folded away.
    """
    values = _header_values(headers, "Sec-Fetch-Site")
    if not values:
        return True
    if len(values) != 1:
        return False
    return values[0].strip().lower() in _ALLOWED_FETCH_SITES


class _RequestRejected(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class _IntakeDeadline:
    """Stop a trickling read without closing the write side of the socket.

    Shutting the socket down completely would also drop the 408 response.
    ``SHUT_RD`` unblocks ``recv`` and still lets the handler write the status.
    The same call is used on Windows and POSIX; there is no second platform path.
    """

    def __init__(self, connection, seconds: float):
        self.expired = threading.Event()
        self._connection = connection
        self._timer = threading.Timer(max(0.0, float(seconds)), self._expire)
        self._timer.daemon = True
        self._timer.start()

    def _expire(self):
        self.expired.set()
        try:
            self._connection.shutdown(socket.SHUT_RD)
        except OSError:
            pass

    def cancel(self):
        self._timer.cancel()


KNOWN_TOOLS = _core_known_tools
parse_disallow_list = _core_parse_disallow_list


class WebGate:
    """Deny-by-default gate with one-shot explicit approvals.

    ``approvals`` maps session id -> {"write": {id: subject}, "edit": {...},
    "exec": {...}, "mcp": {...}}. Approvals are bound to pending denied tool-call
    IDs. Plan mode denies write/edit/exec/mcp before any approval lookup; build
    keeps deny-by-default.

    ``permission_mode`` adds the operator-facing modes: ``edit`` and ``yolo``
    widen the named kinds, while ``plan`` is read-only except for the session's
    own plan draft file. ``plan_draft`` is that policy -- contributed by the
    sessions plugin, exposing ``matches(subject)``, ``denial(kind)`` and
    ``path`` -- so the host gate holds no plan business logic of its own.

    ``session`` is optional and used only to audit the decision: consuming an
    approval without a trace makes it impossible to answer "who authorised
    this?" after the fact.
    """

    web_approval_gate = True

    def __init__(self, root: Path, session_id: str, approvals: dict, lock: threading.Lock,
                 mode: str = "build", disallow=(), session: dict | None = None,
                 permission_mode: str = "build", plan_draft=None):
        if mode not in ("plan", "build"):
            raise ValueError("mode must be 'plan' or 'build'")
        if not is_permission_mode(permission_mode):
            raise ValueError(permission_mode_error())
        self.root = Path(root).resolve()
        self.session_id = session_id
        self.approvals = approvals
        self.lock = lock
        self.mode = mode
        self.disallow = frozenset(disallow or ())
        self.session = session
        self.permission_mode = permission_mode
        self.plan_draft = plan_draft

    def plan_draft_target(self, subject) -> Path | None:
        """计划模式下工作区外唯一可写目标：本会话绑定的计划草稿文件。"""
        if self.permission_mode != "plan" or self.plan_draft is None:
            return None
        return Path(self.plan_draft.path) if self.plan_draft.matches(subject) else None

    def check(self, kind: str, subject: str, tool_call_id: str | None = None) -> None:
        self._check(kind, subject, tool_call_id)
        from .tool_contract import notify_tool_authorized
        notify_tool_authorized(kind, subject, tool_call_id)

    def _check(self, kind: str, subject: str, tool_call_id: str | None = None) -> None:
        draft = self.plan_draft_target(subject) if kind in ("write", "edit") else None
        if kind in ("read", "list", "write", "edit", "glob", "grep"):
            # The session plan draft lives in the state directory by design, so
            # the workspace jail cannot contain it; only plan mode may name it.
            if draft is None:
                path_in(self.root, subject)
        else:
            from .tool_registry import REGISTRY
            known = {tool.gate_kind for tool in REGISTRY} | {"mcp", "planning"}
            if kind not in known:
                raise PermissionError(f"{kind} is not a known tool")
        if kind in self.disallow:
            raise PermissionError(f"{kind} is disallowed for this run")
        if kind in ("write", "edit", "exec", "mcp", "web_fetch", "web_search"):
            if self.mode == "plan":
                raise PermissionError(f"{kind} denied in plan mode")
            if self.permission_mode == "plan":
                if draft is not None:
                    return
                from .tool_contract import PlanModeDenied
                raise PlanModeDenied(
                    self.plan_draft.denial(kind) if self.plan_draft is not None
                    else f"{kind} denied in plan mode",
                    str(self.plan_draft.path) if self.plan_draft is not None else None)
            remote_exec = kind == "exec" and is_remote_exec_subject(subject)
            # Even yolo remains one-shot for a remote SSH command. The action
            # is separately tied to a configured connection and must be visible.
            if self.permission_mode == "yolo" and not remote_exec:
                return
            if self.permission_mode == "edit" and kind in ("write", "edit"):
                return
            bucket_name = kind
            with self.lock:
                bucket = self.approvals.get(self.session_id, {}).get(bucket_name, {})
                if tool_call_id in bucket and bucket[tool_call_id] == subject:
                    del bucket[tool_call_id]
                    record_approval(self.session, "consumed", kind, tool_call_id, subject)
                    return
            raise PermissionError(f"{kind} requires explicit approval")


def pending_denials(session: dict) -> list:
    """Denied tool calls still awaiting an explicit decision, from journal.

    A denial is dropped once the same (tool, subject) later succeeded, so a
    completed retry does not keep offering a stale approval button.
    """
    calls: dict = {}
    for message in session.get("messages", []):
        for call in message.get("tool_calls") or []:
            function = call.get("function", {}) or {}
            try:
                args = json.loads(function.get("arguments", "{}"))
            except (ValueError, TypeError):
                args = {}
            name = function.get("name", "")
            preview = ""
            if name in ("read", "list", "write", "edit"):
                subject = args.get("path", "") if isinstance(args, dict) else ""
                if name == "edit" and isinstance(args, dict):
                    preview = "-" + str(args.get("old", ""))[:200] + " / +" + str(args.get("new", ""))[:200]
            elif name in ("glob", "grep"):
                subject = args.get("path", ".") if isinstance(args, dict) else ""
            elif name == "exec":
                argv = args.get("argv", []) if isinstance(args, dict) else []
                subject = json.dumps(argv, ensure_ascii=False, separators=(",", ":")) if isinstance(argv, list) and all(isinstance(x, str) for x in argv) else ""
            elif name.startswith("mcp__"):
                # A denied MCP call must be approvable the same way as exec: use the
                # exact canonical subject the gate will check, built from the same
                # journaled args, so the two can never drift apart.
                subject = mcp_subject(name, args if isinstance(args, dict) else {})
                preview = "mcp"
            else:
                from .tool_registry import REGISTRY_BY_NAME
                tool = REGISTRY_BY_NAME.get(name)
                try:
                    subject = tool.approval_subject(args) if tool and tool.approval_subject else ""
                except (ValueError, KeyError, TypeError):
                    subject = ""
            if call.get("id"):
                info = {"tool_call_id": call["id"], "name": name, "subject": subject, "preview": preview}
                from .tool_registry import REGISTRY_BY_NAME
                tool = REGISTRY_BY_NAME.get(name)
                if tool and tool.approval_subject:
                    info["kind"] = tool.gate_kind
                calls[call["id"]] = info
    # Only a later successful retry resolves an earlier denial. A previous
    # turn's success must not hide a fresh one-shot approval request.
    succeeded = {
        (info["name"], info["subject"]): index
        for index, (cid, info) in enumerate(calls.items())
        if isinstance((session.get("results") or {}).get(cid), dict)
        and (session["results"][cid] or {}).get("ok")
    }
    return [
        info for index, (cid, info) in enumerate(calls.items())
        if isinstance((session.get("results") or {}).get(cid), dict)
        and (session["results"][cid] or {}).get("error") == "denied"
        # Legacy journals have no classification. New policy denials cannot be
        # resolved with a one-shot approval and must never offer that button.
        and (session["results"][cid] or {}).get("error_code") in (None, "approval_required")
        and succeeded.get((info["name"], info["subject"]), -1) < index
    ]


def changed_paths(session: dict) -> list:
    """Workspace paths from successful registered write/edit tools, in order."""
    paths = []
    seen = set()
    results = session.get("results") or {}
    from .tool_registry import REGISTRY_BY_NAME

    for message in session.get("messages", []):
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            tool = REGISTRY_BY_NAME.get(function.get("name"))
            if (tool is None or tool.gate_kind not in ("write", "edit")
                    or tool.approval_subject is None):
                continue
            try:
                args = json.loads(function.get("arguments") or "{}")
            except (ValueError, TypeError):
                continue
            if not isinstance(args, dict):
                continue
            try:
                path = tool.approval_subject(args)
            except (ValueError, KeyError, TypeError):
                continue
            result = results.get(call.get("id"))
            if isinstance(path, str) and path and isinstance(result, dict) and result.get("ok") and path not in seen:
                seen.add(path)
                paths.append(path)
    return paths[:200]


def _save_audit(ctx: dict, session: dict) -> None:
    """Persist an approval audit line; a save failure must not 500 the request.

    The caller has already recorded the grant in memory, so the decision is
    live either way. Losing the audit trail is worth a silent degrade, not a
    failed approval the operator would have to retry.
    """
    try:
        ctx["store"].save(session)
    except Exception:  # noqa: BLE001 - audited state is best-effort persistence
        pass


def replay_approved(session: dict, store: Store, gate: WebGate, approvals: dict,
                    lock: threading.Lock, mcp_call=None) -> None:
    """Retry only previously denied, explicitly approved calls, using journaled args.

    Do this before the next provider turn; never approve an unrelated future call.
    ``mcp_call`` is required for an approved MCP call to actually run: those are
    not built-in tools, so ``execute`` cannot dispatch them and would answer
    "unknown tool".
    """
    sid = session["id"]
    with lock:
        buckets = approvals.get(sid, {})
        ids = {cid for bucket in buckets.values() for cid in bucket}
    pending = {p["tool_call_id"]: p for p in pending_denials(session)}
    for cid in ids & pending.keys():
        for message in session.get("messages", []):
            call = next((c for c in (message.get("tool_calls") or []) if c.get("id") == cid), None)
            if call is None:
                continue
            function = call.get("function") or {}
            name = function.get("name", "")
            owner = plugin_runtime.tool_owner(name)
            if owner and not plugin_runtime.is_enabled(store.directory, owner):
                # Granting a legacy approval cannot resurrect a disabled tool.
                continue
            try:
                args = json.loads(function.get("arguments", "{}"))
                if not isinstance(args, dict):
                    continue
            except (ValueError, TypeError):
                continue
            if name.startswith("mcp__"):
                # An approved MCP call can only run if the servers are connected
                # for this turn; otherwise leave it pending rather than record a
                # bogus failure the user would have to decode.
                if mcp_call is None:
                    continue
                result = call_mcp(gate, mcp_call, name, args, cid)
            else:
                args["_tool_call_id"] = cid
                from .tool_contract import bind_execution
                with bind_execution(store=store, state_dir=store.directory, registry=None):
                    result = execute(Path(session["root"]), gate, name, args, session)
            session["results"][cid] = result
            for tool_message in session["messages"]:
                if tool_message.get("tool_call_id") == cid:
                    tool_message["content"] = json.dumps(result, ensure_ascii=False)
            store.save(session)
            break


def _allowed_root(candidate: Path, web_runs: Path, project_dir: Path, extra_roots=()) -> Path:
    """Constrain browser-created workspaces; raises ValueError when rejected.

    ``extra_roots`` are operator-declared (``XUENESS_WORKSPACE_ROOTS``), which is
    how a mounted host directory becomes usable without widening the default
    fence for everyone.
    """
    # The old implicit /tmp grant exposed every temporary directory to the
    # picker and accepted raw session roots there. Temporary workspaces must
    # now be explicitly configured (or use the server-owned web-runs root).
    roots = [web_runs.resolve(), project_dir.resolve()]
    roots.extend(Path(str(root)).resolve() for root in extra_roots)
    target = candidate.resolve() if candidate.is_absolute() else (web_runs.resolve() / candidate).resolve()
    if any(target == base or target.is_relative_to(base) for base in roots):
        return target
    raise ValueError("workspace root not permitted")


class Handler(BaseHTTPRequestHandler):
    server_version = "XuenessWeb/0.1"
    protocol_version = "HTTP/1.1"

    # injected by serve()
    _ctx: dict = {}  # type: ignore
    _response_started = False
    _body_consumed = True
    _request_started = False

    def log_message(self, *args):  # quiet; MVP
        pass

    # -- helpers ---------------------------------------------------------
    def _send(self, code: int, payload, content_type="application/json") -> None:
        if (isinstance(content_type, str) and content_type.startswith("application/json")
                and isinstance(payload, dict) and code >= 400):
            payload = normalize_error(code, payload)
        if self._response_started:
            self.close_connection = True
            return
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self._response_started = True
        # parse_request leaves the default HTTP/0.9 version in place when it
        # rejects HTTP/2+ or a bad version, and the stdlib then omits the
        # status line. Every answer from this server names its status.
        if getattr(self, "request_version", None) in (None, "", "HTTP/0.9"):
            self.request_version = "HTTP/1.1"
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if not self._body_consumed:
            self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (TimeoutError, OSError):
            self.close_connection = True

    def handle_expect_100(self):
        # The stdlib sends 100 Continue before Host, CSRF, or the body limit.
        # Defer that answer until the upload is actually acceptable.
        return True

    def send_error(self, code, message=None, explain=None):
        # The stdlib writer emits HTML and copies the request into the body.
        status = int(getattr(code, "value", code))
        token, text = _PROTOCOL_ERRORS.get(status, ("error", "request failed"))
        self._body_consumed = False
        self._reject(status, token, text)

    def _reject(self, status: int, code: str, message: str) -> None:
        self.close_connection = True
        try:
            self._send(status, {"error": message, "code": code})
        except (OSError, TimeoutError):
            self.close_connection = True

    def handle_one_request(self):
        self._mutation_id = None
        self._response_started = False
        self._body_consumed = True
        self._request_started = False
        try:
            self._read_request_head()
        except _RequestRejected as exc:
            self._reject(exc.status, exc.code, exc.message)
        except TimeoutError:
            self.close_connection = True
            if self._request_started and not self._response_started:
                self._reject(408, "request_timeout", "request timed out")
        except Exception:
            # The client sees a fixed body. The traceback stays on stderr so a
            # fault is not discarded with the connection.
            traceback.print_exc()
            self.close_connection = True
            if not self._response_started:
                self._reject(500, "internal_error", "internal error")
        finally:
            if self._mutation_id is not None:
                with self._ctx['lock']:
                    self._ctx.get('active_mutations', {}).pop(self._mutation_id, None)

    def _read_request_head(self):
        try:
            self.connection.settimeout(_HEADER_IDLE_SECONDS)
        except OSError:
            self.close_connection = True
            return
        intake = _IntakeDeadline(self.connection, _HEADER_DEADLINE_SECONDS)
        expired = False
        try:
            try:
                self.raw_requestline = self.rfile.readline(65537)
            except TimeoutError:
                self.close_connection = True
                return
            except OSError:
                self.close_connection = True
                expired = intake.expired.is_set()
                if expired and self._request_started and not self._response_started:
                    self._reject(408, "request_timeout", "request timed out")
                return
            if len(self.raw_requestline) > 65536:
                self.requestline = ""
                self.request_version = ""
                self.command = ""
                self._request_started = True
                self.send_error(414)
                return
            if not self.raw_requestline:
                self.close_connection = True
                if intake.expired.is_set() and self._request_started and not self._response_started:
                    self._reject(408, "request_timeout", "request timed out")
                return
            self._request_started = True
            if not self.parse_request():
                return
            expired = intake.expired.is_set()
        finally:
            intake.cancel()
        if expired:
            self.close_connection = True
            if not self._response_started:
                self._reject(408, "request_timeout", "request timed out")
            return
        if self.command not in {"GET", "HEAD", *_WRITE_METHODS}:
            self._body_consumed = False
            self.send_error(501)
            return
        if self.command == "HEAD":
            # HEAD would replay GET side effects (archive, read marks). Refuse it.
            self._body_consumed = False
            self.send_error(501)
            return
        try:
            self.connection.settimeout(_RESPONSE_IDLE_SECONDS)
        except OSError:
            self.close_connection = True
            return
        getattr(self, "do_" + self.command)()
        try:
            self.wfile.flush()
        except (TimeoutError, OSError):
            self.close_connection = True

    def _guard(self, need_csrf=False) -> bool:
        desktop_token = self._ctx.get('desktop_token')
        if desktop_token:
            presented = _header_values(self.headers, 'X-Xueness-Desktop-Token')
            if (len(presented) != 1 or not presented[0]
                    or not secrets.compare_digest(presented[0], desktop_token)):
                self._send(403, {'error': 'desktop host authentication required',
                                 'code': 'desktop_auth_required'})
                return False
        if not _host_ok(self.headers) or not _origin_ok(self.headers) or not _fetch_site_ok(self.headers):
            self._send(403, {"error": "host not permitted", "code": "host_not_permitted"})
            return False
        if need_csrf:
            tokens = _header_values(self.headers, "X-CSRF-Token")
            if (len(tokens) != 1 or not tokens[0]
                    or not secrets.compare_digest(tokens[0], self._ctx["csrf"])):
                self._send(403, {"error": "csrf token required", "code": "csrf_required"})
                return False
            with self._ctx['lock']:
                if self._ctx.get('admission_closed'):
                    self._send(503, {'error': '服务即将重启，暂不接收新操作。',
                                     'code': 'admission_closed'})
                    return False
                if getattr(self, '_mutation_id', None) is None:
                    self._mutation_id = str(id(self))
                    self._ctx.setdefault('active_mutations', {})[self._mutation_id] = urllib.parse.urlparse(self.path).path
        plugin_runtime.sync_services(self._ctx)
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split('/') if p]
        owner = plugin_runtime.route_owner(parts)
        if owner and not plugin_runtime.is_enabled(self._ctx['state_dir'], owner):
            self._send(403, {'error': 'plugin disabled or dependency unavailable: ' + owner,
                             'plugin': owner, 'code': 'plugin_disabled'})
            return False
        if owner == 'files' and len(parts) == 4 and parts[3] == 'file':
            name = urllib.parse.parse_qs(parsed.query).get('path', [''])[0]
            if Path(name).suffix.lower() in ('.docx', '.xlsx', '.pptx') and not plugin_runtime.is_enabled(self._ctx['state_dir'], 'office'):
                self._send(403, {'error': 'plugin disabled or dependency unavailable: office',
                                 'plugin': 'office', 'code': 'plugin_disabled'})
                return False
        return True

    def _body_limit(self) -> int:
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/composer/prepare":
            return _MAX_COMPOSER_BODY
        return _MAX_BODY

    def _declared_length(self) -> tuple:
        """Return ``(length, explicit)``. Never reads the body.

        Chunked encoding and a second Content-Length are rejected. Treating
        either as an empty object would apply a write the client did not send
        and leave unread bytes on a keep-alive connection.
        """
        transfers = self.headers.get_all("Transfer-Encoding") or []
        if any(item.strip() for item in transfers):
            raise _RequestRejected(411, "length_required", "Content-Length is required")
        lengths = self.headers.get_all("Content-Length") or []
        if not lengths:
            return 0, False
        if len(lengths) != 1:
            raise _RequestRejected(400, "invalid_content_length", "invalid Content-Length")
        raw = lengths[0].strip()
        if len(raw) > 10 or not raw.isdigit() or (len(raw) > 1 and raw[0] == "0"):
            raise _RequestRejected(400, "invalid_content_length", "invalid Content-Length")
        length = int(raw)
        if length > self._body_limit():
            raise _RequestRejected(413, "payload_too_large", "request body is too large")
        return length, True

    def _check_expect(self, length: int) -> None:
        values = self.headers.get_all("Expect") or []
        if not values:
            return
        if len(values) != 1 or values[0].strip().lower() != "100-continue":
            raise _RequestRejected(417, "expectation_failed", "Expect is not supported")
        if length <= 0 or self._response_started:
            return
        self.wfile.write(b"HTTP/1.1 100 Continue\r\n\r\n")
        self.wfile.flush()

    def _read_exact(self, length: int) -> bytes:
        if length == 0:
            self._body_consumed = True
            return b""
        intake = _IntakeDeadline(self.connection, _BODY_DEADLINE_SECONDS)
        chunks = []
        remaining = length
        try:
            while remaining:
                try:
                    self.connection.settimeout(min(
                        _BODY_IDLE_SECONDS,
                        max(0.01, _BODY_DEADLINE_SECONDS),
                    ))
                    block = self.rfile.read(min(remaining, 65536))
                except TimeoutError:
                    raise _RequestRejected(408, "request_timeout", "request timed out") from None
                except OSError:
                    if intake.expired.is_set():
                        raise _RequestRejected(408, "request_timeout", "request timed out") from None
                    raise _RequestRejected(400, "truncated_body", "request body ended early") from None
                if not block:
                    if intake.expired.is_set():
                        raise _RequestRejected(408, "request_timeout", "request timed out")
                    raise _RequestRejected(400, "truncated_body", "request body ended early")
                chunks.append(block)
                remaining -= len(block)
        finally:
            intake.cancel()
        self._body_consumed = True
        if intake.expired.is_set():
            # The read side may already be shut. Finish this response, then close.
            self._body_consumed = False
            self.close_connection = True
        return b"".join(chunks)

    def _parse_object(self, raw: bytes):
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise _RequestRejected(400, "invalid_json", "invalid json body") from None
        if not isinstance(data, dict):
            raise _RequestRejected(400, "invalid_json", "invalid json body")
        return data

    def _prepare_read(self) -> bool:
        """Reject a malformed GET/HEAD body framing. Do not apply its bytes."""
        self._body_consumed = True
        try:
            length, explicit = self._declared_length()
        except _RequestRejected as exc:
            self._body_consumed = False
            self._reject(exc.status, exc.code, exc.message)
            return False
        if explicit and length > 0:
            # Leaving the bytes unread would desync the next keep-alive request.
            self._body_consumed = False
        return True

    def _read_json_body(self):
        length, explicit = self._declared_length()
        self._check_expect(length if explicit else 0)
        if not explicit:
            # No length and no chunking: there is no body to apply. Close so a
            # smuggled following request cannot be parsed on this connection.
            self._body_consumed = False
            return {}
        return self._parse_object(self._read_exact(length))

    # -- stage 2 modules --------------------------------------------------
    def _dispatch_stage2(self, method: str, data: dict) -> bool:
        """Let each stage-2 module try to handle the request.

        Modules own a path prefix each (``/api/settings``, ``/api/resources``,
        ``/api/providers``, ``/api/usage``, ``/api/memory``) and return
        ``(status, payload)`` when they handle it or ``None`` when it is not
        theirs. The iteration order is fixed and each module filters its own
        prefix, so no module can shadow another.

        ``data`` is passed in rather than re-read: ``do_POST`` has already
        consumed the request body from ``rfile``, so a second read would
        return empty.
        """
        path = urllib.parse.urlparse(self.path).path
        parts = [p for p in path.split("/") if p]
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            result = plugin_runtime.dispatch_http(method, parts, query, data, {**self._ctx, "handler": self})
        except Exception:
            traceback.print_exc()
            self._send(500, {"error": "internal error", "code": "internal_error"})
            return True
        if result is HANDLED_RESPONSE:
            return True
        if result is not None:
            status, payload = result
            self._send(status, payload)
            return True
        return False

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        if not self._prepare_read() or not self._guard():
            return
        ctx = self._ctx
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            page = ctx["webapp_dir"] / "index.html"
            try:
                body = page.read_bytes()
            except OSError:
                self._send(503, {"error": "ui asset missing"})
                return
            self._send(200, body, "text/html; charset=utf-8")
            return
        if path.startswith("/assets/"):
            # Only Vite's named assets are public. Never interpret encoded path
            # separators, dot segments, or symlinks as files under the bundle.
            asset_name = path.removeprefix("/assets/")
            if not asset_name or not _re.fullmatch(r"[A-Za-z0-9._-]+", asset_name) or ".." in asset_name:
                self._send(404, {"error": "not found"})
                return
            root = (ctx["webapp_dir"] / "assets").resolve()
            asset = (root / asset_name).resolve()
            if asset.parent != root or asset.suffix not in (".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".webp", ".woff", ".woff2", ".ttf", ".ico", ".wasm", ".mp3"):
                self._send(404, {"error": "not found"})
                return
            try:
                body = asset.read_bytes()
            except OSError:
                self._send(404, {"error": "not found"})
                return
            mime = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"}.get(asset.suffix) or mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
            self._send(200, body, mime)
            return
        # Vite copies ``public/`` to the dist root by original name. Only the
        # small explicit set below is public; this is not a general file server.
        if path in _ROOT_STATIC_FILES:
            static_root = Path(ctx["webapp_dir"]).resolve()
            static_file = (static_root / _ROOT_STATIC_FILES[path][0]).resolve()
            if static_file.parent != static_root:
                self._send(404, {"error": "not found"})
                return
            try:
                body = static_file.read_bytes()
            except OSError:
                self._send(404, {"error": "not found"})
                return
            self._send(200, body, _ROOT_STATIC_FILES[path][1])
            return
        if path == "/api/csrf":
            self._send(200, {"csrfToken": ctx["csrf"]})
            return
        if path in ("/api/health", "/healthz"):
            self._send(200, {"ok": True, "service": "xueness-web"})
            return
        parts = [p for p in path.split("/") if p]
        # Xueness's own versioned event protocol. Additive route: the legacy
        # ``/events`` shape above is untouched, so old consumers keep working
        # while the timeline migrates to this source of truth.
        if self._dispatch_stage2("GET", {}):
            return
        self._send(404, {"error": "not found"})

    def _handle_write(self, method: str):
        # Framing is checked after the host and CSRF gates so a forbidden
        # caller is refused before we describe the body limit. The body is
        # still not read on that path, and the connection is closed.
        self._body_consumed = False
        if not self._guard(need_csrf=True):
            return
        try:
            data = self._read_json_body()
        except _RequestRejected as exc:
            self._reject(exc.status, exc.code, exc.message)
            return
        if self._dispatch_stage2(method, data):
            return
        self._send(404, {"error": "not found", "code": "not_found"})

    def do_POST(self):
        self._handle_write("POST")

    def do_DELETE(self):
        # DELETE mutates persisted state, so it carries the same CSRF
        # requirement as POST rather than the read-only guard.
        self._handle_write("DELETE")

    def do_PATCH(self):
        # PATCH merges fields into persisted state: same CSRF requirement.
        self._handle_write("PATCH")

    def do_PUT(self):
        # PUT replaces a whole resource list: same CSRF requirement.
        self._handle_write("PUT")


def _declared_workspace_roots(additional=()) -> tuple:
    """Operator-declared extra workspace roots (``XUENESS_WORKSPACE_ROOTS``).

    This is how a mounted host directory becomes usable: the same list feeds
    the session-root allowlist and the picker, so nothing can be browsed yet
    refused when a task is created from it.
    """
    values = [*(os.environ.get("XUENESS_WORKSPACE_ROOTS") or "").split(os.pathsep),
              *(str(item) for item in (additional or ()))]
    roots = []
    seen = set()
    for value in values:
        if not value.strip():
            continue
        try:
            root = Path(value).expanduser().resolve(strict=True)
            if not root.is_dir():
                continue
            if root in (Path("/").resolve(), Path("/tmp").resolve()):
                continue
        except (OSError, RuntimeError, ValueError):
            continue
        if str(root) not in seen:
            seen.add(str(root))
            roots.append(root)
    return tuple(roots)


def _browse_roots(web_runs: Path, project_dir: Path, workspace_roots=None) -> tuple:
    """Roots the picker may list and create in; declared mounts lead.

    Listing and creation share one set on purpose: "what you can pick" and
    "where a task may live" must not drift apart.
    """
    return (
        *(_declared_workspace_roots() if workspace_roots is None else workspace_roots),
        project_dir.resolve(),
        web_runs.resolve(),
    )


def build_context(state_dir: Path, web_runs: Path, project_dir: Path, allow_real=False,
                  csrf: str | None = None, workspace_roots=None) -> dict:
    state_dir.mkdir(parents=True, exist_ok=True)
    web_runs.mkdir(parents=True, exist_ok=True)
    configured_workspace_roots = _declared_workspace_roots(workspace_roots or ())
    return {
        "store": Store(state_dir),
        "terminals": plugin_runtime.entrypoint('terminal').create_service() if plugin_runtime.is_enabled(state_dir, 'terminal') else None,
        "web_runs": web_runs.resolve(),
        "project_dir": project_dir.resolve(),
        "webapp_dir": (project_dir.resolve() / "webapp" / "dist"),
        "approvals": {},
        "running": set(),
        # Sessions asked to stop. Polled at step boundaries by run(); a request
        # is honoured between steps, never mid-tool-call, so no side effect is
        # torn in half. Cleared when the run returns.
        "stop_requested": set(),
        # Feature dispatch adds a handler through a per-request shallow copy.
        # Prepared inputs must share the same cache and lock across requests.
        "_composer_prepared_inputs": {},
        "_composer_prepared_lock": threading.RLock(),
        # Delegated sub-run metadata (progress mirror + cooperative cancel).
        "task_registry": plugin_runtime.entrypoint('subagents').create_service(),
        "lock": threading.Lock(),
        "allow_real": allow_real,
        "csrf": csrf or secrets.token_hex(32),
        # Stage 2 新增：设置/资源/供应商等的持久化根。各子模块只读本键，
        # 一律用原子写落盘到该目录下，互不覆盖。
        "state_dir": state_dir.resolve(),
        # 目录浏览（DSH browse 能力的宿主侧）：选择器可见/可建的根，默认是
        # 服务自有的 web-runs / tmp；挂载宿主目录后由
        # XUENESS_WORKSPACE_ROOTS 追加。max_entries 是单层级完整结果上限。
        "workspace_roots": configured_workspace_roots,
        "list_roots": _browse_roots(web_runs, project_dir, configured_workspace_roots),
        "create_roots": _browse_roots(web_runs, project_dir, configured_workspace_roots),
        "max_entries": int(os.environ.get("XUENESS_BROWSE_MAX_ENTRIES") or 1000),
    }


def resolve_bind_host(explicit: str | None = None) -> str:
    """Resolve the interface to bind.

    Default is loopback-only. A non-loopback bind (e.g. ``0.0.0.0`` inside a
    container net namespace) is refused unless ``XUENESS_ALLOW_REMOTE=1`` is
    set explicitly, so public exposure can never happen silently. Even with
    the flag, the caller must put auth/TLS in front; the app itself has none.
    """
    import os as _os
    host = (explicit or _os.environ.get(HOST_ENV, "") or HOST).strip()
    if _loopback_host(host):
        return host
    # Allow 0.0.0.0 / :: / LAN addresses only with explicit opt-in.
    if _os.environ.get(ALLOW_REMOTE_ENV, "").strip().lower() in ("1", "true", "yes", "on"):
        return host
    raise ValueError(f"non-loopback bind {host!r} requires {ALLOW_REMOTE_ENV}=1 plus external auth/TLS")


def create_server(port: int, ctx: dict, host: str | None = None) -> ThreadingHTTPServer:
    bind_host = resolve_bind_host(host)
    handler = type("XuenessHandler", (Handler,), {"_ctx": ctx})
    class ManagedServer(ThreadingHTTPServer):
        def server_close(self):
            # Plugin scopes release exactly what their activate() acquired.
            registry = ctx.get('plugin_scopes')
            if registry is not None:
                registry.dispose()
            super().server_close()
    server = ManagedServer((bind_host, port), handler)
    ctx["serve_plugins"] = True
    plugin_runtime.sync_services(ctx)
    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="xueness-web", description="Xueness loopback-only Web UI")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", type=str, default=None,
                        help="bind interface (default 127.0.0.1; non-loopback needs XUENESS_ALLOW_REMOTE=1)")
    parser.add_argument("--state", type=Path, default=Path(__file__).resolve().parent.parent / ".state")
    parser.add_argument("--web-runs", type=Path, default=Path(__file__).resolve().parent.parent / ".web-runs")
    parser.add_argument("--workspace-root", action="append", type=Path, default=[], metavar="PATH",
                        help="allow an existing host workspace directory (repeatable)")
    parser.add_argument("--allow-real-provider", action="store_true",
                        help="legacy compatibility flag; online runs are enabled by default")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be 1..65535")
    import os as _os
    allow_real_value = _os.environ.get("XUENESS_ALLOW_REAL")
    allow_real = (allow_real_value.strip().lower() in ("1", "true", "yes", "on")
                  if allow_real_value is not None else True)
    workspace_roots = []
    for value in args.workspace_root:
        try:
            root = value.expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            parser.error(f"--workspace-root must name an existing directory: {value}")
        if not root.is_dir():
            parser.error(f"--workspace-root must name a directory, not a file: {value}")
        if root in (Path("/").resolve(), Path("/tmp").resolve()):
            parser.error(f"--workspace-root is too broad; choose a project directory: {value}")
        workspace_roots.append(root)
    project_dir = Path(__file__).resolve().parent.parent
    ctx = build_context(args.state, args.web_runs, project_dir, allow_real,
                        workspace_roots=workspace_roots)
    try:
        bind_host = resolve_bind_host(args.host)
    except ValueError as exc:
        parser.error(str(exc))
    server = create_server(args.port, ctx, bind_host)
    scope = "loopback only" if _loopback_host(bind_host) else "container bind (host publish controls exposure)"
    print(f"Xueness Web UI on http://{bind_host}:{args.port} ({scope}, real provider {'on' if allow_real else 'off'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # KeyboardInterrupt leaves serve_forever without server_close, so plugin
        # scopes would not stop terminals, browsers, or MCP servers.
        server.server_close()
        from .process_runtime import release_owned_processes
        release_owned_processes()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
