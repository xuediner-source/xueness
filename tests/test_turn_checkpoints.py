"""Automatic per-turn workspace checkpoints, rewind, and checkpoint forks.

Contract under test:

* ``git.turn_checkpoints`` snapshots the workspace once per human turn, right
  before the first write/edit/exec capability really runs. Nothing else changes:
  a read-only turn, a non-git workspace, a remote-bound session or a disabled
  plugin all stay exactly as they were.
* ``git.rewind`` is the existing review-and-confirm restore, so it writes a
  recovery snapshot first and never deletes files the checkpoint did not know.
* ``sessions.fork_from_checkpoint`` reuses the safe-turn fork machinery: the new
  session keeps the turns *before* the checkpointed turn and records which
  snapshot it came from; it does not rewrite the shared workspace.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from xueness import plugin_runtime
from xueness.bundled_plugins.git import actions, turn_checkpoints
from xueness.bundled_plugins.git.git_api import GitApiError
from xueness.bundled_plugins.sessions import forking
from xueness.bundled_plugins.sessions.sessions_api import dispatch as sessions_dispatch
from xueness.core import Gate, Store, append_user_turn, run
from xueness.tool_contract import bind_execution
from xueness.tool_registry import dispatch
from xueness.web import WebGate

# 身份只用 -c 内联注入，避免依赖（或污染）本机全局 git 配置。
GIT_IDENT = ("-c", "user.name=Test", "-c", "user.email=test@example.com")


@unittest.skipUnless(shutil.which("git"), "git not installed")
class TurnCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.plain = self.base / "plain"
        self.plain.mkdir()
        self.store = Store(self.base / "state")
        self.ctx = {"store": self.store, "state_dir": self.store.directory}
        self.sid = self.store.new("change the workspace", self.repo)["id"]
        self.plain_sid = self.store.new("plain task", self.plain)["id"]

    # -- fixtures and helpers ---------------------------------------------
    def _git(self, *argv) -> str:
        proc = subprocess.run(["git", *GIT_IDENT, *argv], cwd=self.repo,
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def _repo_with_history(self):
        self._git("init", "-q")
        (self.repo / "a.txt").write_text("one\n", encoding="utf-8")
        self._git("add", "a.txt")
        self._git("commit", "-qm", "initial")

    def _blob(self, rev: str, path: str) -> str:
        """Exact file content inside a snapshot, so newlines stay meaningful."""
        proc = subprocess.run(["git", *GIT_IDENT, "-C", str(self.repo), "show", rev + ":" + path],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def _ref_subjects(self) -> list:
        raw = self._git("for-each-ref", "--format=%(contents:subject)",
                        "refs/xueness/checkpoints/")
        return [line for line in raw.splitlines() if line]

    def _tool(self, name, args, sid=None):
        """One real tool call through the common dispatch boundary."""
        sid = sid or self.sid
        root = Path(self.store.load(sid)["root"])
        gate = Gate(root, allow_write=True, allow_exec=True)
        with bind_execution(store=self.store, state_dir=self.store.directory):
            return dispatch(root, gate, name, dict(args), self.store.load(sid))

    def _records(self, sid=None):
        return turn_checkpoints.records(self.store.load(sid or self.sid))

    def _checkpoint_of(self, turn, sid=None):
        return next(item["checkpointId"] for item in self._records(sid)
                    if item["turn"] == turn)

    def _hash_of(self, turn, sid=None):
        """Commit object a turn snapshot points at; ``checkpointId`` is only a ref name."""
        return next(item["hash"] for item in self._records(sid) if item["turn"] == turn)

    def _next_turn(self, text, sid=None):
        append_user_turn(self.store.load(sid or self.sid), self.store, text)

    def _cli(self, argv) -> tuple:
        from xueness.cli import main as cli_main
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli_main(["--state", str(self.store.directory), *argv])
        return code, out.getvalue(), err.getvalue()

    def _rewind(self, data, sid=None):
        return turn_checkpoints.dispatch(
            "POST", ["api", "sessions", sid or self.sid, "git", "turn-checkpoints", "rewind"],
            {}, data, self.ctx)

    # -- automatic snapshot, once per turn --------------------------------
    def test_first_writing_tool_snapshots_the_turn_once(self):
        self._repo_with_history()
        self.assertEqual(True, self._tool("read", {"path": "a.txt"})["ok"])
        self.assertEqual([], self._records())  # read-only tools never snapshot
        self.assertEqual(True, self._tool("write", {"path": "a.txt", "content": "two\n"})["ok"])
        self.assertEqual(True, self._tool("edit", {"path": "a.txt", "old": "two",
                                                   "new": "three"})["ok"])
        self.assertEqual(True, self._tool("exec", {"argv": [sys.executable, "-c", "pass"]})["ok"])
        records = self._records()
        self.assertEqual(1, len(records), records)
        record = records[0]
        self.assertEqual({"sessionId", "turn", "checkpointId", "hash", "message", "tool",
                          "createdAt"}, set(record))
        self.assertEqual(self.sid, record["sessionId"])
        self.assertEqual(1, record["turn"])
        self.assertEqual("write", record["tool"])
        self.assertRegex(record["createdAt"], r"^\d{4}-\d{2}-\d{2}T.*\+00:00$")
        self.assertEqual(["Turn 1 before first change"], self._ref_subjects())
        self.assertEqual(record["hash"], self._git(
            "rev-parse", "refs/xueness/checkpoints/" + record["checkpointId"] + "^{commit}"))
        # The snapshot holds the pre-turn state, while the run keeps working.
        self.assertEqual("one\n", self._blob(record["hash"], "a.txt"))
        self.assertEqual("three", (self.repo / "a.txt").read_text(encoding="utf-8").strip())

    def test_each_new_turn_snapshots_again(self):
        self._repo_with_history()
        self._tool("write", {"path": "a.txt", "content": "two\n"})
        self._next_turn("keep going")
        self._tool("write", {"path": "a.txt", "content": "three\n"})
        self._tool("write", {"path": "a.txt", "content": "four\n"})
        self.assertEqual([(1, "Turn 1 before first change"), (2, "Turn 2 before first change")],
                         [(item["turn"], item["message"]) for item in self._records()])
        self.assertEqual("two\n", self._blob(self._hash_of(2), "a.txt"))

    def test_snapshot_happens_inside_a_real_agent_run(self):
        from tests.test_lightweight_runtime import ScriptedProvider, call
        self._repo_with_history()
        session = run(self.store.load(self.sid), self.store, ScriptedProvider([
            call("write", {"path": "a.txt", "content": "two\n"}, "call-run-1"),
            {"content": "written"},
        ]), Gate(self.repo, allow_write=True), max_steps=2)
        records = self._records(session["id"])
        self.assertEqual(1, len(records))
        self.assertEqual("write", records[0]["tool"])
        self.assertEqual("one\n", self._blob(records[0]["hash"], "a.txt"))

    def test_empty_repository_snapshots_nothing_and_still_writes(self):
        self._git("init", "-q")  # no HEAD yet: a snapshot has nothing to parent on
        self.assertEqual(True, self._tool("write", {"path": "a.txt", "content": "one\n"})["ok"])
        self.assertEqual([], self._records())
        self.assertEqual([], self._ref_subjects())

    def test_non_git_workspace_is_skipped_without_breaking_the_tool(self):
        self.assertEqual(True, self._tool("write", {"path": "note.txt", "content": "hi\n"},
                                          sid=self.plain_sid)["ok"])
        self.assertEqual([], self._records(self.plain_sid))
        self.assertTrue((self.plain / "note.txt").is_file())
        status, listed = turn_checkpoints.dispatch(
            "GET", ["api", "sessions", self.plain_sid, "git", "turn-checkpoints"], {}, {}, self.ctx)
        self.assertEqual(200, status)
        self.assertEqual({"session": self.plain_sid, "repository": False, "turns": []}, listed)
        self.assertEqual((404, {"error": "该工作区不是 git 仓库"}),
                         self._rewind({"latest": True, "confirmed": True}, self.plain_sid))

    def test_a_broken_snapshot_cannot_break_the_tool_call(self):
        self._repo_with_history()

        def broken(*args, **kwargs):
            raise OSError("git went away")

        original = actions.checkpoint
        actions.checkpoint = broken
        try:
            result = self._tool("write", {"path": "a.txt", "content": "two\n"})
        finally:
            actions.checkpoint = original
        self.assertEqual(True, result["ok"])
        self.assertEqual([], self._records())

    def test_remote_bound_session_never_snapshots_the_local_checkout(self):
        self._repo_with_history()
        session = self.store.load(self.sid)
        session["remote_connection"] = {"id": "srv", "digest": "d" * 64}
        self.assertIsNone(turn_checkpoints.record_turn(
            self.store.directory, session, self.store, tool_name="write", gate_kind="write"))
        self.assertEqual([], self._ref_subjects())

    def test_denied_plan_write_does_not_create_a_checkpoint(self):
        self._repo_with_history()
        session = self.store.load(self.sid)
        gate = Gate(self.repo, allow_write=True, permission_mode="plan")
        with bind_execution(store=self.store, state_dir=self.store.directory):
            result = dispatch(self.repo, gate, "write",
                              {"path": "a.txt", "content": "two\n"}, session)
        self.assertFalse(result["ok"])
        self.assertEqual("plan_mode_denied", result["error_code"])
        self.assertEqual([], self._records())
        self.assertEqual([], self._ref_subjects())
        self.assertEqual("one\n", (self.repo / "a.txt").read_text(encoding="utf-8"))

    def test_pending_approval_snapshots_the_workspace_when_approved(self):
        self._repo_with_history()
        session = self.store.load(self.sid)
        approvals = {}
        gate = WebGate(self.repo, self.sid, approvals, threading.Lock(), session=session)

        def invoke():
            with bind_execution(store=self.store, state_dir=self.store.directory):
                return dispatch(self.repo, gate, "write",
                                {"path": "a.txt", "content": "written\n",
                                 "_tool_call_id": "approval-call"}, session)

        pending = invoke()
        self.assertEqual("approval_required", pending["error_code"])
        self.assertTrue(pending["awaiting_approval"])
        self.assertEqual([], self._records())
        self.assertEqual([], self._ref_subjects())

        # These edits occur while approval is pending. The snapshot taken on
        # approval must include them, immediately before the handler writes.
        (self.repo / "a.txt").write_text("edited while waiting\n", encoding="utf-8")
        approvals[self.sid] = {"write": {"approval-call": "a.txt"}}
        approved = invoke()
        self.assertTrue(approved["ok"], approved)
        self.assertEqual("written\n", (self.repo / "a.txt").read_text(encoding="utf-8"))
        self.assertEqual(1, len(self._records()))
        self.assertEqual("edited while waiting\n",
                         self._blob(self._hash_of(1), "a.txt"))

    def test_post_authorization_observer_finishes_before_handler_mutates(self):
        self._repo_with_history()
        entered, release = threading.Event(), threading.Event()
        git_plugin = plugin_runtime.entrypoint("git")
        original = git_plugin.after_tool_authorization
        original_timeout = plugin_runtime.TOOL_EVENT_TIMEOUT_SECONDS
        result = []

        def delayed(payload):
            entered.set()
            release.wait(2)
            original(payload)

        def invoke():
            result.append(self._tool("write", {"path": "a.txt", "content": "two\n"}))

        git_plugin.after_tool_authorization = delayed
        plugin_runtime.TOOL_EVENT_TIMEOUT_SECONDS = 0.01
        worker = threading.Thread(target=invoke)
        try:
            worker.start()
            self.assertTrue(entered.wait(1), "the authorized observer did not run")
            time.sleep(0.05)  # Longer than the observational event timeout.
            self.assertEqual("one\n", (self.repo / "a.txt").read_text(encoding="utf-8"),
                             "the handler ran before its checkpoint observer finished")
        finally:
            release.set()
            worker.join(3)
            git_plugin.after_tool_authorization = original
            plugin_runtime.TOOL_EVENT_TIMEOUT_SECONDS = original_timeout
        self.assertFalse(worker.is_alive(), "tool dispatch did not finish")
        self.assertTrue(result[0]["ok"], result)
        self.assertEqual("one\n", self._blob(self._hash_of(1), "a.txt"))

    def test_nested_workspace_rewind_preserves_outer_staged_and_unstaged_changes(self):
        nested = self.repo / "project"
        nested.mkdir()
        (self.repo / "outside.txt").write_text("outside base\n", encoding="utf-8")
        (nested / "inside.txt").write_text("inside base\n", encoding="utf-8")
        (nested / "delete-at-checkpoint.txt").write_text("tracked\n", encoding="utf-8")
        self._git("init", "-q")
        self._git("add", "-A")
        self._git(*GIT_IDENT, "commit", "-qm", "initial")

        sid = self.store.new("change nested workspace", nested)["id"]
        (nested / "snapshot-new.txt").write_text("snapshot new\n", encoding="utf-8")
        (nested / "delete-at-checkpoint.txt").unlink()
        (self.repo / "outside.txt").write_text("outside staged\n", encoding="utf-8")
        self._git("add", "outside.txt")
        (self.repo / "outside.txt").write_text("outside unstaged\n", encoding="utf-8")

        # The first authorized write creates a checkpoint of the nested root.
        self.assertTrue(self._tool("write", {"path": "inside.txt", "content": "turn write\n"},
                                   sid=sid)["ok"])
        checkpoint = turn_checkpoints.records(self.store.load(sid))[0]
        self.assertEqual("inside base\n", self._blob(checkpoint["hash"], "project/inside.txt"))
        self.assertEqual("snapshot new\n",
                         self._blob(checkpoint["hash"], "project/snapshot-new.txt"))
        absent = subprocess.run(["git", *GIT_IDENT, "cat-file", "-e",
                                 checkpoint["hash"] + ":project/delete-at-checkpoint.txt"],
                                cwd=self.repo, capture_output=True)
        self.assertNotEqual(0, absent.returncode)

        # Mutate the scoped tree after the snapshot. Include a file unknown to
        # the checkpoint; restore must leave it in place.
        (nested / "inside.txt").write_text("before rewind\n", encoding="utf-8")
        (nested / "snapshot-new.txt").write_text("new changed later\n", encoding="utf-8")
        (nested / "delete-at-checkpoint.txt").write_text("recreated later\n", encoding="utf-8")
        (nested / "unknown.txt").write_text("unknown\n", encoding="utf-8")

        status, result = self._rewind({"latest": True, "confirmed": True}, sid)
        self.assertEqual(200, status, result)
        self.assertEqual("inside base\n", (nested / "inside.txt").read_text(encoding="utf-8"))
        self.assertEqual("snapshot new\n",
                         (nested / "snapshot-new.txt").read_text(encoding="utf-8"))
        self.assertFalse((nested / "delete-at-checkpoint.txt").exists())
        self.assertEqual("unknown\n", (nested / "unknown.txt").read_text(encoding="utf-8"))
        self.assertEqual("outside unstaged\n",
                         (self.repo / "outside.txt").read_text(encoding="utf-8"))
        self.assertEqual("outside staged", self._git("show", ":outside.txt"))
        self.assertIn("MM outside.txt", self._git("status", "--short"))

        # The recovery checkpoint can replay the entire pre-rewind workspace
        # state while still leaving the outer index and worktree untouched.
        actions.restore(nested, result["recovery"]["id"])
        self.assertEqual("before rewind\n", (nested / "inside.txt").read_text(encoding="utf-8"))
        self.assertEqual("new changed later\n",
                         (nested / "snapshot-new.txt").read_text(encoding="utf-8"))
        self.assertEqual("recreated later\n",
                         (nested / "delete-at-checkpoint.txt").read_text(encoding="utf-8"))
        self.assertEqual("unknown\n", (nested / "unknown.txt").read_text(encoding="utf-8"))
        self.assertEqual("outside unstaged\n",
                         (self.repo / "outside.txt").read_text(encoding="utf-8"))
        self.assertEqual("outside staged", self._git("show", ":outside.txt"))

    # -- disabling the plugin ---------------------------------------------
    def test_disabled_plugin_snapshots_nothing_and_refuses_cli_and_http(self):
        self._repo_with_history()
        plugin_runtime.set_enabled(self.store.directory, "git", False)
        self.assertEqual(True, self._tool("write", {"path": "a.txt", "content": "two\n"})["ok"])
        self.assertEqual([], self._records())
        self.assertEqual([], self._ref_subjects())
        for method, tail, data in (
                ("GET", ["turn-checkpoints"], {}),
                ("POST", ["turn-checkpoints", "rewind"], {"latest": True, "confirmed": True})):
            parts = ["api", "sessions", self.sid, "git", *tail]
            self.assertEqual("git", plugin_runtime.route_owner(parts))
            status, body = turn_checkpoints.dispatch(method, parts, {}, data, self.ctx)
            self.assertEqual(403, status, body)
            self.assertIn("plugin disabled", body["error"])
            self.assertEqual((403, {"error": "plugin disabled or dependency unavailable: git",
                                    "plugin": "git"}),
                             plugin_runtime.dispatch_http(method, parts, {}, data, self.ctx))
        for argv in (["git", "turn-checkpoints", "--session", self.sid],
                     ["git", "rewind", "--session", self.sid, "--latest", "--confirmed"]):
            code, _, err = self._cli(argv)
            self.assertEqual(1, code, err)
            self.assertIn("plugin disabled", err)

    # -- rewind ------------------------------------------------------------
    def test_rewind_restores_files_and_writes_a_recovery_checkpoint(self):
        self._repo_with_history()
        self._tool("write", {"path": "a.txt", "content": "two\n"})    # turn 1 snapshot: one
        self._next_turn("second turn")
        self._tool("write", {"path": "a.txt", "content": "three\n"})  # turn 2 snapshot: two
        self._tool("write", {"path": "new.txt", "content": "keep\n"})
        first, second = self._checkpoint_of(1), self._checkpoint_of(2)

        status, result = self._rewind({"latest": True, "confirmed": True})
        self.assertEqual(200, status, result)
        self.assertEqual(second, result["restored"])
        self.assertEqual(2, result["turn"])
        self.assertEqual("two\n", (self.repo / "a.txt").read_text(encoding="utf-8"))
        # What the rewind overwrote stays reachable through the recovery
        # snapshot; files the checkpoint never knew are left alone.
        recovery = result["recovery"]
        self.assertEqual("three\n", self._blob(recovery["hash"], "a.txt"))
        self.assertEqual(recovery["hash"], self._git(
            "rev-parse", "--verify", "refs/xueness/checkpoints/" + recovery["id"]))
        self.assertEqual("keep\n", (self.repo / "new.txt").read_text(encoding="utf-8"))

        status, result = self._rewind({"checkpoint": first, "confirmed": True})
        self.assertEqual(200, status, result)
        self.assertEqual(first, result["restored"])
        self.assertEqual(1, result["turn"])
        self.assertEqual("one\n", (self.repo / "a.txt").read_text(encoding="utf-8"))

    def test_restore_refuses_ignored_checkpoint_path_missing_from_recovery(self):
        self._repo_with_history()
        extra = self.repo / "extra.txt"
        extra.write_text("checkpoint value\n", encoding="utf-8")
        target = actions.checkpoint(self.repo, "Target with a new file")

        # This path was added to the checkpoint but is absent from HEAD. Once
        # ignored, a recovery checkpoint cannot capture edits to it.
        (self.repo / ".gitignore").write_text("extra.txt\n", encoding="utf-8")
        extra.write_text("ignored user data\n", encoding="utf-8")
        refs_before = self._ref_subjects()
        with self.assertRaises(GitApiError) as refused:
            actions.restore(self.repo, target["id"])
        self.assertEqual(409, refused.exception.status)
        self.assertIn("Ignored files overlap", refused.exception.message)
        self.assertEqual("ignored user data\n", extra.read_text(encoding="utf-8"))
        self.assertEqual(refs_before, self._ref_subjects(),
                         "a refused restore must not create a recovery ref")

    def test_restore_refuses_ignored_file_force_added_after_checkpoint(self):
        self._repo_with_history()
        (self.repo / ".gitignore").write_text("extra.txt\n", encoding="utf-8")
        target = actions.checkpoint(self.repo, "Target before ignored file")
        extra = self.repo / "extra.txt"
        extra.write_text("staged ignored value\n", encoding="utf-8")
        self._git("add", "-f", "extra.txt")
        extra.write_text("unstaged ignored value\n", encoding="utf-8")
        refs_before = self._ref_subjects()

        with self.assertRaises(GitApiError) as refused:
            actions.restore(self.repo, target["id"])
        self.assertEqual(409, refused.exception.status)
        self.assertEqual("unstaged ignored value\n", extra.read_text(encoding="utf-8"))
        self.assertEqual("staged ignored value", self._git("show", ":extra.txt"))
        self.assertEqual(refs_before, self._ref_subjects())

    def test_rewind_refuses_without_confirmation_or_a_real_target(self):
        self._repo_with_history()
        self._tool("write", {"path": "a.txt", "content": "two\n"})
        target = self._checkpoint_of(1)
        for data, status in (({"latest": True}, 400),
                             ({"latest": True, "confirmed": False}, 400),
                             ({"confirmed": True}, 400),
                             ({"checkpoint": "f" * 32, "confirmed": True}, 404),
                             ({"checkpoint": target, "latest": True, "confirmed": True}, 400),
                             ({"checkpoint": 7, "confirmed": True}, 400),
                             ({"confirmed": True, "extra": 1}, 400)):
            self.assertEqual(status, self._rewind(data)[0], data)
        self.assertEqual("two\n", (self.repo / "a.txt").read_text(encoding="utf-8"))
        self.assertEqual(["Turn 1 before first change"], self._ref_subjects())
        # A git session that has never written anything has no snapshot to rewind to.
        idle = self.store.new("no snapshots yet", self.repo)["id"]
        self.assertEqual((409, {"error": "该会话没有可用的轮次检查点"}),
                         self._rewind({"latest": True, "confirmed": True}, idle))

    def test_rewind_route_shape_and_root_guard(self):
        self._repo_with_history()
        self._tool("write", {"path": "a.txt", "content": "two\n"})
        self.assertIsNone(turn_checkpoints.dispatch(
            "GET", ["api", "sessions", "zzz", "git", "turn-checkpoints"], {}, {}, self.ctx))
        self.assertIsNone(turn_checkpoints.dispatch(
            "POST", ["api", "sessions", self.sid, "git", "turn-checkpoints", "else"],
            {}, {"latest": True, "confirmed": True}, self.ctx))
        self.assertIsNone(turn_checkpoints.dispatch(
            "GET", ["api", "sessions", self.sid, "notgit", "turn-checkpoints"], {}, {}, self.ctx))
        self.assertEqual(405, turn_checkpoints.dispatch(
            "POST", ["api", "sessions", self.sid, "git", "turn-checkpoints"], {}, {}, self.ctx)[0])
        self.assertEqual(405, turn_checkpoints.dispatch(
            "GET", ["api", "sessions", self.sid, "git", "turn-checkpoints", "rewind"],
            {}, {}, self.ctx)[0])
        # --root is a guard: it must name this session's own workspace.
        self.assertEqual((403, {"error": "--root 与该会话的工作区不一致"}),
                         self._rewind({"latest": True, "confirmed": True, "root": str(self.plain)}))
        self.assertEqual("two\n", (self.repo / "a.txt").read_text(encoding="utf-8"))
        code, _, err = self._cli(["git", "rewind", "--session", self.sid, "--latest",
                                  "--root", str(self.plain), "--confirmed"])
        self.assertEqual(1, code, err)
        self.assertIn("--root", err)
        code, out, err = self._cli(["git", "rewind", "--session", self.sid, "--latest",
                                    "--root", str(self.repo), "--confirmed"])
        self.assertEqual(0, code, err)
        self.assertEqual("one\n", (self.repo / "a.txt").read_text(encoding="utf-8"))
        self.assertIn("Recovery before restoring", json.loads(out)["recovery"]["message"])

    def test_cli_lists_turn_checkpoints_as_json(self):
        self._repo_with_history()
        self._tool("write", {"path": "a.txt", "content": "two\n"})
        code, out, err = self._cli(["git", "turn-checkpoints", "--session", self.sid])
        self.assertEqual(0, code, err)
        payload = json.loads(out)
        self.assertEqual(self.sid, payload["session"])
        self.assertEqual([1], [item["turn"] for item in payload["turns"]])
        self.assertEqual(self._checkpoint_of(1), payload["turns"][0]["checkpointId"])
        self.assertTrue(payload["repository"])
        code, _, err = self._cli(["git", "turn-checkpoints"])
        self.assertEqual(1, code, err)
        self.assertIn("--session", err)
        code, _, err = self._cli(["git", "rewind", "--session", self.sid, "--confirmed"])
        self.assertEqual(1, code, err)
        self.assertIn("--checkpoint", err)
        code, out, err = self._cli(["git", self.sid, "status"])
        self.assertEqual(0, code, err)
        self.assertEqual(["a.txt"], [item["path"] for item in json.loads(out)["entries"]])

    # -- sessions.fork_from_checkpoint -------------------------------------
    def _two_turn_session(self):
        """One real two-turn run: each turn writes, so each turn has a snapshot."""
        from tests.test_lightweight_runtime import ScriptedProvider, call
        self._repo_with_history()
        gate = Gate(self.repo, allow_write=True)
        session = run(self.store.load(self.sid), self.store, ScriptedProvider([
            call("write", {"path": "a.txt", "content": "two\n"}, "call-t1"),
            {"content": "first answer"},
        ]), gate, max_steps=2)
        session = append_user_turn(session, self.store, "second request")
        return run(session, self.store, ScriptedProvider([
            call("write", {"path": "a.txt", "content": "three\n"}, "call-t2"),
            {"content": "second answer"},
        ]), gate, max_steps=2)

    def test_fork_from_checkpoint_copies_only_the_earlier_turns(self):
        session = self._two_turn_session()
        records = self._records(session["id"])
        self.assertEqual([1, 2], [item["turn"] for item in records])

        result = forking.fork_at_checkpoint(self.ctx, session["id"], latest=True)
        child = self.store.load(result["session"]["id"])
        self.assertEqual(["system", "user", "assistant", "tool", "assistant"],
                         [message["role"] for message in child["messages"]])
        self.assertEqual("first answer", child["messages"][-1]["content"])
        self.assertNotIn("second request", json.dumps(child["messages"], ensure_ascii=False))
        self.assertEqual({"call-t1"}, set(child["results"]))
        self.assertEqual({"checkpointId": records[1]["checkpointId"], "turn": 2},
                         result["checkpoint"])
        self.assertEqual(records[1]["checkpointId"], child["fork_parent"]["checkpointId"])
        self.assertEqual(2, child["fork_parent"]["checkpointTurn"])
        self.assertEqual(1, child["fork_parent"]["turn"])
        # The shared workspace is untouched by a fork: that is git.rewind's job.
        self.assertEqual("three\n", (self.repo / "a.txt").read_text(encoding="utf-8"))

        by_turn = forking.fork_at_checkpoint(self.ctx, session["id"], turn=2,
                                            title="Retry the second turn")
        self.assertEqual(child["messages"],
                         self.store.load(by_turn["session"]["id"])["messages"])
        self.assertEqual("Retry the second turn", by_turn["session"]["title"])

        with self.assertRaises(forking.ForkError) as first_turn:
            forking.fork_at_checkpoint(self.ctx, session["id"],
                                       checkpoint=records[0]["checkpointId"])
        self.assertEqual(409, first_turn.exception.status)
        self.assertIn("no earlier turn", str(first_turn.exception))
        with self.assertRaises(forking.ForkError):
            forking.fork_at_checkpoint(self.ctx, session["id"], checkpoint="f" * 32)
        with self.assertRaises(forking.ForkError):
            forking.fork_at_checkpoint(self.ctx, session["id"], checkpoint=records[1]["checkpointId"],
                                       latest=True)

    def test_fork_from_checkpoint_http_route(self):
        session = self._two_turn_session()
        parts = ["api", "sessions", session["id"], "fork-from-checkpoint"]
        status, response = sessions_dispatch(
            "POST", parts, {}, {"latest": True, "title": "From snapshot"}, self.ctx)
        self.assertEqual(201, status, response)
        self.assertEqual("From snapshot", response["session"]["title"])
        self.assertEqual(2, response["checkpoint"]["turn"])
        child = self.store.load(response["session"]["id"])
        self.assertEqual(2, child["fork_parent"]["checkpointTurn"])
        self.assertEqual(400, sessions_dispatch("POST", parts, {}, {"nonsense": 1}, self.ctx)[0])
        self.assertEqual(404, sessions_dispatch(
            "POST", ["api", "sessions", "f" * 32, "fork-from-checkpoint"], {},
            {"latest": True}, self.ctx)[0])
        # Turning git off stops new snapshots; it does not erase the history a
        # snapshot already recorded, and forking belongs to sessions.
        plugin_runtime.set_enabled(self.store.directory, "git", False)
        status, response = sessions_dispatch("POST", parts, {}, {"latest": True}, self.ctx)
        self.assertEqual(201, status, response)


if __name__ == "__main__":
    unittest.main()
