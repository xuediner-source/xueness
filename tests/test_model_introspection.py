"""Read-only introspection tools: providers ``list_models`` and sessions ``read_state``.

Both are pure reads: no network request, no stored secret value, no writes.
The tests pin the registry hints (mutating False, concurrency_safe True), the
redacted summaries, the read-only Gate wiring and the disabled-owner boundary.
"""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate
from xueness.tool_contract import bind_execution
from xueness.tool_registry import REGISTRY_BY_NAME, dispatch

SECRET = "sk-introspection-secret-value-1"


class IntrospectionToolsTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "work"
        self.root.mkdir()
        self.state = self.base / "state"
        self.state.mkdir()
        providers = self.state / "providers"
        providers.mkdir()
        (providers / "main.json").write_text(json.dumps({
            "id": "main", "name": "Main", "baseUrl": "https://api.example.com/v1",
            "model": "test-model", "apiKey": SECRET, "protocol": "openai"}), encoding="utf-8")

    def call(self, name, args, session=None):
        gate = Gate(self.root, allow_write=False)
        with bind_execution(store=None, state_dir=self.state):
            return dispatch(self.root, gate, name, args, session)

    def test_registry_hints_declare_pure_reads(self):
        for name in ("list_models", "read_state"):
            tool = REGISTRY_BY_NAME[name]
            self.assertFalse(tool.mutating, name)
            self.assertTrue(tool.concurrency_safe, name)

    def test_list_models_summarizes_profiles_without_secrets(self):
        result = self.call("list_models", {}, session={
            "model_selection": {"provider_id": "main", "model": "test-model"}})
        self.assertTrue(result["ok"])
        profile = result["profiles"][0]
        self.assertEqual(profile["id"], "main")
        self.assertEqual(profile["model"], "test-model")
        self.assertTrue(profile["hasKey"])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result["current"]["provider_id"], "main")
        self.assertIn("操作者动作", result["note"])

    def test_list_models_without_configuration_reports_an_empty_summary(self):
        empty = self.base / "empty-state"
        empty.mkdir()
        gate = Gate(self.root, allow_write=False)
        with bind_execution(store=None, state_dir=empty):
            result = dispatch(self.root, gate, "list_models", {}, None)
        self.assertTrue(result["ok"])
        self.assertEqual(result["profiles"], [])
        self.assertIsNone(result["current"])

    def test_read_state_projects_the_current_session(self):
        session = {"id": "a" * 32, "status": "running", "mode": "build",
                   "permission_mode": "edit", "steps": 3, "title": "T",
                   "task": "do things",
                   "todos": [{"id": "1", "text": "x", "status": "pending"}],
                   "pending_question": None}
        result = self.call("read_state", {}, session=session)
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], "a" * 32)
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["steps"], 3)
        self.assertEqual(result["permissionMode"], "edit")
        self.assertEqual(result["todos"], session["todos"])
        self.assertFalse(result["pendingQuestion"])
        self.assertNotIn("messages", result)

    def test_read_state_caps_the_todo_projection(self):
        from xueness.bundled_plugins.sessions.tooling import READ_STATE_MAX_TODOS
        todos = [{"id": str(i), "text": "t%d" % i, "status": "pending"}
                 for i in range(READ_STATE_MAX_TODOS + 10)]
        result = self.call("read_state", {}, session={"todos": todos})
        self.assertEqual(len(result["todos"]), READ_STATE_MAX_TODOS)

    def test_read_state_without_a_session_fails_closed(self):
        result = self.call("read_state", {}, session=None)
        self.assertFalse(result["ok"])

    def test_disabled_owner_plugin_cannot_serve_the_tool(self):
        from xueness import plugin_runtime
        plugin_runtime.set_enabled(self.state, "sessions", False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, "sessions", True)
        result = self.call("read_state", {}, session={"id": "x"})
        self.assertEqual(result, {"ok": False, "error": "plugin disabled"})
        plugin_runtime.set_enabled(self.state, "providers", False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, "providers", True)
        result = self.call("list_models", {})
        self.assertEqual(result, {"ok": False, "error": "plugin disabled"})


if __name__ == "__main__":
    unittest.main()
