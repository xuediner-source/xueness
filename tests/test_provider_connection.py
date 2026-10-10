"""Explicit saved-provider connection tests use only local HTTP fixtures."""
from __future__ import annotations

import json
import threading
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.providers import providers_api
from xueness import web


SECRET = "test-profile-secret-never-returned"


def _fixture_server(state, *, status=200, payload=None):
    response = payload or {"choices": [{"message": {"role": "assistant", "content": "OK"}}]}
    raw = json.dumps(response).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            state["path"] = self.path
            state["headers"] = dict(self.headers.items())
            state["body"] = json.loads(self.rfile.read(length))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _slow_fixture_server(state, *, delay=0.03, chunks=100):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            state["body"] = json.loads(self.rfile.read(length))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                # Deliberately keep the connection active by trickling bytes;
                # a per-read socket timeout alone would never stop this peer.
                for _ in range(chunks):
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    time.sleep(delay)
            except OSError:
                pass
            finally:
                state["handler_done"].set()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _slow_header_fixture_server(state, *, delay=0.02):
    body = json.dumps({"choices": [{"message": {"role": "assistant", "content": "OK"}}]}).encode()
    headers = (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        + b"Content-Length: " + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
    )

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            try:
                for byte in headers:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(delay)
                self.wfile.write(body)
                self.wfile.flush()
            except OSError:
                pass
            finally:
                state["handler_done"].set()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class ProviderConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.state_dir = self.base / "state"
        self.state_dir.mkdir()
        (self.state_dir / "providers").mkdir()
        self.ctx = {"state_dir": self.state_dir, "allow_real": True}
        self.local_http = patch.dict("os.environ", {"XUENESS_ALLOW_LOOPBACK_HTTP": "1"})
        self.local_http.start()
        self.addCleanup(self.local_http.stop)
        self.addCleanup(self.temp.cleanup)

    def save_profile(self, base_url, *, protocol="openai", provider_id="fixture", model="fixture-model"):
        status, payload = providers_api.dispatch("POST", ["api", "providers"], {}, {
            "id": provider_id,
            "name": "Fixture profile",
            "baseUrl": base_url,
            "model": model,
            "protocol": protocol,
            "apiKey": SECRET,
        }, self.ctx)
        self.assertEqual(status, 200, payload)
        return payload

    def call_test(self, data):
        return providers_api.dispatch("POST", ["api", "providers", "test"], {}, data, self.ctx)

    def test_openai_profile_test_makes_one_small_request_and_never_echoes_secret(self):
        state = {}
        server = _fixture_server(state)
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual({"id": "fixture", "name": "Fixture profile", "model": "fixture-model", "protocol": "openai"}, payload["provider"])
        self.assertGreaterEqual(payload["latencyMs"], 0)
        self.assertEqual("/v1/chat/completions", state["path"])
        self.assertEqual("Bearer " + SECRET, state["headers"]["Authorization"])
        self.assertEqual("fixture-model", state["body"]["model"])
        self.assertEqual(8, state["body"]["max_tokens"])
        self.assertEqual([], state["body"]["tools"])
        self.assertEqual("Reply with exactly OK.", state["body"]["messages"][0]["content"])
        serialized = json.dumps(payload)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn("apiKey", serialized)
        self.assertNotIn("OK", serialized)

    def test_anthropic_profile_uses_messages_api_and_bounded_output(self):
        state = {}
        server = _fixture_server(state, payload={"content": [{"type": "text", "text": "OK"}]})
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1", protocol="anthropic")
            status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(status, 200, payload)
        self.assertEqual("anthropic", payload["provider"]["protocol"])
        self.assertEqual("/v1/messages", state["path"])
        self.assertEqual(8, state["body"]["max_tokens"])
        self.assertEqual("fixture-model", state["body"]["model"])
        self.assertEqual(SECRET, next(value for key, value in state["headers"].items() if key.lower() == "x-api-key"))
        self.assertNotIn(SECRET, json.dumps(payload))

    def test_current_openai_reasoning_families_use_supported_completion_limit_field(self):
        state = {}
        server = _fixture_server(state)
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1", model="gpt-6-astra")
            status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(200, status, payload)
        self.assertEqual("gpt-6-astra", state["body"]["model"])
        self.assertEqual(8, state["body"]["max_completion_tokens"])
        self.assertNotIn("max_tokens", state["body"])

    def test_server_real_provider_gate_blocks_before_network(self):
        state = {}
        server = _fixture_server(state)
        self.ctx["allow_real"] = False
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(403, status)
        self.assertNotIn("path", state)
        self.assertNotIn(SECRET, json.dumps(payload))

    def test_unknown_fields_missing_profiles_and_invalid_ids_do_not_call_provider(self):
        state = {}
        server = _fixture_server(state)
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            self.assertEqual(400, self.call_test({"id": "fixture", "apiKey": SECRET})[0])
            self.assertEqual(400, self.call_test({"id": "../fixture"})[0])
            self.assertEqual(404, self.call_test({"id": "missing"})[0])
        finally:
            server.shutdown()
            server.server_close()
        self.assertNotIn("path", state)

    def test_remote_error_body_is_never_returned(self):
        state = {}
        server = _fixture_server(state, status=401, payload={"error": f"bad key {SECRET}"})
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(502, status)
        self.assertEqual({"error": "provider connection failed (details suppressed)"}, payload)
        self.assertNotIn(SECRET, json.dumps(payload))

    def test_slow_trickling_response_hits_total_deadline_and_closes_connection(self):
        state = {"handler_done": threading.Event()}
        server = _slow_fixture_server(state)
        started = time.monotonic()
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            with patch.object(providers_api, "CONNECTION_TEST_TIMEOUT_SECONDS", 0.25):
                status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()
        elapsed = time.monotonic() - started

        self.assertEqual(502, status)
        self.assertEqual({"error": "provider connection failed (details suppressed)"}, payload)
        self.assertLess(elapsed, 1.0)
        self.assertTrue(state["handler_done"].wait(1), "client should close the socket so the peer exits")

    def test_slow_trickling_headers_hit_total_deadline_and_close_connection(self):
        state = {"handler_done": threading.Event()}
        server = _slow_header_fixture_server(state)
        started = time.monotonic()
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            with patch.object(providers_api, "CONNECTION_TEST_TIMEOUT_SECONDS", 0.25):
                status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()
        elapsed = time.monotonic() - started

        self.assertEqual(502, status)
        self.assertEqual({"error": "provider connection failed (details suppressed)"}, payload)
        self.assertLess(elapsed, 0.9)
        self.assertTrue(state["handler_done"].wait(1), "deadline should close the socket while headers are read")

    def test_oversized_provider_response_is_bounded_and_suppressed(self):
        state = {}
        server = _fixture_server(
            state,
            payload={"choices": [{"message": {"role": "assistant", "content": "x" * 256}}]},
        )
        try:
            self.save_profile(f"http://127.0.0.1:{server.server_address[1]}/v1")
            with patch("xueness.bundled_plugins.providers.provider.MAX_PROVIDER_RESPONSE_BYTES", 64):
                status, payload = self.call_test({"id": "fixture"})
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(502, status)
        self.assertEqual({"error": "provider connection failed (details suppressed)"}, payload)
        self.assertNotIn("x" * 32, json.dumps(payload))

    def test_latency_reports_elapsed_value_without_silent_eight_second_clamp(self):
        self.save_profile("https://provider.example.test/v1")

        class SuccessfulProvider:
            def test_connection(self, timeout):
                return {"role": "assistant", "content": "OK"}

        with patch(
            "xueness.bundled_plugins.providers.provider_config.resolve",
            return_value=SuccessfulProvider(),
        ), patch.object(providers_api.time, "monotonic", side_effect=[100.0, 108.25]):
            status, payload = self.call_test({"id": "fixture"})

        self.assertEqual(200, status, payload)
        self.assertEqual(8_250, payload["latencyMs"])

    def test_concurrent_save_preserves_rotated_key_after_blank_key_edit(self):
        base_url = "https://provider.example.test/v1"
        self.save_profile(base_url)
        first_inside_write = threading.Event()
        release_first_write = threading.Event()
        rotated_write_done = threading.Event()
        results = {}
        original_write = providers_api._atomic_write

        def gated_write(path, record):
            thread_name = threading.current_thread().name
            if thread_name == "save-without-key":
                first_inside_write.set()
                if not release_first_write.wait(2):
                    raise TimeoutError("test did not release first provider save")
            written = original_write(path, record)
            if thread_name == "rotate-provider-key":
                rotated_write_done.set()
            return written

        def save(name, body):
            results[name] = providers_api.dispatch(
                "POST", ["api", "providers"], {}, body, self.ctx)[0]

        preserve_blank_key = {
            "id": "fixture", "name": "Blank key editor", "baseUrl": base_url,
            "model": "fixture-model",
        }
        rotate_key = {
            "id": "fixture", "name": "Rotated", "baseUrl": base_url,
            "model": "fixture-model", "apiKey": "rotated-provider-secret",
        }
        with patch.object(providers_api, "_atomic_write", side_effect=gated_write):
            first = threading.Thread(
                target=save, args=("blank", preserve_blank_key), name="save-without-key")
            second = threading.Thread(
                target=save, args=("rotate", rotate_key), name="rotate-provider-key")
            first.start()
            self.assertTrue(first_inside_write.wait(1))
            second.start()
            try:
                self.assertFalse(rotated_write_done.wait(0.15))
            finally:
                release_first_write.set()
            first.join(2)
            second.join(2)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual({"blank": 200, "rotate": 200}, results)
        saved = providers_api._read_record(providers_api._providers_dir(self.ctx) / "fixture.json")
        self.assertEqual("rotated-provider-secret", saved["apiKey"])

    def test_http_endpoint_inherits_csrf_guard(self):
        project = self.base / "project"
        project.mkdir()
        ctx = web.build_context(self.base / "web-state", self.base / "runs", project,
                                allow_real=True, csrf="connection-test-csrf")
        server = web.create_server(0, ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_address[1]}/api/providers/test",
                data=b'{"id":"fixture"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
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


if __name__ == "__main__":
    unittest.main()
