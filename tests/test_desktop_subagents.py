"""Desktop HTTP integration for asynchronous subagent progress and collection.

The test uses the real in-process HTTP server and parent driver, but injects a
deterministic provider and a bounded child stub. It never resolves a paid model
or reads the user's configured state directory.
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tests.fake_provider_fixture import inject_provider
from xueness import web


class DesktopSubagentHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / "state"
        self.web_runs = base / "web-runs"
        self.project = base / "project"
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "local.txt").write_text(
            "parent-only independent inspection", encoding="utf-8")
        (self.project / "xueness" / "static").mkdir(parents=True)
        dist = self.project / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        self.csrf = "isolated-desktop-test-token"
        self.ctx = web.build_context(
            self.state, self.web_runs, self.project, allow_real=False,
            csrf=self.csrf, workspace_roots=(self.workspace,))
        self.server = web.create_server(0, self.ctx)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self._close_server)
        self.base_url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def _close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=3)

    def _request(self, path, data=None, timeout=10):
        body = json.dumps(data).encode("utf-8") if data is not None else None
        headers = {"X-CSRF-Token": self.csrf}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=headers,
            method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))

    def test_parent_progress_is_visible_before_background_result_collection(self):
        child_started = threading.Event()
        release_child = threading.Event()
        parent_waiting_to_collect = threading.Event()
        release_collection = threading.Event()
        outcomes = {}
        self.addCleanup(release_child.set)
        self.addCleanup(release_collection.set)

        class DeterministicProvider:
            model = "fixture-only"

            def __init__(self):
                self.calls = 0

            def complete(provider_self, messages, tools):
                provider_self.calls += 1
                names = [(tool.get("function") or {}).get("name") for tool in tools]
                outcomes["task_tools_offered"] = "task" in names and "task_collect" in names
                if provider_self.calls == 1:
                    return {"content": "", "tool_calls": [{
                        "id": "dispatch-child", "type": "function",
                        "function": {"name": "task", "arguments": json.dumps({
                            "prompt": "Inspect the workspace and report a bounded finding."})},
                    }]}
                if provider_self.calls == 2:
                    outcomes["child_started_before_parent_work"] = child_started.wait(3)
                    outcomes["child_was_still_blocked_during_parent_work"] = not release_child.is_set()
                    return {"content": "", "tool_calls": [{
                        "id": "read-independent", "type": "function",
                        "function": {"name": "read", "arguments": json.dumps({"path": "local.txt"})},
                    }]}
                if provider_self.calls == 3:
                    outcomes["parent_read_finished_before_collection"] = any(
                        message.get("role") == "tool"
                        and message.get("tool_call_id") == "read-independent"
                        and "parent-only independent inspection" in message.get("content", "")
                        for message in messages)
                    parent_waiting_to_collect.set()
                    release_collection.wait(timeout=8)
                    return {"content": "", "tool_calls": [{
                        "id": "collect-child", "type": "function",
                        "function": {"name": "task_collect", "arguments": json.dumps({
                            "wait_seconds": 5,
                            "reason": "dependency",
                            "detail": "Combine the completed child review with the parent's file inspection.",
                        })},
                    }]}
                if provider_self.calls == 4:
                    collected = next((message for message in messages
                                      if message.get("role") == "tool"
                                      and message.get("tool_call_id") == "collect-child"), None)
                    try:
                        result = json.loads(collected["content"]) if collected else {}
                    except (TypeError, ValueError):
                        result = {}
                    outcomes["collected_child_summary"] = (
                        result.get("tasks", [{}])[0].get("summary")
                        if result.get("tasks") else None)
                    outcomes["collection_not_evidence"] = result.get("evidence_eligible") is False
                    return {"content": json.dumps({
                        "summary": "Integrated the parent's independent inspection with the collected child finding.",
                        "evidence": [{
                            "tool_call_id": "read-independent",
                            "observation": "The parent read local.txt while the child was still running.",
                        }],
                    })}
                return {"content": json.dumps({"summary": "Unexpected extra provider request.", "evidence": []})}

        provider = DeterministicProvider()

        def child_runner(_gate, _provider, _agents, _prompt, _agent_name, **kwargs):
            task_id = kwargs["task_id"]
            kwargs["registry"].update(task_id, steps=1)
            child_started.set()
            if not release_child.wait(timeout=8):
                return {"ok": False, "task_id": task_id, "error": "test child timed out", "steps": 1}
            return {"ok": True, "task_id": task_id, "summary": "child-only bounded finding",
                    "steps": 2, "agent": None}

        status, session = self._request("/api/sessions", {
            "task": "Verify desktop subagent coordination over HTTP",
            "root": str(self.workspace),
        })
        self.assertEqual(status, 200, session)
        session_id = session["id"]
        run_result = {}

        def run_request():
            try:
                with patch("xueness.core._run_subagent", side_effect=child_runner):
                    with inject_provider(provider=provider, ctx=self.ctx):
                        run_result["response"] = self._request(
                            "/api/sessions/%s/run" % session_id,
                            {"provider": "real", "steps": 4, "max_wall_seconds": 20,
                             "mode": "plan", "allow_subagents": True}, timeout=25)
            except BaseException as error:  # surfaced by the assertions below
                run_result["error"] = repr(error)

        request_thread = threading.Thread(target=run_request, daemon=True)
        request_thread.start()
        self.addCleanup(lambda: (release_child.set(), release_collection.set(),
                                 request_thread.join(timeout=3)))

        self.assertTrue(parent_waiting_to_collect.wait(10),
                        "parent did not reach the collection boundary: %r %r calls=%s" %
                        (run_result, outcomes, provider.calls))
        progress_status, progress = self._request(
            "/api/sessions/%s/tasks" % session_id)
        self.assertEqual(progress_status, 200, progress)
        self.assertEqual(len(progress.get("tasks", [])), 1, progress)
        task = progress["tasks"][0]
        self.assertEqual(task["status"], "running", task)
        self.assertEqual(task["steps"], 1, task)
        self.assertTrue(task.get("workerActive"), task)

        # The parent has already read its own file. Releasing both barriers now
        # lets task_collect receive the child's result and finish the run.
        release_child.set()
        release_collection.set()
        request_thread.join(timeout=20)
        self.assertFalse(request_thread.is_alive(), "HTTP run did not finish")
        self.assertNotIn("error", run_result, run_result)
        run_status, payload = run_result["response"]
        self.assertEqual(run_status, 200, payload)
        self.assertEqual(payload["status"], "completed", payload)
        self.assertTrue(outcomes.get("task_tools_offered"), outcomes)
        self.assertTrue(outcomes.get("child_started_before_parent_work"), outcomes)
        self.assertTrue(outcomes.get("child_was_still_blocked_during_parent_work"), outcomes)
        self.assertTrue(outcomes.get("parent_read_finished_before_collection"), outcomes)
        self.assertEqual(outcomes.get("collected_child_summary"), "child-only bounded finding", outcomes)
        self.assertTrue(outcomes.get("collection_not_evidence"), outcomes)

        self.assertEqual(len(payload.get("tasks", [])), 1, payload)
        finished = payload["tasks"][0]
        self.assertEqual(finished["status"], "completed", finished)
        self.assertEqual(finished["summary"], "child-only bounded finding", finished)
        self.assertFalse(finished.get("workerActive"), finished)
        final_status, final_progress = self._request(
            "/api/sessions/%s/tasks" % session_id)
        self.assertEqual(final_status, 200, final_progress)
        self.assertEqual(final_progress["tasks"][0]["status"], "completed", final_progress)


if __name__ == "__main__":
    unittest.main()
