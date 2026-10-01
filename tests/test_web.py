"""Xueness Web UI tests using a test-injected provider (no live credentials).

Covers: session create/list/show/journal, bounded run, one-shot
write/exec approvals, blanket-approval rejection, CSRF, Host rebinding,
path traversal, workspace-root constraint, and real-provider gating.
No network beyond 127.0.0.1, no live credentials.
"""
import json
import os
import time
from unittest.mock import patch
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from xueness import web


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.project_dir = base / "proj"
        self.project_dir.mkdir(parents=True)
        dist = self.project_dir / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text('<!doctype html><title>Xueness</title><script src="/assets/app.js"></script>', encoding="utf-8")
        (dist / "assets" / "app.js").write_text('console.log("xueness")', encoding="utf-8")
        (dist / "assets" / "helper.mjs").write_text('export default 1', encoding="utf-8")
        (dist / "assets" / "audio.mp3").write_bytes(b"ID3")
        (dist / "assets" / "renderer.wasm").write_bytes(b"\\0asm")
        # Vite copies public/ to the dist root; the HTML and bundle reference
        # these by root URL, so they must be served from there.
        (dist / "favicon.ico").write_bytes(b"\\x00\\x00\\x01\\x00")
        (dist / "apple-touch-icon.png").write_bytes(b"\\x89PNG\\r\\n")
        (dist / "icon_512@2x.png").write_bytes(b"\\x89PNG\\r\\n")
        (dist / "third-party-notices.txt").write_text(
            "Third-party license notices fixture\n", encoding="utf-8")
        self.ctx = web.build_context(base / "state", base / "runs", self.project_dir,
                                     allow_real=False, csrf="test-csrf-token")
        self.server = _start(self.ctx)
        port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    # -- http helpers ----------------------------------------------------
    def _req(self, path, data=None, csrf=True, host=None, origin=None, raw=None):
        url = self.base + path
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        headers = {}
        if csrf:
            headers["X-CSRF-Token"] = "test-csrf-token"
        if origin is not None:
            headers["Origin"] = origin
        req = urllib.request.Request(url, data=body, headers=headers, method="POST" if data is not None or raw is not None else "GET")
        if data is not None or raw is not None:
            req.add_header("Content-Type", "application/json")
        if host is not None:
            req.add_header("Host", host)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)

    def _post(self, path, data, **kw):
        inject = kw.pop("inject_provider", True)
        if inject and path.endswith("/run") and data.get("provider", "real") == "real":
            from tests.fake_provider_fixture import inject_provider
            with inject_provider(ctx=self.ctx):
                return self._req(path, data=data, **kw)
        return self._req(path, data=data, **kw)

    def _mutation(self, method, path, data=None, csrf=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRF-Token"] = "test-csrf-token"
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(self.base + path, data=json.dumps(data or {}).encode(),
                                     headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_run_wall_clock_budget_validation(self):
        sid = self._new_session()
        for value in (0, -1, True, "120", 3601):
            with self.subTest(value=value):
                code, body, _ = self._post(f"/api/sessions/{sid}/run",
                                           {"provider": "real", "max_wall_seconds": value})
                self.assertEqual(code, 400, body)
                self.assertIn("max_wall_seconds", body)
        code, body, _ = self._post(f"/api/sessions/{sid}/run",
                                   {"provider": "real", "steps": 1, "max_wall_seconds": 1})
        self.assertEqual(code, 200, body)

    def _new_session(self, task="Create hello.txt then verify its content", root=None):
        payload = {"task": task}
        if root is not None:
            payload["root"] = root
        code, body, _ = self._post("/api/sessions", payload)
        self.assertEqual(code, 200, body)
        return json.loads(body)["id"]

    # -- server binding ---------------------------------------------------
    def test_binds_loopback_only(self):
        self.assertIsInstance(self.server, ThreadingHTTPServer)
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(web.HOST, "127.0.0.1")

    def test_built_ui_and_assets_are_same_origin(self):
        code, body, _ = self._req("/")
        self.assertEqual(code, 200)
        self.assertIn('src="/assets/app.js"', body)
        self.assertNotIn("https://", body)
        code, body, headers = self._req("/assets/app.js")
        self.assertEqual(code, 200)
        self.assertIn("console.log", body)
        self.assertIn("javascript", headers["Content-Type"])
        for name, mime in (("helper.mjs", "text/javascript"), ("audio.mp3", "audio/mpeg"),
                           ("renderer.wasm", "application/wasm")):
            code, _, headers = self._req("/assets/" + name)
            self.assertEqual(code, 200, name)
            self.assertIn(mime, headers["Content-Type"])
        for path in ("/assets/../index.html", "/assets/%2e%2e%2findex.html", "/assets/not-found.js", "/api/not-found"):
            code, _, _ = self._req(path)
            self.assertEqual(code, 404, path)

    def test_root_static_icons_are_served(self):
        """The favicon request is browser-implicit; a 404 there is a real defect."""
        for path, mime in (("/favicon.ico", "image/"),
                           ("/apple-touch-icon.png", "image/png"),
                           ("/icon_512@2x.png", "image/png")):
            code, body, headers = self._req(path)
            self.assertEqual(code, 200, path)
            self.assertIn(mime, headers["Content-Type"], path)
            self.assertTrue(body, path)
        # The allowlist must not become a general file server.
        for path in ("/xueness/web.py", "/../index.html", "/index.html.bak", "/favicon.ico/../web.py"):
            code, _, _ = self._req(path)
            self.assertEqual(code, 404, path)

    def test_third_party_notices_are_served_as_plain_text(self):
        code, body, headers = self._req("/third-party-notices.txt")
        self.assertEqual(code, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(body, "Third-party license notices fixture\n")

    def test_home_reports_service_unavailable_when_built_ui_is_missing(self):
        self.ctx["webapp_dir"] = self.project_dir / "missing-dist"
        code, body, _ = self._req("/")
        self.assertEqual(code, 503, body)
        self.assertEqual(json.loads(body), {"error": "ui asset missing"})

    def test_material_icons_route_is_retired(self):
        """The retired shell's icon directory is no longer a public asset route."""
        for path in ("/material-icons/../web.py",
                     "/material-icons/..%2fweb.py",
                     "/material-icons/document.svg",
                     "/material-icons/document.txt",
                     "/material-icons/sub/document.svg",
                     "/material-icons/nope.svg"):
            code, _, _ = self._req(path)
            self.assertEqual(code, 404, path)

    # -- sessions ----------------------------------------------------------
    def test_create_list_show_journal(self):
        sid = self._new_session()
        code, body, _ = self._req("/api/sessions")
        self.assertEqual(code, 200)
        self.assertIn(sid, body)
        code, body, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(code, 200)
        detail = json.loads(body)
        self.assertEqual(detail["id"], sid)
        self.assertIn("pending", detail)
        code, body, _ = self._req(f"/api/sessions/{sid}/journal")
        self.assertEqual(code, 200)
        journal = json.loads(body)
        self.assertIn("messages", journal)
        self.assertIn("results", journal)

    def test_rename_preserves_original_task_and_audits_change(self):
        sid = self._new_session("original instruction")
        code, result = self._mutation("PATCH", f"/api/sessions/{sid}", {"title": "  New label  "})
        self.assertEqual((code, result["title"]), (200, "New label"))
        code, detail, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(json.loads(detail)["title"], "New label")
        code, listing, _ = self._req("/api/sessions")
        self.assertEqual(json.loads(listing)["sessions"][0]["title"], "New label")
        journal = self.ctx["store"].load(sid)
        self.assertEqual(journal["task"], "original instruction")
        self.assertEqual(journal["messages"][1]["content"], "original instruction")
        self.assertEqual(journal["management_history"][0]["previous_title"], "original instruction")
        self._mutation("PATCH", f"/api/sessions/{sid}", {"title": "New label"})
        self.assertEqual(len(self.ctx["store"].load(sid)["management_history"]), 1)

    def test_delete_archives_journal_without_removing_workspace(self):
        sid = self._new_session()
        workspace = Path(self.ctx["store"].load(sid)["root"])
        (workspace / "keep.txt").write_text("important")
        code, result = self._mutation("DELETE", f"/api/sessions/{sid}")
        self.assertEqual((code, result), (200, {"id": sid, "deleted": True}))
        self.assertEqual((workspace / "keep.txt").read_text(), "important")
        archived = self.ctx["store"].directory / "deleted-sessions" / f"{sid}.json"
        self.assertEqual(json.loads(archived.read_text())["management_history"][-1]["action"], "deleted")
        self.assertEqual(self._req(f"/api/sessions/{sid}")[0], 404)
        self.assertNotIn(sid, self._req("/api/sessions")[1])
        self.assertEqual(self._mutation("DELETE", f"/api/sessions/{sid}")[0], 404)

    def test_session_mutations_validate_csrf_payload_id_and_running(self):
        sid = self._new_session()
        url = f"/api/sessions/{sid}"
        for method, data in (("PATCH", {"title": "x"}), ("DELETE", {})):
            self.assertEqual(self._mutation(method, url, data, csrf=False)[0], 403)
            self.assertEqual(self._mutation(method, url, data, origin="http://evil.example")[0], 403)
            self.assertEqual(self._mutation(method, "/api/sessions/../../etc", data)[0], 404)
        for data in ({}, {"title": " "}, {"title": "a" * 121}, {"title": 42},
                     {"title": "bad\nline"}, {"title": "x", "root": "/tmp"}):
            self.assertEqual(self._mutation("PATCH", url, data)[0], 400, data)
        with self.ctx["lock"]:
            self.ctx["running"].add(sid)
        self.assertEqual(self._mutation("PATCH", url, {"title": "new"})[0], 409)
        self.assertEqual(self._mutation("DELETE", url)[0], 409)
        self.assertEqual(self.ctx["store"].load(sid)["task"], "Create hello.txt then verify its content")

    def test_create_rejects_blank_task_and_bad_id(self):
        code, body, _ = self._post("/api/sessions", {"task": "  "})
        self.assertEqual(code, 400)
        code, body, _ = self._req("/api/sessions/not-a-session")
        self.assertEqual(code, 404)
        code, body, _ = self._req("/api/sessions/../../etc/journal")
        self.assertEqual(code, 404)

    def test_root_constraint(self):
        allowed = Path(self.temp.name) / "explicitly-allowed"
        allowed.mkdir()
        self.ctx["workspace_roots"] = (allowed.resolve(),)
        self.ctx["list_roots"] = (*self.ctx["list_roots"], allowed.resolve())
        self.ctx["create_roots"] = (*self.ctx["create_roots"], allowed.resolve())
        sid = self._new_session(root=str(allowed))
        code, body, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(code, 200)
        code, body, _ = self._post("/api/sessions", {"task": "t", "root": "/tmp"})
        self.assertEqual(code, 400, body)
        code, body, _ = self._post("/api/sessions", {"task": "t", "root": "/etc"})
        self.assertEqual(code, 400)
        code, body, _ = self._post("/api/sessions", {"task": "t", "root": "/Users"})
        self.assertEqual(code, 400)

    # -- model-injected run + approval gating -------------------------------
    def test_provider_fixture_needs_review_then_approval_completes(self):
        sid = self._new_session()
        # One step only: the denied write stays retryable (fresh IDs) so a
        # later one-shot approval can still complete the run.
        code, body, _ = self._post(f"/api/sessions/{sid}/run",
                                   {"provider": "real", "steps": 1})
        self.assertEqual(code, 200, body)
        out = json.loads(body)
        # The internal fixture writes hello.txt first; without approval it is denied.
        self.assertIn(out["status"], ("paused", "needs_review"))
        self.assertTrue(any(p["name"] == "write" for p in out["pending"]))
        # Approve the exact pending write once, then re-run to completion.
        pending_write = next(p for p in out["pending"] if p["name"] == "write")
        code, body, _ = self._post(f"/api/sessions/{sid}/approvals",
                                   {"kind": "write", "subject": pending_write["subject"], "tool_call_id": pending_write["tool_call_id"]})
        self.assertEqual(code, 200, body)
        # Approval is one-shot: a second run consumes it; a consumed approval
        # cannot be replayed, but the completed write persists on disk.
        code, body, _ = self._post(f"/api/sessions/{sid}/run",
                                   {"provider": "real", "steps": 8})
        self.assertEqual(code, 200, body)
        out2 = json.loads(body)
        self.assertEqual(out2["status"], "completed", body)
        self.assertTrue(out2["completion"]["verified"])

    def test_blanket_approval_never_accepted(self):
        sid = self._new_session()
        for key in ("allow_write", "allowWrite", "allow_exec", "allowExec",
                    "approve_all", "approveAll"):
            code, body, _ = self._post(f"/api/sessions/{sid}/run",
                                       {"provider": "real", key: True})
            self.assertEqual(code, 400, key)
            self.assertIn("blanket", body)

    def test_arbitrary_write_approval_rejected(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/approvals", {"kind": "write", "subject": "innocent.txt", "tool_call_id": "bogus"})
        self.assertEqual(code, 400, body)

    def test_exec_pending_subject_preserves_argv_boundaries(self):
        session = {"messages":[{"tool_calls":[
            {"id":"c1","function":{"name":"exec","arguments":json.dumps({"argv":["a b","c"]})}},
            {"id":"c2","function":{"name":"exec","arguments":json.dumps({"argv":["a","b c"]})}},
        ]}],"results":{"c1":{"error":"denied"},"c2":{"error":"denied"}}}
        pending = web.pending_denials(session)
        self.assertNotEqual(pending[0]["subject"], pending[1]["subject"])

    def test_exact_origin_port_required(self):
        sid = self._new_session()
        code, _, _ = self._post(f"/api/sessions/{sid}/approvals", {"kind":"write","subject":"x"}, origin="http://localhost:9999")
        self.assertEqual(code, 403)

    def test_malformed_host_rejected(self):
        for host in ("127.0.0.1:bad", "[::1", "localhost/path", "127.0.0.1:99999"):
            code, _, _ = self._req("/api/health", host=host)
            self.assertEqual(code, 403, host)

    def test_approval_traversal_rejected(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/approvals",
                                   {"kind": "write", "subject": "../escape"})
        self.assertEqual(code, 400)
        code, body, _ = self._post(f"/api/sessions/{sid}/approvals",
                                   {"kind": "mischief", "subject": "x"})
        self.assertEqual(code, 400)

    def test_run_bounds_validated(self):
        sid = self._new_session()
        code, _, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 0})
        self.assertEqual(code, 400)
        code, _, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 99})
        self.assertEqual(code, 400)
        code, _, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "nope"})
        self.assertEqual(code, 400)

    def test_real_provider_disabled_by_default(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real"},
                                   inject_provider=False)
        self.assertEqual(code, 403)
        self.assertIn("real provider disabled", body)

    def test_public_fake_provider_is_rejected(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "fake"})
        self.assertEqual(code, 400)
        self.assertIn("fake provider has been removed", body)

    def test_historical_fake_session_can_be_read_but_cannot_resume_or_run(self):
        if type(self) is not WebTests:
            self.skipTest("covered once by the base HTTP fixture")
        sid = self._new_session()
        session = self.ctx["store"].load(sid)
        session["messages"].append({"role": "assistant", "tool_calls": [{
            "id": "demo-write", "type": "function",
            "function": {"name": "write", "arguments": '{"path":"hello.txt"}'},
        }]})
        self.ctx["store"].save(session)
        code, body, _ = self._req(f"/api/sessions/{sid}/journal")
        self.assertEqual(code, 200, body)
        code, body, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "continue"})
        self.assertEqual(code, 409)
        self.assertIn("Start a new session", body)
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real"})
        self.assertEqual(code, 409)
        self.assertIn("Start a new session", body)

    def test_prepared_command_selection_survives_create_and_model_switch_clears_effort(self):
        if type(self) is not WebTests:
            self.skipTest("covered once by the base HTTP fixture")
        from xueness.bundled_plugins.providers import providers_api
        from xueness.plugin_runtime import set_enabled

        for provider in (
            {"id": "gpt6", "name": "GPT 6", "baseUrl": "https://models.example.test/v1",
             "model": "gpt-6-sol", "apiKey": "test-only-key",
             "reasoningLevels": ["low", "medium", "high", "xhigh", "max"]},
            {"id": "plain", "name": "Plain", "baseUrl": "https://models.example.test/v1",
             "model": "gpt-4o", "apiKey": "test-only-key"},
        ):
            status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, provider,
                                               self.ctx)
            self.assertEqual(status, 200)
        set_enabled(self.ctx["state_dir"], "commands", True)
        command_dir = Path(self.ctx["state_dir"]) / "resources" / "commands"
        command_dir.mkdir(parents=True)
        (command_dir / "review.json").write_text(json.dumps({
            "id": "review", "name": "Review", "prompt": "Review this: $ARGUMENTS",
        }), encoding="utf-8")

        self.ctx["allow_real"] = True
        code, body, _ = self._post("/api/composer/prepare", {
            "text": "/review first item", "provider_id": "gpt6", "model": "gpt-6-sol",
            "reasoning_effort": "max", "root": str(self.ctx["web_runs"]), "input": {},
        })
        self.assertEqual(code, 200, body)
        prepared = json.loads(body)
        self.assertEqual(prepared["metadata"]["commandInvocations"], [
            {"command": "review", "args": "first item"},
        ])
        code, body, _ = self._post("/api/sessions", {
            "task": "/review first item", "prepared_token": prepared["token"],
        })
        self.assertEqual(code, 200, body)
        sid = json.loads(body)["id"]
        session = self.ctx["store"].load(sid)
        self.assertEqual(session["messages"][1]["content"], prepared["text"])
        self.assertEqual(session["command_invocations"], prepared["metadata"]["commandInvocations"])
        self.assertEqual(session["model_selection"], {
            "provider_id": "gpt6", "model": "gpt-6-sol", "reasoning_effort": "max",
        })

        session["status"] = "completed"
        self.ctx["store"].save(session)
        code, body, _ = self._post("/api/composer/prepare", {
            "text": "/review second item", "provider_id": "plain", "model": "gpt-4o",
            "session_id": sid, "input": {},
        })
        self.assertEqual(code, 200, body)
        followup = json.loads(body)
        code, body, _ = self._post(f"/api/sessions/{sid}/messages", {
            "text": "/review second item", "prepared_token": followup["token"],
        })
        self.assertEqual(code, 200, body)
        session = self.ctx["store"].load(sid)
        self.assertEqual(session["messages"][-1]["content"], followup["text"])
        self.assertEqual(session["model_selection"], {
            "provider_id": "plain", "model": "gpt-4o",
        })
        self.assertEqual(session["command_invocations"], [
            {"command": "review", "args": "first item"},
            {"command": "review", "args": "second item"},
        ])

    def test_permission_modes_only_expand_named_gate_kinds(self):
        if type(self) is not WebTests:
            self.skipTest("covered once by the base HTTP fixture")
        root = Path(self.temp.name)
        build = web.WebGate(root, "s", {}, self.ctx["lock"], permission_mode="build")
        edit = web.WebGate(root, "s", {}, self.ctx["lock"], permission_mode="edit")
        yolo = web.WebGate(root, "s", {}, self.ctx["lock"], permission_mode="yolo")
        edit.check("write", "file.txt", "w1")
        edit.check("edit", "file.txt", "e1")
        for gate in (build, edit):
            with self.assertRaises(PermissionError):
                gate.check("exec", '["echo","ok"]', "x1")
        yolo.check("exec", '["echo","ok"]', "x2")
        yolo.check("web_fetch", "https://example.test/", "n1")
        plan_yolo = web.WebGate(root, "s", {}, self.ctx["lock"], mode="plan",
                                permission_mode="yolo")
        with self.assertRaisesRegex(PermissionError, "plan mode"):
            plan_yolo.check("write", "file.txt", "w2")

    def test_remote_session_summary_selection_and_run_gate_are_bound(self):
        if type(self) is not WebTests:
            self.skipTest("covered once by the base HTTP fixture")
        from xueness.bundled_plugins.providers import providers_api
        from xueness.plugin_runtime import entrypoint, set_enabled

        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, {
            "id": "plain", "name": "Plain", "baseUrl": "https://models.example.test/v1",
            "model": "gpt-4o", "apiKey": "test-only-key",
        }, self.ctx)
        self.assertEqual(status, 200)
        set_enabled(self.ctx["state_dir"], "remote", True)
        remote = entrypoint("remote")
        status, saved = remote.dispatch("POST", ["api", "remote"], {}, {
            "id": "lab", "host": "lab.example.test", "user": "dev", "port": 22,
            "directory": "/work/project",
        }, self.ctx)
        self.assertEqual(status, 200, saved)
        _, catalog = remote.dispatch("GET", ["api", "remote"], {}, {}, self.ctx)
        expected = {"id": "lab", "digest": catalog["connections"][0]["digest"]}
        self.ctx["allow_real"] = True
        code, body, _ = self._post("/api/composer/prepare", {
            "text": "Inspect the remote project", "root": str(self.ctx["web_runs"]),
            "provider_id": "plain", "model": "gpt-4o", "input": {"remote": "lab"},
        })
        self.assertEqual(code, 200, body)
        prepared = json.loads(body)
        code, body, _ = self._post("/api/sessions", {
            "task": "Inspect the remote project", "prepared_token": prepared["token"],
        })
        self.assertEqual(code, 200, body)
        sid = json.loads(body)["id"]
        code, body, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["remote_connection"], expected)

        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1})
        self.assertEqual(code, 409)
        self.assertIn("same remote connection", body)

        def no_cost_run(session, store, provider, gate, steps, max_chars, **kwargs):
            self.assertIn("read", gate.disallow_tool_names)
            self.assertIn("exec", gate.disallow_tool_names)
            session.update(status="completed", steps=1, mode="build",
                           completion={"verified": True, "summary": "ok"},
                           pending_question=None, todos=[], hook_log=[])
            store.save(session)
            return session

        with patch("xueness.web.run", side_effect=no_cost_run):
            code, body, _ = self._post(f"/api/sessions/{sid}/run", {
                "provider": "real", "steps": 1, "remote": "lab",
            })
        self.assertEqual(code, 200, body)

        status, _ = remote.dispatch("POST", ["api", "remote"], {}, {
            "id": "lab", "host": "changed.example.test", "user": "dev", "port": 22,
            "directory": "/work/project",
        }, self.ctx)
        self.assertEqual(status, 200)
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {
            "provider": "real", "steps": 1, "remote": "lab",
        })
        self.assertEqual(code, 409)
        self.assertIn("connection changed", body)

    def test_run_null_reasoning_effort_clears_saved_value_and_audits_permission_change(self):
        if type(self) is not WebTests:
            self.skipTest("covered once by the base HTTP fixture")
        from xueness.bundled_plugins.providers import providers_api

        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, {
            "id": "gpt6", "name": "GPT 6", "baseUrl": "https://models.example.test/v1",
            "model": "gpt-6-sol", "apiKey": "test-only-key",
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max"],
        }, self.ctx)
        self.assertEqual(status, 200)
        sid = self._new_session()
        session = self.ctx["store"].load(sid)
        session["model_selection"] = {
            "provider_id": "gpt6", "model": "gpt-6-sol", "reasoning_effort": "max",
        }
        self.ctx["store"].save(session)

        def no_cost_run(session, store, provider, gate, steps, max_chars, **kwargs):
            session.update(status="completed", steps=1, mode="build",
                           completion={"verified": True, "summary": "ok"},
                           pending_question=None, todos=[], hook_log=[])
            store.save(session)
            return session

        with patch("xueness.web.run", side_effect=no_cost_run):
            code, body, _ = self._post(f"/api/sessions/{sid}/run", {
                "provider": "real", "steps": 1, "reasoning_effort": None,
                "permission_mode": "yolo",
            })
        self.assertEqual(code, 200, body)
        saved = self.ctx["store"].load(sid)
        self.assertEqual(saved["model_selection"], {
            "provider_id": "gpt6", "model": "gpt-6-sol",
        })
        self.assertEqual(saved["permission_mode"], "yolo")
        self.assertEqual(saved["permission_mode_history"][-1]["from"], "build")
        self.assertEqual(saved["permission_mode_history"][-1]["to"], "yolo")

    def test_unconfigured_real_provider_does_not_strand_session_busy(self):
        sid = self._new_session()
        self.ctx["allow_real"] = True
        # Deliberately avoid reading any machine credentials or making a network call.
        with patch("xueness.provider_config.resolve", side_effect=ValueError("provider is not configured")):
            code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real"},
                                       inject_provider=False)
        self.assertEqual(code, 400)
        self.assertIn("provider is not configured", body)
        with self.ctx["lock"]:
            self.assertNotIn(sid, self.ctx["running"])
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1})
        self.assertEqual(code, 200, body)

    def test_invalid_json_rejected(self):
        code, body, _ = self._req("/api/sessions", raw=b"{not json",
                                  csrf=True)
        # urllib sends POST with raw body; web returns 400 invalid json body
        self.assertEqual(code, 400)

    # -- CSRF + host --------------------------------------------------------
    def test_csrf_required_for_post(self):
        code, body, _ = self._post("/api/sessions", {"task": "hi"}, csrf=False)
        self.assertEqual(code, 403)
        self.assertIn("csrf", body)

    def test_host_rebinding_rejected(self):
        code, body, _ = self._req("/api/sessions", host="evil.example:8137")
        self.assertEqual(code, 403)
        code, body, _ = self._post("/api/sessions", {"task": "hi"},
                                   host="192.168.1.9:8137")
        self.assertEqual(code, 403)

    def test_bad_origin_rejected(self):
        code, body, _ = self._post("/api/sessions", {"task": "hi"},
                                   origin="http://evil.example/")
        self.assertEqual(code, 403)

    def test_loopback_helpers(self):
        self.assertTrue(web._loopback_host("127.0.0.1"))
        self.assertTrue(web._loopback_host("localhost"))
        self.assertTrue(web._loopback_host("::1"))
        self.assertFalse(web._loopback_host("evil.example"))
        self.assertFalse(web._loopback_host("192.168.1.1"))
        self.assertTrue(web._valid_sid("a" * 32))
        self.assertFalse(web._valid_sid("../../x"))




