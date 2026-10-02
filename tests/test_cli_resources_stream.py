"""Batch 13: CLI resource management, show --timeline, stream-json output.

Covers:
* ``xueness resources`` — create/list/show/enable/disable/delete over the same
  ``resources.dispatch`` jail the web uses (no second implementation);
* ``show --timeline`` — the derived event tail rendered under the summary;
* ``run --output-format stream-json`` — one JSON line per live event, final
  line ``type=="summary"``, stderr free of event lines.
"""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from xueness.cli import main as cli_main


class ResourcesCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = str(self.root / "state")

    def tearDown(self):
        self.temp.cleanup()

    def _cli(self, argv):
        stderr = io.StringIO()
        stdout = io.StringIO()
        try:
            with redirect_stderr(stderr), redirect_stdout(stdout):
                code = cli_main(["--state", self.state, *argv])
        except SystemExit as exc:
            # argparse usage errors exit(2): surface them as a normal code so
            # tests can assert on the message.
            code = exc.code
        return code, stdout.getvalue(), stderr.getvalue()

    def test_create_list_show_enable_disable_delete_round_trip(self):
        code, out, err = self._cli([
            "resources", "create", "skills", "deploy-runbook",
            "--description", "部署手册", "--body", "# 步骤\n- 构建",
        ])
        self.assertEqual(code, 0, err)
        item = json.loads(out)
        self.assertEqual(item["id"], "deploy-runbook")
        self.assertTrue(item["enabled"])
        self.assertEqual(item["body"], "# 步骤\n- 构建")

        code, out, _ = self._cli(["resources", "list", "skills"])
        self.assertEqual(code, 0)
        self.assertEqual([i["id"] for i in json.loads(out)["items"]], ["deploy-runbook"])

        code, out, _ = self._cli(["resources", "show", "skills", "deploy-runbook"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["description"], "部署手册")

        code, out, _ = self._cli(["resources", "disable", "skills", "deploy-runbook"])
        self.assertEqual(code, 0)
        code, out, _ = self._cli(["resources", "show", "skills", "deploy-runbook"])
        self.assertFalse(json.loads(out)["enabled"])

        code, out, _ = self._cli(["resources", "enable", "skills", "deploy-runbook"])
        self.assertEqual(code, 0)
        code, out, _ = self._cli(["resources", "show", "skills", "deploy-runbook"])
        self.assertTrue(json.loads(out)["enabled"])

        code, out, _ = self._cli(["resources", "delete", "skills", "deploy-runbook"])
        self.assertEqual(code, 0)
        code, out, err = self._cli(["resources", "show", "skills", "deploy-runbook"])
        self.assertEqual(code, 1)
        self.assertIn("not found", err)

    def test_create_rejects_illegal_id_with_error_and_no_file(self):
        code, out, err = self._cli([
            "resources", "create", "hooks", "../escape",
            "--event", "PostToolUse", "--command", "echo hi",
        ])
        self.assertEqual(code, 1)
        self.assertIn("ERROR", err)
        self.assertFalse((self.root / "state" / "resources" / "hooks").exists())

    def test_unknown_kind_is_rejected_by_argparse(self):
        code, out, err = self._cli(["resources", "list", "nope"])
        self.assertEqual(code, 2)  # argparse usage error
        self.assertIn("invalid choice", err)

    def test_body_file_flag_reads_file(self):
        body_path = self.root / "body.md"
        body_path.write_text("# runbook", encoding="utf-8")
        code, out, err = self._cli([
            "resources", "create", "commands", "greet",
            "--description", "问候", "--body-file", str(body_path),
        ])
        self.assertEqual(code, 0, err)
        code, out, _ = self._cli(["resources", "show", "commands", "greet"])
        self.assertEqual(json.loads(out)["body"], "# runbook")


class ShowTimelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            cli_main(["--state", str(self.root / "state"), "run", "--prompt", "t",
                      "--root", str(self.root), "--allow-write"])
        self.state = str(self.root / "state")
        self.sid = json.loads(stdout.getvalue())["id"]

    def tearDown(self):
        self.temp.cleanup()

    def test_timeline_renders_after_summary(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            cli_main(["--state", self.state, "show", self.sid, "--timeline"])
        out = stdout.getvalue()
        # Summary JSON first…
        payload = json.loads(out.split("--- timeline ---")[0])
        self.assertEqual(payload["id"], self.sid)
        # …then the event tail in the shared vocabulary.
        self.assertIn("→ write", out)
        self.assertIn("✓", out)
        self.assertIn("运行结束", out)
        self.assertIn("交付内容尚未检查", out)

    def test_plain_show_stays_json_only(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            cli_main(["--state", self.state, "show", self.sid])
        self.assertNotIn("timeline", stdout.getvalue())
        json.loads(stdout.getvalue())


class StreamJsonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)

    def tearDown(self):
        self.temp.cleanup()

    def test_every_stdout_line_is_json_and_last_is_summary(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            code = cli_main(["--state", str(self.root / "state"), "run", "--prompt", "t",
                             "--root", str(self.root), "--allow-write",
                             "--output-format", "stream-json"])
        self.assertEqual(code, 0)
        lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertTrue(lines)
        events = [json.loads(line) for line in lines]
        self.assertTrue(all(isinstance(e, dict) and "type" in e for e in events))
        self.assertEqual(events[-1]["type"], "summary")
        self.assertEqual(events[-1]["status"], "completed")
        self.assertIn("tool_call", [e["type"] for e in events])
        self.assertIn("tool_result", [e["type"] for e in events])
        # stderr carries no event lines in this mode.
        self.assertNotIn("→", stderr.getvalue())

    def test_exit_code_still_signals_needs_review(self):
        # Plan mode denies everything; the fake demo cannot complete, so the
        # summary line reports needs_review with pending denials.
        stderr = io.StringIO()
        stdout = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            code = cli_main(["--state", str(self.root / "state"), "run", "--prompt", "t",
                             "--root", str(self.root), "--mode", "plan",
                             "--output-format", "stream-json"])
        self.assertEqual(code, 2)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(lines[-1]["type"], "summary")
        self.assertEqual(lines[-1]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
