"""Secure composer catalog, preparation cache, and draft Git branch selection."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from xueness import web, plugin_runtime
from xueness.bundled_plugins.sessions import composer_api, plugin as sessions_plugin
from xueness.plugin_runtime import set_enabled


class ComposerApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / "project"
        self.project.mkdir()
        self.runs = base / "runs"
        self.state = base / "state"
        self.ctx = web.build_context(self.state, self.runs, self.project, allow_real=True)
        self.ctx["workspace_roots"] = ()
        self.provider_env = patch.dict(os.environ, {
            "XUENESS_PROVIDER": "openai",
            "XUENESS_API_BASE": "https://api.example.test/v1",
            "XUENESS_MODEL": "gpt-4o",
            "XUENESS_API_KEY": "composer-test-secret",
            "ANTHROPIC_API_KEY": "",
        })
        self.provider_env.start()
        self.addCleanup(self.provider_env.stop)

    def call(self, method, parts, data=None, query=None):
        return sessions_plugin.dispatch(method, parts, query or {}, data or {}, self.ctx)

    def prepare(self, **payload):
        body = {"text": "Inspect this workspace", **payload}
        return self.call("POST", ["api", "composer", "prepare"], body)

    def test_catalog_is_root_scoped_and_isolated_root_has_no_shared_choices(self):
        (self.project / "note.txt").write_text("hello", encoding="utf-8")
        other = self.runs / "other-session"
        other.mkdir()
        (other / "private.txt").write_text("private", encoding="utf-8")
        current = self.ctx["store"].new("same workspace", self.project)
        unrelated_root = self.runs / "unrelated"
        unrelated_root.mkdir()
        unrelated = self.ctx["store"].new("different workspace", unrelated_root)

        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertEqual(result["root"], str(self.project.resolve()))
        self.assertEqual(result["isolatedRoot"], str(self.runs.resolve()))
        self.assertIn({"id": "note.txt", "label": "note.txt"}, result["files"])
        self.assertIn(current["id"], {item["id"] for item in result["sessions"]})
        self.assertNotIn(unrelated["id"], {item["id"] for item in result["sessions"]})
        self.assertTrue(result["allowReal"])

        status, isolated = self.call("GET", ["api", "composer"], query={"root": [str(self.runs)]})
        self.assertEqual(status, 200)
        self.assertEqual(isolated["files"], [])
        self.assertEqual(isolated["sessions"], [])

    def test_catalog_rejects_a_root_outside_declared_roots(self):
        status, result = self.call("GET", ["api", "composer"], query={"root": ["/etc"]})
        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "workspace root not permitted"})

    def test_git_workspace_file_catalog_prunes_sensitive_and_generated_directories(self):
        subprocess.run(["git", "init", "--quiet", str(self.project)],
                       check=True, capture_output=True, text=True)
        (self.project / "sample.txt").write_text("pick me", encoding="utf-8")
        (self.project / "@notes.md").write_text("user file", encoding="utf-8")
        ignored = (
            ".git/privatekey", ".git/hooks/pre-commit", ".hg/store/data",
            ".svn/wc.db", "node_modules/pkg/index.js", "__pycache__/cache.pyc",
            ".venv/bin/python", "venv/bin/python", "dist/bundle.js", "build/output.js",
            ".state/privatekey", ".web-runs/session.json",
        )
        for relative in ignored:
            target = self.project / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("sensitive/generated", encoding="utf-8")

        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        ids = {item["id"] for item in result["files"]}
        self.assertIn("sample.txt", ids)
        self.assertIn("@notes.md", ids)
        self.assertNotIn(".git/config", ids)
        self.assertNotIn(".git/privatekey", ids)
        self.assertFalse(any(path.startswith(tuple(name + "/" for name in (
            ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv",
            "venv", "dist", "build", ".state", ".web-runs",
        ))) for path in ids))
        status, prepared = self.prepare(input={"files": [".git/privatekey"]})
        self.assertEqual(status, 400)
        self.assertEqual(prepared["error"], "workspace file unavailable")
        set_enabled(self.state, "git", False)
        git_root = str((self.project / ".git").resolve())
        status, git_root_catalog = self.call("GET", ["api", "composer"], query={"root": [git_root]})
        self.assertEqual(status, 200)
        self.assertEqual(git_root_catalog["files"], [])
        status, prepared = self.call("POST", ["api", "composer", "prepare"], {
            "text": "Read internal file", "root": git_root,
            "provider_id": "", "model": "gpt-4o", "input": {"files": ["config"]},
        })
        self.assertEqual(status, 400)
        self.assertEqual(prepared["error"], "workspace file unavailable")

    def test_prepare_caches_real_input_without_creating_a_session_and_consumes_once(self):
        before = self.ctx["store"].list()
        status, result = self.prepare(input={})
        self.assertEqual(status, 200)
        self.assertEqual(result["root"], str(self.project.resolve()))
        self.assertEqual(result["text"], "Inspect this workspace")
        self.assertRegex(result["token"], r"^[0-9a-f]{32}$")
        self.assertEqual(before, self.ctx["store"].list())
        prepared = composer_api.consume_prepared(self.ctx, result["token"], self.project)
        self.assertEqual(prepared["text"], result["text"])
        self.assertEqual(prepared["metadata"], result["metadata"])
        with self.assertRaisesRegex(ValueError, "prepared input invalid or expired"):
            composer_api.consume_prepared(self.ctx, result["token"], self.project)

    def test_prepared_token_survives_per_request_context_shallow_copies(self):
        prepare_ctx = {**self.ctx, "handler": object()}
        consume_ctx = {**self.ctx, "handler": object()}
        self.assertIs(prepare_ctx["_composer_prepared_inputs"],
                      consume_ctx["_composer_prepared_inputs"])
        self.assertIs(prepare_ctx["_composer_prepared_lock"],
                      consume_ctx["_composer_prepared_lock"])
        status, prepared = sessions_plugin.dispatch(
            "POST", ["api", "composer", "prepare"], {},
            {"text": "survive request context copies"}, prepare_ctx,
        )
        self.assertEqual(status, 200)
        consumed = composer_api.consume_prepared(consume_ctx, prepared["token"], self.project)
        self.assertEqual(consumed["text"], "survive request context copies")
        with self.assertRaisesRegex(ValueError, "prepared input invalid or expired"):
            composer_api.consume_prepared(prepare_ctx, prepared["token"], self.project)

    def test_prepare_context_metadata_omits_bodies_base64_and_credentials(self):
        png = b"\x89PNG\r\n\x1a\n" + b"bounded-png"
        encoded = base64.b64encode(png).decode("ascii")
        status, result = self.prepare(input={
            "attachments": [{"name": "capture.png", "mimeType": "image/png", "data": encoded}],
            "goal": True,
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["goal"])
        self.assertIn(encoded, result["text"])
        self.assertEqual(result["metadata"]["attachments"][0]["path"], "capture.png")
        self.assertNotIn(encoded, json.dumps(result["metadata"]))
        self.assertNotIn("composer-test-secret", json.dumps(result))
        self.assertNotIn("https://api.example.test", json.dumps(result))
        self.assertEqual(result["metadata"]["modelSelection"]["model"], "gpt-4o")
        consumed = composer_api.consume_prepared(self.ctx, result["token"], self.project)
        self.assertIn(encoded, consumed["text"])
        self.assertEqual(consumed["metadata"], result["metadata"])

    def test_mixed_media_and_reference_context_keeps_provider_multimodal_suffix_valid(self):
        from xueness.bundled_plugins.providers import provider
        prior = self.ctx["store"].new("previous", self.project)
        prior["messages"].append({"role": "assistant", "content": "Reference answer"})
        self.ctx["store"].save(prior)
        skills = self.state / "resources" / "skills"
        skills.mkdir(parents=True)
        (skills / "guide.json").write_text(json.dumps({
            "id": "guide", "name": "Guide", "body": "Reference skill body", "enabled": True,
        }), encoding="utf-8")
        encoded = base64.b64encode(b"\x89PNG\r\n\x1a\nvalid-ish").decode("ascii")
        status, result = self.prepare(input={
            "attachments": [{"name": "photo.png", "mimeType": "image/png", "data": encoded}],
            "sessions": [prior["id"]], "skills": ["guide"], "plugins": ["files"],
        })
        self.assertEqual(status, 200)
        body_text, media = provider._split_multimodal(result["text"])
        self.assertIn("Reference answer", body_text)
        self.assertIn("Reference skill body", body_text)
        self.assertIn("Selected enabled plugins", body_text)
        self.assertEqual(media[0]["data"], encoded)

    def test_command_expansion_is_audited_and_composes_with_context_and_media(self):
        from xueness.bundled_plugins.providers import provider
        previous = self.ctx["store"].new("previous", self.project)
        previous["messages"].append({"role": "assistant", "content": "Prior reference"})
        self.ctx["store"].save(previous)
        skill_dir = self.state / "resources" / "skills"
        skill_dir.mkdir(parents=True)
        (skill_dir / "guide.json").write_text(json.dumps({
            "id": "guide", "name": "Guide", "body": "Skill reference", "enabled": True,
        }), encoding="utf-8")
        command_dir = self.state / "resources" / "commands"
        command_dir.mkdir(parents=True)
        (command_dir / "review.json").write_text(json.dumps({
            "id": "review", "name": "Review", "prompt": "Review issue: $ARGUMENTS",
        }), encoding="utf-8")
        encoded = base64.b64encode(b"\x89PNG\r\n\x1a\nvalid-ish").decode("ascii")
        status, prepared = self.prepare(text="/review issue 42", input={
            "attachments": [{"name": "photo.png", "mimeType": "image/png", "data": encoded}],
            "sessions": [previous["id"]], "skills": ["guide"],
        })
        self.assertEqual(status, 200)
        body, media = provider._split_multimodal(prepared["text"])
        self.assertIn("Review issue: issue 42", body)
        self.assertIn("Prior reference", body)
        self.assertIn("Skill reference", body)
        self.assertEqual(media[0]["data"], encoded)
        self.assertEqual(prepared["metadata"]["commandInvocations"], [
            {"command": "review", "args": "issue 42"},
        ])

    def test_prepare_checks_media_capability_and_signature(self):
        png = base64.b64encode(b"not a png").decode("ascii")
        status, result = self.prepare(input={
            "attachments": [{"name": "bad.png", "mimeType": "image/png", "data": png}],
        })
        self.assertEqual(status, 400)
        self.assertIn("attachment type", result["error"])

        with patch.dict(os.environ, {"XUENESS_MODEL": "plain-text-model"}):
            good_png = base64.b64encode(b"\x89PNG\r\n\x1a\ncontent").decode("ascii")
            status, result = self.prepare(input={
                "attachments": [{"name": "capture.png", "mimeType": "image/png", "data": good_png}],
            })
        self.assertEqual(status, 400)
        self.assertIn("does not support", result["error"])

    def test_prepare_requires_a_configured_real_provider_and_respects_allow_real(self):
        with patch.dict(os.environ, {"XUENESS_MODEL": "", "XUENESS_API_KEY": ""}):
            status, result = self.prepare()
        self.assertEqual(status, 400)
        self.assertIn("Configure a model", result["error"])
        self.assertEqual(self.ctx["store"].list(), [])

        self.ctx["allow_real"] = False
        status, result = self.prepare()
        self.assertEqual(status, 403)
        self.assertIn("real provider disabled", result["error"])

    def test_saved_default_does_not_replace_the_environment_catalog_entry(self):
        from xueness.bundled_plugins.providers import default_selection, provider_config, providers_api
        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, {
            "id": "saved", "name": "Saved model", "baseUrl": "https://saved.example.test/v1",
            "model": "saved-model", "apiKey": "saved-test-secret",
        }, self.ctx)
        self.assertEqual(status, 200)
        default_selection.save(self.state, {"providerId": "saved", "model": "saved-model"})
        self.ctx["allow_real"] = False

        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertEqual([(model["id"], model["model"]) for model in result["models"]],
                         [("saved", "saved-model"), ("", "gpt-4o")])
        self.assertNotIn("saved-test-secret", json.dumps(result))
        self.assertNotIn("composer-test-secret", json.dumps(result))
        # Catalog construction must not change default resolution for runs.
        self.assertEqual(provider_config.resolve(self.state).model, "saved-model")

        with patch.dict(os.environ, {"XUENESS_MODEL": "", "XUENESS_API_KEY": ""}):
            status, result = self.call("GET", ["api", "composer"])
            self.assertEqual(status, 200)
            self.assertEqual([(model["id"], model["model"]) for model in result["models"]],
                             [("saved", "saved-model")])
            self.assertEqual(provider_config.resolve(self.state).model, "saved-model")

    def test_model_catalog_uses_public_reasoning_levels_including_max(self):
        from xueness.bundled_plugins.providers import providers_api
        payload = {
            "id": "gpt6", "name": "GPT 6 Sol", "baseUrl": "https://api.example.test/v1",
            "model": "gpt-6-sol", "apiKey": "profile-secret",
            "reasoningLevels": ["low", "medium", "high", "xhigh", "max"],
        }
        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, payload, self.ctx)
        self.assertEqual(status, 200)
        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        model = next(item for item in result["models"] if item["id"] == "gpt6")
        self.assertEqual(model["reasoningLevels"], payload["reasoningLevels"])
        self.assertEqual(set(model), {"id", "name", "model", "configured", "protocol", "capabilities", "reasoningLevels"})
        self.assertNotIn("profile-secret", json.dumps(result))
        status, prepared = self.call("POST", ["api", "composer", "prepare"], {
            "text": "Use the selected reasoning", "provider_id": "gpt6", "model": "gpt-6-sol",
            "reasoning_effort": "max",
        })
        self.assertEqual(status, 200)
        self.assertEqual(prepared["metadata"]["modelSelection"]["reasoning_effort"], "max")

    def test_coding_plan_environment_catalog_uses_endpoint_and_exact_model(self):
        from xueness.bundled_plugins.providers import provider_config, providers_api
        coding_plan = "https://ark.cn-beijing.volces.com/api/coding/v3"
        for model, expected in (
            ("deepseek-v4.1-flash", ["low", "medium", "high"]),
            ("deepseek-v4.1-flash-preview", []),
        ):
            with patch.dict(os.environ, {
                "XUENESS_PROVIDER": "openai",
                "XUENESS_API_BASE": coding_plan,
                "XUENESS_MODEL": model,
                "XUENESS_API_KEY": "isolated-environment-test-key",
                "ANTHROPIC_API_KEY": "",
            }):
                status, result = self.call("GET", ["api", "composer"])
            self.assertEqual(status, 200)
            environment_model = next(item for item in result["models"] if item["id"] == "")
            self.assertEqual(environment_model["model"], model)
            self.assertEqual(environment_model["reasoningLevels"], expected)
            self.assertNotIn("isolated-environment-test-key", json.dumps(result))

        status, _ = providers_api.dispatch("POST", ["api", "providers"], {}, {
            "id": "ark", "name": "Ark Coding Plan", "baseUrl": coding_plan,
            "model": "deepseek-v4.1-flash", "apiKey": "isolated-profile-test-key",
        }, self.ctx)
        self.assertEqual(status, 200)
        with self.assertRaisesRegex(ValueError, "does not declare support"):
            provider_config.resolve(
                self.state, "ark", "deepseek-v4.1-flash-preview", reasoning_effort="low")

        # The shared environment catalog must not infer OpenAI-style effort for
        # the same model name when the configured protocol is Anthropic.
        with patch.dict(os.environ, {
            "XUENESS_PROVIDER": "anthropic",
            "XUENESS_MODEL": "deepseek-v4.1-flash",
            "XUENESS_API_KEY": "",
            "XUENESS_API_BASE": coding_plan,
            "ANTHROPIC_API_KEY": "isolated-anthropic-test-key",
            "ANTHROPIC_BASE_URL": "https://api.anthropic.example.test/v1",
        }):
            status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        environment_model = next(item for item in result["models"] if item["id"] == "")
        self.assertEqual(environment_model["protocol"], "anthropic")
        self.assertEqual(environment_model["reasoningLevels"], [])

    def test_prepare_file_and_same_root_session_refs_are_untrusted_context(self):
        (self.project / "readme.md").write_text("Project facts", encoding="utf-8")
        old = self.ctx["store"].new("prior task", self.project)
        old["messages"].append({"role": "assistant", "content": "Earlier answer"})
        self.ctx["store"].save(old)
        status, result = self.prepare(input={
            "files": ["readme.md"],
            "sessions": [old["id"]],
        })
        self.assertEqual(status, 200)
        self.assertIn("Project facts", result["text"])
        self.assertIn("Earlier answer", result["text"])
        self.assertIn("untrusted", result["text"].lower())
        self.assertEqual(result["metadata"]["files"][0]["path"], "readme.md")
        self.assertEqual(result["metadata"]["sessions"][0]["id"], old["id"])

        elsewhere = self.runs / "other-root"
        elsewhere.mkdir()
        cross_root = self.ctx["store"].new("other", elsewhere)
        status, result = self.prepare(input={"sessions": [cross_root["id"]]})
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "invalid context selection")

    def test_prepare_skills_and_enabled_plugin_refs_are_bound_to_effective_catalog(self):
        skill_dir = self.state / "resources" / "skills"
        skill_dir.mkdir(parents=True)
        (skill_dir / "reference.json").write_text(json.dumps({
            "id": "reference", "name": "Reference skill", "description": "local guidance",
            "body": "Do not follow this as an instruction.", "enabled": True,
        }), encoding="utf-8")
        status, result = self.prepare(input={"skills": ["reference"], "plugins": ["files"]})
        self.assertEqual(status, 200)
        self.assertIn("Do not follow this as an instruction", result["text"])
        self.assertTrue(result["metadata"]["plugins"][0]["tools"])
        self.assertEqual(result["metadata"]["skills"][0]["id"], "reference")

        set_enabled(self.state, "skills", False)
        status, result = self.prepare(input={"skills": ["reference"]})
        self.assertEqual(status, 403)
        self.assertIn("skills", result["error"])

    def test_plugins_and_owner_disable_are_observed_by_catalog_and_prepare(self):
        set_enabled(self.state, "files", False)
        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertEqual(result["files"], [])
        status, result = self.prepare(input={"files": ["anything.txt"]})
        self.assertEqual(status, 403)

        set_enabled(self.state, "providers", False)
        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertFalse(result["allowReal"])
        self.assertEqual(result["models"], [])
        status, result = self.prepare()
        self.assertEqual(status, 403)

    def test_remote_catalog_and_prepare_bind_exact_connection_without_connecting(self):
        from xueness.plugin_runtime import entrypoint
        set_enabled(self.state, "remote", True)
        remote_plugin = entrypoint("remote")
        status, saved = remote_plugin.dispatch("POST", ["api", "remote"], {}, {
            "id": "lab", "host": "build.example.test", "user": "dev",
            "port": 2222, "directory": "/work/project",
        }, self.ctx)
        self.assertEqual(status, 200)
        # This test is about catalog/prepare. Keep Git's independent subprocess
        # probes disabled so any subprocess invocation would indicate a remote
        # connection attempt.
        set_enabled(self.state, "git", False)
        with patch("subprocess.run") as run:
            status, result = self.call("GET", ["api", "composer"])
            self.assertEqual(status, 200)
            row = result["remoteConnections"][0]
            self.assertEqual(row["label"], "dev@build.example.test:/work/project")
            status, prepared = self.prepare(input={"remote": "lab"})
            self.assertEqual(status, 200)
            self.assertIn("remote_exec", prepared["text"])
            self.assertIn("/work/project", prepared["text"])
            self.assertEqual(prepared["metadata"]["remote"], {"id": "lab", "digest": row["digest"]})
            self.assertIn('"connection": "lab"', prepared["text"])
            self.assertIn('"connection_digest": "' + row["digest"] + '"', prepared["text"])
            self.assertIn("selected permissions, Plan mode and server tool gates", prepared["text"])
            run.assert_not_called()
        set_enabled(self.state, "remote", False)
        status, result = self.prepare(input={"remote": "lab"})
        self.assertEqual(status, 403)

    def test_background_count_is_workspace_scoped_and_read_only(self):
        from xueness.bundled_plugins.workflows.workflows import WorkflowStore
        store = WorkflowStore(self.state)
        plan = {"nodes": [{"id": "step", "kind": "command", "argv": ["echo", "ok"]}]}
        active = store.create(plan, self.project)
        elsewhere = self.runs / "other"
        elsewhere.mkdir()
        store.create(plan, elsewhere)
        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertEqual(result["backgroundCount"], 1)
        store.update(active["id"], lambda row: row.update(status="completed"))
        self.assertEqual(self.call("GET", ["api", "composer"])[1]["backgroundCount"], 0)

    def test_token_is_root_bound_expires_and_is_single_use(self):
        status, result = self.prepare()
        self.assertEqual(status, 200)
        with self.assertRaisesRegex(ValueError, "prepared input invalid or expired"):
            composer_api.consume_prepared(self.ctx, result["token"], self.runs)

        token = result["token"]
        self.ctx[composer_api._CACHE_KEY][token]["expiresAt"] = 0
        with self.assertRaisesRegex(ValueError, "prepared input invalid or expired"):
            composer_api.consume_prepared(self.ctx, token, self.project)

    def test_isolated_parent_token_accepts_only_session_shaped_direct_child(self):
        status, result = self.call("POST", ["api", "composer", "prepare"], {
            "text": "Create an isolated task", "root": str(self.runs),
        })
        self.assertEqual(status, 200)
        sid = "a" * 32
        child = self.runs / sid
        child.mkdir()
        consumed = composer_api.consume_prepared(self.ctx, result["token"], child)
        self.assertEqual(consumed["text"], "Create an isolated task")

        status, result = self.call("POST", ["api", "composer", "prepare"], {
            "text": "Again", "root": str(self.runs),
        })
        self.assertEqual(status, 200)
        nested = child / "nested"
        nested.mkdir()
        with self.assertRaisesRegex(ValueError, "prepared input invalid or expired"):
            composer_api.consume_prepared(self.ctx, result["token"], nested)

    def _init_git(self):
        subprocess.run(["git", "init", "-b", "main"], cwd=self.project, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "config", "user.name", "Composer Test"], cwd=self.project, check=True)
        subprocess.run(["git", "config", "user.email", "composer@example.test"], cwd=self.project, check=True)
        (self.project / "tracked.txt").write_text("main\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=self.project, check=True)
        subprocess.run(["git", "commit", "-m", "main"], cwd=self.project, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "branch", "next"], cwd=self.project, check=True)

    def test_git_catalog_and_branch_switch_require_clean_idle_workspace(self):
        self._init_git()
        status, result = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertEqual(result["git"]["branch"], "main")
        self.assertIn("next", result["git"]["branches"])

        status, switched = self.call("POST", ["api", "composer", "branch"], {
            "root": str(self.project), "branch": "next",
        })
        self.assertEqual(status, 200)
        self.assertEqual(switched["branch"], "next")

        (self.project / "untracked.txt").write_text("dirty", encoding="utf-8")
        status, result = self.call("POST", ["api", "composer", "branch"], {
            "root": str(self.project), "branch": "main",
        })
        self.assertEqual(status, 409)
        self.assertIn("uncommitted", result["error"])

        (self.project / "untracked.txt").unlink()
        session = self.ctx["store"].new("running", self.project)
        self.ctx["running"].add(session["id"])
        status, result = self.call("POST", ["api", "composer", "branch"], {
            "root": str(self.project), "branch": "main",
        })
        self.assertEqual(status, 409)
        self.assertIn("active run", result["error"])

    def test_catalog_reads_branches_without_scanning_working_tree(self):
        from xueness.bundled_plugins.git import git_api
        self._init_git()
        with patch.object(git_api, "_git_status", side_effect=AssertionError("navigation must not scan status")):
            status, catalog = self.call("GET", ["api", "composer"])
            self.assertEqual(status, 200)
            self.assertEqual(catalog["git"], {"branch": "main", "branches": ["main", "next"]})
            subprocess.run(["git", "checkout", "--detach", "HEAD"], cwd=self.project,
                           check=True, capture_output=True)
            self.assertEqual(self.call("GET", ["api", "composer"])[1]["git"]["branch"], "HEAD (detached)")

    def test_optional_git_failure_does_not_break_file_or_model_choices(self):
        from xueness.bundled_plugins.git import git_api
        (self.project / "note.txt").write_text("hello", encoding="utf-8")
        for code in (400, 404, 501):
            with patch.object(git_api, "_git_branch_catalog", side_effect=git_api.GitApiError(code, "unavailable")):
                status, catalog = self.call("GET", ["api", "composer"])
            self.assertEqual(status, 200)
            self.assertNotIn("git", catalog)
            self.assertIn({"id": "note.txt", "label": "note.txt"}, catalog["files"])
            self.assertTrue(catalog["models"])

    def test_branch_catalog_supports_empty_repository_with_bounded_commands(self):
        from xueness.bundled_plugins.git import git_api
        subprocess.run(["git", "init", "-b", "main"], cwd=self.project, check=True, capture_output=True)
        with patch.object(git_api, "run_external", wraps=git_api.run_external) as run:
            self.assertEqual(git_api._git_branch_catalog(str(self.project)), {"branch": "main", "branches": []})
        self.assertEqual(len(run.call_args_list), 2)
        self.assertTrue(all(call.kwargs["timeout"] == 2 for call in run.call_args_list))

    def test_git_branch_rejects_unknown_or_creation_requests(self):
        self._init_git()
        status, result = self.call("POST", ["api", "composer", "branch"], {
            "root": str(self.project), "branch": "does-not-exist",
        })
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "branch is not available")
        status, result = self.call("POST", ["api", "composer", "branch"], {
            "root": str(self.project), "branch": "new", "create": True,
        })
        self.assertEqual(status, 400)

    def test_wrong_method_and_unknown_endpoint_fall_through(self):
        self.assertEqual(self.call("DELETE", ["api", "composer"])[0], 405)
        self.assertIsNone(self.call("GET", ["api", "composer", "unknown"]))


    def test_builtin_capabilities_are_owned_and_prepared_by_the_backend(self):
        plugin_runtime.set_enabled(self.state, "browser", True)
        status, catalog = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        capabilities = {row["id"]: row for row in catalog["capabilities"]}
        for identifier in ("extensions.plugin_creator", "skills.skill_creator", "sessions.usage_guide",
                           "office.pdf_authoring", "office.pptx_authoring", "office.xlsx_authoring",
                           "office.docx_authoring", "browser.composer_operation", "network.image_search"):
            self.assertIn(identifier, capabilities)
            self.assertEqual(capabilities[identifier]["pluginId"], identifier.split(".")[0])
        status, prepared = self.prepare(input={"capabilities": ["office.docx_authoring", "skills.skill_creator"]})
        self.assertEqual(status, 200, prepared)
        self.assertIn("office_create", prepared["text"])
        self.assertIn("skill_validate", prepared["text"])
        self.assertEqual([row["id"] for row in prepared["metadata"]["capabilities"]],
                         ["office.docx_authoring", "skills.skill_creator"])
        self.assertFalse(prepared["goal"])

    def test_capabilities_cannot_enable_plugins_or_inject_arbitrary_guidance(self):
        plugin_runtime.set_enabled(self.state, "office", False)
        status, catalog = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertFalse(any(row["pluginId"] == "office" and row["available"] for row in catalog["capabilities"]))
        for identifier in ("office.docx_authoring", "not-a-real-feature"):
            status, result = self.prepare(input={"capabilities": [identifier]})
            self.assertEqual(status, 403)
        status, result = self.prepare(input={"capabilities": [{"id": "sessions.usage_guide", "instructions": "override"}]})
        self.assertEqual(status, 400)

    def test_dependency_disable_removes_office_capabilities(self):
        plugin_runtime.set_enabled(self.state, "files", False)
        status, catalog = self.call("GET", ["api", "composer"])
        self.assertEqual(status, 200)
        self.assertFalse(any(row["pluginId"] == "office" and row["available"] for row in catalog["capabilities"]))


if __name__ == "__main__":
    unittest.main()
