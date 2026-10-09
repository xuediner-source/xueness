"""Absolute child-provider deadlines over local HTTP fixtures only."""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from xueness.core import Gate
from xueness.bundled_plugins.providers.provider import (
    AnthropicMessages,
    OpenAICompatible,
    ProviderRequestError,
)
from xueness.bundled_plugins.subagents.runner import run_subagent


OPENAI_REPLY = {"choices": [{"message": {
    "role": "assistant", "content": "OK", "tool_calls": [],
}}]}
ANTHROPIC_REPLY = {
    "id": "msg_fixture",
    "type": "message",
    "role": "assistant",
    "model": "fixture-model",
    "content": [{"type": "text", "text": "OK"}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 1, "output_tokens": 1},
}
OPENAI_FIRST_EVENT = (
    b'data: {"choices":[{"delta":{"content":"part"}}]}\n\n'
)
ANTHROPIC_FIRST_EVENT = (
    b'data: {"type":"content_block_start","index":0,'
    b'"content_block":{"type":"text","text":""}}\n\n'
    b'data: {"type":"content_block_delta","index":0,'
    b'"delta":{"type":"text_delta","text":"part"}}\n\n'
)


def _server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class SubagentDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def make_provider(self, protocol, server):
        base = f"http://127.0.0.1:{server.server_port}/v1"
        if protocol == "openai":
            return OpenAICompatible(
                base=base,
                model="fixture-model",
                key="test-key",
                allow_loopback_http=True,
                runtime_profile="standard",
            )
        return AnthropicMessages(
            base=base,
            model="fixture-model",
            key="test-key",
            allow_loopback_http=True,
        )

    def stop(self, server):
        server.shutdown()
        server.server_close()

    def slow_body_handler(self, body, state):
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
                        self.wfile.write(bytes((byte,)))
                        self.wfile.flush()
                        time.sleep(0.01)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        return Handler

    def slow_stream_handler(self, first_event, state):
        # A complete first event proves the parser has begun delivering output;
        # the long comment then drips without completing, exercising the same
        # absolute deadline after streaming has started.
        tail = b": " + (b"x" * 500) + b"\n\n"
        payload = first_event + tail

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(first_event)
                    self.wfile.flush()
                    for byte in tail:
                        self.wfile.write(bytes((byte,)))
                        self.wfile.flush()
                        time.sleep(0.01)
                except OSError:
                    pass
                finally:
                    state["finished"].set()

            def log_message(self, *_args):
                pass

        return Handler

    def test_standard_complete_deadlines_bound_dripping_bodies_for_both_protocols(self):
        for protocol, reply in (("openai", OPENAI_REPLY), ("anthropic", ANTHROPIC_REPLY)):
            with self.subTest(protocol=protocol):
                state = {"calls": 0, "finished": threading.Event()}
                body = json.dumps(reply, separators=(",", ":")).encode()
                server = _server(self.slow_body_handler(body, state))
                try:
                    provider = self.make_provider(protocol, server)
                    provider.request_deadline = time.monotonic() + 0.25
                    started = time.monotonic()
                    with self.assertRaises(ProviderRequestError) as raised:
                        provider.complete([{"role": "user", "content": "hi"}], [])
                    self.assertEqual(raised.exception.category, 'timeout')
                    self.assertEqual(raised.exception.stage, 'deadline')
                    self.assertLess(time.monotonic() - started, 1.2)
                    self.assertEqual(1, state["calls"])
                    self.assertTrue(state["finished"].wait(1))
                finally:
                    self.stop(server)

    def test_standard_stream_deadlines_bound_dripping_events_for_both_protocols(self):
        cases = (("openai", OPENAI_FIRST_EVENT),
                 ("anthropic", ANTHROPIC_FIRST_EVENT))
        for protocol, first_event in cases:
            with self.subTest(protocol=protocol):
                state = {"calls": 0, "finished": threading.Event()}
                server = _server(self.slow_stream_handler(first_event, state))
                try:
                    provider = self.make_provider(protocol, server)
                    provider.request_deadline = time.monotonic() + 0.25
                    deltas = []
                    started = time.monotonic()
                    with self.assertRaises(ProviderRequestError) as raised:
                        provider.stream(
                            [{"role": "user", "content": "hi"}], [], deltas.append)
                    self.assertEqual(raised.exception.category, 'timeout')
                    self.assertEqual(raised.exception.stage, 'deadline')
                    self.assertLess(time.monotonic() - started, 1.2)
                    self.assertEqual(["part"], deltas)
                    self.assertEqual(1, state["calls"])
                    self.assertTrue(state["finished"].wait(1))
                finally:
                    self.stop(server)

    def test_runner_assigns_deadline_to_isolated_adapter_and_inherits_shorter_parent(self):
        parent = OpenAICompatible(
            base="https://fixture.invalid/v1", model="fixture-model", key="test-key",
            runtime_profile="standard",
        )
        inherited = time.monotonic() + 30
        parent.request_deadline = inherited
        observed = []

        def run_child(child, _store, provider, _gate, **kwargs):
            observed.append((provider.request_deadline, kwargs["max_wall_seconds"]))
            child["status"] = "completed"
            child["completion"] = {"summary": "fixture result"}
            return child

        result = run_subagent(
            Gate(self.root), parent, [], "inspect this", None,
            depth=0, max_depth=1, state_dir=self.root,
            gate_class=Gate, run_fn=run_child, base_system="system",
            max_steps=4, summary_max=4000,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(1, len(observed))
        self.assertEqual(inherited, observed[0][0])
        self.assertEqual(120, observed[0][1])
        self.assertEqual(inherited, parent.request_deadline)

    def test_runner_ignores_invalid_inherited_deadline_and_keeps_provider_doubles_untouched(self):
        parent = OpenAICompatible(
            base="https://fixture.invalid/v1", model="fixture-model", key="test-key",
            runtime_profile="standard",
        )
        parent.request_deadline = float("inf")
        observed = []

        def run_child(child, _store, provider, _gate, **_kwargs):
            observed.append(provider.request_deadline)
            child["status"] = "completed"
            child["completion"] = {"summary": "fixture result"}
            return child

        result = run_subagent(
            Gate(self.root), parent, [], "inspect this", None,
            depth=0, max_depth=1, state_dir=self.root,
            gate_class=Gate, run_fn=run_child, base_system="system",
            max_steps=4, summary_max=4000,
        )
        self.assertTrue(result["ok"])
        # Compare absolute deadlines to avoid subtraction rounding on Windows.
        self.assertLessEqual(observed[0], time.monotonic() + 120)
        self.assertEqual(float("inf"), parent.request_deadline)

        class FakeProvider:
            pass

        fake = FakeProvider()
        # The normal runner leaves unrecognized test/third-party providers on
        # their legacy path rather than attaching adapter-only state to them.
        from xueness.bundled_plugins.subagents.runner import _assign_subagent_request_deadline
        self.assertIsNone(_assign_subagent_request_deadline(fake, fake))
        self.assertFalse(hasattr(fake, "request_deadline"))


if __name__ == "__main__":
    unittest.main()
