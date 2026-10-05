"""``xueness app-server`` — stdio JSON-RPC 2.0 so an IDE can drive Xueness.

Framing: one UTF-8 JSON-RPC message per line, LF terminated, capped at
``MAX_FRAME_BYTES``. stdout carries protocol frames only: the whole request
cycle runs under ``redirect_stdout`` while the frame writer keeps its own
handle on the real stdout buffer. No socket and no port are ever opened — the
transport is the pipe pair the parent process handed us.

Trust model: there is no HTTP here, so ``Handler._guard``'s Host/Origin/CSRF
checks cannot apply and are deliberately absent. The only trusted peer is the
parent process that spawned this server. Everything else is the web's own code
path: ``plugin_runtime.dispatch_http`` supplies the plugin-effective check,
Gate and ``permission_mode`` approvals, the workspace-root fence and the
single-writer session lease. Being local stdio grants nothing extra.
"""
from __future__ import annotations

import contextlib
import json
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ... import events as events_protocol
from ... import plugin_runtime
from ... import web as host

PROTOCOL_NAME = "xueness.app-server.v1"
PROTOCOL_VERSION = 1

#: An oversized frame is answered, never buffered: the line is drained and
#: dropped so a hostile or buggy client cannot grow this process' memory.
MAX_FRAME_BYTES = 1024 * 1024
POLL_SECONDS = 0.05
SHUTDOWN_JOIN_SECONDS = 5.0

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
#: The request was well formed but Xueness refused it (plugin gate, workspace
#: fence, lease conflict, unknown session). ``data.status`` carries the exact
#: HTTP status the same call would return on the web API.
REFUSED = -32000

_STATUS_TO_CODE = {400: INVALID_PARAMS, 403: REFUSED, 404: REFUSED, 405: REFUSED,
                   409: REFUSED, 500: INTERNAL_ERROR, 501: REFUSED, 503: REFUSED}

_METHOD_STATUS = {
    PARSE_ERROR: "Parse error",
    INVALID_REQUEST: "Invalid Request",
    METHOD_NOT_FOUND: "Method not found",
    INVALID_PARAMS: "Invalid params",
    INTERNAL_ERROR: "Internal error",
    REFUSED: "Refused by Xueness",
}

#: ``project_dir`` is the repository root, matching ``xueness web``'s default.
_PROJECT_DIR = Path(__file__).resolve().parents[3]

_TURN_KEYS = {
    "sessionId", "text", "modelSelection", "mode", "permissionMode", "steps",
    "maxChars", "maxTokens", "maxWallSeconds", "runtimeProfile", "browser",
    "disallowTools", "continueQueue",
}
#: Checked here only as a parameter vocabulary so ``turn/start`` answers
#: -32602 immediately; the sessions run route stays the authority that also
#: weighs plugin availability and the session's own stored mode.
_PERMISSION_MODES = ("build", "edit", "yolo", "plan")
_MODEL_KEYS = {"providerId": "provider_id", "provider_id": "provider_id",
               "model": "model", "reasoningEffort": "reasoning_effort",
               "reasoning_effort": "reasoning_effort", "selection": "selection",
               "saveDefault": "save_default", "source": "source"}
_TEXT_SELECTION_KEYS = {"providerId", "provider_id", "model", "reasoningEffort",
                        "reasoning_effort", "selection"}


