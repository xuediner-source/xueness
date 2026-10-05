"""File-shaped custom commands: discovery, shadowing, expansion, CLI, chat, HTTP.

Everything runs against temporary state directories and workspaces. Nothing
here touches a network or a model. The promises covered:

* frontmatter is parsed as plain text, and an unusable entry becomes a
  structured diagnostic instead of an exception or a silent disappearance;
* one subdirectory becomes a namespace (``git/pr.md`` is ``/git:pr``) and a
  second level is refused;
* project commands win over the read-only compat root, which wins over the user
  root, which wins over the JSON resource store — and a name the host already
  answers is listed as ``shadowedBy: "builtin"`` and never expands;
* expansion is pure text: ``$ARGUMENTS`` and ``$1``..``$9`` are substituted,
  a position the user did not supply becomes empty, and neither ``!`cmd``` nor
  ``@file`` is ever run or read;
* a link — of a command file, of a namespace directory, or of a whole command
  root — is refused and its target is never read;
* ``commands list|inspect``, chat ``/commands``, the Web Composer preparation
  and the HTTP listing all stop when the owning plugin is disabled.
"""
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness import plugin_runtime, web
from xueness.bundled_plugins.commands import commands as store
from xueness.bundled_plugins.commands import commands_cli, file_commands
from xueness.bundled_plugins.sessions import cli as sessions_cli
from xueness.bundled_plugins.sessions import plugin as sessions_plugin
from xueness.cli import main as cli_main

BUILTIN_ORIGIN = "built-in prompt shipped with the commands plugin"


DEFAULT_ROOT = object()

BUILTIN_SOURCE = "builtin"


def custom(items) -> list:
    """Only the rows someone placed in a command root or the JSON store.

    The built-in prompt commands ship with the plugin and appear in every
    listing that has a workspace, so this file tests discovery, shadowing and
    budgets without them; ``tests.test_init_command`` owns the built-in rows.
    """
    return [item for item in items if item.get("source") != BUILTIN_SOURCE]


def command_text(description="What it does", body="Do the thing.", *, hint=None,
                 model=None, name=None, extra=()) -> str:
    lines = ["---"]
    if name is not None:
        lines.append("name: %s" % name)
    if description is not None:
        lines.append("description: %s" % description)
    if hint is not None:
        lines.append("argument-hint: %s" % hint)
    if model is not None:
        lines.append("model: %s" % model)
    lines.extend(extra)
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


class CommandFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.ws = self.base / "ws"
        self.state.mkdir()
        self.ws.mkdir()

    # -- writers ------------------------------------------------------------

    def root(self, source) -> Path:
        return {"project": self.ws / ".xueness" / "commands",
                "project-compat": self.ws / ".zcode" / "commands",
                "user": self.state / "commands"}[source]

    def command(self, source, stem, text=None, **fields) -> Path:
        path = self.root(source) / ("%s.md" % stem)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if text is not None else command_text(**fields),
                        encoding="utf-8")
        return path

    def project_command(self, stem, **fields) -> Path:
        return self.command("project", stem, **fields)

    def compat_command(self, stem, **fields) -> Path:
        return self.command("project-compat", stem, **fields)

    def user_command(self, stem, **fields) -> Path:
        return self.command("user", stem, **fields)

    def resource_command(self, cid, **fields) -> Path:
        directory = self.state / "resources" / "commands"
        directory.mkdir(parents=True, exist_ok=True)
        item = {"id": cid}
        item.update(fields)
        path = directory / ("%s.json" % cid)
        path.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
        return path

    # -- readers ------------------------------------------------------------

    def listing(self, root=DEFAULT_ROOT, *, include_builtin: bool = False, **kwargs) -> dict:
        document = store.list_all(self.state, self.ws if root is DEFAULT_ROOT else root, **kwargs)
        if include_builtin:
            return document
        return {**document, "commands": custom(document["commands"])}

    def rows(self, root=DEFAULT_ROOT, **kwargs) -> list:
        return self.listing(root, **kwargs)["commands"]

    def builtins(self, root=DEFAULT_ROOT, **kwargs) -> list:
        """The shipped rows alone: /init and anything the plugin adds later."""
        return [row for row in self.listing(root, include_builtin=True, **kwargs)["commands"]
                if row["source"] == BUILTIN_SOURCE]

    def entries(self, root=DEFAULT_ROOT, **kwargs) -> list:
        return custom(store.load(self.state, self.ws if root is DEFAULT_ROOT else root, **kwargs))

    def diagnostics(self, root=DEFAULT_ROOT, **kwargs) -> list:
        return self.listing(root, **kwargs)["diagnostics"]

    def row(self, name, source=None, root=DEFAULT_ROOT) -> dict:
        for item in self.rows(root):
            if item["id"] == name and (source is None or item["source"] == source):
                return item
        self.fail("no command row for %s %s" % (name, source or "any source"))

    def ids(self, rows) -> list:
        return [row["id"] for row in rows]

    def codes(self, diagnostics) -> list:
        return [item["code"] for item in diagnostics]

    def expanded(self, text, root=DEFAULT_ROOT) -> tuple:
        return store.expand(store.load(self.state, self.ws if root is DEFAULT_ROOT else root), text)

    def snapshot(self) -> dict:
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


# -- frontmatter --------------------------------------------------------------

