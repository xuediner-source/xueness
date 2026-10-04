"""Stage 5 MCP tests.

Covers the contract in docs/stage5-contract.md, section "二、MCP": loading and
filtering (missing directory, disabled, bad command, illegal id, symlinks at
entry and directory level, stable id order), namespacing round trips, the
OpenAI tool schema, and the client against a **real** fake MCP server.

The fake server is a Python script written into a temporary file. It speaks
newline-delimited JSON-RPC 2.0 on stdin/stdout, answers ``initialize``,
``notifications/initialized``, ``tools/list`` and ``tools/call``, records every
request it receives into a log file, reports its pid in the initialize result,
and can fail (``isError``), stall (``slow``), report its environment (``env``)
or answer with a very long text (``long``).

Every fake server is launched as ``sys.executable <script>`` so the suite is
portable and never depends on a shell.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.mcp import (DEFAULT_OUTPUT_CAP, DEFAULT_TIMEOUT, MCP_PREFIX,
                         TIMEOUT_CAP, TRUNCATION_SUFFIX, McpClient, load,
                         namespaced, parse_namespaced, tool_schema)

# The fake MCP server. Written verbatim to a temp file; ``sys.argv[1]`` is the
# request log, ``sys.argv[2]`` the pid file. Raw string on purpose: the child
# source keeps its own "\n" escapes.
FAKE_SERVER = r'''
import json
import os
import subprocess
import sys
import time

LOG = sys.argv[1]
CHILD_PID_FILE = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
FIXTURE_MODE = sys.argv[3] if len(sys.argv) > 3 else ""

TOOLS = [
    {"name": "echo", "description": "Echo the text argument back",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                     "required": ["text"]}},
    {"name": "boom", "description": "Always fails",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "slow", "description": "Sleep then reply",
     "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}}},
    {"name": "env", "description": "Report the child environment",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "long", "description": "Reply with a very long text",
     "inputSchema": {"type": "object", "properties": {}}},
]


def record(entry):
    with open(LOG, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry) + "\n")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def spawn_worker():
    if not CHILD_PID_FILE:
        return
    worker_code = (
        "import os, time\n"
        "with open(%r, 'w', encoding='utf-8') as stream:\n"
        "    stream.write(str(os.getpid()))\n"
        "time.sleep(30)\n"
    ) % CHILD_PID_FILE
    subprocess.Popen(
        [sys.executable, "-c", worker_code],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


if FIXTURE_MODE in ("spawn_on_start", "bad_handshake_tree"):
    spawn_worker()
if FIXTURE_MODE == "bad_handshake_tree":
    time.sleep(0.5)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    request_id = message.get("id")
    record({"method": method, "params": message.get("params"),
            "has_id": "id" in message})
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": ("2099-01-01" if FIXTURE_MODE == "bad_handshake_tree"
                                else "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1.0", "pid": os.getpid()}}})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name == "echo":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [
                {"type": "text", "text": "echo:%s" % arguments.get("text", "")},
                {"type": "image", "data": "not-text-and-must-be-skipped"},
                {"type": "text", "text": "done"}], "isError": False}})
        elif name == "boom":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [
                {"type": "text", "text": "boom failed on purpose"}],
                "isError": True}})
        elif name == "slow":
            if FIXTURE_MODE == "spawn_on_slow":
                spawn_worker()
            time.sleep(float(arguments.get("seconds", 5)))
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [
                {"type": "text", "text": "too late"}], "isError": False}})
        elif name == "env":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [
                {"type": "text", "text": "LEAK=%r HOME=%r" % (
                    os.environ.get("FOO_SECRET"), os.environ.get("HOME"))}],
                "isError": False}})
        elif name == "long":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [
                {"type": "text", "text": "x" * 5000}], "isError": False}})
        else:
            send({"jsonrpc": "2.0", "id": request_id,
                  "error": {"code": -32601, "message": "unknown tool"}})
'''


class McpTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "state"
        self.mcp_dir = self.state_dir / "resources" / "mcp"
        self.mcp_dir.mkdir(parents=True)
        self.work = self.root / "work"
        self.work.mkdir()
        self.script = self.root / "fake_server.py"
        self.script.write_text(FAKE_SERVER, encoding="utf-8")
        self.log = self.root / "requests.jsonl"

    # --- helpers ------------------------------------------------------------

    def server_item(self, server_id="srv", *, fixture_mode=None,
                    child_pid_file=None, **extra) -> dict:
        args = [str(self.script), str(self.log)]
        if fixture_mode is not None or child_pid_file is not None:
            args.extend([str(child_pid_file) if child_pid_file is not None else "",
                         fixture_mode or ""])
        item = {
            "id": server_id,
            "name": server_id,
            "command": sys.executable,
            "args": args,
        }
        item.update(extra)
        return item

    def write_server(self, filename: str, payload) -> Path:
        path = self.mcp_dir / filename
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def client(self, server=None, **kwargs) -> McpClient:
        kwargs.setdefault("cwd", str(self.work))
        client = McpClient(server if server is not None else self.server_item(), **kwargs)
        self.addCleanup(client.close)
        return client

    def requests(self) -> list:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()
                if line.strip()]

    def wait_for_requests(self, count: int, timeout: float = 5.0) -> list:
        """Wait until the fake server has logged at least ``count`` requests.

        The server appends each request to the log *asynchronously*, so the
        client returning from ``start()`` does not mean the last line is on
        disk yet. Reading immediately is a race (observed as a rare flake:
        ``['initialize']`` instead of ``['initialize', 'notifications/initialized']``).
        Poll briefly rather than asserting on a partial file.
        """
        deadline = time.monotonic() + timeout
        entries = self.requests()
        while len(entries) < count and time.monotonic() < deadline:
            time.sleep(0.02)
            entries = self.requests()
        return entries

    def server_pid(self, client) -> int:
        pid = client.server_info.get("pid")
        self.assertIsInstance(pid, int)
        self.assertGreater(pid, 0)
        return pid

    def wait_for_pid_file(self, path: Path, timeout: float = 3.0) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                return int(path.read_text(encoding="utf-8"))
            time.sleep(0.01)
        self.fail("fixture descendant did not write its pid file")

    def hold_process(self, pid: int):
        """Hold the process object open so a later PID reuse cannot mask a leak."""
        if os.name != "nt":
            return None
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL
        handle = open_process(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self.addCleanup(close_handle, handle)
        return handle

    def assert_pid_exited(self, pid: int, process_handle=None) -> None:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            open_process = kernel32.OpenProcess
            open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            open_process.restype = wintypes.HANDLE
            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            wait_for_single_object.restype = wintypes.DWORD
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL

            handle = process_handle
            close_after = False
            if handle is None:
                handle = open_process(0x00100000, False, pid)  # SYNCHRONIZE
                close_after = True
                if not handle:
                    error = ctypes.get_last_error()
                    if error == 87:  # ERROR_INVALID_PARAMETER: no such process id
                        return
                    raise ctypes.WinError(error)
            try:
                state = wait_for_single_object(handle, 0)
                self.assertEqual(
                    state, 0x00000000,
                    "MCP descendant process %d is still running" % pid,
                )
            finally:
                if close_after:
                    close_handle(handle)
        else:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def assert_server_exited(self, pid: int, proc, process_handle=None) -> None:
        self.assertIsNotNone(proc.wait(timeout=3))
        if process_handle is not None:
            self.assert_pid_exited(pid, process_handle)
            return
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            open_process = kernel32.OpenProcess
            open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            open_process.restype = wintypes.HANDLE
            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            wait_for_single_object.restype = wintypes.DWORD
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL

            handle = open_process(0x00100000, False, pid)  # SYNCHRONIZE
            if not handle:
                error = ctypes.get_last_error()
                if error == 87:  # ERROR_INVALID_PARAMETER: no such process id
                    return
                raise ctypes.WinError(error)
            try:
                state = wait_for_single_object(handle, 0)
                if state == 0x00000102:  # WAIT_TIMEOUT
                    self.fail("fake MCP server process %d is still running" % pid)
                self.assertEqual(state, 0x00000000, "could not inspect fake MCP process")
            finally:
                close_handle(handle)
        else:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    # --- load ---------------------------------------------------------------

    def test_load_missing_directory_returns_empty(self):
        self.assertEqual(load(self.root / "nothing-here"), [])
        self.assertEqual(load(self.state_dir / "resources" / "hooks"), [])

    def test_load_filters_and_sorts_by_id(self):
        self.write_server("z.json", self.server_item("bravo"))
        self.write_server("a.json", self.server_item("alpha"))
        self.write_server("off.json", self.server_item("charlie", enabled=False))
        self.write_server("on.json", self.server_item("delta", enabled=True))
        self.write_server("nocmd.json", {"id": "nocmd", "args": []})
        self.write_server("emptycmd.json", {"id": "emptycmd", "command": "   "})
        self.write_server("badid.json", {"id": "../escape", "command": sys.executable})
        self.write_server("nonstr.json", {"id": 7, "command": sys.executable})
        self.write_server("broken.json", "{not json")
        self.write_server("array.json", json.dumps([1, 2, 3]))
        servers = load(self.state_dir)
        self.assertEqual([s["id"] for s in servers], ["alpha", "bravo", "delta"])
        self.assertEqual(servers[0]["command"], sys.executable)
        self.assertIn("args", servers[0])

    def test_load_skips_symlinked_entry(self):
        secret = self.root / "secret.json"
        secret.write_text(json.dumps(self.server_item("evil")), encoding="utf-8")
        make_symlink(self.mcp_dir / "evil.json", secret)
        self.assertEqual(load(self.state_dir), [])

    def test_load_skips_symlinked_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps(self.server_item("outside")), encoding="utf-8")
        shutil.rmtree(self.mcp_dir)
        make_directory_boundary_link(self.mcp_dir, outside)
        self.assertEqual(load(self.state_dir), [])

    def test_load_skips_mcp_dir_symlinked_from_the_state_dir(self):
        outside = self.root / "outside2"
        (outside / "resources" / "mcp").mkdir(parents=True)
        (outside / "resources" / "mcp" / "a.json").write_text(
            json.dumps(self.server_item("outside")), encoding="utf-8")
        link = self.root / "linked-state"
        link.mkdir()
        (link / "resources").mkdir()
        make_directory_boundary_link(link / "resources" / "mcp", outside / "resources" / "mcp")
        self.assertEqual(load(link), [])

    # --- namespacing --------------------------------------------------------

    def test_namespaced_and_parse_round_trip(self):
        for server_id, tool in (("srv", "read"), ("a.b-c_d", "t.1"), ("s", "x")):
            name = namespaced(server_id, tool)
            self.assertTrue(name.startswith(MCP_PREFIX))
            self.assertEqual(parse_namespaced(name), (server_id, tool))
        self.assertEqual(namespaced("srv", "read"), "mcp__srv__read")
        self.assertEqual(MCP_PREFIX, "mcp__")

    def test_parse_namespaced_rejects_invalid_names(self):
        invalid = [
            None, 123, b"mcp__a__b", "",
            "read", "srv__read", "MCP__a__b", "xmcp__a__b",
            "mcp__", "mcp____b", "mcp__a__", "mcp__a", "mcp__a__b\n", "mcp__a/b__c",
            "mcp__.__b", "mcp__..__b", "mcp__a__.", "mcp__a__..",
            "mcp__%s__b" % ("a" * 65), "mcp__a__%s" % ("b" * 65),
            "mcp__a b__c", "mcp__a__b c",
        ]
        for name in invalid:
            self.assertIsNone(parse_namespaced(name), "expected None for %r" % (name,))
        # 64 characters is still legal on both halves.
        self.assertEqual(parse_namespaced("mcp__%s__%s" % ("a" * 64, "b" * 64)),
                         ("a" * 64, "b" * 64))
        # "__" is legal inside a half, so the earliest legal split wins.
        self.assertEqual(parse_namespaced("mcp__a__b__c"), ("a", "b__c"))

    def test_tool_schema_shape(self):
        tool = {"name": "read", "description": "Read a file",
                "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}}
        schema = tool_schema("srv", tool)
        self.assertEqual(schema["type"], "function")
        self.assertEqual(schema["function"]["name"], "mcp__srv__read")
        self.assertEqual(schema["function"]["description"], "Read a file")
        self.assertEqual(schema["function"]["parameters"], tool["inputSchema"])
        # Missing / non-string pieces fall back instead of raising.
        bare = tool_schema("srv", {"name": "ping"})
        self.assertEqual(bare["function"]["name"], "mcp__srv__ping")
        self.assertEqual(bare["function"]["description"], "")
        self.assertEqual(bare["function"]["parameters"], {"type": "object", "properties": {}})
        weird = tool_schema("srv", {"name": "x", "description": 5, "inputSchema": "nope"})
        self.assertEqual(weird["function"]["description"], "")
        self.assertEqual(weird["function"]["parameters"], {"type": "object", "properties": {}})
        self.assertEqual(tool_schema("srv", None)["function"]["name"], "mcp__srv__unnamed")

    def test_constants(self):
        self.assertEqual(DEFAULT_TIMEOUT, 10)
        self.assertEqual(TIMEOUT_CAP, 30)
        self.assertEqual(DEFAULT_OUTPUT_CAP, 2000)
        self.assertEqual(TRUNCATION_SUFFIX, "…(truncated)")

    # --- handshake ----------------------------------------------------------

    def test_start_performs_the_initialize_handshake(self):
        client = self.client()
        client.start()
        self.assertIsNone(client.error)
        self.assertTrue(client.active)
        entries = self.wait_for_requests(2)
        self.assertEqual([e["method"] for e in entries],
                         ["initialize", "notifications/initialized"])
        self.assertTrue(entries[0]["has_id"])
        self.assertFalse(entries[1]["has_id"])
        params = entries[0]["params"]
        self.assertEqual(params["protocolVersion"], "2024-11-05")
        self.assertEqual(params["capabilities"], {})
        self.assertEqual(params["clientInfo"], {"name": "xueness", "version": "0.1"})

    # --- tools/list ---------------------------------------------------------

    def test_list_tools_returns_the_servers_declared_tools(self):
        client = self.client()
        client.start()
        tools = client.list_tools()
        self.assertEqual(sorted(t["name"] for t in tools),
                         ["boom", "echo", "env", "long", "slow"])
        echo = [t for t in tools if t["name"] == "echo"][0]
        self.assertEqual(echo["description"], "Echo the text argument back")
        self.assertIn("text", echo["inputSchema"]["properties"])
        self.assertEqual([e["method"] for e in self.wait_for_requests(3)],
                         ["initialize", "notifications/initialized", "tools/list"])
        schema = tool_schema("srv", echo)
        self.assertEqual(schema["function"]["name"], "mcp__srv__echo")

    def test_list_tools_without_a_live_server_is_empty(self):
        client = self.client({"id": "x", "command": str(self.root / "no-such-binary"), "args": []})
        client.start()
        self.assertEqual(client.list_tools(), [])

    # --- tools/call ---------------------------------------------------------

    def test_call_tool_success_returns_joined_text(self):
        client = self.client()
        client.start()
        client.list_tools()
        result = client.call_tool("echo", {"text": "hello"})
        self.assertTrue(result["ok"])
        self.assertIsNone(result["error"])
        # Only type == "text" items are joined, in order.
        self.assertEqual(result["content"], "echo:hello\ndone")
        call = self.requests()[-1]
        self.assertEqual(call["method"], "tools/call")
        self.assertEqual(call["params"]["name"], "echo")
        self.assertEqual(call["params"]["arguments"], {"text": "hello"})
        self.assertTrue(call["has_id"])

    def test_call_tool_ids_increase_across_calls(self):
        client = self.client()
        client.start()
        client.list_tools()
        client.call_tool("echo", {"text": "one"})
        client.call_tool("echo", {"text": "two"})
        ids = [e["params"] for e in self.requests() if e["method"] == "tools/call"]
        self.assertEqual(len(ids), 2)

    def test_call_tool_is_error_becomes_ok_false_with_the_text_in_error(self):
        client = self.client()
        client.start()
        result = client.call_tool("boom", {})
        self.assertFalse(result["ok"])
        self.assertEqual(result["content"], "")
        self.assertIn("boom failed on purpose", result["error"])
        self.assertIsInstance(result["error"], str)

    def test_unknown_tool_reports_the_server_error_without_raising(self):
        client = self.client()
        client.start()
        result = client.call_tool("nope", {})
        self.assertFalse(result["ok"])
        self.assertIsNotNone(result["error"])

    def test_output_is_clipped_to_the_output_cap(self):
        client = self.client(output_cap=100)
        client.start()
        client.list_tools()
        result = client.call_tool("long", {})
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["content"]), 100)
        self.assertTrue(result["content"].endswith(TRUNCATION_SUFFIX))

    def test_output_is_clipped_to_the_default_cap(self):
        client = self.client()
        client.start()
        result = client.call_tool("long", {})
        self.assertEqual(len(result["content"]), DEFAULT_OUTPUT_CAP)

    # --- failures -----------------------------------------------------------

    def test_timeout_does_not_raise_and_stays_fast(self):
        client = self.client(timeout=1)
        client.start()
        self.assertIsNone(client.error)
        started = time.monotonic()
        result = client.call_tool("slow", {"seconds": 10})
        elapsed = time.monotonic() - started
        self.assertFalse(result["ok"])
        self.assertEqual(result["content"], "")
        self.assertIn("timeout", result["error"])
        self.assertLess(elapsed, 5.0)
        # The stalled server was killed rather than left behind.
        self.assertIsNone(client.proc)
        self.assertFalse(client.active)

    def test_timeout_is_clamped_by_the_cap(self):
        client = self.client(timeout=1, timeout_cap=5, server={"id": "s",
                                                               "command": sys.executable,
                                                               "args": [], "timeout": 999})
        self.assertEqual(client.timeout, 5.0)
        client.start()
        started = time.monotonic()
        result = client.call_tool("anything", {})
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertFalse(result["ok"])

    def test_missing_command_is_reported_not_raised(self):
        server = {"id": "gone", "command": str(self.root / "definitely-missing-binary"),
                  "args": []}
        client = self.client(server)
        client.start()
        self.assertIsNotNone(client.error)
        self.assertIsNone(client.proc)
        self.assertEqual(client.list_tools(), [])
        result = client.call_tool("echo", {"text": "x"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["error"])
        client.close()  # idempotent even after a failed start

    def test_spawn_external_failure_reaps_captured_suspended_process(self):
        import xueness.bundled_plugins.mcp.mcp as mcp_module
        from xueness.bundled_plugins.mcp import windows_process

        proc = Mock()
        proc.stdin = None
        proc.stdout = None
        proc.stderr = None
        proc.poll.return_value = None
        process_job = Mock()

        def spawn_then_restore_failure(factory, *args, **kwargs):
            self.assertEqual(kwargs["creationflags"] & 0x00000004, 0x00000004)
            factory(*args, **kwargs)
            raise OSError("simulated DLL-directory restore failure")

        client = self.client()
        simulated_windows_os = SimpleNamespace(name="nt", environ={})
        with patch.object(mcp_module, "os", simulated_windows_os), \
                patch.object(windows_process, "ProcessTreeJob", return_value=process_job), \
                patch.object(mcp_module.subprocess, "Popen", return_value=proc), \
                patch("xueness.process_runtime.spawn_external",
                      side_effect=spawn_then_restore_failure):
            self.assertFalse(client._spawn([sys.executable]))

        self.assertIsNone(client.proc)
        self.assertIsNotNone(client.error)
        process_job.terminate_and_close.assert_called_once_with()
        proc.terminate.assert_called_once_with()
        proc.wait.assert_called_once()

    def test_close_reports_tree_cleanup_failure_without_raising(self):
        client = self.client()
        client.error = "timeout after 1.0s"
        proc = Mock()
        proc.stdin = None
        proc.stdout = None
        proc.stderr = None
        proc.poll.return_value = 0
        proc.wait.return_value = 0
        process_job = Mock()
        process_job.terminate_and_close.side_effect = TimeoutError(
            "private server arguments must not be reported"
        )
        client.proc = proc
        client._process_job = process_job

        client.close()

        self.assertIn("timeout after 1.0s", client.error)
        self.assertIn("process-tree cleanup failed (TimeoutError)", client.error)
        self.assertNotIn("private server arguments", client.error)
        process_job.close.assert_called_once_with()

    def test_start_preserves_cleanup_failure_and_refuses_to_spawn_again(self):
        client = self.client()
        client.error = "previous transport failure"
        proc = Mock()
        proc.stdin = None
        proc.stdout = None
        proc.stderr = None
        proc.poll.return_value = 0
        proc.wait.return_value = 0
        process_job = Mock()
        process_job.terminate_and_close.side_effect = TimeoutError(
            "private server arguments must not be reported"
        )
        client.proc = proc
        client._process_job = process_job

        with patch.object(client, "_spawn") as spawn:
            client.start()
            # The failed cleanup is sticky even though _kill_proc detached the
            # old handles, so another start must not erase it or create a new
            # server alongside an unverified descendant.
            client.start()

        spawn.assert_not_called()
        self.assertIsNone(client.proc)
        self.assertIsNone(client._process_job)
        self.assertIn("previous transport failure", client.error)
        self.assertIn("process-tree cleanup failed (TimeoutError)", client.error)
        self.assertNotIn("private server arguments", client.error)

    def test_start_does_not_retry_version_after_tree_cleanup_failure(self):
        import xueness.bundled_plugins.mcp.mcp as mcp_module

        client = self.client()
        proc = Mock()
        proc.stdin = None
        proc.stdout = None
        proc.stderr = None
        proc.poll.return_value = 0
        proc.wait.return_value = 0
        process_job = Mock()
        process_job.terminate_and_close.side_effect = TimeoutError("private")

        def spawn_with_unusable_server(_argv):
            client.proc = proc
            client._process_job = process_job
            return True

        with patch.object(client, "_spawn", side_effect=spawn_with_unusable_server) as spawn:
            # Raise the actual internal server-response exception type without
            # needing a transport process; cleanup itself remains the real
            # McpClient path under test.
            with patch.object(client, "_request", side_effect=mcp_module._McpError("server error")):
                client.start()

        spawn.assert_called_once()
        self.assertIn("server error", client.error)
        self.assertIn("process-tree cleanup failed (TimeoutError)", client.error)
        self.assertTrue(client._process_cleanup_failed)

    def test_non_string_command_is_reported_not_raised(self):
        client = McpClient({"id": "bad", "command": None}, cwd=str(self.work))
        self.addCleanup(client.close)
        client.start()
        self.assertIsNotNone(client.error)
        self.assertEqual(client.call_tool("echo", {})["ok"], False)

    def test_call_tool_before_start_does_not_raise(self):
        client = self.client()
        result = client.call_tool("echo", {"text": "x"})
        self.assertFalse(result["ok"])
        self.assertIsNotNone(result["error"])

    # --- close --------------------------------------------------------------

    def test_close_is_idempotent_and_really_kills_the_process(self):
        client = self.client()
        client.start()
        self.assertIsNone(client.error)
        proc = client.proc
        self.assertIsNotNone(proc)
        pid = self.server_pid(client)
        if os.name != "nt":
            self.assertEqual(pid, proc.pid)
        process_handle = self.hold_process(pid)
        client.close()
        self.assert_server_exited(pid, proc, process_handle)
        client.close()
        client.close()
        self.assertFalse(client.active)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object lifecycle")
    def test_close_kills_launcher_server_and_spawned_descendant(self):
        child_pid_file = self.root / "child.pid"
        client = self.client(self.server_item(
            fixture_mode="spawn_on_start", child_pid_file=child_pid_file,
        ))
        client.start()
        self.assertIsNone(client.error)
        proc = client.proc
        server_pid = self.server_pid(client)
        child_pid = self.wait_for_pid_file(child_pid_file)
        server_handle = self.hold_process(server_pid)
        child_handle = self.hold_process(child_pid)

        # The build environment uses a Python launcher which starts a second
        # interpreter; assigning only Popen.pid would miss this server.
        if "xueness-build-env" in sys.executable.lower():
            self.assertNotEqual(server_pid, proc.pid)

        client.close()
        self.assert_server_exited(server_pid, proc, server_handle)
        self.assert_pid_exited(child_pid, child_handle)
        client.close()
        self.assertFalse(client.active)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object lifecycle")
    def test_timeout_kills_spawned_descendant(self):
        child_pid_file = self.root / "timeout-child.pid"
        client = self.client(self.server_item(
            fixture_mode="spawn_on_slow", child_pid_file=child_pid_file,
        ), timeout=2)
        client.start()
        self.assertIsNone(client.error)
        proc = client.proc
        server_pid = self.server_pid(client)
        server_handle = self.hold_process(server_pid)

        results = []
        call_thread = threading.Thread(
            target=lambda: results.append(client.call_tool("slow", {"seconds": 10})),
        )
        call_thread.start()

        def finish_call_thread():
            if call_thread.is_alive():
                client.close()
            call_thread.join(timeout=5)

        self.addCleanup(finish_call_thread)
        # spawn_on_slow writes this only after the in-flight tools/call reaches
        # the server, so the worker is born during the request that will time out.
        child_pid = self.wait_for_pid_file(child_pid_file)
        child_handle = self.hold_process(child_pid)
        call_thread.join(timeout=5)
        self.assertFalse(call_thread.is_alive(), "timed-out tool call did not return")
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertFalse(result["ok"])
        self.assertIn("timeout", result["error"])
        self.assertIsNone(client.proc)
        self.assert_server_exited(server_pid, proc, server_handle)
        self.assert_pid_exited(child_pid, child_handle)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object lifecycle")
    def test_handshake_failure_kills_spawned_descendant(self):
        child_pid_file = self.root / "handshake-child.pid"
        client = self.client(self.server_item(
            fixture_mode="bad_handshake_tree", child_pid_file=child_pid_file,
        ))
        start_thread = threading.Thread(target=client.start)
        start_thread.start()
        child_pid = self.wait_for_pid_file(child_pid_file)
        child_handle = self.hold_process(child_pid)
        start_thread.join(timeout=5)
        self.assertFalse(start_thread.is_alive(), "failed handshake did not return")
        self.assertIn("unsupported protocol version", client.error)
        self.assertIsNone(client.proc)
        self.assert_pid_exited(child_pid, child_handle)

    def test_close_without_start_is_a_no_op(self):
        client = self.client()
        client.close()
        client.close()
        self.assertFalse(client.active)

    def test_context_manager_closes_the_child(self):
        with self.client() as client:
            self.assertTrue(client.active)
            proc = client.proc
            self.assertEqual([t["name"] for t in client.list_tools()],
                             ["echo", "boom", "slow", "env", "long"])
        self.assertIsNotNone(proc.poll())
        self.assertFalse(client.active)

    def test_close_kills_a_stalled_server(self):
        client = self.client(timeout=30)
        client.start()
        proc = client.proc
        pid = self.server_pid(client)
        process_handle = self.hold_process(pid)
        client.close()
        self.assert_server_exited(pid, proc, process_handle)

    # --- environment --------------------------------------------------------

    def test_child_environment_does_not_leak_server_secrets(self):
        os.environ["FOO_SECRET"] = "SUPER-SECRET-VALUE-42"
        try:
            client = self.client()
            client.start()
            result = client.call_tool("env", {})
        finally:
            os.environ.pop("FOO_SECRET", None)
        self.assertTrue(result["ok"])
        self.assertNotIn("SUPER-SECRET-VALUE-42", result["content"])
        self.assertIn("LEAK=None", result["content"])


if __name__ == "__main__":
    unittest.main()
