"""subagents.cancel_one: cooperative cancellation of one delegated subtask.

Experimental, default-off. Two layers, mirroring tests/test_sessions_events_cursor.py
and tests/test_desktop_subagents.py:

* The real HTTP route ``POST /api/sessions/<sid>/tasks/<tid>/cancel`` driven
  through a real server in an isolated state directory, so the host's Host /
  Origin / CSRF guards, the plugin-enabled gate and the persistent feature flag
  are all exercised rather than mocked.
* One end-to-end parent run with a deterministic provider and two bounded child
  stubs, proving the flag is honoured by the real cooperative cancel path and
  that cancelling one subtask leaves the parent session and its sibling running.

Nothing here resolves a paid model or reads the user's configured state dir.
"""
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tests.fake_provider_fixture import inject_provider
from xueness import plugin_runtime, web
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.bundled_plugins.subagents.task_registry import CANCELLED, COMPLETED, RUNNING
from xueness.plugin_runtime import set_enabled

SID = "a" * 32
OTHER_SID = "b" * 32
DISABLED_ERROR = "single subtask cancellation is disabled"


class CancelOneHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / "state"
        self.web_runs = base / "web-runs"
        self.project = base / "project"
        self.workspace = base / "workspace"
        self.sibling = base / "sibling"
        self.forbidden = base / "forbidden"
        for directory in (self.workspace, self.sibling, self.forbidden):
            directory.mkdir()
        (self.project / "xueness" / "static").mkdir(parents=True)
        dist = self.project / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        self.csrf = "isolated-cancel-one-token"
        # Two permitted roots so a task can be recorded in a *different*
        # permitted workspace than its parent session.
        self.ctx = web.build_context(
            self.state, self.web_runs, self.project, allow_real=False,
            csrf=self.csrf, workspace_roots=(self.workspace, self.sibling))
        self.server = web.create_server(0, self.ctx)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self._close_server)
        self.base_url = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.registry = self.ctx["task_registry"]
        self.addCleanup(self.registry.clear)

    def _close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=3)

    # -- request helpers -------------------------------------------------
    def _send(self, method, path, body=None, csrf=True):
        raw = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {}
        if csrf:
            headers["X-CSRF-Token"] = self.csrf
        if raw is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=raw, headers=headers,
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))

    def _get(self, path, **kwargs):
        return self._send("GET", path, **kwargs)

    def _post(self, path, body=None, **kwargs):
        return self._send("POST", path, body=body, **kwargs)

    def _cancel(self, session_id, task_id, body=None, **kwargs):
        path = "/api/sessions/%s/tasks/%s/cancel" % (session_id, task_id)
        return self._post(path, body=body, **kwargs)

    # -- state helpers ---------------------------------------------------
    def _enable(self, enabled=True):
        save_settings(self.ctx["state_dir"], {"agent": {"subagentCancelOneEnabled": enabled}})

    def _session(self, sid, root):
        """Persist a session journal with an explicit id and workspace root."""
        session = {"id": sid, "task": "cancel-one fixture", "root": str(root),
                   "status": "running", "messages": [], "results": {}, "compactions": [],
                   "archived_messages": [], "steps": 0, "completion": None, "todos": [],
                   "pending_question": None}
        self.ctx["store"].save(session)
        return session

    def _task(self, task_id, parent, root, status=RUNNING):
        self.registry.record(task_id, parent_session=parent, agent="explorer",
                             prompt="inspect the workspace", root=root)
        if status == COMPLETED:
            self.registry.finish(task_id, ok=True, summary="done")
        elif status == CANCELLED:
            self.registry.cancel(task_id)
        return task_id

    # -- the flag --------------------------------------------------------
    def test_route_is_owned_by_the_subagents_plugin_it_declares(self):
        """No new httpFamilies entry is needed: sessions/*/tasks already covers it."""
        parts = ["api", "sessions", SID, "tasks", "task-1", "cancel"]
        self.assertEqual(plugin_runtime.route_owner(parts), "subagents")
        # The pre-existing list route keeps its owner and its behaviour.
        self.assertEqual(plugin_runtime.route_owner(["api", "sessions", SID, "tasks"]), "subagents")

    def test_disabled_by_default_answers_forbidden_without_reaching_any_state(self):
        self._task("task-off", SID, self.workspace)
        self._session(SID, self.workspace)
        # A missing key means off; the message must not reveal whether the
        # session or the task exists, so both unknown ids answer the same way.
        for task_id in ("task-off", "task-does-not-exist"):
            status, payload = self._cancel(SID, task_id)
            self.assertEqual(status, 403, payload)
            self.assertEqual(payload["error"], DISABLED_ERROR)
        status, payload = self._cancel("f" * 32, "task-nope")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], DISABLED_ERROR)
        # Refusing must not touch the live task.
        self.assertEqual(self.registry.get("task-off")["status"], RUNNING)

    def test_a_non_boolean_stored_flag_stays_disabled(self):
        self._session(SID, self.workspace)
        self._task("task-strict", SID, self.workspace)
        for value in ("true", 1, ["true"], None):
            save_settings(self.ctx["state_dir"], {"agent": {"subagentCancelOneEnabled": value}})
            status, payload = self._cancel(SID, "task-strict")
            self.assertEqual(status, 403, (value, payload))
            self.assertEqual(payload["error"], DISABLED_ERROR)
        self.assertEqual(self.registry.get("task-strict")["status"], RUNNING)

    def test_settings_route_rejects_a_non_boolean(self):
        status, payload = self._post("/api/settings/agent",
                                     {"values": {"subagentCancelOneEnabled": "true"}})
        self.assertEqual(status, 400, payload)
        self.assertIn("subagentCancelOneEnabled must be boolean", payload["error"])
        status, payload = self._post("/api/settings/agent",
                                     {"values": {"subagentCancelOneEnabled": True}})
        self.assertEqual(status, 200, payload)
        self.assertIs(payload["values"]["subagentCancelOneEnabled"], True)

    # -- the happy path --------------------------------------------------
    def test_cancels_exactly_one_subtask_and_leaves_parent_and_siblings_alone(self):
        self._enable()
        self._session(SID, self.workspace)
        self._session(OTHER_SID, self.workspace)
        target = self._task("task-target", SID, self.workspace)
        sibling_a = self._task("task-sibling-a", SID, self.workspace)
        sibling_b = self._task("task-sibling-b", SID, self.workspace)
        elsewhere = self._task("task-other-session", OTHER_SID, self.workspace)
        parent = self.ctx["store"].load(SID)
        self.assertEqual(parent["status"], "running")

        status, payload = self._cancel(SID, target, body={})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload, {"cancelled": True, "taskId": target})

        # An absent request body is the same accepted empty request.
        self._task("task-nobody", SID, self.workspace)
        status, payload = self._send("POST", "/api/sessions/%s/tasks/task-nobody/cancel" % SID,
                                     body=None)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["taskId"], "task-nobody")

        for task_id in (target, "task-nobody"):
            record = self.registry.get(task_id)
            self.assertEqual(record["status"], CANCELLED, task_id)
            self.assertEqual(record["parent"], SID, task_id)
        for task_id in (sibling_a, sibling_b, elsewhere):
            self.assertEqual(self.registry.get(task_id)["status"], RUNNING, task_id)
        # The parent journal is untouched: no status change, no new turn.
        self.assertEqual(self.ctx["store"].load(SID)["status"], "running")

    def test_tasks_route_still_works_next_to_the_cancel_route(self):
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-visible", SID, self.workspace)
        status, payload = self._get("/api/sessions/%s/tasks" % SID)
        self.assertEqual(status, 200, payload)
        self.assertEqual([task["id"] for task in payload["tasks"]], ["task-visible"])
        self.assertEqual(payload["tasks"][0]["status"], RUNNING)
        # A deeper path that is not the cancel route stays a 404, not a 405:
        # only the exact .../tasks/<tid>/cancel shape is owned by the plugin.
        status, payload = self._get("/api/sessions/%s/tasks/task-visible/notes" % SID)
        self.assertEqual(status, 404, payload)

    # -- request shape ---------------------------------------------------
    def test_body_must_be_empty(self):
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-body", SID, self.workspace)
        for body in ({"taskId": "task-body"}, {"force": True}, {"cancelled": True}):
            status, payload = self._cancel(SID, "task-body", body=body)
            self.assertEqual(status, 400, (body, payload))
            self.assertEqual(payload["error"], "request body must be empty")
        # Body shape is checked before the feature flag, so a malformed request
        # is a 400 even while the experiment is off.
        self._enable(False)
        status, payload = self._cancel(SID, "task-body", body={"taskId": "task-body"})
        self.assertEqual(status, 400, payload)

    def test_only_post_is_allowed(self):
        self._session(SID, self.workspace)
        self._task("task-method", SID, self.workspace)
        for method in ("GET", "PUT", "PATCH", "DELETE"):
            status, payload = self._send(method,
                                         "/api/sessions/%s/tasks/task-method/cancel" % SID,
                                         body={} if method != "GET" else None)
            self.assertEqual(status, 405, (method, payload))
            self.assertEqual(payload["error"], "method not allowed")
        self.assertEqual(self.registry.get("task-method")["status"], RUNNING)

    def test_host_and_csrf_guards_still_apply(self):
        """The route inherits the host guards; nothing here widens them."""
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-csrf", SID, self.workspace)
        status, payload = self._cancel(SID, "task-csrf", csrf=False)
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "csrf token required")
        self.assertEqual(self.registry.get("task-csrf")["status"], RUNNING)

        request = urllib.request.Request(
            self.base_url + "/api/sessions/%s/tasks/task-csrf/cancel" % SID,
            data=b"{}", method="POST",
            headers={"X-CSRF-Token": self.csrf, "Content-Type": "application/json",
                     "Origin": "http://example.invalid"})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                cross_origin = (response.status, response.read())
        except urllib.error.HTTPError as error:
            cross_origin = (error.code, error.read())
        self.assertEqual(cross_origin[0], 403, cross_origin)
        self.assertEqual(json.loads(cross_origin[1])["error"], "host not permitted")

    def test_disabled_plugin_blocks_the_route(self):
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-plugin", SID, self.workspace)
        set_enabled(self.ctx["state_dir"], "subagents", False)
        self.addCleanup(set_enabled, self.ctx["state_dir"], "subagents", True)
        status, payload = self._cancel(SID, "task-plugin")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload.get("plugin"), "subagents")
        self.assertIn("plugin disabled", payload["error"])
        # Disabling must not cancel anything, and re-enabling restores the route.
        self.assertEqual(self.registry.get("task-plugin")["status"], RUNNING)
        set_enabled(self.ctx["state_dir"], "subagents", True)
        status, payload = self._cancel(SID, "task-plugin")
        self.assertEqual(status, 200, payload)

    # -- ownership and boundaries ---------------------------------------
    def test_unknown_subtask_is_not_found(self):
        self._enable()
        self._session(SID, self.workspace)
        status, payload = self._cancel(SID, "task-never-existed")
        self.assertEqual(status, 404, payload)
        self.assertEqual(payload["error"], "subtask not found")

    def test_unknown_session_is_not_found(self):
        self._enable()
        self._task("task-orphan", SID, self.workspace)
        status, payload = self._cancel("c" * 32, "task-orphan")
        self.assertEqual(status, 404, payload)
        self.assertEqual(payload["error"], "session not found")
        self.assertEqual(self.registry.get("task-orphan")["status"], RUNNING)

    def test_malformed_session_id_is_not_found(self):
        """Store-level id validation must not become a 500."""
        self._enable()
        for bad in ("not-an-id", "a" * 31, "a" * 33, "A" * 32, "a" * 31 + "g"):
            status, payload = self._cancel(bad, "task-any")
            self.assertEqual(status, 404, (bad, payload))
            self.assertEqual(payload["error"], "session not found")

    def test_subtask_belonging_to_another_session_is_forbidden(self):
        self._enable()
        self._session(SID, self.workspace)
        self._session(OTHER_SID, self.workspace)
        self._task("task-belonging", OTHER_SID, self.workspace)
        status, payload = self._cancel(SID, "task-belonging")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "subtask does not belong to session")
        self.assertEqual(self.registry.get("task-belonging")["status"], RUNNING)

    def test_session_outside_the_permitted_workspaces_is_forbidden(self):
        self._enable()
        self._session(SID, self.forbidden)
        self._task("task-forbidden-root", SID, self.forbidden)
        status, payload = self._cancel(SID, "task-forbidden-root")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "workspace root not permitted")
        self.assertEqual(self.registry.get("task-forbidden-root")["status"], RUNNING)

    def test_unreadable_session_root_is_forbidden(self):
        self._enable()
        for root in (None, 7, {"path": str(self.workspace)}, []):
            session = {"id": SID, "task": "t", "root": root, "status": "running",
                       "messages": [], "results": {}}
            self.ctx["store"].save(session)
            task_id = "task-bad-root-%s" % type(root).__name__
            self._task(task_id, SID, self.workspace)
            status, payload = self._cancel(SID, task_id)
            self.assertEqual(status, 403, (root, payload))
            self.assertEqual(payload["error"], "workspace root not permitted")
            self.assertEqual(self.registry.get(task_id)["status"], RUNNING)

    def test_subtask_workspace_must_match_the_session_workspace(self):
        self._enable()
        self._session(SID, self.workspace)
        # A different *permitted* root: still not this session's workspace.
        self._task("task-other-workspace", SID, self.sibling)
        status, payload = self._cancel(SID, "task-other-workspace")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "subtask workspace does not match session")
        self.assertEqual(self.registry.get("task-other-workspace")["status"], RUNNING)

    def test_a_sibling_path_prefix_is_not_the_same_workspace(self):
        """``/w/workspace`` must not be satisfied by ``/w/workspace-evil``."""
        self._enable()
        evil = Path(self.temp.name) / "workspace-evil"
        evil.mkdir()
        self._session(SID, self.workspace)
        self._task("task-prefix", SID, evil)
        status, payload = self._cancel(SID, "task-prefix")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "subtask workspace does not match session")

    def test_task_without_a_recorded_workspace_is_forbidden(self):
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-rootless", SID, None)
        status, payload = self._cancel(SID, "task-rootless")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "subtask workspace does not match session")

    def test_subtask_that_is_not_running_conflicts(self):
        self._enable()
        self._session(SID, self.workspace)
        self._task("task-done", SID, self.workspace, status=COMPLETED)
        self._task("task-already-cancelled", SID, self.workspace, status=CANCELLED)
        for task_id in ("task-done", "task-already-cancelled"):
            status, payload = self._cancel(SID, task_id)
            self.assertEqual(status, 409, (task_id, payload))
            self.assertEqual(payload["error"], "subtask is not running")
        # A finished record stays exactly as it was.
        self.assertEqual(self.registry.get("task-done")["status"], COMPLETED)
        self.assertEqual(self.registry.get("task-already-cancelled")["status"], CANCELLED)

    def test_session_root_is_validated_before_the_task_is_looked_up(self):
        """A session the host would not run must fail closed on its root alone."""
        self._enable()
        self._session(SID, self.forbidden)
        status, payload = self._cancel(SID, "task-never-existed")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "workspace root not permitted")


