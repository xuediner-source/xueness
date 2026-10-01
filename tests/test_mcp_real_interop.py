"""Interop test: Xueness's stdlib McpClient against a REAL MCP server.

Every other MCP test in this repo drives a hand-written fake. That proves the
client is self-consistent, not that it speaks the actual protocol. This module
drives a server built on the official ``@modelcontextprotocol/sdk``
(``webapp/tools/real_mcp_server.mjs``), so a passing run is evidence of real
interoperability: handshake, version negotiation, ``tools/list`` schema shape,
``tools/call`` success, multi-block content, and ``isError`` handling.

Skips (not fails) when node or the SDK is unavailable, so the suite still runs
on a machine without them.
"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from xueness.mcp import McpClient, tool_schema

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "webapp" / "tools" / "real_mcp_server.mjs"
SDK = ROOT / "webapp" / "node_modules" / "@modelcontextprotocol" / "sdk"


def _node() -> str | None:
    return shutil.which("node")


def _available() -> tuple[bool, str]:
    if not SERVER.exists():
        return False, "real_mcp_server.mjs missing"
    if not SDK.exists():
        return False, "official MCP SDK not installed"
    node = _node()
    if node is None:
        return False, "node not on PATH"
    return True, ""


class RealMcpInteropTests(unittest.TestCase):
    """Drive the official-SDK server through our own client."""

    @classmethod
    def setUpClass(cls):
        ok, why = _available()
        if not ok:
            raise unittest.SkipTest("real MCP interop unavailable: %s" % why)

    def setUp(self):
        self.work = Path(self._tmpdir())
        self.client = McpClient(
            {"id": "real", "command": _node(), "args": [str(SERVER)]},
            cwd=ROOT / "webapp",
        )
        self.addCleanup(self.client.close)

    def _tmpdir(self):
        import tempfile
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        return holder.name

    # -- handshake ---------------------------------------------------------

    def test_handshake_succeeds_against_the_official_sdk(self):
        self.client.start()
        self.assertIsNone(self.client.error, "handshake failed: %r" % (self.client.error,))
        self.assertTrue(self.client.active)

    def test_negotiated_protocol_version_is_the_one_we_asked_for(self):
        """We request 2024-11-05; the SDK supports it, so it must be echoed."""
        self.client.start()
        self.assertIsNone(self.client.error)
        self.assertEqual(self.client.negotiated_protocol_version, "2024-11-05")
        self.assertEqual(self.client.server_info.get("name"), "xueness-compat-probe")

    def test_every_supported_version_really_works_with_the_official_sdk(self):
        """Backs the claim in ``mcp.SUPPORTED_PROTOCOL_VERSIONS``.

        That constant is a promise: each listed version is one we can actually
        speak. This drives the real SDK server at every one of them and requires
        a full handshake + tools/list + tools/call, so the list cannot drift
        into optimism.
        """
        from xueness.mcp import SUPPORTED_PROTOCOL_VERSIONS

        for version in SUPPORTED_PROTOCOL_VERSIONS:
            with self.subTest(version=version):
                client = McpClient(
                    {"id": "real", "command": _node(), "args": [str(SERVER)],
                     "protocolVersion": version},
                    cwd=ROOT / "webapp", timeout=30,
                )
                self.addCleanup(client.close)
                client.start()
                self.assertIsNone(client.error, "%s: %r" % (version, client.error))
                self.assertEqual(client.negotiated_protocol_version, version)

                tools = client.list_tools()
                self.assertEqual(sorted(t["name"] for t in tools),
                                 ["add", "echo", "fail", "multipart"])

                result = client.call_tool("echo", {"text": version})
                self.assertTrue(result["ok"], result)
                self.assertIn("SDK_ECHO:%s" % version, result["content"])

    # -- tools/list --------------------------------------------------------

    def test_list_tools_reads_the_sdks_real_schemas(self):
        self.client.start()
        tools = self.client.list_tools()
        names = sorted(t["name"] for t in tools)
        self.assertEqual(names, ["add", "echo", "fail", "multipart"])

        echo = next(t for t in tools if t["name"] == "echo")
        self.assertEqual(echo["description"], "Echo the text argument back")
        # The SDK emits JSON Schema; our schema passthrough must preserve it.
        self.assertEqual(echo["inputSchema"]["type"], "object")
        self.assertIn("text", echo["inputSchema"]["properties"])
        self.assertEqual(echo["inputSchema"]["required"], ["text"])

        add = next(t for t in tools if t["name"] == "add")
        self.assertEqual(sorted(add["inputSchema"]["properties"]), ["a", "b"])

    def test_tool_schema_wraps_sdk_tools_correctly(self):
        self.client.start()
        echo = next(t for t in self.client.list_tools() if t["name"] == "echo")
        schema = tool_schema("real", echo)
        self.assertEqual(schema["function"]["name"], "mcp__real__echo")
        self.assertEqual(schema["function"]["parameters"], echo["inputSchema"])

    # -- tools/call --------------------------------------------------------

    def test_call_tool_round_trip(self):
        self.client.start()
        result = self.client.call_tool("echo", {"text": "hello"})
        self.assertTrue(result["ok"], result)
        self.assertIn("SDK_ECHO:hello", result["content"])

    def test_call_tool_with_numeric_schema(self):
        self.client.start()
        result = self.client.call_tool("add", {"a": 2, "b": 40})
        self.assertTrue(result["ok"], result)
        self.assertIn("42", result["content"])

    def test_multi_block_content_is_joined(self):
        self.client.start()
        result = self.client.call_tool("multipart", {})
        self.assertTrue(result["ok"], result)
        self.assertIn("part-one", result["content"])
        self.assertIn("part-two", result["content"])

    def test_is_error_result_is_reported_as_failure(self):
        """A tool-level error must not raise, and must not look like success."""
        self.client.start()
        result = self.client.call_tool("fail", {})
        self.assertFalse(result["ok"], result)
        self.assertIn("intentional failure", (result["error"] or "") + (result["content"] or ""))

    def test_unknown_tool_does_not_raise(self):
        self.client.start()
        result = self.client.call_tool("no-such-tool", {})
        self.assertFalse(result["ok"])
        self.assertIsInstance(result.get("error"), str)

    def test_clean_close_after_real_traffic(self):
        self.client.start()
        self.client.call_tool("echo", {"text": "x"})
        self.client.close()
        self.client.close()  # idempotent
        self.assertFalse(self.client.active)


class RealMcpOverHttpSurfaceTests(unittest.TestCase):
    """The same real server, reached through the web run endpoint."""

    @classmethod
    def setUpClass(cls):
        ok, why = _available()
        if not ok:
            raise unittest.SkipTest("real MCP interop unavailable: %s" % why)

    def test_web_layer_exposes_real_sdk_tools(self):
        """End-to-end: web handler -> real SDK server -> tool schemas."""
        import tempfile
        import threading
        import urllib.request
        from unittest.mock import patch

        from xueness import web

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project = base / "proj"
            (project / "xueness" / "static").mkdir(parents=True)
            dist = project / "webapp" / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
            state = base / "state"
            state.mkdir()

            mcp_dir = state / "resources" / "mcp"
            mcp_dir.mkdir(parents=True)
            (mcp_dir / "real.json").write_text(json.dumps({
                "id": "real", "enabled": True, "command": _node(),
                "args": [str(SERVER)]}), encoding="utf-8")

            ctx = web.build_context(state, base / "runs", project,
                                    allow_real=False, csrf="t")
            server = web.create_server(0, ctx)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            url = "http://127.0.0.1:%d" % server.server_address[1]

            def post(path, payload):
                req = urllib.request.Request(
                    url + path, data=json.dumps(payload).encode(),
                    headers={"Content-Type": "application/json", "X-CSRF-Token": "t"},
                    method="POST")
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode())

            sid = post("/api/sessions", {"task": "t"})["id"]

            seen = {}

            def fake_run(session, store, provider, gate, steps, max_chars, **kwargs):
                seen.update(kwargs)
                # The handler closes MCP clients in its `finally`, so the wired
                # call function is only usable *during* the run. Exercise it here
                # (inside the run) rather than after the response returns.
                call = kwargs.get("mcp_call")
                if callable(call):
                    seen["echo_result"] = call("mcp__real__echo", {"text": "via-web"})
                return {"id": session["id"], "status": "completed", "steps": 1,
                        "mode": "build", "completion": {"verified": True, "summary": "ok"},
                        "todos": [], "hook_log": []}

            with patch("xueness.web.run", side_effect=fake_run):
                from tests.fake_provider_fixture import inject_provider
                with inject_provider(ctx=ctx):
                    post("/api/sessions/%s/run" % sid, {"provider": "real", "steps": 1,
                                                        "allow_mcp": True})

            tools = seen.get("mcp_tools") or []
            names = sorted(t["function"]["name"] for t in tools)
            self.assertEqual(names, ["mcp__real__add", "mcp__real__echo",
                                     "mcp__real__fail", "mcp__real__multipart"])

            # The wired call function really reached the official-SDK server.
            result = seen.get("echo_result")
            self.assertIsNotNone(result, "mcp_call was never exercised during the run")
            self.assertTrue(result["ok"], result)
            self.assertIn("SDK_ECHO:via-web", result["content"])


if __name__ == "__main__":
    unittest.main()