class SearchEditModeWebTests(WebTests):
    def test_edit_approval_flow(self):
        import json as _json
        sid = self._new_session(task="edit a file")
        # seed a file in the session workspace, then journal a denied edit call
        store = self.ctx["store"]
        s = store.load(sid)
        root = Path(s["root"])
        (root / "target.txt").write_text("aaa BBB aaa", encoding="utf-8")
        s["messages"].append({"role": "assistant", "content": "",
            "tool_calls": [{"id": "edit1", "type": "function",
                "function": {"name": "edit", "arguments": _json.dumps({"path": "target.txt", "old": "BBB", "new": "CCC"})}}]})
        s["results"]["edit1"] = {"ok": False, "error": "denied"}
        s["messages"].append({"role": "tool", "tool_call_id": "edit1",
            "content": _json.dumps({"ok": False, "error": "denied"})})
        store.save(s)
        code, body, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(code, 200)
        detail = _json.loads(body)
        pend = [x for x in detail["pending"] if x["name"] == "edit"]
        self.assertTrue(pend, body)
        self.assertIn("preview", pend[0])
        code, body, _ = self._post(f"/api/sessions/{sid}/approvals",
            {"kind": "edit", "subject": "target.txt", "tool_call_id": "edit1"})
        self.assertEqual(code, 200, body)
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1})
        self.assertEqual(code, 200, body)
        self.assertEqual((root / "target.txt").read_text(encoding="utf-8"), "aaa CCC aaa")

    def test_blanket_edit_keys_rejected(self):
        sid = self._new_session()
        for key in ("allow_edit", "allowEdit"):
            code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", key: True})
            self.assertEqual(code, 400, key)
            self.assertIn("blanket", body)

    def test_run_mode_plan_and_disallow(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1, "mode": "plan"})
        self.assertEqual(code, 200, body)
        out = json.loads(body)
        self.assertEqual(out.get("mode"), "plan")
        code, body, _ = self._req(f"/api/sessions/{sid}/journal")
        journal = json.loads(body)
        self.assertEqual(journal.get("mode"), "plan")
        self.assertTrue(any(h.get("mode") == "plan" for h in journal.get("mode_history", [])))
        # invalid mode rejected
        code, _, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "mode": "yolo"})
        self.assertEqual(code, 400)
        # unknown disallow tool rejected
        code, _, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "disallow_tools": "nope"})
        self.assertEqual(code, 400)
        # disallow exec is accepted (fake run still proceeds; gate denies exec if attempted)
        code, body, _ = self._post(f"/api/sessions/{sid}/run",
            {"provider": "real", "steps": 1, "disallow_tools": "exec"})
        self.assertEqual(code, 200, body)

    def test_plan_denies_even_with_approval(self):
        from xueness import web as _web
        from xueness.core import Gate as _Gate
        import threading as _th
        # direct gate: plan denies before approval lookup even when blanket-allowed
        import tempfile as _tf
        from pathlib import Path as _P
        with _tf.TemporaryDirectory() as d:
            _P(d, "x.txt").write_text("a")
            g = _Gate(_P(d), allow_write=True, allow_exec=True, mode="plan")
            from xueness.core import execute as _ex
            self.assertEqual(_ex(_P(d), g, "write", {"path": "x.txt", "content": "b"})["error"], "denied")
        # web gate plan also denies pre-approval
        sid = self._new_session()
        _gate = _web.WebGate(Path(self.ctx["store"].load(sid)["root"]), sid, {}, _th.Lock(), mode="plan")
        with self.assertRaises(PermissionError):
            _gate.check("write", "hello.txt", "any-id")

    def test_new_shell_does_not_imply_legacy_mode_selector(self):
        code, body, _ = self._req("/")
        self.assertEqual(code, 200)
        self.assertIn('<title>Xueness</title>', body)
        self.assertNotIn('id="mode"', body)
        # Plan/build mode enforcement remains covered by the API tests.

    def test_events_stream_and_host_guard(self):
        sid = self._new_session()
        self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1})
        code, body, headers = self._req(f"/api/sessions/{sid}/events")
        self.assertEqual(code, 200, body)
        payload = json.loads(body)
        kinds = [e.get("type") for e in payload["events"]]
        self.assertTrue(any(k in kinds for k in ("tool_call", "assistant", "status")))
        req = urllib.request.Request(self.base + f"/api/sessions/{sid}/events",
                                     headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertIn("text/event-stream", resp.headers.get("Content-Type", ""))
            text = resp.read().decode()
        self.assertIn("event:", text)
        self.assertIn("data:", text)
        code, _, _ = self._req(f"/api/sessions/{sid}/events", host="evil.example:80")
        self.assertEqual(code, 403)

    def test_ask_user_web_answer_csrf(self):
        sid = self._new_session(task="ask something")
        session = self.ctx["store"].load(sid)
        session["status"] = "awaiting_user"
        session["pending_question"] = "which file?"
        self.ctx["store"].save(session)
        code, body, _ = self._post(f"/api/sessions/{sid}/answer", {"answer": "hello.txt"}, csrf=False)
        self.assertEqual(code, 403, body)
        code, body, _ = self._post(f"/api/sessions/{sid}/answer", {"answer": "hello.txt"})
        self.assertEqual(code, 200, body)
        out = json.loads(body)
        self.assertEqual(out["status"], "paused")
        self.assertIsNone(out.get("pending_question"))
        code, body, _ = self._post(f"/api/sessions/{sid}/answer", {"answer": "again"})
        self.assertEqual(code, 409, body)
        # answer is not an approval bypass: pending denials still require one-shot approve
        sid2 = self._new_session()
        self._post(f"/api/sessions/{sid2}/run", {"provider": "real", "steps": 1})
        code, body, _ = self._post(f"/api/sessions/{sid2}/answer", {"answer": "nope"})
        self.assertEqual(code, 409, body)

    def test_concurrent_run_one_200_one_409(self):
        sid = self._new_session()
        started = threading.Event()
        release = threading.Event()
        real = web.run
        def slow(*a, **k):
            started.set()
            self.assertTrue(release.wait(5))
            return real(*a, **k)
        results = []
        def first():
            results.append(self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1}))
        with patch("xueness.web.run", side_effect=slow):
            t = threading.Thread(target=first)
            t.start()
            self.assertTrue(started.wait(5))
            code2, body2, _ = self._post(f"/api/sessions/{sid}/run", {"provider": "real", "steps": 1})
            release.set()
            t.join(timeout=10)
        self.assertTrue(t.is_alive() is False)
        self.assertEqual(code2, 409, body2)
        self.assertEqual(results[0][0], 200, results[0][1])
        code, body, _ = self._req(f"/api/sessions/{sid}/journal")
        self.assertEqual(code, 200, body)
        json.loads(body)

    def test_new_shell_does_not_claim_legacy_answer_and_events_ui(self):
        code, body, _ = self._req("/")
        self.assertEqual(code, 200)
        self.assertNotIn("pending_question", body)
        # Existing answer/events endpoints are tested separately; the imported
        # shell does not expose their old controls yet.

    def test_followup_message_roundtrip_and_safety(self):
        sid = self._new_session()
        # A fresh session can take a follow-up; journal and events retain the turn.
        code, body, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "Inspect again"})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["status"], "pending")
        journal = self.ctx["store"].load(sid)
        self.assertEqual(journal["messages"][-1]["content"], "Inspect again")
        code, body, _ = self._req(f"/api/sessions/{sid}/events")
        self.assertIn("Inspect again", body)
        code, _, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "x"}, csrf=False)
        self.assertEqual(code, 403)
        code, _, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "   "})
        self.assertEqual(code, 400)
        with self.ctx["lock"]:
            self.ctx["running"].add(sid)
        code, _, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "race"})
        self.assertEqual(code, 409)
        with self.ctx["lock"]:
            self.ctx["running"].discard(sid)
        self.assertNotIn("race", json.dumps(self.ctx["store"].load(sid)["messages"]))
        journal = self.ctx["store"].load(sid)
        journal["status"] = "awaiting_user"
        journal["pending_question"] = "which?"
        self.ctx["store"].save(journal)
        code, _, _ = self._post(f"/api/sessions/{sid}/messages", {"text": "skip question"})
        self.assertEqual(code, 409)
        sid2 = self._new_session()
        self._post(f"/api/sessions/{sid2}/run", {"provider": "real", "steps": 1})
        code, _, _ = self._post(f"/api/sessions/{sid2}/messages", {"text": "skip approval"})
        self.assertEqual(code, 409)

    def test_workspace_files_are_read_only_and_jailed(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        (root / "note.txt").write_text("hello file", encoding="utf-8")
        nested = root / "sub"
        nested.mkdir()
        (nested / "b.txt").write_text("nested", encoding="utf-8")
        outside = root.parent / "secret.txt"
        outside.write_text("nope", encoding="utf-8")
        link = root / "escape.txt"
        link.symlink_to(outside)
        code, body, _ = self._req(f"/api/sessions/{sid}/files")
        self.assertEqual(code, 200, body)
        names = [item["path"] for item in json.loads(body)["files"]]
        self.assertIn("note.txt", names)
        self.assertIn("sub/b.txt", names)
        self.assertNotIn("secret.txt", names)
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=note.txt")
        self.assertEqual(code, 200, body)
        self.assertIn("hello file", json.loads(body)["text"])
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=../secret.txt")
        self.assertEqual(code, 400, body)
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=escape.txt")
        self.assertEqual(code, 400, body)
        session = self.ctx["store"].load(sid)
        session["messages"].append({"role": "assistant", "tool_calls": [
            {"id": "w1", "type": "function", "function": {"name": "write", "arguments": json.dumps({"path": "note.txt", "content": "x"})}}]})
        session["results"]["w1"] = {"ok": True}
        self.ctx["store"].save(session)
        code, body, _ = self._req(f"/api/sessions/{sid}")
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["changed_files"], ["note.txt"])

    def test_new_shell_is_not_the_legacy_workbench(self):
        code, body, headers = self._req("/")
        self.assertEqual(code, 200)
        self.assertIn('<title>Xueness</title>', body)
        self.assertIn('/assets/app.js', body)
        self.assertNotIn('class="inspector"', body)
        self.assertNotIn('https://', body)
        self.assertIn('nosniff', headers['X-Content-Type-Options'])


