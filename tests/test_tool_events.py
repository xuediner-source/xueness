"""Tool event pipeline: before-deny, after-observe/rewrite, isolation, batches.

Aligned with the DeepSeek harness capability seams and ZCode's call runner:
every effective plugin observes a registry tool call before and after
execution; a manifest ``toolEvents`` declaration additionally grants a
structured deny (before) and a restricted result rewrite (after). The
pipeline can only tighten a decision, isolates callback failures, caps
callback time, and stays serial -- and results keep their call order --
even when the tool handlers themselves run in a concurrent batch. The hooks
plugin's PostToolUse integration is opt-in per hook and default-off.

All tests use an isolated state directory and injected fake handlers -- no
network, no real model.
"""
import contextlib
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.core import Gate, Store, run
from xueness.plugin_contract import tool_events_field_errors
from xueness.tool_registry import REGISTRY_BY_NAME


def _call(cid, name, **arguments):
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


class _ScriptedProvider:
    """Yields each scripted turn once, then a plain (unverified) answer."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.turns:
            return self.turns.pop(0)
        return {"content": "done"}


class _Serializer:
    """Flags any overlap between observed callback spans."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active = 0
        self.overlaps = 0

    @contextlib.contextmanager
    def span(self, label):
        with self._lock:
            if self._active:
                self.overlaps += 1
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1


class ToolEventTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.store = Store(base / "state")
        self.patches = []

    def tearDown(self):
        while self.patches:
            self.patches.pop().stop()

    def patch_callback(self, plugin_id, name, fn):
        module = plugin_runtime.entrypoint(plugin_id)
        self.patches.append(patch.object(module, name, fn, create=True))
        self.patches[-1].start()

    def declare_tool_events(self, events, priority=None):
        """Declare ``toolEvents`` on the hooks manifest for this test only."""
        manifests = plugin_runtime._manifests()
        declaration = {"events": list(events)}
        if priority is not None:
            declaration["priority"] = priority
        manifests["hooks"] = {**manifests["hooks"], "toolEvents": declaration}
        self.patches.append(patch.object(plugin_runtime, "_manifests",
                                         lambda: manifests))
        self.patches[-1].start()

    def replace_handler(self, name, handler):
        active = patch.object(REGISTRY_BY_NAME[name], "handler", handler)
        active.start()
        self.patches.append(active)

    def run_turn(self, provider, gate=None, **kwargs):
        session = self.store.new("tool-events", self.root)
        return run(session, self.store, provider, gate or Gate(self.root),
                   max_steps=6, **kwargs)

    def tool_message_order(self, session):
        return [message.get("tool_call_id") for message in session["messages"]
                if message.get("role") == "tool"]

    def diagnostics(self, session, kind, plugin="hooks"):
        return [entry for entry in (session.get("tool_event_diagnostics") or [])
                if entry.get("kind") == kind and entry.get("plugin") == plugin]

    # --- after event: observation and restricted rewrite ---------------------

    def test_after_event_observes_the_result_before_it_is_recorded(self):
        seen = []

        def observer(payload):
            seen.append(dict(payload))

        self.patch_callback("hooks", "after_tool_execution", observer)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path"),
                                           "content": "SECRET"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(1, len(seen))
        payload = seen[0]
        self.assertEqual("read", payload["tool"])
        self.assertEqual("r1", payload["tool_call_id"])
        self.assertEqual({"ok": True, "path": "a", "content": "SECRET"},
                         payload["result"])
        self.assertEqual(self.store.directory, payload["state_dir"])
        self.assertTrue(out["results"]["r1"]["ok"])
        # The observer saw the raw handler result; the host evidence alias is
        # bound afterwards, by the kernel alone.
        self.assertNotIn("evidence_id", payload["result"])

    def test_declared_after_event_can_rewrite_the_result(self):
        self.declare_tool_events(["after_tool_execution"])

        def rewriter(payload):
            self.assertEqual("r1", payload["tool_call_id"])
            rewritten = dict(payload["result"])
            rewritten["content"] = "[redacted]"
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", rewriter)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a",
                                           "content": "SECRET"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        tool_messages = [message for message in out["messages"]
                         if message.get("role") == "tool"]
        self.assertEqual(1, len(tool_messages))
        self.assertIn("[redacted]", tool_messages[0]["content"])
        self.assertNotIn("SECRET", tool_messages[0]["content"])
        # The rewrite keeps ok=True, so the host still binds the evidence alias.
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertIsNotNone(out["results"]["r1"].get("evidence_id"))
        self.assertEqual(1, len(self.diagnostics(out, "rewrite")))

    def test_undeclared_rewrite_is_rejected_and_recorded(self):
        # No toolEvents declaration: the same rewriter is now observation only.
        def rewriter(payload):
            rewritten = dict(payload["result"])
            rewritten["content"] = "[redacted]"
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", rewriter)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a",
                                           "content": "SECRET"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        tool_messages = [message for message in out["messages"]
                         if message.get("role") == "tool"]
        self.assertIn("SECRET", tool_messages[0]["content"])
        self.assertNotIn("[redacted]", tool_messages[0]["content"])
        rejected = self.diagnostics(out, "rewrite_rejected")
        self.assertEqual(1, len(rejected))
        self.assertIn("toolEvents", rejected[0]["detail"])

    def test_rewrite_cannot_flip_ok_in_either_direction(self):
        self.declare_tool_events(["after_tool_execution"])
        attempts = []

        def flipper(payload):
            attempts.append(payload["result"].get("ok"))
            rewritten = dict(payload["result"])
            rewritten["ok"] = not rewritten["ok"]
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", flipper)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual([True], attempts)
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertTrue(any("ok must stay unchanged" in item["detail"]
                            for item in self.diagnostics(out, "rewrite_rejected")))

        # The reverse direction is equally forbidden: a failure cannot be
        # promoted into a success, which would forge evidence.
        attempts.clear()

        def failing(r, g, a, s, c):
            raise ValueError("no such file")

        self.replace_handler("read", failing)

        def promoter(payload):
            rewritten = dict(payload["result"])
            rewritten["ok"] = True
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", promoter)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r2", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertFalse(out["results"]["r2"]["ok"])
        self.assertTrue(any("ok must stay unchanged" in item["detail"]
                            for item in self.diagnostics(out, "rewrite_rejected")))

    def test_rewrite_cannot_spoof_identity_or_break_json(self):
        self.declare_tool_events(["after_tool_execution"])

        def identity_thief(payload):
            rewritten = dict(payload["result"])
            rewritten["tool_call_id"] = "somebody-elses-call"
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", identity_thief)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertTrue(any("call identity must stay unchanged" in item["detail"]
                            for item in self.diagnostics(out, "rewrite_rejected")))
        self.assertEqual("r1", self.tool_message_order(out)[0])

        def unserialisable(payload):
            rewritten = dict(payload["result"])
            rewritten["content"] = {1, 2, 3}
            return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", unserialisable)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r2", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertTrue(any("JSON-serialisable" in item["detail"]
                            for item in self.diagnostics(out, "rewrite_rejected")))
        self.assertTrue(out["results"]["r2"]["ok"])

    # --- before event: structured deny, never a grant ------------------------

    def test_declared_before_event_can_deny_with_a_reason(self):
        self.declare_tool_events(["before_tool_execution"])
        handler_calls = []

        def spy(r, g, a, s, c):
            handler_calls.append(a.get("path"))
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", spy)

        def guard(payload):
            if payload["tool_call_id"] == "r2":
                return {"decision": "deny", "reason": "路径不在允许清单内"}
            return None

        self.patch_callback("hooks", "before_tool_execution", guard)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(["a"], handler_calls, "only the allowed call may run")
        denied = out["results"]["r2"]
        self.assertFalse(denied["ok"])
        self.assertEqual("denied by plugin hooks", denied["error"])
        self.assertEqual("plugin_denied", denied["error_code"])
        self.assertEqual("hooks", denied["plugin"])
        self.assertEqual("路径不在允许清单内", denied["user_reason"])
        self.assertEqual(1, len(self.diagnostics(out, "deny")))
        # The run is not halted: the provider saw the denial and answered again.
        self.assertEqual(2, provider.calls)

    def test_undeclared_deny_is_ignored_and_allow_is_inert(self):
        handler_calls = []

        def spy(r, g, a, s, c):
            handler_calls.append(a.get("path"))
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", spy)

        def denier(payload):
            return {"decision": "deny", "reason": "not declared, so ignored"}

        self.patch_callback("hooks", "before_tool_execution", denier)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(["a"], handler_calls)
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertEqual(1, len(self.diagnostics(out, "deny_ignored")))

        # An explicit "allow" is equally inert: the pipeline has no grant
        # channel, so the call simply proceeds through its own Gate checks.
        self.declare_tool_events(["before_tool_execution"])
        self.patch_callback("hooks", "before_tool_execution",
                            lambda payload: {"decision": "allow"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r2", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertIn("a", handler_calls)
        self.assertTrue(out["results"]["r2"]["ok"])

    def test_deny_without_a_usable_reason_is_ignored(self):
        self.declare_tool_events(["before_tool_execution"])
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path")})
        # A deny-shaped outcome without a usable reason is ignored explicitly.
        for bad in ({"decision": "deny"},
                    {"decision": "deny", "reason": "   "},
                    {"decision": "deny", "reason": 42}):
            self.patch_callback("hooks", "before_tool_execution",
                                lambda payload, bad=bad: bad)
            provider = _ScriptedProvider([
                {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
            ])
            out = self.run_turn(provider)
            self.assertTrue(out["results"]["r1"]["ok"], bad)
            self.assertEqual(1, len(self.diagnostics(out, "deny_ignored")), bad)
        # An unknown decision is not an intervention at all: no deny, no noise.
        self.patch_callback("hooks", "before_tool_execution",
                            lambda payload: {"decision": "DENY",
                                             "reason": "wrong case"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r2", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertTrue(out["results"]["r2"]["ok"])
        self.assertEqual([], self.diagnostics(out, "deny_ignored"))

    def test_pipeline_cannot_loosen_the_gate_in_plan_mode(self):
        # The pipeline has no allow channel, so even an explicit allow leaves
        # the handler's own Gate check in charge: plan mode still refuses the
        # write, and the deny seam simply never fires for an allowed call.
        self.declare_tool_events(["before_tool_execution"])
        self.patch_callback("hooks", "before_tool_execution",
                            lambda payload: {"decision": "allow"})

        def gated_write(r, g, a, s, c):
            g.check("write", a.get("path"))
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("write", gated_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("w1", "write", path="a")]},
        ])
        out = self.run_turn(provider, gate=Gate(self.root, mode="plan"))
        self.assertFalse(out["results"]["w1"]["ok"])
        self.assertEqual("denied", out["results"]["w1"]["error"])

    # --- isolation, timeout, disabling ---------------------------------------

    def test_callback_exception_is_isolated_and_recorded(self):
        # git observes before hooks (build order, equal priority); its crash
        # must not stop hooks from observing or the call from running.
        def bomb(payload):
            raise RuntimeError("boom")

        seen = []
        self.patch_callback("git", "after_tool_execution", bomb)
        self.patch_callback("hooks", "after_tool_execution",
                            lambda payload: seen.append(payload["tool_call_id"]))
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path")})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(["r1"], seen)
        self.assertTrue(out["results"]["r1"]["ok"])
        failures = self.diagnostics(out, "error", plugin="git")
        self.assertEqual(1, len(failures))
        self.assertEqual("RuntimeError", failures[0]["detail"])
        self.assertEqual("after_tool_execution", failures[0]["event"])

    def test_callback_timeout_is_capped_and_the_run_continues(self):
        timeout_patch = patch.object(plugin_runtime, "TOOL_EVENT_TIMEOUT_SECONDS",
                                     0.2)
        timeout_patch.start()
        self.patches.append(timeout_patch)

        def slow(payload):
            time.sleep(1.0)

        self.patch_callback("hooks", "after_tool_execution", slow)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path")})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        started = time.monotonic()
        out = self.run_turn(provider)
        self.assertLess(time.monotonic() - started, 0.9,
                        "a stalled observer must not stall the tool call")
        self.assertTrue(out["results"]["r1"]["ok"])
        timeouts = self.diagnostics(out, "timeout")
        self.assertEqual(1, len(timeouts))
        self.assertIn("exceeded", timeouts[0]["detail"])

    def test_disabled_plugin_stops_contributing_immediately(self):
        seen = []
        self.patch_callback("hooks", "after_tool_execution",
                            lambda payload: seen.append(payload["tool_call_id"]))
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path")})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        self.run_turn(provider)
        self.assertEqual(["r1"], seen)
        plugin_runtime.set_enabled(self.store.directory, "hooks", False)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r2", "read", path="b")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(["r1"], seen, "a disabled plugin must not be called again")
        self.assertTrue(out["results"]["r2"]["ok"])

    # --- dispatch order -------------------------------------------------------

    def test_dispatch_order_is_topology_then_priority_then_build_order(self):
        def row(pid, deps=(), priority=0):
            return {"id": pid, "effective": True, "dependencies": list(deps),
                    "toolEvents": {"events": ["after_tool_execution"],
                                   "priority": priority}}

        items = [row("hooks", deps=("sessions",), priority=100),
                 row("sessions"),
                 row("files", priority=5)]
        self.assertEqual(["files", "sessions", "hooks"],
                         plugin_runtime.tool_event_order(items))

        items = [row("files"), row("sessions")]  # equal priority: build order
        self.assertEqual(["sessions", "files"],
                         plugin_runtime.tool_event_order(items))

        items = [row("hooks", deps=("sessions",)), row("sessions", priority=100)]
        self.assertEqual(["sessions", "hooks"],
                         plugin_runtime.tool_event_order(items),
                         "a dependency always dispatches before its dependents")

    def test_plan_grants_come_from_the_declaration(self):
        self.declare_tool_events(["after_tool_execution"], priority=7)
        plan = plugin_runtime.tool_event_plan(self.store.directory)
        hooks = next(row for row in plan if row["id"] == "hooks")
        git = next(row for row in plan if row["id"] == "git")
        self.assertEqual(7, hooks["priority"])
        self.assertFalse(hooks["before"])
        self.assertTrue(hooks["after"])
        self.assertFalse(git["before"])
        self.assertFalse(git["after"], "no declaration means observation only")
        # Every effective plugin appears exactly once.
        effective = {p["id"] for p in plugin_runtime.catalog(self.store.directory)
                     if p["effective"]}
        self.assertEqual(effective, {row["id"] for row in plan})

    # --- concurrent batches ---------------------------------------------------

    def test_batch_events_fire_per_call_and_stay_serial(self):
        barrier = threading.Barrier(3, timeout=15)
        serializer = _Serializer()

        def concurrent_read(r, g, a, s, c):
            barrier.wait()
            return {"ok": True, "path": a.get("path"),
                    "content": "SECRET-" + a.get("path")}

        self.replace_handler("read", concurrent_read)
        self.declare_tool_events(["after_tool_execution"])

        def rewriter(payload):
            with serializer.span(payload["tool_call_id"]):
                rewritten = dict(payload["result"])
                if payload["tool_call_id"] == "r2":
                    rewritten["content"] = "[redacted]"
                return {"decision": "rewrite", "result": rewritten}

        self.patch_callback("hooks", "after_tool_execution", rewriter)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b"),
                                           _call("r3", "read", path="c")]},
        ])
        out = self.run_turn(provider)
        self.assertEqual(0, serializer.overlaps,
                         "event callbacks must not overlap, even across a batch")
        self.assertEqual(["r1", "r2", "r3"], self.tool_message_order(out))
        contents = {message["tool_call_id"]: message["content"]
                    for message in out["messages"] if message.get("role") == "tool"}
        self.assertIn("SECRET-a", contents["r1"])
        self.assertIn("[redacted]", contents["r2"])
        self.assertNotIn("SECRET-b", contents["r2"])
        self.assertIn("SECRET-c", contents["r3"])
        for cid in ("r1", "r2", "r3"):
            self.assertTrue(out["results"][cid]["ok"], out["results"][cid])

    def test_batch_member_deny_keeps_call_order_and_siblings(self):
        self.declare_tool_events(["before_tool_execution"])
        handler_calls = []

        def spy(r, g, a, s, c):
            handler_calls.append(a.get("path"))
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", spy)

        def guard(payload):
            if payload["tool_call_id"] == "r2":
                return {"decision": "deny", "reason": "blocked in batch"}
            return None

        self.patch_callback("hooks", "before_tool_execution", guard)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b"),
                                           _call("r3", "read", path="c")]},
        ])
        out = self.run_turn(provider)
        # Handlers for the surviving members really ran; their start order is
        # naturally racy in a concurrent batch, so compare as a set. The order
        # guarantee under test is the recorded result order below.
        self.assertEqual(["a", "c"], sorted(handler_calls))
        self.assertEqual(["r1", "r2", "r3"], self.tool_message_order(out))
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertFalse(out["results"]["r2"]["ok"])
        self.assertEqual("plugin_denied", out["results"]["r2"]["error_code"])
        self.assertTrue(out["results"]["r3"]["ok"])

    # --- hooks PostToolUse integration (opt-in, default off) ------------------

    def _write_hook(self, rid, event, target, **fields):
        directory = self.store.directory / "resources" / "hooks"
        directory.mkdir(parents=True, exist_ok=True)
        item = {"id": rid, "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-01T00:00:00+00:00", "enabled": True,
                "type": "command", "command": sys.executable,
                "event": event, "matcher": "read",
                "args": ["-c",
                         "import sys; open(%r,'a').write(sys.stdin.read()+'\\n')"
                         % str(target)]}
        item.update(fields)
        (directory / f"{rid}.json").write_text(json.dumps(item), encoding="utf-8")

    def _runner(self):
        from xueness.hooks import HookRunner, load as load_hooks
        return HookRunner(load_hooks(self.store.directory), self.root)

    def test_post_tooluse_hook_without_pipeline_flag_keeps_legacy_semantics(self):
        target = self.root.parent / "legacy-hook.log"
        self._write_hook("post-legacy", "PostToolUse", target)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a",
                                           "content": "SECRET"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        self.run_turn(provider, hooks=self._runner())
        lines = target.read_text(encoding="utf-8").splitlines()
        self.assertEqual(1, len(lines), "the hook must fire exactly once")
        payload = json.loads(lines[0])
        self.assertEqual("read", payload["tool"])
        self.assertEqual("r1", payload["tool_call_id"])
        self.assertNotIn("result", payload,
                         "legacy PostToolUse payload stays as it was")

    def test_pipeline_post_tooluse_hook_receives_the_result_once(self):
        target = self.root.parent / "pipeline-hook.log"
        self._write_hook("post-pipeline", "PostToolUse", target, pipeline=True)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a",
                                           "content": "SECRET"})
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        self.run_turn(provider, hooks=self._runner())
        lines = target.read_text(encoding="utf-8").splitlines()
        self.assertEqual(1, len(lines), "the pipeline hook fires exactly once")
        payload = json.loads(lines[0])
        self.assertEqual("r1", payload["tool_call_id"])
        self.assertIs(True, payload["ok"])
        self.assertEqual({"ok": True, "path": "a", "content": "SECRET"},
                         payload["result"])

    def test_pipeline_post_tooluse_failure_hook_sees_the_failure(self):
        target = self.root.parent / "pipeline-failure.log"
        self._write_hook("post-failure", "PostToolUseFailure", target,
                         pipeline=True)

        def failing(r, g, a, s, c):
            raise ValueError("no such file")

        self.replace_handler("read", failing)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        self.run_turn(provider, hooks=self._runner())
        lines = target.read_text(encoding="utf-8").splitlines()
        self.assertEqual(1, len(lines))
        payload = json.loads(lines[0])
        self.assertIs(False, payload["ok"])

    def test_disabled_hooks_plugin_also_stops_pipeline_hooks(self):
        target = self.root.parent / "disabled-hook.log"
        self._write_hook("post-pipeline", "PostToolUse", target, pipeline=True)
        self.replace_handler(
            "read", lambda r, g, a, s, c: {"ok": True, "path": "a"})
        plugin_runtime.set_enabled(self.store.directory, "hooks", False)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a")]},
        ])
        self.run_turn(provider, hooks=None)
        self.assertFalse(target.exists(),
                         "a disabled hooks plugin must not fire pipeline hooks")

    # --- contract and gate validation -----------------------------------------

    def test_tool_events_declaration_validation(self):
        self.assertEqual([], tool_events_field_errors("hooks", {}))
        self.assertEqual([], tool_events_field_errors(
            "hooks", {"toolEvents": {"events": ["after_tool_execution"],
                                     "priority": 3}}))
        self.assertEqual([], tool_events_field_errors(
            "hooks", {"toolEvents": {"events": ["before_tool_execution",
                                                "after_tool_execution"]}}))
        for bad in ({"toolEvents": []},
                    {"toolEvents": {"events": []}},
                    {"toolEvents": {"events": ["before_tool_execution"], "extra": 1}},
                    {"toolEvents": {"events": ["not_an_event"]}},
                    {"toolEvents": {"events": ["before_tool_execution",
                                               "before_tool_execution"]}},
                    {"toolEvents": {"events": ["before_tool_execution"],
                                    "priority": "high"}},
                    {"toolEvents": {"events": ["before_tool_execution"],
                                    "priority": True}},
                    {"toolEvents": {"events": ["before_tool_execution"],
                                    "priority": 1001}}):
            errors = tool_events_field_errors("hooks", bad)
            self.assertEqual(1, len(errors), bad)
            self.assertIn("toolEvents", errors[0])

    def test_manifest_load_refuses_a_broken_declaration(self):
        checked = []

        def validator(pid, item):
            checked.append(pid)
            return ['%s: toolEvents is broken' % pid] if pid == "hooks" else []

        with patch.object(plugin_runtime, "tool_events_field_errors", validator):
            with self.assertRaises(ValueError):
                plugin_runtime._manifests()
        self.assertIn("hooks", checked)


if __name__ == "__main__":
    unittest.main()
