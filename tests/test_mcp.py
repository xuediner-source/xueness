"""Stage 5 MCP tests.

Covers the contract in docs/stage5-contract.md, section "二、MCP": loading and
filtering (missing directory, disabled, bad command, illegal id, symlinks at
entry and directory level, stable id order), namespacing round trips, the
OpenAI tool schema, and the client against a **real** fake MCP server.

The fake server is a Python script written into a temporary file. It speaks
newline-delimited JSON-RPC 2.0 on stdin/stdout, answers ``initialize``,
``notifications/initialized``, ``tools/list`` and ``tools/call``, records every
request it receives into a log file, writes its own pid into a pid file, and
can fail (``isError``), stall (``slow``), report its environment (``env``) or
answer with a very long text (``long``).

Every fake server is launched as ``sys.executable <script>`` so the suite is
portable and never depends on a shell.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

from xueness.mcp import (DEFAULT_OUTPUT_CAP, DEFAULT_TIMEOUT, MCP_PREFIX,
                         TIMEOUT_CAP, TRUNCATION_SUFFIX, McpClient, load,
                         namespaced, parse_namespaced, tool_schema)

# The fake MCP server. Written verbatim to a temp file; ``sys.argv[1]`` is the
# request log, ``sys.argv[2]`` the pid file. Raw string on purpose: the child
# source keeps its own "\n" escapes.
FAKE_SERVER = r'''
import json
import os
import sys
import time

LOG = sys.argv[1]
PIDFILE = sys.argv[2]

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


with open(PIDFILE, "w", encoding="utf-8") as stream:
    stream.write(str(os.getpid()))

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
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
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
        self.pidfile = self.root / "server.pid"

    # --- helpers ------------------------------------------------------------

    def server_item(self, server_id="srv", **extra) -> dict:
        item = {
            "id": server_id,
            "name": server_id,
            "command": sys.executable,
            "args": [str(self.script), str(self.log), str(self.pidfile)],
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
        (self.mcp_dir / "evil.json").symlink_to(secret)
        self.assertEqual(load(self.state_dir), [])

    def test_load_skips_symlinked_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps(self.server_item("outside")), encoding="utf-8")
        shutil.rmtree(self.mcp_dir)
        self.mcp_dir.symlink_to(outside, target_is_directory=True)
        self.assertEqual(load(self.state_dir), [])

    def test_load_skips_mcp_dir_symlinked_from_the_state_dir(self):
        outside = self.root / "outside2"
        (outside / "resources" / "mcp").mkdir(parents=True)
        (outside / "resources" / "mcp" / "a.json").write_text(
            json.dumps(self.server_item("outside")), encoding="utf-8")
        link = self.root / "linked-state"
        link.mkdir()
        (link / "resources").mkdir()
        (link / "resources" / "mcp").symlink_to(
            outside / "resources" / "mcp", target_is_directory=True)
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
        pid = int(self.pidfile.read_text(encoding="utf-8").strip())
        self.assertEqual(pid, proc.pid)
        client.close()
        self.assertIsNotNone(proc.poll())  # reaped: the child is really gone
        client.close()
        client.close()
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertFalse(client.active)

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
        pid = int(self.pidfile.read_text(encoding="utf-8").strip())
        client.close()
        self.assertIsNotNone(proc.poll())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

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
