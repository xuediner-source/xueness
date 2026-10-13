"""Real Pi child coverage with isolated loopback fixtures and host-owned tools."""
from __future__ import annotations

import io
import json
import sys
import threading
import time
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import patch

from tests import test_local_runtime_http as fixtures
from xueness.cli import main as cli_main
from xueness.bundled_plugins.runtimes import pi_sidecar
from xueness.bundled_plugins.runtimes.runtime import save_selection


class PiSessionTransportTests(unittest.TestCase):
    # Borrow setup and HTTP helpers without inheriting or rerunning their suite.
    setUp = fixtures.LocalRuntimeHttpTests.setUp
    _close_web = fixtures.LocalRuntimeHttpTests._close_web
    _request = fixtures.LocalRuntimeHttpTests._request
    _save_profile = fixtures.LocalRuntimeHttpTests._save_profile
    _new_session = fixtures.LocalRuntimeHttpTests._new_session
    _run = fixtures.LocalRuntimeHttpTests._run

    def _local_session(self, fixture, task):
        save_selection(self.state, "pi-lite")
        status, profile = self._save_profile(
            "pi-local", fixture.base_url, runtimeProfile="lightweight")
        self.assertEqual(200, status, profile)
        sid = self._new_session("pi-local", task=task)
        self.assertEqual("pi-lite", self.ctx["store"].load(sid)["runtime_mode"])
        return sid

    @contextmanager
    def _real_children(self):
        children = []

        def start(*args, **kwargs):
            child = pi_sidecar.start_local_provider(*args, **kwargs)
            self.assertGreater(child.status()["pid"], 0)
            children.append(child)
            self.addCleanup(child.close)
            return child

        with patch("xueness.bundled_plugins.runtimes.provider_transport.start_local_provider",
                   side_effect=start):
            yield children

    def _assert_children_stopped(self, children, expected):
        self.assertEqual(expected, len(children))
        self.assertTrue(all(child.status()["status"] == "stopped" for child in children),
                        [child.status() for child in children])

    def _assert_tool_pair(self, session, call_id):
        calls = [call for message in session["messages"]
                 for call in message.get("tool_calls", []) if call.get("id") == call_id]
        messages = [message for message in session["messages"]
                    if message.get("role") == "tool" and message.get("tool_call_id") == call_id]
        self.assertEqual(1, len(calls))
        self.assertEqual(1, len(messages))
        self.assertEqual(session["results"][call_id], json.loads(messages[0]["content"]))

    def test_bundled_child_read_preserves_tool_pair_and_stream_replay(self):
        (self.workspace / "notes.txt").write_text("Pi transport proof\n", encoding="utf-8")
        final = json.dumps({"summary": "Read the local file", "evidence": [{
            "tool_call_id": "pi-read", "observation": "The read tool succeeded.",
        }]})
        fixture = fixtures.ChatFixture(lambda _body, index: {
            "tool_calls": [{"id": "pi-read", "type": "function", "function": {
                "name": "read", "arguments": '{"path":"notes.txt"}',
            }}],
        } if index == 0 else {"content": final})
        self.addCleanup(fixture.close)
        sid = self._local_session(fixture, "Read notes.txt")

        with self._real_children() as children:
            status, result = self._run(sid)
        self.assertEqual(200, status, result)
        self.assertEqual("completed", result["status"], result)
        saved = self.ctx["store"].load(sid)
        self._assert_tool_pair(saved, "pi-read")
        self.assertTrue(saved["results"]["pi-read"]["ok"])
        self.assertTrue(any(row.get("text") == final and row.get("status") == "completed"
                            for row in saved["stream_history"]))
        self.assertEqual(2, len(fixture.requests))
        self._assert_children_stopped(children, 2)

    def test_child_write_requires_exact_host_approval_and_replays_once(self):
        final = json.dumps({"summary": "Wrote the approved file", "evidence": [{
            "tool_call_id": "pi-write", "observation": "The write tool succeeded.",
        }]})
        fixture = fixtures.ChatFixture(lambda _body, index: {
            "tool_calls": [{"id": "pi-write", "type": "function", "function": {
                "name": "write", "arguments": json.dumps({
                    "path": "approved.txt", "content": "approved once\n",
                }),
            }}],
        } if index == 0 else {"content": final})
        self.addCleanup(fixture.close)
        sid = self._local_session(fixture, "Write approved.txt after exact approval")
        target = self.workspace / "approved.txt"

        with self._real_children() as children:
            status, denied = self._run(sid)
            self.assertEqual(200, status, denied)
            self.assertEqual("paused", denied["status"], denied)
            self.assertFalse(target.exists())
            pending = next(row for row in denied["pending"]
                           if row["tool_call_id"] == "pi-write")
            saved = self.ctx["store"].load(sid)
            self._assert_tool_pair(saved, "pi-write")
            self.assertEqual("denied", saved["results"]["pi-write"]["error"])

            approval = {"kind": "write", "subject": pending["subject"],
                        "tool_call_id": "pi-write"}
            status, granted = self._request("POST", f"/api/sessions/{sid}/approvals", approval)
            self.assertEqual(200, status, granted)
            status, resumed = self._run(sid)
            self.assertEqual(200, status, resumed)
            saved = self.ctx["store"].load(sid)
            self._assert_tool_pair(saved, "pi-write")
            self.assertTrue(saved["results"]["pi-write"]["ok"])
            self.assertEqual("approved once\n", target.read_text(encoding="utf-8"))
            self.assertFalse(self.ctx["approvals"].get(sid, {}).get("write", {}))
            status, replay = self._request("POST", f"/api/sessions/{sid}/approvals", approval)
            self.assertEqual(400, status, replay)

        self.assertEqual(2, len(fixture.requests))
        self._assert_children_stopped(children, 2)

    def test_stop_terminates_blocked_child_without_fabricated_message(self):
        entered, release = threading.Event(), threading.Event()

        def blocked(_body, _index):
            entered.set()
            release.wait(12)
            return {"content": "late fixture reply"}

        fixture = fixtures.ChatFixture(blocked)
        original_error = fixture.server.handle_error

        def connection_error(request, address):
            # Stop deliberately kills the HTTP client before this fixture replies.
            if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
                original_error(request, address)

        fixture.server.handle_error = connection_error
        self.addCleanup(fixture.close)
        self.addCleanup(release.set)
        sid = self._local_session(fixture, "Wait for the local provider")
        response = {}

        def run():
            try:
                response["result"] = self._run(sid)
            except Exception as exc:
                response["error"] = exc

        with self._real_children() as children:
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(6), "bundled child did not reach the fixture")
                started = time.monotonic()
                status, stopped = self._request("POST", f"/api/sessions/{sid}/stop", {})
                self.assertEqual(200, status, stopped)
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive(), "stop did not interrupt the provider child")
                self.assertLess(time.monotonic() - started, 5)
                self.assertNotIn("error", response, response)
                status, result = response["result"]
                self.assertEqual(200, status, result)
                self.assertEqual("stopped", result["status"], result)
            finally:
                release.set()
                worker.join(timeout=5)

        saved = self.ctx["store"].load(sid)
        self.assertFalse(any(message.get("role") == "assistant"
                             for message in saved["messages"]), saved["messages"])
        self.assertFalse(saved.get("results"))
        self.assertNotIn("late fixture reply", json.dumps(saved))
        self.assertNotIn(sid, self.ctx["running"])
        self._assert_children_stopped(children, 1)

    def test_cli_reads_through_bundled_child_and_persists_tool_pair(self):
        (self.workspace / "cli.txt").write_text("CLI transport proof\n", encoding="utf-8")
        final = json.dumps({"summary": "Read the local file", "evidence": [{
            "tool_call_id": "pi-cli-read", "observation": "The read tool succeeded.",
        }]})
        fixture = fixtures.ChatFixture(lambda _body, index: {
            "tool_calls": [{"id": "pi-cli-read", "type": "function", "function": {
                "name": "read", "arguments": '{"path":"cli.txt"}',
            }}],
        } if index == 0 else {"content": final})
        self.addCleanup(fixture.close)
        save_selection(self.state, "pi-lite")
        status, profile = self._save_profile(
            "pi-local", fixture.base_url, runtimeProfile="lightweight")
        self.assertEqual(200, status, profile)
        stdout, stderr = io.StringIO(), io.StringIO()

        with self._real_children() as children, redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main([
                "--state", str(self.state), "run", "--prompt", "Read cli.txt",
                "--root", str(self.workspace), "--provider-id", "pi-local",
                "--steps", "4", "--output-format", "json",
            ])
        self.assertEqual(0, code, stderr.getvalue())
        result = json.loads(stdout.getvalue())
        self.assertEqual("completed", result["status"], result)
        saved = self.ctx["store"].load(result["id"])
        self.assertEqual("pi-lite", saved["runtime_mode"])
        self._assert_tool_pair(saved, "pi-cli-read")
        self.assertTrue(saved["results"]["pi-cli-read"]["ok"])
        self.assertEqual(2, len(fixture.requests))
        self._assert_children_stopped(children, 2)


if __name__ == "__main__":
    unittest.main()
