"""Plugin composition profiles: pure data selecting which plugins are on.

A profile may only name allowlisted plugin ids with booleans, and applying one
may only move those switches. Everything here runs on an isolated state
directory, offline, and checks that a profile never reaches a workspace, a Gate,
an approval rule or a permission mode.
"""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from xueness import plugin_runtime
from xueness.bundled_plugins.extensions import profiles
from xueness.cli import main as cli_main

ROOT = Path(__file__).resolve().parents[1]
BUILT_INS = ("minimal", "lightweight", "standard")


class ProfileFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"

    def test_the_shipped_tiers_are_boolean_switches_over_the_allowlist(self):
        table = profiles.built_in()
        self.assertTrue(set(BUILT_INS) <= set(table), set(table))
        for name, entry in table.items():
            self.assertTrue(profiles.PROFILE_NAME.match(name), name)
            for plugin_id, value in entry["plugins"].items():
                self.assertIn(plugin_id, plugin_runtime.PLUGIN_IDS, "%s in %s" % (plugin_id, name))
                self.assertIs(type(value), bool, "%s/%s in %s" % (plugin_id, value, name))
        self.assertIsNone(table["minimal"]["extends"])
        self.assertEqual(table["lightweight"]["extends"], "minimal")

    def test_the_built_in_tiers_only_narrow_the_plugin_set(self):
        resolved = {name: profiles.resolve(self.state, name)["plugins"] for name in BUILT_INS}
        on = {name: {pid for pid, value in table.items() if value} for name, table in resolved.items()}
        self.assertTrue(on["minimal"] <= on["lightweight"] <= on["standard"], on)
        self.assertLess(len(on["minimal"]), len(on["lightweight"]))
        self.assertLess(len(on["lightweight"]), len(on["standard"]))
        # A profile never names code, paths or commands: only ids and booleans.
        document = json.loads((ROOT / "xueness/bundled_plugins/extensions/profiles.json").read_text(encoding="utf-8"))
        self.assertEqual(set(document), {"apiVersion", "profiles"})
        for row in document["profiles"]:
            self.assertEqual(set(row) <= profiles.PROFILE_FIELDS, True, row)

    def test_the_lightweight_tier_keeps_the_local_runtime_and_its_owner_on(self):
        plugins = profiles.resolve(self.state, "lightweight")["plugins"]
        for plugin_id in ("sessions", "providers", "files", "shell", "extensions"):
            self.assertIs(plugins[plugin_id], True, plugin_id)


class CustomProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        self.directory = self.state / profiles.CUSTOM_DIRECTORY
        self.directory.mkdir(parents=True)

    def write(self, name, document):
        path = self.directory / (name + ".json")
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def test_a_custom_profile_is_read_as_data_and_can_name_more_than_the_builtin_files(self):
        self.write("local", {"extends": "minimal", "plugins": {"git": True}})
        resolved = profiles.resolve(self.state, "local")
        self.assertEqual(resolved["source"], "custom")
        self.assertEqual(resolved["chain"], ["local", "minimal"])
        self.assertIs(resolved["plugins"]["git"], True)
        self.assertIs(resolved["plugins"]["browser"], False)

    def test_a_python_file_beside_the_profiles_is_never_a_profile(self):
        self.write("good", {"plugins": {"git": True}})
        (self.directory / "payload.py").write_text("import os\n", encoding="utf-8")
        self.assertEqual(sorted(profiles.custom(self.state)), ["good"])

    def test_unknown_plugins_non_boolean_switches_and_extra_fields_are_refused(self):
        cases = (
            ({"plugins": {"ghost": True}}, "unknown plugin"),
            ({"plugins": {"git": "yes"}}, "must be a boolean"),
            ({"plugins": {"git": 1}}, "must be a boolean"),
            ({"plugins": {}}, "must list plugin switches"),
            ({"plugins": {"git": True}, "command": "git push"}, "unsupported fields"),
            ({"plugins": {"git": True}, "hooks": [{"run": "rm -rf /"}]}, "unsupported fields"),
            ({"plugins": {"git": True}, "name": "other"}, "does not name itself"),
            ({"plugins": {"git": True}, "extends": "../escape"}, "invalid profile to extend"),
        )
        for index, (document, expected) in enumerate(cases):
            self.write("bad%d" % index, document)
            with self.assertRaises(ValueError, msg=json.dumps(document)) as caught:
                profiles.resolve(self.state, "bad%d" % index)
            self.assertIn(expected, str(caught.exception))
            (self.directory / ("bad%d.json" % index)).unlink()

    def test_a_symlinked_profile_file_is_refused(self):
        outside = Path(self.temp.name) / "outside.json"
        outside.write_text(json.dumps({"plugins": {"git": True}}), encoding="utf-8")
        from tests.fs_link_helpers import make_symlink
        make_symlink(self.directory / "linked.json", outside)
        with self.assertRaises(ValueError):
            profiles.custom(self.state)

    def test_inheritance_cycles_and_over_deep_chains_are_refused(self):
        self.write("a", {"extends": "b", "plugins": {"git": True}})
        self.write("b", {"extends": "a", "plugins": {"memory": True}})
        with self.assertRaises(ValueError) as caught:
            profiles.resolve(self.state, "a")
        self.assertIn("cyclic", str(caught.exception))
        (self.directory / "a.json").unlink()
        (self.directory / "b.json").unlink()
        for index in range(profiles.MAX_EXTENDS_DEPTH + 2):
            parent = None if index == 0 else "chain%d" % (index - 1)
            self.write("chain%d" % index, {"extends": parent, "plugins": {"git": True}})
        with self.assertRaises(ValueError) as caught:
            profiles.resolve(self.state, "chain%d" % (profiles.MAX_EXTENDS_DEPTH + 1))
        self.assertIn("deeper than", str(caught.exception))

    def test_an_unknown_parent_is_refused_instead_of_falling_back(self):
        self.write("orphan", {"extends": "nowhere", "plugins": {"git": True}})
        with self.assertRaises(ValueError) as caught:
            profiles.resolve(self.state, "orphan")
        self.assertIn("unknown plugin profile: nowhere", str(caught.exception))

    def test_a_built_in_name_wins_so_an_operator_cannot_shadow_a_tier(self):
        self.write("minimal", {"plugins": {"sessions": False}})
        self.assertEqual(profiles.resolve(self.state, "minimal")["source"], "built-in")
        self.assertIs(profiles.resolve(self.state, "minimal")["plugins"]["sessions"], True)


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"

    def by_id(self, items=None):
        return {item["id"]: item for item in (items if items is not None else plugin_runtime.catalog(self.state))}

    def test_preview_and_apply_agree_and_only_move_switches(self):
        plugins = profiles.resolve(self.state, "minimal")["plugins"]
        planned = self.by_id(plugin_runtime.preview(self.state, plugins))
        result = profiles.apply(self.state, "minimal")
        after = self.by_id(result["catalog"])
        self.assertEqual({pid: (item["enabled"], item["effective"]) for pid, item in after.items()},
                         {pid: (item["enabled"], item["effective"]) for pid, item in planned.items()})
        self.assertEqual(after["sessions"]["enabled"], True)
        self.assertEqual(after["browser"]["enabled"], False)
        self.assertFalse((self.state / "workspace").exists())

    def test_apply_records_the_profile_layer_and_keeps_the_user_switch_priority(self):
        plugin_runtime.set_enabled(self.state, "memory", False)
        result = profiles.apply(self.state, "standard")
        catalog = self.by_id()
        self.assertIs(catalog["memory"]["enabled"], False)
        self.assertIn("memory", {item["id"] for item in result["warnings"] if item["code"] == "explicitSwitchKept"})
        state = json.loads((self.state / "plugin-state.json").read_text(encoding="utf-8"))
        self.assertEqual(set(state), {"apiVersion", "enabled", "profile"})
        self.assertEqual(state["enabled"], {"memory": False})
        self.assertEqual(state["profile"]["name"], "standard")
        self.assertIs(state["profile"]["overlay"]["memory"], True)

    def test_a_profile_never_enables_a_dependency_behind_the_users_back(self):
        directory = self.state / profiles.CUSTOM_DIRECTORY
        directory.mkdir(parents=True)
        (directory / "automation-only.json").write_text(json.dumps(
            {"plugins": {"automation": True, "workflows": False}}), encoding="utf-8")
        result = profiles.apply(self.state, "automation-only")
        catalog = self.by_id(result["catalog"])
        self.assertIs(catalog["automation"]["enabled"], True)
        self.assertIs(catalog["automation"]["effective"], False)
        self.assertEqual(catalog["automation"]["blockedBy"], ["workflows"])
        self.assertEqual(catalog["workflows"]["enabled"], False)
        self.assertIn({"id": "automation", "blockedBy": ["workflows"]}, result["blocked"])
        # The same holds for the minimal tier: automation stays blocked, nothing is enabled for it.
        minimal = profiles.apply(self.state, "minimal")
        minimal_catalog = self.by_id(minimal["catalog"])
        self.assertIs(minimal_catalog["automation"]["enabled"], False)
        self.assertIs(minimal_catalog["workflows"]["enabled"], False)

    def test_dry_run_reports_the_change_without_writing_and_cannot_drift(self):
        existed = self.state.exists()
        planned = profiles.apply(self.state, "minimal", dry_run=True)
        self.assertTrue(planned["dryRun"])
        self.assertTrue(planned["changes"])
        self.assertFalse((self.state / "plugin-state.json").exists())
        self.assertEqual(plugin_runtime.profile_state(self.state), {"name": None, "overlay": {}})
        self.assertEqual(self.state.exists(), existed)
        applied = profiles.apply(self.state, "minimal")
        self.assertEqual(applied["changes"], planned["changes"])

    def test_applying_the_same_profile_again_reports_no_further_change(self):
        first = profiles.apply(self.state, "lightweight")
        self.assertTrue(first["changes"])
        second = profiles.apply(self.state, "lightweight")
        self.assertEqual(second["changes"], [])
        self.assertEqual(self.by_id()["git"]["enabled"], True)

    def test_the_kernel_refuses_a_profile_that_names_an_unknown_plugin(self):
        for overlay, expected in (({"ghost": True}, "unknown plugin"), ({"git": "yes"}, "must be a boolean"),
                                  (["git"], "must be id/boolean")):
            with self.assertRaises(ValueError, msg=str(overlay)) as caught:
                plugin_runtime.set_profile(self.state, "broken", overlay)
            self.assertIn(expected, str(caught.exception))
        self.assertFalse((self.state / "plugin-state.json").exists())

    def test_security_and_workspace_state_are_never_profile_fields(self):
        profiles.apply(self.state, "minimal")
        state = json.loads((self.state / "plugin-state.json").read_text(encoding="utf-8"))
        for key in ("enabled", "profile"):
            for value in ([state["enabled"]] + ([state["profile"]["overlay"]] if "profile" in state else [])):
                for plugin_id, switch in value.items():
                    self.assertIn(plugin_id, plugin_runtime.PLUGIN_IDS, plugin_id)
                    self.assertIs(type(switch), bool, plugin_id)
        self.assertIs(type(state["apiVersion"]), int)
        self.assertEqual(sorted(path.name for path in self.state.iterdir()), [".plugin-state.lock", "plugin-state.json"])

    def test_toggling_a_plugin_after_a_profile_keeps_the_profile_layer(self):
        profiles.apply(self.state, "minimal")
        plugin_runtime.set_enabled(self.state, "git", True)
        state = json.loads((self.state / "plugin-state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["profile"]["name"], "minimal")
        self.assertEqual(state["enabled"], {"git": True})
        self.assertIs(self.by_id()["git"]["enabled"], True)


class EntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"

    def invoke(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main(["--state", str(self.state), *argv])
        return code, stdout.getvalue(), stderr.getvalue()

    def http(self, method, parts, data):
        return plugin_runtime.dispatch_http(method, parts, {}, data, {"state_dir": self.state})

    def test_the_command_group_lists_and_applies_tiers_as_json(self):
        code, out, err = self.invoke("plugins", "profile", "list")
        self.assertEqual(code, 0, err)
        names = {row["name"] for row in json.loads(out)["profiles"]}
        self.assertTrue(set(BUILT_INS) <= names, names)
        self.assertIsNone(json.loads(out)["active"])
        code, out, err = self.invoke("plugin", "profile", "show", "lightweight")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["extends"], ["minimal"])
        code, out, err = self.invoke("plugins", "profile", "apply", "lightweight", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["dryRun"])
        self.assertFalse((self.state / "plugin-state.json").exists())
        code, out, err = self.invoke("plugins", "profile", "apply", "minimal")
        self.assertEqual(code, 0, err)
        self.assertFalse(json.loads(out)["dryRun"])
        self.assertEqual(plugin_runtime.profile_state(self.state)["name"], "minimal")
        code, out, err = self.invoke("plugins", "profile", "apply", "nowhere")
        self.assertEqual(code, 1)
        self.assertIn("unknown plugin profile", err)
        with self.assertRaises(SystemExit):
            self.invoke("plugins", "profile", "apply")

    def test_http_selection_inherits_the_host_origin_and_csrf_guard(self):
        status, body = self.http("GET", ["api", "plugins", "profiles"], {})
        self.assertEqual(status, 200)
        self.assertIsNone(body["active"])
        self.assertTrue(set(BUILT_INS) <= {row["name"] for row in body["profiles"]})
        status, body = self.http("POST", ["api", "plugins", "profiles", "apply"], {"name": "minimal", "dryRun": True})
        self.assertEqual(status, 200)
        self.assertTrue(body["dryRun"])
        self.assertFalse((self.state / "plugin-state.json").exists())
        status, body = self.http("POST", ["api", "plugins", "profiles", "apply"], {"name": "standard"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(plugin_runtime.profile_state(self.state)["name"], "standard")
        for data in ({}, {"name": 7}, {"name": "minimal", "overlay": {"files": False}}):
            self.assertEqual(self.http("POST", ["api", "plugins", "profiles", "apply"], data)[0], 400)
        self.assertEqual(self.http("POST", ["api", "plugins", "profiles"], {})[0], 405)

    def test_the_profile_surface_stops_with_the_extensions_plugin(self):
        plugin_runtime.set_enabled(self.state, "extensions", False)
        status, body = self.http("GET", ["api", "plugins", "profiles"], {})
        self.assertEqual(status, 403)
        self.assertEqual(body["plugin"], "extensions")
        self.assertEqual(self.http("POST", ["api", "plugins", "profiles", "apply"], {"name": "minimal"})[0], 403)
        code, out, err = self.invoke("plugins", "profile", "list")
        self.assertEqual(code, 1)
        self.assertIn("extensions", err)
        self.assertEqual(out, "")
        # The kernel manager still answers, so a profile can never lock itself out.
        status, body = self.http("GET", ["api", "plugins"], {})
        self.assertEqual(status, 200)
        self.assertEqual({item["id"] for item in body["plugins"]}, set(plugin_runtime.PLUGIN_IDS))

    def test_the_http_manager_and_the_cli_agree_about_one_owner_per_action(self):
        for action in ("validate", "update", "profile"):
            self.assertEqual(plugin_runtime.plugins_action_owner(action), "extensions")
        self.assertIsNone(plugin_runtime.plugins_action_owner("enable"))
        self.assertEqual(plugin_runtime.route_owner(["api", "plugins", "profiles", "apply"]), "extensions")


if __name__ == "__main__":
    unittest.main()
