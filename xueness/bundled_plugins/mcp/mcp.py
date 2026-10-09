"""stdio MCP client (Stage 5 contract, section "二、MCP").

Loads user-configured MCP servers and speaks newline-delimited JSON-RPC 2.0 to
them over stdin/stdout, so a run can offer their tools to the model::

    <state_dir>/resources/mcp/<id>.json

Each file is a JSON object with ``id``, ``command`` and optional
``args`` / ``name`` / ``enabled`` / ``timeout``.

Design decisions, mirroring ``hooks.py`` because both spawn child processes for
untrusted-ish configuration:

* ``load`` never writes, refuses a symlinked directory and symlinked entries
  (``O_NOFOLLOW``), and skips one broken entry instead of failing the list.
* POSIX children see only ``PATH`` and ``HOME``; Windows also restores the
  fixed public OS/runtime allowlist through ``process_runtime``. Private
  environment variables are never inherited wholesale.
* ``argv`` is a list with ``shell=False``; a configured ``args`` entry is never
  re-parsed by a shell.
* the child's ``stderr`` is drained into a small bounded buffer purely to keep
  the pipe from filling; it is **never** echoed back, and no child output is
  ever put into an error string. Failures are reported as metadata only
  (``timeout after 1.0s``, ``FileNotFoundError: ...``).
* no exception may propagate out of ``start`` / ``list_tools`` / ``call_tool``
  / ``close``: a dead, missing, silent or hostile server becomes a failed call,
  never a broken run.
* a read timeout kills that server's process; ``close()`` is idempotent and
  always reaps the child.

A tool called ``read`` on server ``srv`` is exposed as ``mcp__srv__read``;
``parse_namespaced`` turns that back into ``("srv", "read")``.
"""
from __future__ import annotations

import collections
import json
import math
import os
import queue
import re
import subprocess
import threading
import time
from pathlib import Path
from ...resources import _is_link, _kind_dir

MCP_PREFIX = "mcp__"
DEFAULT_TIMEOUT = 10
TIMEOUT_CAP = 30
DEFAULT_OUTPUT_CAP = 2000

# Handshake constants, straight from the contract.
#: The version we ask for first. Chosen for reach: a server that only knows old
#: versions still accepts it, and a newer server answers with its own version.
PROTOCOL_VERSION = "2024-11-05"
#: Every version this client can actually speak, oldest first. The MCP spec is
#: explicit that the client must disconnect when the server answers with a
#: version outside this set: an unknown version may use a different wire shape,
#: and carrying on would mis-parse later messages. Each entry is exercised
#: against the official SDK server in ``tests/test_mcp_real_interop.py``.
SUPPORTED_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
CLIENT_INFO = {"name": "xueness", "version": "0.1"}

TRUNCATION_SUFFIX = "…(truncated)"

ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# Dot-only names satisfy the regex but are traversal/parent markers, not names.
RESERVED_NAMES = frozenset({".", ".."})

# Seconds to wait for a signalled child before escalating to SIGKILL.
CLOSE_GRACE = 1.0
# Bounded stderr drain buffer (never surfaced, purely to avoid a full pipe).
STDERR_LINES = 64


class _McpError(Exception):
    """Base for failures already phrased as safe metadata."""


class _McpTransportError(_McpError):
    """The connection itself is unusable (timeout, EOF, bad write)."""


# --- helpers ---------------------------------------------------------------


def _fail_text(exc) -> str:
    """A short, metadata-only description of a failure."""
    if isinstance(exc, _McpError):
        return str(exc)
    return "%s: %s" % (type(exc).__name__, exc)


