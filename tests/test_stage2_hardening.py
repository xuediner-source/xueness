"""Stage 2 hardening regression tests.

These lock in the fixes for the two blocking findings from the adversarial
review (``reviews/stage2-review.md``):

* **HIGH-1** — a symlinked ``<state_dir>/providers`` directory redirected the
  path jail outside ``state_dir``, letting ``*.json`` be created and read
  outside the state root.
* **HIGH-2** — a symlinked ``<state_dir>/resources/<kind>/<id>.json`` entry
  made an unrelated file's content readable through ``GET /api/resources``.

Plus the follow-on issues: dot-only ids (``.`` / ``..``) and malformed
on-disk state (a directory where a JSON file is expected) must degrade to
400/404 rather than a 500.

Every test asserts behaviour, not implementation: they drive ``dispatch``
exactly the way ``web.py`` does and check the returned status/payload.
"""
import json
import tempfile
import unittest
from pathlib import Path

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness import providers_api, resources


def _ctx(state_dir: Path) -> dict:
    return {"state_dir": state_dir}


class ProviderSymlinkJailTests(unittest.TestCase):
    """HIGH-1: the providers directory must never be reachable via symlink."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state"
        self.outside = Path(self._tmp.name) / "outside"
        self.state.mkdir(parents=True)
        self.outside.mkdir(parents=True)
        (self.outside / "esc.json").write_text(
            json.dumps({"id": "escaped", "apiKey": "SENTINEL_KEY"}), encoding="utf-8"
        )
        # The attack: replace the providers directory with a symlink outside.
        make_directory_boundary_link(self.state / "providers", self.outside)
        self.ctx = _ctx(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_symlinked_providers_dir_get_is_refused(self):
        status, payload = providers_api.dispatch("GET", ["api", "providers"], {}, {}, self.ctx)
        self.assertEqual(status, 400)
        self.assertIn("symlink", payload["error"])

    def test_symlinked_providers_dir_cannot_write_outside(self):
        status, _ = providers_api.dispatch(
            "POST",
            ["api", "providers"],
            {},
            {
                "id": "escapedwrite",
                "name": "X",
                "baseUrl": "https://x.example/v1",
                "model": "m",
                "apiKey": "sk-X",
            },
            self.ctx,
        )
        self.assertEqual(status, 400)
        self.assertFalse(
            (self.outside / "escapedwrite.json").exists(),
            "write escaped state_dir through the symlinked providers dir",
        )

    def test_symlinked_providers_dir_does_not_leak_existing_key(self):
        status, payload = providers_api.dispatch("GET", ["api", "providers"], {}, {}, self.ctx)
        self.assertNotIn("SENTINEL_KEY", json.dumps(payload))
        self.assertEqual(status, 400)


class ResourceSymlinkReadThroughTests(unittest.TestCase):
    """HIGH-2: a symlinked entry must not be readable or deletable."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state"
        self.skills = self.state / "resources" / "skills"
        self.skills.mkdir(parents=True)
        self.ctx = _ctx(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_symlinked_item_is_not_listed(self):
        secret = Path(self._tmp.name) / "secret.json"
        secret.write_text(
            json.dumps({"id": "outside", "note": "SENTINEL_READTHROUGH"}), encoding="utf-8"
        )
        make_symlink(self.skills / "leak.json", secret)

        status, payload = resources.dispatch("GET", ["api", "resources", "skills"], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])
        self.assertNotIn("SENTINEL_READTHROUGH", json.dumps(payload))

    def test_symlinked_item_cannot_be_deleted(self):
        secret = Path(self._tmp.name) / "secret.json"
        secret.write_text(json.dumps({"id": "outside"}), encoding="utf-8")
        link = self.skills / "leak.json"
        make_symlink(link, secret)

        status, _ = resources.dispatch(
            "DELETE", ["api", "resources", "skills", "leak"], {}, {}, self.ctx
        )
        self.assertIn(status, (400, 404))
        self.assertTrue(secret.exists(), "the symlink target outside was removed")
        self.assertTrue(link.is_symlink(), "the symlink itself was removed")

    def test_symlinked_kind_dir_is_refused(self):
        outside = Path(self._tmp.name) / "outside_kind"
        outside.mkdir()
        (outside / "x.json").write_text(json.dumps({"id": "outside"}), encoding="utf-8")
        # Replace the skills dir with a symlink to the outside dir.
        import shutil

        shutil.rmtree(self.skills)
        make_directory_boundary_link(self.skills, outside)

        status, _ = resources.dispatch("GET", ["api", "resources", "skills"], {}, {}, self.ctx)
        self.assertEqual(status, 400)


