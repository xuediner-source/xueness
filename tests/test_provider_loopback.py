"""Loopback-only plaintext HTTP provider option (isolated gateway path).

Uses disposable localhost servers and a fake key only. No live DSH,
no credentials, no external network.
"""
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile

from xueness.core import Gate, Store, run
from xueness.provider import (
    LOOPBACK_HTTP_ENV,
    OpenAICompatible,
    _is_loopback_literal,
    _loopback_http_enabled,
)

FAKE_KEY = "test-loopback-fake-key-xyz"


class LoopbackLiteralTests(unittest.TestCase):
    def test_accepts_loopback_ip_literals(self):
        for host in ("127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1"):
            self.assertTrue(_is_loopback_literal(host), host)

    def test_rejects_dns_tricks_and_non_loopback(self):
        for host in (
            "localhost", "LOCALHOST", "127.0.0.1.evil.com", "evil127.0.0.1",
            "2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1",
            "127.1", "10.0.0.1", "192.168.1.1", "8.8.8.8",
            "0.0.0.0", "::", "::ffff:8.8.8.8", "::ffff:10.0.0.1", "", None,
        ):
            self.assertFalse(_is_loopback_literal(host), repr(host))


class LoopbackGateTests(unittest.TestCase):
    def setUp(self):
        self._old = os.environ.get(LOOPBACK_HTTP_ENV)

    def tearDown(self):
        if self._old is None:
            os.environ.pop(LOOPBACK_HTTP_ENV, None)
        else:
            os.environ[LOOPBACK_HTTP_ENV] = self._old

    def test_http_requires_opt_in(self):
        os.environ.pop(LOOPBACK_HTTP_ENV, None)
        with self.assertRaises(ValueError):
            OpenAICompatible(base="http://127.0.0.1:7863/v1", model="m", key="k")
        os.environ[LOOPBACK_HTTP_ENV] = "1"
        p = OpenAICompatible(base="http://127.0.0.1:7863/v1", model="m", key="k")
        self.assertEqual(p.model, "m")
        # Explicit param wins over env.
        os.environ[LOOPBACK_HTTP_ENV] = "0"
        OpenAICompatible(base="http://127.0.0.1:7863/v1", model="m", key="k",
                         allow_loopback_http=True)
        os.environ[LOOPBACK_HTTP_ENV] = "1"
        with self.assertRaises(ValueError):
            OpenAICompatible(base="http://127.0.0.1:7863/v1", model="m", key="k",
                             allow_loopback_http=False)

    def test_http_rejects_non_loopback_even_with_opt_in(self):
        os.environ[LOOPBACK_HTTP_ENV] = "1"
        bad = [
            "http://localhost:7863/v1",
            "http://127.0.0.1.evil.com/v1",
            "http://2130706433/v1",
            "http://0x7f000001/v1",
            "http://10.0.0.1:7863/v1",
            "http://0.0.0.0:7863/v1",
            "http://[::]:7863/v1",
            "http://8.8.8.8/v1",
            "http://user:pass@127.0.0.1:7863/v1",
            "http://127.0.0.1:7863/v1?q=1",
            "http://127.0.0.1:7863/v1#frag",
        ]
        for base in bad:
            with self.assertRaises(ValueError, msg=base):
                OpenAICompatible(base=base, model="m", key="k")

    def test_https_behavior_unchanged(self):
        os.environ.pop(LOOPBACK_HTTP_ENV, None)
        p = OpenAICompatible(base="https://example.org/v1", model="m", key="k")
        self.assertEqual(p.model, "m")
        # HTTPS with userinfo/query still rejected.
        for base in ("https://user@example.org/v1", "https://example.org/v1?q=1"):
            with self.assertRaises(ValueError, msg=base):
                OpenAICompatible(base=base, model="m", key="k")
        # Non-http(s) schemes rejected even with opt-in.
        os.environ[LOOPBACK_HTTP_ENV] = "1"
        with self.assertRaises(ValueError):
            OpenAICompatible(base="ftp://127.0.0.1/v1", model="m", key="k")

    def test_loopback_flag_values(self):
        for val in ("1", "true", "TRUE", "yes", "on", " 1 "):
            os.environ[LOOPBACK_HTTP_ENV] = val
            self.assertTrue(_loopback_http_enabled(), val)
        for val in ("0", "false", "no", "off", "", "  "):
            os.environ[LOOPBACK_HTTP_ENV] = val
            self.assertFalse(_loopback_http_enabled(), repr(val))