class _Refused(Exception):
    """A parameter or policy failure with a JSON-RPC code and structured data."""

    def __init__(self, message, code=REFUSED, data=None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


def _binary(stream, fallback):
    stream = stream if stream is not None else fallback
    return getattr(stream, "buffer", stream)


def _write_bytes(stream, data: str) -> None:
    payload = data.encode("utf-8", "replace")
    try:
        stream.write(payload)
    except TypeError:
        stream.write(data)


class _LogStream:
    """Sink for stray ``print`` calls: everything lands on stderr, never stdout."""

    encoding = "utf-8"

    def __init__(self, sink):
        self._sink = sink

    def write(self, data):
        text = data if isinstance(data, str) else str(data)
        if text:
            _write_bytes(self._sink, text)
            self.flush()
        return len(text)

    def flush(self):
        try:
            self._sink.flush()
        except (AttributeError, ValueError, OSError):
            pass

    def isatty(self):
        return False


class _Frames:
    """Line-delimited frame writer. The only thing allowed on stdout."""

    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.Lock()
        self._closed = False

    def send(self, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                          default=str) + "\n"
        with self._lock:
            if self._closed:
                return
            try:
                _write_bytes(self._stream, data)
                self._stream.flush()
            except (ValueError, OSError):
                # The parent closed the pipe. Turn threads keep running until the
                # route returns; they must not die printing on the real stderr.
                self._closed = True

    def response(self, request_id, result) -> None:
        self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def error(self, request_id, code, message, data=None) -> None:
        error = {"code": code, "message": message}
        if data:
            error["data"] = data
        self.send({"jsonrpc": "2.0", "id": request_id, "error": error})

    def notification(self, method, params) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})


def read_frame(source, limit=MAX_FRAME_BYTES):
    """Return ``(line, oversized)`` for one LF-terminated frame.

    ``(b"", False)`` means end of input. Every individual read is bounded, so an
    unbounded writer is answered with an error instead of being buffered.
    """
    parts = []
    size = 0
    while True:
        chunk = source.readline(limit + 1)
        if not chunk:
            return b"".join(parts), size > limit
        if chunk.endswith(b"\n"):
            if size + len(chunk) <= limit:
                return b"".join(parts) + chunk, False
            return b"", True
        parts.append(chunk)
        size += len(chunk)
        if size > limit:
            while True:
                tail = source.readline(limit + 1)
                if not tail or tail.endswith(b"\n"):
                    break
            return b"", True


class _Bridge:
    """Stands in for ``web.Handler`` so routes can run without HTTP.

    Routes only ever touch ``_ctx``, ``path``, ``headers``, ``client_address``,
    ``_send`` and the raw writer helpers, so exactly those are provided. There
    is no request line, no cookie and no peer address to invent beyond the
    local parent process.
    """

    def __init__(self, base_ctx, path):
        self._base = base_ctx
        self.path = path
        self.headers = {}
        # The peer is the parent process on this machine, which is the trust
        # level the web grants to a loopback browser and nothing more.
        self.client_address = ("127.0.0.1", 0)
        self.status = None
        self.payload = None
        self._raw = bytearray()

    @property
    def _ctx(self):
        # The shared host context, never a copy: ``sync_services`` and the
        # run/stop bookkeeping must land on the one live dict.
        return self._base

    @property
    def query(self):
        return parse_qs(urlparse(self.path).query)

    def _send(self, code, payload, content_type="application/json"):
        self.status = code
        self.payload = payload

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        pass

    def end_headers(self):
        pass

    def write(self, data):
        self._raw.extend(data if isinstance(data, (bytes, bytearray))
                         else str(data).encode("utf-8"))

    @property
    def wfile(self):
        return self


