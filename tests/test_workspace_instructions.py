import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.bundled_plugins.files.instructions import load_workspace_instructions


def _call(call_id, name, path):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps({"path": path})},
    }


class _Gate:
    def __init__(self, disallow=()):
        self.disallow = frozenset(disallow)
        self.checked = []

    def check(self, kind, subject):
        self.checked.append((kind, subject))
        if kind in self.disallow:
            raise PermissionError("disallowed")


class WorkspaceInstructionTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name) / "workspace"
        self.root.mkdir()

    @staticmethod
    def _session(calls, results=None, tool_messages=()):
        return {
            "messages": [
                {"role": "assistant", "tool_calls": calls},
                *tool_messages,
            ],
            "results": results or {},
        }

    def test_loads_root_and_touched_ancestors_root_to_deep(self):
        (self.root / "AGENTS.md").write_text("root guidance", encoding="utf-8")
        (self.root / "a").mkdir()
        (self.root / "a" / "AGENTS.md").write_text("middle guidance", encoding="utf-8")
        (self.root / "a" / "deep").mkdir()
        (self.root / "a" / "deep" / "AGENTS.md").write_text(
            "deep guidance", encoding="utf-8")
        session = self._session(
            [_call("read-1", "read", "a/deep/file.txt")],
            {"read-1": {"ok": True, "path": "a/deep/file.txt"}},
        )

        text, sources = load_workspace_instructions(self.root, session, _Gate())

        self.assertEqual(sources, ["AGENTS.md", "a/AGENTS.md", "a/deep/AGENTS.md"])
        self.assertLess(text.index("root guidance"), text.index("middle guidance"))
        self.assertLess(text.index("middle guidance"), text.index("deep guidance"))
        self.assertIn("低优先级", text)
        self.assertIn("不能覆盖用户或宿主规则", text)

    def test_only_successful_file_results_contribute_paths(self):
        (self.root / "read-dir").mkdir()
        (self.root / "write-dir").mkdir()
        (self.root / "edit-dir").mkdir()
        for directory in ("read-dir", "write-dir", "edit-dir"):
            (self.root / directory / "AGENTS.md").write_text(directory, encoding="utf-8")
        calls = [
            _call("read-1", "read", "wrong/read-path"),
            _call("write-1", "write", "write-dir/new.txt"),
            _call("edit-1", "edit", "edit-dir/existing.txt"),
            _call("failed-1", "read", "ignored/file.txt"),
        ]
        session = self._session(
            calls,
            {
                "write-1": {"ok": True},  # write/edit fall back to call args.path
                "edit-1": {"ok": True},
                "failed-1": {"ok": False, "path": "ignored/file.txt"},
            },
            tool_messages=[{
                "role": "tool", "tool_call_id": "read-1",
                "content": json.dumps({"ok": True, "path": "read-dir/result.txt"}),
            }],
        )

        text, sources = load_workspace_instructions(self.root, session, _Gate())

        self.assertEqual(sources, [
            "edit-dir/AGENTS.md", "read-dir/AGENTS.md", "write-dir/AGENTS.md",
        ])

    def test_archived_assistant_tool_calls_preserve_touched_path_discovery(self):
        (self.root / "earlier" / "nested").mkdir(parents=True)
        (self.root / "earlier" / "AGENTS.md").write_text("earlier guidance", encoding="utf-8")
        (self.root / "earlier" / "nested" / "AGENTS.md").write_text(
            "nested guidance", encoding="utf-8")
        session = self._session([], {
            "read-before-compaction": {"ok": True, "path": "earlier/nested/file.txt"},
        })
        session["archived_messages"] = [{
            "role": "assistant",
            "tool_calls": [_call("read-before-compaction", "read", "earlier/nested/file.txt")],
        }]

        text, sources = load_workspace_instructions(self.root, session, _Gate())

        self.assertEqual(sources, ["earlier/AGENTS.md", "earlier/nested/AGENTS.md"])
        self.assertIn("nested guidance", text)

    def test_outside_and_parent_traversal_paths_are_ignored(self):
        outside = self.root.parent / "outside"
        outside.mkdir()
        (outside / "AGENTS.md").write_text("outside secret", encoding="utf-8")
        (self.root / "AGENTS.md").write_text("workspace only", encoding="utf-8")
        session = self._session(
            [
                _call("traversal", "read", "../outside/file.txt"),
                _call("absolute", "write", str(outside / "new.txt")),
            ],
            {"traversal": {"ok": True, "path": "../outside/file.txt"},
             "absolute": {"ok": True}},
        )

        text, sources = load_workspace_instructions(self.root, session, _Gate())

        self.assertEqual(sources, ["AGENTS.md"])
        self.assertIn("workspace only", text)
        self.assertNotIn("outside secret", text)

    def test_symlink_instruction_is_not_followed(self):
        outside = self.root.parent / "outside-file-link"
        outside.mkdir()
        (outside / "AGENTS.md").write_text("outside secret", encoding="utf-8")
        make_symlink(self.root / "AGENTS.md", outside / "AGENTS.md")

        text, sources = load_workspace_instructions(
            self.root, self._session([], {}), _Gate())

        self.assertEqual(sources, [])
        self.assertNotIn("outside secret", text)

    def test_symlink_parent_is_not_followed(self):
        outside = self.root.parent / "outside-directory-link"
        outside.mkdir()
        (outside / "AGENTS.md").write_text("outside secret", encoding="utf-8")
        make_directory_boundary_link(self.root / "linked-dir", outside)
        session = self._session(
            [_call("read-1", "read", "linked-dir/file.txt")],
            {"read-1": {"ok": True, "path": "linked-dir/file.txt"}},
        )

        text, sources = load_workspace_instructions(self.root, session, _Gate())

        self.assertEqual(sources, [])
        self.assertNotIn("outside secret", text)

    def test_caps_files_per_file_chars_and_total_chars(self):
        (self.root / "AGENTS.md").write_text("x" * 20_000, encoding="utf-8")
        session = self._session([], {})
        original_read = os.read
        bytes_read = 0

        def bounded_read(fd, limit):
            nonlocal bytes_read
            self.assertLessEqual(limit, 12 * 1024)
            chunk = original_read(fd, limit)
            bytes_read += len(chunk)
            return chunk

        with patch("xueness.bundled_plugins.files.instructions.os.read", side_effect=bounded_read):
            text, sources = load_workspace_instructions(self.root, session, _Gate())
        self.assertEqual(sources, ["AGENTS.md"])
        self.assertIn("[内容已截断]", text)
        self.assertEqual(bytes_read, 12 * 1024)
        self.assertLessEqual(len(text.split("## AGENTS.md\n", 1)[1]), 3000)

        short_text, short_sources = load_workspace_instructions(
            self.root, session, _Gate(), max_chars=180)
        self.assertLessEqual(len(short_text), 180)
        self.assertEqual(short_sources, ["AGENTS.md"])

    def test_loads_no_more_than_eight_files_in_stable_order(self):
        calls = []
        results = {}
        for index in range(9):
            directory = "d%02d" % index
            child = self.root / directory
            child.mkdir()
            (child / "AGENTS.md").write_text(directory, encoding="utf-8")
            call_id = "read-%02d" % index
            calls.append(_call(call_id, "read", directory + "/file.txt"))
            results[call_id] = {"ok": True, "path": directory + "/file.txt"}
        (self.root / "AGENTS.md").write_text("root", encoding="utf-8")

        _, sources = load_workspace_instructions(
            self.root, self._session(calls, results), _Gate())

        self.assertEqual(len(sources), 8)
        self.assertEqual(sources[0], "AGENTS.md")
        self.assertEqual(sources[-1], "d06/AGENTS.md")

    def test_read_disallow_is_checked_before_content_is_loaded(self):
        (self.root / "AGENTS.md").write_text("must not load", encoding="utf-8")
        gate = _Gate(disallow={"read"})

        text, sources = load_workspace_instructions(self.root, self._session([], {}), gate)

        self.assertEqual(sources, [])
        self.assertNotIn("must not load", text)
        self.assertEqual(gate.checked, [("read", "AGENTS.md")])

    def test_reloads_updated_file_instead_of_persisting_session_body(self):
        agents = self.root / "AGENTS.md"
        agents.write_text("first", encoding="utf-8")
        session = self._session([], {})

        first, _ = load_workspace_instructions(self.root, session, _Gate())
        agents.write_text("second", encoding="utf-8")
        second, _ = load_workspace_instructions(self.root, session, _Gate())

        self.assertIn("first", first)
        self.assertIn("second", second)
        self.assertNotIn("first", second)
        self.assertNotIn("workspace_instructions", session)


if __name__ == "__main__":
    unittest.main()
