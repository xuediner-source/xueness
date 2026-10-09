import json
import os
import tempfile
import unittest
import urllib.request
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch
from pathlib import Path
from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from tests.secret_permissions import assert_secret_file_private
from xueness.core import Gate, Store, answer_session, assess, compact, execute, normalize_todos, run, session_events
from xueness.provider import FakeProvider, OpenAICompatible, _NoRedirect


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "state")
        self._provider_patch = patch("xueness.provider_config.resolve", return_value=FakeProvider())
        self._provider_patch.start()
        self.addCleanup(self._provider_patch.stop)

    def tearDown(self):
        self.temp.cleanup()

    def test_persist_resume_and_evidence(self):
        s = self.store.new("demo", self.root)
        loaded = self.store.load(s["id"])
        self.assertEqual(loaded["task"], "demo")
        paused = run(loaded, self.store, FakeProvider(), Gate(self.root, allow_write=True), max_steps=1)
        self.assertEqual(paused["status"], "paused")
        complete = run(self.store.load(s["id"]), self.store, FakeProvider(), Gate(self.root, allow_write=True))
        self.assertEqual(complete["status"], "completed")
        self.assertTrue(complete["completion"]["verified"])
        self.assertEqual((self.root / "hello.txt").read_text(), "Xueness demo\n")
        self.assertEqual(len(self.store.list()), 1)

    def test_gate_and_path_escape(self):
        gate = Gate(self.root)
        self.assertTrue(execute(self.root, gate, "list", {"path": "."})["ok"])
        self.assertFalse(execute(self.root, gate, "write", {"path": "x", "content": "x"})["ok"])
        self.assertFalse(execute(self.root, gate, "exec", {"argv": ["python3", "-V"]})["ok"])
        self.assertFalse(execute(self.root, gate, "read", {"path": "../outside"})["ok"])
        self.assertFalse(execute(self.root, Gate(self.root, allow_write=True), "write", {"path": "../escape", "content": "x"})["ok"])
        self.assertFalse(execute(self.root, gate, "unknown", {})["ok"])
        self.assertTrue(execute(self.root, Gate(self.root, allow_exec=True), "exec", {"argv": ["python3", "-c", "print(7)"]})["ok"])

    def test_compaction_and_invalid_evidence(self):
        s = self.store.new("long", self.root)
        for i in range(10):
            s["messages"].append({"role": "assistant", "content": "", "tool_calls": [{"id": str(i)}]})
            s["messages"].append({"role": "tool", "content": "a" * 900, "tool_call_id": str(i)})
        compact(s, 1100)
        self.assertEqual(len(s["compactions"]), 1)
        self.assertIn("estimatedTokens", s["compactions"][0])
        self.assertEqual(s["compactions"][0]["estimatedTokens"], s["compactions"][0]["previous_chars"] // 4)
        self.assertIn("compacted", s["messages"][1]["content"])
        self.assertFalse(assess(json.dumps({"summary": "done", "evidence": [{"tool_call_id": "fake", "observation": "yes"}]}), {})["verified"])
        self.assertTrue(assess(json.dumps({"summary": "done", "evidence": [{"tool_call_id": "ok", "observation": "exit 0"}]}), {"ok": {"ok": True}})["verified"])

    def test_bad_session_id_and_provider_config(self):
        with self.assertRaises(ValueError):
            self.store.load("../../wrong")
        with self.assertRaises(ValueError):
            OpenAICompatible(base="http://localhost:1/v1", model="m", key="secret")
        p = OpenAICompatible(base="https://example.org/v1", model="m", key="secret")
        self.assertEqual(p.model, "m")

    def test_load_and_list_reject_symlinked_session_file(self):
        sid = "0123456789abcdef0123456789abcdef"
        outside = self.root / "outside-session.json"
        outside.write_text(json.dumps({
            "id": sid, "task": "outside sentinel", "status": "completed",
        }), encoding="utf-8")
        make_symlink(self.store.directory / f"{sid}.json", outside)

        with self.assertRaisesRegex(ValueError, "session file"):
            self.store.load(sid)
        self.assertEqual(self.store.list(), [])

    def test_load_and_list_skip_entry_when_link_guard_reports_reparse_point(self):
        """Exercise the guard branch without claiming this is a real file-link fixture.

        Windows file symbolic-link privilege may be unavailable. The companion
        test above uses a real link where supported; this mock only verifies
        Store's response when the platform guard identifies a reparse entry.
        """
        sid = "fedcba9876543210fedcba9876543210"
        entry = self.store.directory / f"{sid}.json"
        entry.write_text(json.dumps({
            "id": sid, "task": "guarded sentinel", "status": "completed",
        }), encoding="utf-8")

        def reports_reparse(path):
            return Path(path) == entry

        with patch("xueness.core._is_link", side_effect=reports_reparse):
            with self.assertRaisesRegex(ValueError, "session file"):
                self.store.load(sid)
            self.assertEqual(self.store.list(), [])

    def test_list_skips_corrupt_session_journal_and_keeps_valid_sessions(self):
        valid = self.store.new("valid history", self.root)
        corrupt = self.store.directory / "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
        corrupt.write_text("{not valid JSON", encoding="utf-8")

        self.assertEqual(self.store.list(), [{
            "id": valid["id"], "task": "valid history", "status": "pending",
        }])

    def test_store_save_journal_is_private(self):
        session = self.store.new("sensitive journal content", self.root)

        # Checks mode 0600 on POSIX and the actual protected native DACL on Windows.
        assert_secret_file_private(self, self.store._path(session["id"]))

    def test_store_save_protection_failure_preserves_old_journal_and_cleans_temp_fd(self):
        session = self.store.new("original journal", self.root)
        journal = self.store._path(session["id"])
        original = journal.read_bytes()
        session["task"] = "updated journal must not be written"
        captured = {}

        def fail_private_protection(fd):
            captured["fd"] = fd
            self.assertEqual(os.fstat(fd).st_size, 0,
                             "journal bytes were written before private protection")
            raise OSError("simulated private-file protection failure")

        with patch("xueness.core._protect_private_file", side_effect=fail_private_protection):
            with self.assertRaisesRegex(OSError, "protection failure"):
                self.store.save(session)

        self.assertEqual(journal.read_bytes(), original)
        self.assertEqual(list(self.store.directory.glob(".session-*")), [])
        with self.assertRaises(OSError):
            os.fstat(captured["fd"])

    @unittest.skipUnless(os.name == "nt", "Windows replace-sharing errors only")
    def test_store_save_retries_only_transient_windows_replace_sharing_errors(self):
        session = self.store.new("original", self.root)
        journal = self.store._path(session["id"])
        session["task"] = "updated"
        actual_replace = os.replace

        def winerror(code):
            error = PermissionError(f"simulated WinError {code}")
            error.winerror = code
            return error

        call_count = {"value": 0}

        def collide_then_replace(source, target):
            call_count["value"] += 1
            if call_count["value"] == 1:
                raise winerror(32)
            if call_count["value"] == 2:
                raise winerror(33)
            actual_replace(source, target)

        with patch("xueness.resources.os.replace", side_effect=collide_then_replace) as replace, \
                patch("xueness.resources.time.sleep") as sleep:
            self.store.save(session)
        self.assertEqual(replace.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.01, 0.01])
        self.assertEqual(self.store.load(session["id"])["task"], "updated")

        session["task"] = "must not replace"
        with patch("xueness.resources.os.replace", side_effect=winerror(2)) as replace:
            with self.assertRaises(PermissionError):
                self.store.save(session)
        replace.assert_called_once()
        self.assertEqual(self.store.load(session["id"])["task"], "updated")
        self.assertEqual(list(self.store.directory.glob(".session-*")), [])

    def test_provider_refuses_bearer_redirect(self):
        p = OpenAICompatible(base="https://example.org/v1", model="m", key="secret")
        request = urllib.request.Request("https://example.org/v1/chat/completions",
                                         data=b"{}", headers={"Authorization": "Bearer secret"})
        with self.assertRaises(urllib.error.URLError):
            _NoRedirect().redirect_request(
                request, None, 307, "redirect", {}, "https://other.example/steal")
        # Confirm the real complete() path installs the redirect-denying handler.
        class FakeOpener:
            def open(self, req, timeout):
                self.assertion(req)
                raise urllib.error.URLError("redirect blocked")

            def assertion(self, req):
                self_outer.assertEqual(req.get_header("Authorization"), "Bearer secret")

        self_outer = self
        with patch("xueness.provider.urllib.request.build_opener", return_value=FakeOpener()) as factory:
            with self.assertRaisesRegex(RuntimeError, "details suppressed"):
                p.complete([{"role": "user", "content": "hi"}], [])
            self.assertIs(factory.call_args.args[0], _NoRedirect)

    def test_cli_json_output_and_one_shot_prompt(self):
        from xueness.cli import main as cli_main

        def run_cli(argv):
            buffer = StringIO()
            with redirect_stdout(buffer):
                code = cli_main(argv)
            return code, buffer.getvalue()

        with tempfile.TemporaryDirectory() as tmp:
            state = str(Path(tmp) / "state")
            root = str(Path(tmp) / "ws")
            # One-shot --prompt creates and runs in a single command.
            # CLI has no per-action approval prompt, so a trusted disposable
            # workspace uses the same explicit --allow-write opt-in.
            code, out = run_cli(["--state", state, "run", "--prompt", "Create hello.txt then verify its content",
                                 "--root", root, "--allow-write", "--output-format", "json"])
            self.assertEqual(code, 0, out)
            payload = json.loads(out)
            self.assertEqual(payload["status"], "completed")
            self.assertTrue(payload["completion"]["verified"])
            self.assertEqual(payload["pending"], [])
            sid = payload["id"]
            self.assertTrue((Path(root) / "hello.txt").exists())
            # Explicit --resume alias resumes the same session to the same terminal state.
            code, out = run_cli(["--state", state, "run", sid, "--resume", "--output-format", "json"])
            self.assertEqual(code, 0, out)
            self.assertEqual(json.loads(out)["id"], sid)
            # Text format stays the pretty multi-line summary.
            code, out = run_cli(["--state", state, "run", sid, "--resume"])
            self.assertEqual(code, 0, out)
            self.assertIn("\n", out.strip())
            # list is always JSON.
            code, out = run_cli(["--state", state, "list"])
            self.assertEqual(code, 0)
            self.assertIn(sid, out)

    def test_cli_prompt_requires_root_and_rejects_id(self):
        from xueness.cli import main as cli_main

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                cli_main(["--state", tmp, "run", "--prompt", "t"])
            with self.assertRaises(SystemExit):
                cli_main(["--state", tmp, "run", "--prompt", "t", "--root", tmp, "abcd" * 8])

    def test_public_fake_provider_flag_is_rejected_before_creating_session(self):
        from xueness.cli import main as cli_main

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                cli_main(["--state", tmp, "run", "--prompt", "t", "--root", tmp, "--fake"])
            self.assertEqual(Store(Path(tmp)).list(), [])

    def test_provider_message_shape_validated_before_intent(self):
        from xueness.core import validate_message

        # Well-formed message passes through unchanged.
        good = {"content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "write", "arguments": "{}"}}]}
        self.assertIs(validate_message(good), good)
        # Malformed shapes are rejected BEFORE any message can be journaled.
        bad = [
            "not-a-dict",
            {"content": 123},
            {"tool_calls": "oops"},
            {"tool_calls": [{"id": "", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
            {"tool_calls": [{"id": "c1", "type": "nonsense", "function": {"name": "x", "arguments": "{}"}}]},
            {"tool_calls": [{"id": "c1", "type": "function", "function": {"name": "", "arguments": "{}"}}]},
            {"tool_calls": [{"id": "c1", "type": "function", "function": {"name": "x", "arguments": 5}}]},
        ]
        for payload in bad:
            with self.assertRaises(ValueError, msg=repr(payload)):
                validate_message(payload)

    def test_malformed_provider_response_records_provider_error(self):
        from xueness.bundled_plugins.providers.provider import ProviderRequestError

        class Broken:
            def complete(self, messages, tools):
                return {"content": 123}  # non-string content: invalid shape

        s = self.store.new("bad payload", self.root)
        before = len(s["messages"])
        with self.assertRaises(ProviderRequestError) as caught:
            run(s, self.store, Broken(), Gate(self.root, allow_write=True))
        out = self.store.load(s["id"])
        self.assertEqual(caught.exception.category, "invalid_response")
        self.assertEqual(out["status"], "provider_error")
        self.assertEqual(len(out["messages"]), before, "no intent may be journaled from a malformed payload")

    def test_stream_callback_stop_is_settled_as_stopped_not_provider_error(self):
        state = {"stop": False}

        class StopsDuringReasoning:
            def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
                state["stop"] = True
                on_reasoning_delta("private reasoning fixture")
                return {"content": "must not be consumed", "tool_calls": []}

        session = self.store.new("stop while streaming", self.root)
        with patch("xueness.core._reasoning_setting_enabled", return_value=True):
            out = run(session, self.store, StopsDuringReasoning(), Gate(self.root),
                      should_stop=lambda: state["stop"])
        self.assertEqual(out["status"], "stopped")
        self.assertEqual(self.store.load(session["id"])["status"], "stopped")

    def test_journal_export_command(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from xueness.cli import main as cli_main

        s = self.store.new("journaled task", self.root)
        err, out = io.StringIO(), io.StringIO()
        with redirect_stderr(err), redirect_stdout(out):
            code = cli_main(["--state", str(self.root / "state"), "journal", s["id"]])
        self.assertEqual(code, 0)
        self.assertIn("WARNING", err.getvalue())
        self.assertIn("journaled task", out.getvalue())
        # `show` stays a summary: it never prints raw messages.
        out2 = io.StringIO()
        with redirect_stdout(out2):
            cli_main(["--state", str(self.root / "state"), "show", s["id"]])
        self.assertNotIn("\"messages\"", out2.getvalue())

    def test_unverified_completion(self):
        s = self.store.new("Read README.md in this workspace and summarize it.", self.root)
        class UnsupportedFinal:
            def complete(self, messages, tools):
                return {"content": json.dumps({"summary": "No tool evidence", "evidence": []})}

        out = run(s, self.store, UnsupportedFinal(), Gate(self.root))
        self.assertEqual(out["status"], "needs_review")
        self.assertEqual(out["completion"]["status"], "unverified")
        self.assertEqual(out["completion"]["tool_execution_status"], "not_applicable")
        self.assertFalse(out["completion"]["verified"])




class SearchEditModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "state")

    def tearDown(self):
        self.temp.cleanup()

    def test_glob_basic_sorted_capped_jailed(self):
        (self.root / "a.txt").write_text("hi")
        (self.root / "sub").mkdir(exist_ok=True)
        (self.root / "sub" / "b.txt").write_text("hi")
        gate = Gate(self.root)
        r = execute(self.root, gate, "glob", {"pattern": "*.txt"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["output"], sorted(r["output"]))
        self.assertIn("a.txt", r["output"])
        self.assertIn("sub/b.txt", r["output"])
        bad = execute(self.root, gate, "glob", {"path": "../outside", "pattern": "*.txt"})
        self.assertFalse(bad["ok"])
        for absolute_pattern in ("/abs/*.txt", r"C:\abs\*.txt", r"\\server\share\*.txt"):
            with self.subTest(pattern=absolute_pattern):
                bad2 = execute(self.root, gate, "glob", {"pattern": absolute_pattern})
                self.assertFalse(bad2["ok"])
        self.assertIn("glob", [t["function"]["name"] for t in __import__("xueness.core", fromlist=["TOOLS"]).TOOLS])

    def test_glob_symlink_escape(self):
        import tempfile as _tf
        outside = _tf.NamedTemporaryFile(delete=False, suffix=".txt")
        outside.write(b"secret"); outside.close()
        self.addCleanup(Path(outside.name).unlink, missing_ok=True)
        make_directory_boundary_link(self.root / "linkdir", Path(outside.name).parent)
        gate = Gate(self.root)
        r = execute(self.root, gate, "glob", {"pattern": "*.txt"})
        self.assertTrue(r["ok"])
        # must not descend through symlinked dirs: no outside basename leak via linkdir
        self.assertFalse(any(x.startswith("linkdir/") for x in r["output"]))

    def test_grep_jailed_sorted_bounded(self):
        (self.root / "f1.txt").write_text("hello\nhello again\n")
        (self.root / "f2.txt").write_text("hello world\n")
        gate = Gate(self.root)
        r = execute(self.root, gate, "grep", {"pattern": "hello"})
        self.assertTrue(r["ok"])
        paths = [h["path"] for h in r["output"]]
        self.assertEqual(paths, sorted(paths))
        self.assertLessEqual(len(r["output"]), 200)
        bad = execute(self.root, gate, "grep", {"path": "../outside", "pattern": "hello"})
        self.assertFalse(bad["ok"])
        badre = execute(self.root, gate, "grep", {"pattern": "(["})
        self.assertFalse(badre["ok"])

    def test_grep_per_file_cap(self):
        (self.root / "big.txt").write_text("\n".join(f"x {i}" for i in range(50)))
        gate = Gate(self.root)
        r = execute(self.root, gate, "grep", {"pattern": "x"})
        self.assertTrue(r["ok"])
        per = [h for h in r["output"] if h["path"] == "big.txt"]
        self.assertLessEqual(len(per), 20)

    def test_edit_single_occurrence_gate(self):
        (self.root / "e.txt").write_text("foo bar foo")
        gate = Gate(self.root)
        denied = execute(self.root, gate, "edit", {"path": "e.txt", "old": "bar", "new": "BAZ"})
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"], "denied")
        g2 = Gate(self.root, allow_write=True)
        multi = execute(self.root, g2, "edit", {"path": "e.txt", "old": "foo", "new": "X"})
        self.assertFalse(multi["ok"])
        zero = execute(self.root, g2, "edit", {"path": "e.txt", "old": "zzz", "new": "X"})
        self.assertFalse(zero["ok"])
        ok = execute(self.root, g2, "edit", {"path": "e.txt", "old": "bar", "new": "BAZ"})
        self.assertTrue(ok["ok"])
        self.assertEqual((self.root / "e.txt").read_text(), "foo BAZ foo")
        esc = execute(self.root, g2, "edit", {"path": "../escape", "old": "a", "new": "b"})
        self.assertFalse(esc["ok"])

    def test_plan_mode_denies_before_approval(self):
        (self.root / "p.txt").write_text("a")
        plan = Gate(self.root, allow_write=True, allow_exec=True, mode="plan")
        self.assertFalse(execute(self.root, plan, "write", {"path": "p.txt", "content": "b"})["ok"])
        self.assertFalse(execute(self.root, plan, "edit", {"path": "p.txt", "old": "a", "new": "b"})["ok"])
        self.assertFalse(execute(self.root, plan, "exec", {"argv": ["python3", "-c", "print(1)"]})["ok"])
        # read-only still allowed in plan
        self.assertTrue(execute(self.root, plan, "glob", {"pattern": "*.txt"})["ok"])
        self.assertTrue(execute(self.root, plan, "grep", {"pattern": "a"})["ok"])
        # build keeps deny-by-default + approvals
        build = Gate(self.root, allow_write=True, allow_exec=True, mode="build")
        self.assertTrue(execute(self.root, build, "write", {"path": "ok.txt", "content": "b"})["ok"])

    def test_disallow_list(self):
        (self.root / "d.txt").write_text("a")
        g = Gate(self.root, allow_write=True, allow_exec=True, disallow={"exec", "edit"})
        self.assertFalse(execute(self.root, g, "exec", {"argv": ["python3", "-c", "print(1)"]})["ok"])
        self.assertFalse(execute(self.root, g, "edit", {"path": "d.txt", "old": "a", "new": "b"})["ok"])
        self.assertTrue(execute(self.root, g, "write", {"path": "w.txt", "content": "x"})["ok"])

    def test_mode_recorded_in_journal(self):
        s = self.store.new("m", self.root)
        out = run(s, self.store, FakeProvider(), Gate(self.root, mode="plan"), max_steps=1)
        self.assertEqual(out.get("mode"), "plan")
        self.assertTrue(any(h.get("mode") == "plan" for h in out.get("mode_history", [])))
        persisted = self.store.load(s["id"])
        self.assertEqual(persisted.get("mode"), "plan")

    def test_todo_roundtrip_and_cap(self):
        s = self.store.new("todos", self.root)
        written = execute(self.root, Gate(self.root), "todo_write",
                          {"todos": [{"id": "a", "text": "one", "status": "pending"}]}, s)
        self.assertTrue(written["ok"])
        self.assertEqual(s["todos"][0]["text"], "one")
        read = execute(self.root, Gate(self.root), "todo_read", {}, s)
        self.assertEqual(read["todos"][0]["id"], "a")
        too_many = [{"id": str(i), "text": "x", "status": "pending"} for i in range(51)]
        self.assertFalse(execute(self.root, Gate(self.root), "todo_write", {"todos": too_many}, s)["ok"])
        self.assertEqual(len(s["todos"]), 1)
        with self.assertRaises(ValueError):
            normalize_todos([{"id": "a", "text": "one"}, {"id": "a", "text": "dup"}])

    def test_ask_user_pauses_and_answer_resumes(self):
        class AskOnce:
            def __init__(self):
                self.n = 0
            def complete(self, messages, tools):
                self.n += 1
                if self.n == 1:
                    return {"content": "", "tool_calls": [
                        {"id": "q1", "type": "function",
                         "function": {"name": "ask_user", "arguments": json.dumps({"question": "which file?"})}}]}
                return {"content": json.dumps({"summary": "answered", "evidence": [
                    {"tool_call_id": "q1", "observation": "operator answered"}]})}

        provider = AskOnce()
        s = self.store.new("ask", self.root)
        out = run(s, self.store, provider, Gate(self.root), max_steps=3)
        self.assertEqual(out["status"], "awaiting_user")
        self.assertEqual(out["pending_question"], "which file?")
        # run while awaiting must not advance
        again = run(self.store.load(s["id"]), self.store, provider, Gate(self.root), max_steps=3)
        self.assertEqual(again["status"], "awaiting_user")
        self.assertEqual(provider.n, 1)
        paused = answer_session(self.store.load(s["id"]), self.store, "hello.txt")
        self.assertEqual(paused["status"], "paused")
        self.assertIsNone(paused.get("pending_question"))
        done = run(self.store.load(s["id"]), self.store, provider, Gate(self.root), max_steps=3)
        self.assertEqual(done["status"], "completed")
        events = session_events(done)
        kinds = [e["type"] for e in events]
        self.assertIn("tool_call", kinds)
        self.assertIn("completion", kinds)
        blob = json.dumps(events)
        self.assertNotIn("UNTRUSTED", blob)

    def test_cli_answer_and_awaiting_user(self):
        from contextlib import redirect_stderr, redirect_stdout
        from xueness.cli import main as cli_main
        class AskOnce:
            n = 0
            def complete(self, messages, tools):
                type(self).n += 1
                if type(self).n == 1:
                    return {"content": "", "tool_calls": [
                        {"id": "q1", "type": "function",
                         "function": {"name": "ask_user", "arguments": json.dumps({"question": "pick?"})}}]}
                return {"content": json.dumps({"summary": "ok", "evidence": [
                    {"tool_call_id": "q1", "observation": "answered"}]})}
        s = self.store.new("cli-ask", self.root)
        out = run(s, self.store, AskOnce(), Gate(self.root), max_steps=2)
        self.assertEqual(out["status"], "awaiting_user")
        err, stdout = StringIO(), StringIO()
        with redirect_stderr(err), redirect_stdout(stdout):
            code = cli_main(["--state", str(self.root / "state"), "answer", s["id"], "yes"])
        self.assertEqual(code, 0, stdout.getvalue())
        self.assertEqual(json.loads(stdout.getvalue())["status"], "paused")
        with self.assertRaises(SystemExit):
            cli_main(["--state", str(self.root / "state"), "answer", s["id"], "again"])

    def test_token_advisory_records_estimate_without_dropping(self):
        s = self.store.new("tok", self.root)
        s["messages"].append({"role": "assistant", "content": "hello world"})
        compact(s, 24000, max_tokens=1)
        self.assertEqual(s["compactions"][-1]["advisory"], True)
        self.assertEqual(s["compactions"][-1]["removed"], 0)
        self.assertGreaterEqual(s["compactions"][-1]["estimatedTokens"], 1)



    def test_event_subject_is_path_not_file_content(self):
        secret = "SECRET-FILE-BODY-do-not-leak"
        session = {"status": "paused", "steps": 1, "results": {}, "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "task"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "w1", "type": "function", "function": {
                    "name": "write",
                    "arguments": json.dumps({"path": "note.txt", "content": secret})}},
                {"id": "e1", "type": "function", "function": {
                    "name": "exec",
                    "arguments": json.dumps({"argv": ["python3", "-c", "print(1)"]})}},
            ]},
        ]}
        events = session_events(session)
        write = next(event for event in events if event.get("id") == "w1")
        command = next(event for event in events if event.get("id") == "e1")
        self.assertEqual(write["subject"], "note.txt")
        self.assertEqual(command["subject"], '["python3","-c","print(1)"]')
        session["messages"].append({"role": "tool", "tool_call_id": "w1", "content": secret})
        session["results"]["w1"] = {"ok": False, "error": "denied"}
        events = session_events(session)
        result = next(event for event in events if event.get("type") == "tool_result")
        self.assertEqual(result["subject"], "note.txt")
        self.assertNotIn(secret, json.dumps(events, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