class AppServer:
    def __init__(self, ctx, frames, log=None):
        self.ctx = ctx
        self.frames = frames
        self.log = log or (lambda message: print(message, file=sys.stderr, flush=True))
        self._turns = {}
        self._turns_lock = threading.Lock()
        self._stopping = threading.Event()
        self._methods = {
            "initialize": self._initialize,
            "session/list": self._session_list,
            "session/get": self._session_get,
            "session/create": self._session_create,
            "session/setModel": self._session_set_model,
            "session/setEffort": self._session_set_effort,
            "turn/start": self._turn_start,
            "turn/cancel": self._turn_cancel,
            "shutdown": self._shutdown,
            "exit": self._shutdown,
        }

    # -- the HTTP-equivalent call path --------------------------------------
    def _call(self, method, path, data=None):
        bridge = _Bridge(self.ctx, path)
        parts = [p for p in urlparse(path).path.split("/") if p]
        result = plugin_runtime.dispatch_http(method, parts, bridge.query,
                                              data if data is not None else {},
                                              {**self.ctx, "handler": bridge})
        if result is None:
            return 404, {"error": "no such route: " + path}
        if result is host.HANDLED_RESPONSE:
            return (bridge.status or 500), (bridge.payload if bridge.payload is not None
                                            else {"error": "empty response"})
        return result

    def _ask(self, method, path, data=None):
        """Call a route and unwrap its payload, or raise ``_Refused``."""
        status, payload = self._call(method, path, data)
        if status >= 400:
            body = payload if isinstance(payload, dict) else {}
            raise _Refused(str(body.get("error") or f"route returned {status}"),
                           _STATUS_TO_CODE.get(status, REFUSED),
                           {"status": status, **body})
        return payload if isinstance(payload, dict) else {"value": payload}

    # -- methods -------------------------------------------------------------
    def _initialize(self, params):
        plugins = plugin_runtime.catalog(self.ctx["state_dir"])
        return {
            "protocolName": PROTOCOL_NAME,
            "protocolVersion": PROTOCOL_VERSION,
            "xuenessVersion": _xueness_version(),
            "serverInfo": {"name": "xueness-app-server", "transport": "stdio"},
            "capabilities": {
                "streamingNotifications": True,
                "runtimeModelSwitch": True,
                "networkListener": False,
                "hostOriginCsrf": False,
                "trustModel": ("only the parent process that started this server is trusted; "
                               "over stdio there is no Host/Origin/CSRF layer"),
            },
            "limits": {"maxFrameBytes": MAX_FRAME_BYTES,
                       "notificationMethods": ["session/event", "turn/started", "turn/finished"]},
            "methods": sorted(self._methods),
            "plugins": [{"id": item["id"], "enabled": item["enabled"],
                         "effective": item["effective"],
                         "blockedBy": item.get("blockedBy", []),
                         "features": [feature["id"] for feature in item.get("features", [])]}
                        for item in plugins],
        }

    def _session_list(self, params):
        archived = params.get("archived")
        if archived is not None and archived not in (False, True):
            raise _Refused("archived must be a boolean", INVALID_PARAMS)
        return self._ask("GET", "/api/sessions/archived" if archived else "/api/sessions")

    def _session_get(self, params):
        return self._ask("GET", "/api/sessions/" + _sid(params))

    def _session_create(self, params):
        _reject_unknown(params, {"task", "root", "modelSelection"})
        task = params.get("task")
        if not isinstance(task, str) or not task.strip():
            raise _Refused("task must be a non-empty string", INVALID_PARAMS)
        body = {"task": task.strip()}
        if params.get("root") is not None:
            if not isinstance(params["root"], str):
                raise _Refused("root must be a string", INVALID_PARAMS)
            body["root"] = params["root"]
        selection = _selection_param(params)
        if selection:
            body["model_selection"] = selection
        return self._ask("POST", "/api/sessions", body)

    def _session_set_model(self, params):
        _reject_unknown(params, {"sessionId", "providerId", "provider_id", "model",
                                 "selection", "reasoningEffort", "reasoning_effort",
                                 "saveDefault", "source"})
        body = _model_body(params, require_change=True)
        return self._ask("POST", "/api/sessions/" + _sid(params) + "/model", body)

    def _session_set_effort(self, params):
        _reject_unknown(params, {"sessionId", "reasoningEffort", "reasoning_effort",
                                 "saveDefault", "source"})
        effort = params.get("reasoningEffort", params.get("reasoning_effort"))
        if not isinstance(effort, str) or not effort.strip():
            raise _Refused("reasoningEffort must be a level string", INVALID_PARAMS)
        body = _model_body({**params, "reasoningEffort": effort.strip()}, require_change=True)
        return self._ask("POST", "/api/sessions/" + _sid(params) + "/model", body)

    def _turn_start(self, params):
        _reject_unknown(params, _TURN_KEYS)
        permission_mode = params.get("permissionMode")
        if permission_mode is not None and permission_mode not in _PERMISSION_MODES:
            raise _Refused("permissionMode must be one of: " + ", ".join(_PERMISSION_MODES),
                           INVALID_PARAMS, {"permissionMode": permission_mode})
        sid = _sid(params)
        selection = _selection_param(params)
        body = {"model_selection": selection} if selection else {}
        for source, target in (("mode", "mode"), ("permissionMode", "permission_mode"),
                               ("steps", "steps"), ("maxChars", "max_chars"),
                               ("maxTokens", "max_tokens"),
                               ("maxWallSeconds", "max_wall_seconds"),
                               ("runtimeProfile", "runtime_profile"), ("browser", "browser"),
                               ("disallowTools", "disallow_tools"),
                               ("continueQueue", "continue_queue")):
            if source in params:
                body[target] = params[source]
        text = params.get("text")
        if text is not None and not isinstance(text, str):
            raise _Refused("text must be a string", INVALID_PARAMS)
        if isinstance(text, str) and text.strip():
            message_body = {"text": text}
            if selection:
                message_body["model_selection"] = selection
            self._ask("POST", "/api/sessions/" + sid + "/messages", message_body)

        with self._turns_lock:
            if sid in self._turns:
                raise _Refused("session run already in progress", REFUSED,
                               {"status": 409, "sessionId": sid})
            worker = _TurnWorker(self, sid, body)
            self._turns[sid] = worker
        worker.start()
        return {"sessionId": sid, "accepted": True, "cursor": worker.started_at}

    def _turn_cancel(self, params):
        sid = _sid(params)
        result = self._ask("POST", "/api/sessions/" + sid + "/stop")
        with self._turns_lock:
            worker = self._turns.get(sid)
        if worker is not None:
            worker.request_stop()
        return result

    def _shutdown(self, params):
        self._stopping.set()
        with self._turns_lock:
            workers = list(self._turns.values())
        for worker in workers:
            self._call("POST", "/api/sessions/" + worker.sid + "/stop")
            worker.request_stop()
        for worker in workers:
            worker.join(SHUTDOWN_JOIN_SECONDS)
        return {"ok": True, "stoppedTurns": [worker.sid for worker in workers]}

    def _finish_turn(self, sid, worker):
        with self._turns_lock:
            if self._turns.get(sid) is worker:
                self._turns.pop(sid, None)

    # -- loop ---------------------------------------------------------------
    def serve(self, source):
        while not self._stopping.is_set():
            line, oversized = read_frame(source)
            if oversized:
                self.frames.error(None, PARSE_ERROR, _METHOD_STATUS[PARSE_ERROR],
                                  {"reason": "frame exceeds %d bytes" % MAX_FRAME_BYTES})
                continue
            if not line:
                break
            self.handle_line(line)
        return 0

    def handle_line(self, line):
        try:
            message = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.frames.error(None, PARSE_ERROR, _METHOD_STATUS[PARSE_ERROR],
                              {"reason": "frame is not valid JSON"})
            return
        if not isinstance(message, dict):
            self.frames.error(None, INVALID_REQUEST, _METHOD_STATUS[INVALID_REQUEST],
                              {"reason": "expected a JSON-RPC request object"})
            return
        request_id = message.get("id")
        if request_id is not None and not isinstance(request_id, (str, int)):
            self.frames.error(None, INVALID_REQUEST, _METHOD_STATUS[INVALID_REQUEST],
                              {"reason": "id must be a string or number"})
            return
        if message.get("jsonrpc") != "2.0":
            self.frames.error(request_id, INVALID_REQUEST, _METHOD_STATUS[INVALID_REQUEST],
                              {"reason": 'jsonrpc must be "2.0"'})
            return
        method = message.get("method")
        if not isinstance(method, str) or not method:
            self.frames.error(request_id, INVALID_REQUEST, _METHOD_STATUS[INVALID_REQUEST],
                              {"reason": "method must be a non-empty string"})
            return
        params = message.get("params")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            self.frames.error(request_id, INVALID_PARAMS, _METHOD_STATUS[INVALID_PARAMS],
                              {"reason": "params must be an object"})
            return
        handler = self._methods.get(method)
        if handler is None:
            self.frames.error(request_id, METHOD_NOT_FOUND, _METHOD_STATUS[METHOD_NOT_FOUND],
                              {"method": method, "known": sorted(self._methods)})
            return
        try:
            result = handler(params)
        except _Refused as exc:
            self.frames.error(request_id, exc.code, str(exc), exc.data or None)
            return
        except Exception as exc:
            self.log("app-server: %s raised %s: %s" % (method, type(exc).__name__, exc))
            self.frames.error(request_id, INTERNAL_ERROR, _METHOD_STATUS[INTERNAL_ERROR],
                              {"exception": type(exc).__name__})
            return
        if request_id is not None:
            self.frames.response(request_id, result)


