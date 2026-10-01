"""Safe, bounded local export/import of transcript-only sessions."""
import json
import os
from datetime import datetime, timezone
import tempfile
import unittest
from pathlib import Path

from xueness.core import Store
from xueness.bundled_plugins.sessions.operator_cli import export_session, import_session
from xueness.bundled_plugins.sessions.sessions_api import dispatch


class SessionPortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.state = self.base / "state"
        self.store = Store(self.state)
        self.session = self.store.new("task with api_key=very-secret-value", self.root)
        self.session["messages"].extend([
            {"role": "user", "content": "please use this token=private-token-value"},
            {"role": "assistant", "content": "I will inspect the file."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "danger", "function": {"name": "exec"}}]},
            {"role": "tool", "tool_call_id": "danger", "content": "secret result private-token-value"},
        ])
        self.session["results"] = {"danger": {"ok": True}}
        self.session["pending_approvals"] = [{"id": "approval-secret"}]
        self.store.save(self.session)

    def tearDown(self):
        self.temp.cleanup()

    def test_sidebar_metadata_uses_real_workspace_and_journal_activity(self):
        from xueness.bundled_plugins.sessions.session_management import list_summaries
        timestamp = 1_800_000_000
        os.utime(self.store._path(self.session["id"]), (timestamp, timestamp))
        summary = list_summaries(self.store)[0]
        self.assertEqual(summary["root"], str(self.root.resolve()))
        self.assertEqual(summary["updatedAt"], datetime.fromtimestamp(timestamp, timezone.utc).isoformat())
        self.assertNotIn("messages", summary)
        self.assertNotIn("results", summary)

    def test_export_redacts_secrets_and_drops_execution_state(self):
        result = export_session(self.store, self.session["id"], self.state)
        path = Path(result["file"])
        self.assertEqual(self.state.resolve() / "exports" / f"{self.session['id']}.xueness.json", path)
        encoded = path.read_text(encoding="utf-8")
        self.assertNotIn("very-secret-value", encoded)
        self.assertNotIn("private-token-value", encoded)
        self.assertNotIn("approval-secret", encoded)
        self.assertNotIn("tool_calls", encoded)
        self.assertNotIn('"role":"tool"', encoded)
        payload = json.loads(encoded)
        self.assertEqual(["user", "user", "assistant"], [m["role"] for m in payload["messages"]])

    def test_import_creates_new_pending_session_without_side_effect_state(self):
        export = export_session(self.store, self.session["id"], self.state)
        imported = import_session(self.store, export["file"], self.root)
        self.assertNotEqual(self.session["id"], imported["id"])
        session = self.store.load(imported["id"])
        self.assertEqual("pending", session["status"])
        self.assertEqual({}, session["results"])
        self.assertNotIn("pending_approvals", session)
        self.assertEqual(["system", "user", "user", "assistant"], [m["role"] for m in session["messages"]])

    def test_export_jail_and_no_overwrite(self):
        with self.assertRaisesRegex(ValueError, "single safe filename"):
            export_session(self.store, self.session["id"], self.state, "../escape.json")
        export_session(self.store, self.session["id"], self.state, "portable.json")
        with self.assertRaisesRegex(ValueError, "already exists"):
            export_session(self.store, self.session["id"], self.state, "portable.json")

    def test_import_rejects_symlink_and_nonexistent_workspace(self):
        export = export_session(self.store, self.session["id"], self.state)
        link = self.base / "link.json"
        link.symlink_to(export["file"])
        with self.assertRaisesRegex(ValueError, "symlink"):
            import_session(self.store, link, self.root)
        with self.assertRaisesRegex(ValueError, "existing directory"):
            import_session(self.store, export["file"], self.base / "missing")

    def test_api_export_import_has_workspace_allowlist(self):
        runs = self.base / "runs"
        runs.mkdir()
        ctx = {"store": self.store, "web_runs": runs,
               "project_dir": self.base, "workspace_roots": ()}
        status, payload = dispatch("GET", ["api", "sessions", self.session["id"], "export"], {}, {}, ctx)
        self.assertEqual(200, status)
        portable = payload["portableSession"]
        status, result = dispatch("POST", ["api", "sessions", "import"], {},
                                  {"portableSession": portable, "root": str(runs)}, ctx)
        self.assertEqual(201, status)
        self.assertEqual("pending", self.store.load(result["session"]["id"])["status"])
        status, error = dispatch("POST", ["api", "sessions", "import"], {},
                                 {"portableSession": portable, "root": str(self.base.parent)}, ctx)
        self.assertEqual(400, status)
        self.assertIn("not permitted", error["error"])


if __name__ == "__main__":
    unittest.main()