class CancelOneEndToEndTests(unittest.TestCase):
    """The flag actually reaches the cooperative child run, via real HTTP."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "local.txt").write_text("independent parent work", encoding="utf-8")
        project = base / "project"
        (project / "xueness" / "static").mkdir(parents=True)
        dist = project / "webapp" / "dist"
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        self.csrf = "cancel-one-e2e-token"
        self.ctx = web.build_context(base / "state", base / "web-runs", project,
                                     allow_real=False, csrf=self.csrf,
                                     workspace_roots=(self.workspace,))
        self.server = web.create_server(0, self.ctx)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self._close_server)
        self.base_url = "http://127.0.0.1:%d" % self.server.server_address[1]
        save_settings(self.ctx["state_dir"], {"agent": {"subagentCancelOneEnabled": True}})

    def _close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=3)

    def _request(self, path, body=None, method=None, timeout=30):
        raw = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"X-CSRF-Token": self.csrf}
        if raw is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=raw, headers=headers,
                                         method=method or ("POST" if raw is not None else "GET"))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))

    def test_cancelling_one_child_leaves_the_parent_and_its_sibling_running(self):
        both_started = threading.Semaphore(0)
        release_survivor = threading.Event()
        resume_parent = threading.Event()
        outcomes = {}
        self.addCleanup(release_survivor.set)
        self.addCleanup(resume_parent.set)

        class DeterministicProvider:
            model = "fixture-only"

            def __init__(self):
                self.calls = 0

            def complete(provider_self, messages, tools):
                provider_self.calls += 1
                if provider_self.calls == 1:
                    return {"content": "", "tool_calls": [
                        {"id": "dispatch-%d" % index, "type": "function",
                         "function": {"name": "task", "arguments": json.dumps({
                             "prompt": "Inspect the workspace and report a bounded finding.",
                         })},
                        } for index in (1, 2)]}
                if provider_self.calls == 2:
                    # Both children are live; hold until the cancel has landed so
                    # the parent's next step demonstrably happens afterwards.
                    outcomes["children_started"] = all(
                        both_started.acquire(timeout=15) for _ in range(2))
                    outcomes["parent_resumed_after_cancel"] = resume_parent.wait(20)
                    return {"content": "", "tool_calls": [{
                        "id": "read-independent", "type": "function",
                        "function": {"name": "read",
                                     "arguments": json.dumps({"path": "local.txt"})},
                    }]}
                if provider_self.calls == 3:
                    release_survivor.set()
                    return {"content": "", "tool_calls": [{
                        "id": "collect", "type": "function",
                        "function": {"name": "task_collect", "arguments": json.dumps({
                            "wait_seconds": 10, "reason": "dependency",
                            "detail": "Integrate whichever child findings are available.",
                        })},
                    }]}
                return {"content": json.dumps({
                    "summary": "One delegated inspection was withdrawn; the rest stands.",
                    "evidence": [{"tool_call_id": "read-independent",
                                  "observation": "The parent read the file itself."}],
                })}

        def child_runner(_gate, _provider, _agents, _prompt, _agent_name, **kwargs):
            task_id = kwargs["task_id"]
            registry = kwargs["registry"]
            registry.update(task_id, steps=1)
            both_started.release()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if registry.is_cancelled(task_id):
                    outcomes.setdefault("cancelled_child_observed_flag", True)
                    return {"ok": False, "error": "cancelled", "task_id": task_id, "steps": 1}
                if release_survivor.wait(0.05):
                    return {"ok": True, "task_id": task_id,
                            "summary": "bounded finding from " + task_id, "steps": 2, "agent": None}
            return {"ok": False, "error": "test child timed out", "task_id": task_id, "steps": 1}

        status, session = self._request("/api/sessions", {
            "task": "Cancel one of two delegated inspections", "root": str(self.workspace)})
        self.assertEqual(status, 200, session)
        session_id = session["id"]

        run_result = {}

        def run_request():
            try:
                with patch("xueness.core._run_subagent", side_effect=child_runner):
                    with inject_provider(provider=DeterministicProvider(), ctx=self.ctx):
                        run_result["response"] = self._request(
                            "/api/sessions/%s/run" % session_id,
                            {"provider": "real", "steps": 4, "max_wall_seconds": 40,
                             "mode": "plan", "allow_subagents": True}, timeout=45)
            except BaseException as error:  # surfaced by the assertions below
                run_result["error"] = repr(error)

        thread = threading.Thread(target=run_request, daemon=True)
        thread.start()
        self.addCleanup(lambda: (release_survivor.set(), resume_parent.set(),
                                 thread.join(timeout=5)))

        deadline = time.monotonic() + 25
        tasks = []
        while time.monotonic() < deadline:
            list_status, listed = self._request("/api/sessions/%s/tasks" % session_id)
            self.assertEqual(list_status, 200, listed)
            tasks = [task for task in listed.get("tasks", []) if task.get("status") == RUNNING]
            if len(tasks) == 2:
                break
            time.sleep(0.05)
        self.assertEqual(len(tasks), 2, "two subtasks must be running before a cancel: %r" % tasks)

        target = tasks[0]["id"]
        survivor = tasks[1]["id"]
        cancel_status, payload = self._request(
            "/api/sessions/%s/tasks/%s/cancel" % (session_id, target), body={})
        self.assertEqual(cancel_status, 200, payload)
        self.assertEqual(payload, {"cancelled": True, "taskId": target})
        resume_parent.set()

        # The parent keeps delegating and its sibling is untouched: the named
        # task flips to cancelled while the other one is still running.
        seen = {}
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            _, listed = self._request("/api/sessions/%s/tasks" % session_id)
            seen = {task["id"]: task["status"] for task in listed.get("tasks", [])}
            if seen.get(target) == CANCELLED and seen.get(survivor) == RUNNING:
                break
            time.sleep(0.05)
        self.assertEqual(seen.get(target), CANCELLED, seen)
        self.assertEqual(seen.get(survivor), RUNNING, seen)
        self.assertEqual(self.ctx["store"].load(session_id)["status"], "running",
                         "cancelling one subtask must not stop the parent session")

        thread.join(timeout=60)
        self.assertFalse(thread.is_alive(), "the HTTP run never finished: %r" % run_result)
        self.assertNotIn("error", run_result, run_result)
        run_status, result = run_result["response"]
        self.assertEqual(run_status, 200, result)
        self.assertTrue(outcomes.get("children_started"), outcomes)
        self.assertTrue(outcomes.get("parent_resumed_after_cancel"), outcomes)
        self.assertTrue(outcomes.get("cancelled_child_observed_flag"),
                        "the child never observed its own cancellation through the registry")

        statuses = {task["id"]: task["status"] for task in result.get("tasks", [])}
        self.assertEqual(statuses.get(target), CANCELLED, statuses)
        self.assertEqual(statuses.get(survivor), COMPLETED, statuses)
        # The parent still did its own independent work and produced a summary,
        # but a withdrawn child is deliberately reported as an unsuccessful
        # delegation: the run ends in needs_review instead of pretending the
        # cancelled finding still stands.
        checks = result["completion"]["delivery_checks"]["subagents"]
        self.assertEqual(result["status"], "needs_review", result)
        self.assertEqual(checks["status"], "failed", checks)
        self.assertEqual(checks["uncollected"], [], checks)
        self.assertEqual(checks["unsuccessful"], [target], checks)
        _, listed = self._request("/api/sessions/%s/tasks" % session_id)
        final = {task["id"]: task["status"] for task in listed.get("tasks", [])}
        self.assertEqual(final.get(target), CANCELLED, final)
        self.assertEqual(final.get(survivor), COMPLETED, final)


if __name__ == "__main__":
    unittest.main()
