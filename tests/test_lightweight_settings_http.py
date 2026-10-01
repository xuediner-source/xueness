"""Persisted lightweight tuning reaches real local HTTP requests safely."""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness import cli
from xueness.bundled_plugins.providers import provider_config, providers_api
from xueness.bundled_plugins.providers.provider import OpenAICompatible


SECRET = "test-lightweight-settings-key-never-printed"
CHAT_REPLY = {"choices": [{"message": {"role": "assistant", "content": "OK"}}]}


def _server(state):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            state.setdefault("requests", []).append({
                "path": self.path,
                "headers": dict(self.headers.items()),
                "body": json.loads(self.rfile.read(length)),
            })
            raw = json.dumps(CHAT_REPLY).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class LightweightSettingsHttpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.ctx = {"state_dir": self.state_dir, "allow_real": True}
        self.servers = []

    def tearDown(self):
        for server in reversed(self.servers):
            server.shutdown()
            server.server_close()

    def start_server(self, state):
        server = _server(state)
        self.servers.append(server)
        return server

    def save(self, provider_id, base_url, *, protocol="openai", model="fixture-model",
             runtime_profile="lightweight", tool_calling="native", options=None,
             key=SECRET):
        data = {
            "id": provider_id,
            "name": "Fixture provider",
            "baseUrl": base_url,
            "model": model,
            "protocol": protocol,
            "runtimeProfile": runtime_profile,
            "toolCalling": tool_calling,
        }
        if options is not None:
            data["lightweightOptions"] = options
        if key is not None:
            data["apiKey"] = key
        return providers_api.dispatch(
            "POST", ["api", "providers"], {}, data, self.ctx)

    def test_cli_json_options_are_public_keyless_replaceable_and_clearable(self):
        first_options = {"temperature": 0.35, "topP": 0.8, "seed": 41}
        output = io.StringIO()
        error = io.StringIO()
        with patch.dict(os.environ, {"LIGHTWEIGHT_TEST_KEY": SECRET}), \
                redirect_stdout(output), redirect_stderr(error):
            result = cli.main([
                "--state", str(self.state_dir), "providers", "save", "fixture",
                "--base-url", "https://fixture.example.test/v1",
                "--model", "fixture-model", "--runtime-profile", "lightweight",
                "--lightweight-options", json.dumps(first_options),
                "--key-env", "LIGHTWEIGHT_TEST_KEY",
            ])
        self.assertEqual(0, result, error.getvalue())
        saved_public = json.loads(output.getvalue())["provider"]
        self.assertEqual(first_options, saved_public["lightweightOptions"])
        self.assertTrue(saved_public["hasKey"])
        self.assertNotIn(SECRET, output.getvalue())
        self.assertNotIn("apiKey", output.getvalue())

        # Omitting the JSON argument preserves the saved object; a later full
        # replacement changes every key, and {} clears all overrides.
        for options_json, expected in ((None, first_options), ('{"seed":7}', {"seed": 7}),
                                       ("{}", {})):
            output = io.StringIO()
            error = io.StringIO()
            command = [
                "--state", str(self.state_dir), "providers", "save", "fixture",
                "--base-url", "https://fixture.example.test/v1",
                "--model", "fixture-model",
            ]
            if options_json is not None:
                command.extend(("--lightweight-options", options_json))
            with redirect_stdout(output), redirect_stderr(error):
                result = cli.main(command)
            self.assertEqual(0, result, error.getvalue())
            public = json.loads(output.getvalue())["provider"]
            self.assertEqual(expected, public["lightweightOptions"])
            self.assertTrue(public["hasKey"])
            self.assertNotIn(SECRET, output.getvalue())
        record = providers_api._read_record(
            providers_api._providers_dir(self.ctx) / "fixture.json")
        self.assertEqual({}, record["lightweightOptions"])
        self.assertEqual(SECRET, record["apiKey"])

    def test_native_and_json_lightweight_requests_send_sampling_options(self):
        state = {}
        server = self.start_server(state)
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        options = {"temperature": 0.35, "topP": 0.8, "seed": 41}
        tool_schema = [{"type": "function", "function": {
            "name": "read_item", "parameters": {"type": "object", "properties": {}}}}]

        for provider_id, tool_calling in (("native", "native"), ("json", "json")):
            status, saved = self.save(
                provider_id, base_url, tool_calling=tool_calling, options=options)
            self.assertEqual(200, status, saved)
            provider = provider_config.resolve(self.state_dir, provider_id)
            provider.complete([{"role": "user", "content": "hello"}], tool_schema)

        native_payload, json_payload = [request["body"] for request in state["requests"]]
        for payload in (native_payload, json_payload):
            self.assertEqual(0.35, payload["temperature"])
            self.assertEqual(0.8, payload["top_p"])
            self.assertEqual(41, payload["seed"])
        self.assertEqual(tool_schema, native_payload["tools"])
        self.assertNotIn("tools", json_payload)

    def test_standard_profile_suppresses_sampling_options_and_lightweight_probe_omits_them(self):
        state = {}
        server = self.start_server(state)
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        options = {"temperature": 0.35, "topP": 0.8, "seed": 41}
        self.assertEqual(200, self.save(
            "standard", base_url, runtime_profile="standard", options=options)[0])
        with patch.dict(os.environ, {"XUENESS_ALLOW_LOOPBACK_HTTP": "1"}):
            standard = provider_config.resolve(self.state_dir, "standard")
            standard.complete([{"role": "user", "content": "hello"}], [])
        standard_payload = state["requests"][-1]["body"]
        self.assertFalse({"temperature", "top_p", "seed"} & set(standard_payload))

        self.assertEqual(200, self.save("light", base_url, options=options)[0])
        status, result = providers_api.dispatch(
            "POST", ["api", "providers", "test"], {}, {"id": "light"}, self.ctx)
        self.assertEqual(200, status, result)
        probe_payload = state["requests"][-1]["body"]
        self.assertEqual(8, probe_payload["max_tokens"])
        self.assertFalse({"temperature", "top_p", "seed"} & set(probe_payload))

    def test_anthropic_rejects_sampling_options_and_openai_validation_is_strict(self):
        server_state = {}
        server = self.start_server(server_state)
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        status, response = self.save(
            "anthropic", base_url, protocol="anthropic",
            options={"temperature": 0.4})
        self.assertEqual(400, status)
        self.assertIn("OpenAI-compatible", response["error"])
        self.assertNotIn("requests", server_state)

        invalid = (
            {"unknownOption": 1},
            {"seed": True},
            {"temperature": float("nan")},
            {"topP": 0},
        )
        for index, options in enumerate(invalid):
            with self.subTest(options=options):
                status, response = self.save(
                    f"invalid-{index}", base_url, options=options)
                self.assertEqual(400, status)
                self.assertIn("lightweightOptions", response["error"])

    def test_resolved_anthropic_profile_carries_validated_non_sampling_options(self):
        self.assertEqual(200, self.save(
            "anthropic", "https://anthropic.example.test/v1",
            protocol="anthropic", options={"optionalContextChars": 1200})[0])
        provider = provider_config.resolve(self.state_dir, "anthropic")
        self.assertEqual({"optionalContextChars": 1200}, provider.lightweight_options)
        self.assertEqual({}, OpenAICompatible(
            base="https://provider.example.test/v1", model="fixture-model",
            key=SECRET).lightweight_options)


if __name__ == "__main__":
    unittest.main()
