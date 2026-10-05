"""Directory-shaped skills: discovery, shadowing, jail, CLI, ``/skills``, HTTP.

Everything runs against temporary state directories and workspaces. Nothing
here touches a network or a model. The promises covered:

* frontmatter is parsed as plain text, and an unusable entry becomes a
  structured diagnostic instead of an exception or a silent disappearance;
* project skills shadow user skills, which shadow the JSON resource store, and
  the loser is still listed as ``shadowed``;
* a link — of a skill directory, of ``SKILL.md``, or of a whole skill root —
  is refused and its target is never read;
* the catalog summary and ``skill_read`` see file skills under the same budgets
  as before, so a new source cannot widen what one run may read;
* ``skills list|inspect``, chat ``/skills`` and the HTTP listing all stop when
  the owning plugin is disabled.
"""
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.bundled_plugins.skills import file_skills, skills
from xueness.bundled_plugins.skills.plugin import SkillsPlugin
from xueness.cli import main as cli_main
from xueness import plugin_runtime
from xueness.memory import UNTRUSTED_PREAMBLE


def skill_text(name="demo", description="What this skill does", body="Read me first.",
               tags=None):
    lines = ["---", "name: %s" % name, "description: %s" % description]
    if tags is not None:
        lines.append("tags: %s" % tags)
    lines += ["---", "", body]
    return "\n".join(lines) + "\n"


