"""The builtin tool registry: the typed seam behind ``core.execute``.

These tests pin the properties that justify extracting the base tool table and
dispatch out of ``core.py`` into :mod:`xueness.builtin_tools`:

* every advertised schema is backed by a handler, and every handler is reachable
  by name -- schema and dispatch cannot drift apart;
* ``run`` actually routes through the registry (not a private if/elif chain), so
  a registered tool is what executes;
* policy is unchanged: an unknown name is denied, plan mode denies mutations
  before any approval, and deny-by-default holds for write/exec/edit;
* the registry stays a *static* table -- there is no dynamic import or ``eval``
  of data, so a crafted tool name cannot become arbitrary code execution;
* the legacy ``core.TOOLS`` / ``core.KNOWN_TOOLS`` surface is preserved.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import builtin_tools
from xueness.builtin_tools import (REGISTRY, REGISTRY_BY_NAME, dispatch,
                                   tool_schemas)
from xueness.core import Gate, Store, TOOLS, KNOWN_TOOLS, execute, run


class _ScriptedProvider:
    """Emit a fixed list of tool calls, then a verified completion."""

    def __init__(self, calls):
        self.calls = list(calls)
        self.n = 0
        self.tools = None

    def complete(self, messages, tools):
        self.tools = tools
        if self.n < len(self.calls):
            call = self.calls[self.n]
            self.n += 1
            return {"content": "", "tool_calls": [call]}
        return {"content": json.dumps({"summary": "done", "evidence": []})}


def _call(call_id, name, **args):
    return {"id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


class RegistryInvariantTests(unittest.TestCase):
    def test_every_schema_has_a_handler_and_round_trips_by_name(self):
        for tool in REGISTRY:
            self.assertTrue(callable(tool.handler), tool.name)
            self.assertIs(REGISTRY_BY_NAME[tool.name], tool)
            schema = tool.schema()["function"]
            self.assertEqual(schema["name"], tool.name)
            self.assertEqual(set(schema["parameters"]["required"]), set(tool.required))
            self.assertFalse(schema["parameters"]["additionalProperties"])

    def test_schemas_are_derived_from_the_registry(self):
        names = [t["function"]["name"] for t in tool_schemas()]
        self.assertEqual(names, [tool.name for tool in REGISTRY])
        # No tool is advertised without a dispatch entry.
        self.assertEqual(set(names), set(REGISTRY_BY_NAME))

    def test_registry_is_static_no_dynamic_import_or_eval(self):
        """A registry entry is a value, not a module path resolved from data.

        Checked on the parsed AST, not raw source, so a comment or docstring that
        merely *names* a banned construct cannot fail (or hide) the check.
        """
        import ast

        tree = ast.parse(Path(builtin_tools.__file__).read_text(encoding="utf-8"))
        banned_calls = {"eval", "exec", "__import__", "compile"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name, {"importlib", "runpy"},
                                     "%s would make the registry a code-loading seam" % alias.name)
            if isinstance(node, ast.ImportFrom):
                self.assertNotIn((node.module or "").split(".")[0], {"importlib", "runpy"})
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, banned_calls,
                                 "%s() would make the registry a code-loading seam" % node.func.id)
        for tool in REGISTRY:
            self.assertNotIn(".", tool.name, "a dotted name implies module loading")
            self.assertIn(callable(tool.handler), (True,),
                          "handlers must be plain callables, not loaders")

    def test_registry_contains_all_base_tools_and_plugin_contributions(self):
        base_tools = {"read", "list", "glob", "grep", "write", "edit",
                      "exec", "todo_read", "todo_write", "ask_user"}
        self.assertTrue(base_tools.issubset(REGISTRY_BY_NAME))
        self.assertEqual(len(REGISTRY), len(REGISTRY_BY_NAME), "tool names remain globally unique")
        from xueness.plugin_runtime import tool_owner
        for name in set(REGISTRY_BY_NAME) - base_tools:
            self.assertIsNotNone(tool_owner(name), name)


class CompatibilityTests(unittest.TestCase):
    def test_core_tools_matches_registry_schemas(self):
        self.assertEqual(TOOLS, tool_schemas())

    def test_core_known_tools_is_base_tools_plus_mcp(self):
        self.assertEqual(KNOWN_TOOLS, tuple(tool.name for tool in REGISTRY) + ("mcp",))

    def test_execute_is_a_thin_wrapper_over_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sentinel = {"ok": True, "via": "dispatch"}
            # core binds dispatch into its own namespace; patch that binding.
            with patch("xueness.core.dispatch", return_value=sentinel) as spy:
                out = execute(root, Gate(root), "list", {"path": "."})
            self.assertEqual(out, sentinel)
            spy.assert_called_once()
            self.assertEqual(spy.call_args.args[2], "list")


class DispatchTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.base = Path(holder.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)

    def test_registered_tool_path_executes_the_registered_handler(self):
        """A tool registered in the table is what dispatch actually runs."""
        (self.workspace / "f.txt").write_text("hello")
        seen = {}

        original = REGISTRY_BY_NAME["read"].handler

        def spy(root, gate, args, session, call_id):
            seen["called"] = args.get("path")
            return original(root, gate, args, session, call_id)

        with patch.object(REGISTRY_BY_NAME["read"], "handler", spy):
            out = dispatch(self.workspace, Gate(self.workspace), "read", {"path": "f.txt"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["output"], "hello")
        self.assertEqual(seen["called"], "f.txt")

    def test_unknown_tool_is_denied_not_executed(self):
        out = dispatch(self.workspace, Gate(self.workspace), "delete_everything", {})
        self.assertFalse(out["ok"])

    def test_remote_session_denies_local_tools_and_unbound_connections(self):
        remote = {"id": "lab", "digest": "a" * 64}
        local = dispatch(self.workspace, Gate(self.workspace), "read",
                         {"path": "secret.txt"}, {"remote_connection": remote})
        self.assertFalse(local["ok"])
        self.assertEqual(local["error"], "denied")
        self.assertEqual(local["error_code"], "permission_denied")
        self.assertFalse(local["awaiting_approval"])
        self.assertFalse(local["retryable"])
        wrong_remote = dispatch(self.workspace, Gate(self.workspace), "remote_exec", {
            "connection": "other", "connection_digest": "b" * 64,
            "argv": ["pwd"],
        }, {"remote_connection": remote})
        self.assertFalse(wrong_remote["ok"])
        self.assertEqual(wrong_remote["error"], "denied")
        self.assertEqual(wrong_remote["error_code"], "permission_denied")
        self.assertFalse(wrong_remote["awaiting_approval"])
        self.assertFalse(wrong_remote["retryable"])

    def test_remote_run_does_not_advertise_local_file_or_shell_tools(self):
        from xueness.plugin_runtime import set_enabled

        set_enabled(self.state, "remote", True)
        session = self.store.new("inspect remote target", self.workspace)
        session["remote_connection"] = {"id": "lab", "digest": "a" * 64}
        self.store.save(session)
        provider = _ScriptedProvider([_call("local-read", "read", path="secret.txt")])
        out = run(session, self.store, provider, Gate(self.workspace), max_steps=2)
        offered = {tool["function"]["name"] for tool in provider.tools}
        self.assertIn("remote_exec", offered)
        self.assertIn("ask_user", offered)
        self.assertNotIn("read", offered)
        self.assertNotIn("exec", offered)
        refusal = out["results"]["local-read"]
        self.assertFalse(refusal["ok"])
        self.assertEqual(refusal["error"], "denied")
        self.assertEqual(refusal["error_code"], "permission_denied")
        self.assertFalse(refusal["awaiting_approval"])
        self.assertFalse(refusal["retryable"])
        self.assertEqual(out["status"], "needs_review")
        self.assertEqual(out["steps"], 1)

    def test_unknown_name_cannot_reach_registry_via_prefix_tricks(self):
        for name in ("", "read.__class__", "core.read", "mcp__srv__echo"):
            out = dispatch(self.workspace, Gate(self.workspace), name, {})
            self.assertFalse(out["ok"], name)

    def test_tool_call_id_is_stripped_before_the_handler(self):
        (self.workspace / "f.txt").write_text("x")
        gate = Gate(self.workspace)
        out = dispatch(self.workspace, gate, "read", {"path": "f.txt", "_tool_call_id": "c9"})
        self.assertTrue(out["ok"])
        # The smuggled control key must never leak into a result.
        self.assertNotIn("_tool_call_id", json.dumps(out))

    def test_plan_mode_denies_mutations_before_approval(self):
        gate = Gate(self.workspace, allow_write=True, allow_exec=True, mode="plan")
        for name, args in (("write", {"path": "x.txt", "content": "b"}),
                           ("edit", {"path": "x.txt", "old": "a", "new": "b"}),
                           ("exec", {"argv": ["python3", "-c", "print(1)"]})):
            out = dispatch(self.workspace, gate, name, args)
            self.assertFalse(out["ok"], name)
            self.assertEqual(out["error"], "denied", name)
        # Read-only tools still work in plan mode.
        self.assertTrue(dispatch(self.workspace, gate, "glob", {"pattern": "*.txt"})["ok"])

    def test_deny_by_default_without_approval(self):
        gate = Gate(self.workspace)
        self.assertEqual(dispatch(self.workspace, gate, "write",
                                  {"path": "x", "content": "y"})["error"], "denied")
        self.assertEqual(dispatch(self.workspace, gate, "exec",
                                  {"argv": ["python3", "-V"]})["error"], "denied")
        self.assertTrue(dispatch(self.workspace, gate, "list", {"path": "."})["ok"])

    def test_path_escape_denied_for_every_path_tool(self):
        gate = Gate(self.workspace, allow_write=True)
        for name, args in (("read", {"path": "../outside"}),
                           ("list", {"path": "../outside"}),
                           ("write", {"path": "../escape", "content": "x"}),
                           ("glob", {"path": "../outside", "pattern": "*.txt"}),
                           ("grep", {"path": "../outside", "pattern": "a"})):
            out = dispatch(self.workspace, gate, name, args)
            self.assertFalse(out["ok"], name)


class RunUsesRegistryTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.base = Path(holder.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)

    def test_run_dispatches_through_the_registry(self):
        """``run`` must route a base tool call to its registered handler."""
        (self.workspace / "seen.txt").write_text("registry")
        provider = _ScriptedProvider([_call("c1", "read", path="seen.txt")])
        session = self.store.new("t", self.workspace)
        original = REGISTRY_BY_NAME["read"].handler
        calls = []

        def spy(root, gate, args, session_, call_id):
            calls.append(args.get("path"))
            return original(root, gate, args, session_, call_id)

        with patch.object(REGISTRY_BY_NAME["read"], "handler", spy):
            run(session, self.store, provider, Gate(self.workspace), max_steps=2)
        self.assertEqual(calls, ["seen.txt"], "run bypassed the tool registry")
        result = session["results"]["c1"]
        self.assertTrue(result["ok"])
        self.assertEqual(result["output"], "registry")

    def test_run_offers_exactly_the_registry_schemas(self):
        provider = _ScriptedProvider([])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        from xueness.plugin_runtime import tool_schemas as enabled_tool_schemas
        self.assertEqual(provider.tools, enabled_tool_schemas(self.store.directory))

    def test_run_denies_an_unregistered_tool_call(self):
        provider = _ScriptedProvider([_call("c1", "rm_rf", path="/")])
        session = self.store.new("t", self.workspace)
        run(session, self.store, provider, Gate(self.workspace, allow_write=True), max_steps=2)
        self.assertFalse(session["results"]["c1"]["ok"])
        self.assertEqual(session["results"]["c1"]["error"], "ValueError")


if __name__ == "__main__":
    unittest.main()
