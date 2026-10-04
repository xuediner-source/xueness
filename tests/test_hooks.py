"""Stage 4 hooks tests.

Covers the contract in docs/stage4-contract.md, section "后端模块：
xueness/hooks.py": loading and filtering (empty directory, disabled, unknown
event, bad command, broken JSON, symlinks at entry and directory level, stable
id order), matcher selection (missing / ``*`` / regex hit / regex miss /
invalid regex), and the executor (no subprocess when disabled, exit code 2 ->
blocked, timeout clamped by the cap, output truncation, missing binary,
stdin payload delivery, and the minimal child environment).

Hooks here are always ``sys.executable -c "..."`` so the suite stays portable
and never depends on a shell.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.hooks import (DEFAULT_OUTPUT_CAP, DEFAULT_TIMEOUT_CAP, EXIT_BLOCK,
                           HOOK_EVENTS, HookRunner, load, select)

# Sleeps far longer than the clamped cap; the run itself must stay fast.
SLEEP_FOREVER = "import time; time.sleep(5)"
# Echoes whatever JSON arrives on stdin, then exits 0.
ECHO_STDIN = "import sys; print(sys.stdin.read())"
# Prints the secret env var if the child environment leaked it.
PRINT_ENV = "import os; print('LEAK=' + repr(os.environ.get('FOO_SECRET')))"
# Prints a long line so truncation is observable.
PRINT_LONG = "print('x' * 10000)"


class HooksTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "state"
        self.hooks_dir = self.state_dir / "resources" / "hooks"
        self.hooks_dir.mkdir(parents=True)
        self.work = self.root / "work"
        self.work.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    # --- helpers ------------------------------------------------------------

    def write_hook(self, filename: str, payload) -> Path:
        path = self.hooks_dir / filename
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def hook_item(self, hook_id="h", event="PreToolUse", *, command_code=ECHO_STDIN,
                  **extra) -> dict:
        """A hook dict whose command is the current interpreter, no shell."""
        item = {
            "id": hook_id,
            "event": event,
            "type": "command",
            "command": sys.executable,
            "args": ["-c", command_code],
        }
        item.update(extra)
        return item

    def runner(self, **kwargs) -> HookRunner:
        return HookRunner(load(self.state_dir), self.work, **kwargs)

    def snapshot(self):
        """path -> (mtime_ns, size) for the whole root, symlinks included."""
        out = {}
        for base, dirs, files in os.walk(self.root, followlinks=False):
            for name in list(dirs) + list(files):
                path = Path(base) / name
                try:
                    stat = path.lstat()
                except OSError:
                    continue
                out[str(path)] = (stat.st_mtime_ns, stat.st_size)
        return out

    # --- load: empty / missing ---------------------------------------------

    def test_empty_directory_returns_empty_list(self):
        self.assertEqual(load(self.state_dir), [])

    def test_missing_directory_returns_empty_list(self):
        shutil.rmtree(self.hooks_dir)
        self.assertEqual(load(self.state_dir), [])

    def test_constants_match_contract(self):
        self.assertEqual(HOOK_EVENTS, (
            "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
            "PostToolUse", "PostToolUseFailure", "Stop"))
        self.assertEqual(EXIT_BLOCK, 2)
        self.assertEqual(DEFAULT_TIMEOUT_CAP, 30)
        self.assertEqual(DEFAULT_OUTPUT_CAP, 2000)

    # --- load: filtering ----------------------------------------------------

    def test_valid_hook_is_loaded_with_original_fields(self):
        self.write_hook("a.json", self.hook_item("alpha", "PostToolUse",
                                                 matcher="^read$", timeout=7))
        hooks = load(self.state_dir)
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0]["id"], "alpha")
        self.assertEqual(hooks[0]["event"], "PostToolUse")
        self.assertEqual(hooks[0]["matcher"], "^read$")
        self.assertEqual(hooks[0]["timeout"], 7)
        self.assertEqual(hooks[0]["command"], sys.executable)

    def test_disabled_hook_is_skipped(self):
        self.write_hook("on.json", self.hook_item("on"))
        self.write_hook("off.json", self.hook_item("off", enabled=False))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["on"])

    def test_missing_enabled_counts_as_enabled(self):
        self.write_hook("a.json", self.hook_item("implicit"))
        self.write_hook("b.json", self.hook_item("truthy", enabled=True))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["implicit", "truthy"])

    def test_unknown_event_is_skipped(self):
        self.write_hook("bad.json", self.hook_item("bad", "NotAnEvent"))
        self.write_hook("also-bad.json", self.hook_item("also-bad", ""))
        self.write_hook("num.json", self.hook_item("num", event=7))
        self.write_hook("ok.json", self.hook_item("ok", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["ok"])

    def test_all_seven_events_are_accepted(self):
        for index, event in enumerate(HOOK_EVENTS):
            self.write_hook("h%d.json" % index, self.hook_item("h%d" % index, event))
        self.assertEqual([h["event"] for h in load(self.state_dir)], list(HOOK_EVENTS))

    def test_non_string_or_blank_command_is_skipped(self):
        self.write_hook("a.json", {"id": "a", "event": "Stop", "command": ["ls"]})
        self.write_hook("b.json", {"id": "b", "event": "Stop", "command": ""})
        self.write_hook("c.json", {"id": "c", "event": "Stop", "command": "   "})
        self.write_hook("d.json", {"id": "d", "event": "Stop", "command": None})
        self.write_hook("e.json", {"id": "e", "event": "Stop"})
        self.write_hook("ok.json", self.hook_item("ok", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["ok"])

    def test_entry_without_usable_id_is_skipped(self):
        self.write_hook("a.json", {"event": "Stop", "command": sys.executable})
        self.write_hook("b.json", {"id": "", "event": "Stop", "command": sys.executable})
        self.write_hook("c.json", {"id": 9, "event": "Stop", "command": sys.executable})
        self.write_hook("ok.json", self.hook_item("ok", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["ok"])

    def test_broken_entry_only_costs_that_entry(self):
        self.write_hook("broken.json", "{ this is not json ")
        self.write_hook("array.json", "[1, 2, 3]")
        self.write_hook("good.json", self.hook_item("good", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["good"])

    def test_non_json_file_is_ignored(self):
        (self.hooks_dir / "notes.txt").write_text("ignore me", encoding="utf-8")
        self.write_hook("good.json", self.hook_item("good", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["good"])

    # --- load: ordering -----------------------------------------------------

    def test_hooks_sorted_by_id_ascending(self):
        for hook_id in ("zeta", "alpha", "mid"):
            self.write_hook(hook_id + ".json", self.hook_item(hook_id, "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["alpha", "mid", "zeta"])

    def test_ordering_is_stable_across_calls(self):
        for hook_id in ("b", "a", "c"):
            self.write_hook(hook_id + ".json", self.hook_item(hook_id, "Stop"))
        self.assertEqual(load(self.state_dir), load(self.state_dir))

    def test_ordering_ignores_filename_not_id(self):
        self.write_hook("zzz.json", self.hook_item("aaa", "Stop"))
        self.write_hook("aaa.json", self.hook_item("zzz", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["aaa", "zzz"])

    # --- load: symlinks -----------------------------------------------------

    def test_symlinked_entry_is_skipped(self):
        secret = self.root / "outside.json"
        secret.write_text(json.dumps(self.hook_item("evil", "Stop")), encoding="utf-8")
        make_symlink(self.hooks_dir / "evil.json", secret)
        self.write_hook("ok.json", self.hook_item("ok", "Stop"))
        self.assertEqual([h["id"] for h in load(self.state_dir)], ["ok"])

    def test_symlinked_directory_returns_empty(self):
        outside = self.root / "outside-hooks"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps(self.hook_item("outside", "Stop")), encoding="utf-8")
        shutil.rmtree(self.hooks_dir)
        make_directory_boundary_link(self.hooks_dir, outside)
        self.assertEqual(load(self.state_dir), [])

    def test_symlink_to_state_dir_returns_empty(self):
        outside = self.root / "outside-hooks"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps(self.hook_item("outside", "Stop")), encoding="utf-8")
        link = self.root / "link-state"
        link.mkdir()
        (link / "resources").mkdir()
        make_directory_boundary_link(link / "resources" / "hooks", outside)
        self.assertEqual(load(link), [])

    # --- load is read-only --------------------------------------------------

    def test_load_never_writes_anything(self):
        self.write_hook("a.json", self.hook_item("a"))
        self.write_hook("broken.json", "{ not json")
        secret = self.root / "secret.json"
        secret.write_text(json.dumps(self.hook_item("evil", "Stop")), encoding="utf-8")
        make_symlink(self.hooks_dir / "link.json", secret)

        before = self.snapshot()
        load(self.state_dir)
        load(self.state_dir)
        after = self.snapshot()

        self.assertEqual(before, after)

    # --- select -------------------------------------------------------------

    def test_select_requires_event_equality(self):
        hooks = [
            {"id": "a", "event": "PreToolUse"},
            {"id": "b", "event": "Stop"},
            {"id": "c", "event": "Stop"},
        ]
        self.assertEqual([h["id"] for h in select(hooks, "Stop")], ["b", "c"])
        self.assertEqual(select(hooks, "SessionStart"), [])

    def test_matcher_missing_or_empty_or_star_matches_all(self):
        hooks = [
            {"id": "no-matcher", "event": "PreToolUse"},
            {"id": "empty", "event": "PreToolUse", "matcher": ""},
            {"id": "star", "event": "PreToolUse", "matcher": "*"},
            {"id": "null", "event": "PreToolUse", "matcher": None},
        ]
        ids = [h["id"] for h in select(hooks, "PreToolUse", "write")]
        self.assertEqual(ids, ["no-matcher", "empty", "star", "null"])

    def test_matcher_regex_hit_and_miss(self):
        hooks = [
            {"id": "writes", "event": "PreToolUse", "matcher": "^write$"},
            {"id": "reads", "event": "PreToolUse", "matcher": "read"},
        ]
        hits = [h["id"] for h in select(hooks, "PreToolUse", "write")]
        self.assertEqual(hits, ["writes"])
        misses = [h["id"] for h in select(hooks, "PreToolUse", "list")]
        self.assertEqual(misses, [])

    def test_matcher_uses_search_not_fullmatch(self):
        hooks = [{"id": "sub", "event": "PreToolUse", "matcher": "tool"}]
        self.assertEqual([h["id"] for h in select(hooks, "PreToolUse", "my_tool_call")], ["sub"])

    def test_invalid_regex_does_not_match_and_does_not_raise(self):
        hooks = [
            {"id": "broken", "event": "PreToolUse", "matcher": "([unclosed"},
            {"id": "ok", "event": "PreToolUse", "matcher": "write"},
        ]
        try:
            hits = [h["id"] for h in select(hooks, "PreToolUse", "write")]
        except Exception as exc:  # noqa: BLE001
            self.fail("select raised on an invalid regex: %r" % (exc,))
        self.assertEqual(hits, ["ok"])

    def test_non_string_matcher_is_skipped(self):
        hooks = [
            {"id": "num", "event": "PreToolUse", "matcher": 5},
            {"id": "ok", "event": "PreToolUse"},
        ]
        self.assertEqual([h["id"] for h in select(hooks, "PreToolUse", "write")], ["ok"])

    def test_select_without_subject_treats_it_as_empty_string(self):
        hooks = [
            {"id": "empty-re", "event": "Stop", "matcher": "^$"},
            {"id": "nonempty-re", "event": "Stop", "matcher": "^write$"},
        ]
        self.assertEqual([h["id"] for h in select(hooks, "Stop")], ["empty-re"])

    # --- active -------------------------------------------------------------

    def test_active_reflects_enabled_and_hook_count(self):
        self.write_hook("a.json", self.hook_item("a", "Stop"))
        self.assertTrue(HookRunner(load(self.state_dir), self.work).active)
        self.assertFalse(HookRunner(load(self.state_dir), self.work, enabled=False).active)
        self.assertFalse(HookRunner([], self.work).active)
        self.assertFalse(HookRunner([], self.work, enabled=False).active)

    # --- fire: disabled -----------------------------------------------------

    def test_disabled_runner_never_spawns_a_subprocess(self):
        sentinel = self.work / "sentinel.txt"
        code = "import pathlib; pathlib.Path(r'%s').write_text('ran')" % sentinel
        self.write_hook("a.json", self.hook_item("a", "PreToolUse", command_code=code))
        runner = HookRunner(load(self.state_dir), self.work, enabled=False)

        started = time.monotonic()
        self.assertEqual(runner.fire("PreToolUse", {"tool_name": "write"}), [])
        self.assertEqual(runner.pre_tool_use("write", {}), (True, ""))
        elapsed = time.monotonic() - started

        self.assertFalse(sentinel.exists())
        self.assertLess(elapsed, 3.0)

    def test_enabled_runner_does_spawn_the_subprocess(self):
        """Control for the sentinel test: the same hook does run when enabled."""
        sentinel = self.work / "sentinel.txt"
        code = "import pathlib; pathlib.Path(r'%s').write_text('ran')" % sentinel
        self.write_hook("a.json", self.hook_item("a", "PreToolUse", command_code=code))
        runner = HookRunner(load(self.state_dir), self.work, enabled=True)
        runner.fire("PreToolUse", {"tool_name": "write"})
        self.assertTrue(sentinel.exists())

    def test_fire_returns_empty_without_matching_hooks(self):
        self.write_hook("a.json", self.hook_item("a", "Stop"))
        runner = self.runner()
        self.assertEqual(runner.fire("SessionStart", {}), [])

    # --- fire: exit codes ---------------------------------------------------

    def test_exit_zero_is_not_blocked(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse",
                                                 command_code="print('fine')"))
        results = self.runner().fire("PreToolUse", {"tool_name": "write"})
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["exit_code"], 0)
        self.assertFalse(results[0]["blocked"])
        self.assertFalse(results[0]["timeout"])
        self.assertIn("fine", results[0]["output"])

    def test_exit_two_is_blocked(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", command_code="import sys; print('nope'); sys.exit(2)"))
        results = self.runner().fire("PreToolUse", {"tool_name": "write"})
        self.assertEqual(results[0]["exit_code"], 2)
        self.assertTrue(results[0]["blocked"])
        self.assertFalse(results[0]["timeout"])
        self.assertIn("nope", results[0]["output"])

    def test_exit_one_is_not_blocked(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", command_code="import sys; print('warn'); sys.exit(1)"))
        results = self.runner().fire("PreToolUse", {"tool_name": "write"})
        self.assertEqual(results[0]["exit_code"], 1)
        self.assertFalse(results[0]["blocked"])

    def test_result_shape(self):
        self.write_hook("a.json", self.hook_item("a", "PostToolUse"))
        results = self.runner().fire("PostToolUse", {"tool_name": "read"})
        self.assertEqual(set(results[0]), {
            "id", "event", "exit_code", "blocked", "timeout", "duration_ms", "output"})
        self.assertEqual(results[0]["id"], "a")
        self.assertEqual(results[0]["event"], "PostToolUse")
        self.assertIsInstance(results[0]["duration_ms"], int)
        self.assertIsInstance(results[0]["output"], str)

    def test_multiple_hooks_all_reported(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code="print('a')"))
        self.write_hook("b.json", self.hook_item("b", "Stop", command_code="print('b')"))
        self.write_hook("c.json", self.hook_item("c", "SessionStart"))
        results = self.runner().fire("Stop", {})
        self.assertEqual([r["id"] for r in results], ["a", "b"])

    # --- fire: payload on stdin --------------------------------------------

    def test_payload_is_written_to_stdin_as_json(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse"))
        results = self.runner().fire("PreToolUse", {"tool_name": "write", "arguments": {"path": "p"}})
        payload = json.loads(results[0]["output"])
        self.assertEqual(payload["tool_name"], "write")
        self.assertEqual(payload["arguments"], {"path": "p"})

    def test_stdout_and_stderr_are_merged(self):
        code = "import sys; print('OUT'); sys.stderr.write('ERR\\n')"
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=code))
        output = self.runner().fire("Stop", {})[0]["output"]
        self.assertIn("OUT", output)
        self.assertIn("ERR", output)

    # --- fire: environment --------------------------------------------------

    def test_child_environment_does_not_leak_server_secrets(self):
        os.environ["FOO_SECRET"] = "SUPER-SECRET-VALUE-42"
        try:
            self.write_hook("a.json", self.hook_item("a", "Stop", command_code=PRINT_ENV))
            output = self.runner().fire("Stop", {})[0]["output"]
        finally:
            os.environ.pop("FOO_SECRET", None)
        self.assertNotIn("SUPER-SECRET-VALUE-42", output)
        self.assertIn("LEAK=None", output)

    def test_payload_is_not_passed_through_the_environment(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=PRINT_ENV))
        # Even a secret-looking payload value must not reach the child's env.
        self.runner().fire("Stop", {"token": "SUPER-SECRET-VALUE-42"})
        output = self.runner().fire("Stop", {"token": "SUPER-SECRET-VALUE-42"})[0]["output"]
        self.assertNotIn("SUPER-SECRET-VALUE-42", output)

    # --- fire: timeouts -----------------------------------------------------

    def test_timeout_is_clamped_by_the_cap(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=SLEEP_FOREVER))
        runner = self.runner(timeout_cap=1)
        started = time.monotonic()
        results = runner.fire("Stop", {})
        elapsed = time.monotonic() - started
        self.assertTrue(results[0]["timeout"])
        self.assertEqual(results[0]["exit_code"], -1)
        self.assertFalse(results[0]["blocked"])
        self.assertLess(elapsed, 4.0)
        self.assertGreaterEqual(elapsed, 0.5)

    def test_hook_timeout_above_cap_is_clamped(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=SLEEP_FOREVER,
                                                 timeout=60))
        started = time.monotonic()
        results = self.runner(timeout_cap=1).fire("Stop", {})
        elapsed = time.monotonic() - started
        self.assertTrue(results[0]["timeout"])
        self.assertLess(elapsed, 4.0)

    def test_hook_timeout_below_cap_is_honoured(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=SLEEP_FOREVER,
                                                 timeout=0.4))
        started = time.monotonic()
        results = self.runner(timeout_cap=10).fire("Stop", {})
        elapsed = time.monotonic() - started
        self.assertTrue(results[0]["timeout"])
        self.assertLess(elapsed, 3.0)

    # --- fire: output truncation -------------------------------------------

    def test_long_output_is_truncated(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=PRINT_LONG))
        output = self.runner(output_cap=200).fire("Stop", {})[0]["output"]
        self.assertLessEqual(len(output), 200 + 32)
        self.assertIn("truncated", output)

    def test_output_cap_defaults_match_contract(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=PRINT_LONG))
        output = self.runner().fire("Stop", {})[0]["output"]
        self.assertLessEqual(len(output), DEFAULT_OUTPUT_CAP + 32)
        self.assertIn("truncated", output)

    def test_short_output_is_not_truncated(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code="print('short')"))
        output = self.runner().fire("Stop", {})[0]["output"]
        self.assertIn("short", output)
        self.assertNotIn("truncated", output)

    # --- fire: failure containment -----------------------------------------

    def test_missing_command_does_not_raise(self):
        self.write_hook("a.json", {
            "id": "a", "event": "Stop",
            "command": "/definitely/not/a/real/binary-xyz",
        })
        try:
            results = self.runner().fire("Stop", {})
        except Exception as exc:  # noqa: BLE001
            self.fail("fire raised on a missing command: %r" % (exc,))
        self.assertEqual(results[0]["exit_code"], -1)
        self.assertFalse(results[0]["blocked"])
        self.assertTrue(results[0]["output"])

    def test_invalid_root_does_not_execute_and_reports_minus_one(self):
        self.write_hook("a.json", self.hook_item("a", "Stop"))
        missing_root = self.root / "nope" / "nested"
        results = HookRunner(load(self.state_dir), missing_root).fire("Stop", {})
        self.assertEqual(results[0]["exit_code"], -1)
        self.assertEqual(results[0]["output"], "invalid working directory; hook not executed")

    def test_file_as_root_does_not_execute(self):
        self.write_hook("a.json", self.hook_item("a", "Stop"))
        results = HookRunner(load(self.state_dir), self.state_dir / "a-file").fire("Stop", {})
        self.assertEqual(results[0]["exit_code"], -1)

    def test_bad_arguments_type_does_not_raise(self):
        self.write_hook("a.json", {"id": "a", "event": "Stop",
                                   "command": sys.executable, "args": "not-a-list"})
        results = self.runner().fire("Stop", {})
        self.assertEqual(results[0]["exit_code"], 0)

    def test_hook_runs_in_root_as_cwd(self):
        self.write_hook("a.json", self.hook_item("a", "Stop",
                                                 command_code="import os; print(os.getcwd())"))
        output = self.runner().fire("Stop", {})[0]["output"]
        self.assertEqual(os.path.realpath(output.strip()), os.path.realpath(self.work))

    def test_multi_line_stderr_only_output_keeps_exit_code(self):
        code = "import sys; sys.stderr.write('boom\\n'); sys.exit(3)"
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=code))
        results = self.runner().fire("Stop", {})
        self.assertEqual(results[0]["exit_code"], 3)
        self.assertIn("boom", results[0]["output"])

    # --- pre_tool_use -------------------------------------------------------

    def test_pre_tool_use_without_match_allows_and_is_silent(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse",
                                                 command_code="import sys; sys.exit(2)",
                                                 matcher="^write$"))
        allowed, message = self.runner().pre_tool_use("read", {})
        self.assertTrue(allowed)
        self.assertEqual(message, "")

    def test_pre_tool_use_exit_two_blocks_with_output_summary(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", command_code="import sys; print('BLOCK-DETAIL'); sys.exit(2)"))
        allowed, message = self.runner().pre_tool_use("write", {"path": "x"})
        self.assertFalse(allowed)
        self.assertIn("BLOCK-DETAIL", message)

    def test_pre_tool_use_any_blocking_hook_blocks(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse",
                                                 command_code="print('ok')"))
        self.write_hook("b.json", self.hook_item("b", "PreToolUse",
                                                 command_code="import sys; print('stop'); sys.exit(2)"))
        allowed, message = self.runner().pre_tool_use("write", {})
        self.assertFalse(allowed)
        self.assertIn("stop", message)

    def test_pre_tool_use_nonzero_non_two_warns_but_allows(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", command_code="import sys; print('JUST-A-WARNING'); sys.exit(1)"))
        allowed, message = self.runner().pre_tool_use("write", {})
        self.assertTrue(allowed)
        self.assertIn("JUST-A-WARNING", message)

    def test_pre_tool_use_exit_zero_allows_with_empty_warning(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", command_code="print('all good')"))
        self.assertEqual(self.runner().pre_tool_use("write", {}), (True, ""))

    def test_pre_tool_use_timeout_warns_but_allows(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse", command_code=SLEEP_FOREVER))
        allowed, message = self.runner(timeout_cap=1).pre_tool_use("write", {})
        self.assertTrue(allowed)
        self.assertNotEqual(message, "")

    def test_pre_tool_use_subject_is_the_tool_name(self):
        self.write_hook("a.json", self.hook_item(
            "a", "PreToolUse", matcher="^write$",
            command_code="import sys; print('WRITE-SEEN'); sys.exit(2)"))
        self.assertFalse(self.runner().pre_tool_use("write", {})[0])
        self.assertTrue(self.runner().pre_tool_use("read", {})[0])

    def test_pre_tool_use_writes_tool_name_and_arguments_to_stdin(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse"))
        allowed, message = self.runner().pre_tool_use("write", {"path": "p", "content": "c"})
        self.assertTrue(allowed)
        self.assertEqual(message, "")
        # Indirect proof the payload reached stdin: the echo hook's output is
        # dropped on the allow path, so inspect fire() for the same payload.
        results = self.runner().fire("PreToolUse", {"tool_name": "write", "arguments": {"path": "p"}})
        payload = json.loads(results[0]["output"])
        self.assertEqual(payload["tool_name"], "write")
        self.assertEqual(payload["arguments"], {"path": "p"})

    def test_pre_tool_use_is_silent_when_disabled(self):
        self.write_hook("a.json", self.hook_item("a", "PreToolUse",
                                                 command_code="import sys; sys.exit(2)"))
        self.assertEqual(
            HookRunner(load(self.state_dir), self.work, enabled=False).pre_tool_use("write", {}),
            (True, ""))

    # --- no write guarantee for a whole run --------------------------------

    def test_fire_never_writes_into_state_dir(self):
        self.write_hook("a.json", self.hook_item("a", "Stop", command_code=ECHO_STDIN))
        before = self.snapshot()
        self.runner().fire("Stop", {"hello": "world"})
        self.runner().pre_tool_use("write", {})
        after = self.snapshot()
        # Only the hooks dir tree is under inspection; a hook writes to cwd
        # (workspace root) or nowhere, never to the resource store.
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
