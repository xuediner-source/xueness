"""Safe, isolated regressions for importing a user-selected Chrome profile."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.bundled_plugins.browser import plugin, profiles
from xueness.bundled_plugins.files import windows_paths
from tests.secret_permissions import assert_secret_directory_private, assert_secret_file_private


class BrowserProfileImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.state = self.base / "state"
        self.state.mkdir()
        self.chrome = self.base / "chrome-fixture"
        self.chrome.mkdir()
        self.ctx = {
            "state_dir": self.state,
            "running": set(),
            "lock": threading.RLock(),
            "desktop_token": "desktop-test-token",
        }
        self.shutdown = patch.object(plugin, "shutdown")
        self.shutdown_mock = self.shutdown.start()
        self.addCleanup(self.shutdown.stop)
        self.running = patch.object(profiles, "chrome_running", return_value=False)
        self.running_mock = self.running.start()
        self.addCleanup(self.running.stop)
        self.root = patch.object(profiles, "chrome_root", return_value=self.chrome)
        self.root.start()
        self.addCleanup(self.root.stop)

    def seed_chrome(self, *, profiles_to_create=("Default", "Profile 2")):
        names = {}
        for profile_id in profiles_to_create:
            (self.chrome / profile_id).mkdir(parents=True)
            names[profile_id] = {"name": f"Fixture {profile_id}"}
        (self.chrome / "Local State").write_text(
            json.dumps({
                "profile": {"last_used": "Default", "info_cache": names},
                "os_crypt": {"encrypted_key": "synthetic-fixture-key"},
                "account_info": [{"email": "fixture@example.invalid"}],
            }),
            encoding="utf-8",
        )

    def source_snapshot(self):
        """Capture only synthetic fixture files, never a host Chrome directory."""
        return {
            path.relative_to(self.chrome).as_posix(): path.read_bytes()
            for path in self.chrome.rglob("*")
            if path.is_file()
        }

    def source_metadata(self):
        """Return fixture-only stat metadata for diagnosing source_busy results."""
        rows = {}
        for path in self.chrome.rglob("*"):
            info = path.lstat()
            rows[path.relative_to(self.chrome).as_posix()] = (
                info.st_mode,
                info.st_size,
                getattr(info, "st_dev", 0),
                getattr(info, "st_ino", 0),
                getattr(info, "st_mtime_ns", int(info.st_mtime * 1_000_000_000)),
                getattr(info, "st_ctime_ns", int(info.st_ctime * 1_000_000_000)),
            )
        return rows

    def call(self, method="GET", payload=None):
        return plugin_runtime.dispatch_http(
            method,
            ["api", "browser", "profiles"],
            {},
            payload or {},
            self.ctx,
        )

    def call_with_source_diagnostics(self, payload):
        """Capture fixture-only read/stat diagnostics if a guarded copy fails."""
        original_read = profiles._read_file
        original_open = windows_paths.open_regular_file
        read_failures = []
        opened_files = []

        def observe_open(root, relative):
            try:
                result = original_open(root, relative)
            except Exception as error:
                opened_files.append({"path": str(relative), "error": type(error).__name__})
                raise
            signature = profiles._signature(result[1]) if result is not None else None
            opened_files.append({"path": str(relative), "signature": signature})
            return result

        def observe_read(root, path, maximum, expected_signature=None):
            try:
                return original_read(root, path, maximum, expected_signature=expected_signature)
            except Exception as error:
                relative = path.relative_to(root).as_posix()
                try:
                    current = profiles._source_info(root, relative)
                    current_signature = profiles._signature(current) if current is not None else None
                except Exception as stat_error:
                    current_signature = {"error": type(stat_error).__name__}
                read_failures.append({
                    "path": relative,
                    "error": str(error) if isinstance(error, ValueError) else type(error).__name__,
                    "expected_signature": expected_signature,
                    "current_signature": current_signature,
                    "opened_files": [item for item in opened_files if item["path"] == relative],
                })
                raise

        with patch.object(profiles, "_read_file", side_effect=observe_read), \
                patch.object(windows_paths, "open_regular_file", side_effect=observe_open):
            status, result = self.call("POST", payload)
        return status, result, {"read_failures": read_failures, "opened_files": opened_files}

    def enable_browser(self):
        plugin_runtime.set_enabled(self.state, "browser", True)

    def test_lists_only_fixture_profiles_and_imports_the_selected_profile(self):
        self.seed_chrome()
        (self.chrome / "Default" / "Bookmarks").write_text("default fixture", encoding="utf-8")
        (self.chrome / "Profile 2" / "Bookmarks").write_text("selected fixture", encoding="utf-8")
        before = self.source_snapshot()
        old_bookmark = self.state / "browser-profile" / "Default" / "Bookmarks"
        old_bookmark.parent.mkdir(parents=True)
        old_bookmark.write_text("old managed fixture", encoding="utf-8")
        self.enable_browser()

        self.assertEqual(
            self.call(),
            (200, {"profiles": [
                {"id": "Default", "name": "Fixture Default"},
                {"id": "Profile 2", "name": "Fixture Profile 2"},
            ]}),
        )
        status, result = self.call("POST", {"profileId": "Profile 2", "confirmed": True})

        self.assertEqual(status, 200, result)
        self.assertTrue(result["profilePresent"])
        imported = self.state / "browser-profile" / "Default" / "Bookmarks"
        self.assertEqual(imported.read_text(encoding="utf-8"), "selected fixture")
        self.assertFalse(any(self.state.glob("browser-import-old-*")))
        self.assertEqual(self.source_snapshot(), before)
        self.assertTrue(self.shutdown_mock.called)

    def test_import_protects_profile_directory_and_personal_files(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Default" / "Cookies").write_bytes(b"synthetic cookie bytes")
        local = self.chrome / "Default" / "Local Storage"
        local.mkdir()
        (local / "fixture.db").write_bytes(b"synthetic storage bytes")
        before = self.source_snapshot()
        self.enable_browser()
        protected_empty_stage = []
        original_protect = profiles._protect_private_directory

        def protect_before_personal_writes(path):
            if path.name.startswith("browser-import-"):
                protected_empty_stage.append(not any(path.iterdir()))
            return original_protect(path)

        with patch.object(profiles, "_protect_private_directory", side_effect=protect_before_personal_writes):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual(status, 200, result)
        destination = self.state / "browser-profile"
        self.assertEqual(protected_empty_stage, [True])
        assert_secret_directory_private(self, destination)
        for relative in ("Local State", "Default/Cookies", "Default/Local Storage/fixture.db"):
            assert_secret_file_private(self, destination / relative)
        self.assertEqual(self.source_snapshot(), before)

    def test_directory_protection_failure_aborts_before_copy(self):
        self.seed_chrome(profiles_to_create=("Default",))
        destination = self.state / "browser-profile" / "Default" / "Bookmarks"
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"old managed fixture")
        self.enable_browser()
        with patch.object(profiles, "_protect_private_directory", side_effect=OSError("ACL denied")), \
                patch.object(profiles, "_snapshot_sources") as snapshot:
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual((status, result), (409, {"error": "source_busy"}))
        snapshot.assert_not_called()
        self.assertEqual(destination.read_bytes(), b"old managed fixture")
        self.assertFalse(any(self.state.glob("browser-import-*")))

    def test_file_protection_failure_closes_empty_stage_file_and_keeps_old_profile(self):
        self.seed_chrome(profiles_to_create=("Default",))
        destination = self.state / "browser-profile" / "Default" / "Bookmarks"
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"old managed fixture")
        self.enable_browser()
        opened = []

        def refuse_file(fd):
            opened.append(fd)
            self.assertEqual(os.fstat(fd).st_size, 0)
            raise OSError("ACL denied")

        with patch.object(profiles, "_protect_private_file", side_effect=refuse_file):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual((status, result), (409, {"error": "source_busy"}))
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])
        self.assertEqual(destination.read_bytes(), b"old managed fixture")
        self.assertFalse(any(self.state.glob("browser-import-*")))

    def test_worker_refuses_to_start_before_profile_permissions_are_private(self):
        with patch.object(plugin, "_protect_private_directory", side_effect=OSError("ACL denied")), \
                patch("xueness.process_runtime.spawn_external") as spawn:
            with self.assertRaises(OSError):
                plugin._BrowserBroker(self.state, self.base)
        spawn.assert_not_called()

    def test_confirmation_is_required_before_any_import_or_shutdown(self):
        self.seed_chrome()
        self.enable_browser()

        for payload in (
            {"profileId": "Default"},
            {"profileId": "Default", "confirmed": False},
            {"profileId": "Default", "confirmed": True, "extra": "ignored"},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(
                    self.call("POST", payload),
                    (400, {"error": "confirmation_required"}),
                )
        self.shutdown_mock.assert_not_called()
        self.assertFalse((self.state / "browser-profile").exists())

    def test_invalid_profile_selection_is_rejected_without_copying(self):
        self.seed_chrome()
        self.enable_browser()

        status, result = self.call("POST", {"profileId": "Profile 999", "confirmed": True})

        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_not_found"})
        self.assertFalse((self.state / "browser-profile").exists())

    def test_disabled_browser_never_enumerates_chrome_profiles(self):
        self.seed_chrome()
        with patch.object(profiles, "chrome_profiles", side_effect=AssertionError("must stay gated")):
            status, result = self.call()
        self.assertEqual(status, 403)
        self.assertEqual(result["plugin"], "browser")

    def test_import_is_limited_to_desktop_authenticated_hosts(self):
        self.seed_chrome()
        self.enable_browser()
        self.ctx["desktop_token"] = None
        with patch.object(profiles, "chrome_profiles", side_effect=AssertionError("remote host must stay gated")):
            self.assertEqual(self.call()[0], 403)

        self.ctx["desktop_token"] = "desktop-test-token"
        plugin_runtime.set_enabled(self.state, "desktop", False)
        with patch.object(profiles, "chrome_profiles", side_effect=AssertionError("disabled desktop must stay gated")):
            self.assertEqual(self.call()[0], 403)

    def test_busy_tasks_or_open_chrome_block_import(self):
        self.seed_chrome()
        self.enable_browser()
        self.ctx["running"].add("fixture-task")
        self.assertEqual(
            self.call("POST", {"profileId": "Default", "confirmed": True}),
            (409, {"error": "tasks_running"}),
        )
        self.ctx["running"].clear()
        self.shutdown_mock.reset_mock()

        self.running_mock.return_value = True
        status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual(status, 409)
        self.assertEqual(result, {"error": "close_chrome"})
        self.shutdown_mock.assert_called_once_with(self.state)
        self.assertFalse((self.state / "browser-profile").exists())

    def test_source_file_and_total_file_limits_are_enforced(self):
        self.seed_chrome(profiles_to_create=("Default",))
        # Keep Local State out so this isolates the per-file and file-count caps.
        (self.chrome / "Local State").unlink()
        source = self.chrome / "Default"
        (source / "Bookmarks").write_bytes(b"x" * 9)
        self.enable_browser()
        with patch.object(profiles, "MAX_COPY_BYTES", 8):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_too_large"})
        self.assertFalse((self.state / "browser-profile").exists())

        (source / "Bookmarks").write_bytes(b"one")
        (source / "History").write_bytes(b"two")
        with patch.object(profiles, "MAX_COPY_FILES", 2):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_too_large"})
        self.assertFalse((self.state / "browser-profile").exists())

    def test_directory_traversal_is_included_in_entry_limit(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Local State").unlink()
        (self.chrome / "Default" / "Local Storage" / "site-a" / "nested" / "deeper").mkdir(parents=True)
        self.enable_browser()

        with patch.object(profiles, "MAX_COPY_FILES", 3):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_too_large"})
        self.assertFalse((self.state / "browser-profile").exists())

    def test_local_state_counts_toward_the_total_byte_limit(self):
        self.seed_chrome(profiles_to_create=("Default",))
        local_state_size = (self.chrome / "Local State").stat().st_size
        self.enable_browser()

        with patch.object(profiles, "MAX_COPY_BYTES", local_state_size - 1):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_too_large"})
        self.assertFalse((self.state / "browser-profile").exists())

    def test_import_copies_allowed_login_state_to_a_separate_profile_and_preserves_source(self):
        self.seed_chrome(profiles_to_create=("Default",))
        source = self.chrome / "Default"
        fixtures = {
            "Bookmarks": b"bookmarks fixture",
            "History": b"history fixture",
            "Cookies": b"cookie fixture",
            "Local Storage/leveldb/LOG": b"storage fixture",
            "IndexedDB/site/000001.log": b"indexeddb fixture",
            "Login Data": b"password fixture must stay source only",
            "Web Data": b"autofill fixture must stay source only",
            "Cache/cache.data": b"cache fixture must stay source only",
        }
        for name, content in fixtures.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        before = self.source_snapshot()
        self.enable_browser()

        status, result, source_diagnostics = self.call_with_source_diagnostics(
            {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 200, source_diagnostics)
        destination = self.state / "browser-profile"
        self.assertEqual(destination.parent, self.state)
        self.assertTrue(destination.is_dir())
        for name in (
            "Bookmarks", "History", "Cookies", "Local Storage/leveldb/LOG",
            "IndexedDB/site/000001.log",
        ):
            self.assertEqual((destination / "Default" / name).read_bytes(), fixtures[name])
        for name in ("Login Data", "Web Data", "Cache/cache.data"):
            self.assertFalse((destination / "Default" / name).exists())
        imported_local_state = json.loads((destination / "Local State").read_text(encoding="utf-8"))
        self.assertEqual(set(imported_local_state), {"profile", "os_crypt"})
        self.assertNotIn("account_info", (destination / "Local State").read_text(encoding="utf-8"))
        self.assertEqual(self.source_snapshot(), before)

    def test_copy_failure_preserves_the_existing_managed_profile(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Local State").unlink()
        (self.chrome / "Default" / "Bookmarks").write_bytes(b"x" * 9)
        destination = self.state / "browser-profile"
        existing = destination / "Default"
        existing.mkdir(parents=True)
        (existing / "Bookmarks").write_bytes(b"old managed profile")
        self.enable_browser()

        with patch.object(profiles, "MAX_COPY_BYTES", 8):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "profile_too_large"})
        self.assertEqual((destination / "Default" / "Bookmarks").read_bytes(), b"old managed profile")
        self.assertFalse(any(self.state.glob("browser-import-*")))

    def test_chrome_starting_during_copy_blocks_swap_and_preserves_old_profile(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Local State").unlink()
        (self.chrome / "Default" / "Bookmarks").write_bytes(b"new source fixture")
        destination = self.state / "browser-profile"
        (destination / "Default").mkdir(parents=True)
        (destination / "Default" / "Bookmarks").write_bytes(b"old managed profile")
        self.enable_browser()
        self.running_mock.side_effect = [False, True]

        status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 409)
        self.assertEqual(result, {"error": "close_chrome"})
        self.assertEqual(self.running_mock.call_count, 2)
        self.assertEqual((destination / "Default" / "Bookmarks").read_bytes(), b"old managed profile")
        self.assertFalse(any(self.state.glob("browser-import-*")))

    def test_source_change_during_copy_blocks_swap_and_preserves_old_profile(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Local State").unlink()
        source = self.chrome / "Default" / "Bookmarks"
        source.write_bytes(b"original source fixture")
        destination = self.state / "browser-profile"
        (destination / "Default").mkdir(parents=True)
        (destination / "Default" / "Bookmarks").write_bytes(b"old managed profile")
        self.enable_browser()
        read_file = profiles._read_file

        def mutate_source_after_read(root, path, maximum, expected_signature=None):
            data = read_file(root, path, maximum, expected_signature=expected_signature)
            if path == source:
                path.write_bytes(b"changed source fixture has a different size")
            return data

        with patch.object(profiles, "_read_file", side_effect=mutate_source_after_read):
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 409)
        self.assertEqual(result, {"error": "source_busy"})
        self.assertEqual((destination / "Default" / "Bookmarks").read_bytes(), b"old managed profile")
        self.assertFalse(any(self.state.glob("browser-import-*")))

    @unittest.skipUnless(profiles.os.name == "nt", "Windows lstat/fstat ctime semantics")
    def test_windows_open_handle_ctime_difference_is_allowed_but_lstat_change_is_not(self):
        self.seed_chrome(profiles_to_create=("Default",))
        source = self.chrome / "Default" / "Bookmarks"
        source.write_bytes(b"synthetic Windows profile data")
        parts = ("Default", "Bookmarks")
        expected_info = profiles._source_info(self.chrome, parts)
        expected = profiles._signature(expected_info)
        real_open = windows_paths.open_regular_file
        opened_signatures = []

        class CtimeAdjustedInfo:
            def __init__(self, base, ctime_ns):
                self._base = base
                self.st_ctime_ns = ctime_ns
                self.st_ctime = ctime_ns / 1_000_000_000

            def __getattr__(self, name):
                return getattr(self._base, name)

        def open_with_handle_ctime(root, relative):
            fd, info = real_open(root, relative)
            adjusted = CtimeAdjustedInfo(info, expected[-1] + 5_000_000_000)
            opened_signatures.append(profiles._signature(adjusted))
            return fd, adjusted

        with patch.object(windows_paths, "open_regular_file", side_effect=open_with_handle_ctime):
            self.assertEqual(
                profiles._read_file(self.chrome, source, 1024, expected_signature=expected),
                b"synthetic Windows profile data",
            )

        self.assertEqual(opened_signatures[0][:5], expected[:5])
        self.assertNotEqual(opened_signatures[0][-1], expected[-1])

        # The opened handle may report a different ctime API value, but the
        # full lstat signature is still compared before and after the read.
        changed_lstat = CtimeAdjustedInfo(expected_info, expected[-1] + 1)
        with patch.object(profiles, "_source_info", side_effect=[expected_info, changed_lstat]), \
                patch.object(windows_paths, "open_regular_file", side_effect=open_with_handle_ctime):
            with self.assertRaisesRegex(profiles.ProfileError, "source_busy"):
                profiles._read_file(self.chrome, source, 1024, expected_signature=expected)

    def test_backup_cleanup_failure_reports_success_and_leaves_recoverable_backup(self):
        self.seed_chrome(profiles_to_create=("Default",))
        (self.chrome / "Default" / "Bookmarks").write_bytes(b"new managed fixture")
        destination = self.state / "browser-profile"
        (destination / "Default").mkdir(parents=True)
        (destination / "Default" / "Bookmarks").write_bytes(b"old managed profile")
        self.enable_browser()
        source_before = self.source_metadata()
        snapshot = profiles._snapshot_sources
        inventories = []

        def capture_inventory(root, profile_id):
            try:
                current = snapshot(root, profile_id)
            except profiles.ProfileError as error:
                inventories.append({
                    "error": str(error),
                    "sourceMetadata": self.source_metadata(),
                })
                raise
            inventories.append(current)
            return current

        with patch.object(profiles, "_snapshot_sources", side_effect=capture_inventory), \
                patch.object(profiles, "_remove_stage", side_effect=OSError("fixture cleanup failure")):
            status, result, source_diagnostics = self.call_with_source_diagnostics(
                {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 200, {
            "result": result,
            "sourceBefore": source_before,
            "sourceAfter": self.source_metadata(),
            "inventories": inventories,
            "sourceDiagnostics": source_diagnostics,
        })
        self.assertTrue(result["ok"])
        self.assertTrue(result["cleanupPending"])
        self.assertEqual((destination / "Default" / "Bookmarks").read_bytes(), b"new managed fixture")
        backups = list(self.state.glob("browser-import-old-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "Default" / "Bookmarks").read_bytes(), b"old managed profile")

    def test_source_symlink_is_rejected_and_cannot_replace_existing_profile(self):
        self.seed_chrome(profiles_to_create=("Default",))
        outside = self.base / "outside-fixture"
        outside.mkdir()
        secret_fixture = outside / "Bookmarks"
        secret_fixture.write_bytes(b"outside fixture")
        source = self.chrome / "Default" / "Bookmarks"
        source_info_mock = None
        try:
            source.symlink_to(secret_fixture)
        except OSError:
            # Some Windows accounts cannot create symlinks. Exercise the same
            # fail-closed branch with the source-path guard mocked.
            source.write_bytes(b"synthetic linked source")
            real_source_info = profiles._source_info

            def reject_fixture_link(root, relative):
                if tuple(relative) == ("Default", "Bookmarks"):
                    raise profiles.ProfileError("source_invalid")
                return real_source_info(root, relative)

            source_info_mock = patch.object(profiles, "_source_info", side_effect=reject_fixture_link)
        destination = self.state / "browser-profile"
        (destination / "Default").mkdir(parents=True)
        (destination / "Default" / "Bookmarks").write_bytes(b"old managed profile")
        self.enable_browser()

        if source_info_mock:
            with source_info_mock:
                status, result = self.call("POST", {"profileId": "Default", "confirmed": True})
        else:
            status, result = self.call("POST", {"profileId": "Default", "confirmed": True})

        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "source_invalid"})
        self.assertEqual((destination / "Default" / "Bookmarks").read_bytes(), b"old managed profile")
        self.assertEqual(secret_fixture.read_bytes(), b"outside fixture")


if __name__ == "__main__":
    unittest.main()
