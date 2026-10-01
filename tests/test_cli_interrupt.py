"""Real SIGINTs at provider/approval/tool boundaries, with resumable journals."""
import io
import json
import signal
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.cli import main
from xueness.cli_interrupt import RunInterrupt
from xueness.core import Gate, Store, append_user_turn, run
from xueness.provider import FakeProvider


class InterruptTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)
        self.store = Store(self.root / "state")
        self.gate = Gate(self.root, allow_write=True)

    def test_provider_interrupt_discards_unrecorded_intent_then_resumes(self):
        s = self.store.new("demo", self.root)

        class InterruptedProvider(FakeProvider):
            def complete(self, messages, tools):
                signal.raise_signal(signal.SIGINT)
                signal.raise_signal(signal.SIGINT)
                return super().complete(messages, tools)

        with RunInterrupt(self.gate) as stop:
            out = run(s, self.store, InterruptedProvider(), self.gate, should_stop=stop.should_stop)
        self.assertEqual(out["status"], "stopped")
        self.assertEqual(out["steps"], 0)
        self.assertEqual(out["results"], {})
        self.assertFalse((self.root / "hello.txt").exists())
        out = run(self.store.load(s["id"]), self.store, FakeProvider(), self.gate)
        self.assertEqual(out["status"], "completed")

    def test_completed_tool_batch_survives_stop_even_at_step_limit(self):
        s = self.store.new("demo", self.root)
        events = []

        def observe(event):
            events.append(event)
            if event["type"] == "tool_result":
                signal.raise_signal(signal.SIGINT)

        with RunInterrupt(self.gate) as stop:
            out = run(s, self.store, FakeProvider(), self.gate, max_steps=1,
                      should_stop=stop.should_stop, on_event=observe)
        self.assertEqual(out["status"], "stopped")
        self.assertEqual(events[-1]["status"], "stopped")
        self.assertTrue(out["results"]["fixture-write"]["ok"])
        tool_messages = [m for m in out["messages"] if m["role"] == "tool"]
        self.assertEqual([m["tool_call_id"] for m in tool_messages], ["fixture-write"])
        out = run(self.store.load(s["id"]), self.store, FakeProvider(), self.gate)
        self.assertEqual(out["status"], "completed")
        self.assertEqual(len([m for m in out["messages"] if m.get("tool_call_id") == "fixture-write"]), 1)

    def test_approval_interrupt_is_denial_and_handler_is_restored(self):
        def prompt(label):
            signal.raise_signal(signal.SIGINT)
            self.fail("approval should be interrupted")

        gate = Gate(self.root, interactive=True, approval_prompt=prompt)
        original_handler = signal.getsignal(signal.SIGINT)
        s = self.store.new("demo", self.root)
        with RunInterrupt(gate) as stop:
            out = run(s, self.store, FakeProvider(), gate, should_stop=stop.should_stop)
        self.assertEqual(out["status"], "stopped")
        self.assertEqual(out["results"]["fixture-write"]["error"], "denied")
        self.assertFalse((self.root / "hello.txt").exists())
        self.assertIs(signal.getsignal(signal.SIGINT), original_handler)
        self.assertIs(gate.approval_prompt, prompt)

    def test_handler_restored_on_exception(self):
        handler = signal.getsignal(signal.SIGINT)
        with self.assertRaises(RuntimeError):
            with RunInterrupt(self.gate):
                raise RuntimeError("failure")
        self.assertIs(signal.getsignal(signal.SIGINT), handler)
        self.assertIsNone(self.gate.approval_prompt)

    def test_provider_error_after_stop_settles_cleanly(self):
        class BrokenProvider:
            def complete(self, *args):
                signal.raise_signal(signal.SIGINT)
                raise RuntimeError("request failed")

        s = self.store.new("demo", self.root)
        with RunInterrupt(self.gate) as stop:
            out = run(s, self.store, BrokenProvider(), self.gate, should_stop=stop.should_stop)
        self.assertEqual(out["status"], "stopped")
        self.assertEqual(out["steps"], 0)

    def test_stopped_session_accepts_new_user_direction(self):
        s = self.store.new("demo", self.root)
        run(s, self.store, FakeProvider(), self.gate, should_stop=lambda: True)
        out = append_user_turn(self.store.load(s["id"]), self.store, "Change the task")
        self.assertEqual(out["status"], "pending")
        self.assertEqual(out["messages"][-1]["content"], "Change the task")

    def test_chat_retry_resets_stop_and_does_not_duplicate_task(self):
        class OnceInterrupted(FakeProvider):
            first = True

            def complete(self, messages, tools):
                if self.first:
                    self.first = False
                    signal.raise_signal(signal.SIGINT)
                return super().complete(messages, tools)

        out = io.StringIO()
        with mock.patch("xueness.provider_config.resolve", return_value=OnceInterrupted()), \
                mock.patch("sys.stdin", io.StringIO("task\n/retry\n/exit\n")), \
                redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = main(["--state", str(self.store.directory), "chat", "--root", str(self.root),
                         "--allow-write"])
        self.assertEqual(code, 0)
        summary = json.loads(out.getvalue())
        self.assertEqual(summary["status"], "completed")
        s = self.store.load(summary["id"])
        self.assertEqual(len([m for m in s["messages"] if m["role"] == "user"]), 1)

    def test_run_interrupt_returns_exit_two_with_valid_stream_json(self):
        class Interrupted(FakeProvider):
            def complete(self, messages, tools):
                signal.raise_signal(signal.SIGINT)
                return super().complete(messages, tools)

        out = io.StringIO()
        with mock.patch("xueness.provider_config.resolve", return_value=Interrupted()), \
                redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = main(["--state", str(self.store.directory), "run", "--prompt", "task",
                         "--root", str(self.root), "--output-format", "stream-json"])
        self.assertEqual(code, 2)
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(events[-1]["type"], "summary")
        self.assertEqual(events[-1]["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
