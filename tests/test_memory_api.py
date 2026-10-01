"""Tests for the read-only memory-track API (xueness.memory_api).

Covers the unset-root empty response, the full three-track happy path with
byte-accurate sizes, partial presence, non-GET/foreign-path pass-through, and
a strict read-only assertion: the memory root is snapshotted (path + mtime +
size) before and after dispatch and must be byte-identical.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from xueness.memory import project_hash
from xueness.memory_api import MEMORY_ROOT_ENV, dispatch, memory_root


def snapshot(root: Path) -> dict:
    """Recursive path -> (mtime_ns, size) map; empty when root is absent."""
    if not root.exists():
        return {}
    out = {}
    for path in sorted(root.rglob("*")):
        st = path.stat()
        out[str(path.relative_to(root))] = (st.st_mtime_ns, st.st_size)
    return out


class MemoryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.memory_root = self.root / "memories"
        self.cwd = "/srv/projects/demo-app"
        self.ctx = {"memory_cwd": self.cwd, "project_dir": Path(self.root / "proj")}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, method="GET", parts=None, ctx=None, query=None, data=None):
        return dispatch(
            method,
            ["api", "memory", "tracks"] if parts is None else parts,
            query or {},
            data or {},
            self.ctx if ctx is None else ctx,
        )

    def key_path(self):
        return self.memory_root / "projects" / project_hash(self.cwd) / "KEY.md"

    def write_tracks(self, memory=True, user=True, key=True):
        self.memory_root.mkdir(parents=True, exist_ok=True)
        written = {}
        if memory:
            written["memory"] = self.memory_root / "MEMORY.md"
            written["memory"].write_text("global fact\n§\nsecond fact\n", encoding="utf-8")
        if user:
            written["user"] = self.memory_root / "USER.md"
            written["user"].write_text("likes tea\n", encoding="utf-8")
        if key:
            written["key"] = self.key_path()
            written["key"].parent.mkdir(parents=True, exist_ok=True)
            written["key"].write_text("project fact\n", encoding="utf-8")
        return written

    # --- env handling -----------------------------------------------------

    def test_unset_memory_root_returns_empty_tracks(self):
        env = {k: v for k, v in os.environ.items() if k != MEMORY_ROOT_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(memory_root())
            status, payload = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"tracks": []})

    def test_blank_memory_root_returns_empty_tracks(self):
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: "   "}, clear=False):
            self.assertIsNone(memory_root())
            status, payload = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"tracks": []})

    # --- happy path -------------------------------------------------------

    def test_all_three_tracks_present_with_exact_sizes(self):
        written = self.write_tracks()
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            status, payload = self.call()

        self.assertEqual(status, 200)
        tracks = payload["tracks"]
        self.assertEqual(len(tracks), 3)
        self.assertEqual([t["name"] for t in tracks], ["memory", "user", "key"])
        for track in tracks:
            self.assertTrue(track["present"])
            self.assertEqual(track["path"], str(written[track["name"]]))
            self.assertEqual(track["bytes"], written[track["name"]].stat().st_size)
            self.assertGreater(track["bytes"], 0)

    def test_only_memory_track_present(self):
        self.write_tracks(memory=True, user=False, key=False)
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            status, payload = self.call()

        self.assertEqual(status, 200)
        by_name = {t["name"]: t for t in payload["tracks"]}
        self.assertEqual(list(by_name), ["memory", "user", "key"])
        self.assertTrue(by_name["memory"]["present"])
        self.assertEqual(
            by_name["memory"]["bytes"], (self.memory_root / "MEMORY.md").stat().st_size
        )
        for name in ("user", "key"):
            self.assertFalse(by_name[name]["present"])
            self.assertEqual(by_name[name]["bytes"], 0)

    def test_missing_root_directory_is_not_an_error(self):
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            status, payload = self.call()
        self.assertEqual(status, 200)
        self.assertEqual([t["present"] for t in payload["tracks"]], [False, False, False])
        self.assertEqual([t["bytes"] for t in payload["tracks"]], [0, 0, 0])

    # --- routing ----------------------------------------------------------

    def test_non_get_method_returns_none(self):
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            for method in ("POST", "DELETE", "PUT"):
                self.assertIsNone(self.call(method=method))

    def test_other_paths_return_none(self):
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            self.assertIsNone(self.call(parts=["api", "settings"]))
            self.assertIsNone(self.call(parts=["api", "memory"]))
            self.assertIsNone(self.call(parts=["api", "memory", "tracks", "extra"]))
            self.assertIsNone(self.call(parts=[]))

    # --- ctx cwd resolution ----------------------------------------------

    def test_project_dir_used_when_memory_cwd_absent(self):
        self.memory_root.mkdir(parents=True, exist_ok=True)
        project_dir = Path(self.root / "proj")
        project_dir.mkdir()
        expected = self.memory_root / "projects" / project_hash(str(project_dir)) / "KEY.md"
        expected.parent.mkdir(parents=True)
        expected.write_text("k\n", encoding="utf-8")
        ctx = {"project_dir": project_dir}
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            status, payload = self.call(ctx=ctx)
        by_name = {t["name"]: t for t in payload["tracks"]}
        self.assertEqual(status, 200)
        self.assertEqual(by_name["key"]["path"], str(expected))
        self.assertTrue(by_name["key"]["present"])

    # --- read-only guarantee ---------------------------------------------

    def test_dispatch_never_mutates_memory_root(self):
        self.write_tracks()
        before = snapshot(self.memory_root)
        self.assertTrue(before)

        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            self.call()
            self.call(method="POST")
            self.call(parts=["api", "memory", "tracks", "extra"])

        after = snapshot(self.memory_root)
        self.assertEqual(before, after)

    def test_dispatch_leaves_absent_root_absent(self):
        before = snapshot(self.memory_root)
        with mock.patch.dict(os.environ, {MEMORY_ROOT_ENV: str(self.memory_root)}, clear=False):
            self.call()
        self.assertEqual(before, snapshot(self.memory_root))
        self.assertFalse(self.memory_root.exists())


if __name__ == "__main__":
    unittest.main()
