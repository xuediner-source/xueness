"""Fork only revision-bound, complete session turns into inert new sessions."""
from __future__ import annotations

import argparse
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import web
from xueness.core import Store, Gate, run, answer_session
from xueness.session_lease import lease
from xueness.bundled_plugins.sessions import forking
from xueness.bundled_plugins.sessions.operator_cli import add_session_parsers, execute
from xueness.bundled_plugins.sessions.sessions_api import dispatch


class SessionForkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "project"
        self.workspace = self.project / "workspace"
        self.workspace.mkdir(parents=True)
        self.runs = self.base / "web-runs"
        self.state = self.base / "state"
        self.store = Store(self.state)
        self.ctx = web.build_context(self.state, self.runs, self.project, csrf="fork-test")
        self.source = self.store.new("Inspect the workspace", self.workspace)
        self.source["messages"][1] = {"role": "user", "content": "First closed turn"}
        self.source.update({
            "title": "Source session",
            "model_selection": {"provider_id": "fixture", "model": "model-a",
                                "reasoning_effort": "medium"},
            "runtime_profile": "lightweight",
            "runtime_budget": {"activeTools": 4, "safetyReserveTokens": 16},
            "runtime_activity": {"phase": "generating", "outputChars": 7,
                                 "requestSeconds": 0.25, "secret": "discard me"},
            "runtime_activity_history": [
                {"phase": "completed", "requestStep": step, "private": "discard me"}
                for step in range(25)
            ],
            "provider_usage": [{"secret": "discard me"}],
            "steps": 9,
            "completion": {"verified": True, "summary": "source completion"},
            "pending_question": None,
            "pending_approvals": [{"secret": "approval"}],
            "approved": {"write": ["old-call"]},
            "grant_plugin_capability": ["dangerous"],
            "hook_log": [{"secret": "hook"}],
            "task_runs": [{"secret": "task"}],
            "remote_connection": {"id": "remote-secret", "digest": "x" * 64},
            "permission_mode": "yolo",
            "streaming": None,
        })
        self.source["messages"].extend([
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "call-read-1", "type": "function",
                "function": {"name": "read", "arguments": '{"path":"notes.txt"}'},
            }]},
            {"role": "tool", "tool_call_id": "call-read-1",
             "content": '{"ok":true,"text":"read output"}'},
            {"role": "assistant", "content": "Read completed."},
            {"role": "user", "content": "A later request that is still open"},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "call-denied-tail", "type": "function",
                "function": {"name": "write", "arguments": '{"path":"new.txt","content":"x"}'},
            }]},
            {"role": "tool", "tool_call_id": "call-denied-tail",
             "content": '{"ok":false,"error":"denied"}'},
        ])
        self.source["results"] = {
            "call-read-1": {"ok": True, "text": "read output"},
            "call-denied-tail": {"ok": False, "error": "denied"},
            "unreferenced-secret": {"ok": True, "secret": "do not copy"},
        }
        self.store.save(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def _call(self, method, parts, data=None, ctx=None):
        return dispatch(method, ["api", "sessions", *parts], {}, data or {}, ctx or self.ctx)

    def test_api_forks_closed_prefix_without_execution_state_or_source_write(self):
        path = self.store._path(self.source["id"])
        before = path.read_bytes()
        status, listed = self._call("GET", [self.source["id"], "fork-boundaries"])
        self.assertEqual(200, status, listed)
        self.assertEqual(self.source["id"], listed["sourceId"])
        self.assertEqual([1], [row["turn"] for row in listed["boundaries"]])
        self.assertTrue(listed["hasUnclosedTurn"])
        boundary = listed["boundaries"][0]

        status, bad = self._call("POST", [self.source["id"], "fork"], {
            "revision": listed["revision"], "boundary": boundary["token"],
            "endIndex": boundary["endIndex"],
        })
        self.assertEqual(400, status)
        self.assertIn("expected", bad["error"])

        status, response = self._call("POST", [self.source["id"], "fork"], {
            "revision": listed["revision"], "boundary": boundary["token"],
            "title": "A reviewable fork",
        })
        self.assertEqual(201, status, response)
        child = self.store.load(response["session"]["id"])
        self.assertNotEqual(self.source["id"], child["id"])
        self.assertEqual("pending", child["status"])
        self.assertEqual(str(self.workspace.resolve()), child["root"])
        self.assertEqual("A reviewable fork", child["title"])
        self.assertEqual(["system", "user", "assistant", "tool", "assistant"],
                         [message["role"] for message in child["messages"]])
        self.assertEqual({"call-read-1": {"ok": True, "text": "read output"}}, child["results"])
        self.assertEqual(0, child["steps"])
        self.assertIsNone(child["completion"])
        self.assertIsNone(child["pending_question"])
        self.assertEqual({"provider_id": "fixture", "model": "model-a",
                          "reasoning_effort": "medium"}, child["model_selection"])
        self.assertEqual("lightweight", child["runtime_profile"])
        for field in ("runtime_budget", "provider_usage", "pending_approvals", "approved",
                      "grant_plugin_capability", "hook_log", "task_runs", "remote_connection",
                      "runtime_activity", "runtime_activity_history", "permission_mode",
                      "streaming", "approval_log", "archived_messages"):
            if field == "archived_messages":
                self.assertEqual([], child[field])
            else:
                self.assertNotIn(field, child)
        self.assertEqual([], web.pending_denials(child))
        self.assertEqual(response["forkParent"], child["fork_parent"])
        self.assertEqual(before, path.read_bytes(), "forking must not rewrite the source journal")

    def test_completed_denial_in_selected_prefix_is_not_offered(self):
        self.source["messages"] = self.source["messages"][:6]
        self.source["results"].pop("call-denied-tail", None)
        self.source["messages"].extend([
            {"role": "user", "content": "A closed request with a denied action"},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "call-denied-complete", "type": "function",
                "function": {"name": "exec", "arguments": '{"argv":["rm","file"]}'},
            }]},
            {"role": "tool", "tool_call_id": "call-denied-complete",
             "content": '{"ok":false,"error":"denied"}'},
            {"role": "assistant", "content": "The action needs approval."},
        ])
        self.source["results"]["call-denied-complete"] = {"ok": False, "error": "denied"}
        self.source["status"] = "needs_review"
        self.store.save(self.source)
        listed = forking.get_boundaries(self.ctx, self.source["id"])
        self.assertEqual([1], [row["turn"] for row in listed["boundaries"]])
        # An unoffered selector cannot be synthesized from the exposed end index.
        with self.assertRaises(forking.ForkError):
            forking.fork_at(self.ctx, self.source["id"], revision=listed["revision"],
                            boundary_token="fb1-" + "0" * 64)

    def test_answered_model_question_can_fork_at_the_completed_answer_turn(self):
        from tests.test_lightweight_runtime import ScriptedProvider, call
        session = self.store.new('Choose a direction', self.workspace)
        provider = ScriptedProvider([call('ask_user', {'question': 'Which direction?'})])
        session = run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        self.assertEqual(session['status'], 'awaiting_user')
        session = answer_session(session, self.store, 'Inspect only')
        provider = ScriptedProvider([{'content': 'I will inspect only.'}])
        run(session, self.store, provider, Gate(self.workspace), max_steps=1)
        listed = forking.get_boundaries(self.ctx, session['id'])
        self.assertEqual([2], [item['turn'] for item in listed['boundaries']])
        child = forking.fork_at(self.ctx, session['id'], revision=listed['revision'],
                               boundary_token=listed['boundaries'][0]['token'])
        copied = self.store.load(child['session']['id'])
        self.assertIsNone(copied['pending_question'])
        self.assertIn('Operator answer: Inspect only', json.dumps(copied['messages']))

    def test_compaction_archive_is_never_spliced_and_summary_is_dropped(self):
        self.source["messages"].insert(1, {
            "role": "system", "content": "Older history compacted; future turn summary"
        })
        self.source["archived_messages"] = [
            {"role": "user", "content": "old row with no reliable order"},
            {"role": "assistant", "content": "future summary row"},
        ]
        self.source["compactions"] = [{"removed": 4, "masked": 1}]
        self.store.save(self.source)
        listed = forking.get_boundaries(self.ctx, self.source["id"])
        self.assertTrue(listed["historyTruncated"])
        self.assertIsInstance(listed["truncationReason"], str)
        child = forking.fork_at(self.ctx, self.source["id"],
                                revision=listed["revision"],
                                boundary_token=listed["boundaries"][0]["token"])
        session = self.store.load(child["session"]["id"])
        self.assertTrue(session["fork_parent"]["historyTruncated"])
        self.assertTrue(all(not (m["role"] == "system" and m["content"].startswith("Older history compacted;"))
                            for m in session["messages"]))
        self.assertNotIn("unreliable order", json.dumps(session["messages"]))

    def test_revision_change_running_flag_and_cross_process_lease_refuse_fork(self):
        listed = forking.get_boundaries(self.ctx, self.source["id"])
        changed = dict(self.source)
        changed["title"] = "Changed after GET"
        self.store.save(changed)
        with self.assertRaisesRegex(forking.ForkError, "changed") as changed_error:
            forking.fork_at(self.ctx, self.source["id"], revision=listed["revision"],
                            boundary_token=listed["boundaries"][0]["token"])
        self.assertEqual(409, changed_error.exception.status)

        self.ctx["running"].add(self.source["id"])
        with self.assertRaisesRegex(forking.ForkError, "run already") as running_error:
            forking.get_boundaries(self.ctx, self.source["id"])
        self.assertEqual(409, running_error.exception.status)
        self.ctx["running"].clear()

        with lease(self.store, self.source["id"]):
            with self.assertRaisesRegex(forking.ForkError, "another process") as lease_error:
                forking.get_boundaries(self.ctx, self.source["id"])
        self.assertEqual(409, lease_error.exception.status)

    def test_web_workspace_allowlist_is_rechecked_before_listing(self):
        outside = self.base / "outside-workspace"
        outside.mkdir()
        self.source["root"] = str(outside)
        self.store.save(self.source)
        with self.assertRaisesRegex(forking.ForkError, "no longer permitted") as rejected:
            forking.get_boundaries(self.ctx, self.source["id"])
        self.assertEqual(403, rejected.exception.status)

    def test_cli_fork_defaults_to_latest_safe_turn(self):
        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers(dest="cmd")
        add_session_parsers(sub)
        args = parser.parse_args(["sessions", "fork", self.source["id"]])
        result = execute(args, self.store)
        child = self.store.load(result["session"]["id"])
        self.assertEqual(1, result["boundary"]["turn"])
        self.assertEqual("pending", child["status"])
        self.assertEqual(str(self.workspace.resolve()), child["root"])

    def test_real_http_get_then_post_and_new_session_detail_provenance(self):
        dist = self.project / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>fork test</title>", encoding="utf-8")
        (dist / "assets" / "app.js").write_text("", encoding="utf-8")
        server = web.create_server(0, self.ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=2)))
        base = f"http://127.0.0.1:{server.server_port}"

        def request(method, path, body=None, csrf=None):
            raw = json.dumps(body).encode("utf-8") if body is not None else None
            headers = {"X-CSRF-Token": csrf} if csrf else {}
            if body is not None:
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(base + path, data=raw, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    return response.status, json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read() or b"{}")

        _, csrf = request("GET", "/api/csrf")
        self.source["runtime_activity"] = {
            "phase": "generating", "outputChars": 9, "rawContent": "never public",
        }
        self.source["runtime_budget"]["safetyReserveTokens"] = 16
        self.store.save(self.source)
        status, source_detail = request("GET", f"/api/sessions/{self.source['id']}")
        self.assertEqual(200, status, source_detail)
        self.assertEqual({"phase": "generating", "outputChars": 9},
                         source_detail["runtime_activity"])
        self.assertEqual(16, source_detail["runtime_budget"]["safetyReserveTokens"])
        self.assertEqual(24, len(source_detail["runtime_activity_history"]))
        self.assertTrue(all("private" not in row for row in source_detail["runtime_activity_history"]))
        status, listed = request("GET", f"/api/sessions/{self.source['id']}/fork-boundaries")
        self.assertEqual(200, status, listed)
        status, forked = request("POST", f"/api/sessions/{self.source['id']}/fork", {
            "revision": listed["revision"], "boundary": listed["boundaries"][0]["token"],
        }, csrf["csrfToken"])
        self.assertEqual(201, status, forked)
        child_id = forked["session"]["id"]
        status, detail = request("GET", f"/api/sessions/{child_id}")
        self.assertEqual(200, status, detail)
        self.assertEqual(forked["forkParent"], detail["forkParent"])
        self.assertEqual([], detail["pending"])

        # A new turn is accepted even though the source still has a denied,
        # unfinished action. Its pending approval was never copied.
        status, appended = request("POST", f"/api/sessions/{child_id}/messages",
                                  {"text": "Continue from the selected point"}, csrf["csrfToken"])
        self.assertEqual(200, status, appended)
        self.assertEqual("pending", self.store.load(child_id)["status"])


if __name__ == "__main__":
    unittest.main()