def _as_positive_float(value):
    """``value`` as a finite positive float, else ``None``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= 0:
        return None
    return number


def _as_positive_int(value, fallback: int) -> int:
    number = _as_positive_float(value)
    if number is None:
        return fallback
    return int(number)


def _valid_name(value) -> bool:
    """True for a usable server id or tool name (``[A-Za-z0-9._-]{1,64}``)."""
    if not isinstance(value, str):
        return False
    if value in RESERVED_NAMES:
        return False
    # ``fullmatch`` (not ``match``) so a trailing newline cannot slip past ``$``.
    return ID_PATTERN.fullmatch(value) is not None


def clip(text, max_chars: int) -> str:
    """Trim ``text`` to ``max_chars`` characters, keeping a truncation marker."""
    t = text if isinstance(text, str) else str(text)
    if not max_chars or len(t) <= max_chars:
        return t
    keep = max_chars - len(TRUNCATION_SUFFIX)
    if keep <= 0:
        return TRUNCATION_SUFFIX[:max_chars]
    return t[:keep] + TRUNCATION_SUFFIX


def _mcp_dir(state_dir) -> Path:
    return Path(state_dir) / "resources" / "mcp"


def _safe_read_json(path: Path):
    """Read one server file, refusing symlinks (``O_NOFOLLOW``).

    A symlinked entry, an unreadable file, invalid JSON and a document that is
    not an object all yield ``None`` so a single broken entry can never take
    down the list or pull in a foreign file.
    """
    if _is_link(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def load(state_dir) -> list:
    """Every usable MCP server under ``<state_dir>/resources/mcp``, id ascending.

    Skips (in this order): a symlinked directory, a missing directory,
    symlinked entries, broken JSON / non-object documents, entries without a
    legal ``id``, disabled entries, and entries whose ``command`` is not a
    non-blank string. One bad entry only costs that entry.
    """
    try:
        mcp_dir = _kind_dir({"state_dir": state_dir}, "mcp")
    except (OSError, ValueError):
        return []
    # A symlinked directory would relocate the whole jail; refuse it outright.
    if _is_link(mcp_dir):
        return []
    if not mcp_dir.is_dir():
        return []
    servers = []
    for path in sorted(mcp_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _safe_read_json(path)
        if item is None:
            continue
        server_id = item.get("id")
        if not _valid_name(server_id):
            continue
        if item.get("enabled") is False:
            continue
        command = item.get("command")
        if (not isinstance(command, str) or not command.strip()) and not (
                item.get("transport") in ("http", "streamable-http", "sse") and isinstance(item.get("url"), str)):
            continue
        server = dict(item)
        server["id"] = server_id
        servers.append(server)
    servers.sort(key=lambda server: server["id"])
    return servers


# --- naming ----------------------------------------------------------------

def client_for(server, **kwargs):
    if server.get("transport") == "sse":
        from .sse import SseMcpClient
        return SseMcpClient(server, **kwargs)
    if server.get("transport") in ("http", "streamable-http"):
        from ...mcp_http import HttpMcpClient
        return HttpMcpClient(server, **kwargs)
    return McpClient(server, **kwargs)


def namespaced(server_id, tool_name) -> str:
    """``("srv", "read")`` -> ``"mcp__srv__read"``."""
    return "%s%s__%s" % (MCP_PREFIX, server_id, tool_name)


def parse_namespaced(name):
    """``"mcp__srv__read"`` -> ``("srv", "read")``, anything else -> ``None``.

    Both halves must be ``[A-Za-z0-9._-]{1,64}`` and neither may be ``.`` or
    ``..``. ``__`` is legal *inside* a server id or tool name, which makes a
    name like ``mcp__a__b__c`` ambiguous by construction; the earliest split
    where both halves are legal wins (so ``server="a"``, ``tool="b__c"``).
    """
    if not isinstance(name, str) or not name.startswith(MCP_PREFIX):
        return None
    rest = name[len(MCP_PREFIX):]
    index = rest.find("__")
    while index != -1:
        server, tool = rest[:index], rest[index + 2:]
        if _valid_name(server) and _valid_name(tool):
            return (server, tool)
        index = rest.find("__", index + 1)
    return None


def sanitize_mcp_name_part(name: str) -> str:
    """Sanitize name to match [A-Za-z0-9._-]{1,64}, matching ZCode toModelVisibleMcpNamePart."""
    if not isinstance(name, str) or not name.strip():
        return "unnamed"
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "_", name.strip())
    sanitized = re.sub(r"_+", "_", sanitized)
    if not sanitized or sanitized in RESERVED_NAMES:
        return "tool"
    return sanitized[:64]


def tool_schema(server_id, tool) -> dict:
    """An OpenAI function schema for one tool of ``server_id``.

    ``name`` is the namespaced tool name, ``description`` falls back to ``""``
    and ``parameters`` falls back to an empty object schema when the server
    omits ``inputSchema`` (or sends something that is not an object).
    """
    item = tool if isinstance(tool, dict) else {}
    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "unnamed"
    else:
        name = sanitize_mcp_name_part(name)
    description = item.get("description")
    if not isinstance(description, str):
        description = ""
    parameters = item.get("inputSchema")
    if not isinstance(parameters, dict):
        parameters = {"type": "object", "properties": {}}
    return {
        "type": "function",
        "function": {
            "name": namespaced(server_id, name),
            "description": description,
            "parameters": parameters,
        },
    }


def _extract_text(content) -> str:
    """Join the text of content items."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        itype = item.get("type")
        if itype == "text":
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
        elif itype == "resource":
            res = item.get("resource")
            if isinstance(res, dict):
                res_text = res.get("text")
                if isinstance(res_text, str):
                    parts.append(res_text)
                else:
                    parts.append("MCP resource: " + json.dumps(res, ensure_ascii=False))
    return "\n".join(parts)


