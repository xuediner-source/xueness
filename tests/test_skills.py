"""Stage 3 skills-injection tests.

Covers the contract in docs/stage3-contract.md, section "后端模块：xueness/skills.py":
empty/missing directories, header + name/description/body rendering, stable
id ordering, ``enabled: false`` filtering, broken-JSON isolation, total and
per-body budgets, symlink refusal at both entry and directory level, and the
read-only guarantee (file tree snapshot identical before/after, and a symlink
target outside the state dir never read).
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.skills import (DEFAULT_BODY_BUDGET, SKILLS_HEADER,
                            TOTAL_MAX_CHARS, load)


class SkillsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "state"
        self.skills_dir = self.state_dir / "resources" / "skills"
        self.skills_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_skill(self, filename: str, payload) -> Path:
        path = self.skills_dir / filename
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def snapshot(self) -> dict:
        """path -> (mtime_ns, size) for the whole state dir, symlinks included."""
        out = {}
        for base, dirs, files in os.walk(self.state_dir, followlinks=False):
            for name in list(dirs) + list(files):
                path = Path(base) / name
                try:
                    stat = path.lstat()
                except OSError:
                    continue
                out[str(path)] = (stat.st_mtime_ns, stat.st_size)
        return out

    # --- no content ---------------------------------------------------------

    def test_missing_directory_returns_empty(self):
        import shutil
        shutil.rmtree(self.skills_dir)
        self.assertEqual(load(self.state_dir), "")

    def test_empty_directory_returns_empty(self):
        self.assertEqual(load(self.state_dir), "")

    # --- happy path ---------------------------------------------------------

    def test_single_skill_rendered_with_header_name_description_body(self):
        self.write_skill("a.json", {
            "id": "a", "name": "Release checklist",
            "description": "How we ship", "body": "line one\nline two",
        })
        out = load(self.state_dir)
        self.assertTrue(out.startswith(SKILLS_HEADER))
        self.assertIn("### Release checklist", out)
        self.assertIn("How we ship", out)
        self.assertIn("line one\nline two", out)  # inner newlines preserved

    def test_id_and_name_only(self):
        self.write_skill("a.json", {"id": "a", "name": "Bare"})
        out = load(self.state_dir)
        self.assertIn("### Bare", out)
        self.assertNotIn("None", out)

    # --- filtering ----------------------------------------------------------

    def test_disabled_skill_is_skipped(self):
        self.write_skill("on.json", {"id": "on", "name": "On"})
        self.write_skill("off.json", {"id": "off", "name": "Off", "enabled": False, "body": "SECRET-BODY"})
        out = load(self.state_dir)
        self.assertIn("### On", out)
        self.assertNotIn("Off", out)
        self.assertNotIn("SECRET-BODY", out)

    def test_missing_enabled_counts_as_enabled(self):
        self.write_skill("a.json", {"id": "a", "name": "Implicit"})
        self.assertIn("### Implicit", load(self.state_dir))
        self.write_skill("b.json", {"id": "b", "name": "Truthy", "enabled": True})
        self.assertIn("### Truthy", load(self.state_dir))

    def test_invalid_id_or_name_entries_are_skipped(self):
        self.write_skill("a.json", {"name": "No id"})
        self.write_skill("b.json", {"id": "b"})
        self.write_skill("c.json", {"id": 7, "name": "Numeric id"})
        self.write_skill("d.json", {"id": "d", "name": []})
        self.write_skill("e.json", {"id": "  ", "name": "Blank id"})
        self.write_skill("f.json", {"id": "f", "name": "  "})
        self.write_skill("ok.json", {"id": "ok", "name": "Kept"})
        out = load(self.state_dir)
        self.assertIn("### Kept", out)
        for gone in ("No id", "Numeric id", "Blank id"):
            self.assertNotIn(gone, out)

    # --- ordering -----------------------------------------------------------

    def test_skills_sorted_by_id_ascending(self):
        self.write_skill("z.json", {"id": "zeta", "name": "Zeta"})
        self.write_skill("a.json", {"id": "alpha", "name": "Alpha"})
        self.write_skill("m.json", {"id": "mid", "name": "Mid"})
        out = load(self.state_dir)
        self.assertLess(out.index("### Alpha"), out.index("### Mid"))
        self.assertLess(out.index("### Mid"), out.index("### Zeta"))

    def test_ordering_is_stable_across_calls(self):
        for sid, name in (("b", "Bee"), ("a", "Ay"), ("c", "Cee")):
            self.write_skill(sid + ".json", {"id": sid, "name": name})
        self.assertEqual(load(self.state_dir), load(self.state_dir))

    # --- damage isolation ---------------------------------------------------

    def test_invalid_json_file_is_skipped_without_affecting_others(self):
        self.write_skill("broken.json", "{ this is not json ")
        self.write_skill("arr.json", "[1, 2, 3]")
        self.write_skill("good.json", {"id": "good", "name": "Survivor", "body": "kept body"})
        out = load(self.state_dir)
        self.assertIn("### Survivor", out)
        self.assertIn("kept body", out)

    # --- budgets ------------------------------------------------------------

    def test_total_budget_truncates(self):
        for i in range(30):
            self.write_skill(f"s{i:02d}.json", {
                "id": f"s{i:02d}", "name": f"Skill {i:02d}", "body": "x" * 400,
            })
        out = load(self.state_dir)
        self.assertLessEqual(len(out), TOTAL_MAX_CHARS)
        self.assertIn("…(truncated)", out)

    def test_total_budget_honours_custom_cap(self):
        for i in range(5):
            self.write_skill(f"s{i}.json", {"id": f"s{i}", "name": f"Skill {i}", "body": "y" * 300})
        out = load(self.state_dir, total_max_chars=120)
        self.assertLessEqual(len(out), 120)

    def test_body_budget_truncates_single_skill(self):
        self.write_skill("big.json", {"id": "big", "name": "Big", "body": "z" * 5000})
        out = load(self.state_dir)
        self.assertIn("…(truncated)", out)
        self.assertNotIn("z" * (DEFAULT_BODY_BUDGET + 1), out)
        # header, blank line, "### Big" then the (clipped) body
        rendered_body = out.split("### Big\n", 1)[1]
        self.assertLessEqual(len(rendered_body), DEFAULT_BODY_BUDGET)
        self.assertLessEqual(len(out), TOTAL_MAX_CHARS)

    def test_no_truncation_marker_when_under_budget(self):
        self.write_skill("a.json", {"id": "a", "name": "Small", "body": "short"})
        self.assertNotIn("…(truncated)", load(self.state_dir))

    # --- symlinks -----------------------------------------------------------

    def test_symlinked_entry_is_skipped(self):
        secret = self.root / "outside-secret.txt"
        secret.write_text(json.dumps({"id": "evil", "name": "Evil",
                                      "body": "SECRET-OUTSIDE"}), encoding="utf-8")
        make_symlink(self.skills_dir / "evil.json", secret)
        self.write_skill("ok.json", {"id": "ok", "name": "Legit"})
        out = load(self.state_dir)
        self.assertIn("### Legit", out)
        self.assertNotIn("Evil", out)
        self.assertNotIn("SECRET-OUTSIDE", out)
        self.assertFalse(secret.read_text(encoding="utf-8") == "")  # sanity

    def test_symlinked_directory_returns_empty(self):
        outside = self.root / "outside-skills"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps({"id": "a", "name": "Outside", "body": "SECRET-DIR"}), encoding="utf-8")
        import shutil
        shutil.rmtree(self.skills_dir)
        make_directory_boundary_link(self.skills_dir, outside)
        out = load(self.state_dir)
        self.assertEqual(out, "")
        self.assertNotIn("SECRET-DIR", out)

    def test_secret_file_content_never_read(self):
        secret = self.root / "creds.json"
        secret.write_text(json.dumps({"id": "s", "name": "Leak", "body": "TOKEN-ABC-123"}),
                          encoding="utf-8")
        make_symlink(self.skills_dir / "leak.json", secret)
        out = load(self.state_dir)
        self.assertEqual(out, "")
        self.assertNotIn("TOKEN-ABC-123", out)

    # --- read-only guarantee ------------------------------------------------

    def test_load_never_writes_to_state_dir(self):
        self.write_skill("a.json", {"id": "a", "name": "Alpha", "body": "b" * 2000})
        self.write_skill("bad.json", "{ not json")
        secret = self.root / "secret.json"
        secret.write_text(json.dumps({"id": "x", "name": "X", "body": "SECRET-VALUE"}), encoding="utf-8")
        make_symlink(self.skills_dir / "link.json", secret)

        before = self.snapshot()
        out = load(self.state_dir)
        load(self.state_dir, total_max_chars=50, budgets={"body": 10})
        after = self.snapshot()

        self.assertEqual(before, after)
        self.assertIn("### Alpha", out)
        self.assertNotIn("SECRET-VALUE", out)
        self.assertEqual(secret.read_text(encoding="utf-8"),
                         json.dumps({"id": "x", "name": "X", "body": "SECRET-VALUE"}))

    # --- shape --------------------------------------------------------------

    def test_no_header_only_shell(self):
        self.write_skill("off.json", {"id": "off", "name": "Off", "enabled": False})
        self.assertEqual(load(self.state_dir), "")


if __name__ == "__main__":
    unittest.main()