def _serve(handler_cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class RedirectLeakTests(unittest.TestCase):
    def test_redirect_never_forwards_bearer(self):
        seen = {"auth": [], "hits": 0}

        class Sink(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                self.rfile.read(length)
                seen["hits"] += 1
                seen["auth"].append(self.headers.get("Authorization"))
                body = json.dumps({"choices": [{"message": {"content": "leaked"}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        sink = _serve(Sink)
        sink_port = sink.server_address[1]

        class Redirector(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                self.rfile.read(length)
                self.send_response(307)
                self.send_header("Location", f"http://127.0.0.1:{sink_port}/v1/chat/completions")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        redirector = _serve(Redirector)
        try:
            port = redirector.server_address[1]
            p = OpenAICompatible(base=f"http://127.0.0.1:{port}/v1", model="m",
                                 key=FAKE_KEY, allow_loopback_http=True)
            with self.assertRaisesRegex(RuntimeError, "details suppressed"):
                p.complete([{"role": "user", "content": "hi"}], [])
            # Bearer must never arrive at the redirect destination.
            self.assertEqual(seen["auth"], [])
            self.assertEqual(seen["hits"], 0)
        finally:
            redirector.shutdown()
            sink.shutdown()
            redirector.server_close()
            sink.server_close()


class LoopbackRoundtripTests(unittest.TestCase):
    def test_openai_toolcall_roundtrip_over_loopback_http(self):
        seen_auth = []

        class ChatHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != "/v1/chat/completions":
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                seen_auth.append(self.headers.get("Authorization"))
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = {}
                messages = payload.get("messages", [])
                has_write_result = any(
                    m.get("tool_call_id") == "loop-write" for m in messages
                )
                if not has_write_result:
                    reply = {"content": "", "tool_calls": [
                        {"id": "loop-write", "type": "function",
                         "function": {"name": "write", "arguments": json.dumps(
                             {"path": "hello.txt", "content": "Xueness loopback\n"})}},
                        {"id": "loop-read", "type": "function",
                         "function": {"name": "read", "arguments": json.dumps({"path": "hello.txt"})}},
                    ]}
                else:
                    reply = {"content": json.dumps({
                        "summary": "Created and read hello.txt over loopback",
                        "evidence": [
                            {"tool_call_id": "loop-write", "observation": "write acknowledged"},
                            {"tool_call_id": "loop-read", "observation": "file content read back"},
                        ]})}
                body = json.dumps({"choices": [{"message": reply}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = _serve(ChatHandler)
        tmp = tempfile.TemporaryDirectory()
        try:
            port = server.server_address[1]
            root = Path(tmp.name) / "workspace"
            root.mkdir()
            store = Store(Path(tmp.name) / "state")
            session = store.new("Create hello.txt then verify its content", root)
            provider = OpenAICompatible(base=f"http://127.0.0.1:{port}/v1",
                                        model="loopback-test",
                                        key=FAKE_KEY, allow_loopback_http=True)
            out = run(store.load(session["id"]), store, provider,
                      Gate(root, allow_write=True), max_steps=4)
            self.assertEqual(out["status"], "completed")
            self.assertTrue(out["completion"]["verified"])
            self.assertEqual((root / "hello.txt").read_text(encoding="utf-8"),
                             "Xueness loopback\n")
            # Every request carried the fake bearer; nothing else was contacted.
            self.assertTrue(seen_auth)
            self.assertTrue(all(a == "Bearer " + FAKE_KEY for a in seen_auth))
        finally:
            server.shutdown()
            server.server_close()
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
