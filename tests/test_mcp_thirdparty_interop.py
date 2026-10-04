"""Interop test against a REAL third-party MCP server (not ours, not an SDK sample).

``tests/test_mcp.py`` drives a fake we wrote, and ``test_mcp_real_interop.py``
drives a server we built on the official SDK. Neither proves we can talk to a
package someone else shipped. This module uses ``@modelcontextprotocol/server-github``
from the local npm cache when present.

Deliberately **handshake + tools/list only**: calling any of those tools would
reach the live GitHub API, which this suite must never do. Schema discovery is
enough to prove wire compatibility.

Skips (not fails) when the package is absent, so the suite still runs anywhere.
"""
import glob
import json
import os
import shutil
import unittest
from pathlib import Path

from xueness.mcp import McpClient, tool_schema

PACKAGE = "@modelcontextprotocol/server-github"


def _find_entry() -> str | None:
    """Locate the cached package entry point without installing anything."""
    if shutil.which("node") is None:
        return None
    configured = os.environ.get("XUENESS_MCP_TEST_NODE_MODULES")
    roots = []
    if configured:
        roots.append(str(Path(configured).expanduser().resolve()))
    roots.extend([
        os.path.expanduser("~/.npm/_npx/*/node_modules"),
        str(Path(__file__).resolve().parent.parent / "webapp" / "node_modules"),
    ])
    for root in roots:
        for candidate in glob.glob(os.path.join(root, PACKAGE, "dist", "index.js")):
            return candidate
    return None


class ThirdPartyServerInteropTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entry = _find_entry()
        if not cls.entry:
            raise unittest.SkipTest("third-party %s not available locally" % PACKAGE)

    def setUp(self):
        import tempfile
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.work = Path(holder.name)
        self.client = McpClient(
            {"id": "gh", "command": "node", "args": [self.entry]},
            cwd=self.work, timeout=30,
        )
        self.addCleanup(self.client.close)

    def test_handshake_with_a_third_party_server(self):
        self.client.start()
        self.assertIsNone(self.client.error, "handshake failed: %r" % (self.client.error,))
        self.assertTrue(self.client.active)
        # The server identifies itself; ours must have parsed that, not guessed.
        self.assertTrue(self.client.server_info.get("name"))
        self.assertEqual(self.client.negotiated_protocol_version, "2024-11-05")

    def test_tools_list_from_a_third_party_server(self):
        self.client.start()
        tools = self.client.list_tools()
        self.assertIsNone(self.client.error)
        # A real server ships a substantial toolset; an empty list would mean we
        # mis-parsed the response rather than that the server has nothing.
        self.assertGreater(len(tools), 5, "suspiciously few tools: %r" % (tools[:3],))
        names = [t["name"] for t in tools]
        self.assertEqual(len(names), len(set(names)), "duplicate tool names")

        # Every real tool must carry a usable JSON Schema, or our wrapper would
        # hand the model a tool with no parameters.
        for tool in tools:
            self.assertIsInstance(tool.get("inputSchema"), dict, tool.get("name"))
            self.assertIn("type", tool["inputSchema"], tool.get("name"))

        # And our OpenAI-style wrapper must survive the real shapes.
        for tool in tools:
            wrapped = tool_schema("gh", tool)
            self.assertTrue(wrapped["function"]["name"].startswith("mcp__gh__"))
            self.assertEqual(wrapped["function"]["parameters"], tool["inputSchema"])

    def test_clean_close_of_a_third_party_server(self):
        self.client.start()
        self.client.list_tools()
        self.client.close()
        self.client.close()  # idempotent
        self.assertFalse(self.client.active)

    def test_web_style_registry_roundtrip(self):
        """The same server via the ``load()`` path the web handler uses."""
        import tempfile
        from xueness.mcp import load as load_mcp

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            directory = state / "resources" / "mcp"
            directory.mkdir(parents=True)
            (directory / "gh.json").write_text(json.dumps({
                "id": "gh", "enabled": True, "command": "node", "args": [self.entry],
            }), encoding="utf-8")

            servers = load_mcp(state)
            self.assertEqual([s["id"] for s in servers], ["gh"])
            client = McpClient(servers[0], cwd=self.work, timeout=30)
            self.addCleanup(client.close)
            client.start()
            tools = client.list_tools()
            self.assertGreater(len(tools), 5)
            self.assertTrue(all(t["name"] for t in tools))


if __name__ == "__main__":
    unittest.main()
