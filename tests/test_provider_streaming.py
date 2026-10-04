"""Local protocol tests for streaming, retries and native Anthropic mapping."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness.provider import AnthropicMessages, OpenAICompatible
from xueness.bundled_plugins.providers.provider import (
    ProviderRequestError, _openai_messages, _split_multimodal, _to_anthropic_messages,
)
from xueness import providers_api, provider_config


def _server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class ProviderStreamTests(unittest.TestCase):
    def provider(self, server):
        return OpenAICompatible(base=f"http://127.0.0.1:{server.server_port}/v1",
                                model="gpt-4o-mini", key="test-key",
                                allow_loopback_http=True)

    def test_openai_sse_assembles_text_and_tool_arguments(self):
        payload = (
            'data: {"choices":[{"delta":{"reasoning_content":"plan "}}]}\n\n'
            'data: {"choices":[{"delta":{"reasoning":"steps"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n'
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n'
            'data: [DONE]\n\n'
        ).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            deltas = []
            reasoning = []
            result = self.provider(server).stream([{"role": "user", "content": "hi"}], [],
                                                  deltas.append,
                                                  on_reasoning_delta=reasoning.append)
            self.assertEqual("hello world", result["content"])
            self.assertEqual("hello world", "".join(deltas))
            self.assertEqual(["plan ", "steps"], reasoning)
            self.assertNotIn("plan", result["content"])
            self.assertEqual("read", result["tool_calls"][0]["function"]["name"])
            self.assertEqual('{"path":"a.txt"}', result["tool_calls"][0]["function"]["arguments"])
            self.assertEqual({"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}, result["_usage"])
        finally:
            server.shutdown(); server.server_close()

    def test_json_response_usage_survives_complete_and_stream_fallback(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                payload = json.dumps({'choices':[{'message':{'content':'answer','tool_calls':[]}}],
                                      'usage':{'prompt_tokens':7,'completion_tokens':3,'total_tokens':10}}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers(); self.wfile.write(payload)
            def log_message(self, *args): pass
        server = _server(Handler)
        try:
            provider = self.provider(server)
            for result in (provider.complete([{'role':'user','content':'hi'}], []),
                           provider.stream([{'role':'user','content':'hi'}], [])):
                self.assertEqual(result['_usage']['total_tokens'], 10)
                self.assertEqual(result['content'], 'answer')
        finally:
            server.shutdown(); server.server_close()

    def test_openai_reasoning_effort_is_sent_in_complete_and_stream_requests(self):
        bodies = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                bodies.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
                payload = json.dumps({"choices": [{"message": {
                    "role": "assistant", "content": "ok", "tool_calls": [],
                }}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            provider = OpenAICompatible(base=f"http://127.0.0.1:{server.server_port}/v1",
                                        model="gpt-6-sol", key="test-key",
                                        allow_loopback_http=True, reasoning_effort="max")
            messages = [{"role": "user", "content": "hi"}]
            provider.complete(messages, [])
            provider.stream(messages, [])
            self.assertEqual([body["reasoning_effort"] for body in bodies], ["max", "max"])
        finally:
            server.shutdown(); server.server_close()

    def test_public_reasoning_levels_preserve_explicit_empty_and_infer_only_known_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            base = {"name": "test", "baseUrl": "https://models.example.test/v1",
                    "apiKey": "test-key"}
            for pid, model, levels in (
                ("declared", "custom-model", ["low", "max"]),
                ("disabled", "gpt-6-sol", []),
                ("known", "gpt-6-sol", None),
                ("old", "o4-mini", None),
                ("unknown", "custom-model", None),
            ):
                payload = {"id": pid, **base, "model": model}
                if levels is not None:
                    payload["reasoningLevels"] = levels
                status, saved = providers_api.dispatch("POST", ["api", "providers"], {},
                                                       payload, {"state_dir": state})
                self.assertEqual(status, 200, saved)
            status, result = providers_api.dispatch("GET", ["api", "providers"], {}, {},
                                                    {"state_dir": state})
            self.assertEqual(status, 200)
            rows = {item["id"]: item for item in result["providers"]}
            self.assertEqual(rows["declared"]["reasoningLevels"], ["low", "max"])
            self.assertEqual(rows["disabled"]["reasoningLevels"], [])
            self.assertEqual(rows["known"]["reasoningLevels"], ["low", "medium", "high", "xhigh", "max"])
            self.assertEqual(rows["old"]["reasoningLevels"], ["low", "medium", "high"])
            self.assertNotIn("reasoningLevels", rows["unknown"])

    def test_retry_after_transient_response_before_any_delta(self):
        state = {"calls": 0}
        payload = b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                if state["calls"] == 1:
                    self.send_response(429)
                    self.send_header("Retry-After", "0")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            with patch("xueness.bundled_plugins.providers.provider.time.sleep"):
                result = self.provider(server).stream([{"role": "user", "content": "hi"}], [])
            self.assertEqual("ok", result["content"])
            self.assertEqual(2, state["calls"])
        finally:
            server.shutdown(); server.server_close()

    def test_exhausted_retry_exposes_only_safe_status_metadata(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(429)
                self.send_header("Retry-After", "30")
                self.send_header("Content-Length", "0")
                self.end_headers()
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            with patch("xueness.bundled_plugins.providers.provider.time.sleep"):
                with self.assertRaises(ProviderRequestError) as caught:
                    self.provider(server).stream([{"role": "user", "content": "hi"}], [])
            self.assertEqual(429, caught.exception.status)
            self.assertEqual(2.0, caught.exception.retry_after)
            self.assertNotIn("test-key", str(caught.exception))
        finally:
            server.shutdown(); server.server_close()

    def test_partial_output_is_never_retried(self):
        state = {"calls": 0}
        payload = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                state["calls"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload) + 20))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
                self.close_connection = True
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            deltas = []
            with self.assertRaisesRegex(RuntimeError, "details suppressed"):
                self.provider(server).stream([{"role": "user", "content": "hi"}], [], deltas.append)
            self.assertEqual(["partial"], deltas)
            self.assertEqual(1, state["calls"])
        finally:
            server.shutdown(); server.server_close()

    def test_anthropic_messages_request_and_stream_normalization(self):
        state = {"body": None, "headers": None}
        payload = (
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n'
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8}}}\n\n'
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}\n\n'
            'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":"initial "}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"thought"}}\n\n'
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read","input":{}}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x\\"}"}}\n\n'
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                state["body"] = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                state["headers"] = dict(self.headers.items())
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass

        server = _server(Handler)
        try:
            provider = AnthropicMessages(base=f"http://127.0.0.1:{server.server_port}/v1",
                                         model="claude-test", key="test-key",
                                         allow_loopback_http=True)
            schema = {"type": "function", "function": {"name": "read", "description": "read a file",
                      "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}
            deltas = []
            reasoning_deltas = []
            result = provider.stream([{"role": "system", "content": "system rules"},
                                      {"role": "user", "content": "hi"}], [schema], deltas.append,
                                     on_reasoning_delta=reasoning_deltas.append)
            self.assertEqual("answer", result["content"])
            self.assertEqual({"input_tokens": 8, "output_tokens": 2,
                              "prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}, result["_usage"])
            self.assertEqual(["answer"], deltas)
            self.assertEqual(["initial ", "thought"], reasoning_deltas)
            self.assertEqual("system rules", state["body"]["system"])
            self.assertEqual("read", state["body"]["tools"][0]["name"])
            headers = {name.lower(): value for name, value in state["headers"].items()}
            self.assertEqual("test-key", headers["x-api-key"])
            self.assertEqual('{"path":"x"}', result["tool_calls"][0]["function"]["arguments"])
        finally:
            server.shutdown(); server.server_close()

    def test_multimodal_provider_contract_and_capability_checks(self):
        marker = '\n\nXUENESS_MULTIMODAL_V1:[{"path":"photo.png","bytes":8,"sha256":"x","mimeType":"image/png","data":"iVBORw0KGgo="}]'
        openai = OpenAICompatible(base="https://example.com/v1", model="gpt-4o", key="k")
        converted = _openai_messages([{"role": "user", "content": "look" + marker}], openai)
        self.assertEqual("image_url", converted[0]["content"][1]["type"])
        anthropic = AnthropicMessages(base="https://api.anthropic.com/v1", model="claude-test", key="k")
        _, messages = _to_anthropic_messages([{"role": "user", "content": "look" + marker}], anthropic)
        self.assertEqual("image", messages[0]["content"][1]["type"])
        text_model = OpenAICompatible(base="https://example.com/v1", model="text-only", key="k")
        with self.assertRaisesRegex(ValueError, "does not declare image"):
            _openai_messages([{"role": "user", "content": "look" + marker}], text_model)
        for broken in (
            '[{"mimeType":"image/png","data":""}]',
            '[{"mimeType":"image/png","data":"aGVsbG8="}]',
            '[{"mimeType":"video/mp4","data":"aGVsbG8="}]',
        ):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                _split_multimodal("prompt\n\nXUENESS_MULTIMODAL_V1:" + broken)

    def test_anthropic_pdf_and_video_use_document_and_frame_blocks(self):
        attachments = [
            {"path": "doc.pdf", "bytes": 5, "sha256": "x", "mimeType": "application/pdf", "data": "JVBERi0x"},
            {"path": "clip.mp4", "bytes": 4, "sha256": "y", "mimeType": "video/mp4", "framesData": ["/9j/AA=="]},
        ]
        marker = "\n\nXUENESS_MULTIMODAL_V1:" + json.dumps(attachments)
        anthropic = AnthropicMessages(base="https://api.anthropic.com/v1", model="claude-test", key="k")
        _, messages = _to_anthropic_messages([{"role": "user", "content": "review" + marker}], anthropic)
        blocks = messages[0]["content"]
        self.assertEqual(["text", "document", "image"], [block["type"] for block in blocks])
        restricted = AnthropicMessages(base="https://api.anthropic.com/v1", model="claude-test", key="k",
                                       capabilities=("image",))
        with self.assertRaisesRegex(ValueError, "PDF input"):
            _to_anthropic_messages([{"role": "user", "content": "review" + marker}], restricted)

    def test_profile_protocol_and_capabilities_round_trip_without_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            status, payload = providers_api.dispatch(
                "POST", ["api", "providers"], {},
                {"id": "claude", "name": "Claude", "baseUrl": "https://api.anthropic.com/v1",
                 "model": "claude-test", "apiKey": "private-key", "protocol": "anthropic",
                 "capabilities": ["image", "pdf"]}, {"state_dir": state})
            self.assertEqual(200, status)
            self.assertEqual("anthropic", payload["provider"]["protocol"])
            self.assertEqual(["image", "pdf"], payload["provider"]["capabilities"])
            self.assertNotIn("private-key", json.dumps(payload))
            provider = provider_config.resolve(state, "claude")
            self.assertIsInstance(provider, AnthropicMessages)
            self.assertEqual(frozenset({"image", "pdf"}), provider.capabilities)


if __name__ == "__main__":
    unittest.main()