class FrontmatterTests(CommandFixture):
    def test_plain_key_value_block_parses(self):
        values, keys, error = file_commands.parse_frontmatter(
            command_text(hint="<issue>", extra=["author: qa"]))
        self.assertIsNone(error)
        self.assertEqual(values["description"], "What it does")
        self.assertEqual(values["argument-hint"], "<issue>")
        self.assertEqual(values["author"], "qa")
        self.assertEqual(keys, ["description", "argument-hint", "author"])

    def test_quoted_values_and_crlf_are_normalised(self):
        text = '---\r\ndescription: "Review: everything"\r\nargument-hint: \'a b\'\r\n---\r\nbody\r\n'
        values, _keys, error = file_commands.parse_frontmatter(text)
        self.assertIsNone(error)
        self.assertEqual(values["description"], "Review: everything")
        self.assertEqual(values["argument-hint"], "a b")

    def test_folded_block_scalar_joins_indented_lines(self):
        values, _keys, error = file_commands.parse_frontmatter(
            "---\ndescription: >\n  first line\n  second line\n---\nbody\n")
        self.assertIsNone(error)
        self.assertEqual(values["description"], "first line second line")

    def test_literal_block_scalar_keeps_lines(self):
        values, _keys, _error = file_commands.parse_frontmatter(
            "---\ndescription: |\n  step one\n  step two\n---\nbody\n")
        self.assertEqual(values["description"], "step one\nstep two")

    def test_a_missing_fence_is_legal(self):
        self.assertEqual(file_commands.parse_frontmatter("# Title\n\nDo it.\n"),
                         ({}, [], None))

    def test_uppercase_and_dashes_are_kept_as_written(self):
        self.project_command("Release-Notes")
        self.assertEqual(self.ids(self.entries()), ["Release-Notes"])

    def test_unclosed_fence_is_reported(self):
        self.project_command("open", text="---\ndescription: no end\n")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_unclosed_frontmatter"])

    def test_an_unreadable_block_is_reported(self):
        self.project_command("odd", text="---\nnot a pair at all\nstill not\n---\nbody\n")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_frontmatter"])

    def test_corrupt_lines_do_not_hide_the_readable_ones(self):
        self.project_command("mixed",
                             text="---\nnot a pair at all\ndescription: usable\n---\nbody\n")
        self.assertEqual(self.row("mixed")["description"], "usable")
        self.assertEqual(self.diagnostics(), [])

    def test_comment_and_indented_lines_are_skipped(self):
        self.project_command("notes",
                             text="---\n# a comment\ndescription: fine\n  stray: nested\n---\nx\n")
        self.assertEqual(self.row("notes")["description"], "fine")
        self.assertEqual(self.row("notes")["frontmatterKeys"], ["description"])

    def test_frontmatter_never_reaches_the_expanded_body(self):
        self.project_command("clean", body="LINE-ONE\nLINE-TWO")
        expanded, meta = self.expanded("/clean")
        self.assertEqual(expanded, "LINE-ONE\nLINE-TWO")
        self.assertNotIn("description", expanded)
        self.assertEqual(meta, {"command": "clean", "args": ""})

    def test_the_file_stem_is_the_invocation_name(self):
        self.project_command("hinted", hint="<branch> <base>", name="Hinted")
        row = self.row("hinted")
        self.assertEqual(row["argumentHint"], "<branch> <base>")
        self.assertEqual(row["name"], "hinted")
        self.assertEqual(self.codes(self.diagnostics()), ["command_unsupported_frontmatter"],
                         "a name: key is named back but never renames the command")

    def test_bodies_keep_inner_blank_lines_but_lose_the_fences(self):
        path = self.project_command("shape", text="---\ndescription: d\n---\n\n  one\n\n  two\n\n")
        entry = self.entries()[0]
        self.assertEqual(entry["prompt"], "one\n\n  two")
        self.assertTrue(path.exists())


# -- validation and budgets ---------------------------------------------------

class ValidationTests(CommandFixture):
    def test_description_falls_back_to_the_first_body_line(self):
        self.project_command("bare", text="# Ship checklist\n\nRun the steps below.\n")
        self.assertEqual(self.row("bare")["description"], "Ship checklist")

    def test_frontmatter_description_wins_over_the_body(self):
        self.project_command("both", description="From frontmatter", body="From body")
        self.assertEqual(self.row("both")["description"], "From frontmatter")

    def test_description_is_bounded(self):
        self.project_command("long", description="d" * 2000)
        self.assertEqual(len(self.row("long")["description"]),
                         file_commands.DESCRIPTION_MAX_CHARS)

    def test_argument_hint_is_bounded(self):
        self.project_command("hint", hint="h" * 200)
        self.assertEqual(len(self.row("hint")["argumentHint"]),
                         file_commands.ARGUMENT_HINT_MAX_CHARS)

    def test_an_unsupported_frontmatter_key_is_named_but_ignored(self):
        self.project_command("granting", extra=["allowed-tools: Bash(rm:*)", "skills: other"])
        self.assertEqual(self.codes(self.diagnostics()),
                         ["command_unsupported_frontmatter", "command_unsupported_frontmatter"])
        self.assertEqual(self.row("granting")["frontmatterKeys"],
                         ["description", "allowed-tools", "skills"])

    def test_a_model_is_shown_and_never_applied(self):
        self.project_command("modelled", model="gpt-4o")
        self.assertEqual(self.row("modelled")["model"], "gpt-4o")
        self.assertIn("command_model_not_applied", self.codes(self.diagnostics()))
        self.assertNotIn("provider", json.dumps(self.row("modelled")))

    def test_an_empty_body_is_refused(self):
        self.project_command("blank", text="---\ndescription: nothing here\n---\n\n")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_empty_body"])

    def test_an_illegal_name_is_refused(self):
        self.project_command("bad!name")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_name"])

    def test_a_name_over_the_length_limit_is_refused(self):
        self.project_command("n" * (file_commands.MAX_NAME_CHARS + 1))
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_name"])

    def test_a_namespaced_name_is_checked_as_a_whole(self):
        self.project_command("git/" + "p" * file_commands.MAX_NAME_CHARS)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_name"])

    def test_an_oversized_file_is_refused_without_being_parsed(self):
        path = self.project_command("huge", body="x" * 100)
        path.write_text(path.read_text(encoding="utf-8") +
                        "y" * file_commands.MAX_COMMAND_FILE_BYTES, encoding="utf-8")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_file_too_large"])

    def test_a_non_utf8_file_is_refused(self):
        path = self.project_command("binary")
        path.write_bytes(b"\xff\xfe\x00garbage")
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_encoding"])

    def test_command_count_per_root_is_capped(self):
        for index in range(file_commands.MAX_COMMANDS_PER_ROOT + 3):
            self.project_command("s%02d" % index)
        self.assertEqual(len(self.rows()), file_commands.MAX_COMMANDS_PER_ROOT)
        self.assertIn("command_root_limit", self.codes(self.diagnostics()))

    def test_one_broken_entry_does_not_affect_its_neighbours(self):
        self.project_command("bad", text="---\n")
        self.project_command("good")
        self.assertEqual(self.ids(self.rows()), ["good"])
        self.assertIn("command_unclosed_frontmatter", self.codes(self.diagnostics()))

    def test_a_missing_root_is_simply_nothing(self):
        shutil.rmtree(self.ws)
        self.assertEqual(self.listing(), {"commands": [], "diagnostics": []})

    def test_discovery_reports_nothing_for_an_empty_workspace(self):
        self.assertEqual(file_commands.discover(self.state, self.ws),
                         {"commands": [], "diagnostics": []})


