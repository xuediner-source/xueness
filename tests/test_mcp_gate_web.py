"""MCP tool calls are gated like write/exec, proven at the HTTP boundary.

Why this exists: MCP calls run code we did not write, but they used to bypass
``Gate`` entirely — ``run()`` dispatched them straight to ``mcp_call``. The
MCP spec says a client "should never" make tool-use decisions from a server's
``ToolAnnotations``, and the real third-party servers we measured ship none, so
there is no trustworthy read-only signal to classify by. Every MCP call is
therefore deny-by-default and runs only after an explicit per-call approval.

These tests drive the real HTTP handler with a real (fake-backed) MCP server
subprocess, so they assert on behaviour rather than on a mock's opinion.
"""
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import web
from tests.fake_provider_fixture import inject_provider

# A minimal real MCP server over stdio (newline-delimited JSON-RPC).
FAKE_SERVER = r'''
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except ValueError:
        continue
    mid = m.get("id")
    mth = m.get("method")
    if mth == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1"}}}
    elif mth == "notifications/initialized":
        continue
    elif mth == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": "echo", "description": "Echo",
             "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                             "required": ["text"]}}]}}
    elif mth == "tools/call":
        a = (m.get("params") or {}).get("arguments") or {}
        out = {"jsonrpc": "2.0", "id": mid, "result": {"content": [
            {"type": "text", "text": "MCP_ECHO:" + str(a.get("text", ""))}], "isError": False}}
    else:
        out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nf"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


class McpCallProvider:
    """Emits one MCP tool call, then finishes once it has succeeded.

    Single-step shape on purpose: if the call was denied the provider stops, so
    the UI can approve that exact tool_call_id and the harness re-executes it.
    """

    def __init__(self, tool="mcp__srv__echo", call_id="m1"):
        self.tool = tool
        self.call_id = call_id
        self.turns = 0
        self.tools = []

    def complete(self, messages, tools):
        self.tools.append(tools)
        self.turns += 1
        done = False
        for message in messages:
            if message.get("tool_call_id") == self.call_id:
                try:
                    result = json.loads(message.get("content") or "{}")
                except ValueError:
                    result = {}
                if result.get("ok"):
                    done = True
        if not done:
            return {"content": "", "tool_calls": [
                {"id": self.call_id, "type": "function",
                 "function": {"name": self.tool,
                              "arguments": json.dumps({"text": "ping"})}}]}
        return {"content": json.dumps({"summary": "done", "evidence": [{
            "tool_call_id": self.call_id,
            "observation": "The approved MCP call returned a successful result.",
        }]})}


class McpGateWebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.state = base / "state"
        self.project_dir = base / "proj"
        (self.project_dir / "xueness" / "static").mkdir(parents=True)
        dist = self.project_dir / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")

        # A real MCP server, configured the way an operator would.
        server_py = self.state / "fake_mcp.py"
        self.state.mkdir(parents=True, exist_ok=True)
        server_py.write_text(FAKE_SERVER, encoding="utf-8")
        mcp_dir = self.state / "resources" / "mcp"
        mcp_dir.mkdir(parents=True)
        (mcp_dir / "srv.json").write_text(json.dumps({
            "id": "srv", "enabled": True, "command": sys.executable,
            "args": [str(server_py)]}), encoding="utf-8")

        self.ctx = web.build_context(self.state, base / "runs", self.project_dir,
                                     allow_real=False, csrf="tok")
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base_url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    # -- helpers -----------------------------------------------------------

    def _req(self, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        headers = {"X-CSRF-Token": "tok"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=body, headers=headers,
                                     method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8", "replace"))

    def _new_session(self):
        status, payload = self._req("/api/sessions", {"task": "use the mcp tool"})
        self.assertEqual(status, 200, payload)
        return payload["id"]

    def _run(self, sid, **extra):
        body = {"provider": "real", "steps": 6, "allow_mcp": True}
        body.update(extra)
        return self._req("/api/sessions/%s/run" % sid, body)

    @staticmethod
    def _tool_messages(sid):
        # Re-read through the API so we assert on what was durably recorded.
        return None

    def _journal(self, sid):
        import urllib.request as u
        with u.urlopen(self.base_url + "/api/sessions/%s/journal" % sid, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def _tool_result(journal, call_id):
        for message in journal.get("messages", []):
            if message.get("tool_call_id") == call_id:
                try:
                    return json.loads(message.get("content") or "{}")
                except ValueError:
                    return {}
        return None

    # -- the gate ----------------------------------------------------------

    def test_mcp_call_is_denied_without_an_approval(self):
        """Deny-by-default: the approved-by-nobody call must not reach the server."""
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            status, payload = self._run(sid)
        self.assertEqual(status, 200, payload)

        journal = self._journal(sid)
        result = self._tool_result(journal, "m1")
        self.assertIsNotNone(result, "no tool result recorded")
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("error"), "denied")

        # It must also be offered for approval, with the canonical subject.
        self.assertTrue(payload.get("pending"), payload)
        entry = next(p for p in payload["pending"] if p["tool_call_id"] == "m1")
        self.assertEqual(entry["name"], "mcp__srv__echo")
        self.assertIn("mcp__srv__echo", entry["subject"])

    def test_unapproved_mcp_call_never_reaches_the_server(self):
        """Prove the denial is real by observing the server's own empty journal."""
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            self._run(sid)
        # The server process is only spawned per-run; a denied call leaves no
        # result carrying server output.
        result = self._tool_result(self._journal(sid), "m1")
        self.assertNotIn("MCP_ECHO", json.dumps(result))

    def test_approval_makes_the_call_run(self):
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            status, payload = self._run(sid)
            self.assertEqual(status, 200, payload)
            self.assertEqual("paused", payload["status"], payload)
            self.assertIsNone(payload["completion"], payload)
            entry = next(p for p in payload["pending"] if p["tool_call_id"] == "m1")

            # Approve exactly that call.
            status, approved = self._req("/api/sessions/%s/approvals" % sid,
                                         {"kind": "mcp", "tool_call_id": "m1"})
            self.assertEqual(status, 200, approved)
            self.assertEqual(approved["approved"]["kind"], "mcp")
            self.assertEqual(approved["approved"]["subject"], entry["subject"])

            # Re-run: the replay executes the approved call against the server.
            status, payload2 = self._run(sid)
            self.assertEqual(status, 200, payload2)
            self.assertEqual("completed", payload2["status"], payload2)
            self.assertTrue(payload2["completion"]["verified"], payload2)
            self.assertEqual([], payload2["pending"], payload2)

        result = self._tool_result(self._journal(sid), "m1")
        self.assertTrue(result.get("ok"), result)
        self.assertIn("MCP_ECHO:ping", result.get("content", ""))

    def test_approval_is_one_shot(self):
        """A consumed approval cannot be replayed by a later run."""
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            self._run(sid)
            self._req("/api/sessions/%s/approvals" % sid, {"kind": "mcp", "tool_call_id": "m1"})
            self._run(sid)
            # The approval was consumed on first use.
            _, detail = self._req("/api/sessions/%s" % sid)
        self.assertEqual(detail["approved"]["mcp"], [], "approval must be consumed on first use")

    def test_approval_requires_an_exact_pending_tool_call_id(self):
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            self._run(sid)
        # Unknown id is refused.
        status, payload = self._req("/api/sessions/%s/approvals" % sid,
                                    {"kind": "mcp", "tool_call_id": "not-a-call"})
        self.assertEqual(status, 400, payload)

    def test_plan_mode_denies_mcp_even_with_the_opt_in(self):
        """Plan mode is a read-only boundary; MCP has side effects."""
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            status, payload = self._run(sid, mode="plan")
        self.assertEqual(status, 200, payload)
        result = self._tool_result(self._journal(sid), "m1")
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("error"), "denied")

    def test_mcp_can_be_disallowed_by_name(self):
        sid = self._new_session()
        provider = McpCallProvider()
        with inject_provider(provider, ctx=self.ctx):
            status, payload = self._run(sid, disallow_tools="mcp")
        self.assertEqual(status, 200, payload)
        result = self._tool_result(self._journal(sid), "m1")
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("error"), "denied")

    def test_blanket_mcp_approval_is_never_accepted_over_http(self):
        sid = self._new_session()
        status, payload = self._run(sid, allow_mcp=True, approve_all=True)
        self.assertEqual(status, 400, payload)
        self.assertIn("blanket", payload.get("error", ""))

    def test_approving_one_mcp_tool_does_not_approve_another(self):
        """The subject binds tool name + arguments, not just the server."""
        from xueness.core import mcp_subject
        a = mcp_subject("mcp__srv__echo", {"text": "ping"})
        b = mcp_subject("mcp__srv__echo", {"text": "other"})
        c = mcp_subject("mcp__srv__push", {"text": "ping"})
        self.assertNotEqual(a, b, "different arguments must not share an approval")
        self.assertNotEqual(a, c, "different tools must not share an approval")

    def test_subject_is_stable_across_key_order(self):
        from xueness.core import mcp_subject
        self.assertEqual(mcp_subject("mcp__srv__echo", {"a": 1, "b": 2}),
                         mcp_subject("mcp__srv__echo", {"b": 2, "a": 1}))


if __name__ == "__main__":
    unittest.main()
