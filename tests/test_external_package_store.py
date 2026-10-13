"""Source packages remain inert and their exact reviewed bytes govern activation."""
import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from xueness.bundled_plugins.extensions import package_store as packages


def archive(version="1.0.0", *, entries=None, capabilities=None, transport="mcp-stdio", package_id="fixture-tool"):
    manifest = {"apiVersion": 1, "id": package_id, "version": version,
                "transport": transport, "runtime": "python", "entrypoint": "src/server.py",
                "capabilities": capabilities or ["command"]}
    contents = {packages.MANIFEST_NAME: json.dumps(manifest).encode(),
                "src/server.py": b"raise RuntimeError('package must never execute on install')\n"}
    if entries is not None:
        contents.update(entries)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as stream:
        for name, data in contents.items():
            stream.writestr(name, data)
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


class ExternalPackageStoreTests(unittest.TestCase):
    def test_exact_pin_inert_install_and_permission_activation(self):
        with tempfile.TemporaryDirectory() as state:
            data, digest = archive(capabilities=["command", "network"], transport="acp-stdio")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                packages.install(state, data, expected_sha256="0" * 64)
            self.assertEqual(packages.list_packages(state), [])
            installed = packages.install(state, data, expected_sha256=digest)
            self.assertFalse(installed["enabled"])
            self.assertEqual(installed["receipt"]["provenance"], {"kind": "sha256-pin"})
            self.assertEqual(len(installed["receipt"]["files"]), 2)
            with self.assertRaisesRegex(ValueError, "capabilities"):
                packages.set_enabled(state, "fixture-tool", True, expected_sha256=digest, grants=["command"])
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                packages.set_enabled(state, "fixture-tool", True, expected_sha256="0" * 64,
                                     grants=["command", "network"])
            enabled = packages.set_enabled(state, "fixture-tool", True, expected_sha256=digest,
                                           grants=["network", "command"])
            self.assertTrue(enabled["enabled"])
            self.assertEqual(packages.resolved_package(state, "fixture-tool")["entrypoint"], installed["entrypoint"])
            self.assertTrue(packages.list_packages(state)[0]["enabled"])

    def test_upgrade_rollback_and_uninstall_keep_receipts_and_clear_activation(self):
        with tempfile.TemporaryDirectory() as state:
            first, first_hash = archive()
            second, second_hash = archive("2.0.0", capabilities=["command", "network"])
            initial = packages.install(state, first, expected_sha256=first_hash)
            packages.set_enabled(state, "fixture-tool", True, expected_sha256=first_hash, grants=["command"])
            upgraded = packages.upgrade(state, second, expected_sha256=second_hash, package_id="fixture-tool")
            self.assertFalse(upgraded["enabled"])
            self.assertEqual(upgraded["history"], [{"version": "1.0.0", "archiveSha256": first_hash}])
            packages.set_enabled(state, "fixture-tool", True, expected_sha256=second_hash,
                                 grants=["command", "network"])
            # Review a historical version using its own capabilities while active grants differ.
            historical = packages.review(state, "fixture-tool", archive_sha256=first_hash)
            self.assertEqual(historical["manifest"]["capabilities"], ["command"])
            rolled = packages.rollback(state, "fixture-tool")
            self.assertEqual(rolled["archiveSha256"], first_hash)
            self.assertFalse(rolled["enabled"])
            self.assertEqual(rolled["grants"], [])
            self.assertTrue(Path(upgraded["root"]).is_dir())
            removed = packages.uninstall(state, "fixture-tool")
            self.assertIsNone(removed["active"])
            self.assertTrue(Path(initial["root"]).is_dir())
            self.assertFalse(packages.list_packages(state)[0]["installed"])
            self.assertTrue(packages.review(state, "fixture-tool", archive_sha256=first_hash)["valid"])

    def test_zip_path_link_collision_and_size_guards(self):
        unsafe = ["../escape.py", "C:/escape.py", "server.py:stream", "NUL.py", "src/aux/file.py", "COM¹.py",
                  "src/bad. /file.py", "src\\server.py", "/absolute.py", "src/../other.py"]
        for name in unsafe:
            with self.subTest(name=name):
                data, _ = archive(entries={name: b"bad"})
                with self.assertRaises(ValueError):
                    packages.review_archive(data)
        for entries in [{"SRC/other.py": b"bad"}, {"src/server.PY": b"bad"}, {"src": b"bad"}]:
            data, _ = archive(entries=entries)
            with self.assertRaisesRegex(ValueError, "collid|directory"):
                packages.review_archive(data)
        data, _ = archive()
        output = io.BytesIO(data)
        with zipfile.ZipFile(output, "a") as stream:
            link = zipfile.ZipInfo("link.py")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            stream.writestr(link, "src/server.py")
        with self.assertRaisesRegex(ValueError, "link"):
            packages.review_archive(output.getvalue())
        with patch.object(packages, "MAX_FILE_BYTES", 8):
            with self.assertRaisesRegex(ValueError, "limit"):
                packages.review_archive(data)

    def test_closed_schema_duplicate_json_and_integrity_fail_closed(self):
        data, digest = archive()
        with tempfile.TemporaryDirectory() as state:
            installed = packages.install(state, data, expected_sha256=digest)
            packages.set_enabled(state, "fixture-tool", True, expected_sha256=digest, grants=["command"])
            healthy_data, healthy_digest = archive(package_id="healthy-tool")
            packages.install(state, healthy_data, expected_sha256=healthy_digest)
            Path(installed["entrypoint"]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "integrity"):
                packages.review(state, "fixture-tool")
            with self.assertRaisesRegex(ValueError, "integrity"):
                packages.set_enabled(state, "fixture-tool", True, expected_sha256=digest, grants=["command"])
            rows = {row["id"]: row for row in packages.list_packages(state)}
            self.assertFalse(rows["fixture-tool"]["valid"])
            self.assertTrue(rows["fixture-tool"]["enabled"])
            self.assertEqual(rows["fixture-tool"]["archiveSha256"], digest)
            self.assertEqual(rows["fixture-tool"]["safeError"], "installed package failed integrity verification")
            self.assertTrue(rows["healthy-tool"]["valid"])
            original_link_check = packages._is_link
            with patch.object(packages, "_is_link", side_effect=lambda path: Path(path) == Path(installed["entrypoint"]) or original_link_check(path)):
                with self.assertRaisesRegex(ValueError, "links or reparse"):
                    packages.list_packages(state)
            # Rewriting both source and its mutable receipt cannot defeat the archive pin.
            receipt_path = Path(installed["root"]).parent / "receipt.json"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            for row in receipt["files"]:
                if row["path"] == "src/server.py":
                    row.update(size=7, sha256=hashlib.sha256(b"changed").hexdigest())
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "confirmed archive"):
                packages.review(state, "fixture-tool")
            # Recovery actions remain available even after package corruption.
            self.assertFalse(packages.set_enabled(state, "fixture-tool", False,
                                                  expected_sha256=digest)["enabled"])
            self.assertTrue(packages.uninstall(state, "fixture-tool")["uninstalled"])
        review = packages.review_archive(data)
        document = {**review["manifest"], "installScript": "run.py"}
        bad, _ = archive(entries={packages.MANIFEST_NAME: json.dumps(document).encode()})
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            packages.review_archive(bad)
        bad, _ = archive(entries={packages.MANIFEST_NAME: b'{"apiVersion":1,"apiVersion":1}'})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            packages.review_archive(bad)

    def test_reparse_storage_and_disabled_plugin_refuse_work(self):
        data, digest = archive()
        with tempfile.TemporaryDirectory() as state:
            storage = Path(state) / packages.STORE_DIRECTORY
            original = packages._is_link
            with patch.object(packages, "_is_link", side_effect=lambda path: Path(path) == storage or original(path)):
                with self.assertRaisesRegex(ValueError, "reparse"):
                    packages.install(state, data, expected_sha256=digest)
            self.assertFalse(storage.exists())
            with patch.object(packages, "require_enabled", side_effect=RuntimeError("extensions disabled")):
                with self.assertRaisesRegex(RuntimeError, "disabled"):
                    packages.install(state, data, expected_sha256=digest)
            self.assertFalse(storage.exists())


if __name__ == "__main__":
    unittest.main()
