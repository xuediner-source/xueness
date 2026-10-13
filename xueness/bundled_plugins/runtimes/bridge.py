"""Execution bridge for the runtimes plugin.

The v4 transport is owned by :mod:`runtimes`, while session persistence and
model execution remain owned by the sessions plugin.  This module is the
small, explicit seam between the two: it invokes the normal HTTP route
dispatch with a local handler shim and keeps run workers on the host context.

It deliberately returns ``(status, payload)`` from every public operation.
Callers can therefore preserve the sessions route's structured refusal instead
of manufacturing a second error vocabulary in the protocol adapter.
"""
from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from typing import Any, Mapping

from ... import plugin_runtime, web as host

_WORKERS_INIT_LOCK = threading.Lock()


class _RouteBridge:
    """Minimal trusted handler used to execute a normal sessions route.

    The sessions HTTP modules only rely on these handler fields.  Keeping this
    shim private prevents the runtimes plugin from depending on the remote
    stdio plugin's implementation while retaining the same route semantics.
    """

    def __init__(self, ctx: dict[str, Any], path: str):
        self._base = ctx
        self.path = path
        self.headers: dict[str, str] = {}
        self.client_address = ("127.0.0.1", 0)
        self.status: int | None = None
        self.payload: Any = None
        self._raw = bytearray()

    @property
    def _ctx(self) -> dict[str, Any]:
        return self._base

    @property
    def query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _send(self, code: int, payload: Any, content_type: str = "application/json") -> None:
        del content_type
        self.status = code
        self.payload = payload

    def send_response(self, code: int) -> None:
        self.status = code

    def send_header(self, key: str, value: str) -> None:
        del key, value

    def end_headers(self) -> None:
        return None

    def write(self, data: Any) -> None:
        self._raw.extend(data if isinstance(data, (bytes, bytearray))
                        else str(data).encode("utf-8"))

    @property
    def wfile(self) -> "_RouteBridge":
        return self


class _RunWorker:
    """One asynchronous invocation of the ordinary sessions ``/run`` route."""

    def __init__(self, bridge: "ExecutionBridge", session_id: str, body: dict[str, Any]):
        self.bridge = bridge
        self.session_id = session_id
        self.execution_id = uuid.uuid4().hex
        self.started_at = time.time() * 1000
        self.body = dict(body)
        self.done = threading.Event()
        self.status: int | None = None
        self.payload: Any = None
        self.failure: BaseException | None = None
        self.thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="xueness-v4-run-" + session_id[:8],
        )

    def start(self) -> None:
        self.thread.start()

    def join(self, timeout: float | None = None) -> None:
        self.thread.join(timeout)

    def _run(self) -> None:
        try:
            self.status, self.payload = self.bridge._call(
                "POST", f"/api/sessions/{self.session_id}/run", self.body
            )
        except BaseException as exc:  # keep worker failures inspectable
            self.failure = exc
        finally:
            self.done.set()
            self.bridge._finish_worker(self)