class DirectoryBrowseWebTests(WebTests):
    """Host-side half of the DSH ``browse`` capability (the Web folder picker).

    A browser has no OS chooser, so the picker lists levels and creates child
    directories through the host. These tests pin the seam semantics: absolute
    paths only, directories only, hidden flagged and filtered, bounded levels
    reported as truncated, single-segment creation, and a hard root fence.
    """

    def setup_workspace(self):
        root = Path(self.ctx["web_runs"]).resolve()
        (root / "proj-a").mkdir(exist_ok=True)
        (root / "proj-b").mkdir(exist_ok=True)
        (root / ".hidden").mkdir(exist_ok=True)
        (root / "note.txt").write_text("x", encoding="utf-8")
        return root

    def test_system_info_anchors_the_picker_inside_the_roots(self):
        root = self.setup_workspace()
        code, body, _ = self._req("/api/system")
        self.assertEqual(code, 200)
        homedir = json.loads(body)["homedir"]
        # The test host's real home is outside the roots, so the picker starts
        # at the first operator-allowed workspace root (the project root).
        allowed_root = Path(self.ctx["list_roots"][0])
        self.assertEqual(homedir, str(allowed_root))
        code, listing, _ = self._req(f"/api/directory?path={homedir}")
        self.assertEqual(code, 200, listing)

    def test_directory_listing_is_directories_only_and_flags_hidden(self):
        root = self.setup_workspace()
        code, body, _ = self._req(f"/api/directory?path={root}")
        self.assertEqual(code, 200, body)
        listing = json.loads(body)
        names = [e["name"] for e in listing["entries"]]
        # Files never appear, and dot-directories are hidden by default.
        self.assertEqual(names, ["proj-a", "proj-b"])
        self.assertNotIn("note.txt", names)
        self.assertFalse(listing["truncated"])
        self.assertEqual(listing["path"], str(root))
        self.assertTrue(listing["crumbs"])
        for entry in listing["entries"]:
            self.assertTrue(Path(entry["path"]).is_dir())

        code, body, _ = self._req(f"/api/directory?path={root}&includeHidden=1")
        self.assertEqual(code, 200)
        self.assertIn(".hidden", [e["name"] for e in json.loads(body)["entries"]])

    def test_directory_listing_rejects_relative_and_outside_paths(self):
        self.setup_workspace()
        for path in ("relative/path", "/etc", "/"):
            code, body, _ = self._req(f"/api/directory?path={urllib.parse.quote(path)}")
            self.assertEqual(code, 400, path)
            self.assertEqual(json.loads(body)["error"], "directory-unreadable")

    def test_bounded_level_reports_truncated(self):
        root = self.setup_workspace()
        for index in range(12):
            (root / f"gen-{index:02d}").mkdir(exist_ok=True)
        original = self.ctx["max_entries"]
        self.ctx["max_entries"] = 5
        try:
            code, body, _ = self._req(f"/api/directory?path={root}")
            self.assertEqual(code, 200)
            listing = json.loads(body)
            self.assertEqual(len(listing["entries"]), 5)
            self.assertTrue(listing["truncated"])
        finally:
            self.ctx["max_entries"] = original

    def test_create_directory_is_single_segment_and_conflict_aware(self):
        root = self.setup_workspace()
        code, body, _ = self._post("/api/directory", {"path": str(root), "name": "made-by-picker"})
        self.assertEqual(code, 200, body)
        created = json.loads(body)["path"]
        self.assertTrue(Path(created).is_dir())

        # Creating it again is a conflict, not silent success.
        code, body, _ = self._post("/api/directory", {"path": str(root), "name": "made-by-picker"})
        self.assertEqual(code, 409)
        self.assertEqual(json.loads(body)["error"], "directory-exists")

        for bad in ("a/b", "..", ".", "", "   "):
            code, body, _ = self._post("/api/directory", {"path": str(root), "name": bad})
            self.assertEqual(code, 400, repr(bad))
            self.assertEqual(json.loads(body)["error"], "directory-create-failed")

    def test_create_directory_cannot_escape_the_roots(self):
        self.setup_workspace()
        code, body, _ = self._post("/api/directory", {"path": "/etc", "name": "nope"})
        self.assertEqual(code, 400)
        self.assertFalse(Path("/etc/nope").exists())

    def test_directory_write_requires_csrf(self):
        root = self.setup_workspace()
        code, _, _ = self._req("/api/directory", data={"path": str(root), "name": "x"}, csrf=False)
        self.assertEqual(code, 403)
        self.assertFalse((root / "x").exists())

    def test_listing_defaults_to_directories_but_can_include_files(self):
        root = self.setup_workspace()
        # Default keeps the DSH browse semantics: the picker walks directories only.
        code, body, _ = self._req(f"/api/directory?path={root}")
        self.assertEqual(code, 200, body)
        self.assertNotIn("note.txt", [e["name"] for e in json.loads(body)["entries"]])

        # The workspace file tree needs files alongside directories.
        code, body, _ = self._req(f"/api/directory?path={root}&includeFiles=1")
        self.assertEqual(code, 200, body)
        kinds = {e["name"]: e["type"] for e in json.loads(body)["entries"]}
        self.assertEqual(kinds.get("note.txt"), "file")
        self.assertEqual(kinds.get("proj-a"), "directory")
        for entry in json.loads(body)["entries"]:
            self.assertIn(entry["type"], ("file", "directory"))

    def test_crumbs_stay_inside_the_roots(self):
        root = self.setup_workspace()
        nested = root / "proj-a" / "inner"
        nested.mkdir()
        code, body, _ = self._req(f"/api/directory?path={nested}")
        self.assertEqual(code, 200, body)
        crumbs = json.loads(body)["crumbs"]
        # Every crumb is offered as a jump target, so none may sit above the
        # fence; the topmost one is the permitted ancestor itself.
        self.assertEqual([c["name"] for c in crumbs], [root.name, "proj-a", "inner"])
        for crumb in crumbs:
            list_code, _, _ = self._req(f"/api/directory?path={crumb['path']}")
            self.assertEqual(list_code, 200, crumb["path"])

    def test_declared_workspace_root_can_back_a_session(self):
        # A mounted host directory is declared once and then works for both the
        # picker and task creation; the two must not drift apart.
        root = self.setup_workspace()
        self.ctx["workspace_roots"] = (root,)
        try:
            sid = self._new_session(task="t", root=str(root))
            code, body, _ = self._req(f"/api/sessions/{sid}")
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["root"], str(root))
        finally:
            self.ctx["workspace_roots"] = ()