# -- namespaces ---------------------------------------------------------------

class NamespaceTests(CommandFixture):
    def test_one_subdirectory_becomes_a_namespace(self):
        self.project_command("git/pr", description="Review a pull request")
        self.assertEqual(self.ids(self.rows()), ["git:pr"])
        self.assertEqual(self.row("git:pr")["source"], "project")
        self.assertEqual(self.diagnostics(), [])

    def test_a_second_level_is_refused(self):
        self.project_command("git/deep/pr", description="too deep")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_namespace_too_deep"])

    def test_a_namespace_keeps_its_siblings_and_ignores_the_rest(self):
        anchor = self.project_command("git/pr")
        nested = anchor.parent / "sub"
        nested.mkdir()
        (nested / "deeper.md").write_text(command_text(description="hidden level"),
                                          encoding="utf-8")
        (anchor.parent / "notes.txt").write_text("plain text", encoding="utf-8")
        self.assertEqual(self.ids(self.rows()), ["git:pr"])
        self.assertEqual(self.codes(self.diagnostics()), ["command_namespace_too_deep"])

    def test_non_markdown_and_hidden_entries_are_ignored(self):
        directory = self.root("project")
        directory.mkdir(parents=True)
        (directory / "README.md.md").write_text(command_text(description="keep"), encoding="utf-8")
        (directory / "notes.txt").write_text("plain text", encoding="utf-8")
        (directory / "README").write_text("no extension", encoding="utf-8")
        (directory / ".scratch").mkdir()
        (directory / ".scratch" / "quiet.md").write_text(command_text(description="hidden"),
                                                         encoding="utf-8")
        self.assertEqual(self.ids(self.rows()), ["README.md"])
        self.assertEqual(self.diagnostics(), [])

    def test_an_unusable_namespace_directory_is_a_warning(self):
        self.project_command("bad name/x")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.codes(self.diagnostics()), ["command_invalid_namespace"])

    def test_a_namespaced_command_expands(self):
        self.project_command("git/pr", body="Fix $1 against $2 for $ARGUMENTS")
        expanded, meta = self.expanded("/git:pr main release extra words")
        self.assertEqual(expanded, "Fix main against release for main release extra words")
        self.assertEqual(meta, {"command": "git:pr", "args": "main release extra words"})

    def test_the_name_helpers_agree_with_the_chat_matcher(self):
        self.assertTrue(file_commands.is_valid_name("git:pr"))
        self.assertTrue(file_commands.is_valid_name("Release-Notes"))
        self.assertFalse(file_commands.is_valid_name("git:pr:x"))
        self.assertFalse(file_commands.is_valid_name("bad!name"))
        self.assertFalse(file_commands.is_valid_name("."))
        self.assertFalse(file_commands.is_valid_name("n" * 65))
        self.assertFalse(file_commands.is_valid_name(""))


# -- sources and shadowing ----------------------------------------------------

class SourceTests(CommandFixture):
    def test_project_wins_over_every_lower_source(self):
        self.compat_command("alpha", description="compat level")
        self.user_command("alpha", description="user level")
        self.project_command("alpha", description="project level")
        self.resource_command("alpha", prompt="resource level")
        self.assertEqual(self.ids(self.rows()), ["alpha"] * 4)
        self.assertEqual([(row["source"], row["shadowedBy"]) for row in self.rows()],
                         [("project", None), ("project-compat", "project"),
                          ("user", "project"), ("resource", "project")])

    def test_compat_wins_over_user_without_a_project_command(self):
        self.compat_command("shared", description="compat")
        self.user_command("shared", description="user")
        self.assertEqual([(row["source"], row["shadowedBy"]) for row in self.rows()],
                         [("project-compat", None), ("user", "project-compat")])

    def test_a_compat_root_is_switchable(self):
        self.compat_command("legacy", description="from .zcode")
        self.assertEqual(self.row("legacy")["scope"], "project")
        document = self.listing(include_compat=False)
        self.assertEqual(document["commands"], [])

    def test_user_wins_over_the_json_store(self):
        self.user_command("solo", description="file side")
        self.resource_command("solo", prompt="store side")
        self.assertEqual([(row["source"], row["shadowed"]) for row in self.rows()],
                         [("user", False), ("resource", True)])

    def test_rows_are_ordered_by_name_then_priority(self):
        self.user_command("beta")
        self.project_command("beta")
        self.project_command("alpha")
        self.resource_command("alpha", prompt="a")
        self.assertEqual(self.ids(self.rows()), ["alpha", "alpha", "beta", "beta"])

    def test_only_the_winning_body_is_loadable(self):
        self.project_command("winner", body="WINNER-BODY")
        self.user_command("loser", body="LOSER-BODY")
        self.project_command("loser", body="LOSER-TOO")
        entries = self.entries()
        self.assertEqual([entry["id"] for entry in entries], ["loser", "winner"])
        self.assertEqual(entries[0]["prompt"], "LOSER-TOO")
        self.assertNotIn("LOSER-BODY", json.dumps(entries, ensure_ascii=False))

    def test_the_json_store_contract_is_unchanged_without_a_root(self):
        self.resource_command("kept", prompt="STORE-BODY", description="stored")
        self.resource_command("off", prompt="HIDDEN", enabled=False)
        self.project_command("project-only")
        entries = store.load(self.state)
        self.assertEqual([entry["id"] for entry in entries], ["kept"])
        expanded, _meta = store.expand(entries, "/kept now")
        self.assertIn("STORE-BODY", expanded)

    def test_a_disabled_json_command_stays_disabled(self):
        self.resource_command("off", prompt="HIDDEN", enabled=False)
        self.assertEqual(self.ids(self.rows(root=None)), [])
        self.user_command("off", body="FILE-BODY")
        self.assertEqual(self.ids(self.rows()), ["off"])
        self.assertEqual([entry["prompt"] for entry in self.entries()], ["FILE-BODY"])


