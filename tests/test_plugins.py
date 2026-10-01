"""The capability plugin seam: one loader both callers share.

Before this, web.py and cli.py each hand-wired skills/hooks/MCP/sub-agents.
The MCP block was near-identical in both, so a fix to one could silently miss
the other -- the same duplication that once let two KNOWN_TOOLS copies disagree.

These tests pin the properties that make the seam worth having: deny-by-default
is the caller's explicit list, a broken resource degrades instead of raising, and
MCP subprocesses are always reaped.
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import plugins


class RegistryTests(unittest.TestCase):
    def test_registry_covers_every_opt_in_capability(self):
        self.assertEqual(set(plugins.PLUGINS),
                         {"skills", "hooks", "subagents", "mcp"})

    def test_every_plugin_declares_its_resource_kind(self):
        for name, cls in plugins.PLUGINS.items():
            self.assertTrue(cls.kind, "%s must declare a kind" % name)

    def test_activation_with_no_names_loads_nothing(self):
        act = plugins.activate([], Path("/nonexistent"), Path("/nonexistent"), {})
        self.assertEqual(act.kwargs, {})
        act.close()

    def test_unknown_name_is_skipped_not_fatal(self):
        """A typo must neither abort the run nor grant the capability."""
        act = plugins.activate(["nope"], Path("/nonexistent"), Path("/nonexistent"), {})
        self.assertEqual(act.kwargs, {})
        act.close()

    def test_duplicate_names_load_once(self):
        calls = []

        class Counting(plugins.Plugin):
            kind = "counting"

            def load(self, state_dir, root, session):
                calls.append(1)
                return {}

        with patch.dict(plugins.PLUGINS, {"counting": Counting}):
            act = plugins.activate(["counting", "counting"], Path("/x"), Path("/x"), {})
            act.close()
        self.assertEqual(len(calls), 1, "a capability listed twice must load once")


class DegradationTests(unittest.TestCase):
    def test_a_failing_plugin_does_not_raise(self):
        class Boom(plugins.Plugin):
            kind = "boom"

            def load(self, state_dir, root, session):
                raise RuntimeError("bad resource file")

        with patch.dict(plugins.PLUGINS, {"boom": Boom}):
            act = plugins.activate(["boom"], Path("/x"), Path("/x"), {})
            self.assertEqual(act.kwargs, {})
            act.close()

    def test_a_failing_plugin_does_not_block_a_healthy_one(self):
        """One bad plugin must not silently disable the others in the list."""
        got = {}

        class Good(plugins.Plugin):
            kind = "good"

            def load(self, state_dir, root, session):
                return {"good": True}

        class Bad(plugins.Plugin):
            kind = "bad"

            def load(self, state_dir, root, session):
                raise RuntimeError("nope")

        with patch.dict(plugins.PLUGINS, {"good": Good, "bad": Bad}):
            act = plugins.activate(["bad", "good"], Path("/x"), Path("/x"), {})
            got = dict(act.kwargs)
            act.close()
        self.assertEqual(got, {"good": True})

    def test_partially_loaded_plugin_is_torn_down_immediately(self):
        torn = []

        class Partial(plugins.Plugin):
            kind = "partial"

            def load(self, state_dir, root, session):
                raise RuntimeError("failure after acquisition")

            def teardown(self):
                torn.append("released")

        with patch.dict(plugins.PLUGINS, {"partial": Partial}):
            act = plugins.activate(["partial"], Path("/x"), Path("/x"), {})
            self.assertEqual(act.kwargs, {})
            act.close()
        self.assertEqual(torn, ["released"])

    def test_teardown_runs_even_after_a_later_plugin_fails(self):
        torn = []

        class First(plugins.Plugin):
            kind = "first"

            def load(self, state_dir, root, session):
                return {}

            def teardown(self):
                torn.append("first")

        class Second(plugins.Plugin):
            kind = "second"

            def load(self, state_dir, root, session):
                raise RuntimeError("boom")

        with patch.dict(plugins.PLUGINS, {"first": First, "second": Second}):
            act = plugins.activate(["first", "second"], Path("/x"), Path("/x"), {})
            act.close()
        self.assertEqual(torn, ["first"], "an acquired plugin must still be released")


class ContextManagerTests(unittest.TestCase):
    def test_context_manager_closes_on_exception(self):
        torn = []

        class Holder(plugins.Plugin):
            kind = "holder"

            def load(self, state_dir, root, session):
                return {}

            def teardown(self):
                torn.append(1)

        with patch.dict(plugins.PLUGINS, {"holder": Holder}):
            with self.assertRaises(ValueError):
                with plugins.activate(["holder"], Path("/x"), Path("/x"), {}) as act:
                    self.assertIn("__enter__", dir(act))
                    raise ValueError("run failed")
        self.assertEqual(torn, [1], "a failed run must not leak the plugin")


class RealPluginTests(unittest.TestCase):
    """Exercise the real classes against a real state directory layout."""

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.state = base / "state"
        self.root = base / "ws"
        self.state.mkdir(parents=True)
        self.root.mkdir(parents=True)

    def _write(self, kind, filename, payload):
        d = self.state / "resources" / kind
        d.mkdir(parents=True, exist_ok=True)
        (d / filename).write_text(json.dumps(payload), encoding="utf-8")

    def test_hooks_plugin_returns_a_runner(self):
        self._write("hooks", "h.json", {
            "id": "h", "event": "Stop", "enabled": True,
            "command": sys.executable, "args": ["-c", "pass"]})
        act = plugins.activate(["hooks"], self.state, self.root, {})
        self.assertIsNotNone(act.kwargs.get("hooks"))
        act.close()

    def test_subagents_plugin_returns_agents(self):
        self._write("subagents", "a.json", {
            "id": "a", "name": "alpha", "enabled": True, "prompt": "do things"})
        act = plugins.activate(["subagents"], self.state, self.root, {})
        self.assertEqual([a["id"] for a in act.kwargs.get("subagents") or []], ["a"])
        act.close()

    def test_skills_plugin_returns_none_when_empty(self):
        """An empty store must not pay header-only context cost."""
        act = plugins.activate(["skills"], self.state, self.root, {})
        self.assertIsNone(act.kwargs.get("skills"))
        act.close()

    def test_mcp_plugin_with_no_servers_adds_no_tools(self):
        act = plugins.activate(["mcp"], self.state, self.root, {})
        self.assertNotIn("mcp_tools", act.kwargs)
        act.close()

    def test_mcp_plugin_teardown_is_idempotent(self):
        act = plugins.activate(["mcp"], self.state, self.root, {})
        act.close()
        act.close()  # a double close must not raise

    def test_mcp_plugin_reaps_client_if_list_tools_raises(self):
        started = []

        class BrokenClient:
            def __init__(self, server, *, cwd, **kw):
                started.append(server["id"])

            def start(self):
                pass

            def list_tools(self):
                raise RuntimeError("broken list_tools")

            def close(self):
                started.pop()

        self._write("mcp", "srv.json", {
            "id": "srv", "enabled": True,
            "command": sys.executable, "args": ["-c", "pass"]})
        with patch("xueness.mcp.McpClient", BrokenClient):
            act = plugins.activate(["mcp"], self.state, self.root, {})
            self.assertNotIn("mcp_tools", act.kwargs)
            self.assertEqual(started, [])
            act.close()
        self.assertEqual(started, [])

    def test_mcp_plugin_closes_clients_without_usable_tools(self):
        started = []

        class EmptyClient:
            def __init__(self, server, *, cwd, **kw):
                started.append(server["id"])

            def start(self):
                pass

            def list_tools(self):
                return []

            def close(self):
                started.pop()

        self._write("mcp", "srv.json", {
            "id": "srv", "enabled": True,
            "command": sys.executable, "args": ["-c", "pass"]})
        with patch("xueness.mcp.McpClient", EmptyClient):
            act = plugins.activate(["mcp"], self.state, self.root, {})
            self.assertNotIn("mcp_tools", act.kwargs)
            self.assertEqual(started, [])
            act.close()

    def test_mcp_plugin_closes_clients_it_started(self):
        """The leak this seam prevents: one child process per connected server."""
        started = []

        class FakeClient:
            def __init__(self, server, *, cwd, **kw):
                self.server = server
                started.append(server["id"])
                self.closed = False

            def start(self):
                return None

            def list_tools(self):
                return [{"name": "echo", "description": "e",
                         "inputSchema": {"type": "object", "properties": {}}}]

            def call_tool(self, name, arguments):
                return {"ok": True}

            def close(self):
                self.closed = True
                started.remove(self.server["id"])

        self._write("mcp", "srv.json", {
            "id": "srv", "enabled": True,
            "command": sys.executable, "args": ["-c", "pass"]})

        with patch("xueness.mcp.McpClient", FakeClient):
            act = plugins.activate(["mcp"], self.state, self.root, {})
            self.assertIn("mcp_tools", act.kwargs)
            self.assertEqual(started, ["srv"], "the server should be running")
            act.close()
        self.assertEqual(started, [], "teardown must reap every client")


if __name__ == "__main__":
    unittest.main()
