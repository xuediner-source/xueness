"""Local HTTP checks for lightweight inference deadlines and transport retries."""
from __future__ import annotations

import http.client
import io
import json
import threading
import time
import unittest
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from xueness.bundled_plugins.providers.provider import (
    AnthropicMessages, OpenAICompatible, ProviderRequestError,
)


CHAT_REPLY = {"choices": [{"message": {
    "role": "assistant", "content": "OK", "tool_calls": [],
}}]}
SSE_REPLY = (
    b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
    b'data: [DONE]\n\n'
)


def _server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class LightweightTransportBudgetTests(unittest.TestCase):
    @contextmanager
    def assert_timeout(self):
        with self.assertRaises(ProviderRequestError) as caught:
            yield
        self.assertEqual('timeout', caught.exception.category)
        self.assertEqual('deadline', caught.exception.stage)

    def provider(self, server, *, options=None, profile="lightweight"):
        return OpenAICompatible(
            base=f"http://127.0.0.1:{server.server_port}/v1",
            model="fixture-model", key="test-key", allow_loopback_http=True,
            runtime_profile=profile,
            lightweight_options=options if options is not None else {
                "requestTimeoutSeconds": 1, "transportRetries": 0,
            },
        )

    def anthropic_provider(self, server, *, options=None):
        provider = AnthropicMessages(
            base=f"http://127.0.0.1:{server.server_port}/v1",
            model="fixture-model", key="test-key", allow_loopback_http=True,
        )
        provider.runtime_profile = "lightweight"
        provider.context_window = 8192
        provider.max_output_tokens = 1024
        provider.lightweight_options = options if options is not None else {
            "requestTimeoutSeconds": 1, "transportRetries": 0,
        }
        return provider

    def stop(self, server):
        server.shutdown()
        server.server_close()

    def _http_protocol_provider(self, kind, profile):
        cls = OpenAICompatible if kind == "openai" else AnthropicMessages
        provider = cls(base="https://provider.example/v1", model="fixture-model",
                       key="fixture-private-key")
        provider.runtime_profile = profile
        provider.context_window = 8192
        provider.max_output_tokens = 1024
        provider.lightweight_options = {
            "requestTimeoutSeconds": 5, "transportRetries": 2,
        }
        return provider

    def test_http_protocol_errors_are_sanitized_and_never_replayed(self):
        secret = b"fixture-private-response-must-not-escape"
        for kind in ("openai", "anthropic"):
            for profile in ("standard", "lightweight"):
                for operation in ("complete", "stream"):
                    for error in (http.client.BadStatusLine(secret.decode()),
                                  http.client.LineTooLong(secret.decode()),
                                  http.client.IncompleteRead(secret, 99)):
                        with self.subTest(kind=kind, profile=profile,
                                          operation=operation, error=type(error).__name__):
                            provider = self._http_protocol_provider(kind, profile)
                            with patch("xueness.bundled_plugins.providers.provider._open_with_retry",
                                       side_effect=error) as opened, patch(
                                    "urllib.request.OpenerDirector.open", side_effect=error) as direct:
                                with self.assertRaises(ProviderRequestError) as caught:
                                    getattr(provider, operation)([{"role": "user", "content": "hi"}], [])
                            self.assertEqual(1, opened.call_count + direct.call_count)
                            self.assertEqual("invalid_response", caught.exception.category)
                            self.assertEqual("parse", caught.exception.stage)
                            self.assertEqual(type(error).__name__, caught.exception.exception_type)
                            self.assertNotIn(secret.decode(), str(caught.exception))
                            self.assertNotIn(secret.decode(), repr(vars(caught.exception)))
                            self.assertTrue(caught.exception.__suppress_context__)

    def test_partial_status_line_at_deadline_is_timeout_without_replay(self):
        clock = [100.0]

        def expired_status(*_args, **_kwargs):
            # Reproduce a socket watchdog interrupting http.client._read_status.
            clock[0] = 101.0
            raise http.client.BadStatusLine("HTTP/1.1 20")

        for kind in ("openai", "anthropic"):
            for profile in ("standard", "lightweight"):
                for operation in ("complete", "stream"):
                    with self.subTest(kind=kind, profile=profile, operation=operation):
                        provider = self._http_protocol_provider(kind, profile)
                        clock[0] = 100.0
                        provider.request_deadline = 100.5
                        with patch("xueness.bundled_plugins.providers.provider._open_with_retry",
                                   side_effect=expired_status) as opened, patch(
                                "xueness.bundled_plugins.providers.provider.time.monotonic",
                                side_effect=lambda: clock[0]):
                            with self.assert_timeout():
                                getattr(provider, operation)([{"role": "user", "content": "hi"}], [])
                        self.assertEqual(1, opened.call_count)

    def test_terminal_parse_error_is_not_hidden_by_previous_transport_failure(self):
        provider = self._http_protocol_provider("openai", "standard")
        with patch("xueness.bundled_plugins.providers.provider._open_with_retry",
                   side_effect=[urllib.error.URLError("fixture connection interrupted"),
                                http.client.BadStatusLine("fixture-private-response")]) as opened, patch(
                "xueness.bundled_plugins.providers.provider.time.sleep"):
            with self.assertRaises(ProviderRequestError) as caught:
                provider.complete([{"role": "user", "content": "hi"}], [])
        self.assertEqual(2, opened.call_count)
        self.assertEqual("invalid_response", caught.exception.category)
        self.assertEqual("parse", caught.exception.stage)
        self.assertEqual("BadStatusLine", caught.exception.exception_type)

    def test_truncated_http_error_body_keeps_status_and_does_not_escape(self):
        class BrokenErrorBody(io.BytesIO):
            def read1(self, _limit):
                raise http.client.IncompleteRead(b"fixture-private-error-body", 99)

        for kind in ("openai", "anthropic"):
            for profile in ("standard", "lightweight"):
                for operation in ("complete", "stream"):
                    with self.subTest(kind=kind, profile=profile, operation=operation):
                        provider = self._http_protocol_provider(kind, profile)
                        body = BrokenErrorBody()
                        error = urllib.error.HTTPError(
                            "https://provider.example/v1", 400, "fixture error", {}, body)
                        with patch("urllib.request.OpenerDirector.open", side_effect=error) as opened:
                            with self.assertRaises(ProviderRequestError) as caught:
                                getattr(provider, operation)([{"role": "user", "content": "hi"}], [])
                        self.assertEqual(1, opened.call_count)
                        self.assertEqual(400, caught.exception.status)
                        self.assertFalse(caught.exception.context_overflow)
                        self.assertNotIn("fixture-private-error-body", str(caught.exception))
                        self.assertTrue(body.closed)

    def test_slow_headers_are_bounded_and_zero_retries_means_one_request(self):
        state = {"calls": 0, "finished": threading.Event()}
        body = json.dumps(CHAT_REPLY).encode()
        headers = (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            + b"Content-Length: " + str(len(body)).encode()
            + b"\r\nX-Slow: " + (b"x" * 160)
            + b"\r\nConnection: close\r\n\r\n"
        )

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                try:
                    for byte in headers + body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.015)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            started = time.monotonic()
            with self.assert_timeout():
                self.provider(server).complete([{"role": "user", "content": "hi"}], [])
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 2.5)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_slow_body_is_bounded_by_total_request_timeout(self):
        state = {"calls": 0, "finished": threading.Event()}
        body = json.dumps(CHAT_REPLY).encode()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.025)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            started = time.monotonic()
            with self.assert_timeout():
                self.provider(server).complete([{"role": "user", "content": "hi"}], [])
            self.assertLess(time.monotonic() - started, 2.5)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_transport_retries_allow_two_extra_attempts(self):
        state = {"calls": 0}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                if state["calls"] < 3:
                    self.send_response(503)
                    self.send_header("Retry-After", "0")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(SSE_REPLY)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(SSE_REPLY)

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 5, "transportRetries": 2,
            })
            result = provider.stream([{"role": "user", "content": "hi"}], [])
            self.assertEqual("ok", result["content"])
            self.assertEqual(3, state["calls"])
        finally:
            self.stop(server)

    def test_anthropic_lightweight_complete_bounds_slow_response_body(self):
        state = {"calls": 0, "finished": threading.Event()}
        body = json.dumps({"content": [{"type": "text", "text": "OK"}]}).encode()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.025)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            started = time.monotonic()
            with self.assert_timeout():
                self.anthropic_provider(server).complete(
                    [{"role": "user", "content": "hi"}], [])
            self.assertLess(time.monotonic() - started, 2.5)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_anthropic_lightweight_stream_retries_up_to_two_times(self):
        state = {"calls": 0}
        stream_body = (
            b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'
            b'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
            b'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'
            b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        )

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                if state["calls"] < 3:
                    self.send_response(503)
                    self.send_header("Retry-After", "0")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(stream_body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(stream_body)

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            result = self.anthropic_provider(server, options={
                "requestTimeoutSeconds": 5, "transportRetries": 2,
            }).stream([{"role": "user", "content": "hi"}], [])
            self.assertEqual("ok", result["content"])
            self.assertEqual(3, state["calls"])
            self.assertEqual({"prompt_tokens": 3, "completion_tokens": 2,
                              "total_tokens": 5, "input_tokens": 3,
                              "output_tokens": 2}, result["_usage"])
        finally:
            self.stop(server)

    def test_anthropic_reasoning_delta_prevents_stream_replay(self):
        state = {"calls": 0, "finished": threading.Event()}
        partial = (
            b'event: content_block_delta\n'
            b'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n'
        )

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(partial) + 100))
                self.end_headers()
                try:
                    self.wfile.write(partial)
                    self.wfile.flush()
                    time.sleep(1.5)
                    self.wfile.write(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
                    self.wfile.flush()
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            reasoning = []
            with self.assert_timeout():
                self.anthropic_provider(server, options={
                    "requestTimeoutSeconds": 1, "transportRetries": 2,
                }).stream(
                    [{"role": "user", "content": "hi"}], [],
                    on_reasoning_delta=reasoning.append,
                )
            self.assertEqual(["plan"], reasoning)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_huge_run_deadline_is_rejected_without_overflow_or_network_call(self):
        state = {"calls": 0}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                state["calls"] += 1
                self.send_response(500)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server)
            provider.request_deadline = 10 ** 10_000
            with self.assertRaisesRegex(ValueError, "invalid provider request deadline"):
                provider.complete([{"role": "user", "content": "hi"}], [])
            self.assertEqual(0, state["calls"])
        finally:
            self.stop(server)

    def test_stream_timeout_after_delta_does_not_replay(self):
        state = {"calls": 0, "finished": threading.Event()}
        partial = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(partial) + 100))
                self.end_headers()
                try:
                    self.wfile.write(partial)
                    self.wfile.flush()
                    time.sleep(1.5)
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 1, "transportRetries": 2,
            })
            deltas = []
            started = time.monotonic()
            with self.assert_timeout():
                provider.stream([{"role": "user", "content": "hi"}], [], deltas.append)
            self.assertLess(time.monotonic() - started, 2.5)
            self.assertEqual(["partial"], deltas)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_reasoning_delta_also_prevents_stream_replay(self):
        state = {"calls": 0, "finished": threading.Event()}
        partial = b'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n'

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(partial) + 100))
                self.end_headers()
                try:
                    self.wfile.write(partial)
                    self.wfile.flush()
                    time.sleep(1.5)
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 1, "transportRetries": 2,
            })
            reasoning = []
            with self.assert_timeout():
                provider.stream(
                    [{"role": "user", "content": "hi"}], [],
                    on_reasoning_delta=reasoning.append,
                )
            self.assertEqual(["plan"], reasoning)
            self.assertEqual(1, state["calls"])
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_run_deadline_shortens_the_profile_timeout(self):
        body = json.dumps(CHAT_REPLY).encode()
        state = {"finished": threading.Event()}

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.025)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 5, "transportRetries": 0,
            })
            provider.request_deadline = time.monotonic() + 0.25
            started = time.monotonic()
            with self.assert_timeout():
                provider.complete([{"role": "user", "content": "hi"}], [])
            self.assertLess(time.monotonic() - started, 0.9)
            self.assertTrue(state["finished"].wait(1))
        finally:
            self.stop(server)

    def test_retry_after_sleep_cannot_outlive_run_deadline_or_start_another_attempt(self):
        state = {"calls": 0}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(503)
                self.send_header("Retry-After", "2")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 5, "transportRetries": 2,
            })
            provider.request_deadline = time.monotonic() + 0.25
            started = time.monotonic()
            with self.assert_timeout():
                provider.complete([{"role": "user", "content": "hi"}], [])
            self.assertLess(time.monotonic() - started, 0.9)
            self.assertEqual(1, state["calls"])
        finally:
            self.stop(server)

    def test_connection_probe_keeps_its_fixed_timeout(self):
        raw = json.dumps(CHAT_REPLY).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                time.sleep(1.15)
                try:
                    self.wfile.write(raw)
                    self.wfile.flush()
                except OSError:
                    pass

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, options={
                "requestTimeoutSeconds": 1, "transportRetries": 0,
            })
            result = provider.test_connection(timeout=3)
            self.assertEqual("OK", result["content"])
        finally:
            self.stop(server)

    def test_standard_streaming_keeps_three_attempts(self):
        state = {"calls": 0}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                if state["calls"] < 3:
                    self.send_response(503)
                    self.send_header("Retry-After", "0")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(SSE_REPLY)))
                self.end_headers()
                self.wfile.write(SSE_REPLY)

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            provider = self.provider(server, profile="standard")
            result = provider.stream([{"role": "user", "content": "hi"}], [])
            self.assertEqual("ok", result["content"])
            self.assertEqual(3, state["calls"])
        finally:
            self.stop(server)

    def test_standard_streaming_error_remains_sanitized(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(429)
                self.send_header("Retry-After", "30")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = _server(Handler)
        try:
            with patch("xueness.bundled_plugins.providers.provider.time.sleep"):
                with self.assertRaises(ProviderRequestError) as caught:
                    self.provider(server, profile="standard").stream(
                        [{"role": "user", "content": "hi"}], [])
            self.assertEqual(429, caught.exception.status)
            self.assertNotIn("test-key", str(caught.exception))
        finally:
            self.stop(server)


if __name__ == "__main__":
    unittest.main()
