"""Explicit, bounded model discovery for saved OpenAI-compatible profiles."""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness import cli, web
from xueness.bundled_plugins.providers import providers_api


SECRET = "test-discovery-secret-never-returned"
MODEL_LIST = {
    "object": "list",
    "data": [{
        "id": "model-a",
        "object": "model",
        "created": 1_700_000_000,
        "owned_by": "fixture-team",
        "capabilities": ["image"],
        "context_window": 999_999,
        "apiKey": SECRET,
    }],
}


def _server(state, *, redirect_to=None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            state["hits"] = state.get("hits", 0) + 1
            state["method"] = "GET"
            state["path"] = self.path
            state["headers"] = dict(self.headers.items())
            if redirect_to is not None:
                self.send_response(302)
                self.send_header("Location", redirect_to)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raw = json.dumps(state.get("payload", MODEL_LIST)).encode("utf-8")
            self.send_response(state.get("status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            if state.get("trickle"):
                self.send_header("Connection", "close")
            self.end_headers()
            try:
                if state.get("trickle"):
                    for byte in raw:
                        self.wfile.write(bytes((byte,)))
                        self.wfile.flush()
                        time.sleep(state.get("delay", 0.02))
                    return
                self.wfile.write(raw)
            except OSError:
                pass
            finally:
                if state.get("done") is not None:
                    state["done"].set()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class ProviderDiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.ctx = {"state_dir": self.state_dir, "allow_real": True}
        self._servers = []

    def tearDown(self):
        for server in reversed(self._servers):
            server.shutdown()
            server.server_close()

    def start_server(self, state, *, redirect_to=None):
        server = _server(state, redirect_to=redirect_to)
        self._servers.append(server)
        return server

    def save(self, base_url, *, protocol="openai", key=SECRET, **extra):
        data = {
            "id": "fixture",
            "name": "Fixture profile",
            "baseUrl": base_url,
            "model": "saved-default",
            "protocol": protocol,
            "runtimeProfile": "lightweight",
        }
        if key is not None:
            data["apiKey"] = key
        data.update(extra)
        return providers_api.dispatch(
            "POST", ["api", "providers"], {}, data, self.ctx)

    def discover(self, data=None):
        if data is None:
            data = {"id": "fixture"}
        return providers_api.dispatch(
            "POST", ["api", "providers", "discover"], {}, data, self.ctx)

    def test_discovery_returns_only_service_ids_and_small_validated_metadata(self):
        state = {}
        server = self.start_server(state)
        status, saved = self.save(f"http://127.0.0.1:{server.server_port}/v1")
        self.assertEqual(200, status, saved)

        status, result = self.discover()

        self.assertEqual(200, status, result)
        self.assertEqual({
            "ok": True,
            "provider": {
                "id": "fixture", "name": "Fixture profile",
                "model": "saved-default", "protocol": "openai",
            },
            "models": [{
                "id": "model-a", "created": 1_700_000_000,
                "ownedBy": "fixture-team",
            }],
        }, result)
        self.assertEqual("GET", state["method"])
        self.assertEqual("/v1/models", state["path"])
        self.assertEqual("Bearer " + SECRET, state["headers"]["Authorization"])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn("apiKey", json.dumps(result))
        self.assertNotIn("capabilities", json.dumps(result))
        self.assertNotIn("context_window", json.dumps(result))

        stored = providers_api._read_record(
            providers_api._providers_dir(self.ctx) / "fixture.json")
        self.assertEqual("lightweight", stored["runtimeProfile"])

    def test_lightweight_loopback_profile_can_discover_without_an_authorization_header(self):
        state = {}
        server = self.start_server(state)
        status, saved = self.save(
            f"http://127.0.0.1:{server.server_port}/v1", key=None)
        self.assertEqual(200, status, saved)

        status, result = self.discover()

        self.assertEqual(200, status, result)
        self.assertEqual([{"id": "model-a", "created": 1_700_000_000,
                           "ownedBy": "fixture-team"}], result["models"])
        self.assertFalse(any(key.casefold() == "authorization"
                             for key in state["headers"]))

    def test_literal_loopback_discovery_bypasses_environment_proxies(self):
        state = {}
        server = self.start_server(state)
        proxy_state = {"payload": {"data": []}}
        proxy = self.start_server(proxy_state)
        proxy_url = f"http://127.0.0.1:{proxy.server_port}"
        self.save(f"http://127.0.0.1:{server.server_port}/v1")
        with patch.dict(os.environ, {
            "http_proxy": proxy_url, "HTTP_PROXY": proxy_url,
            "https_proxy": proxy_url, "HTTPS_PROXY": proxy_url,
            "all_proxy": proxy_url, "ALL_PROXY": proxy_url,
            "no_proxy": "", "NO_PROXY": "",
        }):
            status, result = self.discover()

        self.assertEqual(200, status, result)
        self.assertEqual(1, state["hits"])
        self.assertEqual(0, proxy_state.get("hits", 0))

    def test_discovery_refuses_redirects_without_contacting_the_redirect_target(self):
        destination_state = {}
        destination = self.start_server(destination_state)
        source_state = {}
        source = self.start_server(
            source_state,
            redirect_to=f"http://127.0.0.1:{destination.server_port}/models")
        self.save(f"http://127.0.0.1:{source.server_port}/v1")

        status, result = self.discover()

        self.assertEqual(502, status)
        self.assertEqual(
            {"error": "provider model discovery failed (details suppressed)"}, result)
        self.assertEqual(1, source_state["hits"])
        self.assertEqual(0, destination_state.get("hits", 0))
        self.assertNotIn(SECRET, json.dumps(result))

    def test_slow_trickling_model_list_hits_the_total_deadline(self):
        state = {"trickle": True, "delay": 0.02, "done": threading.Event()}
        server = self.start_server(state)
        self.save(f"http://127.0.0.1:{server.server_port}/v1")

        with patch.object(providers_api, "MODEL_DISCOVERY_TIMEOUT_SECONDS", 0.25):
            started = time.monotonic()
            status, result = self.discover()
            elapsed = time.monotonic() - started

        self.assertEqual(502, status)
        self.assertEqual(
            {"error": "provider model discovery failed (details suppressed)"}, result)
        self.assertLess(elapsed, 1.0)
        self.assertTrue(state["done"].wait(1), "deadline should close the provider socket")

    def test_invalid_oversized_duplicate_and_credential_echo_lists_are_suppressed(self):
        state = {}
        server = self.start_server(state)
        self.save(f"http://127.0.0.1:{server.server_port}/v1")
        invalid_lists = [
            {"data": {"id": "not-a-list"}},
            {"data": [{"id": "same"}, {"id": "same"}]},
            {"data": [{"id": "x" * 257}]},
            {"data": [{"id": SECRET}]},
            {"data": [{"id": f"model-{i}"} for i in range(501)]},
            {"data": [], "extra": "x" * 520_000},
        ]
        for payload in invalid_lists:
            with self.subTest(payload_shape=str(payload)[:50]):
                state["payload"] = payload
                status, result = self.discover()
                self.assertEqual(502, status)
                self.assertEqual(
                    {"error": "provider model discovery failed (details suppressed)"}, result)
                self.assertNotIn(SECRET, json.dumps(result))

    def test_discovery_requires_server_gate_and_exact_saved_id_only_body(self):
        state = {}
        server = self.start_server(state)
        self.save(f"http://127.0.0.1:{server.server_port}/v1")
        self.assertEqual(400, self.discover({"id": "fixture", "apiKey": SECRET})[0])
        self.assertEqual(400, self.discover({"id": "../fixture"})[0])
        self.ctx["allow_real"] = False
        status, result = self.discover()
        self.assertEqual(403, status)
        self.assertNotIn("hits", state)

    def test_http_discovery_endpoint_inherits_csrf_guard(self):
        state = {}
        model_server = self.start_server(state)
        self.save(f"http://127.0.0.1:{model_server.server_port}/v1")
        ctx = web.build_context(
            self.state_dir, self.root / "runs", self.root,
            allow_real=True, csrf="model-discovery-csrf")
        server = web.create_server(0, ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/providers/discover",
                data=b'{"id":"fixture"}',
                headers={"Content-Type": "application/json"},
                method="POST")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=3)
            self.assertEqual(403, caught.exception.code)
            self.assertEqual(
                {"error": "csrf token required", "code": "csrf_required", "status": 403},
                json.loads(caught.exception.read()))
            caught.exception.close()
        finally:
            server.shutdown()
            server.server_close()
        self.assertNotIn("hits", state)

    def test_anthropic_discovery_is_clearly_unsupported_without_network_access(self):
        state = {}
        server = self.start_server(state)
        self.save(f"http://127.0.0.1:{server.server_port}/v1", protocol="anthropic")

        status, result = self.discover()

        self.assertEqual(400, status)
        self.assertEqual({
            "error": "model discovery is not supported for Anthropic providers"}, result)
        self.assertNotIn("hits", state)

    def test_cli_discover_is_registered_by_providers_plugin_and_uses_same_contract(self):
        state = {}
        server = self.start_server(state)
        self.save(f"http://127.0.0.1:{server.server_port}/v1")
        from io import StringIO
        from contextlib import redirect_stderr, redirect_stdout

        output = StringIO()
        error = StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            result = cli.main([
                "--state", str(self.state_dir), "providers", "discover", "fixture"])

        self.assertEqual(0, result, error.getvalue())
        self.assertEqual(1, state["hits"])
        self.assertEqual([{"id": "model-a", "created": 1_700_000_000,
                           "ownedBy": "fixture-team"}], json.loads(output.getvalue())["models"])
        self.assertNotIn(SECRET, output.getvalue())


if __name__ == "__main__":
    unittest.main()
