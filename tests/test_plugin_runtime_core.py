"""Persisted plugin policy is enforced at the core execution boundary."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import Gate, Store, run


class CaptureProvider:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete(self, messages, tools):
        self.calls.append((messages, tools))
        return self.responses.pop(0)


class PluginRuntimeCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.store = Store(self.base / "state")

    @staticmethod
    def _tool_names(schemas):
        return {item["function"]["name"] for item in schemas}

    def test_bundled_defaults_keep_existing_base_tool_surface(self):
        from xueness.plugin_runtime import active_tool_names, is_enabled

        expected = {"read", "list", "glob", "grep", "write", "edit",
                    "exec", "todo_read", "todo_write", "ask_user"}
        self.assertTrue(expected.issubset(active_tool_names(self.store.directory)))
        for plugin_id in ("files", "shell", "planning", "skills", "hooks",
                          "mcp", "subagents", "memory"):
            self.assertTrue(is_enabled(self.store.directory, plugin_id), plugin_id)

    def test_disabled_files_plugin_hides_schemas_and_blocks_direct_model_call(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("try to write", self.root)
        set_enabled(self.store.directory, "files", False)
        provider = CaptureProvider([
            {"content": "", "tool_calls": [{
                "id": "call-write", "type": "function",
                "function": {"name": "write", "arguments": '{"path":"blocked.txt","content":"no"}'},
            }]},
        ])
        result = run(session, self.store, provider,
                     Gate(self.root, allow_write=True), max_steps=1)

        exposed = self._tool_names(provider.calls[0][1])
        self.assertNotIn("write", exposed)
        self.assertNotIn("read", exposed)
        self.assertEqual(result["results"]["call-write"]["error"], "plugin disabled")
        self.assertFalse((self.root / "blocked.txt").exists())

    def test_disabled_workflows_hides_and_blocks_contributed_model_tools(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("inspect a workflow", self.root)
        set_enabled(self.store.directory, "workflows", False)
        provider = CaptureProvider([{"content": "", "tool_calls": [{
            "id": "workflow-status", "type": "function", "function": {
                "name": "workflow_status", "arguments": '{"workflow_id":"' + 'a'*32 + '"}'}}
        ]}])
        result = run(session, self.store, provider, Gate(self.root), max_steps=1)
        self.assertNotIn("workflow_status", self._tool_names(provider.calls[0][1]))
        self.assertEqual(result["results"]["workflow-status"]["error"], "plugin disabled")

    def test_disabling_files_during_provider_call_blocks_returned_write(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("try to write", self.root)

        class Provider(CaptureProvider):
            def complete(self, messages, tools):
                self.calls.append((messages, tools))
                # Simulate a settings change after schema publication but before
                # the model's tool call reaches core dispatch.
                set_enabled(self_state_dir, "files", False)
                return {"content": "", "tool_calls": [{
                    "id": "racing-write", "type": "function",
                    "function": {"name": "write", "arguments": '{"path":"race.txt","content":"no"}'},
                }]}

        provider = Provider([])
        self_state_dir = self.store.directory
        result = run(session, self.store, provider,
                     Gate(self.root, allow_write=True), max_steps=1)

        self.assertIn("write", self._tool_names(provider.calls[0][1]))
        self.assertEqual(result["results"]["racing-write"]["error"], "plugin disabled")
        self.assertFalse((self.root / "race.txt").exists())

    def test_optional_callbacks_cannot_bypass_disable_during_provider_call(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("attempt extensions", self.root)
        invoked = []

        class Provider(CaptureProvider):
            def complete(self, messages, tools):
                self.calls.append((messages, tools))
                names = PluginRuntimeCoreTests._tool_names(tools)
                self.asserted = {"skill_read", "task", "mcp__srv__lookup"} <= names
                for plugin in ("skills", "mcp", "subagents"):
                    set_enabled(self_state_dir, plugin, False)
                return {"content": "", "tool_calls": [
                    {"id": "skill", "type": "function", "function":
                     {"name": "skill_read", "arguments": '{"id":"s"}'}},
                    {"id": "mcp", "type": "function", "function":
                     {"name": "mcp__srv__lookup", "arguments": "{}"}},
                    {"id": "task", "type": "function", "function":
                     {"name": "task", "arguments": '{"prompt":"do work"}'}},
                ]}

        provider = Provider([])
        self_state_dir = self.store.directory
        result = run(session, self.store, provider, Gate(self.root), max_steps=1,
                     skill_reader=lambda _sid: invoked.append("skill"),
                     mcp_tools=[{"type": "function", "function":
                                 {"name": "mcp__srv__lookup"}}],
                     mcp_call=lambda *_args: invoked.append("mcp"),
                     subagents=[{"id": "agent"}])

        self.assertTrue(provider.asserted)
        self.assertEqual(invoked, [])
        self.assertEqual([result["results"][key]["error"]
                          for key in ("skill", "mcp", "task")],
                         ["plugin disabled"] * 3)

    def test_disabled_modules_strip_injected_callbacks_and_context(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("plain reply", self.root)
        hits = []

        class Hooks:
            def fire(self, *_args):
                hits.append("hooks")
                raise AssertionError("disabled hooks were invoked")

        class Provider(CaptureProvider):
            def complete(self, messages, tools):
                super().complete(messages, tools)
                return {"content": "done"}

        provider = Provider([{"content": "done"}])
        for plugin in ("files", "shell", "planning", "skills", "hooks",
                       "mcp", "subagents", "memory"):
            set_enabled(self.store.directory, plugin, False)
        run(session, self.store, provider, Gate(self.root), max_steps=1,
            memory="private memory", skills="private skills", hooks=Hooks(),
            skill_reader=lambda _sid: hits.append("skill_read"),
            mcp_tools=[{"type": "function", "function": {"name": "mcp__x__y"}}],
            mcp_call=lambda *_args: hits.append("mcp"),
            subagents=[{"id": "agent"}])

        messages, schemas = provider.calls[0]
        self.assertNotIn("private memory", str(messages))
        self.assertNotIn("private skills", str(messages))
        names = self._tool_names(schemas)
        self.assertFalse({"skill_read", "task", "mcp__x__y"} & names)
        self.assertEqual(hits, [])

    def test_core_preview_compatibility_wrappers_forward_legacy_globals(self):
        from xueness import core

        target = self.root / "note.txt"
        target.write_text("abcdef", encoding="utf-8")
        with patch("xueness.core.MAX_FILE_PREVIEW", 3):
            preview = core.workspace_preview(self.root, "note.txt")
        self.assertEqual(preview["text"], "abc")
        self.assertTrue(preview["truncated"])

        custom = {".txt": ("text/plain", 100)}
        with patch("xueness.core.BINARY_PREVIEW_SUFFIXES", custom):
            binary = core.workspace_binary_preview(self.root, "note.txt")
        self.assertEqual(binary["embed"]["mime"], "text/plain")

        with patch("xueness.core.path_in", side_effect=PermissionError("blocked")):
            with self.assertRaises(PermissionError):
                core.workspace_preview(self.root, "note.txt")

    def test_contributed_tool_context_is_scoped_to_core_dispatch(self):
        from xueness import core
        from xueness.tool_contract import get_context

        session = self.store.new("read", self.root)
        provider = CaptureProvider([{"content": "", "tool_calls": [{
            "id": "read-context", "type": "function",
            "function": {"name": "read", "arguments": '{"path":"."}'},
        }]}])
        class Registry:
            def list(self, _session_id):
                return []

        registry = Registry()
        seen = []

        def handler(*_args):
            context = get_context()
            seen.append((context.store, context.state_dir, context.registry))
            return {"ok": True}

        with patch("xueness.core.dispatch", side_effect=handler):
            run(session, self.store, provider, Gate(self.root), max_steps=1,
                registry=registry)
        self.assertEqual(seen, [(self.store, self.store.directory, registry)])
        with self.assertRaisesRegex(ValueError, "active harness context"):
            get_context()

    def test_provider_stream_saves_deltas_then_final_and_separates_usage(self):
        session = self.store.new("stream response", self.root)
        observed = []

        class StreamProvider:
            model = "usage-fixture-model"
            protocol = "anthropic"

            def stream(self, messages, tools, on_delta=None):
                on_delta("Hello ")
                on_delta("there")
                return {"content": "Hello there", "_usage": {"input_tokens": 8,
                                                                     "output_tokens": 2},
                        "_cost": 0.001}

        def on_event(event):
            if event["type"] == "assistant_delta":
                saved = self.store.load(session["id"])
                observed.append((event["text"], saved.get("streaming", {}).get("text")))

        result = run(session, self.store, StreamProvider(), Gate(self.root),
                     max_steps=1, on_event=on_event)

        self.assertEqual(observed, [("Hello ", "Hello "), ("there", "Hello there")])
        self.assertNotIn("streaming", result)
        self.assertEqual(result["provider_usage"][0]["usage"],
                         {"input_tokens": 8, "output_tokens": 2})
        self.assertEqual(result["provider_usage"][0]["cost"], 0.001)
        self.assertEqual(result["provider_usage"][0]["model"], "usage-fixture-model")
        self.assertEqual(result["provider_usage"][0]["protocol"], "anthropic")
        self.assertNotIn("_usage", str(result["messages"][-1]))

    def test_completed_stream_is_archived_for_delta_replay(self):
        session = self.store.new("stream response", self.root)

        class StreamProvider:
            def stream(self, messages, tools, on_delta=None):
                on_delta("replay me")
                return {"content": "replay me"}

        result = run(session, self.store, StreamProvider(), Gate(self.root), max_steps=1)

        self.assertNotIn("streaming", result)
        self.assertEqual(len(result["stream_history"]), 1)
        archived = result["stream_history"][0]
        self.assertEqual(archived["status"], "completed")
        self.assertEqual(archived["text"], "replay me")
        self.assertFalse(archived["truncated"])
        self.assertEqual(archived["final_message_index"], len(result["messages"]) - 1)
        self.assertEqual(archived["id"], result["stream_history"][0]["id"])

    def test_stop_during_provider_delta_persists_interrupted_partial(self):
        session = self.store.new("stop during stream", self.root)
        stop = {"value": False}

        class StreamProvider:
            def stream(self, messages, tools, on_delta=None):
                on_delta("partial answer")
                return {"content": "partial answer"}

        def on_event(event):
            if event["type"] == "assistant_delta":
                stop["value"] = True

        result = run(session, self.store, StreamProvider(), Gate(self.root),
                     max_steps=1, should_stop=lambda: stop["value"], on_event=on_event)

        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["streaming"]["text"], "partial answer")
        self.assertTrue(result["streaming"]["interrupted"])
        self.assertEqual(result["streaming"]["status"], "interrupted")
        self.assertFalse(any(message.get("role") == "assistant"
                             and message.get("content") == "partial answer"
                             for message in result["messages"]))

    def test_provider_switch_is_rechecked_before_each_provider_request(self):
        from xueness.plugin_runtime import set_enabled

        session = self.store.new("keep going", self.root)
        provider = CaptureProvider([{"content": "", "tool_calls": [{
            "id": "todo", "type": "function", "function":
            {"name": "todo_read", "arguments": "{}"}}]}, {"content": "must not be requested"}])
        original = provider.complete
        def first_then_disable(messages, tools):
            response = original(messages, tools)
            set_enabled(self.store.directory, "providers", False)
            return response
        provider.complete = first_then_disable
        result = run(session, self.store, provider, Gate(self.root), max_steps=2)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(result["status"], "paused")
        self.assertEqual(result["pause_reason"], "providers plugin disabled")


if __name__ == "__main__":
    unittest.main()