class _TurnWorker:
    """Runs one turn on the web's own run route and mirrors events as notifications."""

    def __init__(self, server, sid, body):
        self.server = server
        self.sid = sid
        self.body = body
        self.started_at = _head_seq(server.ctx, sid)
        self.cursor = self.started_at
        self._done = threading.Event()
        self._outcome = None
        self._failure = None
        self._runner = None
        self._pump_thread = None

    def start(self):
        self._runner = threading.Thread(target=self._run_route, daemon=True,
                                        name="xueness-turn-run-" + self.sid[:8])
        self._pump_thread = threading.Thread(target=self._pump, daemon=True,
                                             name="xueness-turn-events-" + self.sid[:8])
        self._runner.start()
        self._pump_thread.start()

    def request_stop(self):
        self._done.set()

    def join(self, timeout):
        for thread in (self._runner, self._pump_thread):
            if thread is not None:
                thread.join(timeout)

    def _run_route(self):
        try:
            self._outcome = self.server._call("POST", "/api/sessions/" + self.sid + "/run",
                                              self.body)
        except Exception as exc:
            self._failure = exc
        finally:
            # The pump only stops once the route is done; a turn that never
            # returns would otherwise keep the notifications flowing forever.
            self._done.set()

    def _pump(self):
        frames = self.server.frames
        frames.notification("turn/started", {"sessionId": self.sid, "cursor": self.started_at})
        while not self._done.wait(POLL_SECONDS):
            self.cursor = self._pump_events(self.cursor)
        self._runner.join()
        self.cursor = self._pump_events(self.cursor)
        self.server._finish_turn(self.sid, self)
        if self._failure is not None:
            self.server.log("app-server: turn failed for %s: %s" % (self.sid, self._failure))
            frames.notification("turn/finished", {
                "sessionId": self.sid, "ok": False, "cursor": self.cursor,
                "error": {"code": INTERNAL_ERROR, "message": str(self._failure)}})
            return
        if self._outcome is None:
            frames.notification("turn/finished", {
                "sessionId": self.sid, "ok": False, "cursor": self.cursor,
                "error": {"code": INTERNAL_ERROR, "message": "turn produced no response"}})
            return
        status, payload = self._outcome
        finished = {"sessionId": self.sid, "ok": status < 400, "cursor": self.cursor,
                    "status": status, "result": payload}
        if status >= 400:
            body = payload if isinstance(payload, dict) else {}
            finished["error"] = {"code": _STATUS_TO_CODE.get(status, REFUSED),
                                 "message": str(body.get("error") or "route returned %s" % status)}
        frames.notification("turn/finished", finished)

    def _pump_events(self, cursor):
        try:
            session = self.server.ctx["store"].load(self.sid)
            envelope = events_protocol.page_events(
                session, events_protocol.derive_events(session), cursor,
                events_protocol.DEFAULT_LIMIT)
        except Exception as exc:
            self.server.log("app-server: event derivation failed: %s" % exc)
            return cursor
        for event in envelope["events"]:
            self.server.frames.notification("session/event",
                                            {"sessionId": self.sid, "event": event})
        return envelope["nextCursor"]