# -- builtin name conflicts ---------------------------------------------------

class BuiltinConflictTests(CommandFixture):
    def test_a_host_answered_name_is_marked_and_never_expands(self):
        self.project_command("help", description="My own help", body="MUST-NOT-EXPAND")
        row = self.row("help")
        self.assertTrue(row["shadowed"])
        self.assertEqual(row["shadowedBy"], "builtin")
        self.assertEqual(self.entries(), [])
        self.assertEqual(self.expanded("/help me"), ("/help me", None))

    def test_manifest_commands_are_reserved_too(self):
        self.project_command("commands", description="shadows my own command")
        self.project_command("skills", description="shadows the skills plugin")
        self.project_command("ghost", description="not reserved")
        self.assertEqual(self.row("commands")["shadowedBy"], "builtin")
        self.assertEqual(self.row("skills")["shadowedBy"], "builtin")
        self.assertFalse(self.row("ghost")["shadowed"])
        self.assertEqual(self.ids(self.entries()), ["ghost"])

    def test_reserved_is_answered_from_the_real_registry(self):
        self.assertTrue(file_commands.is_reserved("help"))
        self.assertTrue(file_commands.is_reserved("commands"))
        self.assertTrue(file_commands.is_reserved("/model"))
        self.assertFalse(file_commands.is_reserved("release-notes"))
        self.assertFalse(file_commands.is_reserved(""))

    def test_the_builtin_does_not_claim_the_name_for_lower_sources(self):
        self.project_command("help", body="TOP")
        self.user_command("help", body="BOTTOM")
        self.assertEqual([(row["shadowedBy"], row["shadowed"]) for row in self.rows()],
                         [("builtin", True), ("builtin", True)])

    def test_the_json_store_may_still_hold_a_reserved_id(self):
        self.resource_command("help", prompt="STORE-CONTRACT")
        row = self.row("help")
        self.assertEqual(row["source"], "resource")
        self.assertFalse(row["shadowed"])


# -- listing and inspect ------------------------------------------------------

class ListingTests(CommandFixture):
    def test_a_listing_is_a_summary_not_a_body(self):
        self.project_command("quiet", description="Ship checklist", body="PRIVATE-BODY-MARKER")
        document = self.listing()
        self.assertIn("Ship checklist", json.dumps(document, ensure_ascii=False))
        self.assertNotIn("PRIVATE-BODY-MARKER", json.dumps(document, ensure_ascii=False))
        self.assertNotIn("body", document["commands"][0])

    def test_a_shadowed_row_carries_no_body_either(self):
        self.project_command("dup", body="TOP")
        self.user_command("dup", body="BOTTOM-MARKER")
        self.assertNotIn("BOTTOM-MARKER", json.dumps(self.listing(), ensure_ascii=False))

    def test_rows_carry_source_scope_and_paths(self):
        path = self.project_command("shaped", hint="<n>")
        row = self.row("shaped")
        self.assertEqual(row["source"], "project")
        self.assertEqual(row["scope"], "project")
        self.assertEqual(Path(row["path"]), path.resolve())
        self.assertEqual(Path(row["rootPath"]), self.root("project").resolve())
        self.assertGreater(row["bytes"], 0)

    def test_inspect_returns_a_bounded_body_and_limits(self):
        self.project_command("deep", body="STEP-ONE\nSTEP-TWO")
        result = store.inspect_command(self.state, "deep", self.ws)
        self.assertTrue(result["ok"])
        self.assertEqual(result["command"]["id"], "deep")
        self.assertIn("STEP-TWO", result["content"])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["limits"]["expandChars"], store.EXPAND_MAX_CHARS)
        self.assertEqual(result["limits"]["commandFileBytes"],
                         file_commands.MAX_COMMAND_FILE_BYTES)
        self.assertNotIn("body", json.dumps(result, ensure_ascii=False))

    def test_inspect_clips_a_large_body(self):
        self.project_command("big", body="z" * (file_commands.BODY_PREVIEW_CHARS + 500))
        result = store.inspect_command(self.state, "big", self.ws)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["content"]), file_commands.BODY_PREVIEW_CHARS)
        self.assertIn("…(truncated)", result["content"])

    def test_inspect_names_what_is_available(self):
        self.project_command("here")
        result = store.inspect_command(self.state, "ghost", self.ws)
        self.assertFalse(result["ok"])
        self.assertIn("command not found: ghost", result["error"])
        self.assertEqual(result["available"], ["here", "init"],
                         "the built-in prompt command is an available name too")

    def test_inspect_tolerates_a_leading_slash_and_refuses_a_path(self):
        self.project_command("safe")
        self.assertTrue(store.inspect_command(self.state, "/safe", self.ws)["ok"])
        self.assertFalse(store.inspect_command(self.state, "../safe", self.ws)["ok"])
        self.assertFalse(store.inspect_command(self.state, str(self.ws), self.ws)["ok"])

    def test_inspect_of_a_shadowed_name_reports_the_winner(self):
        self.project_command("dup", body="WINNER")
        self.user_command("dup", body="LOSER")
        result = store.inspect_command(self.state, "dup", self.ws)
        self.assertEqual(result["command"]["source"], "project")
        self.assertIn("WINNER", result["content"])
        self.assertNotIn("LOSER", result["content"])

    def test_inspect_reports_the_shell_refusal_once_for_a_stored_prompt(self):
        self.resource_command("shelly", prompt="Run !`whoami` now")
        result = store.inspect_command(self.state, "shelly")
        self.assertEqual(self.codes(result["diagnostics"]), ["command_shell_expansion_unsupported"])

    def test_inspect_reports_the_shell_refusal_once_for_a_file(self):
        self.project_command("shelly", body="Run !`whoami` now")
        result = store.inspect_command(self.state, "shelly", self.ws)
        self.assertEqual(self.codes(result["diagnostics"]), ["command_shell_expansion_unsupported"])


