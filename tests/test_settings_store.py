"""Tests for xueness.settings_store (Stage 2 contract section 1)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from xueness import settings_store as ss  # noqa: E402


class SettingsStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state_dir = Path(self._tmp.name)
        self.ctx = {"state_dir": self.state_dir}

    # -- helpers ---------------------------------------------------------
    def call(self, method, path, data=None, query=None):
        parts = [p for p in path.split("/") if p]
        return ss.dispatch(method, parts, query or {}, data if data is not None else {}, self.ctx)

    def settings_file(self):
        return self.state_dir / "settings.json"

    # -- normal paths ----------------------------------------------------
    def test_section_ids_whitelist(self):
        # ``agent`` was added in Stage 6 for run-time capability opt-ins
        # (MCP / sub-agents / hooks); the four Stage 2 sections are unchanged.
        self.assertEqual(
            ss.SECTION_IDS,
            ("general", "appearance", "shortcuts", "browser", "agent"),
        )
        self.assertEqual(ss.SECTION_IDS[:4], ("general", "appearance", "shortcuts", "browser"))

    def test_agent_section_roundtrip(self):
        """The opt-in switches persist as plain booleans in their own section."""
        values = {"allowMcp": True, "allowSubagents": False, "allowHooks": True}
        status, payload = self.call("POST", "/api/settings/agent", {"values": values})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], values)

        status, payload = self.call("GET", "/api/settings/agent")
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], values)

        # And it survives a sibling-section write (sections stay independent).
        self.call("POST", "/api/settings/general", {"values": {"unrelated": 1}})
        _, payload = self.call("GET", "/api/settings/agent")
        self.assertEqual(payload["values"], values)

    def test_agent_defaults_are_absent_so_callers_treat_as_off(self):
        """An unset section is ``{}``: absent switches must read as off, not on."""
        status, payload = self.call("GET", "/api/settings/agent")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"section": "agent", "values": {}})

    def test_workbench_preferences_validate_language_and_boolean_controls(self):
        valid = {"language": "en", "autoScroll": True, "showTodos": False,
                 "collapseTools": True,
                 "toolGroupingExploreEnabled": False,
                 "toolGroupingTerminalEnabled": True,
                 "toolGroupingChangesEnabled": False,
                 "messageStreamShowReasoning": True,
                 "taskAutoArchiveEnabled": True,
                 "taskAutoArchiveOlderThanDays": 7}
        status, payload = self.call("POST", "/api/settings/general", {"values": valid})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], valid)
        shortcut = {"sendShortcut": "mod-enter"}
        status, payload = self.call("POST", "/api/settings/shortcuts", {"values": shortcut})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], shortcut)
        appearance = {"terminalFontSize": 16}
        status, payload = self.call("POST", "/api/settings/appearance", {"values": appearance})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], appearance)
        status, payload = self.call("POST", "/api/settings/browser",
                                    {"values": {"browserControlEnabled": False}})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], {"browserControlEnabled": False})
        for section, values in (("general", {"language": "fr"}),
                                ("general", {"autoScroll": 1}),
                                ("general", {"showTodos": "yes"}),
                                ("general", {"collapseTools": None}),
                                ("general", {"toolGroupingExploreEnabled": 1}),
                                ("general", {"toolGroupingTerminalEnabled": "yes"}),
                                ("general", {"toolGroupingChangesEnabled": None}),
                                ("general", {"messageStreamShowReasoning": "yes"}),
                                ("general", {"taskAutoArchiveEnabled": 1}),
                                ("general", {"taskAutoArchiveEnabled": "yes"}),
                                ("general", {"taskAutoArchiveOlderThanDays": True}),
                                ("general", {"taskAutoArchiveOlderThanDays": 2}),
                                ("general", {"taskAutoArchiveOlderThanDays": 90}),
                                ("shortcuts", {"sendShortcut": "space"}),
                                ("shortcuts", {"sendShortcut": None}),
                                ("appearance", {"terminalFontSize": 9}),
                                ("appearance", {"terminalFontSize": 25}),
                                ("appearance", {"terminalFontSize": 12.5}),
                                ("appearance", {"terminalFontSize": True}),
                                ("browser", {"browserControlEnabled": "true"})):
            with self.subTest(section=section, values=values):
                status, payload = self.call("POST", f"/api/settings/{section}",
                                            {"values": values})
                self.assertEqual(status, 400, payload)

    def test_get_all_initially_empty(self):
        status, payload = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"settings": {}})

    def test_each_section_roundtrip(self):
        for section in ss.SECTION_IDS:
            with self.subTest(section=section):
                # initial GET is empty
                status, payload = self.call("GET", f"/api/settings/{section}")
                self.assertEqual(status, 200)
                self.assertEqual(payload, {"section": section, "values": {}})

                values = {"alpha": 1, "nested": {"k": "v"}, "list": [1, 2, 3], "flag": True}
                status, payload = self.call(
                    "POST", f"/api/settings/{section}", {"values": values}
                )
                self.assertEqual(status, 200)
                self.assertEqual(payload, {"section": section, "values": values})

                # read back
                status, payload = self.call("GET", f"/api/settings/{section}")
                self.assertEqual(status, 200)
                self.assertEqual(payload, {"section": section, "values": values})

    def test_get_all_reflects_posts(self):
        self.call("POST", "/api/settings/general", {"values": {"a": 1}})
        self.call("POST", "/api/settings/browser", {"values": {"b": 2}})
        status, payload = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertEqual(payload["settings"]["general"], {"a": 1})
        self.assertEqual(payload["settings"]["browser"], {"b": 2})

    def test_post_does_not_clobber_other_sections(self):
        self.call("POST", "/api/settings/general", {"values": {"keep": "me"}})
        self.call("POST", "/api/settings/appearance", {"values": {"theme": "dark"}})
        self.call("POST", "/api/settings/shortcuts", {"values": {"save": "Cmd+S"}})
        # re-post general only
        status, _ = self.call("POST", "/api/settings/general", {"values": {"keep": "changed"}})
        self.assertEqual(status, 200)

        _, payload = self.call("GET", "/api/settings")
        settings = payload["settings"]
        self.assertEqual(settings["general"], {"keep": "changed"})
        self.assertEqual(settings["appearance"], {"theme": "dark"})
        self.assertEqual(settings["shortcuts"], {"save": "Cmd+S"})

    def test_post_empty_values_ok(self):
        self.call("POST", "/api/settings/general", {"values": {"x": 1}})
        status, payload = self.call("POST", "/api/settings/general", {"values": {}})
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], {})
        _, after = self.call("GET", "/api/settings/general")
        self.assertEqual(after["values"], {})

    # -- 404 / 400 / None ------------------------------------------------
    def test_unknown_section_get_404(self):
        status, payload = self.call("GET", "/api/settings/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_unknown_section_post_404(self):
        status, payload = self.call("POST", "/api/settings/nope", {"values": {}})
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_values_not_dict_400(self):
        for bad in ([1, 2], "str", 5, None, True):
            with self.subTest(bad=bad):
                status, payload = self.call("POST", "/api/settings/general", {"values": bad})
                self.assertEqual(status, 400)
                self.assertIn("error", payload)

    def test_missing_values_key_400(self):
        status, payload = self.call("POST", "/api/settings/general", {"other": 1})
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_body_not_dict_400(self):
        for bad in ([], "x", 3, None):
            with self.subTest(bad=bad):
                status, payload = self.call("POST", "/api/settings/general", bad)
                self.assertEqual(status, 400)
                self.assertIn("error", payload)

    def test_other_paths_return_none(self):
        cases = [
            ("GET", "/api/resources/skills"),
            ("GET", "/api/settingsx/general"),
            ("GET", "/settings/general"),
            ("GET", "/api"),
        ]
        for method, path in cases:
            with self.subTest(method=method, path=path):
                self.assertIsNone(self.call(method, path))

    def test_deeper_path_returns_none(self):
        self.assertIsNone(self.call("GET", "/api/settings/general/extra"))
        self.assertIsNone(self.call("POST", "/api/settings/general/extra", {"values": {}}))

    def test_other_methods_return_none(self):
        self.assertIsNone(self.call("DELETE", "/api/settings/general"))
        self.assertIsNone(self.call("PUT", "/api/settings/general"))
        self.assertIsNone(self.call("POST", "/api/settings"))

    # -- persistence robustness -----------------------------------------
    def test_corrupt_file_falls_back_to_empty(self):
        self.settings_file().write_text("{ this is not json ", encoding="utf-8")
        self.assertEqual(ss.load_settings(self.state_dir), {})
        status, payload = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"settings": {}})
        status, payload = self.call("GET", "/api/settings/general")
        self.assertEqual(status, 200)
        self.assertEqual(payload["values"], {})
        # and it can be repaired by a write
        status, _ = self.call("POST", "/api/settings/general", {"values": {"ok": True}})
        self.assertEqual(status, 200)
        _, payload = self.call("GET", "/api/settings/general")
        self.assertEqual(payload["values"], {"ok": True})

    def test_non_object_json_falls_back_to_empty(self):
        self.settings_file().write_text("[1, 2, 3]", encoding="utf-8")
        self.assertEqual(ss.load_settings(self.state_dir), {})
        status, _ = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)

    def test_missing_file_is_empty(self):
        self.assertFalse(self.settings_file().exists())
        self.assertEqual(ss.load_settings(self.state_dir), {})

    def test_saved_file_is_valid_json(self):
        values = {"unicode": "设置", "n": 1}
        self.call("POST", "/api/settings/general", {"values": values})
        self.assertTrue(self.settings_file().exists())
        with self.settings_file().open("r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        self.assertEqual(loaded, {"general": values})

    def test_save_settings_creates_missing_dir(self):
        nested = self.state_dir / "a" / "b"
        ss.save_settings(nested, {"general": {"x": 1}})
        self.assertEqual(ss.load_settings(nested), {"general": {"x": 1}})

    def test_no_temp_files_left_behind(self):
        for section in ss.SECTION_IDS:
            self.call("POST", f"/api/settings/{section}", {"values": {"i": section}})
        leftovers = [p.name for p in self.state_dir.iterdir() if p.name.startswith(".settings-")]
        self.assertEqual(leftovers, [])

    def test_unknown_sections_preserved_on_write(self):
        # Unknown top-level keys must survive read-modify-write.
        self.settings_file().write_text(
            json.dumps({"future": {"z": 1}, "general": {"old": True}}), encoding="utf-8"
        )
        self.call("POST", "/api/settings/general", {"values": {"new": True}})
        with self.settings_file().open("r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        self.assertEqual(loaded["future"], {"z": 1})
        self.assertEqual(loaded["general"], {"new": True})


if __name__ == "__main__":
    unittest.main()
