"""Runtime profile, payload compatibility, and keyless loopback tests."""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.providers import provider_config, providers_api
from xueness.bundled_plugins.providers.provider import OpenAICompatible, ProviderRequestError
from xueness.bundled_plugins.providers.runtime_options import build_openai_payload


FAKE_KEY = "test-local-profile-key"
FIXTURE_REPLY = {"choices": [{"message": {"role": "assistant", "content": "OK"}}]}


def _server(state, *, status=200, payload=None, stream_payload=None):
    payload = FIXTURE_REPLY if payload is None else payload

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            state["path"] = self.path
            state["headers"] = dict(self.headers.items())
            state["body"] = json.loads(self.rfile.read(length))
            state["hits"] = state.get("hits", 0) + 1
            if stream_payload is not None and state["body"].get("stream"):
                raw = stream_payload
                content_type = "text/event-stream"
            else:
                raw = json.dumps(payload).encode("utf-8")
                content_type = "application/json"
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class LocalProviderOptionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state_dir = Path(self.temp.name) / "state"
        self.state_dir.mkdir()
        self.ctx = {"state_dir": self.state_dir, "allow_real": True}

    def save(self, *, provider_id="fixture", base_url="https://provider.example.test/v1", **extra):
        data = {
            "id": provider_id,
            "name": "Fixture provider",
            "baseUrl": base_url,
            "model": "fixture-model",
        }
        data.update(extra)
        return providers_api.dispatch("POST", ["api", "providers"], {}, data, self.ctx)

    def test_legacy_public_shape_and_explicit_runtime_round_trip(self):
        status, result = self.save(apiKey=FAKE_KEY)
        self.assertEqual(200, status)
        self.assertEqual({
            "id": "fixture", "name": "Fixture provider",
            "baseUrl": "https://provider.example.test/v1", "model": "fixture-model",
            "hasKey": True,
        }, result["provider"])

        status, result = self.save(
            runtimeProfile="lightweight", contextWindow=16384,
            maxOutputTokens=4096, toolCalling="json",
            compatibility={"streamUsage": False, "maxTokensField": "max_tokens"},
        )
        self.assertEqual(200, status, result)
        public = result["provider"]
        self.assertEqual("lightweight", public["runtimeProfile"])
        self.assertEqual(16384, public["contextWindow"])
        self.assertEqual(4096, public["maxOutputTokens"])
        self.assertEqual("json", public["toolCalling"])
        self.assertEqual({"streamUsage": False, "maxTokensField": "max_tokens"},
                         public["compatibility"])
        self.assertNotIn("apiKey", public)
        self.assertTrue(public["hasKey"])

        # An update to one compatibility option merges its supplied option and
        # retains the other saved runtime fields and credentials.
        status, result = self.save(compatibility={"parallelToolCalls": True})
        self.assertEqual(200, status, result)
        self.assertEqual({
            "streamUsage": False, "maxTokensField": "max_tokens",
            "parallelToolCalls": True,
        }, result["provider"]["compatibility"])
        self.assertEqual("json", result["provider"]["toolCalling"])
        record = providers_api._read_record(
            providers_api._providers_dir(self.ctx) / "fixture.json")
        self.assertEqual(FAKE_KEY, record["apiKey"])

    def test_runtime_values_reject_bad_integer_boolean_and_unknown_compatibility(self):
        bad_values = [
            ({"contextWindow": True}, "contextWindow"),
            ({"contextWindow": 2047}, "contextWindow"),
            ({"maxOutputTokens": False}, "maxOutputTokens"),
            ({"maxOutputTokens": 2049, "contextWindow": 4096}, "half"),
            ({"compatibility": {"unknown": True}}, "compatibility"),
            ({"compatibility": {"streamUsage": 1}}, "compatibility"),
            ({"compatibility": {"maxTokensField": []}}, "compatibility"),
            ({"toolCalling": "json"}, "lightweight"),
        ]
        for fields, _expected in bad_values:
            status, result = self.save(**fields)
            self.assertEqual(400, status, (fields, result))

        status, _ = self.save(runtimeProfile="lightweight", toolCalling="json",
                              protocol="anthropic")
        self.assertEqual(400, status)

        # Corrupt records are rejected at read time, including booleans in
        # numeric fields and compatibility keys outside the whitelist.
        directory = providers_api._providers_dir(self.ctx)
        directory.mkdir(parents=True)
        (directory / "bad-bool.json").write_text(json.dumps({
            "id": "bad-bool", "contextWindow": True,
        }))
        (directory / "bad-compat.json").write_text(json.dumps({
            "id": "bad-compat", "compatibility": {"surprise": True},
        }))
        self.assertIsNone(providers_api._read_record(directory / "bad-bool.json"))
        self.assertIsNone(providers_api._read_record(directory / "bad-compat.json"))

    def test_standard_payload_keeps_existing_shape(self):
        state = {}
        server = _server(state)
        try:
            client = OpenAICompatible(
                base=f"http://127.0.0.1:{server.server_port}/v1",
                model="fixture-model", key=FAKE_KEY, allow_loopback_http=True)
            client.complete([{"role": "user", "content": "hello"}], [])
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual({"model", "messages", "tools"}, set(state["body"]))
        self.assertEqual("Bearer " + FAKE_KEY, state["headers"]["Authorization"])

    def test_lightweight_json_payload_omits_tool_fields_and_uses_configured_limits(self):
        body = build_openai_payload(
            model="local-small", messages=[{"role": "user", "content": "tool JSON here"}],
            tools=[{"function": {"name": "read"}}], runtime_profile="lightweight",
            context_window=8192, max_output_tokens=1024, tool_calling="json",
            compatibility={"parallelToolCalls": True}, stream=True,
        )
        self.assertEqual({"model", "messages", "stream", "max_tokens"}, set(body))
        self.assertEqual(1024, body["max_tokens"])
        self.assertNotIn("tools", body)
        self.assertNotIn("parallel_tool_calls", body)
        self.assertNotIn("stream_options", body)

    def test_lightweight_stream_defaults_and_explicit_compatibility_overrides(self):
        state = {}
        stream = (
            b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'
            b'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'
            b"data: [DONE]\n\n"
        )
        server = _server(state, stream_payload=stream)
        try:
            client = OpenAICompatible(
                base=f"http://127.0.0.1:{server.server_port}/v1", model="local-small",
                key=FAKE_KEY, runtime_profile="lightweight", tool_calling="native",
            )
            result = client.stream([{"role": "user", "content": "hello"}], [])
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual("OK", result["content"])
        self.assertEqual(1024, state["body"]["max_tokens"])
        self.assertFalse(state["body"]["parallel_tool_calls"])
        self.assertNotIn("stream_options", state["body"])

        state = {}
        server = _server(state, stream_payload=stream)
        try:
            client = OpenAICompatible(
                base=f"http://127.0.0.1:{server.server_port}/v1", model="local-small",
                key=FAKE_KEY, runtime_profile="lightweight", tool_calling="native",
                compatibility={"streamUsage": True, "parallelToolCalls": True,
                               "maxTokensField": "max_completion_tokens"},
            )
            client.stream([{"role": "user", "content": "hello"}], [])
        finally:
            server.shutdown()
            server.server_close()
        self.assertTrue(state["body"]["parallel_tool_calls"])
        self.assertEqual({"include_usage": True}, state["body"]["stream_options"])
        self.assertEqual(1024, state["body"]["max_completion_tokens"])
        self.assertNotIn("max_tokens", state["body"])

    def test_lightweight_loopback_resolve_allows_empty_key_without_authorization_header(self):
        state = {}
        server = _server(state)
        try:
            status, result = self.save(
                base_url=f"http://127.0.0.1:{server.server_port}/v1",
                runtimeProfile="lightweight",
            )
            self.assertEqual(200, status, result)
            client = provider_config.resolve(self.state_dir, "fixture")
            self.assertEqual("lightweight", client.runtime_profile)
            self.assertEqual(8192, client.context_window)
            self.assertEqual(1024, client.max_output_tokens)
            status, response = providers_api.dispatch(
                "POST", ["api", "providers", "test"], {}, {"id": "fixture"}, self.ctx)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(200, status, response)
        self.assertNotIn("Authorization", state["headers"])
        self.assertEqual(8, state["body"]["max_tokens"])
        self.assertFalse(state["body"]["parallel_tool_calls"])
        self.assertEqual([], state["body"]["tools"])

    def test_empty_key_requires_opted_in_literal_loopback_even_for_https(self):
        with self.assertRaisesRegex(ValueError, "empty API key"):
            OpenAICompatible(base="https://provider.example.test/v1", model="m", key="")
        with self.assertRaisesRegex(ValueError, "empty API key"):
            OpenAICompatible(base="https://127.0.0.1/v1", model="m", key="",
                             allow_empty_key=False)
        local_tls = OpenAICompatible(
            base="https://127.0.0.1/v1", model="m", key="",
            runtime_profile="lightweight")
        self.assertEqual("", local_tls.key)
        with self.assertRaisesRegex(ValueError, "loopback IP literals"):
            OpenAICompatible(base="http://localhost:11434/v1", model="m", key="",
                             runtime_profile="lightweight")

        self.save(base_url="https://provider.example.test/v1",
                  runtimeProfile="lightweight")
        with self.assertRaisesRegex(ValueError, "empty API key"):
            provider_config.resolve(self.state_dir, "fixture")

    def test_session_standard_choice_keeps_saved_local_transport_opt_in(self):
        status, _ = self.save(base_url='http://127.0.0.1:11434/v1', runtimeProfile='lightweight')
        self.assertEqual(status, 200)
        standard = provider_config.resolve(self.state_dir, 'fixture', runtime_profile='standard')
        self.assertEqual(standard.runtime_profile, 'standard')
        self.assertEqual(standard.key, '')
        self.assertEqual(providers_api._list(self.ctx)[0]['runtimeProfile'], 'lightweight')

    def test_resolve_runtime_profile_is_ephemeral_and_applies_to_anthropic_budget(self):
        status, _ = self.save(apiKey=FAKE_KEY)
        self.assertEqual(200, status)
        client = provider_config.resolve(self.state_dir, "fixture", runtime_profile="lightweight")
        self.assertEqual("lightweight", client.runtime_profile)
        self.assertEqual(8192, client.context_window)
        self.assertEqual(1024, client.max_output_tokens)
        saved = providers_api._read_record(
            providers_api._providers_dir(self.ctx) / "fixture.json")
        self.assertNotIn("runtimeProfile", saved)

        status, result = self.save(
            provider_id="anthropic", protocol="anthropic", apiKey=FAKE_KEY,
            runtimeProfile="lightweight", contextWindow=2048,
        )
        self.assertEqual(200, status, result)
        anthropic = provider_config.resolve(self.state_dir, "anthropic")
        self.assertEqual("lightweight", anthropic.runtime_profile)
        self.assertEqual(2048, anthropic.context_window)
        self.assertEqual(512, anthropic.max_output_tokens)
        self.assertEqual(512, anthropic.max_tokens)

    def test_environment_client_can_explicitly_select_local_lightweight_profile(self):
        server = _server({})
        try:
            with patch.dict(os.environ, {
                "XUENESS_API_BASE": f"http://127.0.0.1:{server.server_port}/v1",
                "XUENESS_MODEL": "local-small", "XUENESS_API_KEY": "",
                "XUENESS_PROVIDER": "openai",
                "XUENESS_ALLOW_LOOPBACK_HTTP": "0",
            }):
                client = provider_config.resolve(self.state_dir, runtime_profile="lightweight")
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual("lightweight", client.runtime_profile)
        self.assertEqual("", client.key)

    def test_proxy_environment_is_ignored_for_provider_requests(self):
        state = {}
        proxied = {"hits": 0}
        proxy_server = _server(proxied)
        server = _server(state)
        try:
            proxy_url = f"http://127.0.0.1:{proxy_server.server_port}"
            with patch.dict(os.environ, {
                "HTTP_PROXY": proxy_url, "http_proxy": proxy_url,
                "NO_PROXY": "", "no_proxy": "",
            }):
                client = OpenAICompatible(
                    base=f"http://127.0.0.1:{server.server_port}/v1",
                    model="fixture-model", key=FAKE_KEY, allow_loopback_http=True)
                client.complete([{"role": "user", "content": "hello"}], [])
        finally:
            proxy_server.shutdown()
            proxy_server.server_close()
            server.shutdown()
            server.server_close()
        self.assertEqual(1, state.get("hits"))
        self.assertEqual(0, proxied.get("hits", 0))

    def test_context_overflow_flag_uses_only_allowlisted_http_error_codes(self):
        secret = "must-never-appear-in-error-output"
        state = {}
        server = _server(state, status=400, payload={
            "error": {"code": "context_length_exceeded", "message": secret},
        })
        try:
            client = OpenAICompatible(
                base=f"http://127.0.0.1:{server.server_port}/v1",
                model="fixture-model", key=FAKE_KEY, allow_loopback_http=True)
            with self.assertRaises(ProviderRequestError) as raised:
                client.complete([{"role": "user", "content": "hello"}], [])
        finally:
            server.shutdown()
            server.server_close()
        self.assertTrue(raised.exception.context_overflow)
        self.assertEqual(400, raised.exception.status)
        self.assertNotIn(secret, str(raised.exception))
        self.assertEqual(1, state["hits"], "a non-retryable 400 should make one request")

        state = {}
        server = _server(state, status=413, payload={
            "error": {"code": "other", "message": "prompt_too_long"},
        })
        try:
            client = OpenAICompatible(
                base=f"http://127.0.0.1:{server.server_port}/v1",
                model="fixture-model", key=FAKE_KEY, allow_loopback_http=True)
            with self.assertRaises(ProviderRequestError) as raised:
                client.complete([{"role": "user", "content": "hello"}], [])
        finally:
            server.shutdown()
            server.server_close()
        self.assertFalse(raised.exception.context_overflow)


if __name__ == "__main__":
    unittest.main()