# -- expansion ----------------------------------------------------------------

class ExpansionTests(CommandFixture):
    def test_arguments_placeholder_from_a_file_body(self):
        self.project_command("t", body="Translate $ARGUMENTS now.")
        expanded, meta = self.expanded("/t hello world")
        self.assertEqual(expanded, "Translate hello world now.")
        self.assertEqual(meta, {"command": "t", "args": "hello world"})

    def test_positional_arguments_are_substituted(self):
        self.project_command("p", body="Fix $1 in $2 and $3")
        self.assertEqual(self.expanded("/p src/app.py tests review")[0],
                         "Fix src/app.py in tests and review")

    def test_quoted_arguments_group_spaces(self):
        self.project_command("q", body='["$1", "$2", "$ARGUMENTS"]')
        expanded, _meta = self.expanded('/q "two words" tail')
        self.assertEqual(expanded, '["two words", "tail", ""two words" tail"]')

    def test_a_missing_positional_becomes_empty(self):
        self.project_command("p", body="second is $2")
        self.assertEqual(self.expanded("/p one")[0], "second is")

    def test_tenth_argument_is_not_a_placeholder(self):
        self.project_command("ten", body="$1 then $10 then $ARGUMENTS")
        expanded, _meta = self.expanded("/ten " + " ".join(str(i) for i in range(10)))
        self.assertEqual(expanded, "0 then $10 then 0 1 2 3 4 5 6 7 8 9")

    def test_a_user_value_is_never_expanded_again(self):
        self.project_command("p", body="value: $1")
        self.assertEqual(self.expanded("/p $2")[0], "value: $2")

    def test_arguments_are_appended_when_no_placeholder_is_named(self):
        self.project_command("c", body="Body text.")
        expanded, meta = self.expanded("/c hello world")
        self.assertEqual(expanded, "Body text.\n\nhello world")
        self.assertEqual(meta["args"], "hello world")

    def test_a_body_without_arguments_is_left_alone(self):
        self.project_command("c", body="Body text.")
        self.assertEqual(self.expanded("/c"), ("Body text.", {"command": "c", "args": ""}))

    def test_a_placeholder_without_arguments_becomes_empty(self):
        self.project_command("t", body="Translate $ARGUMENTS now.")
        self.assertEqual(self.expanded("/t")[0], "Translate  now.")

    def test_multiline_bodies_and_arguments_survive(self):
        self.project_command("c", body="one\ntwo\nthree")
        expanded, meta = self.expanded("/c line one\nline two")
        self.assertEqual(expanded, "one\ntwo\nthree\n\nline one\nline two")
        self.assertEqual(meta["args"], "line one\nline two")

    def test_an_over_long_expansion_is_clipped(self):
        self.project_command("big", body="x" * (store.EXPAND_MAX_CHARS * 2))
        expanded, meta = self.expanded("/big")
        self.assertLessEqual(len(expanded), store.EXPAND_MAX_CHARS)
        self.assertIn("…(truncated)", expanded)
        self.assertEqual(meta["command"], "big")

    def test_inline_shell_syntax_stays_literal(self):
        self.project_command("shell", body="Before !`whoami` after")
        self.assertEqual(self.expanded("/shell")[0], "Before !`whoami` after")
        self.assertIn("command_shell_expansion_unsupported", self.codes(self.diagnostics()))

    def test_a_fenced_shell_block_stays_literal(self):
        self.project_command("fenced",
                             text="---\ndescription: d\n---\n```!\nls -la\n```\n")
        self.assertIn("```!\nls -la\n```", self.expanded("/fenced")[0])
        self.assertIn("command_shell_expansion_unsupported", self.codes(self.diagnostics()))

    def test_an_at_reference_is_kept_and_its_target_is_never_read(self):
        (self.ws / "notes.txt").write_text("TOKEN-AT-TARGET", encoding="utf-8")
        self.project_command("ref", body="See @notes.txt please")
        self.assertEqual(self.expanded("/ref")[0], "See @notes.txt please")
        self.assertNotIn("TOKEN-AT-TARGET", json.dumps([
            self.listing(), store.inspect_command(self.state, "ref", self.ws)],
            ensure_ascii=False))

    def test_unknown_and_passthrough_turns_are_untouched(self):
        self.project_command("demo")
        for text in ("/ghost args", "plain /demo text", "//demo", "/demo" + "x" * 65,
                     "  /demo", "", "double /demo slash"):
            self.assertEqual(self.expanded(text), (text, None), text)

    def test_expansion_never_writes_a_file(self):
        self.project_command("c", body="b" * 4)
        before = self.snapshot()
        entries = store.load(self.state, self.ws)
        for text in ("/c arg", "/c", "/ghost", "text"):
            store.expand(entries, text)
        self.assertEqual(self.snapshot(), before)


# -- the read-only jail -------------------------------------------------------

