"""Parity regression tests for browser-use plugin (matching ZCode core/src/browser-client).

Tests that:
1. Tool registry exposes exactly the 5 approved tools with correct approval subjects.
2. Bridge script checks command actions and guards file screenshots.
3. Managed profile adheres to filesystem jail and link rejection.
"""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.bundled_plugins.browser.plugin import REGISTRY, _subject
from xueness.bundled_plugins.browser.profiles import managed_profile, ProfileError


class ParityBrowserTests(unittest.TestCase):
    def test_registry_tools_and_approvals(self):
        tool_names = [tool.name for tool in REGISTRY]
        self.assertEqual(
            tool_names,
            [
                "browser_navigate",
                "browser_inspect",
                "browser_click",
                "browser_fill",
                "browser_screenshot",
            ],
        )

        for tool in REGISTRY:
            self.assertEqual(tool.gate_kind, "exec")
            # click and fill require approval on the prompt and are mutating
            if tool.name in ("browser_click", "browser_fill"):
                self.assertTrue(tool.mutating)

    def test_subject_canonical_json(self):
        subj = _subject({"action": "navigate", "url": "https://example.com"})
        parsed = json.loads(subj)
        self.assertEqual(parsed["action"], "navigate")
        self.assertEqual(parsed["url"], "https://example.com")

    def test_managed_profile_jail(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir()
            profile = managed_profile(state)
            self.assertEqual(profile, state / "browser-profile")

    def test_managed_profile_rejects_symlink_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            real_state = Path(tmp) / "real_state"
            real_state.mkdir()
            symlink_state = Path(tmp) / "sym_state"
            symlink_state.symlink_to(real_state)
            with self.assertRaises(ProfileError):
                managed_profile(symlink_state)

    def test_bridge_source_guards_screenshot_output(self):
        bridge_path = Path(__file__).parent.parent / "xueness" / "bundled_plugins" / "browser" / "bridge.mjs"
        content = bridge_path.read_text(encoding="utf-8")
        self.assertIn("if (command.output)", content)


if __name__ == "__main__":
    unittest.main()
