"""Batch 14: CLI surface parity with the web's read-side stage-2 modules.

``settings`` / ``settings-set`` / ``usage`` / ``memory-tracks`` / ``git`` call
the same dispatch functions as the web handler, so a CLI answer and a web
answer cannot drift apart. Covered here:
* settings show (all + one section) and settings-set round trip,
* usage totals after a real fake-provider run,
* memory-tracks honest empty state without XUENESS_MEMORY_ROOT,
* git status over a real repo in a session workspace and the honest 404 for a
  non-repo workspace.
"""
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from xueness.cli import main as cli_main


def _cli(state, argv):
    stderr = io.StringIO()
    stdout = io.StringIO()
    try:
        with redirect_stderr(stderr), redirect_stdout(stdout):
            code = cli_main(["--state", str(state), *argv])
    except SystemExit as exc:
        code = exc.code
    return code, stdout.getvalue(), stderr.getvalue()


class Stage2CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            cli_main(["--state", str(self.state), "run", "--prompt", "t",
                      "--root", str(self.root), "--allow-write",
                      "--output-format", "json"])
        self.sid = json.loads(stdout.getvalue())["id"]

    def tearDown(self):
        self.temp.cleanup()

    def test_settings_show_all_and_single_section(self):
        code, out, err = _cli(self.state, ["settings"])
        self.assertEqual(code, 0, err)
        # Empty store: a valid document, simply without any section yet.
        self.assertIsInstance(json.loads(out)["settings"], dict)
        code, out, _ = _cli(self.state, ["settings", "agent"])
        self.assertEqual(json.loads(out)["section"], "agent")

    def test_settings_set_round_trip_values_and_types(self):
        code, out, err = _cli(self.state, ["settings-set", "agent", "allowMcp", "true"])
        self.assertEqual(code, 0, err)
        code, out, _ = _cli(self.state, ["settings", "agent"])
        self.assertTrue(json.loads(out)["values"]["allowMcp"])
        # A bare string falls back to text; an explicit JSON stays typed.
        code, _, _ = _cli(self.state, ["settings-set", "agent", "note", "hello"])
        self.assertEqual(code, 0)
        code, out, _ = _cli(self.state, ["settings", "agent"])
        self.assertEqual(json.loads(out)["values"]["note"], "hello")

    def test_settings_set_rejects_unknown_section(self):
        code, _, err = _cli(self.state, ["settings-set", "nope", "k", "v"])
        self.assertEqual(code, 2)
        self.assertIn("invalid choice", err)

    def test_usage_totals_after_run(self):
        code, out, err = _cli(self.state, ["usage"])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertGreaterEqual(payload["totals"]["sessions"], 1)
        self.assertIn("series", payload)
        self.assertIn("updatedAt", payload)

    def test_memory_tracks_empty_without_root(self):
        code, out, _ = _cli(self.state, ["memory-tracks"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["tracks"], [])

    def test_git_status_over_real_repo_and_non_repo_404(self):
        sid = self.sid
        # The fake run above used --root self.root, so that directory exists.
        workspace = self.root
        subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "t@local"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=workspace, check=True)
        (workspace / "tracked.txt").write_text("one\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=workspace, check=True)
        (workspace / "tracked.txt").write_text("two\n", encoding="utf-8")

        code, out, err = _cli(self.state, ["git", sid, "status"])
        self.assertEqual(code, 0, err)
        status = json.loads(out)
        self.assertIn("master", status["branch"])
        self.assertEqual([e["path"] for e in status["entries"]], ["tracked.txt"])

        code, out, _ = _cli(self.state, ["git", sid, "diff"])
        self.assertIn("diff --git", json.loads(out)["patch"])

        code, out, _ = _cli(self.state, ["git", sid, "log"])
        self.assertEqual(json.loads(out)["commits"][0]["subject"], "init")

        # A session whose workspace is not a repo: honest 404, exit 1. The
        # workspace must live outside the repo above — git walks up the tree.
        with tempfile.TemporaryDirectory() as plain_temp:
            other_root = Path(plain_temp) / "plain"
            other_root.mkdir()
            code, out, _ = _cli(self.state, ["new", "plain task", "--root", str(other_root)])
            other_sid = out.strip()
            code, out, err = _cli(self.state, ["git", other_sid, "status"])
        self.assertEqual(code, 1)
        self.assertIn("该工作区不是 git 仓库", err)


if __name__ == "__main__":
    unittest.main()
