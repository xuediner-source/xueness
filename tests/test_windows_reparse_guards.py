"""Windows directory-junction coverage for filesystem security boundaries.

Junctions are real NTFS directory reparse points, not file symlinks or
hardlinks. File-symlink-only behavior remains covered by the separate tests
that use ``make_symlink`` and report unavailable Windows privilege precisely.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from tests.fs_link_helpers import make_directory_junction, remove_directory_junction
from xueness import plugin_sdk, resources
from xueness.bundled_plugins.sessions import session_management
from xueness.bundled_plugins.sessions.operator_cli import export_session
from xueness.core import Gate, Store, execute
from xueness.session_lease import lease
from xueness.skills import load as load_skills
from xueness.write_lock import WriteLocks


@unittest.skipUnless(os.name == "nt", "directory-junction isolation is Windows-specific")
class WindowsReparseGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def junction(self, link: Path, target: Path) -> Path:
        created = make_directory_junction(link, target)
        # Registered after TemporaryDirectory.cleanup so junction entries are
        # removed first and cleanup can never recurse into their targets.
        self.addCleanup(remove_directory_junction, created)
        return created

    @staticmethod
    def manifest(ident: str) -> dict:
        return {
            "id": ident,
            "version": "1.0.0",
            "apiVersion": plugin_sdk.API_VERSION,
            "enabled": True,
            "builtin": "mcp",
        }

    def test_glob_read_and_write_stay_inside_workspace_through_junction(self):
        workspace = self.base / "workspace"
        workspace.mkdir()
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text("junction secret", encoding="utf-8")
        self.junction(workspace / "linked", outside)

        globbed = execute(workspace, Gate(workspace), "glob", {"pattern": "*.txt"})
        self.assertTrue(globbed["ok"], globbed)
        self.assertFalse(any(path.startswith("linked/") for path in globbed["output"]))

        read = execute(workspace, Gate(workspace), "read", {"path": "linked/private.txt"})
        self.assertFalse(read["ok"], read)
        self.assertNotIn("junction secret", json.dumps(read))

        write = execute(workspace, Gate(workspace, allow_write=True), "write", {
            "path": "linked/escaped.txt", "content": "outside write",
        })
        self.assertFalse(write["ok"], write)
        self.assertFalse((outside / "escaped.txt").exists())

    def test_skills_loader_rejects_junctioned_resources_and_kind_roots(self):
        outside_resources = self.base / "outside-resources"
        outside_skills = outside_resources / "skills"
        outside_skills.mkdir(parents=True)
        (outside_skills / "secret.json").write_text(json.dumps({
            "id": "secret", "name": "Secret", "body": "junction skill secret",
        }), encoding="utf-8")

        state_with_resources_junction = self.base / "state-resources-junction"
        state_with_resources_junction.mkdir()
        self.junction(state_with_resources_junction / "resources", outside_resources)
        self.assertEqual(load_skills(state_with_resources_junction), "")

        state_with_kind_junction = self.base / "state-kind-junction"
        (state_with_kind_junction / "resources").mkdir(parents=True)
        self.junction(state_with_kind_junction / "resources" / "skills", outside_skills)
        self.assertEqual(load_skills(state_with_kind_junction), "")

    def test_resources_reject_junctioned_parent_and_each_kind_for_crud(self):
        # A redirected resources parent must fail closed for every resource
        # kind before any GET, create, replacement, or delete reaches the target.
        outside_parent = self.base / "outside-resource-parent"
        outside_parent.mkdir()
        redirected_state = self.base / "state-parent-junction"
        redirected_state.mkdir()
        for kind in resources.KINDS:
            target = outside_parent / kind
            target.mkdir()
            sentinel = target / "sentinel.json"
            sentinel.write_text(json.dumps({"id": "sentinel", "body": "must stay private"}),
                                encoding="utf-8")
        self.junction(redirected_state / "resources", outside_parent)
        redirected_ctx = {"state_dir": redirected_state}
        for kind in resources.KINDS:
            with self.subTest(boundary="resources-parent", kind=kind):
                status, payload = resources.dispatch(
                    "GET", ["api", "resources", kind], {}, {}, redirected_ctx)
                self.assertEqual(status, 400, payload)
                self.assertNotIn("must stay private", json.dumps(payload))
                status, _ = resources.dispatch(
                    "POST", ["api", "resources", kind], {}, {"id": "escaped"}, redirected_ctx)
                self.assertEqual(status, 400)
                self.assertFalse((outside_parent / kind / "escaped.json").exists())

        # Each kind directory is also an independent storage boundary.
        for kind in resources.KINDS:
            with self.subTest(boundary="kind-root", kind=kind):
                state = self.base / f"state-kind-{kind}"
                (state / "resources").mkdir(parents=True)
                outside = self.base / f"outside-kind-{kind}"
                outside.mkdir()
                sentinel = outside / "sentinel.json"
                sentinel.write_text(json.dumps({"id": "sentinel", "body": "kind secret"}),
                                    encoding="utf-8")
                self.junction(state / "resources" / kind, outside)
                ctx = {"state_dir": state}

                status, payload = resources.dispatch(
                    "GET", ["api", "resources", kind], {}, {}, ctx)
                self.assertEqual(status, 400, payload)
                self.assertNotIn("kind secret", json.dumps(payload))
                status, _ = resources.dispatch(
                    "POST", ["api", "resources", kind], {}, {"id": "escaped"}, ctx)
                self.assertEqual(status, 400)
                status, _ = resources.dispatch(
                    "PUT", ["api", "resources", kind], {}, {"items": []}, ctx)
                self.assertEqual(status, 400)
                status, _ = resources.dispatch(
                    "DELETE", ["api", "resources", kind, "sentinel"], {}, {}, ctx)
                self.assertEqual(status, 400)
                self.assertTrue(sentinel.exists(), "DELETE crossed the kind-directory junction")
                self.assertFalse((outside / "escaped.json").exists())

    def test_plugin_manifests_reject_junctioned_state_and_plugin_roots(self):
        actual_state = self.base / "actual-state"
        actual_plugins = actual_state / "resources" / "plugins"
        actual_plugins.mkdir(parents=True)
        (actual_plugins / "secret.json").write_text(
            json.dumps(self.manifest("secret")), encoding="utf-8")
        state_alias = self.base / "state-alias"
        self.junction(state_alias, actual_state)

        self.assertEqual(plugin_sdk.load_manifests(state_alias), [])
        result = plugin_sdk.install_all(state_alias, [self.manifest("escaped")])
        self.assertFalse(result["ok"], result)
        self.assertFalse((actual_plugins / "escaped.json").exists())

        state = self.base / "ordinary-state"
        (state / "resources").mkdir(parents=True)
        outside_plugins = self.base / "outside-plugins"
        outside_plugins.mkdir()
        (outside_plugins / "secret.json").write_text(
            json.dumps(self.manifest("secret")), encoding="utf-8")
        self.junction(state / "resources" / "plugins", outside_plugins)

        self.assertEqual(plugin_sdk.load_manifests(state), [])
        result = plugin_sdk.install_all(state, [self.manifest("escaped")])
        self.assertFalse(result["ok"], result)
        self.assertFalse((outside_plugins / "escaped.json").exists())

    def test_session_lease_refuses_junctioned_lock_directory(self):
        state = self.base / "state"
        store = Store(state)
        workspace = self.base / "workspace"
        workspace.mkdir()
        session = store.new("test lease boundary", workspace)
        outside = self.base / "outside-locks"
        outside.mkdir()
        self.junction(store.directory / ".locks", outside)

        with self.assertRaisesRegex(ValueError, "lock directory"):
            with lease(store, session["id"]):
                self.fail("lease unexpectedly followed a junction")
        self.assertEqual(list(outside.iterdir()), [])

    def test_store_rejects_junctioned_session_root_before_resolving(self):
        sid = "0123456789abcdef0123456789abcdef"
        outside_sessions = self.base / "outside-sessions"
        outside_sessions.mkdir()
        outside_journal = outside_sessions / f"{sid}.json"
        original = json.dumps({
            "id": sid, "task": "external session sentinel", "status": "pending",
        }).encode("utf-8")
        outside_journal.write_bytes(original)
        redirected_sessions = self.base / "redirected-sessions"
        self.junction(redirected_sessions, outside_sessions)

        with self.assertRaisesRegex(ValueError, "session directory"):
            Store(redirected_sessions)

        self.assertEqual(outside_journal.read_bytes(), original)
        self.assertEqual([path.name for path in outside_sessions.iterdir()], [outside_journal.name])

    def test_session_read_state_archive_and_export_refuse_junctions(self):
        state = self.base / "state"
        store = Store(state)
        workspace = self.base / "workspace"
        workspace.mkdir()
        session = store.new("test management boundaries", workspace)

        read_state_outside = self.base / "outside-read-state"
        read_state_outside.mkdir()
        self.junction(store.directory / ".xueness-session-read", read_state_outside)
        with self.assertRaisesRegex(ValueError, "read state directory"):
            session_management.mark_viewed(store, session["id"])
        self.assertEqual(list(read_state_outside.iterdir()), [])

        # Use another Store so each protected directory is independently
        # replaced by a real junction in this test.
        archive_state = self.base / "archive-state"
        archive_store = Store(archive_state)
        archived_session = archive_store.new("archive target", workspace)
        outside_archive = self.base / "outside-archive"
        outside_archive.mkdir()
        self.junction(archive_store.directory / "deleted-sessions", outside_archive)
        self.assertEqual(session_management.list_archived(archive_store), [])
        with self.assertRaisesRegex(ValueError, "archive directory"):
            session_management.archive(archive_store, archived_session["id"])
        self.assertTrue(archive_store._path(archived_session["id"]).exists())
        self.assertEqual(list(outside_archive.iterdir()), [])

        export_state = self.base / "export-state"
        export_store = Store(export_state)
        export_session_record = export_store.new("export target", workspace)
        outside_exports = self.base / "outside-exports"
        outside_exports.mkdir()
        self.junction(export_store.directory / "exports", outside_exports)
        with self.assertRaisesRegex(ValueError, "exports directory"):
            export_session(export_store, export_session_record["id"], export_state)
        self.assertEqual(list(outside_exports.iterdir()), [])

    def test_session_restore_refuses_junctioned_archive_directory(self):
        state = self.base / "restore-state"
        store = Store(state)
        sid = "0123456789abcdef0123456789abcdef"
        outside_archive = self.base / "outside-restore-archive"
        outside_archive.mkdir()
        archive_file = outside_archive / f"{sid}.json"
        original = json.dumps({
            "id": sid,
            "task": "external archive sentinel",
            "status": "completed",
            "management_history": [],
        }, ensure_ascii=False, indent=2).encode("utf-8")
        archive_file.write_bytes(original)
        self.junction(store.directory / "deleted-sessions", outside_archive)

        with self.assertRaisesRegex(ValueError, "archive directory"):
            session_management.restore(store, sid)

        self.assertEqual(archive_file.read_bytes(), original)
        self.assertEqual([path.name for path in outside_archive.iterdir()], [archive_file.name])
        self.assertFalse(store._path(sid).exists())

    def test_write_locks_canonicalize_a_junction_parent(self):
        target_dir = self.base / "real-files"
        target_dir.mkdir()
        target = target_dir / "report.txt"
        target.write_text("original", encoding="utf-8")
        alias_dir = self.base / "directory-alias"
        self.junction(alias_dir, target_dir)

        locks = WriteLocks()
        self.assertTrue(locks.acquire(target, "writer-one"))
        self.assertFalse(locks.acquire(alias_dir / target.name, "writer-two"))
        self.assertEqual(locks.holder(alias_dir / target.name), "writer-one")


if __name__ == "__main__":
    unittest.main()