def _head_seq(ctx, sid):
    try:
        return events_protocol.head_seq(
            events_protocol.derive_events(ctx["store"].load(sid)))
    except (OSError, ValueError):
        return 0


def _sid(params):
    value = params.get("sessionId", params.get("sid"))
    if not isinstance(value, str) or not host._valid_sid(value):
        raise _Refused("sessionId must be a 32-character session id", INVALID_PARAMS,
                       {"sessionId": value if isinstance(value, str) else None})
    return value


def _reject_unknown(params, allowed):
    unknown = set(params) - allowed
    if unknown:
        raise _Refused("unexpected keys: " + ", ".join(sorted(unknown)), INVALID_PARAMS,
                       {"keys": sorted(unknown)})


def _clean_selection(raw):
    out = {}
    for key, value in raw.items():
        target = _MODEL_KEYS.get(key)
        if target is None or target == "save_default":
            continue
        if value is not None and not isinstance(value, str):
            raise _Refused("model selection values must be strings or null", INVALID_PARAMS)
        out[target] = value.strip() if isinstance(value, str) else value
        if target in _TEXT_SELECTION_KEYS and out[target] == "":
            out[target] = None
    return out


def _selection_param(params):
    raw = params.get("modelSelection")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise _Refused("modelSelection must be an object", INVALID_PARAMS)
    _reject_unknown(raw, {"providerId", "provider_id", "model", "reasoningEffort",
                          "reasoning_effort"})
    return _clean_selection(raw)


