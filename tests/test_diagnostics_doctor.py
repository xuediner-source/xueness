"""`xueness doctor`: read-only health report owned by the diagnostics plugin.

The default report must never touch the network and never print a credential;
``--ping`` is the explicit opt-in to one bounded model-discovery request. These
tests exercise the aggregation, the redaction, the ping guard and the CLI face.
"""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from xueness import plugin_runtime
from xueness.bundled_plugins.diagnostics import doctor

SECRET = "sk-test-only-doctor-secret-value-123"


class DoctorTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.state.mkdir()
        self.work = self.base / "work"
        self.work.mkdir()
        env = {name: os.environ.pop(name, None) for name in
               ("XUENESS_API_BASE", "XUENESS_MODEL", "XUENESS_API_KEY", "XUENESS_PROVIDER")}
        for name, value in env.items():
            if value is not None:
                os.environ[name] = value
                self.addCleanup(os.environ.__setitem__, name, value)
            else:
                self.addCleanup(os.environ.pop, name, None)

    def write_provider(self, provider_id="main"):
        directory = self.state / "providers"
        directory.mkdir(exist_ok=True)
        record = {"id": provider_id, "name": provider_id,
                  "baseUrl": "https://api.example.com/v1", "model": "test-model",
                  "apiKey": SECRET, "protocol": "openai"}
        (directory / (provider_id + ".json")).write_text(json.dumps(record), encoding="utf-8")

    def test_report_shape_and_empty_defaults(self):
        document = doctor.report(self.state, root=self.work)
        self.assertEqual(document["schema"], "xueness.doctor.v1")
        self.assertTrue(document["version"]["xueness"])
        self.assertEqual(document["plugins"]["installed"], len(plugin_runtime.PLUGIN_IDS))
        self.assertEqual(document["plugins"]["effective"],
                         len(plugin_runtime.PLUGIN_IDS) - len(document["plugins"]["blocked"]))
        self.assertTrue(document["storage"]["stateDir"]["writable"])
        self.assertTrue(document["storage"]["workspace"]["writable"])
        self.assertFalse(document["model"]["resolvable"])
        self.assertIn("no model provider is configured", document["model"]["error"])
        self.assertIsNone(document["model"]["ping"])
        self.assertFalse(document["ok"])

    def test_missing_workspace_directory_is_reported_not_created(self):
        document = doctor.report(self.state, root=self.base / "nowhere")
        workspace = document["storage"]["workspace"]
        self.assertFalse(workspace["exists"])
        self.assertFalse(workspace["writable"])
        self.assertFalse((self.base / "nowhere").exists())
        self.assertFalse(document["ok"])

    def test_unwritable_workspace_keeps_the_overall_result_failed(self):
        os.environ["XUENESS_API_BASE"] = "https://api.example.com/v1"
        os.environ["XUENESS_MODEL"] = "test-model"
        os.environ["XUENESS_API_KEY"] = "test-key"
        document = doctor.report(self.state, root=self.base / "nowhere")
        self.assertTrue(document["model"]["resolvable"])
        self.assertFalse(document["storage"]["workspace"]["writable"])
        self.assertFalse(document["ok"])

    def test_failed_probe_write_removes_its_temporary_file(self):
        with patch("xueness.bundled_plugins.diagnostics.doctor.os.write",
                   side_effect=PermissionError("fixture")):
            result = doctor._probe_directory(self.work)
        self.assertFalse(result["writable"])
        self.assertEqual(list(self.work.glob(".xueness-doctor-*")), [])

    def test_model_resolves_from_environment_without_a_request(self):
        os.environ["XUENESS_API_BASE"] = "https://api.example.com/v1"
        os.environ["XUENESS_MODEL"] = "test-model"
        os.environ["XUENESS_API_KEY"] = "test-key"
        document = doctor.report(self.state, root=self.work)
        self.assertTrue(document["model"]["resolvable"])
        self.assertIsNone(document["model"]["error"])
        self.assertTrue(document["ok"])

    def test_provider_profile_summary_is_redacted(self):
        self.write_provider()
        document = doctor.report(self.state, root=self.work)
        self.assertTrue(document["model"]["resolvable"])
        row = document["model"]["profiles"][0]
        self.assertEqual(row["id"], "main")
        self.assertEqual(row["model"], "test-model")
        self.assertTrue(row["hasKey"])
        self.assertNotIn(SECRET, json.dumps(document))
        self.assertNotIn(SECRET, doctor.format_report(document))
        self.assertNotIn("https://api.example.com", doctor.format_report(document))

    def test_ping_requires_the_providers_plugin_to_be_effective(self):
        plugin_runtime.set_enabled(self.state, "providers", False)
        self.addCleanup(plugin_runtime.set_enabled, self.state, "providers", True)
        document = doctor.report(self.state, root=self.work, ping=True)
        self.assertFalse(document["model"]["ping"]["ok"])
        self.assertIn("providers plugin is disabled", document["model"]["ping"]["error"])

    def test_ping_counts_discovered_models(self):
        self.write_provider()
        resolved = Mock()
        resolved.discover_models = Mock(return_value=["m1", "m2", "m3"])
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=resolved) as resolve:
            document = doctor.report(self.state, root=self.work, ping=True)
        self.assertTrue(document["model"]["ping"]["ok"])
        self.assertEqual(document["model"]["ping"]["models"], 3)
        # One resolution shared by the resolvability check and the ping.
        resolve.assert_called_once_with(self.state, "main")
        resolved.discover_models.assert_called_once_with(timeout=doctor.PING_TIMEOUT_SECONDS)

    def test_ping_failure_stays_sanitized(self):
        self.write_provider()
        resolved = Mock()
        resolved.discover_models = Mock(side_effect=RuntimeError("boom"))
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=resolved):
            document = doctor.report(self.state, root=self.work, ping=True)
        self.assertFalse(document["model"]["ping"]["ok"])
        self.assertEqual(document["model"]["ping"]["error"],
                         "provider model discovery failed (details suppressed)")
        self.assertTrue(document["model"]["resolvable"])
        self.assertFalse(document["ok"])

        args = SimpleNamespace(state=self.state, root=self.work, ping=True, json=True,
                               language=None)
        output = io.StringIO()
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=resolved), contextlib.redirect_stdout(output):
            code = doctor.execute(args)
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])

    def test_ping_without_discovery_support_reports_the_protocol(self):
        self.write_provider()
        resolved = Mock(spec=[])
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=resolved):
            document = doctor.report(self.state, root=self.work, ping=True)
        self.assertFalse(document["model"]["ping"]["ok"])
        self.assertIn("not supported", document["model"]["ping"]["error"])

    def test_format_report_bilingual_labels(self):
        document = doctor.report(self.state, root=self.work)
        zh = doctor.format_report(document)
        self.assertIn("Xueness doctor（只读体检）", zh)
        self.assertIn("整体: 存在问题", zh)
        en = doctor.format_report(document, language="en")
        self.assertIn("Xueness doctor (read-only)", en)
        self.assertIn("overall: problems found", en)

    def test_cli_execute_json_and_exit_codes(self):
        args = SimpleNamespace(state=self.state, root=self.work, ping=False, json=True,
                               language=None)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.execute(args)
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(out.getvalue())["ok"])
        os.environ["XUENESS_API_BASE"] = "https://api.example.com/v1"
        os.environ["XUENESS_MODEL"] = "test-model"
        os.environ["XUENESS_API_KEY"] = "test-key"
        args = SimpleNamespace(state=self.state, root=self.work, ping=False, json=False,
                               language="en")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.execute(args)
        self.assertEqual(code, 0)
        self.assertIn("overall: pass", out.getvalue())


if __name__ == "__main__":
    unittest.main()
