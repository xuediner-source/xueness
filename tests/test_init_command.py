"""The built-in ``/init`` prompt command: text, entry points and refusal.

``/init`` is shipped inside the commands plugin, so these tests are about the
promises that makes it safe and useful:

* the expanded turn names the workspace target and carries every constraint the
  command is built on — read-only exploration first, only commands verified in
  the repository, an incremental edit when ``AGENTS.md`` already exists, the
  read-only compatibility files, writing through the existing file tools and
  their Gate, and a draft only while the session is in plan mode;
* the arguments a user types are appended as quoted data, never substituted
  into the template and never executed;
* the text follows the interface language (``--language``, the Web Composer
  request, or ``XUENESS_LANGUAGE``) and an unknown value falls back instead of
  refusing the turn;
* a same-named file command or stored command loses its name to the build and
  reports why, so a workspace cannot rewrite what ``/init`` asks for;
* everything disappears with the plugin: chat loader, CLI, HTTP listing, the
  Web Composer expansion;
* expansion is pure text — it writes nothing and grants nothing.

Temporary state directories and workspaces only; no network and no model.
"""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime, web
from xueness.bundled_plugins.commands import builtin_prompts, commands as store, file_commands
from xueness.bundled_plugins.sessions import cli as sessions_cli
from xueness.bundled_plugins.sessions import plugin as sessions_plugin
from xueness.cli import main as cli_main

MARKERS_ZH = ("AGENTS.md", "只读", "编造", "增量更新", "CLAUDE.md", ".zcode", "Gate", "plan")
MARKERS_EN = ("AGENTS.md", "read-only", "no source means no claim", "with edits",
              "CLAUDE.md", ".zcode", "Gate", "plan (read-only) permission mode")


