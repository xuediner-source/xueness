"""Tests for the generic resource repository (Stage 2 contract, section 2)."""
import json
import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import (
    is_reparse_point, make_directory_junction, make_symlink,
    remove_directory_junction,
)
from tests.secret_permissions import (
    assert_secret_directory_private, assert_secret_file_private,
)
from xueness import plugin_sdk, resources
from xueness.resources import KINDS, dispatch


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name)
        self.ctx = {"state_dir": self.state}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, method, parts, data=None, query=None):
        return dispatch(method, parts, query or {}, data if data is not None else {}, self.ctx)

    # --- happy path -------------------------------------------------
    def test_six_kinds_create_read_delete(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                status, payload = self.call(
                    "POST", ["api", "resources", kind],
                    {"id": "alpha", "label": "Alpha " + kind})
                self.assertEqual(status, 200)
                self.assertIn("item", payload)
                item = payload["item"]
                self.assertEqual(item["id"], "alpha")
                self.assertEqual(item["label"], "Alpha " + kind)
                self.assertIsInstance(item["createdAt"], str)
                self.assertIsInstance(item["updatedAt"], str)

                status, payload = self.call("GET", ["api", "resources", kind])
                self.assertEqual(status, 200)
                self.assertTrue(payload["capability"]["userScopeAvailable"])
                ids = [entry["id"] for entry in payload["items"]]
                self.assertEqual(ids, ["alpha"])
                self.assertEqual(payload["items"][0]["label"], "Alpha " + kind)

                status, payload = self.call("DELETE", ["api", "resources", kind, "alpha"])
                self.assertEqual(status, 200)
                self.assertEqual(payload, {"ok": True, "id": "alpha"})

                status, payload = self.call("GET", ["api", "resources", kind])
                self.assertEqual(status, 200)
                self.assertEqual(payload["items"], [])

    def test_get_sorted_by_id_ascending(self):
        for rid in ["zeta", "alpha", "Beta", "mid-1"]:
            status, _ = self.call("POST", ["api", "resources", "skills"], {"id": rid})
            self.assertEqual(status, 200)
        status, payload = self.call("GET", ["api", "resources", "skills"])
        self.assertEqual(status, 200)
        self.assertEqual([i["id"] for i in payload["items"]], sorted(
            ["zeta", "alpha", "Beta", "mid-1"]))
        # stable across repeated reads
        _, again = self.call("GET", ["api", "resources", "skills"])
        self.assertEqual(payload["items"], again["items"])

    def test_upsert_preserves_created_and_refreshes_updated(self):
        status, first = self.call(
            "POST", ["api", "resources", "commands"], {"id": "run", "n": 1})
        self.assertEqual(status, 200)
        created = first["item"]["createdAt"]
        updated = first["item"]["updatedAt"]
        time.sleep(0.01)
        status, second = self.call(
            "POST", ["api", "resources", "commands"], {"id": "run", "n": 2})
        self.assertEqual(status, 200)
        self.assertEqual(second["item"]["createdAt"], created)
        self.assertNotEqual(second["item"]["updatedAt"], updated)
        self.assertEqual(second["item"]["n"], 2)

        status, payload = self.call("GET", ["api", "resources", "commands"])
        self.assertEqual(len(payload["items"]), 1)
        self.assertEqual(payload["items"][0]["n"], 2)
        self.assertEqual(payload["items"][0]["createdAt"], created)

    def test_create_only_rejects_duplicate_without_overwriting(self):
        status, first = self.call(
            "POST", ["api", "resources", "plugins"],
            {"id": "manifest", "name": "Original", "createOnly": True})
        self.assertEqual(status, 200)
        self.assertNotIn("createOnly", first["item"])

        status, payload = self.call(
            "POST", ["api", "resources", "plugins"],
            {"id": "manifest", "name": "Replacement", "createOnly": True})
        self.assertEqual(status, 409)
        self.assertIn("already exists", payload["error"])
        _, listed = self.call("GET", ["api", "resources", "plugins"])
        self.assertEqual(listed["items"][0]["name"], "Original")

    def test_concurrent_create_only_allows_one_writer(self):
        first_inside_write = threading.Event()
        release_first_write = threading.Event()
        second_reached_write = threading.Event()
        results = {}
        original_write = resources._atomic_write_json

        def gated_write(path, item):
            thread_name = threading.current_thread().name
            if thread_name == "create-only-first":
                first_inside_write.set()
                if not release_first_write.wait(2):
                    raise TimeoutError("test did not release first writer")
            elif thread_name == "create-only-second":
                second_reached_write.set()
            return original_write(path, item)

        def create(name):
            results[name] = self.call(
                "POST", ["api", "resources", "plugins"],
                {"id": "same-id", "name": name, "createOnly": True})[0]

        with patch.object(resources, "_atomic_write_json", side_effect=gated_write):
            first = threading.Thread(target=create, args=("first",), name="create-only-first")
            second = threading.Thread(target=create, args=("second",), name="create-only-second")
            first.start()
            self.assertTrue(first_inside_write.wait(1))
            second.start()
            try:
                self.assertFalse(second_reached_write.wait(0.15))
            finally:
                release_first_write.set()
            first.join(2)
            second.join(2)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(sorted(results.values()), [200, 409])
        self.assertFalse(second_reached_write.is_set())
        _, listed = self.call("GET", ["api", "resources", "plugins"])
        self.assertEqual(len(listed["items"]), 1)

    def test_create_only_serializes_with_plugin_sdk_install(self):
        sdk_inside_write = threading.Event()
        release_sdk_write = threading.Event()
        resource_reached_write = threading.Event()
        results = {}
        sdk_write = plugin_sdk._atomic_write_json
        resource_write = resources._atomic_write_json

        def gated_sdk_write(path, item):
            sdk_inside_write.set()
            if not release_sdk_write.wait(2):
                raise TimeoutError("test did not release plugin SDK install")
            return sdk_write(path, item)

        def gated_resource_write(path, item):
            resource_reached_write.set()
            return resource_write(path, item)

        def install():
            results["install"] = plugin_sdk.install_all(self.state, [{
                "id": "shared-id", "version": "1.0.0", "apiVersion": 1,
                "enabled": False, "builtin": "mcp",
            }])

        def create_only():
            results["resource"] = self.call(
                "POST", ["api", "resources", "plugins"],
                {"id": "shared-id", "name": "must not replace", "createOnly": True})[0]

        with patch.object(plugin_sdk, "_atomic_write_json", side_effect=gated_sdk_write), \
             patch.object(resources, "_atomic_write_json", side_effect=gated_resource_write):
            install_thread = threading.Thread(target=install, name="sdk-install")
            resource_thread = threading.Thread(target=create_only, name="resource-create")
            install_thread.start()
            self.assertTrue(sdk_inside_write.wait(1))
            resource_thread.start()
            try:
                self.assertFalse(resource_reached_write.wait(0.15))
            finally:
                release_sdk_write.set()
            install_thread.join(2)
            resource_thread.join(2)

        self.assertFalse(install_thread.is_alive())
        self.assertFalse(resource_thread.is_alive())
        self.assertTrue(results["install"]["ok"])
        self.assertEqual(results["resource"], 409)
        self.assertFalse(resource_reached_write.is_set())
        saved = json.loads((self.state / "resources" / "plugins" / "shared-id.json").read_text())
        self.assertEqual(saved["version"], "1.0.0")
        self.assertNotIn("name", saved)

    # --- persistence -------------------------------------------------
    def test_file_on_disk_is_valid_json(self):
        status, _ = self.call(
            "POST", ["api", "resources", "hooks"], {"id": "post-save", "when": "save"})
        self.assertEqual(status, 200)
        path = self.state / "resources" / "hooks" / "post-save.json"
        self.assertTrue(path.is_file())
        raw = path.read_text(encoding="utf-8")
        loaded = json.loads(raw)
        self.assertEqual(loaded["id"], "post-save")
        self.assertEqual(loaded["when"], "save")
        self.assertIn("createdAt", loaded)
        self.assertIn("updatedAt", loaded)
        assert_secret_file_private(self, path)

    def test_private_directory_is_protected(self):
        directory = self.state / "browser-profile"
        directory.mkdir()

        resources._protect_private_directory(directory)

        assert_secret_directory_private(self, directory)

    def test_private_directory_does_not_create_missing_path(self):
        directory = self.state / "missing-profile"
        with self.assertRaises(OSError):
            resources._protect_private_directory(directory)
        self.assertFalse(directory.exists())

    def test_private_directory_rejects_symlink_or_junction(self):
        target = self.state / "profile-target"
        target.mkdir()
        link = self.state / "profile-link"
        if os.name == "nt":
            make_directory_junction(link, target)
        else:
            make_symlink(link, target, target_is_directory=True)
        try:
            with self.assertRaises(OSError):
                resources._protect_private_directory(link)
            self.assertTrue(target.is_dir())
        finally:
            if os.name == "nt" and is_reparse_point(link):
                remove_directory_junction(link)

    def test_private_directory_failure_is_propagated_and_closes_handle(self):
        directory = self.state / "failed-profile"
        directory.mkdir()
        if os.name == "nt":
            with patch.object(resources, "_protect_private_windows_handle",
                              side_effect=OSError("simulated ACL setup failure")):
                with self.assertRaisesRegex(OSError, "simulated ACL setup failure"):
                    resources._protect_private_directory(directory)
            return

        opened_fds = []
        original_open = os.open

        def track_open(path, flags):
            fd = original_open(path, flags)
            opened_fds.append(fd)
            return fd

        with patch.object(os, "open", side_effect=track_open), \
             patch.object(os, "fchmod", side_effect=OSError("simulated chmod failure")):
            with self.assertRaisesRegex(OSError, "simulated chmod failure"):
                resources._protect_private_directory(directory)

        self.assertEqual(len(opened_fds), 1)
        with self.assertRaises(OSError):
            os.fstat(opened_fds[0])

    @unittest.skipUnless(os.name == "nt", "Windows inherited directory ACL coverage")
    def test_private_directory_acl_is_inherited_by_new_files(self):
        directory = self.state / "browser-profile"
        directory.mkdir()
        resources._protect_private_directory(directory)

        child = directory / "Preferences"
        child.write_text("private profile data", encoding="utf-8")

        assert_secret_file_private(self, child, require_protected=False)

    @unittest.skipUnless(os.name == "nt", "Windows existing-child ACL propagation")
    def test_private_directory_acl_repairs_existing_unprotected_children(self):
        directory = self.state / "browser-profile"
        child_directory = directory / "Default"
        child_directory.mkdir(parents=True)
        child_file = child_directory / "Preferences"
        child_file.write_text("old profile data", encoding="utf-8")

        resources._protect_private_directory(directory)

        assert_secret_directory_private(self, directory)
        assert_secret_directory_private(
            self, child_directory, require_protected=False)
        assert_secret_file_private(self, child_file, require_protected=False)

    def test_private_acl_failure_preserves_old_record_and_cleans_temp_fd(self):
        path = self.state / "resources" / "hooks" / "existing.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        original = b'{"id":"existing","apiKey":"old-secret"}\n'
        path.write_bytes(original)
        opened_fds = []

        def reject_private_file(fd):
            opened_fds.append(fd)
            raise OSError("simulated ACL setup failure")

        with patch.object(resources, "_protect_private_file",
                          side_effect=reject_private_file):
            with self.assertRaisesRegex(OSError, "simulated ACL setup failure"):
                resources._atomic_write_json(path, {"id": "existing", "apiKey": "new-secret"})

        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(path.parent.glob(".resource-*")), [])
        self.assertNotIn(b"new-secret", b"".join(item.read_bytes() for item in path.parent.iterdir()))
        self.assertEqual(len(opened_fds), 1)
        with self.assertRaises(OSError):
            os.fstat(opened_fds[0])
        # no temp leftovers after an atomic write
        leftovers = [p.name for p in path.parent.iterdir() if p.name.startswith(".resource-")]
        self.assertEqual(leftovers, [])

    def test_timestamp_is_iso8601_utc(self):
        _, payload = self.call("POST", ["api", "resources", "mcp"], {"id": "srv"})
        stamp = payload["item"]["createdAt"]
        self.assertRegex(stamp, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
        self.assertTrue(re.match(r"^.*\+00:00$", stamp) or stamp.endswith("Z"))

    def test_get_when_directory_missing_returns_empty(self):
        self.assertFalse((self.state / "resources").exists())
        status, payload = self.call("GET", ["api", "resources", "subagents"])
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])
        self.assertTrue(payload["capability"]["userScopeAvailable"])

    # --- invalid input -----------------------------------------------
    def test_invalid_ids_rejected(self):
        bad = ["../x", "a/b", "", "..", "a\\b", "x" * 65, "bad id", "a.json/../b"]
        for rid in bad:
            with self.subTest(rid=rid):
                status, payload = self.call(
                    "POST", ["api", "resources", "skills"], {"id": rid})
                self.assertEqual(status, 400)
                self.assertIn("error", payload)

    def test_missing_id_rejected(self):
        status, payload = self.call("POST", ["api", "resources", "skills"], {"name": "x"})
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_non_object_body_rejected(self):
        status, payload = self.call("POST", ["api", "resources", "skills"], ["nope"])
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_invalid_id_on_delete(self):
        status, payload = self.call("DELETE", ["api", "resources", "skills", "../x"])
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_unknown_kind_404(self):
        for method, parts in [
            ("GET", ["api", "resources", "widgets"]),
            ("POST", ["api", "resources", "widgets"]),
            ("DELETE", ["api", "resources", "widgets", "one"]),
        ]:
            with self.subTest(method=method):
                status, payload = self.call(method, parts, {"id": "one"})
                self.assertEqual(status, 404)
                self.assertIn("error", payload)

    def test_delete_missing_is_404(self):
        status, payload = self.call("DELETE", ["api", "resources", "plugins", "ghost"])
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    # --- not ours ----------------------------------------------------
    def test_unrelated_paths_return_none(self):
        cases = [
            ("GET", ["api", "settings"]),
            ("GET", ["api", "providers"]),
            ("GET", ["api", "resources"]),
            # PUT *is* ours since Stage 4 (whole-list replace); see PutReplaceTests.
            # A wrong-arity PUT is still not ours.
            ("PUT", ["api", "resources"]),
            ("PUT", ["api", "resources", "skills", "a"]),
            # PATCH *is* ours since Stage 3 (merge semantics); its own tests live
            # in PatchMergeTests below. A wrong-arity PATCH is still not ours.
            ("PATCH", ["api", "resources", "skills"]),
            ("PATCH", ["api", "resources", "skills", "a", "b"]),
            ("GET", ["resources", "skills"]),
            ("GET", []),
        ]
        for method, parts in cases:
            with self.subTest(method=method, parts=parts):
                self.assertIsNone(self.call(method, parts))

    def test_extra_segments_not_handled(self):
        self.assertIsNone(self.call("GET", ["api", "resources", "skills", "a", "b"]))
        self.assertIsNone(self.call("POST", ["api", "resources", "skills", "a"]))


