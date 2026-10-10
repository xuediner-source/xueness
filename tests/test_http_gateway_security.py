"""Gateway Host, Origin, CSRF, body limits, and the JSON error envelope.

The live server is the stdlib loopback listener. Raw sockets cover cases urllib
rewrites for us (Host smuggling, chunked bodies, stalled reads). Windows and
macOS share this path; tests only flip ``sys.platform``.
"""
import contextlib
import io
import json
import socket
import tempfile
import threading
import time
import unittest
from email.message import Message
from http.client import parse_headers
from pathlib import Path
from unittest.mock import patch

from xueness import web
from xueness.http_contract import error_payload, normalize_error


def _headers(lines):
    blob = "".join(line + "\r\n" for line in lines).encode() + b"\r\n"
    return parse_headers(io.BytesIO(blob))


def _read_response(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(8192)
        if not chunk:
            break
        data += chunk
        if len(data) > 2_000_000:
            break
    if not data:
        return None, {}, b"", b""
    head, sep, rest = data.partition(b"\r\n\r\n")
    if not sep:
        return None, {}, b"", data
    lines = head.decode("iso-8859-1").split("\r\n")
    status = int(lines[0].split(" ", 2)[1])
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers.setdefault(name.lower(), []).append(value.strip())
    if status == 100 or "content-length" not in headers:
        return status, headers, b"", rest
    length = int(headers["content-length"][0])
    while len(rest) < length:
        chunk = sock.recv(length - len(rest))
        if not chunk:
            break
        rest += chunk
    return status, headers, rest[:length], rest[length:]


class EnvelopeTests(unittest.TestCase):
    def test_error_payload_uses_status_token_and_ignores_envelope_overrides(self):
        body = error_payload(413, "request body is too large", code="",
                             plugin="sessions", error="hidden")
        self.assertEqual(body["error"], "request body is too large")
        self.assertEqual(body["code"], "payload_too_large")
        self.assertEqual(body["status"], 413)
        self.assertEqual(body["plugin"], "sessions")

    def test_normalize_keeps_existing_machine_codes_and_extra_fields(self):
        body = normalize_error(502, {
            "error": "The model service rejected the request",
            "error_code": "provider_request_rejected",
            "trace_id": "abc",
            "upstream_status": 401,
        })
        self.assertEqual(body["error"], "The model service rejected the request")
        self.assertEqual(body["code"], "provider_request_rejected")
        self.assertEqual(body["error_code"], "provider_request_rejected")
        self.assertEqual(body["trace_id"], "abc")
        self.assertEqual(body["upstream_status"], 401)
        self.assertEqual(body["status"], 502)
        coded = normalize_error(400, {
            "error": "bad cursor",
            "errorCode": "xueness.error.invalid_argument",
            "plugin": "sessions",
        })
        self.assertEqual(coded["code"], "xueness.error.invalid_argument")
        self.assertEqual(coded["errorCode"], "xueness.error.invalid_argument")
        self.assertEqual(coded["plugin"], "sessions")

    def test_authority_rejects_smuggled_host_and_does_not_canonicalize(self):
        self.assertIsNone(web._parse_authority("127.0.0.1:0"))
        self.assertIsNone(web._parse_authority("127.0.0.1:00"))
        self.assertIsNone(web._parse_authority("127.0.0.1:bad"))
        self.assertIsNone(web._parse_authority("127.0.0.1:99999"))
        self.assertIsNone(web._parse_authority("127.0.0.1:8137?"))
        self.assertIsNone(web._parse_authority("127.0.0.1:8137#x"))
        self.assertIsNone(web._parse_authority("user:pw@127.0.0.1:8137"))
        self.assertIsNone(web._parse_authority("127.0.0.1:8137/"))
        self.assertEqual(web._parse_authority("[::1]:8137"), ("::1", 8137))
        self.assertEqual(web._parse_authority("localhost"), ("localhost", 80))
        host = "127.0.0.1:8137"
        self.assertFalse(web._host_ok(_headers([
            "Host: 127.0.0.1:8137",
            "Host: evil.example",
        ])))
        self.assertFalse(web._origin_ok(_headers([
            "Host: " + host,
            "Origin: http://127.0.0.1:0",
        ])))
        self.assertFalse(web._origin_ok(_headers([
            "Host: [::1]:8137",
            "Origin: http://[0:0:0:0:0:0:0:1]:8137",
        ])))
        self.assertTrue(web._origin_ok(_headers([
            "Host: 127.0.0.1:8137",
            "Origin: http://127.0.0.1:8137",
            "Referer: http://127.0.0.1:8137/index.html",
        ])))
        self.assertFalse(web._fetch_site_ok(_headers([
            "Sec-Fetch-Site: same-origin",
            "Sec-Fetch-Site: cross-site",
        ])))
        self.assertFalse(web._fetch_site_ok(_headers([
            "Sec-Fetch-Site: same-origin, cross-site",
        ])))
        self.assertTrue(web._fetch_site_ok(Message()))
        self.assertTrue(web._fetch_site_ok(_headers(["Sec-Fetch-Site: none"])))


class GatewaySecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        base = Path(cls.temp.name)
        project = base / "proj"
        project.mkdir()
        dist = project / "webapp" / "dist"
        dist.mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>Xueness</title>", encoding="utf-8")
        cls.ctx = web.build_context(base / "state", base / "runs", project,
                                    allow_real=False, csrf="gateway-csrf-token")
        cls.server = web.create_server(0, cls.ctx)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.temp.cleanup()

    def setUp(self):
        self._deadline = (
            web._HEADER_IDLE_SECONDS, web._HEADER_DEADLINE_SECONDS,
            web._BODY_IDLE_SECONDS, web._BODY_DEADLINE_SECONDS,
            web._RESPONSE_IDLE_SECONDS,
        )

    def tearDown(self):
        (web._HEADER_IDLE_SECONDS, web._HEADER_DEADLINE_SECONDS,
         web._BODY_IDLE_SECONDS, web._BODY_DEADLINE_SECONDS,
         web._RESPONSE_IDLE_SECONDS) = self._deadline
        self.ctx.pop("desktop_token", None)

    def _ids(self):
        folder = self.ctx["store"].directory
        return sorted(path.stem for path in folder.glob("[0-9a-f]" * 32 + ".json"))

    def _open(self, timeout=3):
        return socket.create_connection(("127.0.0.1", self.port), timeout=timeout)

    def _raw(self, payload, timeout=3):
        sock = self._open(timeout)
        try:
            sock.settimeout(timeout)
            sock.sendall(payload)
            return _read_response(sock)
        finally:
            sock.close()

    def _request_head(self, method, path, extra=(), body=None, csrf=True, host=None):
        if host is None:
            host = f"127.0.0.1:{self.port}"
        headers = [f"{method} {path} HTTP/1.1", "Host: " + host]
        if csrf:
            headers.append("X-CSRF-Token: gateway-csrf-token")
        if body is not None:
            headers.append("Content-Type: application/json")
            headers.append(f"Content-Length: {len(body)}")
        headers.extend(extra)
        raw = ("\r\n".join(headers) + "\r\n\r\n").encode()
        if body is not None:
            raw += body
        return raw

    def _json(self, status, body):
        self.assertIsNotNone(status)
        payload = json.loads(body.decode())
        self.assertEqual(payload["status"], status)
        return payload

    def _tighten(self):
        web._HEADER_IDLE_SECONDS = 0.4
        web._HEADER_DEADLINE_SECONDS = 0.35
        web._BODY_IDLE_SECONDS = 0.4
        web._BODY_DEADLINE_SECONDS = 0.35
        web._RESPONSE_IDLE_SECONDS = 2

    def test_write_methods_require_one_csrf_token(self):
        before = self._ids()
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            status, headers, body, _ = self._raw(self._request_head(
                method, "/api/sessions", body=b'{"task":"no csrf"}', csrf=False))
            payload = self._json(status, body)
            self.assertEqual(status, 403, payload)
            self.assertEqual(payload["error"], "csrf token required")
            self.assertEqual(payload["code"], "csrf_required")
            self.assertEqual(headers["content-type"][0], "application/json")
            self.assertIn("close", headers["connection"][0].lower())
            self.assertNotIn(b"<html", body.lower())
        duplicated = self._request_head(
            "POST", "/api/sessions",
            extra=["X-CSRF-Token: not-the-token"],
            body=b'{"task":"duplicate csrf"}',
        )
        status, _, body, _ = self._raw(duplicated)
        self.assertEqual(self._json(status, body)["code"], "csrf_required")
        self.assertEqual(self._ids(), before)

    def test_host_origin_and_fetch_site_cover_get_side_effects(self):
        created = self._raw(self._request_head(
            "POST", "/api/sessions", body=b'{"task":"view me"}'))
        session_id = json.loads(created[2].decode())["id"]
        target = f"/api/sessions/{session_id}"
        attacks = (
            {"extra": ["Sec-Fetch-Site: cross-site"]},
            {"extra": ["Sec-Fetch-Site: same-site"]},
            {"extra": ["Sec-Fetch-Site: same-origin", "Sec-Fetch-Site: cross-site"]},
            {"extra": ["Sec-Fetch-Site: same-origin, cross-site"]},
            {"host": "127.0.0.1:0"},
            {"host": "127.0.0.1:00"},
            {"host": "127.0.0.1:8137?"},
            {"host": "127.0.0.1:8137#frag"},
            {"host": f"user@127.0.0.1:{self.port}"},
            {"host": "evil.example"},
            {"host": f"127.0.0.1:{self.port}", "extra": ["Host: evil.example"]},
            {"extra": ["Origin: http://evil.example"]},
            {"extra": ["Origin: http://127.0.0.1:0"]},
            {"extra": [f"Origin: http://user@127.0.0.1:{self.port}"]},
            {"extra": [f"Origin: http://127.0.0.1:{self.port}", "Origin: http://evil.example"]},
        )
        with patch("xueness.web.session_management.mark_viewed") as viewed:
            for attack in attacks:
                lines = self._request_head("GET", target, csrf=False, **attack)
                status, _, body, _ = self._raw(lines)
                payload = self._json(status, body)
                self.assertEqual(status, 403, (attack, payload))
                self.assertEqual(payload["error"], "host not permitted")
                self.assertEqual(payload["code"], "host_not_permitted")
            viewed.assert_not_called()
            for extra in (["Sec-Fetch-Site: same-origin"], ["Sec-Fetch-Site: none"], []):
                status, _, body, _ = self._raw(self._request_head(
                    "GET", target, extra=extra, csrf=False))
                self.assertEqual(status, 200, (extra, body))
                viewed.assert_called()

    def test_head_and_unknown_methods_do_not_replay_get_or_echo_the_request(self):
        created = self._raw(self._request_head(
            "POST", "/api/sessions", body=b'{"task":"head me"}'))
        session_id = json.loads(created[2].decode())["id"]
        with patch("xueness.web.session_management.mark_viewed") as viewed:
            status, headers, body, _ = self._raw(self._request_head(
                "HEAD", f"/api/sessions/{session_id}", csrf=False))
            payload = self._json(status, body)
            self.assertEqual(status, 501, payload)
            self.assertEqual(payload["error"], "method not implemented")
            self.assertNotIn(b"HEAD", body)
            viewed.assert_not_called()
        status, _, body, _ = self._raw(
            f"FOO /api/sessions HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        payload = self._json(status, body)
        self.assertEqual(payload["code"], "not_implemented")
        self.assertNotIn(b"FOO", body)
        self.assertNotIn(b"<html", body.lower())
        secret = "secret-uri-token"
        status, _, body, _ = self._raw(
            f"GET /{secret}{'a' * 70000} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        self.assertEqual(status, 414)
        self.assertNotIn(secret.encode(), body)
        status, _, body, _ = self._raw(
            f"GET / HTTP/9.9\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        payload = self._json(status, body)
        self.assertEqual(payload["code"], "http_version_not_supported")
        self.assertNotIn(b"9.9", body)
        planted = "planted-header-secret"
        too_many = "".join(
            f"X-Planted-{index}: {planted}\r\n" for index in range(120))
        status, _, body, _ = self._raw(
            f"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n{too_many}\r\n".encode())
        payload = self._json(status, body)
        self.assertEqual(payload["code"], "request_header_fields_too_large")
        self.assertNotIn(planted.encode(), body)

    def test_framing_uses_413_411_and_400_without_applying_a_body(self):
        before = self._ids()
        cases = (
            ("POST", "/api/sessions", ["Content-Length: 1000001"], 413, "payload_too_large"),
            ("POST", "/api/composer/prepare/", ["Content-Length: 1000001"], 413, "payload_too_large"),
            ("POST", "/api/composer/prepare", ["Content-Length: 6000001"], 413, "payload_too_large"),
            ("POST", "/api/sessions", ["Transfer-Encoding: chunked"], 411, "length_required"),
            ("POST", "/api/sessions", ["Content-Length: 00"], 400, "invalid_content_length"),
            ("POST", "/api/sessions", ["Content-Length: 1,2"], 400, "invalid_content_length"),
            ("POST", "/api/sessions", ["Content-Length: 2", "Content-Length: 2"], 400, "invalid_content_length"),
            ("POST", "/api/sessions", ["Expect: goodbye", "Content-Length: 2"], 417, "expectation_failed"),
            ("POST", "/api/sessions", ["Expect: 100-continue", "Content-Length: 1000001"], 413, "payload_too_large"),
            ("GET", "/api/sessions", ["Transfer-Encoding: chunked"], 411, "length_required"),
        )
        for method, path, extra, expect, code in cases:
            started = time.monotonic()
            status, headers, body, _ = self._raw(self._request_head(method, path, extra=extra))
            self.assertLess(time.monotonic() - started, 2.0, (path, extra))
            payload = self._json(status, body)
            self.assertEqual(status, expect, (path, extra, payload))
            self.assertEqual(payload["code"], code, payload)
            self.assertIn("close", headers["connection"][0].lower())
            self.assertNotIn(b"100 Continue", body)
        status, _, body, _ = self._raw(self._request_head(
            "POST", "/api/sessions", body=b"{not json"))
        payload = self._json(status, body)
        self.assertEqual(payload["error"], "invalid json body")
        self.assertEqual(payload["code"], "invalid_json")
        self.assertEqual(self._ids(), before)

    def test_forbidden_caller_is_refused_before_the_body_limit(self):
        before = self._ids()
        raw = self._request_head(
            "POST", "/api/sessions",
            extra=["Content-Length: 1000001"],
            csrf=False,
        )
        status, _, body, _ = self._raw(raw)
        payload = self._json(status, body)
        self.assertEqual(payload["code"], "csrf_required")
        self.assertEqual(self._ids(), before)

    def test_slow_header_and_body_return_408_and_a_silent_idle_accept_does_not(self):
        self._tighten()
        before = self._ids()
        started = time.monotonic()
        sock = self._open()
        try:
            sock.settimeout(2)
            status, _, body, _ = _read_response(sock)
        finally:
            sock.close()
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertIsNone(status)
        self.assertEqual(body, b"")

        started = time.monotonic()
        partial = (
            f"POST /api/sessions HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{self.port}\r\n"
            f"X-CSRF-Token: gateway-csrf-token\r\n"
        ).encode()
        status, _, body, _ = self._raw(partial, timeout=2)
        payload = self._json(status, body)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(payload["code"], "request_timeout")

        started = time.monotonic()
        head = self._request_head(
            "POST", "/api/sessions",
            extra=["Content-Length: 32"],
        )
        # Declared length is inside the cap, but the bytes never arrive.
        sock = self._open()
        try:
            sock.settimeout(2)
            sock.sendall(head)
            status, _, body, _ = _read_response(sock)
        finally:
            sock.close()
        payload = self._json(status, body)
        self.assertLess(time.monotonic() - started, 2.0, payload)
        self.assertEqual(payload["code"], "request_timeout")
        self.assertEqual(self._ids(), before)

        self._tighten()
        started = time.monotonic()
        status, _, body, _ = self._raw(self._request_head(
            "POST", "/api/composer/prepare",
            extra=["Content-Length: 1000001"],
        ), timeout=2)
        payload = self._json(status, body)
        self.assertLess(time.monotonic() - started, 2.0, payload)
        self.assertEqual(payload["code"], "request_timeout")

    def test_continue_is_sent_only_for_an_accepted_body(self):
        payload = b'{"task":"hello gateway"}'
        head = self._request_head(
            "POST", "/api/sessions",
            extra=["Expect: 100-continue", f"Content-Length: {len(payload)}"],
        )
        sock = self._open()
        try:
            sock.settimeout(3)
            sock.sendall(head)
            status, _, body, rest = _read_response(sock)
            self.assertEqual(status, 100, body)
            self.assertEqual(body, b"")
            sock.sendall(payload)
            if rest:
                # The final response cannot arrive before the body.
                self.fail(rest)
            status, headers, body, _ = _read_response(sock)
        finally:
            sock.close()
        self.assertEqual(status, 200, body)
        self.assertNotIn("code", json.loads(body.decode()))
        self.assertNotIn("close", headers.get("connection", [""])[0].lower())
        session_id = json.loads(body.decode())["id"]
        self.assertIn(session_id, self._ids())

    def test_successful_requests_stay_keep_alive_and_failures_stay_json(self):
        raw = (
            f"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n"
            f"GET /api/csrf HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()
        sock = self._open()
        try:
            sock.settimeout(3)
            sock.sendall(raw)
            first, _, body, rest = _read_response(sock)
            self.assertEqual(json.loads(body.decode())["ok"], True)
            if not rest:
                rest = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    rest += chunk
                    if b"\r\n\r\n" in rest:
                        break
            head, sep, leftover = rest.partition(b"\r\n\r\n")
            self.assertTrue(sep)
            self.assertIn(b"200", head.split(b"\r\n", 1)[0])
            length = int(head.lower().split(b"content-length:", 1)[1].split(b"\r\n", 1)[0].strip())
            while len(leftover) < length:
                leftover += sock.recv(length - len(leftover))
            token = json.loads(leftover[:length].decode())["csrfToken"]
        finally:
            sock.close()
        self.assertEqual(first, 200)
        self.assertEqual(token, "gateway-csrf-token")

        logged = io.StringIO()
        with patch.object(Path, "read_bytes", side_effect=RuntimeError("secret-token-value")), \
                contextlib.redirect_stderr(logged):
            status, headers, body, _ = self._raw(self._request_head("GET", "/", csrf=False))
        payload = self._json(status, body)
        self.assertEqual(payload["code"], "internal_error")
        self.assertNotIn(b"secret-token-value", body)
        self.assertIn("secret-token-value", logged.getvalue())
        self.assertNotIn(b"<html", body.lower())
        self.assertEqual(headers["content-type"][0], "application/json")

    def test_limits_and_csrf_match_on_windows_and_macos(self):
        for platform_name in ("win32", "darwin"):
            with patch("sys.platform", platform_name):
                denied, _, body, _ = self._raw(self._request_head(
                    "DELETE", "/api/sessions/" + ("ab" * 16), csrf=False))
                self.assertEqual(self._json(denied, body)["code"], "csrf_required", platform_name)
                limited, _, body, _ = self._raw(self._request_head(
                    "PUT", "/api/sessions", extra=["Content-Length: 1000001"]))
                self.assertEqual(self._json(limited, body)["code"], "payload_too_large", platform_name)


if __name__ == "__main__":
    unittest.main()
