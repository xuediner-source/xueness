"""Lifecycle boundary for the optional local ``pi-lite`` runtime.

The runtimes plugin owns this service.  It is intentionally a small process
boundary rather than a model client: callers provide a trusted local argv,
and request/response frames cross stdin/stdout using the versioned Xueness
JSONL protocol.  No shell is used and no provider credentials are copied into
the child environment by default.

A sidecar is not allowed to become a second transcript.  The session plugin
remains the owner of durable messages and tool results; this service only
owns the child process and exposes bounded diagnostics for the caller to
persist or project.
"""
from __future__ import annotations

from collections import deque
import os
import math
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any, Mapping, Sequence

from ... import plugin_runtime
from ...process_runtime import (
    decode_subprocess_output,
    forget_owned_process,
    note_owned_process,
    process_running,
    spawn_external,
    terminate_process_tree,
)
from ...resources import _is_link

from .runtime import (
    RuntimeRequest,
    RuntimeResponse,
    decode_response,
    encode_request,
    load_selection,
)


MAX_FRAME_BYTES = 1_048_576
MAX_STDERR_BYTES = 64 * 1024
MAX_ARG_BYTES = 32 * 1024
MAX_ARG_CHARS = 4096
MAX_SIDECARS = 8
_SIDECARE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
_SECRET_ENV = re.compile(r"(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.I)
_EOF = object()


class SidecarError(RuntimeError):
    """Base error raised at the local runtime boundary."""


class SidecarBusy(SidecarError):
    """A requested sidecar id already has a live child."""


class SidecarExited(SidecarError):
    """The child stopped before a response was available."""

    def __init__(self, message: str, *, returncode: int | None = None,
                 stderr: str = "") -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class SidecarProtocolError(SidecarError):
    """The child wrote a frame outside the strict runtime response schema."""


class _FrameError:
    def __init__(self, error: BaseException):
        self.error = error


def _sidecar_id(value: Any) -> str:
    if not isinstance(value, str) or _SIDECARE_ID.fullmatch(value) is None:
        raise ValueError("sidecarId has invalid format")
    return value


def _argv(value: Sequence[str]) -> tuple[str, ...]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise ValueError("sidecar command must be an argv array")
    result: list[str] = []
    total = 0
    for item in value:
        if not isinstance(item, str) or not item or "\x00" in item:
            raise ValueError("sidecar command arguments must be non-empty strings")
        if len(item) > MAX_ARG_CHARS:
            raise ValueError("sidecar command argument is too long")
        total += len(item.encode("utf-8")) + 1
        if total > MAX_ARG_BYTES:
            raise ValueError("sidecar command is too long")
        result.append(item)
    if not result:
        raise ValueError("sidecar command cannot be empty")
    return tuple(result)


def _environment(value: Mapping[str, str] | None) -> dict[str, str]:
    """Return a child environment with credential-like keys removed.

    A local model process gets ordinary runtime variables such as ``PATH``
    and locale settings, but provider credentials from the desktop process do
    not cross this boundary accidentally.  Callers can supply extra local
    variables; the same denylist and value validation still apply.
    """
    source = os.environ if value is None else value
    if not isinstance(source, Mapping):
        raise ValueError("sidecar environment must be an object")
    result: dict[str, str] = {}
    for key, item in source.items():
        if not isinstance(key, str) or not key or "\x00" in key or "=" in key:
            raise ValueError("sidecar environment names are invalid")
        if not isinstance(item, str) or "\x00" in item:
            raise ValueError("sidecar environment values are invalid")
        if _SECRET_ENV.search(key):
            continue
        if len(key) + len(item) > MAX_ARG_BYTES:
            raise ValueError("sidecar environment entry is too long")
        result[key] = item
    return result


def _cwd(value: str | os.PathLike[str] | None) -> str | None:
    if value is None:
        return None
    path = Path(value)
    if _is_link(path):
        raise ValueError("sidecar working directory must not be a symlink")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("sidecar working directory is unavailable") from exc
    if not resolved.is_dir():
        raise ValueError("sidecar working directory must be a directory")
    return str(resolved)


class PiLiteSidecar:
    """One local JSONL child process.

    stdout and stderr are drained by dedicated threads so a diagnostic-heavy
    child cannot deadlock the request path.  Only decoded response frames are
    placed in the response queue; malformed output is surfaced as a protocol
    error and never treated as an assistant message.
    """

    def __init__(self, sidecar_id: str, command: Sequence[str], *,
                 cwd: str | os.PathLike[str] | None = None,
                 env: Mapping[str, str] | None = None,
                 max_stderr_bytes: int = MAX_STDERR_BYTES,
                 guard=None):
        self.sidecar_id = _sidecar_id(sidecar_id)
        self.command = _argv(command)
        self.cwd = _cwd(cwd)
        self.env = _environment(env)
        if type(max_stderr_bytes) is not int or not 1024 <= max_stderr_bytes <= MAX_STDERR_BYTES:
            raise ValueError("max_stderr_bytes is out of range")
        self.max_stderr_bytes = max_stderr_bytes
        self._guard = guard
        self._proc: subprocess.Popen | None = None
        self._tree_group = os.name != "nt"
        self._responses: queue.Queue[Any] = queue.Queue(maxsize=32)
        self._pending: deque[RuntimeResponse] = deque()
        self._send_lock = threading.RLock()
        self._state_lock = threading.RLock()
        self._stderr_lock = threading.Lock()
        self._stderr = bytearray()
        self._stderr_truncated = False
        self._reader_threads: list[threading.Thread] = []
        self._closed = False
        self._closed_event = threading.Event()
        self._started_at: float | None = None
        self._stopped_at: float | None = None
        self._returncode: int | None = None

    @property
    def process(self) -> subprocess.Popen | None:
        return self._proc

    def _admit(self) -> None:
        if self._guard is not None:
            self._guard()

    def start(self) -> "PiLiteSidecar":
        self._admit()
        with self._state_lock:
            if self._proc is not None and process_running(self._proc):
                raise SidecarBusy("sidecar is already running")
            if self._closed:
                raise SidecarError("sidecar has been closed")
            kwargs: dict[str, Any] = {
                "cwd": self.cwd,
                "env": self.env,
                "stdin": subprocess.PIPE,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "shell": False,
                "bufsize": 0,
                "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            }
            if os.name != "nt":
                kwargs["start_new_session"] = True
            try:
                proc = spawn_external(subprocess.Popen, list(self.command), **kwargs)
            except (OSError, ValueError) as exc:
                raise SidecarError("could not start pi-lite sidecar") from exc
            self._proc = proc
            self._started_at = time.time() * 1000
            self._stopped_at = None
            self._returncode = None
            note_owned_process(proc, group=self._tree_group)
            stdout_thread = threading.Thread(target=self._read_stdout, daemon=True,
                                             name="xueness-pi-lite-stdout")
            stderr_thread = threading.Thread(target=self._read_stderr, daemon=True,
                                             name="xueness-pi-lite-stderr")
            self._reader_threads = [stdout_thread, stderr_thread]
            stdout_thread.start()
            stderr_thread.start()
            return self

    def _offer(self, value) -> None:
        while not self._closed_event.is_set():
            try:
                self._responses.put(value, timeout=0.1)
                return
            except queue.Full:
                continue

    def _read_stdout(self) -> None:
        proc = self._proc
        stream = getattr(proc, "stdout", None)
        if stream is None:
            self._offer(_FrameError(SidecarProtocolError("sidecar stdout is unavailable")))
            self._offer(_EOF)
            return
        try:
            while True:
                raw = stream.readline(MAX_FRAME_BYTES + 2)
                if not raw:
                    break
                if not raw.endswith(b"\n"):
                    self._offer(_FrameError(SidecarProtocolError("sidecar frame exceeds size limit")))
                    break
                # Native text writers on Windows commonly emit CRLF.  The
                # wire contract remains one JSON object per LF-terminated
                # line; normalize only the single framing CR and let the
                # strict decoder reject any embedded carriage return.
                if raw.endswith(b"\r\n"):
                    raw = raw[:-2] + b"\n"
                if len(raw) > MAX_FRAME_BYTES + 1:
                    self._offer(_FrameError(SidecarProtocolError("sidecar frame exceeds size limit")))
                    break
                try:
                    frame = decode_response(raw)
                except (TypeError, ValueError) as exc:
                    self._offer(_FrameError(SidecarProtocolError("invalid sidecar response")))
                    break
                self._offer(frame)
        except (OSError, ValueError) as exc:
            self._offer(_FrameError(SidecarExited("sidecar stdout read failed", stderr=self.stderr)))
        finally:
            self._offer(_EOF)

    def _read_stderr(self) -> None:
        proc = self._proc
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8", "replace")
                with self._stderr_lock:
                    self._stderr.extend(chunk)
                    if len(self._stderr) > self.max_stderr_bytes:
                        self._stderr = self._stderr[-self.max_stderr_bytes:]
                        self._stderr_truncated = True
        except (OSError, ValueError):
            return

    @property
    def stderr(self) -> str:
        with self._stderr_lock:
            value = decode_subprocess_output(bytes(self._stderr))
            if self._stderr_truncated:
                return "[stderr truncated]\n" + value
            return value

    def _running(self) -> bool:
        proc = self._proc
        return proc is not None and process_running(proc)

    def _ensure_running(self) -> subprocess.Popen:
        proc = self._proc
        if proc is None or not self._running():
            code = getattr(proc, "returncode", None) if proc is not None else self._returncode
            raise SidecarExited("pi-lite sidecar is not running", returncode=code, stderr=self.stderr)
        return proc

    def send(self, request: RuntimeRequest) -> None:
        self._admit()
        encoded = encode_request(request).encode("utf-8")
        if len(encoded) > MAX_FRAME_BYTES:
            raise ValueError("sidecar request exceeds size limit")
        with self._send_lock:
            proc = self._ensure_running()
            stream = proc.stdin
            if stream is None:
                raise SidecarExited("sidecar stdin is unavailable", stderr=self.stderr)
            try:
                stream.write(encoded)
                stream.flush()
            except (BrokenPipeError, OSError) as exc:
                raise SidecarExited("sidecar stopped while sending", stderr=self.stderr) from exc

    def receive(self, timeout: float | None = None) -> RuntimeResponse:
        self._admit()
        if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout < 0):
            raise ValueError("timeout must be non-negative")
        try:
            value = self._responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("timed out waiting for sidecar response") from exc
        if value is _EOF:
            proc = self._proc
            code = getattr(proc, "returncode", None) if proc is not None else self._returncode
            raise SidecarExited("sidecar exited before a response", returncode=code, stderr=self.stderr)
        if isinstance(value, _FrameError):
            raise value.error
        if not isinstance(value, dict):
            raise SidecarProtocolError("sidecar returned an invalid response")
        return value

    def request(self, request: RuntimeRequest, *, timeout: float | None = 30.0) -> RuntimeResponse:
        """Send one request and wait for its matching response.

        Frames for another request are retained in a bounded in-memory queue;
        they are never dropped into the transcript.  Concurrent sends are
        serialized to preserve stdin frame boundaries.
        """
        request_id = request.get("requestId") if isinstance(request, Mapping) else None
        if not isinstance(request_id, str):
            raise ValueError("requestId is required")
        with self._send_lock:
            self.send(request)
            deadline = None if timeout is None else time.monotonic() + timeout
            try:
                while True:
                    for index, frame in enumerate(self._pending):
                        if frame.get("requestId") == request_id:
                            del self._pending[index]
                            return frame
                    if deadline is None:
                        remaining = None
                    else:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("timed out waiting for sidecar response")
                    frame = self.receive(remaining)
                    if frame.get("requestId") == request_id:
                        return frame
                    if len(self._pending) >= 64:
                        raise SidecarProtocolError("too many unmatched sidecar responses")
                    self._pending.append(frame)
            except (TimeoutError, SidecarProtocolError, SidecarExited):
                # There is no public cancel frame yet.  A timed-out or
                # malformed request therefore terminates this serialized
                # child, closing the leak window instead of leaving work
                # running after the caller has abandoned it.
                self.stop(grace=0.5)
                raise

    def request_stream(self, request: RuntimeRequest, on_frame, *,
                       timeout: float | None = 30.0, should_stop=None) -> RuntimeResponse:
        """Deliver matching stream frames until a result or error frame.

        The callback is invoked in the caller's thread.  The serialized child
        is stopped if the callback, timeout, or protocol boundary fails.
        """
        if not callable(on_frame):
            raise TypeError("on_frame must be callable")
        request_id = request.get("requestId") if isinstance(request, Mapping) else None
        if not isinstance(request_id, str):
            raise ValueError("requestId is required")
        if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout < 0):
            raise ValueError("timeout must be finite and non-negative")
        with self._send_lock:
            self.send(request)
            deadline = None if timeout is None else time.monotonic() + timeout
            try:
                while True:
                    from ..providers import cancel_watch
                    cancel_watch.raise_if_active()
                    if should_stop is not None and should_stop():
                        raise cancel_watch.ProviderCancelled()
                    frame = None
                    for index, pending in enumerate(self._pending):
                        if pending.get("requestId") == request_id:
                            frame = pending
                            del self._pending[index]
                            break
                    if frame is None:
                        if deadline is None:
                            remaining = None
                        else:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise TimeoutError("timed out waiting for sidecar response")
                        try:
                            frame = self.receive(min(0.1, remaining) if remaining is not None else 0.1)
                        except TimeoutError:
                            if self._closed:
                                raise cancel_watch.ProviderCancelled("pi-lite sidecar closed")
                            self._ensure_running()
                            continue
                        if frame.get("requestId") != request_id:
                            if len(self._pending) >= 64:
                                raise SidecarProtocolError("too many unmatched sidecar responses")
                            self._pending.append(frame)
                            continue
                    if (frame.get("sessionId") != request.get("sessionId")
                            or frame.get("method") != request.get("method")):
                        raise SidecarProtocolError("sidecar response identity mismatch")
                    on_frame(frame)
                    payload = frame.get("payload") or {}
                    if not frame.get("ok") or payload.get("type") in (None, "result"):
                        return frame
            except (TimeoutError, SidecarProtocolError, SidecarExited):
                self.stop(grace=0.5)
                raise
            except Exception:
                self.stop(grace=0.5)
                raise

    def status(self) -> dict[str, Any]:
        proc = self._proc
        running = self._running()
        if proc is not None and not running and self._returncode is None:
            self._returncode = getattr(proc, "returncode", None)
        return {
            "sidecarId": self.sidecar_id,
            "status": "running" if running else ("stopped" if proc is not None else "new"),
            "pid": getattr(proc, "pid", None),
            "startedAt": self._started_at,
            "stoppedAt": self._stopped_at,
            "exitCode": self._returncode,
            "stderr": self.stderr,
        }

    def stop(self, *, grace: float = 1.0) -> dict[str, Any]:
        if not isinstance(grace, (int, float)) or grace < 0 or grace > 30:
            raise ValueError("grace must be between 0 and 30 seconds")
        with self._state_lock:
            if self._closed:
                return self.status()
            proc = self._proc
            self._closed = True
            self._closed_event.set()
            if proc is None:
                self._stopped_at = time.time() * 1000
                return self.status()
            try:
                stream = proc.stdin
                if stream is not None:
                    stream.close()
            except OSError:
                pass
            try:
                terminate_process_tree(proc, group=self._tree_group, grace=grace)
            finally:
                self._returncode = getattr(proc, "returncode", None)
                self._stopped_at = time.time() * 1000
                forget_owned_process(proc)
                for thread in self._reader_threads:
                    if thread.is_alive():
                        thread.join(timeout=min(1.0, max(0.1, grace)))
                for name in ("stdout", "stderr"):
                    stream = getattr(proc, name, None)
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
            return self.status()

    close = stop