def _cli(state, argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main(["--state", str(state), *argv])
    except SystemExit as exc:
        code = exc.code
    return code, stdout.getvalue(), stderr.getvalue()


class InitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.ws = self.base / "ws"
        self.state.mkdir()
        self.ws.mkdir()
        env = patch.dict(os.environ, {})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("XUENESS_LANGUAGE", None)

    # -- writers ------------------------------------------------------------

    def project_command(self, stem, text) -> Path:
        path = self.ws / ".xueness" / "commands" / ("%s.md" % stem)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def user_command(self, text, stem="init") -> Path:
        path = self.state / "commands" / ("%s.md" % stem)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def compat_command(self, stem, text) -> Path:
        path = self.ws / ".zcode" / "commands" / ("%s.md" % stem)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def resource_command(self, cid, **fields) -> Path:
        directory = self.state / "resources" / "commands"
        directory.mkdir(parents=True, exist_ok=True)
        item = {"id": cid}
        item.update(fields)
        path = directory / ("%s.json" % cid)
        path.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
        return path

    # -- readers ------------------------------------------------------------

    def entries(self, **kwargs) -> list:
        return store.load(self.state, self.ws, **kwargs)

    def expand(self, text, **kwargs):
        return store.expand(self.entries(**kwargs), text)

    def rows(self, **kwargs) -> list:
        return store.list_all(self.state, self.ws, **kwargs)["commands"]

    def row(self, source) -> dict:
        for item in self.rows():
            if item["source"] == source:
                return item
        self.fail("no %s row in %r" % (source, [item["source"] for item in self.rows()]))

    def snapshot(self) -> dict:
        return {path.relative_to(self.base).as_posix(): path.stat().st_mtime_ns
                for path in self.base.rglob("*") if path.is_file()}


# -- the shipped text ---------------------------------------------------------

class PromptTextTests(InitFixture):
    def test_the_row_exists_only_for_a_workspace(self):
        self.assertEqual([entry["id"] for entry in store.load(self.state)], [])
        self.assertEqual([row["id"] for row in store.load(self.state, self.ws)], ["init"])

    def test_the_expanded_prompt_carries_every_constraint_of_the_command(self):
        expanded, meta = self.expand("/init")
        self.assertEqual(meta, {"command": "init", "args": ""})
        for marker in MARKERS_ZH:
            self.assertIn(marker, expanded, marker)
        self.assertIn(str(self.ws / "AGENTS.md"), expanded)
        self.assertNotIn(builtin_prompts._WORKSPACE_TOKEN, expanded)
        self.assertNotIn(builtin_prompts._TARGET_TOKEN, expanded)

    def test_the_prompt_tells_the_agent_to_edit_rather_than_overwrite(self):
        expanded, _meta = self.expand("/init")
        self.assertIn("已存在", expanded)
        self.assertIn("不要整篇覆盖", expanded)
        self.assertIn("兼容来源", expanded)

    def test_the_prompt_keeps_writes_on_the_existing_approval_path(self):
        expanded, _meta = self.expand("/init")
        self.assertIn("文件写入或编辑工具", expanded)
        self.assertIn("不授予任何写权限", expanded)

    def test_plan_mode_is_answered_with_a_draft_only(self):
        for language, marker in (("zh", "草稿"), ("en", "draft")):
            expanded, _meta = self.expand("/init", language=language)
            self.assertIn("plan", expanded)
            self.assertIn(marker, expanded)
        zh, _ = self.expand("/init")
        self.assertIn("不要写入文件", zh)
        en, _ = self.expand("/init", language="en")
        self.assertIn("write no file and run no change", en)

    def test_english_names_the_same_boundaries_as_chinese(self):
        expanded, _meta = self.expand("/init", language="en")
        for marker in MARKERS_EN:
            self.assertIn(marker, expanded, marker)
        self.assertIn(str(self.ws / "AGENTS.md"), expanded)
        self.assertNotIn("你正在执行", expanded)

    def test_the_row_loses_its_body_in_a_listing(self):
        document = store.list_all(self.state, self.ws)
        self.assertNotIn("你正在执行", json.dumps(document, ensure_ascii=False))
        self.assertNotIn("body", document["commands"][0])
        row = self.row("builtin")
        self.assertEqual(row["scope"], "builtin")
        self.assertEqual(Path(row["path"]).name, "builtin_prompts.py")
        self.assertEqual(row["language"], "zh")
        self.assertTrue(row["bytes"] > 0)

    def test_expansion_writes_nothing_and_touches_no_file(self):
        before = self.snapshot()
        for text in ("/init", "/init add the release checklist", "/initx", "plain /init text"):
            store.expand(self.entries(), text)
        self.assertEqual(self.snapshot(), before)


# -- arguments ---------------------------------------------------------------

class ArgumentTests(InitFixture):
    def test_arguments_are_appended_below_the_fixed_prompt(self):
        expanded, meta = self.expand("/init 只关注 tests/ 目录")
        self.assertEqual(meta, {"command": "init", "args": "只关注 tests/ 目录"})
        self.assertTrue(expanded.endswith("只关注 tests/ 目录\n```"))
        self.assertIn("```text", expanded)
        self.assertIn("你正在执行 Xueness 的内建命令 /init", expanded)

    def test_no_arguments_means_no_quoted_block(self):
        bare, _ = self.expand("/init")
        self.assertNotIn("```text", bare)

    def test_user_text_never_reaches_the_template(self):
        hostile = ("__XUENESS_TARGET__ $ARGUMENTS $1 !`rm -rf /` @secrets.txt "
                   "$ARGUMENTS")
        expanded, _meta = self.expand("/init " + hostile)
        self.assertIn(hostile, expanded)
        self.assertNotIn("__XUENESS_TARGET__ \n", expanded)
        self.assertIn(str(self.ws / "AGENTS.md"), expanded)
        self.assertNotIn("rm -rf", expanded.replace(hostile, ""))

    def test_an_overlong_argument_is_bounded(self):
        expanded, _meta = self.expand("/init " + "x" * (builtin_prompts.MAX_ARGUMENT_CHARS + 500))
        self.assertLessEqual(len(expanded), store.EXPAND_MAX_CHARS)
        block = expanded.split("```text\n", 1)[1]
        self.assertEqual(block.count("x"), builtin_prompts.MAX_ARGUMENT_CHARS)

    def test_the_preamble_is_a_single_turn_and_stays_one_message(self):
        expanded, meta = self.expand("/init   spaced   out")
        self.assertEqual(meta["args"], "spaced   out")
        self.assertTrue(expanded.endswith("spaced   out\n```"))


# -- language ----------------------------------------------------------------

class LanguageTests(InitFixture):
    def test_the_environment_variable_is_the_fallback(self):
        with patch.dict(os.environ, {"XUENESS_LANGUAGE": "en"}):
            expanded, _meta = self.expand("/init")
        self.assertIn("You are running Xueness's built-in /init command", expanded)

    def test_an_explicit_language_beats_the_environment(self):
        with patch.dict(os.environ, {"XUENESS_LANGUAGE": "en"}):
            expanded, _meta = self.expand("/init", language="zh")
        self.assertIn("你正在执行", expanded)

    def test_an_unknown_language_falls_back_instead_of_refusing(self):
        for value in ("fr", "", None, 7, {"locale": "en"}, "EN", "zh-CN"):
            expanded, meta = self.expand("/init", language=value)
            self.assertIsNotNone(meta, repr(value))
            self.assertIn("AGENTS.md", expanded)
        en, _ = self.expand("/init", language="en-US")
        self.assertIn("You are running", en)

    def test_the_listing_row_describes_itself_in_the_chosen_language(self):
        self.assertIn("内建", self.row("builtin")["description"])
        rows = store.list_all(self.state, self.ws, language="en")["commands"]
        self.assertIn("Builtin", [row for row in rows if row["id"] == "init"][0]["description"])

    def test_normalize_language_never_raises(self):
        self.assertEqual(builtin_prompts.normalize_language("zh"), "zh")
        self.assertEqual(builtin_prompts.normalize_language("en"), "en")
        self.assertEqual(builtin_prompts.normalize_language("klingon"), "zh")
        self.assertEqual(builtin_prompts.normalize_language(None), "zh")


# -- same-named commands -----------------------------------------------------

class PrecedenceTests(InitFixture):
    def test_a_project_file_command_loses_the_name(self):
        self.project_command("init", "---\ndescription: mine\n---\nWORKSPACE-INIT-BODY\n")
        row = self.row("project")
        self.assertTrue(row["shadowed"])
        self.assertEqual(row["shadowedBy"], "builtin")
        expanded, meta = self.expand("/init")
        self.assertEqual(meta["command"], "init")
        self.assertNotIn("WORKSPACE-INIT-BODY", expanded)
        self.assertIn("AGENTS.md", expanded)

    def test_every_lower_source_loses_it_too(self):
        self.user_command("---\ndescription: user level\n---\nUSER-INIT-BODY\n")
        self.resource_command("init", prompt="STORE-INIT-BODY", description="stored")
        self.compat_command("init", "COMPAT-INIT-BODY\n")
        sources = [(row["source"], row["shadowedBy"]) for row in self.rows()]
        self.assertEqual(sources, [("builtin", None), ("project-compat", "builtin"),
                                   ("user", "builtin"), ("resource", "builtin")])
        for marker in ("USER-INIT-BODY", "STORE-INIT-BODY", "COMPAT-INIT-BODY"):
            self.assertNotIn(marker, self.expand("/init")[0])

    def test_the_read_only_compat_root_is_shadowed_as_well(self):
        self.compat_command("init", "COMPAT-INIT-BODY\n")
        self.assertEqual(self.row("project-compat")["shadowedBy"], "builtin")
        self.assertNotIn("COMPAT-INIT-BODY", self.expand("/init")[0])

    def test_init_is_a_reserved_name(self):
        self.assertTrue(file_commands.is_reserved("init"))
        self.assertTrue(file_commands.is_reserved("/init"))
        self.assertTrue(builtin_prompts.is_builtin_name("init"))
        self.assertFalse(builtin_prompts.is_builtin_name("init2"))

    def test_a_file_command_named_like_a_builtin_still_shows_its_own_diagnostics(self):
        self.project_command("init", "!`whoami`\n")
        codes = [item["code"] for item in
                 store.list_all(self.state, self.ws)["diagnostics"]]
        self.assertIn("command_shell_expansion_unsupported", codes)

    def test_inspect_names_the_file_that_lost(self):
        path = self.project_command("init", "MINE\n")
        result = store.inspect_command(self.state, "init", self.ws)
        self.assertTrue(result["ok"])
        self.assertEqual(result["command"]["source"], "builtin")
        findings = json.dumps(result["diagnostics"], ensure_ascii=False)
        self.assertIn("command_shadowed_by_builtin", findings)
        self.assertIn(path.name, findings)

    def test_the_builtin_body_is_never_read_from_the_workspace(self):
        self.project_command("init", "MINE\n")
        result = store.inspect_command(self.state, "init", self.ws, language="en")
        self.assertIn("You are running", result["content"])
        self.assertNotIn("MINE", result["content"])
        self.assertFalse(result["truncated"], "a shipped prompt is shown whole")


# -- refusal when the plugin is off ------------------------------------------

class DisabledTests(InitFixture):
    def setUp(self):
        super().setUp()
        self.runs = self.base / "runs"
        self.runs.mkdir()
        self.env = patch.dict(os.environ, {
            "XUENESS_PROVIDER": "openai",
            "XUENESS_API_BASE": "https://api.example.test/v1",
            "XUENESS_MODEL": "gpt-4o",
            "XUENESS_API_KEY": "init-test-secret",
            "ANTHROPIC_API_KEY": "",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ctx = web.build_context(self.state, self.runs, self.ws, allow_real=True)
        self.ctx["workspace_roots"] = ()

    def disable(self):
        plugin_runtime.set_enabled(self.state, "commands", False)

    def prepare(self, text, **extra):
        return sessions_plugin.dispatch("POST", ["api", "composer", "prepare"], {},
                                        {"text": text, **extra}, self.ctx)

    def test_the_chat_loader_stops_listing_it(self):
        self.assertIn("init", [entry["id"] for entry in
                               sessions_cli.load_commands(self.state, self.ws)])
        self.disable()
        self.assertEqual(sessions_cli.load_commands(self.state, self.ws), [])

    def test_the_cli_refuses_and_prints_nothing_on_stdout(self):
        self.disable()
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("commands", err)

    def test_the_http_listing_is_forbidden(self):
        self.disable()
        status, body = plugin_runtime.dispatch_http(
            "GET", ["api", "resources", "commands", "files"], {"root": [str(self.ws)]}, {},
            {"state_dir": self.state, "web_runs": self.runs, "project_dir": self.ws,
             "workspace_roots": (self.ws,)})
        self.assertEqual(status, 403)
        self.assertEqual(body["plugin"], "commands")

    def test_the_composer_sends_the_raw_turn(self):
        self.disable()
        status, prepared = self.prepare("/init make the file")
        self.assertEqual(status, 200, prepared)
        self.assertIn("/init make the file", prepared["text"])
        self.assertNotIn("AGENTS.md", json.dumps(prepared, ensure_ascii=False))
        self.assertNotIn("commandInvocations", prepared["metadata"])


# -- CLI surface -------------------------------------------------------------

class CliTests(InitFixture):
    def test_list_shows_the_builtin_row_tagged(self):
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("- /init [补充说明] (builtin)", out)
        self.assertIn("built-in prompt shipped with the commands plugin", out)

    def test_list_follows_the_cli_language(self):
        _code, zh, _err = _cli(self.state, ["--language", "zh", "commands", "list",
                                            "--root", str(self.ws)])
        _code, en, err = _cli(self.state, ["--language", "en", "commands", "list",
                                           "--root", str(self.ws)])
        self.assertEqual(_code, 0, err)
        self.assertIn("Builtin: study the workspace", en)
        self.assertNotIn("Builtin", zh)

    def test_list_json_reports_the_builtin_source(self):
        code, out, err = _cli(self.state, ["commands", "list", "--root", str(self.ws), "--json"])
        self.assertEqual(code, 0, err)
        document = json.loads(out)
        row = [item for item in document["commands"] if item["id"] == "init"][0]
        self.assertEqual(row["source"], "builtin")
        self.assertEqual(row["rootPath"], str(self.ws))
        self.assertNotIn("body", row)

    def test_inspect_prints_the_prompt_and_its_own_expansion_note(self):
        code, out, err = _cli(self.state, ["--language", "en", "commands", "inspect", "init",
                                           "--root", str(self.ws)])
        self.assertEqual(code, 0, err)
        self.assertIn("Command: /init", out)
        self.assertIn("source: builtin (scope builtin)", out)
        self.assertIn("language: en", out)
        self.assertIn("the arguments are appended below the shipped prompt as quoted data", out)
        self.assertIn("no workspace file can override this text", out)
        self.assertNotIn("$ARGUMENTS and $1..$9 only", out)
        self.assertIn("You are running Xueness's built-in /init command", out)
        self.assertIn("AGENTS.md", out)

    def test_chat_commands_lists_it_too(self):
        reply = plugin_runtime.dispatch_slash(
            "/commands", {"state_dir": self.state, "root": str(self.ws),
                          "session": {"root": str(self.ws)}, "language": "en"})
        self.assertIn("- /init", reply)
        self.assertIn("Builtin: study the workspace", reply)


# -- Web surface -------------------------------------------------------------

class ComposerTests(InitFixture):
    def setUp(self):
        super().setUp()
        self.runs = self.base / "runs"
        self.runs.mkdir()
        self.env = patch.dict(os.environ, {
            "XUENESS_PROVIDER": "openai",
            "XUENESS_API_BASE": "https://api.example.test/v1",
            "XUENESS_MODEL": "gpt-4o",
            "XUENESS_API_KEY": "init-test-secret",
            "ANTHROPIC_API_KEY": "",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ctx = web.build_context(self.state, self.runs, self.ws, allow_real=True)
        self.ctx["workspace_roots"] = ()

    def prepare(self, text, **extra):
        return sessions_plugin.dispatch("POST", ["api", "composer", "prepare"], {},
                                        {"text": text, **extra}, self.ctx)

    def test_the_composer_expands_init_for_the_session_workspace(self):
        status, prepared = self.prepare("/init focus on the packaging")
        self.assertEqual(status, 200, prepared)
        self.assertIn("AGENTS.md", prepared["text"])
        self.assertIn(str(self.ws / "AGENTS.md"), prepared["text"])
        self.assertIn("focus on the packaging", prepared["text"])
        self.assertEqual(prepared["metadata"]["commandInvocations"],
                         [{"command": "init", "args": "focus on the packaging"}])

    def test_the_request_language_selects_the_text(self):
        status, prepared = self.prepare("/init", language="en")
        self.assertEqual(status, 200, prepared)
        self.assertIn("You are running Xueness's built-in /init command", prepared["text"])

    def test_an_unknown_language_is_data_not_a_refusal(self):
        status, prepared = self.prepare("/init", language="klingon")
        self.assertEqual(status, 200, prepared)
        self.assertIn("你正在执行", prepared["text"])

    def test_the_slash_router_does_not_answer_init_itself(self):
        self.assertIsNone(plugin_runtime.slash_owner("init"))
        self.assertIsNone(plugin_runtime.dispatch_slash(
            "/init", {"state_dir": self.state, "root": str(self.ws), "session": {}}))


class HttpListingTests(InitFixture):
    parts = ["api", "resources", "commands", "files"]

    def setUp(self):
        super().setUp()
        self.runs = self.base / "runs"
        self.runs.mkdir()
        self.ctx = {"state_dir": self.state, "web_runs": self.runs,
                    "project_dir": self.ws, "workspace_roots": (self.ws,)}

    def get(self, query=None):
        return plugin_runtime.dispatch_http("GET", self.parts, query or {}, {}, self.ctx)

    def test_the_listing_offers_init_without_its_body(self):
        status, body = self.get({"root": [str(self.ws)]})
        self.assertEqual(status, 200, body)
        row = [item for item in body["commands"] if item["id"] == "init"][0]
        self.assertEqual(row["source"], "builtin")
        self.assertFalse(row["shadowed"])
        self.assertNotIn("body", json.dumps(body, ensure_ascii=False))
        self.assertNotIn("你正在执行", json.dumps(body, ensure_ascii=False))

    def test_the_language_query_selects_the_description(self):
        _status, body = self.get({"root": [str(self.ws)], "language": ["en"]})
        row = [item for item in body["commands"] if item["id"] == "init"][0]
        self.assertEqual(row["argumentHint"], "[notes]")
        self.assertIn("Builtin", row["description"])

    def test_without_a_root_there_is_nothing_to_target(self):
        status, body = self.get()
        self.assertEqual(status, 200, body)
        self.assertEqual([item for item in body["commands"] if item["id"] == "init"], [])

    def test_a_workspace_outside_the_fence_is_refused_before_any_row(self):
        status, body = self.get({"root": [str(self.base / "elsewhere")]})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "workspace root not permitted"})


if __name__ == "__main__":
    unittest.main()
