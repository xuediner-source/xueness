"""Batch 12: agent-CLI streaming and chat loop.

Covers:
* ``core.run(on_event=...)`` — the structured live-event stream (assistant,
  tool_call, tool_result, status) emitted at the same vocabulary as
  ``session_events``, additive to the existing ``on_step`` contract,
* ``run --stream`` — live events on stderr while stdout keeps the exact
  machine-readable summary,
* ``chat`` — the multi-turn REPL: turns append and run, /exit ends, EOF ends,
  a pending question consumes the next line as its answer.
"""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.cli import main as cli_main
from xueness.core import Gate, Store, run
from xueness.provider import FakeProvider


class OnEventStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "state")

    def tearDown(self):
        self.temp.cleanup()

    def test_event_sequence_for_fake_demo(self):
        s = self.store.new("Create hello.txt then verify its content", self.root)
        events = []
        out = run(self.store.load(s["id"]), self.store, FakeProvider(),
                  Gate(self.root, allow_write=True), on_event=events.append)
        self.assertEqual(out["status"], "completed")
        types = [e["type"] for e in events]
        # Live vocabulary matches session_events; every tool call is followed
        # by exactly one result with the same id.
        self.assertIn("assistant", types)
        self.assertIn("tool_call", types)
        self.assertIn("tool_result", types)
        calls = [e for e in events if e["type"] == "tool_call"]
        results = [e for e in events if e["type"] == "tool_result"]
        self.assertEqual([c["id"] for c in calls], [r["id"] for r in results])
        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual(events[-1]["type"], "status")
        self.assertEqual(events[-1]["status"], "completed")
        self.assertTrue(events[-1]["verified"])
        # write call carries its subject (the raw arguments head)
        write_call = next(c for c in calls if c["name"] == "write")
        self.assertIn("hello.txt", write_call["subject"])

    def test_on_event_failure_never_breaks_the_run(self):
        s = self.store.new("Create hello.txt then verify its content", self.root)

        def exploding(event):
            raise RuntimeError("observer is broken")

        out = run(self.store.load(s["id"]), self.store, FakeProvider(),
                  Gate(self.root, allow_write=True), on_event=exploding)
        self.assertEqual(out["status"], "completed")

    def test_on_step_contract_unchanged(self):
        # The task registry mirrors runs through on_step(steps); adding
        # on_event must not have moved that positional/keyword surface.
        s = self.store.new("Create hello.txt then verify its content", self.root)
        steps_seen = []
        run(self.store.load(s["id"]), self.store, FakeProvider(),
            Gate(self.root, allow_write=True), on_step=steps_seen.append)
        self.assertTrue(steps_seen)
        self.assertTrue(all(isinstance(n, int) for n in steps_seen))


class StreamFlagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)

    def tearDown(self):
        self.temp.cleanup()

    def test_stream_goes_to_stderr_stdout_stays_json(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            code = cli_main(["--state", str(self.root / "state"), "run", "--prompt", "t",
                             "--root", str(self.root), "--allow-write", "--stream"])
        self.assertEqual(code, 0)
        # stdout: the whole summary is exactly one JSON document.
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["status"], "completed")
        self.assertIn("id", payload)
        # stderr: the live trail — tool intent, result marker, settle line.
        err = stderr.getvalue()
        self.assertIn("→ write", err)
        self.assertIn("✓ write", err)
        self.assertIn("== completed", err)

    def test_without_stream_stderr_stays_quiet_of_events(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            code = cli_main(["--state", str(self.root / "state"), "run", "--prompt", "t",
                             "--root", str(self.root), "--allow-write"])
        self.assertEqual(code, 0)
        self.assertNotIn("→ write", stderr.getvalue())
        json.loads(stdout.getvalue())


class ChatLoopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = str(self.root / "state")
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            cli_main(["--state", self.state, "new", "Create hello.txt then verify its content",
                      "--root", str(self.root)])
        self.sid = stdout.getvalue().strip()

    def tearDown(self):
        self.temp.cleanup()

    def _chat(self, lines):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout), \
                mock.patch("sys.stdin", io.StringIO("\n".join(lines) + "\n")):
            code = cli_main(["--state", self.state, "chat", self.sid,
                             "--allow-write"])
        return code, stderr.getvalue(), stdout.getvalue()

    def test_single_turn_then_exit(self):
        code, err, out = self._chat(["帮我写一个文件", "/exit"])
        self.assertEqual(code, 0)
        # The turn was journaled and the fake demo streamed its steps.
        journal = json.loads(Path(self.state, f"{self.sid}.json").read_text())
        user_turns = [m for m in journal["messages"] if m.get("role") == "user"]
        self.assertTrue(any("帮我写一个文件" in (m.get("content") or "") for m in user_turns))
        self.assertIn("→ write", err)
        self.assertIn("== completed", err)
        # Final summary lands on stdout for scripting.
        payload = json.loads(out)
        self.assertEqual(payload["id"], self.sid)

    def test_exit_and_empty_lines(self):
        code, err, out = self._chat(["", "  ", "/exit"])
        self.assertEqual(code, 0)
        journal = json.loads(Path(self.state, f"{self.sid}.json").read_text())
        user_turns = [m for m in journal["messages"] if m.get("role") == "user"]
        # Only the initial task turn exists; empty lines added nothing.
        self.assertEqual(len(user_turns), 1)

    def test_pending_question_consumes_next_line_as_answer(self):
        # Simulate a tool-driven question the way ask_user would leave one.
        s = json.loads(Path(self.state, f"{self.sid}.json").read_text())
        s["pending_question"] = "要继续部署吗？"
        s["status"] = "awaiting_user"
        Path(self.state, f"{self.sid}.json").write_text(json.dumps(s, ensure_ascii=False))
        code, err, _ = self._chat(["好的，继续", "/exit"])
        self.assertEqual(code, 0)
        self.assertIn("问题: 要继续部署吗？", err)
        self.assertIn("已回答", err)
        journal = json.loads(Path(self.state, f"{self.sid}.json").read_text())
        self.assertEqual(journal["status"], "completed")
        self.assertIsNone(journal.get("pending_question"))


if __name__ == "__main__":
    unittest.main()
