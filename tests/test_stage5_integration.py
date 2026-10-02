"""End-to-end proof that commands / MCP / sub-agents reach the loop.

Unit tests show each module behaves; these show ``core.run`` and
``core.append_user_turn`` actually use them:

1. ``/demo hello`` is expanded before the turn is recorded.
2. An MCP server's tools appear in the tool list the model receives, and a
   real ``tools/call`` round-trip lands in the journal.
3. The ``task`` tool delegates to a read-only child run that cannot write.
4. With nothing opted in, the tool list is byte-identical to the default.

The MCP server here is a real subprocess speaking newline-delimited JSON-RPC,
so a passing run is evidence the handshake works.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, append_user_turn, run
from xueness.memory import UNTRUSTED_PREAMBLE  # noqa: F401  (kept for clarity)


def _write(state_dir: Path, kind: str, rid: str, **fields) -> None:
    directory = Path(state_dir) / "resources" / kind
    directory.mkdir(parents=True, exist_ok=True)
    item = {"id": rid, "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00", "enabled": True}
    item.update(fields)
    (directory / f"{rid}.json").write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")


FAKE_MCP_SERVER = r'''
import json, sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1"}}}
    elif method == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": "echo", "description": "Echo back the text",
             "inputSchema": {"type": "object",
                             "properties": {"text": {"type": "string"}},
                             "required": ["text"]}},
        ]}}
    elif method == "tools/call":
        args = (msg.get("params") or {}).get("arguments") or {}
        out = {"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": "MCP_ECHO:" + str(args.get("text", ""))}],
            "isError": False}}
    elif method and method.startswith("notifications/"):
        continue
    else:
        out = {"jsonrpc": "2.0", "id": mid,
               "error": {"code": -32601, "message": "method not found"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


class RecordingProvider:
    def __init__(self, script):
        """``script``: list of responses; the last one repeats."""
        self.script = list(script)
        self.prompts = []
        self.tools = []

    def complete(self, messages, tools):
        self.prompts.append(json.loads(json.dumps(messages)))
        self.tools.append(json.loads(json.dumps(tools)))
        return self.script[min(len(self.prompts) - 1, len(self.script) - 1)]


class CommandExpansionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_slash_command_is_expanded_before_the_turn(self):
        _write(self.state, "commands", "demo",
               name="demo", prompt="Do the demo thing with $ARGUMENTS")
        _write(self.state, "commands", "plain", name="plain", prompt="No placeholder here")

        session = self.store.new("start", self.workspace)
        session["status"] = "completed"
        self.store.save(session)

        from xueness.commands import load as load_commands
        append_user_turn(session, self.store, "/demo hello world", load_commands(self.state))

        last = session["messages"][-1]
        self.assertEqual(last["role"], "user")
        self.assertIn("Do the demo thing with hello world", last["content"])
        self.assertEqual(session["command_invocations"][-1]["command"], "demo")

        provider = RecordingProvider([{"content": json.dumps({"summary": "ok"})}])
        run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        self.assertIn("Do the demo thing with hello world",
                      json.dumps(provider.prompts[0], ensure_ascii=False))


class McpLoopTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)
        self.server_py = self.base / "fake_mcp.py"
        self.server_py.write_text(FAKE_MCP_SERVER, encoding="utf-8")
        _write(self.state, "mcp", "srv", name="srv", command=sys.executable,
               args=[str(self.server_py)])

    def tearDown(self):
        self._tmp.cleanup()

    def _clients(self):
        from xueness.mcp import McpClient, load, tool_schema
        clients, tools = {}, []
        for server in load(self.state):
            client = McpClient(server, cwd=self.workspace)
            client.start()
            clients[server["id"]] = client
            for tool in client.list_tools():
                tools.append(tool_schema(server["id"], tool))
        return clients, tools

    def test_mcp_tools_are_offered_and_calls_land_in_the_journal(self):
        clients, tools = self._clients()
        try:
            self.assertEqual([t["function"]["name"] for t in tools], ["mcp__srv__echo"])

            calls = []

            def mcp_call(name, arguments):
                calls.append((name, arguments))
                from xueness.mcp import parse_namespaced
                server_id, tool_name = parse_namespaced(name)
                return clients[server_id].call_tool(tool_name, arguments)

            provider = RecordingProvider([
                {"content": "", "tool_calls": [
                    {"id": "m1", "type": "function",
                     "function": {"name": "mcp__srv__echo",
                                  "arguments": json.dumps({"text": "ping"})}}]},
                {"content": json.dumps({"summary": "done", "evidence": []})},
            ])
            session = self.store.new("use the mcp tool", self.workspace)
            # MCP calls reach code we did not write, so they are gated like write/exec:
            # this run opts in explicitly (the deny-by-default path is covered by
            # test_mcp_call_is_denied_without_approval below).
            run(session, self.store, provider, Gate(self.workspace, allow_mcp=True), max_steps=3,
                mcp_tools=tools, mcp_call=mcp_call)

            # The model really was offered the MCP tool...
            offered = [t["function"]["name"] for t in provider.tools[0]]
            self.assertIn("mcp__srv__echo", offered)
            # ...the call really happened...
            self.assertEqual(calls, [("mcp__srv__echo", {"text": "ping"})])
            # ...and its result was recorded as the tool message.
            tool_msgs = [m for m in session["messages"] if m.get("role") == "tool"]
            self.assertTrue(tool_msgs)
            self.assertIn("MCP_ECHO:ping", tool_msgs[-1]["content"])
        finally:
            for client in clients.values():
                client.close()

    def test_mcp_call_is_denied_without_approval(self):
        """Deny-by-default: an MCP tool must not reach the server unprompted."""
        clients, tools = self._clients()
        try:
            calls = []

            def mcp_call(name, arguments):
                calls.append((name, arguments))
                from xueness.mcp import parse_namespaced
                server_id, tool_name = parse_namespaced(name)
                return clients[server_id].call_tool(tool_name, arguments)

            provider = RecordingProvider([
                {"content": "", "tool_calls": [
                    {"id": "m1", "type": "function",
                     "function": {"name": "mcp__srv__echo",
                                  "arguments": json.dumps({"text": "ping"})}}]},
                {"content": json.dumps({"summary": "done", "evidence": []})},
            ])
            session = self.store.new("try the mcp tool", self.workspace)
            run(session, self.store, provider, Gate(self.workspace), max_steps=3,
                mcp_tools=tools, mcp_call=mcp_call)

            # The server was never contacted...
            self.assertEqual(calls, [])
            # ...and the denial is visible in the journal rather than silent.
            tool_msgs = [m for m in session["messages"] if m.get("role") == "tool"]
            self.assertTrue(tool_msgs)
            self.assertIn('"denied"', tool_msgs[-1]["content"])
        finally:
            for client in clients.values():
                client.close()

    def test_mcp_denied_in_plan_mode_even_when_opted_in(self):
        """Plan mode is a read-only planning boundary: MCP has side effects."""
        clients, tools = self._clients()
        try:
            calls = []

            def mcp_call(name, arguments):
                calls.append((name, arguments))
                return {"ok": True, "content": "should not happen", "error": None}

            provider = RecordingProvider([
                {"content": "", "tool_calls": [
                    {"id": "m1", "type": "function",
                     "function": {"name": "mcp__srv__echo",
                                  "arguments": json.dumps({"text": "ping"})}}]},
                {"content": json.dumps({"summary": "done", "evidence": []})},
            ])
            session = self.store.new("plan around it", self.workspace)
            run(session, self.store, provider,
                Gate(self.workspace, mode="plan", allow_mcp=True), max_steps=3,
                mcp_tools=tools, mcp_call=mcp_call)

            self.assertEqual(calls, [])
            tool_msgs = [m for m in session["messages"] if m.get("role") == "tool"]
            self.assertIn('"denied"', tool_msgs[-1]["content"])
        finally:
            for client in clients.values():
                client.close()

    def test_mcp_not_opted_in_leaves_tools_unchanged(self):
        provider = RecordingProvider([{"content": json.dumps({"summary": "ok"})}])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        names = [t["function"]["name"] for t in provider.tools[0]]
        self.assertFalse([n for n in names if n.startswith("mcp__")])


class SubagentLoopTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)
        _write(self.state, "subagents", "reviewer", name="Reviewer",
               systemPrompt="You review things carefully.")

    def tearDown(self):
        self._tmp.cleanup()

    def test_task_tool_delegates_and_parent_journal_stays_small(self):
        from xueness.subagents import load as load_subagents

        providers = []

        def make_provider():
            return RecordingProvider([
                {"content": "", "tool_calls": [
                    {"id": "s1", "type": "function",
                     "function": {"name": "task",
                                  "arguments": json.dumps({"prompt": "check the file",
                                                           "agent": "reviewer"})}}]},
                {"content": json.dumps({"summary": "child done", "evidence": []})},
            ])

        parent = self.store.new("delegate this", self.workspace)
        child_provider = make_provider()

        class SwitchingProvider:
            """Parent turn 1 delegates; the child run gets its own script."""

            def __init__(self):
                self.parent = make_provider()
                self.child = None

            def complete(self, messages, tools):
                # The child's system prompt carries the agent text.
                if any("You review things carefully." in (m.get("content") or "")
                       for m in messages if m.get("role") == "system"):
                    if self.child is None:
                        self.child = child_provider
                    return self.child.complete(messages, tools)
                return self.parent.complete(messages, tools)

        switching = SwitchingProvider()
        out = run(parent, self.store, switching, Gate(self.workspace, allow_write=True),
                  max_steps=3, subagents=load_subagents(self.state), max_depth=1)

        # The task call is visible in the parent journal...
        blob = json.dumps(parent["messages"], ensure_ascii=False)
        self.assertIn("task", blob)
        result = out["results"].get("s1")
        self.assertIsNotNone(result, "no result recorded for the delegated call")
        self.assertTrue(result.get("ok"))

        # ...but the child's system prompt and transcript are NOT persisted.
        self.assertNotIn("You review things carefully.", blob)
        self.assertNotIn("sub-", blob)  # no child session id leaked in

    def test_subagent_cannot_write(self):
        """The delegated run gets a read-only gate: writes must be denied."""
        from xueness.subagents import load as load_subagents

        class WriteAttemptProvider:
            """Child: attempt one write; the host must deny and pause it."""

            def __init__(self):
                self.n = 0

            def complete(self, messages, tools):
                self.n += 1
                return {"content": "", "tool_calls": [
                    {"id": "c-w", "type": "function",
                     "function": {"name": "write",
                                  "arguments": json.dumps({"path": "should-not-exist.txt",
                                                           "content": "x"})}}]}

        parent_provider = RecordingProvider([
            {"content": "", "tool_calls": [
                {"id": "s1", "type": "function",
                 "function": {"name": "task",
                              "arguments": json.dumps({"prompt": "try to write"})}}]},
            {"content": json.dumps({"summary": "parent done", "evidence": []})},
        ])
        child_provider = WriteAttemptProvider()

        class Router:
            """The parent is the run that was offered ``task``; the child is not."""

            def complete(self, messages, tools):
                names = [t["function"]["name"] for t in tools]
                if "task" in names:
                    return parent_provider.complete(messages, tools)
                return child_provider.complete(messages, tools)

        parent = self.store.new("delegate", self.workspace)
        out = run(parent, self.store, Router(), Gate(self.workspace, allow_write=True),
                  max_steps=3, subagents=load_subagents(self.state), max_depth=1)

        self.assertFalse((self.workspace / "should-not-exist.txt").exists(),
                         "a delegated run wrote to the workspace despite the read-only gate")
        # A hard denial is returned to the delegated task and pauses it before
        # another provider request can repeat the same refused action.
        self.assertEqual(child_provider.n, 1)
        result = out["results"]["s1"]
        self.assertTrue(result["ok"], result)
        self.assertIn("权限策略禁止", result["summary"])

    def test_depth_cap_hides_the_task_tool(self):
        from xueness.subagents import load as load_subagents

        provider = RecordingProvider([{"content": json.dumps({"summary": "ok"})}])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=1,
            subagents=load_subagents(self.state), depth=1, max_depth=1)
        names = [t["function"]["name"] for t in provider.tools[0]]
        self.assertNotIn("task", names, "task was offered past the depth cap")

    def test_task_tool_present_when_allowed(self):
        from xueness.subagents import load as load_subagents

        provider = RecordingProvider([{"content": json.dumps({"summary": "ok"})}])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=1,
            subagents=load_subagents(self.state), depth=0, max_depth=1)
        names = [t["function"]["name"] for t in provider.tools[0]]
        self.assertIn("task", names)


class DefaultsUnchangedTests(unittest.TestCase):
    """With every capability off, the tool list must be the stock one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_default_tool_list_has_no_opt_in_tools(self):
        from xueness.plugin_runtime import tool_schemas

        provider = RecordingProvider([{"content": json.dumps({"summary": "ok"})}])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        self.assertEqual(provider.tools[0], tool_schemas(self.store.directory))
        names = [t["function"]["name"] for t in provider.tools[0]]
        self.assertTrue({"read", "list", "glob", "grep", "write", "edit",
                         "exec", "todo_read", "todo_write", "ask_user"}.issubset(names))
        self.assertNotIn("task", names)
        self.assertNotIn("skill_read", names)
        self.assertFalse(any(name.startswith("mcp__") for name in names))


if __name__ == "__main__":
    unittest.main()
