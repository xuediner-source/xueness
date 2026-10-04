"""Plugin SDK tests: manifest validation, capability gating, install rollback.

The properties worth pinning here are the ones whose failure would be a security
bug rather than a cosmetic one:

* a manifest that names executable code is refused, and refusing it also blocks
  the builtin it claims (fail-closed, not "silently load around the bad file")
* a capability is only granted when the caller names it explicitly
* install validates the whole batch before writing, and a mid-batch failure
  leaves the previous bytes exactly as they were
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness import plugin_sdk as sdk


def _manifest(**overrides):
    base = {"id": "demo", "version": "1.0.0", "apiVersion": sdk.API_VERSION,
            "enabled": True, "builtin": "mcp"}
    base.update(overrides)
    return base


class ValidateManifestTests(unittest.TestCase):
    def test_accepts_a_minimal_valid_manifest(self):
        manifest, errors = sdk.validate_manifest(_manifest())
        self.assertEqual(errors, [])
        self.assertEqual(manifest["id"], "demo")
        self.assertEqual(manifest["builtin"], "mcp")
        self.assertEqual(manifest["capabilities"], [])
        self.assertTrue(manifest["enabled"])

    def test_rejects_non_object(self):
        for bad in [None, "x", 5, []]:
            with self.subTest(bad=bad):
                manifest, errors = sdk.validate_manifest(bad)
                self.assertIsNone(manifest)
                self.assertTrue(errors)

    def test_executable_fields_are_always_refused(self):
        for field in ("entrypoint", "command"):
            with self.subTest(field=field):
                manifest, errors = sdk.validate_manifest(_manifest(**{field: "./run.sh"}))
                self.assertIsNone(manifest)
                self.assertIn("external plugin code requires a separate audit", errors)

    def test_falsy_executable_field_is_ignored(self):
        # An empty string is not code; only a truthy value is an escape attempt.
        manifest, errors = sdk.validate_manifest(_manifest(entrypoint=""))
        self.assertEqual(errors, [])
        self.assertIsNotNone(manifest)

    def test_version_must_be_semver_like(self):
        for bad in ["1", "1.0", "v1.0.0", "1.0.0-beta", "", 1.0, None]:
            with self.subTest(version=bad):
                manifest, errors = sdk.validate_manifest(_manifest(version=bad))
                self.assertIsNone(manifest)
                self.assertIn("version must be MAJOR.MINOR.PATCH", errors)

    def test_api_version_must_match_exactly(self):
        manifest, errors = sdk.validate_manifest(_manifest(apiVersion=sdk.API_VERSION + 1))
        self.assertIsNone(manifest)
        self.assertIn("incompatible apiVersion", errors)

    def test_api_version_boolean_is_not_an_int(self):
        # bool is an int subclass in Python; True must not pass as apiVersion 1.
        manifest, errors = sdk.validate_manifest(_manifest(apiVersion=True))
        self.assertIsNone(manifest)
        self.assertIn("apiVersion must be an integer", errors)

    def test_builtin_must_name_a_known_capability(self):
        for bad in ["nope", "", 5]:
            with self.subTest(builtin=bad):
                manifest, errors = sdk.validate_manifest(_manifest(builtin=bad))
                self.assertIsNone(manifest)
                self.assertIn("builtin must name a known capability", errors)

    def test_id_must_pass_the_resource_whitelist(self):
        for bad in ["../x", "a/b", ".", "..", "", None, "x" * 65]:
            with self.subTest(rid=bad):
                manifest, errors = sdk.validate_manifest(_manifest(id=bad))
                self.assertIsNone(manifest)
                self.assertIn("invalid id", errors)

    def test_unknown_capability_is_refused(self):
        manifest, errors = sdk.validate_manifest(_manifest(capabilities=["shell"]))
        self.assertIsNone(manifest)
        self.assertTrue(any("unknown capability" in e for e in errors))

    def test_capabilities_must_be_an_array_and_are_deduplicated(self):
        manifest, errors = sdk.validate_manifest(_manifest(capabilities="command"))
        self.assertIsNone(manifest)
        self.assertIn("capabilities must be an array", errors)

        manifest, errors = sdk.validate_manifest(
            _manifest(capabilities=["command", "command", "network"]))
        self.assertEqual(errors, [])
        self.assertEqual(manifest["capabilities"], ["command", "network"])

    def test_enabled_is_only_true_for_a_literal_true(self):
        for value, expected in [(True, True), ("true", False), (1, False),
                                (False, False), (None, False), ("yes", False)]:
            with self.subTest(value=value):
                manifest, errors = sdk.validate_manifest(_manifest(enabled=value))
                self.assertEqual(errors, [])
                self.assertIs(manifest["enabled"], expected)

    def test_validation_never_raises(self):
        for bad in [object(), {"id": []}, {"capabilities": [{}]}]:
            with self.subTest(bad=bad):
                sdk.validate_manifest(bad)  # must not raise


class LoadManifestsTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.state = Path(holder.name)
        self.dir = self.state / "resources" / "plugins"

    def _write(self, name, payload):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_missing_directory_yields_nothing(self):
        self.assertEqual(sdk.load_manifests(self.state), [])

    def test_symlinked_directory_is_refused(self):
        real = self.state / "elsewhere"
        real.mkdir(parents=True)
        (real / "a.json").write_text(json.dumps(_manifest(id="a")), encoding="utf-8")
        self.dir.parent.mkdir(parents=True, exist_ok=True)
        make_directory_boundary_link(self.dir, real)
        self.assertEqual(sdk.load_manifests(self.state), [])

    def test_symlinked_entry_is_skipped(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        outside = self.state / "outside.json"
        outside.write_text(json.dumps(_manifest(id="evil")), encoding="utf-8")
        make_symlink(self.dir / "evil.json", outside)
        self.assertEqual(sdk.load_manifests(self.state), [])

    def test_broken_json_and_non_objects_are_skipped(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "broken.json").write_text("{not json", encoding="utf-8")
        (self.dir / "list.json").write_text("[1,2]", encoding="utf-8")
        self._write("good.json", _manifest(id="good"))
        self.assertEqual([m["id"] for m in sdk.load_manifests(self.state)], ["good"])

    def test_invalid_manifests_are_not_returned(self):
        self._write("bad.json", _manifest(id="bad", version="x"))
        self._write("good.json", _manifest(id="good"))
        self.assertEqual([m["id"] for m in sdk.load_manifests(self.state)], ["good"])

    def test_results_are_sorted_by_id(self):
        for rid in ["zeta", "alpha", "mid"]:
            self._write(rid + ".json", _manifest(id=rid))
        self.assertEqual([m["id"] for m in sdk.load_manifests(self.state)],
                         ["alpha", "mid", "zeta"])


class PlanTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.state = Path(holder.name)
        self.dir = self.state / "resources" / "plugins"
        self.dir.mkdir(parents=True)

    def _write(self, name, payload):
        (self.dir / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_no_manifest_means_the_caller_list_is_the_authority(self):
        plan = sdk.plan(self.state, ["mcp", "skills"])
        self.assertEqual(plan.load, ["mcp", "skills"])
        self.assertEqual(plan.refused, [])
        self.assertEqual(plan.manifests, {})

    def test_unknown_name_is_refused(self):
        plan = sdk.plan(self.state, ["ghost"])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused, [{"name": "ghost", "reason": "unknown capability"}])

    def test_duplicates_load_once_and_keep_first_order(self):
        plan = sdk.plan(self.state, ["hooks", "mcp", "hooks"])
        self.assertEqual(plan.load, ["hooks", "mcp"])

    def test_empty_and_non_string_names_are_ignored(self):
        plan = sdk.plan(self.state, ["", None, 5, "mcp"])
        self.assertEqual(plan.load, ["mcp"])
        self.assertEqual(plan.refused, [])

    def test_missing_grant_refuses_the_capability(self):
        self._write("a.json", _manifest(id="a", builtin="mcp", capabilities=["command"]))
        plan = sdk.plan(self.state, ["mcp"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused,
                         [{"name": "mcp", "reason": "missing grant: command"}])

    def test_granted_capability_passes(self):
        self._write("a.json", _manifest(id="a", builtin="mcp", capabilities=["command"]))
        plan = sdk.plan(self.state, ["mcp"], grants=["command"])
        self.assertEqual(plan.load, ["mcp"])
        self.assertEqual(plan.manifests["mcp"]["id"], "a")

    def test_first_missing_grant_is_reported_in_capability_order(self):
        self._write("a.json", _manifest(
            id="a", builtin="mcp", capabilities=["network", "command"]))
        # CAPABILITIES order is command, network, filesystem-write.
        plan = sdk.plan(self.state, ["mcp"], grants=[])
        self.assertEqual(plan.refused[0]["reason"], "missing grant: command")

    def test_disabled_manifest_blocks_its_builtin(self):
        self._write("a.json", _manifest(id="a", builtin="hooks", enabled=False))
        plan = sdk.plan(self.state, ["hooks"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused, [{"name": "hooks", "reason": "disabled"}])

    def test_absent_enabled_blocks_its_builtin(self):
        doc = _manifest(id="a", builtin="hooks")
        del doc["enabled"]
        self._write("a.json", doc)
        plan = sdk.plan(self.state, ["hooks"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused[0]["reason"], "disabled")

    def test_entrypoint_manifest_blocks_its_builtin(self):
        """The security property: a manifest naming code must not silently let
        the plain builtin load in its place."""
        self._write("a.json", _manifest(id="a", builtin="subagents",
                                        entrypoint="./run.sh"))
        plan = sdk.plan(self.state, ["subagents"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused,
                         [{"name": "subagents",
                           "reason": "external plugin code requires a separate audit"}])

    def test_incompatible_api_version_blocks_its_builtin(self):
        self._write("a.json", _manifest(id="a", builtin="skills",
                                        apiVersion=sdk.API_VERSION + 1))
        plan = sdk.plan(self.state, ["skills"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused[0]["reason"], "incompatible apiVersion")

    def test_structurally_invalid_manifest_still_blocks_its_builtin(self):
        self._write("a.json", _manifest(id="a", builtin="skills", version="nope"))
        plan = sdk.plan(self.state, ["skills"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused[0]["reason"], "version must be MAJOR.MINOR.PATCH")

    def test_manifest_id_is_not_a_requestable_alias(self):
        self._write("a.json", _manifest(id="mcp-ops", builtin="mcp"))
        plan = sdk.plan(self.state, ["mcp-ops"], grants=[])
        self.assertEqual(plan.load, [])
        self.assertEqual(plan.refused,
                         [{"name": "mcp-ops", "reason": "unknown capability"}])

    def test_conflicting_manifests_are_reported(self):
        self._write("a.json", _manifest(id="aaa", builtin="mcp"))
        self._write("b.json", _manifest(id="bbb", builtin="mcp"))
        plan = sdk.plan(self.state, ["mcp"], grants=[])
        self.assertEqual(plan.load, ["mcp"])
        self.assertEqual(plan.manifests["mcp"]["id"], "aaa")
        self.assertIn({"name": "bbb", "reason": "conflicting manifest: aaa"}, plan.refused)

    def test_manifest_that_names_no_known_builtin_is_ignored(self):
        # validate_manifest refuses these, so they cannot govern anything.
        self._write("a.json", {"id": "a", "version": "1.0.0", "apiVersion": 1,
                               "enabled": True, "builtin": "nope"})
        plan = sdk.plan(self.state, ["mcp"], grants=[])
        self.assertEqual(plan.load, ["mcp"])


class InstallTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.state = Path(holder.name)
        self.dir = self.state / "resources" / "plugins"

    def test_install_writes_valid_manifests(self):
        result = sdk.install_all(self.state, [_manifest(id="a"), _manifest(id="b")])
        self.assertTrue(result["ok"])
        self.assertEqual(result["written"], ["a", "b"])
        self.assertEqual(sorted(p.stem for p in self.dir.glob("*.json")), ["a", "b"])

    def test_install_with_any_invalid_item_writes_nothing(self):
        result = sdk.install_all(self.state, [_manifest(id="ok"), _manifest(id="bad", version="x")])
        self.assertFalse(result["ok"])
        self.assertEqual(result["written"], [])
        self.assertFalse(self.dir.exists() and any(self.dir.glob("*.json")))

    def test_install_rejects_duplicate_ids(self):
        result = sdk.install_all(self.state, [_manifest(id="a"), _manifest(id="a")])
        self.assertFalse(result["ok"])

    def test_install_rejects_executable_manifests(self):
        result = sdk.install_all(self.state, [_manifest(id="a", command="./x.sh")])
        self.assertFalse(result["ok"])

    def test_install_refuses_symlinked_directory(self):
        self.dir.parent.mkdir(parents=True, exist_ok=True)
        outside = self.state / "elsewhere"
        outside.mkdir()
        make_directory_boundary_link(self.dir, outside)
        result = sdk.install_all(self.state, [_manifest(id="a")])
        self.assertFalse(result["ok"])

    def test_mid_install_failure_rolls_back_new_files(self):
        """A write that fails part way must not leave a partial set behind."""
        real_write = sdk._atomic_write_json
        calls = {"n": 0}

        def flaky(path, item):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("disk full")
            return real_write(path, item)

        with patch.object(sdk, "_atomic_write_json", flaky):
            result = sdk.install_all(self.state, [_manifest(id="a"), _manifest(id="b")])
        self.assertFalse(result["ok"])
        self.assertEqual(result["written"], [])
        self.assertFalse((self.dir / "a.json").exists(), "the new file must be rolled back")

    def test_mid_install_failure_restores_previous_bytes(self):
        sdk.install_all(self.state, [_manifest(id="a", version="1.0.0")])
        before = (self.dir / "a.json").read_bytes()

        real_write = sdk._atomic_write_json
        calls = {"n": 0}

        def flaky(path, item):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("disk full")
            return real_write(path, item)

        with patch.object(sdk, "_atomic_write_json", flaky):
            result = sdk.install_all(self.state, [
                _manifest(id="a", version="2.0.0"),
                _manifest(id="b"),
            ])
        self.assertFalse(result["ok"])
        self.assertEqual((self.dir / "a.json").read_bytes(), before,
                         "an overwritten file must be restored to its prior bytes")

    def test_install_items_must_be_an_array(self):
        result = sdk.install_all(self.state, {"id": "a"})
        self.assertFalse(result["ok"])


class UninstallTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.state = Path(holder.name)
        self.dir = self.state / "resources" / "plugins"

    def test_uninstall_removes_and_returns_the_manifest(self):
        sdk.install_all(self.state, [_manifest(id="a")])
        result = sdk.uninstall(self.state, "a")
        self.assertTrue(result["ok"])
        self.assertTrue(result["removed"])
        self.assertEqual(result["manifest"]["id"], "a")
        self.assertFalse((self.dir / "a.json").exists())

    def test_uninstall_missing_is_ok_and_idempotent(self):
        result = sdk.uninstall(self.state, "ghost")
        self.assertTrue(result["ok"])
        self.assertFalse(result["removed"])
        self.assertIsNone(result["manifest"])

    def test_uninstall_rejects_an_invalid_id(self):
        result = sdk.uninstall(self.state, "../etc/passwd")
        self.assertFalse(result["ok"])

    def test_uninstall_result_can_roll_back(self):
        sdk.install_all(self.state, [_manifest(id="a")])
        manifest = sdk.uninstall(self.state, "a")["manifest"]
        sdk.install_all(self.state, [manifest])
        self.assertTrue((self.dir / "a.json").exists())


if __name__ == "__main__":
    unittest.main()
