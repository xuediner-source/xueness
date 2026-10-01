"""CLI coverage for the bundled feature-plugin manager."""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from xueness.cli import main


class PluginCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(["--state", str(self.state), *argv])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_plugins_list_and_show(self):
        catalog = [
            {"id": "sessions", "enabled": True, "description": "Session handling"},
            {"id": "providers", "enabled": True, "description": "Model providers"},
        ]
        with patch("xueness.plugin_runtime.catalog", return_value=catalog):
            code, out, err = self.invoke("plugins", "list")
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(out), catalog)
            code, out, err = self.invoke("plugins", "show", "providers")
            self.assertEqual(code, 0, err)
            self.assertEqual(json.loads(out), catalog[1])

    def test_plugins_enable_and_disable(self):
        state = {"enabled": True}

        def toggle(state_dir, plugin_id, enabled):
            self.assertEqual(plugin_id, "workflows")
            state["enabled"] = enabled
            return [{"id": plugin_id, **state}]

        with patch("xueness.plugin_runtime.catalog", return_value=[{"id": "workflows", **state}]), \
             patch("xueness.plugin_runtime.set_enabled", side_effect=toggle):
            code, out, err = self.invoke("plugins", "disable", "workflows")
            self.assertEqual(code, 0, err)
            self.assertFalse(json.loads(out)["enabled"])
            code, out, err = self.invoke("plugins", "enable", "workflows")
            self.assertEqual(code, 0, err)
            self.assertTrue(json.loads(out)["enabled"])

    def test_disabled_owner_fails_before_creating_state_or_workspace(self):
        workspace = Path(self.temp.name) / "workspace"
        with patch("xueness.plugin_runtime.require_enabled", side_effect=ValueError("plugin 'sessions' is disabled")):
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = main(["--state", str(self.state), "new", "task", "--root", str(workspace)])
        self.assertEqual(code, 1)
        self.assertIn("sessions", stderr.getvalue())
        self.assertFalse(self.state.exists())
        self.assertFalse(workspace.exists())

    def test_unknown_plugin_id_fails_cleanly(self):
        with patch("xueness.plugin_runtime.catalog", return_value=[]), \
             patch("xueness.plugin_runtime.set_enabled", side_effect=ValueError("unknown plugin: missing")):
            code, _, err = self.invoke("plugins", "enable", "missing")
        self.assertEqual(code, 1)
        self.assertIn("unknown plugin", err)
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