def _cli(state, argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main(["--state", str(state), *argv])
    except SystemExit as exc:
        code = exc.code
    return code, stdout.getvalue(), stderr.getvalue()


class SkillFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.ws = self.base / "ws"
        self.state.mkdir()
        self.ws.mkdir()

    # -- helpers ------------------------------------------------------------

    def project_skill(self, directory, name, **fields) -> Path:
        return self._write(self.ws / ".xueness" / "skills" / directory, name, **fields)

    def compat_skill(self, directory, name, **fields) -> Path:
        return self._write(self.ws / ".zcode" / "skills" / directory, name, **fields)

    def user_skill(self, directory, name, **fields) -> Path:
        return self._write(self.state / "skills" / directory, name, **fields)

    def _write(self, directory, name, text=None, **fields) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "SKILL.md"
        path.write_text(text if text is not None else skill_text(name=name, **fields),
                        encoding="utf-8")
        return path

    def resource_skill(self, rid, name, **fields) -> Path:
        directory = self.state / "resources" / "skills"
        directory.mkdir(parents=True, exist_ok=True)
        item = {"id": rid, "name": name}
        item.update(fields)
        path = directory / ("%s.json" % rid)
        path.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
        return path

    def names(self, rows) -> list:
        return [row["name"] for row in rows]

    def codes(self, diagnostics) -> list:
        return [item["code"] for item in diagnostics]


# -- frontmatter --------------------------------------------------------------

class FrontmatterTests(SkillFixture):
    def test_plain_key_value_block_parses(self):
        values, keys, error = file_skills.parse_frontmatter(skill_text(tags="review, shipping"))
        self.assertIsNone(error)
        self.assertEqual(values["name"], "demo")
        self.assertEqual(values["description"], "What this skill does")
        self.assertEqual(values["tags"], "review, shipping")
        self.assertEqual(keys, ["name", "description", "tags"])

    def test_quoted_values_and_crlf_are_normalised(self):
        text = '---\r\nname: "quoted-skill"\r\ndescription: \'It handles: everything\'\r\n---\r\nbody\r\n'
        values, _keys, error = file_skills.parse_frontmatter(text)
        self.assertIsNone(error)
        self.assertEqual(values["name"], "quoted-skill")
        self.assertEqual(values["description"], "It handles: everything")

    def test_folded_block_scalar_joins_indented_lines(self):
        text = "---\nname: folded\ndescription: >\n  first line\n  second line\n---\nbody\n"
        values, _keys, error = file_skills.parse_frontmatter(text)
        self.assertIsNone(error)
        self.assertEqual(values["description"], "first line second line")

    def test_literal_block_scalar_keeps_lines(self):
        text = "---\nname: literal\ndescription: |\n  step one\n  step two\n---\nbody\n"
        values, _keys, _error = file_skills.parse_frontmatter(text)
        self.assertEqual(values["description"], "step one\nstep two")

    def test_missing_frontmatter_is_reported(self):
        self.project_skill("bare", "bare", text="# Just prose\n\nNo fence here.\n")
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(outcome["skills"], [])
        self.assertEqual(self.codes(outcome["diagnostics"]), ["skill_missing_frontmatter"])

    def test_unclosed_frontmatter_is_reported(self):
        self.project_skill("open", "open", text="---\nname: open\ndescription: no end\n")
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(self.codes(outcome["diagnostics"]), ["skill_unclosed_frontmatter"])

    def test_corrupt_lines_do_not_hide_the_whole_block(self):
        self.project_skill("odd", "odd",
                           text="---\nnot a pair at all\nname: odd\ndescription: usable\n---\nx\n")
        rows = file_skills.discover(self.state, self.ws)["skills"]
        self.assertEqual(self.names(rows), ["odd"])

    def test_comment_and_indented_lines_are_skipped(self):
        self.project_skill("notes", "notes",
                           text="---\n# a comment\nname: notes\ndescription: fine\n  stray: nested\n---\nx\n")
        rows = file_skills.discover(self.state, self.ws)["skills"]
        self.assertEqual(self.names(rows), ["notes"])
        self.assertEqual(rows[0]["frontmatterKeys"], ["name", "description"])

    def test_tags_accept_both_common_writings(self):
        self.project_skill("tagged", "tagged", tags="review, shipping")
        row = file_skills.discover(self.state, self.ws)["skills"][0]
        self.assertEqual(row["tags"], ["review", "shipping"])
        self.project_skill("bracketed", "bracketed", tags="[a, b, a, ]")
        rows = file_skills.discover(self.state, self.ws)["skills"]
        self.assertEqual([item["tags"] for item in rows if item["name"] == "bracketed"], [["a", "b"]])

    def test_tag_list_is_capped(self):
        self.project_skill("many", "many", tags=", ".join("t%d" % i for i in range(40)))
        self.assertEqual(len(file_skills.discover(self.state, self.ws)["skills"][0]["tags"]),
                         file_skills.MAX_TAGS)


class ValidationTests(SkillFixture):
    def assert_dropped(self, text, expected_code):
        self.project_skill("case", "case", text=text)
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(outcome["skills"], [])
        self.assertEqual(self.codes(outcome["diagnostics"]), [expected_code])

    def test_name_is_required(self):
        self.assert_dropped("---\ndescription: no name\n---\nx\n", "skill_missing_name")

    def test_description_is_required(self):
        self.assert_dropped("---\nname: skill-a\n---\nx\n", "skill_missing_description")

    def test_uppercase_name_is_refused(self):
        self.assert_dropped("---\nname: Release-Notes\ndescription: d\n---\nx\n",
                            "skill_invalid_name")

    def test_underscore_name_is_refused(self):
        self.assert_dropped("---\nname: release_notes\ndescription: d\n---\nx\n",
                            "skill_invalid_name")

    def test_name_longer_than_sixty_four_is_refused(self):
        self.assert_dropped("---\nname: %s\ndescription: d\n---\nx\n" % ("n" * 65),
                            "skill_invalid_name")

    def test_name_at_the_limit_is_accepted(self):
        self.project_skill("edge", "edge", text="---\nname: %s\ndescription: d\n---\nx\n" % ("n" * 64))
        self.assertEqual(self.names(file_skills.discover(self.state, self.ws)["skills"]),
                         ["n" * 64])

    def test_description_over_the_limit_is_refused(self):
        self.assert_dropped("---\nname: skill-a\ndescription: %s\n---\nx\n"
                            % ("d" * (file_skills.DESCRIPTION_MAX_CHARS + 1)),
                            "skill_description_too_long")

    def test_oversized_file_is_refused_without_being_parsed(self):
        path = self.project_skill("huge", "huge", text="---\nname: huge\ndescription: d\n---\n")
        path.write_bytes(path.read_bytes() + b"x" * file_skills.MAX_SKILL_FILE_BYTES)
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(outcome["skills"], [])
        self.assertEqual(self.codes(outcome["diagnostics"]), ["skill_file_too_large"])

    def test_non_utf8_file_is_refused(self):
        path = self.project_skill("binary", "binary")
        path.write_bytes(b"\xff\xfe\x00garbage")
        self.assertEqual(self.codes(file_skills.discover(self.state, self.ws)["diagnostics"]),
                         ["skill_invalid_encoding"])

    def test_root_limit_stops_scanning_and_reports(self):
        for index in range(4):
            self.project_skill("s%d" % index, "skill-%d" % index)
        outcome = file_skills.discover(self.state, self.ws, limit=2)
        self.assertEqual(self.names(outcome["skills"]), ["skill-0", "skill-1"])
        self.assertIn("skill_root_limit", self.codes(outcome["diagnostics"]))

    def test_one_broken_entry_does_not_affect_its_neighbours(self):
        self.project_skill("bad", "bad", text="---\nname: Bad Name\ndescription: d\n---\nx\n")
        self.project_skill("good", "good")
        self.assertEqual(self.names(file_skills.discover(self.state, self.ws)["skills"]), ["good"])


# -- sources, shadowing, attachments -----------------------------------------

class SourceTests(SkillFixture):
    def test_project_shadows_user_and_resource(self):
        self.user_skill("alpha", "alpha", description="user level")
        self.project_skill("alpha", "alpha", description="project level")
        self.resource_skill("alpha-res", "alpha", description="resource level")
        rows = skills.list_all(self.state, self.ws)["skills"]
        by_source = {row["source"]: row for row in rows}
        self.assertEqual(set(by_source), {"project", "user", "resource"})
        self.assertFalse(by_source["project"]["shadowed"])
        self.assertTrue(by_source["user"]["shadowed"])
        self.assertEqual(by_source["user"]["shadowedBy"], "project")
        self.assertTrue(by_source["resource"]["shadowed"])
        self.assertEqual(by_source["resource"]["shadowedBy"], "project")

    def test_user_shadows_resource_without_a_workspace(self):
        self.user_skill("solo", "solo")
        self.resource_skill("solo-res", "solo")
        rows = skills.list_all(self.state)["skills"]
        self.assertEqual([(row["source"], row["shadowed"]) for row in rows],
                         [("user", False), ("resource", True)])
        self.assertEqual(rows[1]["shadowedBy"], "user")

    def test_legacy_zcode_root_is_compat_only_and_switchable(self):
        self.compat_skill("legacy", "legacy", description="from .zcode")
        rows = skills.list_all(self.state, self.ws)["skills"]
        self.assertEqual(self.names(rows), ["legacy"])
        self.assertEqual(rows[0]["source"], "project-compat")
        self.assertEqual(rows[0]["scope"], "project")
        self.assertEqual(skills.list_all(self.state, self.ws, include_compat=False)["skills"], [])

    def test_compat_root_never_beats_the_xueness_project_root(self):
        self.compat_skill("shared", "shared", description="compat")
        self.project_skill("shared", "shared", description="project")
        rows = skills.list_all(self.state, self.ws)["skills"]
        self.assertEqual([(row["source"], row["shadowedBy"]) for row in rows],
                         [("project", None), ("project-compat", "project")])

    def test_attachments_are_named_and_sized_but_never_read(self):
        directory = self.project_skill("with-files", "with-files").parent
        (directory / "examples.md").write_text("TOKEN-ATTACHMENT-BODY\n", encoding="utf-8")
        (directory / "scripts").mkdir()
        (directory / "scripts" / "run.py").write_text("print('TOKEN-RUNNER')\n", encoding="utf-8")
        rows = file_skills.discover(self.state, self.ws)["skills"]
        attachments = rows[0]["attachments"]
        self.assertEqual([item["name"] for item in attachments], ["examples.md"])
        self.assertGreater(attachments[0]["bytes"], 0)
        self.assertNotIn("TOKEN", json.dumps(rows, ensure_ascii=False))
        self.assertFalse(rows[0]["attachmentsTruncated"])

    def test_attachment_names_are_capped(self):
        directory = self.project_skill("many-files", "many-files").parent
        for index in range(file_skills.MAX_ATTACHMENTS_PER_SKILL + 3):
            (directory / ("note-%02d.md" % index)).write_text("x", encoding="utf-8")
        row = file_skills.discover(self.state, self.ws)["skills"][0]
        self.assertEqual(len(row["attachments"]), file_skills.MAX_ATTACHMENTS_PER_SKILL)
        self.assertTrue(row["attachmentsTruncated"])

    def test_hidden_directories_are_not_skills(self):
        self._write(self.ws / ".xueness" / "skills" / ".git", "hidden")
        self.assertEqual(file_skills.discover(self.state, self.ws)["skills"], [])


class JailTests(SkillFixture):
    def test_symlinked_skill_directory_is_refused(self):
        outside = self.base / "outside"
        (outside / "evil").mkdir(parents=True)
        (outside / "evil" / "SKILL.md").write_text(skill_text(name="evil",
                                                             description="TOKEN-DIR"),
                                                   encoding="utf-8")
        root = self.ws / ".xueness" / "skills"
        root.mkdir(parents=True)
        make_symlink(root / "evil", outside / "evil", target_is_directory=True)
        self.project_skill("kept", "kept")
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(self.names(outcome["skills"]), ["kept"])
        self.assertIn("skill_directory_symlink", self.codes(outcome["diagnostics"]))
        self.assertNotIn("TOKEN-DIR", json.dumps(outcome, ensure_ascii=False))

    def test_symlinked_skill_file_is_refused(self):
        secret = self.base / "credentials.md"
        secret.write_text(skill_text(name="leak", description="TOKEN-FILE"), encoding="utf-8")
        directory = self.project_skill("linking", "linking").parent
        (directory / "SKILL.md").unlink()
        make_symlink(directory / "SKILL.md", secret)
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(outcome["skills"], [])
        self.assertIn("skill_file_symlink", self.codes(outcome["diagnostics"]))
        self.assertNotIn("TOKEN-FILE", json.dumps(outcome, ensure_ascii=False))

    def test_skill_root_redirected_out_of_the_workspace_is_refused(self):
        elsewhere = self.base / "elsewhere" / "skills"
        elsewhere.mkdir(parents=True)
        (elsewhere / "away").mkdir()
        (elsewhere / "away" / "SKILL.md").write_text(
            skill_text(name="away", description="TOKEN-ROOT"), encoding="utf-8")
        self.ws.mkdir(exist_ok=True)
        make_directory_boundary_link(self.ws / ".xueness", elsewhere.parent)
        outcome = file_skills.discover(self.state, self.ws)
        project = [row for row in outcome["skills"] if row["scope"] == "project"]
        self.assertEqual(project, [])
        self.assertIn("skill_root_escapes", self.codes(outcome["diagnostics"]))
        self.assertNotIn("TOKEN-ROOT", json.dumps(outcome, ensure_ascii=False))

    def test_symlinked_user_skill_root_is_refused(self):
        outside = self.base / "user-skills"
        (outside / "u").mkdir(parents=True)
        (outside / "u" / "SKILL.md").write_text(skill_text(name="u", description="TOKEN-USER"),
                                                encoding="utf-8")
        make_directory_boundary_link(self.state / "skills", outside)
        outcome = file_skills.discover(self.state, self.ws)
        self.assertEqual(outcome["skills"], [])
        self.assertIn("skill_root_symlink", self.codes(outcome["diagnostics"]))
        self.assertNotIn("TOKEN-USER", json.dumps(outcome, ensure_ascii=False))

    def test_discovery_never_writes_anything(self):
        self.project_skill("a", "a")
        self.user_skill("b", "b")
        self.resource_skill("c", "c", body="x")

        def snapshot():
            entries = {}
            for base, dirs, files in os.walk(self.base, followlinks=False):
                for name in list(dirs) + list(files):
                    path = Path(base) / name
                    try:
                        info = path.lstat()
                    except OSError:
                        continue
                    entries[str(path)] = (info.st_mtime_ns, info.st_size)
            return entries

        before = snapshot()
        skills.list_all(self.state, self.ws)
        skills.catalog(self.state, self.ws)
        skills.inspect_skill(self.state, "a", self.ws)
        self.assertEqual(snapshot(), before)

    def test_body_reader_revalidates_a_stale_row(self):
        elsewhere = self.base / "planted"
        elsewhere.mkdir()
        (elsewhere / "SKILL.md").write_text(skill_text(name="stale", description="TOKEN-STALE"),
                                            encoding="utf-8")
        path = self.project_skill("stale", "stale")
        row = file_skills.discover(self.state, self.ws)["skills"][0]
        directory = path.parent
        shutil.rmtree(directory)
        make_directory_boundary_link(directory, elsewhere)
        result = file_skills.read_body(row)
        self.assertFalse(result["ok"])
        self.assertNotIn("TOKEN-STALE", json.dumps(result, ensure_ascii=False))


# -- catalog, skill_read and the run seam ------------------------------------

class InjectionTests(SkillFixture):
    def test_catalog_lists_file_skills_without_bodies(self):
        self.project_skill("review", "review", description="Ship checklist",
                           body="PRIVATE-BODY-MARKER")
        text = skills.catalog(self.state, self.ws)
        self.assertIn('"id": "file:project:review"', text)
        self.assertIn("Ship checklist", text)
        self.assertNotIn("PRIVATE-BODY-MARKER", text, "the catalog is a summary, not a body")

    def test_catalog_omits_shadowed_rows(self):
        self.project_skill("same", "same", description="winner")
        self.user_skill("same-dir", "same", description="loser")
        text = skills.catalog(self.state, self.ws)
        self.assertIn("winner", text)
        self.assertNotIn("loser", text)

    def test_catalog_stays_inside_the_existing_budget(self):
        for index in range(60):
            self.project_skill("skill-%02d" % index, "skill-%02d" % index,
                               description="d" * 400)
        text = skills.catalog(self.state, self.ws)
        self.assertLessEqual(len(text), skills.TOTAL_MAX_CHARS)
        self.assertIn("(catalog truncated)", text)

    def test_read_skill_returns_a_file_body_as_untrusted_context(self):
        self.project_skill("reader", "reader", body="Follow these steps.")
        result = skills.read_skill(self.state, "file:project:reader", self.ws)
        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "project")
        self.assertTrue(result["content"].startswith(UNTRUSTED_PREAMBLE))
        self.assertIn("Follow these steps.", result["content"])

    def test_read_skill_also_accepts_the_plain_name(self):
        self.project_skill("by-name", "by-name", body="named lookup")
        self.assertTrue(skills.read_skill(self.state, "by-name", self.ws)["ok"])

    def test_read_skill_clips_a_large_file_body(self):
        self.project_skill("big", "big", body="z" * 40000)
        result = skills.read_skill(self.state, "big", self.ws)
        self.assertTrue(result["ok"])
        self.assertLessEqual(len(result["content"]),
                             len(UNTRUSTED_PREAMBLE) + skills.READ_TOTAL_BUDGET + 1)
        self.assertIn("…(truncated)", result["content"])

    def test_read_skill_refuses_a_path_shaped_id(self):
        self.project_skill("safe", "safe")
        self.assertFalse(skills.read_skill(self.state, "../../safe", self.ws)["ok"])
        self.assertFalse(skills.read_skill(self.state, str(self.ws), self.ws)["ok"])

    def test_resource_store_behaviour_is_unchanged_without_a_root(self):
        self.resource_skill("sample", "Sample", description="d", body="resource body")
        self.user_skill("visible", "visible", description="file side")
        self.assertIn('"id": "sample"', skills.catalog(self.state))
        self.assertIn("file:user:visible", skills.catalog(self.state))
        self.assertTrue(skills.read_skill(self.state, "sample")["ok"])
        self.assertFalse(skills.read_skill(self.state, "missing")["ok"])

    def test_disabled_resource_skill_is_still_invisible(self):
        self.resource_skill("off", "Off", body="hidden", enabled=False)
        self.assertFalse(skills.read_skill(self.state, "off", self.ws)["ok"])
        self.assertNotIn("Off", skills.catalog(self.state, self.ws))

    def test_run_seam_passes_file_skills_through_catalog_and_reader(self):
        self.project_skill("seam", "seam", description="Through the plugin",
                           body="SEAM-BODY")
        kwargs = SkillsPlugin().load(self.state, self.ws, {"skill_catalog": True})
        self.assertIn("file:project:seam", kwargs["skills"])
        self.assertNotIn("SEAM-BODY", kwargs["skills"])
        read = kwargs["skill_reader"]("seam")
        self.assertTrue(read["ok"])
        self.assertIn("SEAM-BODY", read["content"])

    def test_eager_load_text_is_limited_to_the_resource_store(self):
        self.project_skill("eager", "eager", body="NOT-IN-EAGER-TEXT")
        self.resource_skill("store", "Store", body="IN-EAGER-TEXT")
        text = skills.load(self.state)
        self.assertIn("IN-EAGER-TEXT", text)
        self.assertNotIn("NOT-IN-EAGER-TEXT", text)


