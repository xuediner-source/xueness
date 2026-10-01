"""Stage 6 end-to-end: the run-time capability switches actually gate behaviour.

The switches live in the ``agent`` settings section and are read by the frontend
``readRunOptIns()``. What matters at the HTTP layer is that the *run* endpoint
honours them: with MCP off the model must not be offered MCP tools, and with it
on the configured server must really be connected.

``xueness.web.run`` is patched here so we can assert on the exact arguments the
handler passed (not on a mock's opinion): ``mcp_tools`` / ``subagents`` /
``hooks`` must be absent unless explicitly opted in.
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import web

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
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "fake", "version": "1"}}}
    elif mth == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": "echo", "description": "Echo", "inputSchema": {
                "type": "object", "properties": {"text": {"type": "string"}},
                "required": ["text"]}}]}}
    elif mth and mth.startswith("notifications/"):
        continue
    else:
        out = {"jsonrpc": "2.0", "id": mid,
               "error": {"code": -32601, "message": "nf"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


class RunOptInTests(unittest.TestCase):
    """Each switch must be off unless the request asks for it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.state = base / "state"
        self.project_dir = base / "proj"
        (self.project_dir / "xueness" / "static").mkdir(parents=True)
        dist = self.project_dir / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        self.ctx = web.build_context(self.state, base / "runs", self.project_dir,
                                     allow_real=False, csrf="test-csrf-token")
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _req(self, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        headers = {"X-CSRF-Token": "test-csrf-token"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=body, headers=headers,
                                     method="POST" if body is not None else "GET")
        def send():
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read().decode("utf-8", "replace"))
        if path.endswith("/run"):
            from tests.fake_provider_fixture import inject_provider
            with inject_provider(ctx=self.ctx):
                return send()
        return send()

    def _new_session(self):
        status, payload = self._req("/api/sessions", {"task": "t"})
        self.assertEqual(status, 200, payload)
        return payload["id"]

    def _install_mcp_server(self):
        server_py = self.state / "fake_mcp.py"
        server_py.write_text(FAKE_SERVER, encoding="utf-8")
        directory = self.state / "resources" / "mcp"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "srv.json").write_text(json.dumps({
            "id": "srv", "enabled": True, "command": sys.executable,
            "args": [str(server_py)]}), encoding="utf-8")

    @staticmethod
    def _stub_run(record):
        """Stand-in for web.run that records how the handler called it."""

        def fake(session, store, provider, gate, steps, max_chars, **kwargs):
            record.update(kwargs)
            return {"id": session["id"], "status": "completed", "steps": 1,
                    "mode": "build", "completion": {"verified": True, "summary": "ok"},
                    "todos": [], "hook_log": []}

        return fake

    def test_all_opt_ins_off_by_default(self):
        self._install_mcp_server()
        sid = self._new_session()
        record = {}
        with patch("xueness.web.run", side_effect=self._stub_run(record)):
            status, payload = self._req("/api/sessions/%s/run" % sid,
                                        {"provider": "real", "steps": 1})
        self.assertEqual(status, 200, payload)
        # Off means genuinely absent, not falsy-but-present.
        self.assertIsNone(record.get("mcp_tools"))
        self.assertIsNone(record.get("mcp_call"))
        self.assertIsNone(record.get("subagents"))
        self.assertIsNone(record.get("hooks"))

    def test_allow_mcp_connects_the_configured_server(self):
        self._install_mcp_server()
        sid = self._new_session()
        record = {}
        with patch("xueness.web.run", side_effect=self._stub_run(record)):
            status, payload = self._req("/api/sessions/%s/run" % sid,
                                        {"provider": "real", "steps": 1,
                                         "allow_mcp": True})
        self.assertEqual(status, 200, payload)
        tools = record.get("mcp_tools")
        self.assertTrue(tools, "allow_mcp did not produce any MCP tools")
        names = [t["function"]["name"] for t in tools]
        self.assertEqual(names, ["mcp__srv__echo"])
        # The call function must be wired to the live client.
        self.assertTrue(callable(record.get("mcp_call")))

    def test_allow_subagents_exposes_the_task_tool(self):
        directory = self.state / "resources" / "subagents"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "reviewer.json").write_text(json.dumps({
            "id": "reviewer", "name": "Reviewer", "enabled": True,
            "systemPrompt": "x"}), encoding="utf-8")
        sid = self._new_session()
        record = {}
        with patch("xueness.web.run", side_effect=self._stub_run(record)):
            status, payload = self._req("/api/sessions/%s/run" % sid,
                                        {"provider": "real", "steps": 1,
                                         "allow_subagents": True})
        self.assertEqual(status, 200, payload)
        agents = record.get("subagents")
        self.assertTrue(agents, "allow_subagents produced no agents")
        self.assertEqual([a["id"] for a in agents], ["reviewer"])

    def test_empty_mcp_registry_degrades_to_no_tools(self):
        """Opting in with nothing configured must not error or invent tools."""
        sid = self._new_session()
        record = {}
        with patch("xueness.web.run", side_effect=self._stub_run(record)):
            status, payload = self._req("/api/sessions/%s/run" % sid,
                                        {"provider": "real", "steps": 1,
                                         "allow_mcp": True})
        self.assertEqual(status, 200, payload)
        self.assertIsNone(record.get("mcp_tools"))

    def test_broken_mcp_server_degrades_without_500(self):
        """A server that dies on startup must not take the run endpoint down."""
        directory = self.state / "resources" / "mcp"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "broken.json").write_text(json.dumps({
            "id": "broken", "enabled": True,
            "command": sys.executable, "args": ["-c", "raise SystemExit(1)"]}),
            encoding="utf-8")
        sid = self._new_session()
        record = {}
        with patch("xueness.web.run", side_effect=self._stub_run(record)):
            status, payload = self._req("/api/sessions/%s/run" % sid,
                                        {"provider": "real", "steps": 1,
                                         "allow_mcp": True})
        self.assertEqual(status, 200, payload)
        self.assertIsNone(record.get("mcp_tools"))

    def test_agent_settings_roundtrip_over_http(self):
        status, payload = self._req("/api/settings/agent")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"section": "agent", "values": {}})

        status, payload = self._req("/api/settings/agent")  # GET is not a POST
        self.assertEqual(status, 200)

        # POST via the same helper used for other sections.
        body = json.dumps({"values": {"allowMcp": True}})
        req = urllib.request.Request(
            self.base + "/api/settings/agent", data=body.encode(),
            headers={"X-CSRF-Token": "test-csrf-token", "Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp:
            self.assertEqual(resp.status, 200)
            saved = json.loads(resp.read().decode("utf-8"))
        self.assertEqual(saved["values"], {"allowMcp": True})

        status, payload = self._req("/api/settings/agent")
        self.assertEqual(payload["values"], {"allowMcp": True})


if __name__ == "__main__":
    unittest.main()