class PiLiteSidecarSupervisor:
    """Plugin-scoped registry of local pi-lite sidecars."""

    def __init__(self, state_dir: str | os.PathLike[str], *, ctx: Mapping[str, Any] | None = None):
        self.state_dir = Path(state_dir).absolute()
        if _is_link(self.state_dir):
            raise ValueError("runtime state directory must not be a symlink")
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.ctx = dict(ctx or {})
        self._lock = threading.RLock()
        self._sidecars: dict[str, PiLiteSidecar] = {}

    def _guard(self) -> None:
        plugin_runtime.require_enabled(self.state_dir, "runtimes")
        if load_selection(self.state_dir) != "pi-lite":
            raise SidecarError("pi-lite sidecar requires the pi-lite runtime profile")

    def start(self, sidecar_id: str, command: Sequence[str], *,
              cwd: str | os.PathLike[str] | None = None,
              env: Mapping[str, str] | None = None, session_profile=None) -> PiLiteSidecar:
        if session_profile is not None and session_profile != "pi-lite":
            raise ValueError("sidecar session profile must be pi-lite")
        def guard():
            if session_profile is None:
                self._guard()
            else:
                # An explicit saved session mode need not be the default mode
                # used for new sessions. It still obeys all effective plugins.
                for pid in ("runtimes", "sessions", "providers"):
                    plugin_runtime.require_enabled(self.state_dir, pid)
        guard()
        sid = _sidecar_id(sidecar_id)
        with self._lock:
            existing = self._sidecars.get(sid)
            if existing is not None and existing.status()["status"] == "running":
                raise SidecarBusy("sidecar is already running: " + sid)
            if len(self._sidecars) >= MAX_SIDECARS and existing is None:
                raise SidecarBusy("too many pi-lite sidecars")
            sidecar = PiLiteSidecar(sid, command, cwd=cwd, env=env, guard=guard)
            try:
                sidecar.start()
            except BaseException:
                sidecar.stop(grace=0)
                raise
            self._sidecars[sid] = sidecar
            return sidecar

    def get(self, sidecar_id: str) -> PiLiteSidecar | None:
        self._guard()
        with self._lock:
            return self._sidecars.get(_sidecar_id(sidecar_id))

    def stop(self, sidecar_id: str, *, grace: float = 1.0) -> dict[str, Any]:
        sid = _sidecar_id(sidecar_id)
        with self._lock:
            sidecar = self._sidecars.pop(sid, None)
        if sidecar is None:
            return {"sidecarId": sid, "status": "stopped", "pid": None,
                    "startedAt": None, "stoppedAt": None, "exitCode": None, "stderr": ""}
        return sidecar.stop(grace=grace)

    def statuses(self) -> list[dict[str, Any]]:
        self._guard()
        with self._lock:
            return [self._sidecars[key].status() for key in sorted(self._sidecars)]

    def close_all(self) -> None:
        with self._lock:
            sidecars = list(self._sidecars.values())
            self._sidecars.clear()
        for sidecar in sidecars:
            try:
                sidecar.stop(grace=1.0)
            except (OSError, SidecarError):
                pass


