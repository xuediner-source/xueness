"""Read-only git panel API tests (direct dispatch, no HTTP layer).

The product contract under test is twofold:

* Shapes: status/diff/log return the documented payloads, including the honest
  failure states (not a git repository -> 404, missing git -> 501, unknown
  session -> 404, non-GET on a claimed path -> 405).
* Read-only safety: every argv handed to ``subprocess.run`` is a ``git`` array
  behind ``--no-optional-locks`` whose subcommand is one of the three read-only
  verbs — asserted both by inspecting a stubbed ``subprocess.run`` and by
  checking that a real repository's HEAD and porcelain state are untouched
  after a full status/diff/log round.
"""
import os
import shutil
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path
from unittest import mock

from xueness import git_api
from xueness.core import Store

# 身份只用 -c 内联注入，避免依赖（或污染）本机全局 git 配置。
GIT_IDENT = ("-c", "user.name=Test", "-c", "user.email=test@example.com")

# 任何会改变仓库状态的子命令出现在 argv 里都算违约（产品安全契约）。
MUTATING_SUBCOMMANDS = frozenset({
    "add", "commit", "checkout", "restore", "stash", "push", "pull",
    "fetch", "merge", "rebase", "clean", "reset",
})


@unittest.skipUnless(shutil.which("git"), "git not installed")
class GitApiDispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        self._git("init")
        self.store = Store(base / "state")
        self.sid = self.store.new("git panel task", self.repo)["id"]

    def tearDown(self):
        self.temp.cleanup()

    # -- helpers ----------------------------------------------------------
    def _git(self, *argv) -> str:
        proc = subprocess.run(["git", *GIT_IDENT, *argv], cwd=self.repo,
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def _commit_file(self, name: str, content: str, message: str) -> None:
        (self.repo / name).write_text(content, encoding="utf-8")
        self._git("add", name)
        self._git("commit", "-m", message)

    def _dispatch(self, verb: str, sid: str | None = None, method: str = "GET"):
        return git_api.dispatch(
            method, ["api", "sessions", sid or self.sid, "git", verb], {}, {},
            {"store": self.store},
        )

    # -- status -----------------------------------------------------------
    def test_read_only_git_does_not_inherit_the_open_desktop_control_pipe(self):
        reader, writer = os.pipe()
        real_run = subprocess.run
        def executable(_argv, **kwargs):
            kwargs.setdefault('stdin', reader)
            kwargs['timeout'] = 3
            return real_run([sys.executable, '-c', 'import sys; sys.stdin.read(); print("input closed")'], **kwargs)
        try:
            with mock.patch.object(git_api.subprocess, 'run', side_effect=executable):
                result = git_api._run_git(str(self.repo), ['--no-optional-locks', 'status', '--porcelain=v1', '-b'])
            self.assertEqual(result.stdout.strip(), 'input closed')
        finally:
            os.close(reader); os.close(writer)

    def test_status_clean_fresh_repo(self):
        status, payload = self._dispatch("status")
        self.assertEqual(status, 200)
        self.assertEqual(payload["entries"], [])
        self.assertIs(payload["clean"], True)
        self.assertTrue(payload["branch"])
        self.assertNotIn("(detached)", payload["branch"])

    def test_status_reports_untracked_files(self):
        (self.repo / "new.txt").write_text("hi", encoding="utf-8")
        status, payload = self._dispatch("status")
        self.assertEqual(status, 200)
        self.assertEqual(payload["entries"], [{"code": "??", "path": "new.txt"}])
        self.assertIs(payload["clean"], False)

    def test_status_branch_matches_rev_parse_after_commit(self):
        self._commit_file("a.txt", "one\n", "first")
        status, payload = self._dispatch("status")
        self.assertEqual(payload["branch"], self._git("rev-parse", "--abbrev-ref", "HEAD"))

    def test_status_reports_modified_tracked_file(self):
        self._commit_file("a.txt", "one\n", "first")
        (self.repo / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
        _, payload = self._dispatch("status")
        self.assertEqual(len(payload["entries"]), 1)
        self.assertEqual(payload["entries"][0]["code"], " M")
        self.assertEqual(payload["entries"][0]["path"], "a.txt")

    # -- diff -------------------------------------------------------------
    def test_diff_returns_stat_and_patch(self):
        self._commit_file("a.txt", "one\n", "first")
        (self.repo / "a.txt").write_text("one\nchanged\n", encoding="utf-8")
        status, payload = self._dispatch("diff")
        self.assertEqual(status, 200)
        self.assertIn("a.txt", payload["stat"])
        self.assertIn("diff --git a/a.txt b/a.txt", payload["patch"])
        self.assertIn("+changed", payload["patch"])
        self.assertIs(payload["truncated"], False)

    def test_diff_clean_tree_is_empty(self):
        self._commit_file("a.txt", "one\n", "first")
        _, payload = self._dispatch("diff")
        self.assertEqual(payload["stat"], "")
        self.assertEqual(payload["patch"], "")
        self.assertIs(payload["truncated"], False)

    def test_diff_truncates_oversized_patch(self):
        self._commit_file("a.txt", "one\n", "first")
        (self.repo / "a.txt").write_text("one\n" + "x\n" * 500, encoding="utf-8")
        with mock.patch.object(git_api, "MAX_PATCH_CHARS", 50):
            _, payload = self._dispatch("diff")
        self.assertTrue(payload["patch"])
        self.assertLessEqual(len(payload["patch"]), 50)
        self.assertIs(payload["truncated"], True)

    # -- log --------------------------------------------------------------
    def test_log_lists_commits_newest_first(self):
        self._commit_file("a.txt", "one\n", "first commit")
        self._commit_file("b.txt", "two\n", "second commit")
        status, payload = self._dispatch("log")
        self.assertEqual(status, 200)
        subjects = [c["subject"] for c in payload["commits"]]
        self.assertEqual(subjects, ["second commit", "first commit"])
        head = payload["commits"][0]
        self.assertEqual(head["hash"], self._git("rev-parse", "HEAD"))
        self.assertEqual(len(head["short"]), 7)
        self.assertEqual(head["author"], "Test")
        self.assertRegex(head["date"], r"^\d{4}-\d{2}-\d{2}T")

    def test_log_empty_repository_yields_empty_list(self):
        status, payload = self._dispatch("log")
        self.assertEqual(status, 200)
        self.assertEqual(payload["commits"], [])

    # -- failure states -----------------------------------------------------
    def test_non_repo_workspace_is_404(self):
        plain = self.repo.parent / "plain"
        plain.mkdir()
        sid = self.store.new("plain task", plain)["id"]
        for verb in ("status", "diff", "log"):
            with self.subTest(verb=verb):
                self.assertEqual(
                    self._dispatch(verb, sid=sid),
                    (404, {"error": "该工作区不是 git 仓库"}),
                )

    def test_missing_workspace_root_is_not_a_repo(self):
        gone = self.repo.parent / "gone"
        sid = self.store.new("gone task", gone)["id"]  # 从未创建的目录
        self.assertEqual(
            self._dispatch("status", sid=sid),
            (404, {"error": "该工作区不是 git 仓库"}),
        )

    def test_unknown_session_is_404(self):
        self.assertEqual(
            self._dispatch("status", sid="f" * 32),
            (404, {"error": "session not found"}),
        )

    def test_invalid_sid_falls_through_as_none(self):
        # 路由形状要求 32 位十六进制 sid；不合形状的路径不属于本模块。
        self.assertIsNone(self._dispatch("status", sid="zzz"))
        self.assertIsNone(self._dispatch("status", sid="g" * 32))

    def test_unclaimed_shapes_fall_through_as_none(self):
        self.assertIsNone(self._dispatch("show"))  # 未知 verb
        self.assertIsNone(git_api.dispatch("GET", ["api", "sessions", self.sid, "git"], {}, {}, {"store": self.store}))
        self.assertIsNone(git_api.dispatch("GET", ["api", "sessions", self.sid, "git", "status", "extra"], {}, {}, {"store": self.store}))
        self.assertIsNone(git_api.dispatch("GET", ["api", "sessions", self.sid, "notgit", "status"], {}, {}, {"store": self.store}))
        self.assertIsNone(git_api.dispatch("GET", ["api", "providers"], {}, {}, {"store": self.store}))

    def test_non_get_method_on_claimed_path_is_405(self):
        for method in ("POST", "DELETE", "PUT", "PATCH"):
            with self.subTest(method=method):
                self.assertEqual(
                    self._dispatch("status", method=method),
                    (405, {"error": "method not allowed"}),
                )

    # -- subprocess contract ------------------------------------------------
    def test_argv_is_read_only_git_behind_no_optional_locks(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((list(argv), kwargs))
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with mock.patch.object(git_api.subprocess, "run", side_effect=fake_run):
            for verb in ("status", "diff", "log"):
                status, _ = self._dispatch(verb)
                self.assertEqual(status, 200)

        self.assertGreaterEqual(len(calls), 3)  # diff 自身就跑 stat + patch 两条
        for argv, kwargs in calls:
            self.assertEqual(argv[0], "git")
            self.assertEqual(argv[1], "--no-optional-locks")
            self.assertNotIn(argv[2], MUTATING_SUBCOMMANDS)
            self.assertIn(argv[2], {"status", "diff", "log"})
            self.assertTrue(all(isinstance(part, str) for part in argv))
            self.assertEqual(kwargs["timeout"], 10)
            self.assertTrue(kwargs["capture_output"])
            self.assertTrue(kwargs["text"])
            self.assertIsInstance(kwargs["env"], dict)
            self.assertEqual(kwargs["cwd"], str(Path(self.store.load(self.sid)["root"])))

    def test_real_round_never_mutates_the_repository(self):
        self._commit_file("a.txt", "one\n", "first")
        (self.repo / "untracked.txt").write_text("keep me\n", encoding="utf-8")
        before = (
            self._git("rev-parse", "HEAD"),
            self._git("status", "--porcelain=v1"),
            self._git("stash", "list"),
        )
        for verb in ("status", "diff", "log"):
            status, _ = self._dispatch(verb)
            self.assertEqual(status, 200, verb)
        after = (
            self._git("rev-parse", "HEAD"),
            self._git("status", "--porcelain=v1"),
            self._git("stash", "list"),
        )
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