# --- client ----------------------------------------------------------------


class McpClient:
    """One stdio MCP server, spoken to over newline-delimited JSON-RPC 2.0.

    ``server`` is a ``load`` entry; ``cwd`` is the child's working directory.
    ``timeout`` is per request, overridable by the server's own ``timeout`` key
    and always clamped to ``timeout_cap``. No public method raises.
    """

    def __init__(self, server, *, cwd, timeout: int = DEFAULT_TIMEOUT,
                 timeout_cap: int = TIMEOUT_CAP, output_cap: int = DEFAULT_OUTPUT_CAP):
        self.server = dict(server) if isinstance(server, dict) else {}
        self.cwd = cwd
        self.timeout_cap = _as_positive_int(timeout_cap, TIMEOUT_CAP)
        self.timeout = self._resolve_timeout(timeout)
        self.output_cap = _as_positive_int(output_cap, DEFAULT_OUTPUT_CAP)
        self.proc = None
        self._process_job = None
        self._process_cleanup_failed = False
        self._process_cleanup_error = None
        self.error = None
        self.tools = []
        #: What the server actually agreed to in ``initialize`` (None until then).
        #: Worth keeping: a server may answer with a different protocol version
        #: than we asked for, and that is exactly the detail you need when an
        #: interop bug shows up.
        self.negotiated_protocol_version = None
        self.server_info = {}
        self.server_capabilities = {}
        self._started = False
        self._next_id = 3
        self._queue = queue.Queue()
        self._stderr = collections.deque(maxlen=STDERR_LINES)
        self._threads = []
        self._lock = threading.RLock()

    # --- configuration ------------------------------------------------------

    def _resolve_timeout(self, requested) -> float:
        """Requested timeout, overridden by the server's own, capped by the cap."""
        seconds = _as_positive_float(self.server.get("timeout"))
        if seconds is None:
            seconds = _as_positive_float(requested)
        if seconds is None:
            seconds = float(DEFAULT_TIMEOUT)
        return min(seconds, float(self.timeout_cap))

    def _error_with_cleanup(self, message: str) -> str:
        """Keep a process-tree cleanup failure visible in later errors."""
        cleanup_error = self._process_cleanup_error
        if cleanup_error and cleanup_error not in message:
            return message + "; " + cleanup_error
        return message

    @property
    def active(self) -> bool:
        """True while a live child process is attached."""
        proc = self.proc
        return proc is not None and proc.poll() is None

    # --- transport ----------------------------------------------------------

    def _spawn_reader(self, stream) -> None:
        """Drain stdout into ``self._queue``; EOF pushes ``None``."""

        def read_lines():
            try:
                for line in stream:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    self._queue.put(message)
            except Exception:  # noqa: BLE001 - a broken pipe is not fatal here
                pass
            finally:
                self._queue.put(None)

        thread = threading.Thread(target=read_lines, daemon=True)
        thread.start()
        self._threads.append(thread)

    def _spawn_stderr_drain(self, stream) -> None:
        """Keep stderr from filling; content is deliberately never surfaced."""

        def drain():
            try:
                for line in stream:
                    self._stderr.append(line.rstrip("\n"))
            except Exception:  # noqa: BLE001
                pass

        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        self._threads.append(thread)

    def _write(self, message: dict) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            raise _McpTransportError("server process is not running")
        stream = proc.stdin
        if stream is None:
            raise _McpTransportError("server stdin is unavailable")
        try:
            stream.write(json.dumps(message) + "\n")
            stream.flush()
        except Exception as exc:  # noqa: BLE001
            raise _McpTransportError("write failed: %s" % type(exc).__name__)

    def _notify(self, method: str, params=None) -> None:
        """A JSON-RPC notification: same shape, but no ``id`` and no reply."""
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write(message)

    def _post_result(self, response: dict) -> None:
        """Send one JSON-RPC response to the server. Stdio writes it to stdin."""
        self._write(response)

    def _answer_server_request(self, message: dict) -> None:
        """Answer a server-initiated request without treating it as our result.

        The reply is the only place an elicitation answer is written. A
        transport failure names the exception type and does not include that
        answer.
        """
        from .elicitation import response_for
        reply = response_for(self, message)
        if reply is not None:
            self._post_result(reply)

    def _await(self, request_id, deadline: float) -> dict:
        """The response whose ``id`` matches, or a transport error.

        A server request is answered before it can be mistaken for our result.
        Time spent waiting for the operator is added back onto the deadline so
        the tool-call timeout does not expire during that wait.
        """
        from .elicitation import is_server_request
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._kill_proc()
                raise _McpTransportError("timeout after %.1fs" % self.timeout)
            try:
                message = self._queue.get(timeout=remaining)
            except queue.Empty:
                self._kill_proc()
                raise _McpTransportError("timeout after %.1fs" % self.timeout)
            if message is None:
                self._kill_proc()
                raise _McpTransportError("server closed stdout before replying")
            if not isinstance(message, dict):
                continue
            if is_server_request(message):
                started = time.monotonic()
                self._answer_server_request(message)
                deadline += time.monotonic() - started
                continue
            if message.get("id") == request_id:
                return message
            # Notifications and unrelated ids are ignored.

    def _request(self, method: str, params, request_id: int) -> dict:
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        deadline = time.monotonic() + self.timeout
        self._write(message)
        response = self._await(request_id, deadline)
        if response.get("error") is not None:
            raise _McpError("server error: %s" % _error_summary(response.get("error")))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    # --- lifecycle ----------------------------------------------------------

    def _preferred_version(self) -> str:
        """The version to ask for first.

        A per-server ``protocolVersion`` key pins one server without changing
        global behaviour. Anything unknown or unsupported falls back to the
        default rather than being sent blindly.
        """
        pinned = self.server.get("protocolVersion")
        if isinstance(pinned, str) and pinned in SUPPORTED_PROTOCOL_VERSIONS:
            return pinned
        from .elicitation import ELICITATION_PROTOCOL, elicitation_enabled
        if elicitation_enabled(self.server):
            return ELICITATION_PROTOCOL
        return PROTOCOL_VERSION

    def _version_ladder(self) -> list:
        """Versions to try, in order, when the server rejects our first choice.

        Preferred first, then the rest newest-first: a server that dropped an
        old version is far more likely to speak a recent one than a middle one.
        """
        preferred = self._preferred_version()
        rest = [v for v in reversed(SUPPORTED_PROTOCOL_VERSIONS) if v != preferred]
        return [preferred] + rest

    def _spawn(self, argv) -> bool:
        """Start the child and wire its readers; ``False`` sets ``self.error``."""
        # Minimal environment on purpose: never forward os.environ.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
        }
        if os.name == 'nt':
            env.update({key: value for key, value in os.environ.items()
                        if key.upper() in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE')})
        try:
            from ...process_runtime import spawn_external
            process_factory = subprocess.Popen
            creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
            if os.name == 'nt':
                from .windows_process import ProcessTreeJob, windows_creationflags

                self._process_job = ProcessTreeJob()
                creationflags = windows_creationflags()

                def process_factory(*args, **kwargs):
                    proc = subprocess.Popen(*args, **kwargs)
                    # Retain the suspended Popen if spawn_external later fails
                    # while restoring the frozen app's DLL search directory.
                    self.proc = proc
                    return proc

            session = {}
            if os.name != 'nt':
                session['start_new_session'] = True
            self.proc = spawn_external(process_factory,
                argv,
                shell=False,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(self.cwd) if self.cwd is not None else None,
                text=True,
                encoding='utf-8',
                bufsize=1,
                env=env,
                creationflags=creationflags,
                **session,
            )
            from ...process_runtime import note_owned_process
            note_owned_process(self.proc, group=os.name != 'nt')
            if os.name == 'nt':
                # CREATE_SUSPENDED keeps the process inert while
                # spawn_external restores PyInstaller's process-wide DLL path.
                self._process_job.assign_and_resume(self.proc)
        except Exception as exc:  # noqa: BLE001 - a bad command is data, not a crash
            self.error = _fail_text(exc)
            self._kill_proc()
            return False
        self._queue = queue.Queue()
        self._threads = []
        if self.proc.stdout is not None:
            self._spawn_reader(self.proc.stdout)
        if self.proc.stderr is not None:
            self._spawn_stderr_drain(self.proc.stderr)
        self._next_id = 3
        return True

    def _record_handshake(self, handshake) -> str | None:
        """Keep the server's identity; reject a version we cannot speak.

        Returns an error string (recording nothing) when the response is
        unusable, else ``None``.
        """
        if not isinstance(handshake, dict):
            return "malformed initialize result"
        version = handshake.get("protocolVersion")
        if not isinstance(version, str) or not version:
            return "initialize result is missing protocolVersion"
        if version not in SUPPORTED_PROTOCOL_VERSIONS:
            # Disconnect rather than guess at the shape of a protocol we do not
            # know. Silently accepting it is how you mis-parse every later message.
            return "unsupported protocol version: %s" % version
        self.negotiated_protocol_version = version
        info = handshake.get("serverInfo")
        if isinstance(info, dict):
            self.server_info = dict(info)
        caps = handshake.get("capabilities")
        if isinstance(caps, dict):
            self.server_capabilities = dict(caps)
        return None

    def start(self) -> None:
        """Spawn the child and complete the ``initialize`` handshake.

        Never raises, never starts a second child: config errors, a missing
        binary and a handshake failure all land in ``self.error``.

        The version ladder runs only when the server *answers* with a JSON-RPC
        error (a fast response), so a server that rejects our preferred version
        gets a real retry on a fresh process. A dead or silent child is not
        retried: a different version cannot fix a broken transport.
        """
        with self._lock:
            if self.active:
                return
            # A launcher can exit while its server child remains alive. Keep
            # ownership of that tree until it is explicitly reaped, including
            # before a restart replaces the old Popen handle.
            if self.proc is not None or self._process_job is not None:
                if not self._kill_proc():
                    return
            # A failed tree cleanup is sticky: the Job handle has already been
            # relinquished, so a later start cannot prove the old descendants
            # are gone and must not silently forget the failure.
            if self._process_cleanup_failed:
                if self.error is None:
                    self.error = self._process_cleanup_error
                return
            self.error = None
            self.negotiated_protocol_version = None
            self.server_info = {}
            self.server_capabilities = {}
            command = self.server.get("command")
            if not isinstance(command, str) or not command.strip():
                self.error = "invalid command"
                return
            argv = [command]
            extra = self.server.get("args")
            if isinstance(extra, list):
                argv.extend(str(part) for part in extra)

            from .elicitation import initialize_capabilities
            capabilities = initialize_capabilities(self.server)
            ladder = self._version_ladder()
            for index, version in enumerate(ladder):
                if not self._spawn(argv):
                    return
                try:
                    handshake = self._request(
                        "initialize",
                        {
                            "protocolVersion": version,
                            "capabilities": capabilities,
                            "clientInfo": dict(CLIENT_INFO),
                        },
                        1,
                    )
                except _McpTransportError as exc:
                    # The connection itself is unusable; another version will
                    # not help.
                    self.error = self._error_with_cleanup(_fail_text(exc))
                    self._kill_proc()
                    return
                except _McpError as exc:
                    # The server answered with an error. An unacceptable
                    # version is the plausible cause, so try the next one.
                    self.error = self._error_with_cleanup(_fail_text(exc))
                    if not self._kill_proc():
                        return
                    if index + 1 < len(ladder):
                        self.error = None
                        continue
                    return
                except Exception as exc:  # noqa: BLE001
                    self.error = self._error_with_cleanup(_fail_text(exc))
                    self._kill_proc()
                    return

                problem = self._record_handshake(handshake)
                if problem:
                    self.error = problem
                    self._kill_proc()
                    return
                try:
                    self._notify("notifications/initialized")
                except Exception as exc:  # noqa: BLE001
                    self.error = _fail_text(exc)
                    self._kill_proc()
                    return
                self._started = True
                return

    def list_tools(self) -> list:
        """The server's tools (``result.tools``), or ``[]`` on any failure."""
        try:
            result = self._request("tools/list", {}, 2)
        except _McpTransportError as exc:
            self.error = self._error_with_cleanup(_fail_text(exc))
            self._kill_proc()
            return []
        except Exception as exc:  # noqa: BLE001
            self.error = self._error_with_cleanup(_fail_text(exc))
            return []
        tools = result.get("tools")
        if not isinstance(tools, list):
            return []
        self.tools = [tool for tool in tools if isinstance(tool, dict)]
        return self.tools

    def call_tool(self, tool_name, arguments) -> dict:
        """Call ``tool_name``; always ``{"ok", "content", "error"}``.

        Text results are joined and clipped to ``output_cap``. A server-side
        ``isError`` (and every transport failure) yields ``ok=False`` with the
        reason in ``error`` -- this method never raises.
        """
        try:
            with self._lock:
                request_id = self._next_id
                self._next_id += 1
            params = {
                "name": tool_name,
                "arguments": arguments if isinstance(arguments, dict) else {},
            }
            result = self._request("tools/call", params, request_id)
        except _McpTransportError as exc:
            self.error = self._error_with_cleanup(_fail_text(exc))
            self._kill_proc()
            return {"ok": False, "content": "", "error": self.error}
        except Exception as exc:  # noqa: BLE001 - a failed call must not break a run
            self.error = self._error_with_cleanup(_fail_text(exc))
            return {"ok": False, "content": "", "error": self.error}
        raw_text = _extract_text(result.get("content"))
        structured = result.get("structuredContent")
        if structured is not None and isinstance(structured, (dict, list)) and len(structured) > 0:
            structured_text = "Structured content:\n" + json.dumps(structured, ensure_ascii=False, indent=2)
            text = (raw_text + "\n\n" + structured_text) if raw_text else structured_text
        else:
            text = raw_text
        text = clip(text, self.output_cap)
        if result.get("isError") is True:
            return {"ok": False, "content": "", "error": text}
        return {"ok": True, "content": text, "error": None}

    # --- shutdown -----------------------------------------------------------

    def _kill_proc(self) -> bool:
        """Terminate and reap the process tree; report whether that was proven."""
        with self._lock:
            proc = self.proc
            process_job = self._process_job
            self.proc = None
            self._process_job = None
            self._started = False
            cleanup_failure = None
            if process_job is not None:
                try:
                    process_job.terminate_and_close()
                except Exception as exc:  # noqa: BLE001
                    cleanup_failure = exc
                    try:
                        process_job.close()
                    except Exception:  # noqa: BLE001
                        pass
            if proc is not None:
                try:
                    if proc.stdin is not None:
                        proc.stdin.close()
                except Exception:  # noqa: BLE001
                    pass
                from ...process_runtime import forget_owned_process, terminate_process_tree
                try:
                    # Windows already asked the Job Object to kill the tree.
                    # POSIX has no job, so the session group is the tree.
                    terminate_process_tree(
                        proc, group=os.name != 'nt', grace=CLOSE_GRACE)
                except Exception:  # noqa: BLE001
                    pass
                forget_owned_process(proc)
                for stream in (proc.stdout, proc.stderr):
                    try:
                        if stream is not None:
                            stream.close()
                    except Exception:  # noqa: BLE001
                        pass
            for thread in list(self._threads):
                thread.join(timeout=CLOSE_GRACE)
            self._threads = []
            if cleanup_failure is not None:
                message = "process-tree cleanup failed (%s)" % type(cleanup_failure).__name__
                self._process_cleanup_failed = True
                self._process_cleanup_error = message
                if self.error is None:
                    self.error = message
                elif message not in self.error:
                    self.error = self.error + "; " + message
            return not self._process_cleanup_failed

    def close(self) -> None:
        """Kill the child and reap it. Idempotent, and never raises."""
        self._kill_proc()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def _error_summary(error) -> str:
    """A short metadata description of a JSON-RPC ``error`` object."""
    if isinstance(error, dict):
        code = error.get("code")
        if code is None:
            return "unlabelled"
        return "code %s" % code
    return type(error).__name__ if error is not None else "unknown"