class ExecutionBridge:
    """Run real Xueness sessions on behalf of the runtimes plugin.

    ``ctx`` may be the request context passed to a plugin dispatch or the
    underlying host context itself.  In the former case the handler's context
    is used so run/stop bookkeeping is shared with the web server.
    """

    _WORKERS_KEY = "_runtimes_v4_workers"
    _WORKERS_LOCK_KEY = "_runtimes_v4_workers_lock"

    def __init__(self, ctx: Mapping[str, Any]):
        handler = ctx.get("handler") if isinstance(ctx, Mapping) else None
        base = getattr(handler, "_ctx", None)
        self.ctx: dict[str, Any] = base if isinstance(base, dict) else dict(ctx)
        state_dir = self.ctx.get("state_dir")
        if state_dir is None:
            raise ValueError("runtime state directory is unavailable")
        self.state_dir = Path(state_dir)

    def _guard(self) -> None:
        plugin_runtime.require_enabled(self.state_dir, "runtimes")
        if self.ctx.get("store") is None:
            raise ValueError("session store is unavailable")

    def _workers(self) -> tuple[dict[str, _RunWorker], threading.RLock]:
        # The context is shared by every request in a web/app-server process;
        # initialize these fields once without replacing a caller's lock.
        with _WORKERS_INIT_LOCK:
            lock = self.ctx.get(self._WORKERS_LOCK_KEY)
            if lock is None:
                lock = threading.RLock()
                self.ctx[self._WORKERS_LOCK_KEY] = lock
            workers = self.ctx.setdefault(self._WORKERS_KEY, {})
        return workers, lock

    def _call(self, method: str, path: str, data: Mapping[str, Any] | None = None) -> tuple[int, Any]:
        """Dispatch a sessions route through normal plugin ownership checks."""
        self._guard()
        bridge = _RouteBridge(self.ctx, path)
        parts = [part for part in urlparse(path).path.split("/") if part]
        result = plugin_runtime.dispatch_http(
            method,
            parts,
            bridge.query,
            dict(data or {}),
            {**self.ctx, "handler": bridge},
        )
        if result is None:
            return 404, {"error": "no such sessions route: " + path}
        if result is host.HANDLED_RESPONSE:
            return bridge.status or 500, (
                bridge.payload if bridge.payload is not None else {"error": "empty response"}
            )
        if (isinstance(result, tuple) and len(result) == 2
                and isinstance(result[0], int)):
            return result
        return 500, {"error": "invalid route response"}

    def create_session(
        self,
        workspace_id: str,
        *,
        first_input: Mapping[str, Any] | None = None,
        runtime_mode: str | None = None,
        model_selection: Mapping[str, Any] | None = None,
    ) -> tuple[int, Any]:
        """Create a durable Store session via ``POST /api/sessions``.

        ``workspace_id`` is metadata supplied by the v4 client.  Workspace
        paths still go through the sessions plugin's normal default/root
        admission; the bridge never turns an untrusted id into a filesystem
        path.
        """
        if not isinstance(workspace_id, str) or not workspace_id.strip():
            return 400, {"error": "workspaceId must be a non-empty string"}
        body: dict[str, Any] = {"task": "New conversation"}
        # Workspace ids from the v4 client are accepted as either an absolute
        # operator-approved path or a path relative to the server-owned
        # ``web_runs`` root.  Reuse the web admission helper; never pass an
        # unchecked path to the sessions route.
        try:
            from ..settings.workspaces_api import allowed_roots
            candidate = Path(workspace_id.strip()).expanduser()
            try:
                root = host._allowed_root(
                    candidate,
                    self.ctx["web_runs"],
                    self.ctx["project_dir"],
                    allowed_roots(self.ctx),
                )
            except ValueError:
                # A desktop may send an opaque workspace identity. It is
                # never interpreted as a path; opaque identities use the
                # server-owned run root.
                if any(char in workspace_id for char in ("/", "\\", ":")):
                    raise
                root = self.ctx["web_runs"].resolve()
            body["root"] = str(root)
        except (KeyError, OSError, RuntimeError, TypeError, ValueError):
            return 400, {"error": "workspaceId is not an allowed workspace path"}
        if first_input is not None:
            if not isinstance(first_input, Mapping):
                return 400, {"error": "firstInput must be an object"}
            text = first_input.get("text")
            if not isinstance(text, str) or not text.strip():
                return 400, {"error": "firstInput.text must be a non-empty string"}
            body["task"] = text.strip()
            if isinstance(first_input.get("modelSelection"), Mapping):
                body["model_selection"] = dict(first_input["modelSelection"])
            if first_input.get("mode") in ("plan", "build"):
                body["mode"] = first_input["mode"]
        if model_selection is not None:
            if not isinstance(model_selection, Mapping):
                return 400, {"error": "modelSelection must be an object"}
            body["model_selection"] = dict(model_selection)
        if runtime_mode is not None:
            if runtime_mode not in ("zcode-full", "pi-lite"):
                return 400, {"error": "runtimeMode must be zcode-full or pi-lite"}
            body["runtime_mode"] = runtime_mode
        status, payload = self._call("POST", "/api/sessions", body)
        if status >= 400 or not isinstance(payload, Mapping):
            return status, payload
        session_id = payload.get("id")
        if not isinstance(session_id, str):
            return 500, {"error": "session route returned no id"}
        try:
            # Persist the v4 workspace identity on the real journal.  The
            # custom field is inert to the core runner and survives reload.
            def mark(session: dict[str, Any]) -> bool:
                if session.get("workspace_id") == workspace_id.strip():
                    return False
                session["workspace_id"] = workspace_id.strip()
                return True

            session = self.ctx["store"].update(session_id, mark)
        except (OSError, ValueError, BlockingIOError):
            return 500, {"error": "session created but workspace metadata could not be saved"}
        return status, {**dict(payload), "workspaceId": workspace_id.strip(),
                        "session": session}

    def append_message(
        self,
        session_id: str,
        text: str,
        *,
        model_selection: Mapping[str, Any] | None = None,
    ) -> tuple[int, Any]:
        if not isinstance(session_id, str) or not session_id:
            return 400, {"error": "sessionId must be a non-empty string"}
        if not isinstance(text, str) or not text.strip():
            return 400, {"error": "text must be a non-empty string"}
        body: dict[str, Any] = {"text": text}
        if model_selection is not None:
            if not isinstance(model_selection, Mapping):
                return 400, {"error": "modelSelection must be an object"}
            body["model_selection"] = dict(model_selection)
        return self._call("POST", f"/api/sessions/{session_id}/messages", body)

    def start_run_async(
        self,
        session_id: str,
        *,
        options: Mapping[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        if not isinstance(session_id, str) or not session_id:
            return 400, {"error": "sessionId must be a non-empty string"}
        body = dict(options or {})
        workers, lock = self._workers()
        with lock:
            current = workers.get(session_id)
            if current is not None and not current.done.is_set():
                return 409, {"error": "session run already in progress", "sessionId": session_id}
            # A route worker may have been started by the web UI or app-server.
            # Honour the shared host set before creating another v4 worker.
            if session_id in self.ctx.setdefault("running", set()):
                return 409, {"error": "session run already in progress", "sessionId": session_id}
            worker = _RunWorker(self, session_id, body)
            workers[session_id] = worker
            worker.start()
        return 202, {
            "accepted": True,
            "sessionId": session_id,
            "executionId": worker.execution_id,
            "startedAt": worker.started_at,
        }

    def stop(
        self,
        session_id: str,
        *,
        expected_execution_id: str | None = None,
    ) -> tuple[int, Any]:
        if not isinstance(session_id, str) or not session_id:
            return 400, {"error": "sessionId must be a non-empty string"}
        workers, lock = self._workers()
        with lock:
            current = workers.get(session_id)
            if (current is not None and not current.done.is_set()
                    and expected_execution_id is not None
                    and expected_execution_id != current.execution_id):
                return 409, {"error": "stale foreground execution", "sessionId": session_id}
            # The route sets this flag when it sees a busy session.  Set it
            # before entering the route as well so a stop racing the worker's
            # first scheduling turn cannot be lost.
            if current is not None and not current.done.is_set():
                self.ctx.setdefault("stop_requested", set()).add(session_id)
        body: dict[str, Any] = {}
        if expected_execution_id is not None:
            body["expectedForegroundExecutionId"] = expected_execution_id
        return self._call("POST", f"/api/sessions/{session_id}/stop", body)

    def worker(self, session_id: str) -> _RunWorker | None:
        workers, lock = self._workers()
        with lock:
            return workers.get(session_id)

    def _finish_worker(self, worker: _RunWorker) -> None:
        workers, lock = self._workers()
        with lock:
            if workers.get(worker.session_id) is worker:
                # Keep completed workers inspectable until the next start, but
                # don't retain an unbounded map after a long-lived desktop run.
                workers.pop(worker.session_id, None)


def create_execution_bridge(ctx: Mapping[str, Any]) -> ExecutionBridge:
    return ExecutionBridge(ctx)