class WorkspaceImagePreviewTest(WebTests):
    """Lane C: workspace image preview over the GET file route.

    Whitelisted image suffixes come back as base64 data URLs (for direct
    ``<img>`` consumption); every other suffix keeps the text-branch behavior.
    The workspace fence must hold for images too: oversized files and symlink
    escapes are rejected with 400.
    """

    def test_image_file_returns_data_url(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        data = b"\x89PNG\r\n\x1a\n" + b"not-really-an-image-but-bytes" * 4
        (root / "tiny.png").write_bytes(data)
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=tiny.png")
        self.assertEqual(code, 200, body)
        payload = json.loads(body)
        self.assertTrue(payload["image"].startswith("data:image/png;base64,"), body)
        self.assertEqual(payload["size"], len(data))
        self.assertFalse(payload["truncated"])
        self.assertEqual(payload["path"], "tiny.png")
        self.assertNotIn("text", payload)
        import base64
        self.assertEqual(base64.b64decode(payload["image"].split(",", 1)[1]), data)

    def test_txt_file_still_uses_text_branch(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        (root / "note.txt").write_text("hello text", encoding="utf-8")
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=note.txt")
        self.assertEqual(code, 200, body)
        payload = json.loads(body)
        self.assertIn("hello text", payload["text"])
        self.assertNotIn("image", payload)

    def test_oversized_image_is_rejected(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        (root / "big.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * (2_000_001 - 8))
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=big.png")
        self.assertEqual(code, 400, body)
        self.assertIn("cannot preview file", body)

    def test_symlinked_image_escape_is_rejected(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        outside = root.parent / "outside.png"
        outside.write_bytes(b"\x89PNG\r\n\x1a\noutside")
        (root / "escape.png").symlink_to(outside)
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=escape.png")
        self.assertEqual(code, 400, body)
        self.assertIn("path outside workspace", body)

    def test_workspace_image_preview_unit(self):
        import tempfile
        from xueness.core import workspace_image_preview
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = b"\x89PNG\r\n\x1a\npayload"
            (root / "tiny.png").write_bytes(data)
            result = workspace_image_preview(root, "tiny.png")
            self.assertEqual(result["path"], "tiny.png")
            self.assertEqual(result["size"], len(data))
            self.assertFalse(result["truncated"])
            self.assertTrue(result["image"].startswith("data:image/png;base64,"))
            self.assertNotIn("text", result)
            # Suffix whitelist is fixed and case-insensitive on the lookup.
            (root / "tiny.JPG").write_bytes(data)
            self.assertTrue(
                workspace_image_preview(root, "tiny.JPG")["image"].startswith("data:image/jpeg;base64,"))
            (root / "notes.txt").write_text("x", encoding="utf-8")
            with self.assertRaises(ValueError):
                workspace_image_preview(root, "notes.txt")
            (root / "boxed.png").mkdir()
            with self.assertRaises(ValueError):
                workspace_image_preview(root, "boxed.png")

    def test_binary_preview_pdf_and_media(self):
        import base64
        import tempfile
        from xueness.core import workspace_binary_preview
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = b"%PDF-1.4 minimal"
            (root / "doc.pdf").write_bytes(pdf)
            result = workspace_binary_preview(root, "doc.pdf")
            self.assertEqual(result["embed"]["mime"], "application/pdf")
            self.assertIn("data:application/pdf;base64,", result["embed"]["dataUrl"])
            self.assertEqual(
                base64.b64decode(result["embed"]["dataUrl"].split(",", 1)[1]), pdf)
            self.assertNotIn("image", result)
            self.assertNotIn("text", result)
            (root / "clip.mp3").write_bytes(b"ID3 fake audio")
            audio = workspace_binary_preview(root, "clip.mp3")
            self.assertEqual(audio["embed"]["mime"], "audio/mpeg")
            (root / "film.webm").write_bytes(b"\x1aE\xdf\xa3 fake webm")
            video = workspace_binary_preview(root, "film.webm")
            self.assertEqual(video["embed"]["mime"], "video/webm")

    def test_binary_preview_pdf_route_and_cap(self):
        sid = self._new_session()
        root = Path(self.ctx["store"].load(sid)["root"])
        (root / "doc.pdf").write_bytes(b"%PDF-1.4 tiny")
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=doc.pdf")
        self.assertEqual(code, 200, body)
        self.assertIn("data:application/pdf;base64,", body)
        self.assertNotIn('"text"', body)
        # Per-type cap: a 4_000_001-byte pdf is rejected even though a same-
        # size image would also be rejected -- assert the pdf cap specifically.
        big = b"%PDF-1.4 " + b"x" * 4_000_000
        (root / "big.pdf").write_bytes(big)
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=big.pdf")
        self.assertEqual(code, 400, body)
        self.assertIn("cannot preview file", body)
        # Audio routed end to end.
        (root / "clip.mp3").write_bytes(b"ID3 tiny")
        code, body, _ = self._req("/api/sessions/" + sid + "/file?path=clip.mp3")
        self.assertEqual(code, 200, body)
        self.assertIn("data:audio/mpeg;base64,", body)


class SessionPinArchiveWebTest(WebTests):
    """Lane A: session pin, archived listing and restore.

    Pin is a metadata toggle surfaced on the active list; delete archives into
    ``deleted-sessions`` and restore moves the session back. The archive
    listing must skip anything that is not a real archived session file.
    """

    def test_pin_round_trip(self):
        sid = self._new_session()
        code, body, _ = self._post(f"/api/sessions/{sid}/pin", {"pinned": True})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body), {"ok": True, "pinned": True})
        code, body, _ = self._req("/api/sessions")
        summaries = {s["id"]: s for s in json.loads(body)["sessions"]}
        self.assertIs(summaries[sid]["pinned"], True)

        code, body, _ = self._post(f"/api/sessions/{sid}/pin", {"pinned": False})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body), {"ok": True, "pinned": False})
        code, body, _ = self._req("/api/sessions")
        summaries = {s["id"]: s for s in json.loads(body)["sessions"]}
        self.assertIs(summaries[sid]["pinned"], False)

    def test_pin_rejects_non_boolean(self):
        sid = self._new_session()
        for value in ("yes", 1, None):
            with self.subTest(value=value):
                code, body, _ = self._post(f"/api/sessions/{sid}/pin", {"pinned": value})
                self.assertEqual(code, 400, body)
                self.assertIn("pinned must be a boolean", body)
        code, body, _ = self._post(f"/api/sessions/{sid}/pin", {})
        self.assertEqual(code, 400, body)
        # A missing session is 404, not 400.
        code, body, _ = self._post(f"/api/sessions/{'f' * 32}/pin", {"pinned": True})
        self.assertEqual(code, 404, body)

    def test_archive_list_and_restore_round_trip(self):
        sid = self._new_session(task="Archive me then bring me back")
        code, body = self._mutation("DELETE", f"/api/sessions/{sid}")
        self.assertEqual(code, 200, body)
        code, body, _ = self._req("/api/sessions")
        self.assertNotIn(sid, [s["id"] for s in json.loads(body)["sessions"]])

        code, body, _ = self._req("/api/sessions/archived")
        self.assertEqual(code, 200, body)
        archived = json.loads(body)["sessions"]
        entry = next(e for e in archived if e["id"] == sid)
        self.assertEqual(entry["task"], "Archive me then bring me back")
        self.assertEqual(entry["title"], "Archive me then bring me back")
        self.assertTrue(entry["archivedAt"])

        code, body, _ = self._post(f"/api/sessions/{sid}/restore", {})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body), {"ok": True, "id": sid})
        code, body, _ = self._req("/api/sessions")
        self.assertIn(sid, [s["id"] for s in json.loads(body)["sessions"]])
        code, body, _ = self._req("/api/sessions/archived")
        self.assertEqual(json.loads(body)["sessions"], [])

        # The session is live again (and no longer archived), so a second
        # restore is a client error.
        code, body, _ = self._post(f"/api/sessions/{sid}/restore", {})
        self.assertEqual(code, 400, body)
        self.assertIn("session is not archived", body)

    def test_auto_archive_requires_old_read_revision_and_remains_restorable(self):
        store = self.ctx["store"]
        old = time.time() - 10 * 24 * 60 * 60

        eligible = self._new_session(task="Read and archive this old task")
        session = store.load(eligible)
        session["status"] = "completed"
        store.save(session)
        os.utime(store._path(eligible), (old, old))
        # Opening the detail records the exact current journal revision.
        code, _, _ = self._req(f"/api/sessions/{eligible}")
        self.assertEqual(code, 200)
        marker_path = store.directory / ".xueness-session-read" / f"{eligible}.json"
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["viewedAt"] = time.time() - 8 * 24 * 60 * 60
        marker_path.write_text(json.dumps(marker), encoding="utf-8")

        unread = self._new_session(task="Keep unread old task")
        session = store.load(unread)
        session["status"] = "completed"
        store.save(session)
        os.utime(store._path(unread), (old, old))

        code, body, _ = self._req("/api/settings/general", {
            "values": {"taskAutoArchiveEnabled": True, "taskAutoArchiveOlderThanDays": 3}
        })
        self.assertEqual(code, 200, body)
        code, body, _ = self._req("/api/sessions")
        self.assertEqual(code, 200, body)
        live = {entry["id"] for entry in json.loads(body)["sessions"]}
        self.assertNotIn(eligible, live)
        self.assertIn(unread, live)

        code, body, _ = self._req("/api/sessions/archived")
        self.assertEqual(code, 200, body)
        self.assertIn(eligible, {entry["id"] for entry in json.loads(body)["sessions"]})
        code, body, _ = self._post(f"/api/sessions/{eligible}/restore", {})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)["id"], eligible)

    def test_auto_archive_will_not_archive_a_newer_unread_revision(self):
        from xueness import session_management
        from xueness.core import Store

        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            sid = store.new("revision safety", Path(tmp))["id"]
            session = store.load(sid)
            session["status"] = "completed"
            store.save(session)
            old = time.time() - 10 * 24 * 60 * 60
            os.utime(store._path(sid), (old, old))
            session_management.mark_viewed(store, sid)
            marker_path = store.directory / ".xueness-session-read" / f"{sid}.json"
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["viewedAt"] = time.time() - 8 * 24 * 60 * 60
            marker_path.write_text(json.dumps(marker), encoding="utf-8")

            # A new journal revision after the view invalidates the watermark.
            session["messages"].append({"role": "assistant", "content": "new activity"})
            store.save(session)
            self.assertEqual(session_management.archive_stale(store, 3), [])
            self.assertTrue(store._path(sid).exists())

    def test_auto_archive_skips_pinned_running_and_pending_tasks(self):
        from xueness import session_management
        from xueness.core import Store

        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            old = time.time() - 10 * 24 * 60 * 60

            def old_read_task(name, **fields):
                session = store.new(name, Path(tmp))
                session.update({"status": "completed", **fields})
                store.save(session)
                os.utime(store._path(session["id"]), (old, old))
                session_management.mark_viewed(store, session["id"])
                marker_path = store.directory / ".xueness-session-read" / f"{session['id']}.json"
                marker = json.loads(marker_path.read_text(encoding="utf-8"))
                marker["viewedAt"] = time.time() - 8 * 24 * 60 * 60
                marker_path.write_text(json.dumps(marker), encoding="utf-8")
                return session["id"]

            safe = old_read_task("eligible")
            pinned = old_read_task("pinned", pinned=True)
            running = old_read_task("running")
            active_status = old_read_task("active-status", status="running")
            awaiting = old_read_task("awaiting", pending_question="Confirm this action?")
            denied = old_read_task("denied", synthetic_pending_denial=True)

            archived = session_management.archive_stale(
                store, 3, running_ids={running},
                has_pending=lambda session: session.get("synthetic_pending_denial", False),
            )
            self.assertEqual(set(archived), {safe})
            self.assertTrue(store._path(pinned).exists())
            self.assertTrue(store._path(running).exists())
            self.assertTrue(store._path(active_status).exists())
            self.assertTrue(store._path(awaiting).exists())
            self.assertTrue(store._path(denied).exists())

    def test_session_management_pin_list_archived_restore_units(self):
        from xueness import session_management
        from xueness.core import Store

        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            sid = store.new("unit task", Path(tmp))["id"]

            pinned = session_management.pin(store, sid, True)
            self.assertIs(pinned["pinned"], True)
            self.assertEqual(pinned["management_history"][-1]["action"], "pinned")
            summary = next(s for s in session_management.list_summaries(store) if s["id"] == sid)
            self.assertIs(summary["pinned"], True)

            unpinned = session_management.pin(store, sid, False)
            self.assertIs(unpinned["pinned"], False)
            self.assertEqual(unpinned["management_history"][-1]["action"], "unpinned")

            session_management.mark_viewed(store, sid)
            read_marker = store.directory / ".xueness-session-read" / f"{sid}.json"
            self.assertTrue(read_marker.exists())
            session_management.archive(store, sid)
            self.assertFalse(read_marker.exists())
            archived = session_management.list_archived(store)
            self.assertEqual([e["id"] for e in archived], [sid])
            self.assertEqual(archived[0]["task"], "unit task")
            archived_session = json.loads(
                (store.directory / "deleted-sessions" / (sid + ".json")).read_text(encoding="utf-8"))
            self.assertEqual(archived[0]["archivedAt"],
                             archived_session["management_history"][-1]["at"])
            self.assertEqual(session_management.list_summaries(store), [])

            restored = session_management.restore(store, sid)
            self.assertEqual(restored["id"], sid)
            self.assertEqual(restored["management_history"][-1]["action"], "restored")
            self.assertEqual(session_management.list_archived(store), [])

            # A live session cannot be restored again; junk ids are rejected.
            with self.assertRaises(ValueError):
                session_management.restore(store, sid)
            with self.assertRaises(ValueError):
                session_management.restore(store, "not-a-valid-id")

            # The archived listing skips symlinks, unparsable JSON and
            # non-session file names, and falls back to mtime when the
            # deleted audit is missing.
            other = store.new("other task", Path(tmp))
            session_management.archive(store, other["id"])
            bare = store.new("bare task", Path(tmp))
            archive_dir = store.directory / "deleted-sessions"
            store._path(bare["id"]).rename(archive_dir / (bare["id"] + ".json"))
            (archive_dir / "nothex.json").write_text("{}", encoding="utf-8")
            (archive_dir / ("z" * 32 + ".json")).write_text("{broken", encoding="utf-8")
            (archive_dir / ("e" * 32 + ".json")).symlink_to(archive_dir / "nothex.json")
            entries = {e["id"]: e for e in session_management.list_archived(store)}
            self.assertEqual(set(entries), {other["id"], bare["id"]})
            self.assertIn("T", entries[bare["id"]]["archivedAt"])  # mtime ISO fallback
            bare_restored = session_management.restore(store, bare["id"])
            self.assertEqual(bare_restored["task"], "bare task")

            # A collision (archived copy AND a live file) refuses the restore.
            collide = store.new("collide task", Path(tmp))
            session_management.archive(store, collide["id"])
            store.save(collide)  # recreate the live file behind the backend's back
            with self.assertRaises(ValueError):
                session_management.restore(store, collide["id"])


