"""Local HTTP checks for lightweight inference deadlines and transport retries."""
from __future__ import annotations

import json
import threading
import time
import unittest
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
            with self.assertRaises(TimeoutError):
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
