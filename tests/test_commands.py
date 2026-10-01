"""Stage 5 slash-command tests.

Covers the contract in docs/stage5-contract.md, section "一、命令":

* passthrough for anything that is not a single legal ``/name`` invocation,
* happy-path expansion, ``$ARGUMENTS`` substitution, argument appending,
* unknown / disabled / malformed commands passing the turn through unchanged,
* clipping to ``EXPAND_MAX_CHARS`` with a truncation marker,
* symlink refusal at entry and directory level,
* illegal id filtering and stable id ordering in ``load``,
* and the read-only guarantee (whole-tree snapshot identical before/after,
  plus ``expand`` touching nothing at all).
"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from xueness.commands import (ARGUMENTS_PLACEHOLDER, EXPAND_MAX_CHARS,
                              TRUNCATION_SUFFIX, expand, load)


class CommandsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "state"
        self.commands_dir = self.state_dir / "resources" / "commands"
        self.commands_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_command(self, filename: str, payload) -> Path:
        path = self.commands_dir / filename
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

    # --- load: no content ---------------------------------------------------

    def test_missing_directory_returns_empty_list(self):
        shutil.rmtree(self.commands_dir)
        self.assertEqual(load(self.state_dir), [])

    def test_empty_directory_returns_empty_list(self):
        self.assertEqual(load(self.state_dir), [])

    def test_directory_is_symlink_returns_empty_list(self):
        outside = self.root / "outside-commands"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps({"id": "a", "prompt": "SECRET-DIR"}), encoding="utf-8")
        shutil.rmtree(self.commands_dir)
        self.commands_dir.symlink_to(outside, target_is_directory=True)
        self.assertEqual(load(self.state_dir), [])

    # --- load: happy path ---------------------------------------------------

    def test_loads_single_command(self):
        self.write_command("a.json", {"id": "demo", "prompt": "Say hi"})
        items = load(self.state_dir)
        self.assertEqual([c["id"] for c in items], ["demo"])
        self.assertEqual(items[0]["prompt"], "Say hi")

    def test_content_used_when_prompt_absent(self):
        self.write_command("a.json", {"id": "demo", "content": "From content"})
        self.assertEqual([c["id"] for c in load(self.state_dir)], ["demo"])

    def test_prompt_wins_over_content(self):
        self.write_command("a.json", {"id": "demo", "prompt": "P", "content": "C"})
        _, meta = expand(load(self.state_dir), "/demo")
        self.assertEqual(meta, {"command": "demo", "args": ""})

    def test_sorted_by_id_ascending(self):
        self.write_command("z.json", {"id": "zeta", "prompt": "z"})
        self.write_command("a.json", {"id": "alpha", "prompt": "a"})
        self.write_command("m.json", {"id": "mid", "prompt": "m"})
        self.assertEqual([c["id"] for c in load(self.state_dir)],
                         ["alpha", "mid", "zeta"])

    def test_ordering_stable_across_calls(self):
        for cid in ("b", "a", "c"):
            self.write_command(cid + ".json", {"id": cid, "prompt": cid})
        self.assertEqual([c["id"] for c in load(self.state_dir)],
                         [c["id"] for c in load(self.state_dir)])

    # --- load: filtering ----------------------------------------------------

    def test_disabled_command_is_skipped(self):
        self.write_command("on.json", {"id": "on", "prompt": "ON-BODY"})
        self.write_command("off.json", {"id": "off", "prompt": "OFF-BODY",
                                        "enabled": False})
        items = load(self.state_dir)
        self.assertEqual([c["id"] for c in items], ["on"])

    def test_missing_enabled_counts_as_enabled(self):
        self.write_command("a.json", {"id": "a", "prompt": "A"})
        self.write_command("b.json", {"id": "b", "prompt": "B", "enabled": True})
        self.assertEqual([c["id"] for c in load(self.state_dir)], ["a", "b"])

    def test_illegal_ids_are_skipped(self):
        bad = [
            {"prompt": "no id"},
            {"id": "", "prompt": "blank id"},
            {"id": "   ", "prompt": "spaces id"},
            {"id": 7, "prompt": "numeric id"},
            {"id": ["a"], "prompt": "list id"},
            {"id": ".", "prompt": "dot"},
            {"id": "..", "prompt": "dotdot"},
            {"id": "has space", "prompt": "space"},
            {"id": "a/b", "prompt": "slash"},
            {"id": "x" * 65, "prompt": "too long"},
            {"id": "semi;colon", "prompt": "semi"},
        ]
        for i, payload in enumerate(bad):
            self.write_command(f"bad{i}.json", payload)
        self.write_command("ok.json", {"id": "ok", "prompt": "Kept"})
        self.assertEqual([c["id"] for c in load(self.state_dir)], ["ok"])

    def test_entries_without_body_are_skipped(self):
        self.write_command("a.json", {"id": "a"})
        self.write_command("b.json", {"id": "b", "prompt": ""})
        self.write_command("c.json", {"id": "c", "content": "   "})
        self.write_command("d.json", {"id": "d", "prompt": None, "content": 5})
        self.write_command("e.json", {"id": "e", "prompt": [], "content": {}})
        self.write_command("ok.json", {"id": "ok", "content": "Kept"})
        self.assertEqual([c["id"] for c in load(self.state_dir)], ["ok"])

    def test_broken_json_and_non_object_are_isolated(self):
        self.write_command("broken.json", "{ this is not json ")
        self.write_command("arr.json", "[1, 2, 3]")
        self.write_command("good.json", {"id": "good", "prompt": "Survivor"})
        self.assertEqual([c["id"] for c in load(self.state_dir)], ["good"])

    # --- load: symlinks -----------------------------------------------------

    def test_symlinked_entry_is_skipped(self):
        secret = self.root / "outside-secret.json"
        secret.write_text(json.dumps({"id": "evil", "prompt": "SECRET-OUTSIDE"}),
                          encoding="utf-8")
        (self.commands_dir / "evil.json").symlink_to(secret)
        self.write_command("ok.json", {"id": "ok", "prompt": "Legit"})
        items = load(self.state_dir)
        self.assertEqual([c["id"] for c in items], ["ok"])
        self.assertNotIn("SECRET-OUTSIDE", json.dumps(items))

    def test_secret_file_content_never_read(self):
        secret = self.root / "creds.json"
        secret.write_text(json.dumps({"id": "s", "prompt": "TOKEN-ABC-123"}),
                          encoding="utf-8")
        (self.commands_dir / "leak.json").symlink_to(secret)
        items = load(self.state_dir)
        self.assertEqual(items, [])
        self.assertNotIn("TOKEN-ABC-123", json.dumps(items))

    # --- expand: passthrough ------------------------------------------------

    def test_text_without_slash_is_returned_unchanged(self):
        self.write_command("a.json", {"id": "demo", "prompt": "BODY"})
        commands = load(self.state_dir)
        for text in ("hello world", "no slash at all", "", "  /demo", "/demo" + "x" * 65):
            self.assertEqual(expand(commands, text), (text, None))

    def test_double_slash_is_returned_unchanged(self):
        self.write_command("a.json", {"id": "demo", "prompt": "BODY"})
        commands = load(self.state_dir)
        self.assertEqual(expand(commands, "//demo hi"), ("//demo hi", None))
        self.assertEqual(expand(commands, "/d/emo hi"), ("/d/emo hi", None))

    def test_unknown_command_is_returned_unchanged(self):
        self.write_command("a.json", {"id": "demo", "prompt": "BODY"})
        commands = load(self.state_dir)
        text = "/nope some args"
        self.assertEqual(expand(commands, text), (text, None))

    def test_disabled_command_is_returned_unchanged(self):
        self.write_command("off.json", {"id": "off", "prompt": "OFF-BODY",
                                        "enabled": False})
        commands = load(self.state_dir)
        text = "/off now"
        self.assertEqual(expand(commands, text), (text, None))
        self.assertNotIn("OFF-BODY", expand(commands, text)[0])

    def test_disabled_command_passed_in_directly_is_not_expanded(self):
        text = "/off now"
        self.assertEqual(expand([{"id": "off", "prompt": "OFF-BODY",
                                  "enabled": False}], text), (text, None))

    def test_empty_command_list_passes_through(self):
        self.assertEqual(expand([], "/demo hi"), ("/demo hi", None))

    # --- expand: happy path -------------------------------------------------

    def test_hit_expands_to_body(self):
        self.write_command("a.json", {"id": "demo", "prompt": "Do the thing."})
        expanded, meta = expand(load(self.state_dir), "/demo")
        self.assertEqual(expanded, "Do the thing.")
        self.assertEqual(meta, {"command": "demo", "args": ""})

    def test_prompt_preferred_over_content(self):
        self.write_command("a.json", {"id": "demo", "prompt": "PROMPT-BODY",
                                      "content": "CONTENT-BODY"})
        expanded, meta = expand(load(self.state_dir), "/demo")
        self.assertEqual(expanded, "PROMPT-BODY")
        self.assertNotIn("CONTENT-BODY", expanded)
        self.assertEqual(meta, {"command": "demo", "args": ""})

    def test_content_used_when_prompt_missing(self):
        self.write_command("a.json", {"id": "demo", "content": "CONTENT-BODY"})
        expanded, meta = expand(load(self.state_dir), "/demo")
        self.assertEqual(expanded, "CONTENT-BODY")
        self.assertEqual(meta, {"command": "demo", "args": ""})

    def test_arguments_placeholder_is_substituted(self):
        self.write_command("t.json", {"id": "t", "prompt": "Translate $ARGUMENTS now."})
        expanded, meta = expand(load(self.state_dir), "/t hello world")
        self.assertEqual(expanded, "Translate hello world now.")
        self.assertEqual(meta, {"command": "t", "args": "hello world"})

    def test_arguments_placeholder_missing_args_becomes_empty_string(self):
        self.write_command("t.json", {"id": "t", "prompt": "Translate $ARGUMENTS now."})
        expanded, meta = expand(load(self.state_dir), "/t")
        self.assertEqual(expanded, "Translate  now.")
        self.assertNotIn(ARGUMENTS_PLACEHOLDER, expanded)
        self.assertEqual(meta, {"command": "t", "args": ""})

    def test_arguments_placeholder_replaced_everywhere(self):
        self.write_command("t.json", {"id": "t", "prompt": "$ARGUMENTS and $ARGUMENTS"})
        expanded, _ = expand(load(self.state_dir), "/t x")
        self.assertEqual(expanded, "x and x")

    def test_args_are_appended_when_no_placeholder(self):
        self.write_command("c.json", {"id": "c", "prompt": "Body text."})
        expanded, meta = expand(load(self.state_dir), "/c hello world")
        self.assertEqual(expanded, "Body text.\n\nhello world")
        self.assertEqual(meta, {"command": "c", "args": "hello world"})

    def test_no_args_and_no_placeholder_leaves_body_alone(self):
        self.write_command("c.json", {"id": "c", "prompt": "Body text."})
        expanded, meta = expand(load(self.state_dir), "/c")
        self.assertEqual(expanded, "Body text.")
        self.assertEqual(meta, {"command": "c", "args": ""})

    def test_multiline_args_are_preserved(self):
        self.write_command("c.json", {"id": "c", "prompt": "Body."})
        expanded, meta = expand(load(self.state_dir), "/c line one\nline two")
        self.assertEqual(expanded, "Body.\n\nline one\nline two")
        self.assertEqual(meta, {"command": "c", "args": "line one\nline two"})

    def test_body_with_inner_newlines_is_preserved(self):
        self.write_command("c.json", {"id": "c", "prompt": "one\ntwo\nthree"})
        expanded, _ = expand(load(self.state_dir), "/c")
        self.assertEqual(expanded, "one\ntwo\nthree")

    # --- expand: clipping ---------------------------------------------------

    def test_over_long_body_is_truncated(self):
        self.write_command("big.json", {"id": "big", "prompt": "x" * (EXPAND_MAX_CHARS * 3)})
        expanded, meta = expand(load(self.state_dir), "/big")
        self.assertLessEqual(len(expanded), EXPAND_MAX_CHARS)
        self.assertIn("…(truncated)", expanded)
        self.assertEqual(meta, {"command": "big", "args": ""})

    def test_over_long_body_with_args_is_still_truncated(self):
        self.write_command("big.json", {"id": "big", "prompt": "y" * (EXPAND_MAX_CHARS * 2)})
        expanded, meta = expand(load(self.state_dir), "/big " + "z" * 5000)
        self.assertLessEqual(len(expanded), EXPAND_MAX_CHARS)
        self.assertIn("…(truncated)", expanded)
        self.assertEqual(meta["command"], "big")
        self.assertEqual(len(meta["args"]), 5000)

    def test_under_budget_body_has_no_truncation_marker(self):
        self.write_command("a.json", {"id": "a", "prompt": "short"})
        expanded, _ = expand(load(self.state_dir), "/a")
        self.assertNotIn(TRUNCATION_SUFFIX, expanded)

    def test_expand_max_chars_constant(self):
        self.assertEqual(EXPAND_MAX_CHARS, 8000)
        self.assertTrue(TRUNCATION_SUFFIX)

    # --- read-only guarantee ------------------------------------------------

    def test_load_and_expand_never_write_to_state_dir(self):
        self.write_command("a.json", {"id": "a", "prompt": "b" * 20000})
        self.write_command("bad.json", "{ not json")
        self.write_command("off.json", {"id": "off", "prompt": "OFF", "enabled": False})
        secret = self.root / "secret.json"
        secret.write_text(json.dumps({"id": "x", "prompt": "SECRET-VALUE"}),
                          encoding="utf-8")
        (self.commands_dir / "link.json").symlink_to(secret)

        before = self.snapshot()
        commands = load(self.state_dir)
        expand(commands, "/a hello")
        expand(commands, "/off")
        expand(commands, "/unknown")
        expand(commands, "plain text")
        after = self.snapshot()

        self.assertEqual(before, after)
        self.assertEqual([c["id"] for c in commands], ["a"])
        self.assertNotIn("SECRET-VALUE", json.dumps(commands))
        self.assertEqual(secret.read_text(encoding="utf-8"),
                         json.dumps({"id": "x", "prompt": "SECRET-VALUE"}))

    def test_expand_does_not_touch_files_at_all(self):
        self.write_command("a.json", {"id": "a", "prompt": "BODY"})
        before = self.snapshot()
        commands = load(self.state_dir)
        for _ in range(5):
            expand(commands, "/a some args")
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
