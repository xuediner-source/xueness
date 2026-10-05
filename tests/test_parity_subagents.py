"""Parity regression tests for subagents (matching ZCode core/src/subagent).

Tests that:
1. Built-in fallback profiles (general-purpose and explore) are available via select().
2. User-configured profiles with matching names take precedence over built-ins.
3. Unknown agent names still return None.
4. disallowedTools / disallowed_tools are enforced in provider tool filtering.
5. Child runner passes disallowed tools to Gate.denied_tool_names.
"""
import unittest
from unittest.mock import MagicMock, patch

from xueness.subagents import select, provider_with_agent_tools
from xueness.bundled_plugins.subagents.runner import run_subagent


class ParitySubagentsTests(unittest.TestCase):
    def test_built_in_general_purpose_profile(self):
        profile = select([], "general-purpose")
        self.assertIsNotNone(profile)
        self.assertEqual(profile["id"], "general-purpose")
        self.assertEqual(profile["name"], "general-purpose")
        self.assertEqual(profile["tools"], ["*"])

        profile_underscore = select([], "general_purpose")
        self.assertIsNotNone(profile_underscore)
        self.assertEqual(profile_underscore["id"], "general-purpose")

    def test_built_in_explore_profile(self):
        profile = select([], "explore")
        self.assertIsNotNone(profile)
        self.assertEqual(profile["id"], "explore")
        self.assertEqual(profile["name"], "explore")
        self.assertIn("read", profile["tools"])
        self.assertIn("grep", profile["tools"])
        self.assertIn("glob", profile["tools"])
        self.assertNotIn("exec", profile["tools"])

    def test_user_profile_overrides_builtin(self):
        user_explore = {"id": "explore", "name": "explore", "tools": ["read"], "custom": True}
        selected = select([user_explore], "explore")
        self.assertIs(selected, user_explore)
        self.assertTrue(selected.get("custom"))

        # Case-insensitive lookup must also hit the custom profile instead of built-in
        selected_case = select([user_explore], "Explore")
        self.assertIs(selected_case, user_explore)
        self.assertTrue(selected_case.get("custom"))

    def test_agent_tool_allowlist_pascal_case(self):
        from xueness.subagents import agent_tool_allowlist
        agent = {"tools": ["Read", "Glob", "WebSearch"]}
        allowed = agent_tool_allowlist(agent)
        self.assertIn("read", allowed)
        self.assertIn("glob", allowed)
        self.assertIn("web_search", allowed)

    def test_unknown_agent_returns_none(self):
        self.assertIsNone(select([], "arbitrary_unknown"))
        self.assertIsNone(select([{"id": "a", "name": "A"}], "b"))

    def test_disallowed_tools_filtering(self):
        class Provider:
            model = "test-model"
            def complete(self, messages, tools):
                return tools

        provider = Provider()
        agent = {
            "tools": ["read", "write", "exec", "bash"],
            "disallowedTools": ["Exec", "Bash(git *)"],
        }
        filtered = provider_with_agent_tools(provider, agent)
        schemas = [
            {"type": "function", "function": {"name": "read"}},
            {"type": "function", "function": {"name": "write"}},
            {"type": "function", "function": {"name": "exec"}},
            {"type": "function", "function": {"name": "bash"}},
        ]
        result = filtered.complete([], schemas)
        tool_names = [s["function"]["name"] for s in result]
        self.assertEqual(tool_names, ["read", "write"])
        self.assertNotIn("exec", tool_names)
        self.assertNotIn("bash", tool_names)

    def test_disallowed_tools_with_wildcard(self):
        class Provider:
            model = "test-model"
            def complete(self, messages, tools):
                return tools

        provider = Provider()
        agent = {
            "tools": ["*"],
            "disallowed_tools": ["write"],
        }
        filtered = provider_with_agent_tools(provider, agent)
        schemas = [
            {"type": "function", "function": {"name": "read"}},
            {"type": "function", "function": {"name": "write"}},
        ]
        result = filtered.complete([], schemas)
        tool_names = [s["function"]["name"] for s in result]
        self.assertEqual(tool_names, ["read"])

    def test_child_runner_gate_denies_disallowed_tools(self):
        observed = {}

        class DummyGate:
            root = "/tmp"
            disallow = ()
            def __init__(self, root, **kwargs):
                self.root = root
                self.allowed_tool_names = None
                self.denied_tool_names = None
                observed["gate"] = self

        def dummy_run(child, store, provider, gate, **kwargs):
            child["status"] = "completed"
            child["completion"] = {"summary": "done"}

        agent = {
            "id": "restricted",
            "name": "restricted",
            "tools": ["read", "grep"],
            "disallowedTools": ["grep"],
        }

        res = run_subagent(
            DummyGate("/tmp"), MagicMock(), [agent], "task prompt", "restricted",
            depth=0, max_depth=1, gate_class=DummyGate, run_fn=dummy_run,
            base_system="system", max_steps=1, summary_max=100,
        )
        self.assertTrue(res["ok"])
        gate = observed["gate"]
        self.assertIn("grep", gate.denied_tool_names)
        self.assertEqual(gate.allowed_tool_names, frozenset({"read"}))


if __name__ == "__main__":
    unittest.main()