class JailTests(CommandFixture):
    def test_a_symlinked_command_file_is_refused(self):
        secret = self.base / "outside-secret.md"
        secret.write_text(command_text(description="TOKEN-FILE"), encoding="utf-8")
        self.root("project").mkdir(parents=True)
        make_symlink(self.root("project") / "leak.md", secret)
        self.project_command("kept")
        rows, diagnostics = self.rows(), self.diagnostics()
        self.assertEqual(self.ids(rows), ["kept"])
        self.assertIn("command_entry_symlink", self.codes(diagnostics))
        self.assertNotIn("TOKEN-FILE", json.dumps([rows, diagnostics], ensure_ascii=False))

    def test_a_symlink_inside_a_namespace_is_refused(self):
        secret = self.base / "elsewhere.md"
        secret.write_text(command_text(description="TOKEN-NAMESPACE"), encoding="utf-8")
        directory = self.project_command("git/anchor").parent
        make_symlink(directory / "pr.md", secret)
        rows, diagnostics = self.rows(), self.diagnostics()
        self.assertEqual(self.ids(rows), ["git:anchor"])
        self.assertIn("command_file_symlink", self.codes(diagnostics))
        self.assertNotIn("TOKEN-NAMESPACE", json.dumps([rows, diagnostics], ensure_ascii=False))

    def test_a_symlinked_namespace_directory_is_refused(self):
        outside = self.base / "outside" / "git"
        outside.mkdir(parents=True)
        (outside / "pr.md").write_text(command_text(description="TOKEN-DIR"), encoding="utf-8")
        self.root("project").mkdir(parents=True)
        make_symlink(self.root("project") / "git", outside, target_is_directory=True)
        rows, diagnostics = self.rows(), self.diagnostics()
        self.assertEqual(rows, [])
        self.assertIn("command_entry_symlink", self.codes(diagnostics))
        self.assertNotIn("TOKEN-DIR", json.dumps([rows, diagnostics], ensure_ascii=False))

    def test_a_project_root_redirected_out_of_the_workspace_is_refused(self):
        elsewhere = self.base / "elsewhere" / "commands"
        elsewhere.mkdir(parents=True)
        (elsewhere / "away.md").write_text(command_text(description="TOKEN-ROOT"),
                                          encoding="utf-8")
        make_directory_boundary_link(self.ws / ".xueness", elsewhere.parent)
        rows, diagnostics = self.rows(), self.diagnostics()
        self.assertEqual(rows, [])
        self.assertIn("command_root_escapes", self.codes(diagnostics))
        self.assertNotIn("TOKEN-ROOT", json.dumps([rows, diagnostics], ensure_ascii=False))

    def test_a_symlinked_user_command_root_is_refused(self):
        outside = self.base / "user-commands"
        outside.mkdir(parents=True)
        (outside / "u.md").write_text(command_text(description="TOKEN-USER"), encoding="utf-8")
        make_directory_boundary_link(self.state / "commands", outside)
        rows, diagnostics = self.rows(), self.diagnostics()
        self.assertEqual(rows, [])
        self.assertIn("command_root_symlink", self.codes(diagnostics))
        self.assertNotIn("TOKEN-USER", json.dumps([rows, diagnostics], ensure_ascii=False))

    def test_the_json_store_directory_still_refuses_a_link(self):
        directory = self.state / "resources"
        directory.mkdir(parents=True)
        outside = self.base / "outside-store"
        (outside / "commands").mkdir(parents=True)
        (outside / "commands" / "x.json").write_text(
            json.dumps({"id": "x", "prompt": "TOKEN-STORE"}), encoding="utf-8")
        make_directory_boundary_link(directory / "commands", outside / "commands")
        self.assertEqual(store.resource_rows(self.state), [])
        self.assertNotIn("TOKEN-STORE", json.dumps(self.listing(), ensure_ascii=False))

    def test_discovery_writes_nothing(self):
        self.project_command("a")
        self.user_command("b")
        self.resource_command("c", prompt="x")
        before = self.snapshot()
        store.list_all(self.state, self.ws)
        store.load(self.state, self.ws)
        store.inspect_command(self.state, "a", self.ws)
        self.assertEqual(self.snapshot(), before)

    def test_the_body_reader_revalidates_a_stale_row(self):
        planted = self.base / "planted.md"
        planted.write_text(command_text(body="TOKEN-STALE"), encoding="utf-8")
        path = self.project_command("stale")
        row = file_commands.discover(self.state, self.ws)["commands"][0]
        path.unlink()
        make_symlink(path, planted)
        result = file_commands.read_body(row)
        self.assertFalse(result["ok"])
        self.assertNotIn("TOKEN-STALE", json.dumps(result, ensure_ascii=False))

    def test_the_body_reader_refuses_a_foreign_path(self):
        self.assertFalse(file_commands.read_body({"path": "", "rootPath": ""})["ok"])
        outside = self.base / "free.md"
        outside.write_text(command_text(body="FREE"), encoding="utf-8")
        row = {"path": str(outside), "rootPath": str(self.root("project"))}
        self.assertFalse(file_commands.read_body(row)["ok"])


# -- CLI ----------------------------------------------------------------------