def _model_body(params, require_change=False):
    body = _clean_selection({key: value for key, value in params.items()
                             if key in _MODEL_KEYS})
    if "saveDefault" in params:
        value = params["saveDefault"]
        if value is not None and value not in (False, True):
            raise _Refused("saveDefault must be a boolean", INVALID_PARAMS)
        if value is True:
            body["save_default"] = True
    if require_change and not ({"provider_id", "model", "reasoning_effort", "selection"}
                               & set(body)):
        raise _Refused("nothing to change: provide providerId, model, selection or reasoningEffort",
                       INVALID_PARAMS)
    return body


def _xueness_version():
    from ... import __version__
    return __version__


def build_app_context(state_dir, web_runs=None, project_dir=None, workspace_roots=(),
                      allow_real=None):
    """The same host context ``xueness web`` builds, minus the socket."""
    import os
    state_dir = Path(state_dir).expanduser()
    web_runs = Path(web_runs).expanduser() if web_runs is not None else _PROJECT_DIR / ".web-runs"
    project_dir = Path(project_dir).expanduser() if project_dir is not None else _PROJECT_DIR
    if allow_real is None:
        declared = os.environ.get("XUENESS_ALLOW_REAL")
        allow_real = (declared.strip().lower() in ("1", "true", "yes", "on")
                      if declared is not None else True)
    roots = []
    for value in workspace_roots or ():
        try:
            root = Path(value).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            raise ValueError("--workspace-root must name an existing directory: %s" % value) from None
        if not root.is_dir():
            raise ValueError("--workspace-root must name a directory, not a file: %s" % value)
        if root in (Path("/").resolve(), Path("/tmp").resolve()):
            raise ValueError("--workspace-root is too broad; choose a project directory: %s" % value)
        roots.append(root)
    ctx = host.build_context(state_dir, web_runs, project_dir, allow_real,
                             workspace_roots=roots)
    plugin_runtime.sync_services(ctx)
    return ctx


def run(state_dir, stdin=None, stdout=None, stderr=None, web_runs=None,
        project_dir=None, workspace_roots=(), allow_real=None):
    """Serve the stdio protocol until EOF or ``shutdown``; return an exit code."""
    err = _binary(stderr, sys.stderr)
    out = _binary(stdout, sys.stdout)
    source = _binary(stdin, sys.stdin)

    def log(message):
        _write_bytes(err, message if message.endswith("\n") else message + "\n")
        err.flush()

    if not plugin_runtime.is_enabled(state_dir, "remote"):
        log("app-server refused to start: the remote plugin (and therefore "
            "remote.app_server) is not enabled. Enable it with "
            "`xueness plugins enable remote` first.")
        return 2
    try:
        ctx = build_app_context(state_dir, web_runs=web_runs, project_dir=project_dir,
                                workspace_roots=workspace_roots, allow_real=allow_real)
    except ValueError as exc:
        log("app-server refused to start: %s" % exc)
        return 2
    server = AppServer(ctx, _Frames(out), log=log)
    # Feature code that prints stays on stderr; only _Frames touches stdout.
    with contextlib.redirect_stdout(_LogStream(err)):
        try:
            return server.serve(source)
        except KeyboardInterrupt:
            log("app-server: interrupted")
            return 0
