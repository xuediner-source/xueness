"""Host path identity for jails and plan drafts.

Windows and macOS compare like the write-lock helper. Linux stays
case-sensitive. These tests mock the platform; they do not need those hosts.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import write_lock
from xueness.bundled_plugins.commands.file_commands import _contained as command_contained
from xueness.bundled_plugins.hooks import workspace_hooks
from xueness.bundled_plugins.hooks.workspace_hooks import _contained as hook_contained
from xueness.bundled_plugins.sessions.plan_mode import DraftPolicy
from xueness.bundled_plugins.skills.file_skills import _contained as skill_contained
from xueness.write_lock import host_path_contained, host_relative_to


# Saved before any test patches the name. Looking it up inside the wrapper
# would call the wrapper again.
_ORIGINAL_FOLD = write_lock._fold_host_path


def _windows_fold(text):
    # Nested so Path() outside the fold still sees a POSIX os.name.
    with patch.object(write_lock.os, "name", "nt"), \
            patch.object(write_lock.os.path, "normcase", str.lower):
        return _ORIGINAL_FOLD(text)


@unittest.skipIf(os.name == 'nt', 'POSIX path semantics cannot be emulated by native Windows pathlib')
class HostPathIdentityTests(unittest.TestCase):
    def test_linux_keeps_case_and_rejects_siblings_and_dotdot(self):
        self.assertEqual(host_relative_to("/tmp/workspace/a/b", "/tmp/workspace"), "a/b")
        self.assertEqual(host_relative_to("/tmp/workspace", "/tmp/workspace"), ".")
        self.assertTrue(host_path_contained("/tmp/workspace/a", "/tmp/workspace"))
        self.assertFalse(host_path_contained("/tmp/Workspace/A", "/tmp/workspace"))
        self.assertIsNone(host_relative_to("/tmp/workspace-extra", "/tmp/workspace"))
        self.assertIsNone(host_relative_to("/tmp/workspace-extra/file", "/tmp/workspace"))
        self.assertIsNone(host_relative_to("/tmp/workspace/../secret", "/tmp/workspace"))
        self.assertEqual(
            host_relative_to("/tmp/workspace/../workspace/file", "/tmp/workspace"), "file")
        self.assertIsNone(host_relative_to(None, "/tmp"))
        self.assertFalse(host_path_contained(1, "/tmp"))

    def test_macos_and_windows_fold_case_without_crossing_a_sibling(self):
        child = Path("/tmp/Workspace/Notes.md")
        parent = Path("/tmp/workspace")
        with self.subTest(platform="darwin"), patch.object(write_lock.sys, "platform", "darwin"):
            self.assertEqual(host_relative_to(child, parent), "Notes.md")
            self.assertTrue(host_path_contained(child, parent))
            self.assertEqual(host_relative_to(Path("/tmp/Workspace"), parent), ".")
            self.assertIsNone(host_relative_to("/tmp/workspace-extra/Notes.md", parent))
            self.assertIsNone(host_relative_to("/tmp/Workspace/../secret", parent))
        with self.subTest(platform="win32"), \
                patch.object(write_lock, "_fold_host_path", side_effect=_windows_fold):
            self.assertEqual(host_relative_to(child, parent), "Notes.md")
            self.assertTrue(host_path_contained(Path("/TMP/WORKSPACE/A"), Path("/tmp/workspace")))
            self.assertIsNone(host_relative_to("/tmp/workspace-extra", "/tmp/workspace"))

    def test_a_fold_that_changes_part_count_fails_closed(self):
        def broken(text):
            if text.endswith("workspace"):
                return text + "/extra"
            return text

        with patch.object(write_lock, "_fold_host_path", side_effect=broken):
            self.assertIsNone(host_relative_to("/tmp/workspace/file", "/tmp/workspace"))
            self.assertFalse(host_path_contained("/tmp/workspace", "/tmp/workspace"))

    def test_command_skill_and_hook_wrappers_follow_the_same_helper(self):
        child = Path("/tmp/Workspace/item")
        parent = Path("/tmp/workspace")
        wrappers = (command_contained, skill_contained, hook_contained)
        for wrapper in wrappers:
            self.assertFalse(wrapper(child, parent))
            self.assertTrue(wrapper(Path("/tmp/workspace/item"), parent))
        with patch.object(write_lock.sys, "platform", "darwin"):
            for wrapper in wrappers:
                self.assertTrue(wrapper(child, parent))
                self.assertFalse(wrapper(Path("/tmp/workspace-extra/item"), parent))
        with patch.object(write_lock, "_fold_host_path", side_effect=_windows_fold):
            for wrapper in wrappers:
                self.assertTrue(wrapper(child, parent))

    def test_discover_accepts_a_case_variant_only_on_macos_and_windows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Workspace"
            directory = root / ".xueness"
            directory.mkdir(parents=True)
            (directory / "hooks.json").write_text("[]", encoding="utf-8")
            real = workspace_hooks._real

            def shifted(value):
                resolved = real(value)
                if resolved is None or resolved.name != "hooks.json":
                    return resolved
                text = os.fspath(resolved)
                needle = os.sep + "Workspace" + os.sep
                if needle not in text:
                    raise AssertionError(text)
                return Path(text.replace(needle, os.sep + "workspace" + os.sep, 1))

            def codes(platform_patch):
                with platform_patch, patch.object(workspace_hooks, "_real", side_effect=shifted):
                    found = workspace_hooks.discover(root)
                self.assertEqual(found["hooks"], [])
                return [item["code"] for item in found["diagnostics"]]

            linux = codes(patch.object(write_lock.sys, "platform", "linux"))
            self.assertIn("hook_escapes_workspace", linux)
            darwin = codes(patch.object(write_lock.sys, "platform", "darwin"))
            self.assertNotIn("hook_escapes_workspace", darwin)
            windows = codes(patch.object(write_lock, "_fold_host_path", side_effect=_windows_fold))
            self.assertNotIn("hook_escapes_workspace", windows)

    def test_plan_draft_matches_case_variants_only_on_macos_and_windows(self):
        sid = "ab" * 16
        path = Path("/state/plan-drafts") / (sid + ".md")
        policy = DraftPolicy(path)
        upper = Path("/state/Plan-Drafts") / (sid.upper() + ".MD")
        self.assertTrue(policy.matches(os.fspath(path)))
        self.assertFalse(policy.matches(os.fspath(upper)))
        self.assertFalse(policy.matches("/state/plan-drafts"))
        self.assertFalse(policy.matches("plan-drafts/" + sid + ".md"))
        other = Path("/state/plan-drafts") / ("cd" * 16 + ".md")
        self.assertFalse(policy.matches(os.fspath(other)))
        escaped = os.fspath(path) + "/../" + ("cd" * 16 + ".md")
        self.assertFalse(policy.matches(escaped))
        with self.subTest(platform="darwin"), patch.object(write_lock.sys, "platform", "darwin"):
            self.assertTrue(policy.matches(os.fspath(upper)))
            self.assertFalse(policy.matches("/state/Plan-Drafts"))
            self.assertFalse(policy.matches(os.fspath(other).replace("plan-drafts", "Plan-Drafts")))
        with self.subTest(platform="win32"), \
                patch.object(write_lock, "_fold_host_path", side_effect=_windows_fold):
            self.assertTrue(policy.matches(os.fspath(upper)))
            self.assertFalse(policy.matches("/state/plan-drafts"))
            self.assertFalse(policy.matches(os.fspath(path) + ".bak"))


@unittest.skipUnless(os.name == 'nt', 'native Windows path identity')
class NativeWindowsHostPathIdentityTests(unittest.TestCase):
    def test_containment_wrappers_ignore_case_but_refuse_siblings_and_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / 'Workspace'
            child = parent / 'Notes.md'
            variant = Path(str(child).upper())
            for wrapper in (host_path_contained, command_contained, skill_contained, hook_contained):
                self.assertTrue(wrapper(variant, parent))
                self.assertFalse(wrapper(parent.with_name('Workspace-extra') / 'Notes.md', parent))
                self.assertFalse(wrapper(parent / '..' / 'secret', parent))
            self.assertEqual(host_relative_to(variant, parent), 'NOTES.MD')

    def test_absolute_plan_draft_case_variants_match_only_the_same_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'plan-drafts' / ('ab' * 16 + '.md')
            policy = DraftPolicy(path)
            self.assertTrue(policy.matches(str(path)))
            self.assertTrue(policy.matches(str(path).upper()))
            self.assertFalse(policy.matches(str(path) + '.bak'))
            self.assertFalse(policy.matches(str(path.parent)))
            self.assertFalse(policy.matches(path.name))
            self.assertFalse(policy.matches(str(path.parent / '..' / 'secret.md')))


if __name__ == "__main__":
    unittest.main()