class CliTests(CommandFixture):
    def test_list_prints_rows_sources_and_descriptions(self):
        self.project_command("alpha", description="Project alpha", hint="<n>")
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("Custom commands (2)", out)
        self.assertIn("- /alpha <n> (project)", out)
        self.assertIn("Project alpha", out)
        self.assertIn("- /init [补充说明] (builtin)", out)
        self.assertIn(BUILTIN_ORIGIN, out)

    def test_list_marks_who_shadowed_what(self):
        self.project_command("help")
        self.user_command("dup")
        self.project_command("dup")
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("/help (project) [shadowed-by-builtin]", out)
        self.assertIn("/dup (user) [shadowed by project]", out)

    def test_list_reports_diagnostics_in_human_output(self):
        self.project_command("bad!name")
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("Custom commands (1)", out)
        self.assertIn("- /init", out)
        self.assertNotIn("- /bad!name", out)
        self.assertIn("Diagnostics (1)", out)
        self.assertIn("[error] command_invalid_name", out)

    def test_bare_commands_lists_the_current_directory(self):
        self.project_command("alpha")
        previous = os.getcwd()
        try:
            os.chdir(self.ws)
            code, out, err = _cli(self.state, ["commands"])
        finally:
            os.chdir(previous)
        self.assertEqual(code, 0, err)
        self.assertIn("- /alpha (project)", out)

    def test_list_json_is_machine_readable(self):
        self.project_command("alpha")
        self.resource_command("res", prompt="from the store", description="stored")
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws), "--json"])
        self.assertEqual(code, 0, err)
        document = json.loads(out)
        self.assertEqual(document["root"], str(self.ws))
        self.assertEqual(document["stateDir"], str(self.state))
        self.assertEqual(self.ids(document["commands"]), ["alpha", "init", "res"])
        self.assertEqual({row["source"] for row in document["commands"]},
                         {"project", "builtin", "resource"})
        self.assertEqual(document["limits"]["commandsPerRoot"],
                         file_commands.MAX_COMMANDS_PER_ROOT)
        self.assertNotIn("body", document["commands"][0])

    def test_inspect_prints_metadata_and_body(self):
        self.project_command("alpha", body="Step one.\nStep two.", hint="<issue>")
        code, out, err = _cli(self.state, ["commands", "inspect", "alpha",
                                           "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("Command: /alpha", out)
        self.assertIn("source: project", out)
        self.assertIn("argument-hint: <issue>", out)
        self.assertIn("shadowed: no", out)
        self.assertIn("Step two.", out)
        self.assertIn("no shell expansion", out)

    def test_inspect_shows_a_model_as_reference_only(self):
        self.project_command("modelled", model="gpt-4o")
        code, out, err = _cli(self.state, ["commands", "inspect", "modelled",
                                           "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("model: gpt-4o (shown only", out)

    def test_inspect_json_shape(self):
        self.user_command("solo", description="user only", body="USER-BODY")
        code, out, err = _cli(self.state, ["commands", "inspect", "solo", "--json"])
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertTrue(result["ok"])
        self.assertEqual(result["command"]["source"], "user")
        self.assertEqual(result["root"], str(Path.cwd()))
        self.assertIn("USER-BODY", result["content"])
        self.assertFalse(result["truncated"])

    def test_inspect_unknown_name_exits_non_zero(self):
        code, out, err = _cli(self.state, ["commands", "inspect", "ghost",
                                           "--root", str(self.ws)])
        self.assertEqual(code, 1)
        self.assertIn("ERROR: command not found: ghost", out)
        self.assertIn("Available: /init", out)

    def test_usage_error_writes_nothing_to_stdout(self):
        code, out, err = _cli(self.state, ["commands", "frobnicate"])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")

    def test_inspect_without_a_name_is_a_usage_error(self):
        code, out, err = _cli(self.state, ["commands", "inspect"])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")

    def test_a_disabled_plugin_exits_non_zero_with_empty_stdout(self):
        self.project_command("alpha")
        plugin_runtime.set_enabled(self.state, "commands", False)
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("commands", err)


# -- chat /commands -----------------------------------------------------------

class SlashTests(CommandFixture):
    def ctx(self):
        return {"state_dir": self.state, "root": str(self.ws), "session": {"root": str(self.ws)}}

    def test_commands_is_claimed_by_the_commands_plugin(self):
        self.assertEqual(plugin_runtime.slash_owner("commands"), "commands")
        self.assertIsNone(plugin_runtime.slash_owner("commandz"))

    def test_dispatch_lists_and_inspects(self):
        self.project_command("alpha", description="chat listing", body="ALPHA-BODY")
        reply = plugin_runtime.dispatch_slash("/commands", self.ctx())
        self.assertIn("- /alpha (project)", reply)
        self.assertIsNone(plugin_runtime.dispatch_slash("/commandz", self.ctx()))
        inspected = plugin_runtime.dispatch_slash("/commands inspect alpha", self.ctx())
        self.assertIn("Command: /alpha", inspected)
        self.assertIn("ALPHA-BODY", inspected)

    def test_default_and_explicit_list_agree(self):
        self.project_command("alpha")
        self.assertEqual(plugin_runtime.dispatch_slash("/commands", self.ctx()),
                         plugin_runtime.dispatch_slash("/commands list", self.ctx()))

    def test_usage_answers_instead_of_an_exception(self):
        self.assertIn("Unknown commands command",
                      plugin_runtime.dispatch_slash("/commands frobnicate", self.ctx()))
        self.assertIn("takes no arguments",
                      plugin_runtime.dispatch_slash("/commands list extra", self.ctx()))
        self.assertIn("needs a name",
                      plugin_runtime.dispatch_slash("/commands inspect", self.ctx()))

    def test_a_session_root_is_used_when_no_root_is_given(self):
        self.project_command("from-session")
        ctx = {"state_dir": self.state, "session": {"root": str(self.ws)}}
        self.assertIn("- /from-session (project)",
                      plugin_runtime.dispatch_slash("/commands", ctx))

    def test_a_session_without_a_state_directory_reads_nothing(self):
        self.assertIn("no state directory", commands_cli.handle_slash("", {"session": {}}))

    def test_a_disabled_plugin_refuses_the_command(self):
        self.project_command("alpha")
        plugin_runtime.set_enabled(self.state, "commands", False)
        reply = plugin_runtime.dispatch_slash("/commands", self.ctx())
        self.assertIn("plugin disabled", reply)
        self.assertNotIn("alpha", reply)


# -- the run seam -------------------------------------------------------------

class ChatPathTests(CommandFixture):
    def test_the_chat_loader_sees_file_commands(self):
        self.project_command("pr", body="Review $1 with $ARGUMENTS")
        self.user_command("daily")
        self.resource_command("stored", prompt="STORE")
        entries = custom(sessions_cli.load_commands(self.state, self.ws))
        self.assertEqual(sorted(entry["id"] for entry in entries), ["daily", "pr", "stored"])
        expanded, meta = store.expand(entries, "/pr main")
        self.assertEqual(expanded, "Review main with main")
        self.assertEqual(meta, {"command": "pr", "args": "main"})

    def test_without_a_workspace_only_user_and_stored_commands_load(self):
        self.project_command("pr")
        self.user_command("daily")
        self.assertEqual([entry["id"] for entry in sessions_cli.load_commands(self.state, None)],
                         ["daily"])

    def test_a_disabled_commands_plugin_loads_nothing(self):
        self.project_command("pr")
        plugin_runtime.set_enabled(self.state, "commands", False)
        self.assertEqual(sessions_cli.load_commands(self.state, self.ws), [])

    def test_a_shadowed_builtin_name_never_reaches_the_model(self):
        self.project_command("help", body="MUST-NOT-EXPAND")
        self.user_command("model", body="MUST-NOT-EXPAND-EITHER")
        self.assertEqual(custom(sessions_cli.load_commands(self.state, self.ws)), [])


class ComposerParityTests(unittest.TestCase):
    """The Web Composer must expand exactly what the chat loader expands."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / "project"
        self.project.mkdir()
        self.runs = base / "runs"
        self.state = base / "state"
        self.env = patch.dict(os.environ, {
            "XUENESS_PROVIDER": "openai",
            "XUENESS_API_BASE": "https://api.example.test/v1",
            "XUENESS_MODEL": "gpt-4o",
            "XUENESS_API_KEY": "composer-test-secret",
            "ANTHROPIC_API_KEY": "",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ctx = web.build_context(self.state, self.runs, self.project, allow_real=True)
        self.ctx["workspace_roots"] = ()

    def prepare(self, text):
        return sessions_plugin.dispatch("POST", ["api", "composer", "prepare"], {},
                                        {"text": text}, self.ctx)

    def write_project_command(self, stem, text):
        path = self.project / ".xueness" / "commands" / ("%s.md" % stem)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_a_project_file_command_expands_in_the_composer(self):
        self.write_project_command("git/pr", command_text(body="Review PR $1 ($ARGUMENTS)"))
        status, prepared = self.prepare("/git:pr 42")
        self.assertEqual(status, 200, prepared)
        self.assertIn("Review PR 42 (42)", json.dumps(prepared, ensure_ascii=False))
        self.assertEqual(prepared["metadata"]["commandInvocations"],
                         [{"command": "git:pr", "args": "42"}])

    def test_an_unexpanded_turn_leaks_no_command_body(self):
        self.write_project_command("quiet", command_text(body="PRIVATE-COMPOSER-MARKER"))
        status, result = self.prepare("plain text")
        self.assertEqual(status, 200, result)
        self.assertNotIn("PRIVATE-COMPOSER-MARKER", json.dumps(result, ensure_ascii=False))

    def test_a_disabled_commands_plugin_sends_the_raw_turn(self):
        self.write_project_command("raw", command_text(body="NEVER-SHIPPED"))
        plugin_runtime.set_enabled(self.state, "commands", False)
        status, prepared = self.prepare("/raw args")
        self.assertEqual(status, 200, prepared)
        self.assertNotIn("NEVER-SHIPPED", json.dumps(prepared, ensure_ascii=False))
        self.assertNotIn("commandInvocations", prepared["metadata"])
        self.assertIn("/raw args", prepared["text"])


# -- HTTP ---------------------------------------------------------------------

class HttpTests(CommandFixture):
    parts = ["api", "resources", "commands", "files"]

    def setUp(self):
        super().setUp()
        self.runs = self.base / "runs"
        self.runs.mkdir()
        self.ctx = {"state_dir": self.state, "web_runs": self.runs,
                    "project_dir": self.ws, "workspace_roots": (self.ws,)}

    def get(self, query=None):
        return plugin_runtime.dispatch_http("GET", self.parts, query or {}, {}, self.ctx)

    def test_the_files_route_belongs_to_the_commands_plugin(self):
        self.assertEqual(plugin_runtime.route_owner(self.parts), "commands")
        self.assertEqual(plugin_runtime.route_owner(["api", "resources", "commands"]), "commands")

    def test_listing_returns_sources_and_diagnostics(self):
        self.project_command("alpha")
        self.user_command("bad!name")
        status, body = self.get({"root": [str(self.ws)]})
        self.assertEqual(status, 200)
        self.assertEqual(self.ids(body["commands"]), ["alpha", "init"])
        self.assertEqual({row["source"] for row in body["commands"]}, {"project", "builtin"})
        self.assertEqual(body["root"], str(self.ws.resolve()))
        self.assertIn("command_invalid_name", self.codes(body["diagnostics"]))
        self.assertEqual(body["limits"]["commandFileBytes"],
                         file_commands.MAX_COMMAND_FILE_BYTES)
        self.assertNotIn("body", json.dumps(body, ensure_ascii=False))

    def test_shadowing_is_visible_to_the_ui(self):
        self.project_command("same")
        self.project_command("dup")
        self.user_command("dup")
        status, body = self.get({"root": [str(self.ws)]})
        self.assertEqual(status, 200)
        self.assertEqual([(row["id"], row["shadowedBy"]) for row in body["commands"]],
                         [("dup", None), ("dup", "project"), ("init", None), ("same", None)])

    def test_a_root_without_a_workspace_only_lists_user_and_stored(self):
        self.project_command("project-only")
        self.user_command("daily")
        status, body = self.get()
        self.assertEqual(status, 200)
        self.assertIsNone(body["root"])
        self.assertEqual(self.ids(body["commands"]), ["daily"])

    def test_workspace_escape_is_refused(self):
        status, body = self.get({"root": [str(self.base)]})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "workspace root not permitted")

    def test_a_link_cannot_borrow_a_permitted_root(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "x.md").write_text(command_text(description="TOKEN-HTTP"), encoding="utf-8")
        make_directory_boundary_link(self.ws / "link", outside)
        status, body = self.get({"root": [str(self.ws / "link")]})
        self.assertEqual(status, 400)
        self.assertNotIn("TOKEN-HTTP", json.dumps(body, ensure_ascii=False))

    def test_write_methods_are_not_accepted(self):
        status, _body = plugin_runtime.dispatch_http("POST", self.parts, {}, {}, self.ctx)
        self.assertEqual(status, 405)

    def test_a_disabled_plugin_is_forbidden(self):
        plugin_runtime.set_enabled(self.state, "commands", False)
        status, body = self.get({"root": [str(self.ws)]})
        self.assertEqual(status, 403)
        self.assertEqual(body["plugin"], "commands")

    def test_the_existing_resource_route_still_answers(self):
        self.resource_command("kept", prompt="STORED", description="stored")
        status, body = plugin_runtime.dispatch_http(
            "GET", ["api", "resources", "commands"], {}, {}, self.ctx)
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in body["items"]], ["kept"])


if __name__ == "__main__":
    unittest.main()
