"""Daily CLI entry: lazy creation, workspace resume and interactive boundaries."""
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from xueness.cli import main
from xueness.core import Store


class ChatEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.store = Store(self.state)
        from tests.fake_provider_fixture import patch_provider_resolution
        self.provider_patch = patch_provider_resolution(self)

    def invoke(self, args, text=""):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(text)):
            try:
                code = main(["--state", str(self.state), *args])
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def chat(self, *args, text=""):
        return self.invoke(["chat", "--root", str(self.root), *args], text)

    def test_first_prompt_is_task_without_duplicate_turn(self):
        code, out, err = self.chat(text="create demo\ny\n/exit\n")
        self.assertEqual(code, 0, err)
        summary = json.loads(out)
        self.assertEqual(summary["status"], "completed")
        self.assertIn("Approve write", err)
        self.assertEqual((self.root / "hello.txt").read_text(), "Xueness demo\n")
        session = self.store.load(summary["id"])
        self.assertEqual([m["content"] for m in session["messages"] if m["role"] == "user"], ["create demo"])

    def test_default_entry_and_help_exit_do_not_create_session_or_provider(self):
        with mock.patch("xueness.provider_config.resolve") as provider:
            code, out, err = self.invoke([], "/help\n/status\n/exit\n")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, "")
        self.assertIn("/mode", err)
        self.assertEqual(self.store.list(), [])
        provider.assert_not_called()

    def test_fullscreen_chat_falls_back_with_selected_language(self):
        code, out, err = self.invoke(["--language", "en", "chat", "--root", str(self.root),
                                      "--tui"], "/exit\n")
        self.assertEqual(code, 0, err)
        self.assertIn("Fullscreen terminal unavailable", err)
        self.assertIn("workspace", err)
        self.assertEqual(out, "")

    def test_mode_change_is_local_and_plan_still_denies_blanket_write(self):
        code, out, err = self.chat("--allow-write", text="/mode plan\ncreate demo\n/exit\n")
        s = self.store.load(json.loads(out)["id"])
        self.assertEqual(code, 0, err)
        self.assertEqual(s["mode"], "plan")
        self.assertFalse((self.root / "hello.txt").exists())
        self.assertNotIn("Approve write", err)
        self.assertEqual(len([m for m in s["messages"] if m["role"] == "user"]), 1)

    def test_continue_uses_latest_matching_workspace_and_preserves_plan(self):
        older = self.store.new("older", self.root)
        newest = self.store.new("newest", self.root)
        newest["mode"] = "plan"
        self.store.save(newest)
        other = self.store.new("other", self.root / "elsewhere")
        os.utime(self.store._path(older["id"]), ns=(10, 10))
        os.utime(self.store._path(newest["id"]), ns=(20, 20))
        os.utime(self.store._path(other["id"]), ns=(30, 30))
        # Broken/symlinked state must not hijack the continuation selector.
        (self.state / ("a" * 32 + ".json")).write_text("[]")
        (self.state / ("b" * 32 + ".json")).symlink_to(self.store._path(other["id"]))
        code, out, err = self.chat("--continue", text="/retry\n/exit\n")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["id"], newest["id"])
        self.assertEqual(json.loads(out)["mode"], "plan")
        self.assertFalse((self.root / "hello.txt").exists())

    def test_continue_without_match_and_invalid_flags_leave_no_journal(self):
        for flags in (("--continue",), ("--steps", "0"), ("--disallow-tools", "invalid")):
            code, _, _ = self.chat(*flags, text="task\n")
            self.assertEqual(code, 2)
            self.assertEqual(self.store.list(), [])

    def test_eof_at_approval_denies_and_stdout_remains_json(self):
        code, out, err = self.chat(text="task\n")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["status"], "needs_review")
        self.assertFalse((self.root / "hello.txt").exists())

    def test_non_interactive_never_consumes_following_input_as_approval(self):
        code, out, err = self.chat("--non-interactive", text="task\n/exit\n")
        self.assertEqual(code, 0, err)
        json.loads(out)
        self.assertNotIn("Approve write", err)
        self.assertFalse((self.root / "hello.txt").exists())

    def test_retry_continues_step_limited_run_without_duplicate_user_turn(self):
        code, out, err = self.chat("--steps", "1", "--allow-write", text="task\n/retry\n/retry\n/exit\n")
        self.assertEqual(code, 0, err)
        s = self.store.load(json.loads(out)["id"])
        self.assertEqual(s["status"], "completed")
        self.assertEqual(len([m for m in s["messages"] if m["role"] == "user"]), 1)

    def test_exit_while_awaiting_does_not_become_an_answer(self):
        s = self.store.new("task", self.root)
        s.update(status="awaiting_user", pending_question="Choose a color")
        self.store.save(s)
        code, out, err = self.invoke(["chat", s["id"]], "/help\n/exit\n")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["status"], "awaiting_user")
        self.assertEqual(self.store.load(s["id"])["pending_question"], "Choose a color")

    def test_custom_command_expands_first_task_and_records_invocation(self):
        directory = self.state / "resources" / "commands"
        directory.mkdir(parents=True)
        (directory / "greet.json").write_text(json.dumps({"id": "greet", "content": "Hello $ARGUMENTS"}))
        code, out, err = self.chat("--allow-write", text="/greet world\n/exit\n")
        self.assertEqual(code, 0, err)
        s = self.store.load(json.loads(out)["id"])
        self.assertEqual(s["task"], "Hello world")
        self.assertEqual(s["command_invocations"], [{"command": "greet", "args": "world"}])

    def test_interactive_run_keeps_stream_json_parseable(self):
        code, out, err = self.invoke(["run", "--prompt", "task", "--root", str(self.root),
                                      "--interactive", "--output-format", "stream-json"], "y\n")
        self.assertEqual(code, 0, err)
        events = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(events[-1]["status"], "completed")
        self.assertIn("Approve write", err)

    def test_launcher_uses_callers_workspace_from_outside_checkout(self):
        launcher = Path(__file__).resolve().parents[1] / "bin" / "xueness"
        proc = subprocess.run([str(launcher), "--state", str(self.state), "chat"],
                              cwd=self.root, input="/status\n/exit\n", text=True,
                              capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(str(self.root.resolve()), proc.stderr)
        self.assertEqual(self.store.list(), [])

    def test_missing_provider_fails_before_creating_session(self):
        self.provider_patch.stop()
        with mock.patch.dict(os.environ, {"XUENESS_API_BASE": "", "XUENESS_MODEL": "", "XUENESS_API_KEY": ""}):
            code, _, err = self.invoke(["chat", "--root", str(self.root)], "task\n")
        self.provider_patch.start()
        self.assertEqual(code, 2, err)
        self.assertEqual(self.store.list(), [])


if __name__ == "__main__":
    unittest.main()
