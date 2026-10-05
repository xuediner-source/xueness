"""Xueness local Web UI (loopback-only MVP, stdlib only).

Serves a single self-contained page plus a small JSON API. The server binds
127.0.0.1 only, validates Host/Origin against loopback, requires a
same-origin CSRF token for every POST, and never takes blanket
allow-write/allow-edit/allow-exec from the browser. Writes, edits, and
subprocesses run only after an explicit per-action approval that is
consumed on first use.

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
import threading
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
from .http_contract import HANDLED_RESPONSE

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


def _origin_ok(headers) -> bool:
    expected = _parse_authority(headers.get("Host", ""))
    if expected is None:
        return False
    for key in ("Origin", "Referer"):
        raw = headers.get(key)
        if not raw:
            continue
        try:
            parsed = urllib.parse.urlsplit(raw)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username is not None or parsed.password is not None:
                return False
            authority = ((parsed.hostname or "").lower(), parsed.port or (443 if parsed.scheme == "https" else 80))
        except ValueError:
            return False
        if authority != expected:
            return False
    return True


def _parse_authority(value: str):
    value = (value or "").strip()
    if not value or any(c in value for c in " /\\\t\r\n"):
        return None
    try:
        parsed = urllib.parse.urlsplit("//" + value)
        if not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username is not None:
            return None
        hostname, port = parsed.hostname.lower(), parsed.port or 80
        if not _loopback_host(hostname) or not 1 <= port <= 65535:
            return None
        return hostname, port
    except ValueError:
        return None


def _host_ok(headers) -> bool:
    return _parse_authority(headers.get("Host", "")) is not None


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
    succeeded = {
        (info["name"], info["subject"])
        for cid, info in calls.items()
        if isinstance((session.get("results") or {}).get(cid), dict)
        and (session["results"][cid] or {}).get("ok")
    }
    return [
        info for cid, info in calls.items()
        if isinstance((session.get("results") or {}).get(cid), dict)
        and (session["results"][cid] or {}).get("error") == "denied"
        # Legacy journals have no classification. New policy denials cannot be
        # resolved with a one-shot approval and must never offer that button.
        and (session["results"][cid] or {}).get("error_code") in (None, "approval_required")
        and (info["name"], info["subject"]) not in succeeded
    ]


def changed_paths(session: dict) -> list:
    """Workspace paths successfully written or edited, in first-seen order."""
    paths = []
    seen = set()
    results = session.get("results") or {}
    for message in session.get("messages", []):
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            if function.get("name") not in ("write", "edit"):
                continue
            try:
                args = json.loads(function.get("arguments") or "{}")
            except (ValueError, TypeError):
                continue
            path = args.get("path") if isinstance(args, dict) else ""
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

    def log_message(self, *args):  # quiet; MVP
        pass

    # -- helpers ---------------------------------------------------------
    def _send(self, code: int, payload, content_type="application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def handle_one_request(self):
        self._mutation_id = None
        try:
            return super().handle_one_request()
        finally:
            if self._mutation_id is not None:
                with self._ctx['lock']:
                    self._ctx.get('active_mutations', {}).pop(self._mutation_id, None)

    def _guard(self, need_csrf=False) -> bool:
        desktop_token = self._ctx.get('desktop_token')
        if desktop_token and not secrets.compare_digest(
                self.headers.get('X-Xueness-Desktop-Token', ''), desktop_token):
            self._send(403, {'error': 'desktop host authentication required'})
            return False
        if not _host_ok(self.headers) or not _origin_ok(self.headers):
            self._send(403, {"error": "host not permitted"})
            return False
        if need_csrf:
            token = self.headers.get("X-CSRF-Token", "")
            if not token or not secrets.compare_digest(token, self._ctx["csrf"]):
                self._send(403, {"error": "csrf token required"})
                return False
            with self._ctx['lock']:
                if self._ctx.get('admission_closed'):
                    self._send(503, {'error': '服务即将重启，暂不接收新操作。'})
                    return False
                if getattr(self, '_mutation_id', None) is None:
                    self._mutation_id = str(id(self))
                    self._ctx.setdefault('active_mutations', {})[self._mutation_id] = urllib.parse.urlparse(self.path).path
        plugin_runtime.sync_services(self._ctx)
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split('/') if p]
        owner = plugin_runtime.route_owner(parts)
        if owner and not plugin_runtime.is_enabled(self._ctx['state_dir'], owner):
            self._send(403, {'error': 'plugin disabled or dependency unavailable: ' + owner, 'plugin': owner})
            return False
        if owner == 'files' and len(parts) == 4 and parts[3] == 'file':
            name = urllib.parse.parse_qs(parsed.query).get('path', [''])[0]
            if Path(name).suffix.lower() in ('.docx', '.xlsx', '.pptx') and not plugin_runtime.is_enabled(self._ctx['state_dir'], 'office'):
                self._send(403, {'error': 'plugin disabled or dependency unavailable: office', 'plugin': 'office'})
                return False
        return True

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        body_limit = _MAX_COMPOSER_BODY if urllib.parse.urlparse(self.path).path == '/api/composer/prepare' else _MAX_BODY
        if length < 0 or length > body_limit:
            return None
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

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
            self._send(500, {"error": "internal error"})
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
        if not self._guard():
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

    def do_POST(self):
        if not self._guard(need_csrf=True):
            return
        ctx = self._ctx
        path = urllib.parse.urlparse(self.path).path
        data = self._body()
        if data is None:
            self._send(400, {"error": "invalid json body"})
            return
        parts = [p for p in path.split("/") if p]
        if self._dispatch_stage2("POST", data):
            return
        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        # DELETE mutates persisted state, so it carries the same CSRF
        # requirement as POST rather than the read-only guard.
        if not self._guard(need_csrf=True):
            return
        data = self._body()
        if data is None:
            self._send(400, {"error": "invalid json body"})
            return
        path = urllib.parse.urlparse(self.path).path
        parts = path.split("/")
        if self._dispatch_stage2("DELETE", data):
            return
        self._send(404, {"error": "not found"})

    def do_PATCH(self):
        # PATCH merges fields into persisted state: same CSRF requirement.
        if not self._guard(need_csrf=True):
            return
        data = self._body()
        if data is None:
            self._send(400, {"error": "invalid json body"})
            return
        path = urllib.parse.urlparse(self.path).path
        parts = path.split("/")
        if self._dispatch_stage2("PATCH", data):
            return
        self._send(404, {"error": "not found"})

    def do_PUT(self):
        # PUT replaces a whole resource list: same CSRF requirement.
        if not self._guard(need_csrf=True):
            return
        data = self._body()
        if data is None:
            self._send(400, {"error": "invalid json body"})
            return
        if self._dispatch_stage2("PUT", data):
            return
        self._send(404, {"error": "not found"})


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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