# -- CLI ----------------------------------------------------------------------

class CliTests(SkillFixture):
    def test_bare_skills_lists_rows(self):
        self.project_skill("alpha", "alpha", description="Project alpha")
        code, out, err = _cli(self.state, ["skills", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("Available skills (1)", out)
        self.assertIn("alpha (project)", out)
        self.assertIn("Project alpha", out)

    def test_list_reports_diagnostics_in_human_output(self):
        self.project_skill("bad", "bad", text="---\nname: Bad Name\ndescription: d\n---\nx\n")
        code, out, err = _cli(self.state, ["skills", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("No skills found.", out)
        self.assertIn("[error] skill_invalid_name", out)

    def test_bare_skills_lists_the_current_directory(self):
        self.project_skill("alpha", "alpha")
        previous = os.getcwd()
        try:
            os.chdir(self.ws)
            code, out, err = _cli(self.state, ["skills"])
        finally:
            os.chdir(previous)
        self.assertEqual(code, 0, err)
        self.assertIn("alpha (project)", out)

    def test_list_json_is_machine_readable(self):
        self.project_skill("alpha", "alpha")
        self.resource_skill("res", "Res", description="from the store")
        code, out, err = _cli(self.state, ["skills", "list", "--root", str(self.ws), "--json"])
        self.assertEqual(code, 0, err)
        document = json.loads(out)
        self.assertEqual(document["root"], str(self.ws))
        self.assertEqual(self.names(document["skills"]), ["alpha", "Res"])
        self.assertEqual({row["source"] for row in document["skills"]}, {"resource", "project"})
    def test_inspect_prints_metadata_and_body(self):
        self.project_skill("alpha", "alpha", body="Step one.\nStep two.")
        code, out, err = _cli(self.state, ["skills", "inspect", "alpha", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("id: file:project:alpha", out)
        self.assertIn("shadowed: no", out)
        self.assertIn("Step two.", out)

    def test_inspect_json_shape(self):
        self.user_skill("solo", "solo", description="user only", body="USER-BODY")
        code, out, err = _cli(self.state, ["skills", "inspect", "solo", "--json"])
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertTrue(result["ok"])
        self.assertEqual(result["skill"]["source"], "user")
        self.assertIn("USER-BODY", result["content"])
        self.assertFalse(result["truncated"])

    def test_inspect_unknown_name_exits_non_zero(self):
        code, out, err = _cli(self.state, ["skills", "inspect", "ghost", "--root", str(self.ws)])
        self.assertEqual(code, 1)
        self.assertIn("skill not found: ghost", out)

    def test_usage_error_writes_nothing_to_stdout(self):
        code, out, err = _cli(self.state, ["skills", "frobnicate"])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")

    def test_disabled_plugin_exits_non_zero_with_empty_stdout(self):
        plugin_runtime.set_enabled(self.state, "skills", False)
        code, out, err = _cli(self.state, ["skills", "list", "--root", str(self.ws)])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("skills", err)


# -- chat /skills -------------------------------------------------------------

class SlashTests(SkillFixture):
    def ctx(self):
        return {"state_dir": self.state, "root": str(self.ws), "session": {"root": str(self.ws)}}

    def test_skills_is_claimed_by_the_skills_plugin(self):
        self.assertEqual(plugin_runtime.slash_owner("skills"), "skills")
        self.assertIsNone(plugin_runtime.slash_owner("skillz"))

    def test_dispatch_lists_and_inspects(self):
        self.project_skill("alpha", "alpha", description="chat listing")
        reply = plugin_runtime.dispatch_slash("/skills", self.ctx())
        self.assertIn("alpha (project)", reply)
        self.assertIsNone(plugin_runtime.dispatch_slash("/skillz", self.ctx()))
        inspected = plugin_runtime.dispatch_slash("/skills inspect alpha", self.ctx())
        self.assertIn("id: file:project:alpha", inspected)

    def test_default_and_explicit_list_agree(self):
        self.project_skill("alpha", "alpha")
        self.assertEqual(plugin_runtime.dispatch_slash("/skills", self.ctx()),
                         plugin_runtime.dispatch_slash("/skills list", self.ctx()))

    def test_usage_answers_instead_of_an_exception(self):
        self.assertIn("Unknown skills command", plugin_runtime.dispatch_slash(
            "/skills frobnicate", self.ctx()))
        self.assertIn("no arguments", plugin_runtime.dispatch_slash("/skills list extra", self.ctx()))
        self.assertIn("needs a name", plugin_runtime.dispatch_slash("/skills inspect", self.ctx()))

    def test_disabled_plugin_refuses_the_command(self):
        self.project_skill("alpha", "alpha")
        plugin_runtime.set_enabled(self.state, "skills", False)
        reply = plugin_runtime.dispatch_slash("/skills", self.ctx())
        self.assertIn("plugin disabled", reply)
        self.assertNotIn("alpha", reply)


# -- HTTP ---------------------------------------------------------------------

class HttpTests(SkillFixture):
    parts = ["api", "resources", "skills", "files"]

    def setUp(self):
        super().setUp()
        self.runs = self.base / "runs"
        self.runs.mkdir()
        self.ctx = {"state_dir": self.state, "web_runs": self.runs,
                    "project_dir": self.ws, "workspace_roots": (self.ws,)}

    def test_the_files_route_belongs_to_the_skills_plugin(self):
        self.assertEqual(plugin_runtime.route_owner(self.parts), "skills")

    def test_listing_returns_sources_and_diagnostics(self):
        self.project_skill("alpha", "alpha")
        self.user_skill("beta", "beta", text="---\nname: Beta\ndescription: d\n---\nx\n")
        status, body = plugin_runtime.dispatch_http(
            "GET", self.parts, {"root": [str(self.ws)]}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual(self.names(body["skills"]), ["alpha"])
        self.assertIn("skill_invalid_name", self.codes(body["diagnostics"]))
        self.assertEqual(body["limits"]["skillFileBytes"], file_skills.MAX_SKILL_FILE_BYTES)

    def test_a_root_without_a_workspace_only_lists_user_and_resource(self):
        self.project_skill("alpha", "alpha")
        self.user_skill("beta", "beta")
        status, body = plugin_runtime.dispatch_http("GET", self.parts, {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertIsNone(body["root"])
        self.assertEqual(self.names(body["skills"]), ["beta"])

    def test_workspace_escape_is_refused(self):
        status, body = plugin_runtime.dispatch_http(
            "GET", self.parts, {"root": [str(self.base)]}, {}, self.ctx)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "workspace root not permitted")

    def test_write_methods_are_not_accepted(self):
        status, _body = plugin_runtime.dispatch_http("POST", self.parts, {}, {}, self.ctx)
        self.assertEqual(status, 405)

    def test_disabled_plugin_is_forbidden(self):
        plugin_runtime.set_enabled(self.state, "skills", False)
        status, body = plugin_runtime.dispatch_http(
            "GET", self.parts, {"root": [str(self.ws)]}, {}, self.ctx)
        self.assertEqual(status, 403)
        self.assertEqual(body["plugin"], "skills")

    def test_the_existing_resource_route_still_answers(self):
        self.resource_skill("kept", "Kept")
        status, body = plugin_runtime.dispatch_http(
            "GET", ["api", "resources", "skills"], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in body["items"]], ["kept"])


if __name__ == "__main__":
    unittest.main()