class ReservedIdTests(unittest.TestCase):
    """Dot-only ids satisfy the regex but are traversal markers."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state"
        self.state.mkdir(parents=True)
        self.ctx = _ctx(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resources_reject_dot_ids(self):
        for bad in (".", ".."):
            with self.subTest(bad=bad):
                status, _ = resources.dispatch(
                    "POST", ["api", "resources", "skills"], {}, {"id": bad}, self.ctx
                )
                self.assertEqual(status, 400)
                # No hidden file may be created for these names.
                kind_dir = self.state / "resources" / "skills"
                if kind_dir.is_dir():
                    for entry in kind_dir.iterdir():
                        self.assertNotIn(entry.name, ("..json", ".json"))

    def test_providers_reject_dot_ids(self):
        for bad in (".", ".."):
            with self.subTest(bad=bad):
                status, _ = providers_api.dispatch(
                    "POST",
                    ["api", "providers"],
                    {},
                    {"id": bad, "name": "X", "baseUrl": "https://x.example/v1", "model": "m"},
                    self.ctx,
                )
                self.assertEqual(status, 400)


class MalformedStateTests(unittest.TestCase):
    """A directory where a JSON file is expected is a client-shaped 400/404."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state"
        self.state.mkdir(parents=True)
        self.ctx = _ctx(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resources_delete_directory_entry_is_not_500(self):
        target = self.state / "resources" / "skills" / "diritem.json"
        target.mkdir(parents=True)
        status, _ = resources.dispatch(
            "DELETE", ["api", "resources", "skills", "diritem"], {}, {}, self.ctx
        )
        self.assertIn(status, (400, 404))

    def test_resources_list_with_directory_entry_is_not_500(self):
        target = self.state / "resources" / "skills" / "diritem.json"
        target.mkdir(parents=True)
        status, payload = resources.dispatch(
            "GET", ["api", "resources", "skills"], {}, {}, self.ctx
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])

    def test_providers_write_onto_directory_is_not_500(self):
        (self.state / "providers").mkdir(parents=True)
        (self.state / "providers" / "dirprov.json").mkdir()
        status, _ = providers_api.dispatch(
            "POST",
            ["api", "providers"],
            {},
            {"id": "dirprov", "name": "X", "baseUrl": "https://x.example/v1", "model": "m"},
            self.ctx,
        )
        self.assertEqual(status, 400)


class HappyPathStillWorksTests(unittest.TestCase):
    """The hardening must not break the ordinary read/write path."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name) / "state"
        self.state.mkdir(parents=True)
        self.ctx = _ctx(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resource_round_trip(self):
        status, payload = resources.dispatch(
            "POST", ["api", "resources", "skills"], {}, {"id": "ok-skill", "name": "OK"}, self.ctx
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["item"]["id"], "ok-skill")

        status, payload = resources.dispatch("GET", ["api", "resources", "skills"], {}, {}, self.ctx)
        self.assertEqual([item["id"] for item in payload["items"]], ["ok-skill"])

        status, _ = resources.dispatch(
            "DELETE", ["api", "resources", "skills", "ok-skill"], {}, {}, self.ctx
        )
        self.assertEqual(status, 200)

    def test_provider_round_trip_never_echoes_key(self):
        status, payload = providers_api.dispatch(
            "POST",
            ["api", "providers"],
            {},
            {
                "id": "ok-prov",
                "name": "OK",
                "baseUrl": "https://x.example/v1",
                "model": "m",
                "apiKey": "sk-TOP-SECRET",
            },
            self.ctx,
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["provider"]["hasKey"])
        self.assertNotIn("sk-TOP-SECRET", json.dumps(payload))

        status, payload = providers_api.dispatch("GET", ["api", "providers"], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertNotIn("sk-TOP-SECRET", json.dumps(payload))
        self.assertEqual(payload["providers"][0]["id"], "ok-prov")


if __name__ == "__main__":
    unittest.main()