def create_pi_lite_sidecar(ctx: Mapping[str, Any]) -> PiLiteSidecarSupervisor:
    """Create the lifecycle service published by the runtimes plugin."""
    state_dir = ctx.get("state_dir") if isinstance(ctx, Mapping) else None
    if state_dir is None:
        raise ValueError("runtime state directory is unavailable")
    return PiLiteSidecarSupervisor(state_dir, ctx=ctx)


def local_provider_command(state_dir=None) -> tuple[str, ...]:
    """Return the bundled provider worker command without a shell."""
    if getattr(sys, 'frozen', False):
        if state_dir is None:
            raise ValueError('frozen worker requires a state directory')
        return (sys.executable, '--state', str(state_dir), 'pi-lite-worker')
    return (sys.executable, "-m", "xueness.bundled_plugins.runtimes.pi_sidecar_process")


def start_local_provider(supervisor: PiLiteSidecarSupervisor, sidecar_id: str,
                         *, cwd: str | os.PathLike[str] | None = None,
                         session_profile=None) -> PiLiteSidecar:
    """Start the bundled worker with only the trusted state directory input."""
    env = dict(os.environ)
    env["XUENESS_PI_LITE_STATE_DIR"] = str(supervisor.state_dir)
    # Source launches must work when the CLI was invoked from another cwd.
    worker_cwd = cwd or Path(__file__).resolve().parents[3]
    return supervisor.start(sidecar_id, local_provider_command(supervisor.state_dir), cwd=worker_cwd, env=env,
                            session_profile=session_profile)


__all__ = [
    "MAX_FRAME_BYTES", "MAX_STDERR_BYTES", "PiLiteSidecar", "PiLiteSidecarSupervisor",
    "SidecarBusy", "SidecarError", "SidecarExited", "SidecarProtocolError",
    "create_pi_lite_sidecar", "local_provider_command", "start_local_provider",
]