# -- Git panel (read-only git integration) ------------------------------------
# 追加泳道所需的两个标准库 import，紧挨新类放置，避免改动文件头部的 import 区。
import shutil  # noqa: E402
import subprocess  # noqa: E402


@unittest.skipUnless(shutil.which("git"), "git not installed")
class GitPanelWebTest(unittest.TestCase):
    """HTTP-level Git panel tests over /api/sessions/<sid>/git/{status,diff,log}.

    Fixture is copied from ``WebTests`` (server + fake dist tree + request
    helpers) rather than inherited: the parent class's own tests assume a
    session-list that starts empty, and the git fixture deliberately seeds an
    extra session with a repo workspace, which would break them.
    """

    def _git(self, *argv) -> str:
        proc = subprocess.run(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *argv],
            cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        project_dir = base / "proj"
        project_dir.mkdir(parents=True)
        dist = project_dir / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>Xueness</title>", encoding="utf-8")
        (dist / "assets" / "app.js").write_text('console.log("xueness")', encoding="utf-8")
        self.ctx = web.build_context(base / "state", base / "runs", project_dir,
                                     allow_real=False, csrf="test-csrf-token")
        self.server = _start(self.ctx)
        port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{port}"
        # 会话根必须落在允许的 workspace root 里；web_runs 本来就是其中之一。
        self.repo = Path(self.ctx["web_runs"]) / "git-repo"
        self.repo.mkdir(parents=True, exist_ok=True)
        self._git("init")
        (self.repo / "hello.txt").write_text("hello\n", encoding="utf-8")
        self._git("add", "hello.txt")
        self._git("commit", "-m", "initial commit")
        self.sid = self._new_session(task="Git panel session", root=str(self.repo))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    # -- http helpers（抄自 WebTests）--------------------------------------
    def _req(self, path, data=None, csrf=True):
        url = self.base + path
        body = json.dumps(data).encode() if data is not None else None
        headers = {}
        if csrf:
            headers["X-CSRF-Token"] = "test-csrf-token"
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method="POST" if data is not None else "GET")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)

    def _post(self, path, data, **kw):
        return self._req(path, data=data, **kw)

    def _new_session(self, task, root=None):
        payload = {"task": task}
        if root is not None:
            payload["root"] = root
        code, body, _ = self._post("/api/sessions", payload)
        self.assertEqual(code, 200, body)
        return json.loads(body)["id"]

    # -- the panel routes ---------------------------------------------------
    def test_git_status_diff_log_routes(self):
        code, body, _ = self._req(f"/api/sessions/{self.sid}/git/status")
        self.assertEqual(code, 200, body)
        status = json.loads(body)
        self.assertEqual(status["branch"], self._git("rev-parse", "--abbrev-ref", "HEAD"))
        self.assertEqual(status["entries"], [])
        self.assertIs(status["clean"], True)

        code, body, _ = self._req(f"/api/sessions/{self.sid}/git/diff")
        self.assertEqual(code, 200, body)
        diff = json.loads(body)
        self.assertEqual(diff["stat"], "")
        self.assertEqual(diff["patch"], "")
        self.assertIs(diff["truncated"], False)

        code, body, _ = self._req(f"/api/sessions/{self.sid}/git/log")
        self.assertEqual(code, 200, body)
        commits = json.loads(body)["commits"]
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["subject"], "initial commit")
        self.assertEqual(commits[0]["hash"], self._git("rev-parse", "HEAD"))
        for key in ("short", "author", "date"):
            self.assertTrue(commits[0][key], key)

    def test_git_status_and_diff_reflect_working_tree(self):
        (self.repo / "hello.txt").write_text("hello\nchanged\n", encoding="utf-8")
        code, body, _ = self._req(f"/api/sessions/{self.sid}/git/status")
        self.assertEqual(code, 200, body)
        entries = json.loads(body)["entries"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["code"], " M")
        self.assertEqual(entries[0]["path"], "hello.txt")

        code, body, _ = self._req(f"/api/sessions/{self.sid}/git/diff")
        self.assertEqual(code, 200, body)
        diff = json.loads(body)
        self.assertIn("hello.txt", diff["stat"])
        self.assertIn("diff --git a/hello.txt b/hello.txt", diff["patch"])
        self.assertIn("+changed", diff["patch"])

    def test_git_routes_report_non_repo_workspace(self):
        plain = Path(self.ctx["web_runs"]) / "plain-workspace"
        plain.mkdir(parents=True, exist_ok=True)
        sid = self._new_session(task="plain workspace", root=str(plain))
        for verb in ("status", "diff", "log"):
            code, body, _ = self._req(f"/api/sessions/{sid}/git/{verb}")
            self.assertEqual(code, 404, verb)
            self.assertIn("该工作区不是 git 仓库", body)

    def test_git_route_rejects_invalid_sid(self):
        code, body, _ = self._req(f"/api/sessions/{'z' * 32}/git/status")
        self.assertEqual(code, 404, body)

    def test_git_route_rejects_post_with_405(self):
        code, body, _ = self._post(f"/api/sessions/{self.sid}/git/status", {})
        self.assertEqual(code, 405, body)
        self.assertIn("method not allowed", body)


if __name__ == "__main__":
    unittest.main()