class PutReplaceTests(unittest.TestCase):
    """Stage 4: PUT replaces the whole list for one kind (the UI saves hooks).

    Validation must happen before any write: one bad item leaves the stored
    set untouched rather than half-replaced.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name)
        self.ctx = {"state_dir": self.state}

    def tearDown(self):
        self._tmp.cleanup()

    def call(self, method, parts, data=None):
        return dispatch(method, parts, {}, data if data is not None else {}, self.ctx)

    def test_put_replaces_and_deletes_missing(self):
        self.call("POST", ["api", "resources", "hooks"], {"id": "keep", "name": "K"})
        self.call("POST", ["api", "resources", "hooks"], {"id": "drop", "name": "D"})
        status, payload = self.call("PUT", ["api", "resources", "hooks"],
                                    {"items": [{"id": "keep", "name": "K2"},
                                               {"id": "added", "name": "A"}]})
        self.assertEqual(status, 200)
        self.assertEqual([i["id"] for i in payload["items"]], ["added", "keep"])

        status, after = self.call("GET", ["api", "resources", "hooks"])
        self.assertEqual([i["id"] for i in after["items"]], ["added", "keep"])
        self.assertFalse((self.state / "resources" / "hooks" / "drop.json").exists())

    def test_put_keeps_created_at(self):
        _, created = self.call("POST", ["api", "resources", "hooks"], {"id": "h", "name": "H"})
        self.call("PUT", ["api", "resources", "hooks"], {"items": [{"id": "h", "name": "H2"}]})
        _, after = self.call("GET", ["api", "resources", "hooks"])
        self.assertEqual(after["items"][0]["createdAt"], created["item"]["createdAt"])

    def test_put_bad_item_leaves_state_untouched(self):
        self.call("POST", ["api", "resources", "hooks"], {"id": "existing", "name": "E"})
        # Second item is invalid -> whole request rejected, nothing written/deleted.
        status, _ = self.call("PUT", ["api", "resources", "hooks"],
                              {"items": [{"id": "newone"}, {"id": "../escape"}]})
        self.assertEqual(status, 400)
        _, after = self.call("GET", ["api", "resources", "hooks"])
        self.assertEqual([i["id"] for i in after["items"]], ["existing"])
        self.assertFalse((self.state / "resources" / "hooks" / "newone.json").exists())

    def test_put_rejects_duplicate_ids(self):
        status, _ = self.call("PUT", ["api", "resources", "hooks"],
                              {"items": [{"id": "dup"}, {"id": "dup"}]})
        self.assertEqual(status, 400)

    def test_put_rejects_non_array_items(self):
        status, _ = self.call("PUT", ["api", "resources", "hooks"], {"items": "nope"})
        self.assertEqual(status, 400)

    def test_put_empty_list_clears_kind(self):
        self.call("POST", ["api", "resources", "hooks"], {"id": "gone", "name": "G"})
        status, payload = self.call("PUT", ["api", "resources", "hooks"], {"items": []})
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])
        self.assertFalse((self.state / "resources" / "hooks" / "gone.json").exists())

    def test_put_skips_symlinked_entries_when_deleting(self):
        # A symlink planted in the kind dir must not be followed or removed.
        kind_dir = self.state / "resources" / "hooks"
        kind_dir.mkdir(parents=True)
        outside = Path(self._tmp.name) / "outside.json"
        outside.write_text(json.dumps({"id": "outside"}), encoding="utf-8")
        link = kind_dir / "sneaky.json"
        make_symlink(link, outside)

        status, _ = self.call("PUT", ["api", "resources", "hooks"], {"items": []})
        self.assertEqual(status, 200)
        self.assertTrue(link.is_symlink(), "the symlink itself was removed")
        self.assertTrue(outside.exists(), "the symlink target outside was removed")


class PatchMergeTests(unittest.TestCase):
    """Stage 3: PATCH merges fields instead of replacing the whole item.

    The UI toggles a skill's ``enabled`` switch; a replace-style update would
    silently drop the stored ``body``/``description``.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name)
        self.ctx = {"state_dir": self.state}

    def tearDown(self):
        self._tmp.cleanup()

    def call(self, method, parts, data=None):
        return dispatch(method, parts, {}, data if data is not None else {}, self.ctx)

    def test_patch_preserves_untouched_fields(self):
        self.call("POST", ["api", "resources", "skills"],
                  {"id": "demo", "name": "Demo", "description": "D", "body": "BODY-TEXT"})
        status, payload = self.call("PATCH", ["api", "resources", "skills", "demo"],
                                    {"enabled": False})
        self.assertEqual(status, 200)
        item = payload["item"]
        self.assertIs(item["enabled"], False)
        self.assertEqual(item["name"], "Demo")          # preserved
        self.assertEqual(item["description"], "D")      # preserved
        self.assertEqual(item["body"], "BODY-TEXT")     # the key assertion

    def test_patch_keeps_created_at_and_bumps_updated_at(self):
        _, created = self.call("POST", ["api", "resources", "skills"], {"id": "ts", "name": "T"})
        self.call("PATCH", ["api", "resources", "skills", "ts"], {"enabled": False})
        _, after = self.call("GET", ["api", "resources", "skills"])
        item = after["items"][0]
        self.assertEqual(item["createdAt"], created["item"]["createdAt"])
        self.assertGreaterEqual(item["updatedAt"], created["item"]["updatedAt"])

    def test_patch_missing_resource_is_404(self):
        status, _ = self.call("PATCH", ["api", "resources", "skills", "ghost"], {"enabled": True})
        self.assertEqual(status, 404)

    def test_patch_invalid_id_is_400(self):
        for bad in ("..", ".", "a/b", ""):
            with self.subTest(bad=bad):
                status, _ = self.call("PATCH", ["api", "resources", "skills", bad], {"enabled": True})
                self.assertIn(status, (400, 404))

    def test_patch_rejects_id_mismatch(self):
        self.call("POST", ["api", "resources", "skills"], {"id": "real", "name": "R"})
        status, _ = self.call("PATCH", ["api", "resources", "skills", "real"], {"id": "other"})
        self.assertEqual(status, 400)

    def test_patch_non_object_body_is_400(self):
        self.call("POST", ["api", "resources", "skills"], {"id": "x1", "name": "X"})
        status, _ = dispatch("PATCH", ["api", "resources", "skills", "x1"], {}, [], self.ctx)
        self.assertEqual(status, 400)

    def test_patch_result_is_readable_after_reload(self):
        self.call("POST", ["api", "resources", "skills"], {"id": "persist", "name": "P", "body": "KEEP"})
        self.call("PATCH", ["api", "resources", "skills", "persist"], {"enabled": False})
        on_disk = json.loads((self.state / "resources" / "skills" / "persist.json").read_text())
        self.assertEqual(on_disk["body"], "KEEP")
        self.assertIs(on_disk["enabled"], False)

    # --- path jail ---------------------------------------------------
    def test_writes_stay_inside_kind_directory(self):
        status, _ = self.call("POST", ["api", "resources", "skills"], {"id": "safe"})
        self.assertEqual(status, 200)
        resolved = (self.state / "resources" / "skills" / "safe.json").resolve()
        root = (self.state / "resources" / "skills").resolve()
        self.assertEqual(resolved.parent, root)


if __name__ == "__main__":
    unittest.main()
