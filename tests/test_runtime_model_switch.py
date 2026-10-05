"""运行中切换模型与推理档位（sessions.runtime_model_switch）。

全部使用确定性 provider 与隔离状态目录：不访问网络，不调用真实模型。
"""
import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from xueness import plugin_runtime, provider_config, providers_api, web
from xueness.bundled_plugins.providers import default_selection
from xueness.bundled_plugins.sessions import model_switch
from xueness.core import Gate, Store, run
from xueness.plugin_runtime import set_enabled

FIRST = "model-one"
SECOND = "model-two"
LEVELS = ["low", "medium", "high"]
READ_REPLY = {"role": "assistant", "content": "", "tool_calls": [
    {"id": "switch-read", "type": "function", "function": {
        "name": "read", "arguments": json.dumps({"path": "notes.txt"})}}]}
#: Which request each scripted model is allowed to answer, so a mid-run switch
#: can be told apart from a switch that changed nothing.
SCRIPTS = {FIRST: [READ_REPLY], SECOND: []}


class ScriptedProvider:
    """Deterministic provider recording which model answered each request."""

    def __init__(self, name, log, replies=None, on_request=None):
        self.name = name
        self.log = log
        self.replies = list(SCRIPTS.get(name, ()) if replies is None else replies)
        self.on_request = on_request
        self.runtime_profile = "standard"
        self.tool_calling = "native"
        self.model = name

    def complete(self, messages, tools):
        self.log.append(self.name)
        if self.on_request is not None:
            self.on_request(self, len(self.log))
        if self.replies:
            return self.replies.pop(0)
        observed = [item["tool_call_id"] for item in messages if item.get("tool_call_id")]
        evidence = ([{"tool_call_id": observed[-1], "observation": "workspace file read"}]
                    if observed else [])
        return {"role": "assistant", "content": json.dumps(
            {"summary": f"{self.name} finished", "evidence": evidence}, ensure_ascii=False)}


class Route:
    """Minimal stand-in for the web handler; these routes only need ``_send``."""

    def __init__(self, ctx, path):
        self._ctx = ctx
        self.path = path
        self.headers = {}
        self.status = None
        self.payload = None

    def _send(self, code, payload, content_type="application/json"):
        self.status, self.payload = code, payload


class RuntimeModelSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / "state"
        self.root = base / "work"
        self.root.mkdir()
        (self.root / "notes.txt").write_text("xueness\n", encoding="utf-8")
        self.store = Store(self.state)
        self.ctx = web.build_context(self.state, base / "runs", base / "proj", allow_real=True)
        self.log = []
        for record in (
            {"id": "first", "name": "First", "baseUrl": "https://models.example.test/v1",
             "model": FIRST, "apiKey": "test-only-key", "reasoningLevels": LEVELS},
            {"id": "second", "name": "Second", "baseUrl": "https://models.example.test/v1",
             "model": SECOND, "apiKey": "test-only-key"},
        ):
            status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, record, self.ctx)
            self.assertEqual(status, 200)

    # -- helpers -----------------------------------------------------------
    def args(self, provider_id=None, model=None, reasoning_effort=None):
        return argparse.Namespace(provider_id=provider_id, model=model,
                                  reasoning_effort=reasoning_effort, runtime_profile=None)

    def session(self, selection=None):
        session = self.store.new("读一下 notes.txt 并总结", self.root)
        if selection is not None:
            session["model_selection"] = selection
            self.store.save(session)
        return self.store.load(session["id"])

    def running(self, sid, selection=None):
        self.ctx["running"].add(sid)
        self.ctx.setdefault("running_context", {})[sid] = {"model_selection": selection or {}}
        self.addCleanup(self._clean_running, sid)

    def _clean_running(self, sid):
        self.ctx["running"].discard(sid)
        self.ctx.get("running_context", {}).pop(sid, None)
        model_switch.unregister(self.ctx, sid)

    def resolve_by_name(self, state_dir, provider_id=None, model=None, **kwargs):
        return ScriptedProvider(model or FIRST, self.log)

    def call_route(self, method, path, data=None):
        """Call a route the same way the HTTP host does, unwrapping both shapes."""
        route = Route(self.ctx, path)
        parts = [part for part in path.split("/") if part]
        result = plugin_runtime.dispatch_http(method, parts, {}, data or {},
                                              {**self.ctx, "handler": route})
        if result is web.HANDLED_RESPONSE:
            self.assertIsNotNone(route.status, f"{method} {path} sent nothing")
            return route.status, route.payload
        self.assertIsInstance(result, tuple, f"route was not handled: {method} {path}")
        return result

    # -- /effort -----------------------------------------------------------
    def test_effort_list_marks_the_current_level(self):
        args = self.args("first", FIRST)
        text, provider = model_switch.chat_switch(self.state, "/effort", "list",
                                                  self.store, None, args)
        self.assertIsNone(provider)
        for level in LEVELS:
            self.assertIn(level, text)
        self.assertNotIn("[", text)

        model_switch.chat_switch(self.state, "/effort", "medium", self.store, None, args)
        listed, _ = model_switch.chat_switch(self.state, "/effort", "list", self.store, None, args)
        self.assertIn("[medium]", listed)

    def test_effort_rejects_unknown_and_unsupported_levels(self):
        args = self.args("first", FIRST)
        for level in ("ultra", "max"):
            with self.subTest(level=level):
                with self.assertRaises(ValueError):
                    model_switch.chat_switch(self.state, "/effort", level,
                                             self.store, None, args)
        self.assertIsNone(args.reasoning_effort)

    def test_effort_writes_session_selection_and_history(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        args = self.args("first", FIRST)
        model_switch.chat_switch(self.state, "/effort", "medium", self.store, session, args)
        stored = self.store.load(session["id"])
        self.assertEqual(stored["model_selection"],
                         {"provider_id": "first", "model": FIRST, "reasoning_effort": "medium"})
        entry = stored["model_history"][-1]
        self.assertEqual(entry["source"], "cli")
        self.assertEqual(entry["effect"], "next_run")
        self.assertIsNone(entry["from"]["reasoning_effort"])
        self.assertEqual(entry["to"]["reasoning_effort"], "medium")

    # -- /model ------------------------------------------------------------
    def test_model_shorthand_legacy_and_env(self):
        args = self.args("first", FIRST, "high")
        text, provider = model_switch.chat_switch(self.state, "/model", "second/model-two",
                                                  self.store, None, args)
        self.assertEqual((args.provider_id, args.model, args.reasoning_effort),
                         ("second", SECOND, None))
        self.assertIn("模型已切换", text)
        self.assertEqual(provider.model, SECOND)

        model_switch.chat_switch(self.state, "/model", "first model-one", self.store, None, args)
        self.assertEqual((args.provider_id, args.model), ("first", FIRST))

        env = {"XUENESS_API_BASE": "https://env.example.test/v1",
               "XUENESS_MODEL": "model-from-env", "XUENESS_API_KEY": "test-only-key"}
        with patch.dict(os.environ, env):
            _, provider = model_switch.chat_switch(self.state, "/model", "env", self.store,
                                                   None, args)
        self.assertEqual((args.provider_id, args.model), (None, None))
        self.assertEqual(provider.model, "model-from-env")

    def test_model_switch_uses_the_new_models_default_level(self):
        args = self.args("first", FIRST, "medium")
        # The saved level belongs to the first profile: keeping it would fail.
        with self.assertRaises(ValueError):
            provider_config.resolve(self.state, "second", SECOND, reasoning_effort="medium")
        _, provider = model_switch.chat_switch(self.state, "/model", "second", self.store,
                                               None, args)
        self.assertIsNone(args.reasoning_effort)
        self.assertIsNone(provider.reasoning_effort)

    def test_model_list_reports_current_selection_and_profiles(self):
        args = self.args("first", FIRST, "low")
        text, provider = model_switch.chat_switch(self.state, "/model", "list",
                                                  self.store, None, args)
        self.assertIsNone(provider)
        payload = json.loads(text)
        self.assertEqual(payload["current"], f"first {FIRST} low")
        self.assertEqual([item["id"] for item in payload["profiles"]], ["first", "second"])

    def test_unknown_provider_is_rejected_without_touching_arguments(self):
        args = self.args("first", FIRST)
        with self.assertRaises(ValueError):
            model_switch.chat_switch(self.state, "/model", "ghost/model-x", self.store, None, args)
        self.assertEqual((args.provider_id, args.model), ("first", FIRST))

    # -- save as default ---------------------------------------------------
    def test_save_default_drives_later_unqualified_requests(self):
        args = self.args("first", FIRST, "medium")
        text, provider = model_switch.chat_switch(self.state, "/model", "save-default",
                                                  self.store, None, args)
        self.assertIsNone(provider)
        self.assertIn("已设为默认", text)
        stored = default_selection.load(self.state)
        self.assertEqual({key: stored[key] for key in
                          ("providerId", "model", "reasoningEffort")},
                         {"providerId": "first", "model": FIRST, "reasoningEffort": "medium"})
        resolved = provider_config.resolve(self.state)
        self.assertEqual(resolved.model, FIRST)
        self.assertEqual(resolved.reasoning_effort, "medium")

    def test_save_default_refuses_a_level_the_model_does_not_declare(self):
        with self.assertRaises(ValueError):
            model_switch.store_default(self.state, {"providerId": "first", "model": FIRST,
                                                    "reasoningEffort": "max"})
        self.assertEqual(default_selection.load(self.state), {})

    def test_default_route_reads_writes_and_keeps_delete_yours(self):
        status, payload = self.call_route("GET", "/api/providers/default")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["default"])
        status, payload = self.call_route("POST", "/api/providers/default",
                                          {"providerId": "second", "model": SECOND})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["default"]["providerId"], "second")
        self.assertEqual(default_selection.load(self.state)["providerId"], "second")
        # A saved profile may legitimately be named "default", so this path must
        # not hijack DELETE.
        status, _ = self.call_route("DELETE", "/api/providers/default")
        self.assertEqual(status, 404)
        self.assertEqual(default_selection.load(self.state)["providerId"], "second")

    def test_default_is_dropped_when_its_profile_is_deleted(self):
        model_switch.store_default(self.state, {"providerId": "first", "model": FIRST})
        status, _ = providers_api.dispatch("DELETE", ["api", "providers", "first"], {}, None,
                                           self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual(default_selection.load(self.state), {})

    # -- HTTP switching ----------------------------------------------------
    def test_idle_http_switch_persists_and_describes(self):
        session = self.session({"provider_id": "first", "model": FIRST,
                                "reasoning_effort": "low"})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"providerId": "first", "model": FIRST,
                                           "reasoningEffort": "high"})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["applied"], "immediate")
        self.assertEqual(payload["model_selection"]["reasoning_effort"], "high")
        stored = self.store.load(session["id"])
        self.assertEqual(stored["model_selection"]["reasoning_effort"], "high")
        self.assertEqual(stored["model_history"][-1]["effect"], "immediate")

        status, described = self.call_route("GET", f"/api/sessions/{session['id']}/model")
        self.assertEqual(status, 200)
        self.assertEqual(described["levels"], LEVELS)
        self.assertEqual(described["model_selection"]["reasoning_effort"], "high")

    def test_http_switch_rejects_empty_and_unknown_selection(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model", {})
        self.assertEqual(status, 400, payload)
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"providerId": "ghost"})
        self.assertEqual(status, 400, payload)
        self.assertIn("provider", payload["error"])

    def test_http_selection_shorthand_resets_the_level(self):
        session = self.session({"provider_id": "first", "model": FIRST,
                                "reasoning_effort": "high"})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"selection": "second/model-two"})
        self.assertEqual(status, 200, payload)
        self.assertNotIn("reasoning_effort", payload["model_selection"])
        self.assertEqual(self.store.load(session["id"])["model_selection"],
                         {"provider_id": "second", "model": SECOND})

    def test_http_switch_can_save_the_default_in_the_same_call(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"reasoningEffort": "high", "saveDefault": True})
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["default_saved"])
        self.assertEqual(default_selection.load(self.state)["reasoningEffort"], "high")

    def test_refused_default_write_does_not_change_the_session(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"providerId": "second", "model": SECOND,
                                           "reasoningEffort": "high", "saveDefault": True})
        self.assertEqual(status, 400, payload)
        self.assertEqual(self.store.load(session["id"])["model_selection"],
                         {"provider_id": "first", "model": FIRST})

    # -- mid-run switching -------------------------------------------------
    def test_mid_run_switch_only_affects_the_next_model_request(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        first = ScriptedProvider(FIRST, self.log)
        switcher = model_switch.register(self.ctx, session["id"], first, session)
        self.running(session["id"], {"provider_id": "first", "model": FIRST})

        def switch_during_the_first_request(provider, request_index):
            if request_index != 1:
                return
            status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                              {"providerId": "second", "model": SECOND})
            self.assertEqual(status, 200, payload)
            self.assertEqual(payload["applied"], "next_request")
            # The request already in flight still belongs to the first model.
            self.assertEqual(switcher.pending_selection()["model"], SECOND)
            self.assertEqual(self.log, [FIRST])

        first.on_request = switch_during_the_first_request
        with patch("xueness.provider_config.resolve", side_effect=self.resolve_by_name):
            out = run(session, self.store, switcher, Gate(self.root), max_steps=4)

        self.assertEqual(self.log, [FIRST, SECOND])
        self.assertEqual(out["status"], "completed")
        stored = self.store.load(session["id"])
        self.assertEqual(stored["model_selection"], {"provider_id": "second", "model": SECOND})
        self.assertEqual(stored["model_history"][-1]["effect"], "next_request")
        self.assertEqual(self.ctx["running_context"][session["id"]]["model_selection"],
                         {"provider_id": "second", "model": SECOND})

    def test_run_without_a_switch_is_unaffected(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        switcher = model_switch.register(self.ctx, session["id"],
                                         ScriptedProvider(FIRST, self.log), session)
        with patch("xueness.provider_config.resolve", side_effect=self.resolve_by_name):
            out = run(session, self.store, switcher, Gate(self.root), max_steps=3)
        self.assertEqual(self.log, [FIRST, FIRST])
        self.assertEqual(out["status"], "completed")
        self.assertNotIn("model_history", self.store.load(session["id"]))

    def test_switcher_keeps_the_run_deadline_and_refreshes_profile_facts(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        first = ScriptedProvider(FIRST, self.log)
        first.request_deadline = 12.5
        switcher = model_switch.register(self.ctx, session["id"], first, session)
        replacement = ScriptedProvider(SECOND, self.log)
        replacement.request_deadline = None
        switcher.switch_to({"provider_id": "second", "model": SECOND}, replacement)
        switcher.complete([], [])
        self.assertEqual(replacement.request_deadline, 12.5)
        self.assertEqual(session["model_selection"], {"provider_id": "second", "model": SECOND})

    def test_lightweight_copy_follows_the_shared_pending_switch(self):
        from xueness.bundled_plugins.providers.lightweight import prepare_provider
        session = self.session({"provider_id": "first", "model": FIRST})
        facade = model_switch.register(self.ctx, session["id"],
                                      ScriptedProvider(FIRST, self.log), session)
        clone = prepare_provider(facade)
        self.assertEqual(clone.runtime_profile, "lightweight")
        clone.switch_to({"provider_id": "second", "model": SECOND},
                        ScriptedProvider(SECOND, self.log))
        self.assertEqual(facade.pending_selection()["model"], SECOND)
        clone.complete([], [])
        self.assertEqual(self.log, [SECOND])
        # The run's private copy stays lightweight after the swap.
        self.assertEqual(clone.runtime_profile, "lightweight")

    def test_active_run_refuses_an_incompatible_runtime_profile(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        active = ScriptedProvider(FIRST, self.log)
        active.runtime_profile = "lightweight"
        model_switch.register(self.ctx, session["id"], active, session)
        self.running(session["id"], {"provider_id": "first", "model": FIRST})
        with patch("xueness.provider_config.resolve", side_effect=self.resolve_by_name):
            status, payload = model_switch.apply_http(
                self.ctx, session["id"], {"providerId": "second", "model": SECOND,
                                          "runtime_profile": "lightweight"})
        self.assertEqual(status, 409, payload)
        self.assertIn("runtime profile", payload["error"])
        self.assertEqual(session["model_selection"], {"provider_id": "first", "model": FIRST})

    def test_http_refuses_to_switch_a_run_it_cannot_reach(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        self.running(session["id"], {"provider_id": "first", "model": FIRST})
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"reasoningEffort": "high"})
        self.assertEqual(status, 409, payload)
        self.assertNotIn("model_history", self.store.load(session["id"]))

    # -- ownership and availability ---------------------------------------
    def test_route_is_owned_by_sessions_and_refused_when_disabled(self):
        session = self.session()
        self.assertEqual(plugin_runtime.route_owner(["api", "sessions", session["id"], "model"]),
                         "sessions")
        set_enabled(self.state, "sessions", False)
        self.addCleanup(set_enabled, self.state, "sessions", True)
        status, payload = self.call_route("POST", f"/api/sessions/{session['id']}/model",
                                          {"reasoningEffort": "high"})
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["plugin"], "sessions")
        self.assertNotIn("model_history", self.store.load(session["id"]))

    def test_switch_trace_is_capped(self):
        session = self.session({"provider_id": "first", "model": FIRST})
        for index in range(model_switch.HISTORY_MAX + 5):
            model_switch.apply_http(self.ctx, session["id"],
                                    {"reasoningEffort": LEVELS[index % len(LEVELS)]})
        self.assertEqual(len(self.store.load(session["id"])["model_history"]),
                         model_switch.HISTORY_MAX)


if __name__ == "__main__":
    unittest.main()
