"""Provider API tests (Stage 2 contract, section 3).

The emphasis is on the security properties, not just the happy path:

* the api key never appears in any response body (``assertNotIn`` on the raw
  serialized JSON, so a nested leak would still be caught);
* ``hasKey`` reflects whether a key is on disk;
* hostile ``baseUrl`` / ``id`` values are rejected with 400;
* an upsert without ``apiKey`` preserves the stored key;
* the on-disk key file is owner-private on POSIX and Windows.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.secret_permissions import assert_secret_file_private
from xueness.bundled_plugins.providers import providers_api
from xueness.providers_api import dispatch
from xueness.resources import _protect_private_file

SECRET = "sk-test-only-placeholder-secret-key"


class ProviderApiTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self._tmp.name).resolve()
        self.ctx = {"state_dir": self.state_dir}
        (self.state_dir / "providers").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def call(self, method, path, data=None, query=None):
        parts = [p for p in path.split("/") if p]
        return dispatch(method, parts, query or {}, data or {}, self.ctx)

    def post(self, body):
        status, payload = self.call("POST", "/api/providers", data=body)
        self.assertIsNotNone(payload)
        return status, payload

    def body_text(self, payload):
        return json.dumps(payload, ensure_ascii=False)

    def key_path(self, pid):
        return self.state_dir / "providers" / f"{pid}.json"

    def base(self, **over):
        body = {
            "id": "openai",
            "name": "OpenAI",
            "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-4o",
        }
        body.update(over)
        return body

    # -- routing ---------------------------------------------------------
    def test_foreign_paths_return_none(self):
        for method, path in [
            ("GET", "/api/settings"),
            ("GET", "/api/resources/skills"),
            ("POST", "/api/usage"),
            ("DELETE", "/api/memory/tracks"),
            ("GET", "/healthz"),
        ]:
            self.assertIsNone(self.call(method, path, data={"id": "x"}))
        # sub-paths of providers that are not part of the contract
        self.assertIsNone(self.call("GET", "/api/providers/openai"))
        self.assertIsNone(self.call("POST", "/api/providers/openai"))

    def test_empty_list_when_nothing_stored(self):
        status, payload = self.call("GET", "/api/providers")
        self.assertEqual(200, status)
        self.assertEqual({"providers": []}, payload)

    def test_private_temp_file_is_protected_before_secret_write(self):
        fd, raw_path = tempfile.mkstemp(prefix="private-test-", dir=self.state_dir)
        path = Path(raw_path)
        open_fd = fd
        try:
            _protect_private_file(open_fd)
            # Inspect the native DACL while the temp handle is still open and
            # before putting credential bytes into the file.
            assert_secret_file_private(self, path)
            stream = os.fdopen(open_fd, "wb")
            open_fd = -1
            with stream:
                stream.write(SECRET.encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            assert_secret_file_private(self, path)
        finally:
            if open_fd >= 0:
                os.close(open_fd)
            path.unlink(missing_ok=True)

    def test_acl_setup_failure_preserves_old_provider_and_cleans_temp_fd(self):
        path = self.key_path("openai")
        path.parent.mkdir(parents=True, exist_ok=True)
        original = b'{"apiKey":"old-secret"}\n'
        path.write_bytes(original)
        opened_fds = []

        def reject_private_file(fd):
            opened_fds.append(fd)
            raise OSError("simulated ACL setup failure")

        with mock.patch.object(providers_api, "_protect_private_file",
                               side_effect=reject_private_file):
            with self.assertRaisesRegex(OSError, "simulated ACL setup failure"):
                providers_api._atomic_write(path, {"apiKey": SECRET})

        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(path.parent.glob(".provider-*")), [])
        self.assertNotIn(SECRET.encode(), b"".join(item.read_bytes() for item in path.parent.iterdir()))
        self.assertEqual(len(opened_fds), 1)
        with self.assertRaises(OSError):
            os.fstat(opened_fds[0])

    # -- happy path ------------------------------------------------------
    def test_post_then_list_and_delete(self):
        status, payload = self.post(self.base(apiKey=SECRET))
        self.assertEqual(200, status)
        self.assertEqual(
            {"id": "openai", "name": "OpenAI",
             "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o",
             "hasKey": True},
            payload["provider"],
        )

        status, payload = self.call("GET", "/api/providers")
        self.assertEqual(200, status)
        self.assertEqual(1, len(payload["providers"]))
        self.assertEqual("openai", payload["providers"][0]["id"])

        status, payload = self.call("DELETE", "/api/providers/openai")
        self.assertEqual(200, status)
        self.assertEqual({"ok": True, "id": "openai"}, payload)

        status, payload = self.call("GET", "/api/providers")
        self.assertEqual([], payload["providers"])

    def test_list_is_sorted_by_id(self):
        for pid in ("zeta", "alpha", "mid"):
            self.assertEqual(200, self.post(self.base(id=pid))[0])
        _, payload = self.call("GET", "/api/providers")
        self.assertEqual(["alpha", "mid", "zeta"],
                         [p["id"] for p in payload["providers"]])

    # -- secret never echoed --------------------------------------------
    def test_api_key_never_echoed(self):
        status, payload = self.post(self.base(apiKey=SECRET))
        self.assertEqual(200, status)
        self.assertNotIn(SECRET, self.body_text(payload))
        self.assertNotIn("apiKey", self.body_text(payload))
        self.assertTrue(payload["provider"]["hasKey"])

        _, listing = self.call("GET", "/api/providers")
        self.assertNotIn(SECRET, self.body_text(listing))
        self.assertNotIn("apiKey", self.body_text(listing))
        self.assertTrue(listing["providers"][0]["hasKey"])

        # the key really is on disk (so the assertion above is meaningful)
        raw = self.key_path("openai").read_text(encoding="utf-8")
        self.assertIn(SECRET, raw)

    def test_legacy_url_credentials_are_redacted_from_public_summary(self):
        profile = self.base(
            apiKey=SECRET,
            baseUrl=f"https://user:{SECRET}@api.example.com/v1?token={SECRET}",
        )
        self.key_path("openai").write_text(json.dumps(profile), encoding="utf-8")
        _, listing = self.call("GET", "/api/providers")
        encoded = self.body_text(listing)
        self.assertNotIn(SECRET, encoded)
        self.assertEqual("https://api.example.com/v1", listing["providers"][0]["baseUrl"])

    def test_has_key_false_without_api_key(self):
        status, payload = self.post(self.base())
        self.assertEqual(200, status)
        self.assertFalse(payload["provider"]["hasKey"])
        _, listing = self.call("GET", "/api/providers")
        self.assertFalse(listing["providers"][0]["hasKey"])

    def test_upsert_without_api_key_preserves_existing(self):
        self.assertEqual(200, self.post(self.base(apiKey=SECRET))[0])
        status, payload = self.post(self.base(name="Renamed", model="gpt-4.1"))
        self.assertEqual(200, status)
        self.assertEqual("Renamed", payload["provider"]["name"])
        self.assertEqual("gpt-4.1", payload["provider"]["model"])
        self.assertTrue(payload["provider"]["hasKey"])
        self.assertNotIn(SECRET, self.body_text(payload))

        stored = json.loads(self.key_path("openai").read_text(encoding="utf-8"))
        self.assertEqual(SECRET, stored["apiKey"])

        _, listing = self.call("GET", "/api/providers")
        self.assertTrue(listing["providers"][0]["hasKey"])

    def test_upsert_with_new_api_key_replaces(self):
        self.assertEqual(200, self.post(self.base(apiKey=SECRET))[0])
        new_secret = "sk-rotated-0987654321"
        status, payload = self.post(self.base(apiKey=new_secret))
        self.assertEqual(200, status)
        self.assertNotIn(new_secret, self.body_text(payload))
        stored = json.loads(self.key_path("openai").read_text(encoding="utf-8"))
        self.assertEqual(new_secret, stored["apiKey"])

    def test_upsert_empty_api_key_clears(self):
        self.assertEqual(200, self.post(self.base(apiKey=SECRET))[0])
        status, payload = self.post(self.base(apiKey=""))
        self.assertEqual(200, status)
        self.assertFalse(payload["provider"]["hasKey"])
        stored = json.loads(self.key_path("openai").read_text(encoding="utf-8"))
        self.assertNotIn("apiKey", stored)

    # -- validation: baseUrl --------------------------------------------
    def test_hostile_base_urls_rejected(self):
        for bad in ("ftp://x", "javascript:alert(1)", "notaurl",
                    "file:///etc/passwd", "//example.com", "",
                    "http://", "   ", 123, None,
                    "https://user:embedded-secret@example.com/v1",
                    "https://@api.example.com/v1",
                    "https://api.example.com/v1?token=embedded-secret",
                    "https://api.example.com/v1#embedded-secret",
                    "https://api.example.com:bad/v1"):
            status, payload = self.post(self.base(baseUrl=bad))
            self.assertEqual(400, status, f"baseUrl={bad!r} should be 400")
            self.assertIn("error", payload)
            self.assertNotIn("embedded-secret", json.dumps(payload))
        self.assertFalse(self.key_path("openai").exists())

    def test_http_and_https_accepted(self):
        for good in ("http://localhost:8080/v1", "https://api.example.com"):
            status, _ = self.post(self.base(baseUrl=good))
            self.assertEqual(200, status)

    # -- validation: id --------------------------------------------------
    def test_invalid_ids_rejected(self):
        for bad in ("../x", "a/b", "", "   ", "..", "a" * 65,
                    "has space", "semi;colon", None, 42):
            status, payload = self.post(self.base(id=bad))
            self.assertEqual(400, status, f"id={bad!r} should be 400")
            self.assertIn("error", payload)

    def test_unknown_id_delete_is_404(self):
        status, payload = self.call("DELETE", "/api/providers/ghost")
        self.assertEqual(404, status)
        self.assertIn("error", payload)

    def test_invalid_id_delete_is_400(self):
        status, payload = self.call("DELETE", "/api/providers/..%2Fx")
        # "%2F" is a literal here (web.py does the unquoting); it is not in
        # the whitelist, so this must be rejected, never treated as a path.
        self.assertEqual(400, status)
        self.assertIn("error", payload)

    def test_delete_traversal_never_touches_outside_file(self):
        outside = self.state_dir / "outside.json"
        outside.write_text("keep me", encoding="utf-8")
        status, _ = self.call("DELETE", "/api/providers/..")
        self.assertEqual(400, status)
        self.assertTrue(outside.exists())

    # -- validation: required fields -------------------------------------
    def test_missing_required_fields_rejected(self):
        for field in ("name", "baseUrl", "model", "id"):
            body = self.base()
            body.pop(field)
            status, payload = self.post(body)
            self.assertEqual(400, status, f"missing {field} should be 400")
            self.assertIn("error", payload)

    def test_non_object_body_rejected(self):
        status, payload = self.call("POST", "/api/providers", data=None)
        self.assertEqual(400, status)
        self.assertIn("error", payload)

    # -- atomic write + permissions --------------------------------------
    def test_key_file_is_private_after_atomic_upsert(self):
        self.assertEqual(200, self.post(self.base(apiKey=SECRET))[0])
        assert_secret_file_private(self, self.key_path("openai"))

        # survives an upsert too
        self.assertEqual(200, self.post(self.base(apiKey="sk-next"))[0])
        assert_secret_file_private(self, self.key_path("openai"))

    def test_readback_after_atomic_write(self):
        self.assertEqual(200, self.post(self.base(apiKey=SECRET))[0])
        stored = json.loads(self.key_path("openai").read_text(encoding="utf-8"))
        revision = stored.pop("_profileRevision")
        self.assertRegex(revision, r"^[0-9a-f]{32}$")
        self.assertEqual(
            {"id": "openai", "name": "OpenAI",
             "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o",
             "apiKey": SECRET},
            stored,
        )
        # no temp files left behind
        leftovers = [p.name for p in (self.state_dir / "providers").glob(".provider-*")]
        self.assertEqual([], leftovers)

    def test_corrupt_store_is_skipped_not_fatal(self):
        (self.state_dir / "providers" / "broken.json").write_text(
            "{not json", encoding="utf-8")
        status, payload = self.call("GET", "/api/providers")
        self.assertEqual(200, status)
        self.assertEqual([], payload["providers"])


if __name__ == "__main__":
    unittest.main()
