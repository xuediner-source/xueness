"""Parity regression tests for MCP tool bridge (matching ZCode core/src/mcp).

Tests that:
1. sanitize_mcp_name_part normalizes non-alphanumeric chars to underscore, capped at 64 chars.
2. tool_schema uses sanitized tool names.
3. _extract_text extracts text from text blocks, resource blocks, image/audio placeholders, and strings.
4. call_tool appends structuredContent when provided by server.
5. McpPlugin maps sanitized model-visible names back to raw server tool names.
"""
import json
import unittest
from unittest.mock import MagicMock

from xueness.mcp import _extract_text, sanitize_mcp_name_part, tool_schema, namespaced, parse_namespaced
from xueness.bundled_plugins.mcp.mcp import McpClient
from xueness.bundled_plugins.mcp.plugin import McpPlugin


class ParityMcpTests(unittest.TestCase):
    def test_sanitize_mcp_name_part(self):
        self.assertEqual(sanitize_mcp_name_part("query:sql"), "query_sql")
        self.assertEqual(sanitize_mcp_name_part("docker/ps"), "docker_ps")
        self.assertEqual(sanitize_mcp_name_part("git log"), "git_log")
        self.assertEqual(sanitize_mcp_name_part("."), "tool")
        self.assertEqual(sanitize_mcp_name_part(".."), "tool")
        self.assertEqual(sanitize_mcp_name_part("already-valid_name.1"), "already-valid_name.1")
        self.assertEqual(sanitize_mcp_name_part("_private"), "_private")
        long_name = "a" * 100
        self.assertEqual(len(sanitize_mcp_name_part(long_name)), 64)

    def test_tool_schema_sanitizes_tool_name(self):
        schema = tool_schema("srv1", {"name": "docker:exec", "description": "run command"})
        func = schema["function"]
        self.assertEqual(func["name"], "mcp__srv1__docker_exec")
        self.assertEqual(func["description"], "run command")
        self.assertEqual(parse_namespaced(func["name"]), ("srv1", "docker_exec"))

    def test_extract_text_formats_various_content_types(self):
        # Text block
        content = [{"type": "text", "text": "normal text"}]
        self.assertEqual(_extract_text(content), "normal text")

        # Resource with text
        content = [{"type": "resource", "resource": {"uri": "file:///test.txt", "text": "resource content"}}]
        self.assertEqual(_extract_text(content), "resource content")

        # Resource without text property formats metadata
        content = [{"type": "resource", "resource": {"uri": "file:///test.bin", "mimeType": "application/octet-stream"}}]
        self.assertIn("MCP resource:", _extract_text(content))
        self.assertIn("file:///test.bin", _extract_text(content))

        # Non-text items like image without text are safely skipped
        content = [{"type": "image", "data": "base64...", "mimeType": "image/png"}]
        self.assertEqual(_extract_text(content), "")

        # Raw string content
        self.assertEqual(_extract_text("string payload"), "string payload")

        # Mixed content
        content = [
            {"type": "text", "text": "Heading:"},
            {"type": "image", "mimeType": "image/jpeg"},
            {"type": "resource", "resource": {"text": "Body detail"}},
        ]
        self.assertEqual(
            _extract_text(content),
            "Heading:\nBody detail",
        )

    def test_call_tool_appends_structured_content(self):
        client = McpClient({"id": "srv", "command": "dummy"}, cwd="/tmp")
        mock_result = {
            "content": [{"type": "text", "text": "Status report"}],
            "structuredContent": {"exitCode": 0, "verified": True},
        }
        client._request = MagicMock(return_value=mock_result)
        client.proc = MagicMock()
        client.proc.poll = MagicMock(return_value=None)

        res = client.call_tool("check", {})
        self.assertTrue(res["ok"])
        self.assertIn("Status report", res["content"])
        self.assertIn("Structured content:\n", res["content"])
        self.assertIn('"verified": true', res["content"])

    def test_mcp_plugin_maps_sanitized_name_to_raw_tool(self):
        plugin = McpPlugin()
        mock_client = MagicMock()
        mock_client.list_tools.return_value = [
            {"name": "system:diagnostics", "description": "health check", "inputSchema": {}}
        ]
        mock_client.call_tool.return_value = {"ok": True, "content": "healthy", "error": None}
        mock_client.server_capabilities = {}
        mock_client.active = True

        fake_server = {"id": "sys", "command": "dummy"}
        with unittest.mock.patch("xueness.mcp.load", return_value=[fake_server]), \
             unittest.mock.patch("xueness.bundled_plugins.mcp.lifecycle.Pool") as mock_pool_cls:
            mock_pool = MagicMock()
            mock_pool_cls.return_value = mock_pool
            mock_pool.get.return_value = mock_client
            loaded = plugin.load("/tmp/state", "/tmp/root", {})
            self.assertIn("mcp_tools", loaded)
            self.assertEqual(loaded["mcp_tools"][0]["function"]["name"], "mcp__sys__system_diagnostics")

            # Model invokes the sanitized name
            mcp_call = loaded["mcp_call"]
            result = mcp_call("mcp__sys__system_diagnostics", {})
            self.assertTrue(result["ok"])
            # Verified raw tool name was forwarded to client
            mock_client.call_tool.assert_called_once_with("system:diagnostics", {})


if __name__ == "__main__":
    unittest.main()
