"""End-to-end lightweight profile coverage through real local HTTP and CLI paths.

Every provider request is served by a disposable 127.0.0.1 SSE fixture. These
tests never call Ollama or a remote/paid model endpoint. Provider connection
tests intentionally remain a small reachability probe and do not establish
that a model can make useful tool calls.

Stop-boundary and repeated-tool non-replay behavior remain covered by
``tests.test_plugin_runtime_core`` and ``tests.test_stall_guard``.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness import web
from xueness.cli import main as cli_main


FAKE_KEY = "test-local-fixture-key"
CSRF = "runtime-http-test-csrf"


def _sse(reply):
    choices = []
    calls = reply.get("tool_calls") or []
    content = reply.get("content") or ""
    if calls:
        deltas = []
        for index, call in enumerate(calls):
            function = call.get("function") or {}
            deltas.append({
                "index": index,
                "id": call.get("id", ""),
                "type": "function",
                "function": {
                    "name": function.get("name", ""),
                    "arguments": function.get("arguments", "{}"),
                },
            })
        choices.append({"choices": [{"delta": {"tool_calls": deltas}, "finish_reason": None}]})
        choices.append({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    else:
        choices.append({"choices": [{"delta": {"content": content}, "finish_reason": None}]})
        choices.append({"choices": [{"delta": {}, "finish_reason": "stop"}]})
    return b"".join(
        ("data: " + json.dumps(item, ensure_ascii=False) + "\n\n").encode("utf-8")
        for item in choices
    ) + b"data: [DONE]\n\n"


class ChatFixture:
    """Local OpenAI-compatible SSE endpoint with an inspectable request log."""

    def __init__(self, responder):
        self.requests = []
        self.lock = threading.Lock()
        self.responder = responder

        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                with fixture.lock:
                    index = len(fixture.requests)
                    fixture.requests.append({
                        "path": self.path,
                        "headers": dict(self.headers.items()),
                        "body": body,
                    })
                reply = fixture.responder(body, index)
                raw = _sse(reply)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except OSError:
                    pass

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class LocalRuntimeHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / "project"
        self.project.mkdir()
        dist = self.project / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>fixture</title>", encoding="utf-8")
        (dist / "assets" / "app.js").write_text("", encoding="utf-8")
        self.workspace = self.project / "workspace"
        self.workspace.mkdir()
        self.state = base / "state"
        self.ctx = web.build_context(self.state, base / "web-runs", self.project,
                                     allow_real=True, csrf=CSRF)
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.csrf = self._request("GET", "/api/csrf", csrf=False)[1]["csrfToken"]
        self.addCleanup(self._close_web)

    def _close_web(self):
        self.server.shutdown()
        self.server.server_close()

    def _request(self, method, path, data=None, *, csrf=True):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = urllib.request.Request(self.base_url + path, data=body,
                                         headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            try:
                raw = error.read()
                return error.code, json.loads(raw) if raw else {}
            finally:
                error.close()

    def _save_profile(self, provider_id, base_url, **fields):
        data = {
            "id": provider_id,
            "name": "Local fixture",
            "baseUrl": base_url,
            "model": "fixture-model",
        }
        data.update(fields)
        return self._request("POST", "/api/providers", data)

    def _new_session(self, provider_id, model="fixture-model", *, task="Read the fixture file"):
        status, payload = self._request("POST", "/api/sessions", {
            "task": task,
            "root": str(self.workspace),
            "provider_id": provider_id,
            "model": model,
        })
        self.assertEqual(200, status, payload)
        saved = self.ctx['store'].load(payload['id'])
        self.assertEqual(saved['model_selection']['provider_id'], provider_id)
        self.assertEqual(saved['model_selection']['model'], model)
        return payload["id"]

    def _run(self, session_id, **fields):
        data = {"provider": "real", "steps": 4, "max_wall_seconds": 20}
        data.update(fields)
        return self._request("POST", f"/api/sessions/{session_id}/run", data)

    def test_http_keyless_lightweight_profile_runs_and_persists_budget(self):
        (self.workspace / "notes.txt").write_text("loopback proof\n", encoding="utf-8")
        fixture = ChatFixture(lambda _body, index: (
            {"content": "", "tool_calls": [{
                "id": "fixture-read", "type": "function",
                "function": {"name": "read", "arguments": '{"path":"notes.txt"}'},
            }]} if index == 0 else {
                "content": json.dumps({"summary": "Read the local file", "evidence": [{
                    "tool_call_id": "fixture-read", "observation": "The read tool succeeded.",
                }]}, ensure_ascii=False),
            }
        ))
        self.addCleanup(fixture.close)

        status, profile = self._save_profile(
            "local", fixture.base_url, runtimeProfile="lightweight")
        self.assertEqual(200, status, profile)
        self.assertFalse(profile["provider"]["hasKey"])
        self.assertEqual("lightweight", profile["provider"]["runtimeProfile"])

        # CSRF is required for every state-changing endpoint.
        status, rejected = self._request(
            "POST", "/api/providers", {
                "id": "csrf-missing", "name": "bad", "baseUrl": fixture.base_url,
                "model": "fixture-model",
            }, csrf=False)
        self.assertEqual(403, status, rejected)

        sid = self._new_session("local")
        status, result = self._run(sid)
        self.assertEqual(200, status, result)
        self.assertTrue(result["completion"]["verified"], result)
        self.assertEqual(2, len(fixture.requests))
        for request in fixture.requests:
            self.assertEqual("/v1/chat/completions", request["path"])
            self.assertEqual(1024, request["body"]["max_tokens"])
            self.assertNotIn("parallel_tool_calls", request["body"])
            self.assertNotIn("stream_options", request["body"])
            self.assertNotIn("Authorization", request["headers"])
        self.assertTrue(all(request["body"]["stream"] is True for request in fixture.requests))

        status, detail = self._request("GET", f"/api/sessions/{sid}", csrf=False)
        self.assertEqual(200, status, detail)
        self.assertEqual("lightweight", detail["runtime_profile"])
        budget = detail["runtime_budget"]
        self.assertEqual(8192, budget["contextWindow"])
        self.assertEqual(1024, budget["reservedOutputTokens"])
        self.assertLessEqual(budget["estimatedInputTokens"], budget["inputBudgetTokens"])
        restored = self.ctx["store"].load(sid)
        self.assertEqual("lightweight", restored["runtime_profile"])
        self.assertEqual(budget["inputBudgetTokens"], restored["runtime_budget"]["inputBudgetTokens"])

    def test_profile_validation_and_standard_switch_preserve_secret_key(self):
        fixture = ChatFixture(lambda _body, _index: {"content": "unused"})
        self.addCleanup(fixture.close)
        status, invalid = self._save_profile("invalid", fixture.base_url,
                                             runtimeProfile="micro")
        self.assertEqual(400, status, invalid)
        self.assertIn("runtimeProfile", invalid["error"])

        status, created = self._save_profile(
            "keyed", fixture.base_url, apiKey=FAKE_KEY,
            runtimeProfile="lightweight")
        self.assertEqual(200, status, created)
        self.assertTrue(created["provider"]["hasKey"])
        self.assertNotIn(FAKE_KEY, json.dumps(created))
        status, updated = self._save_profile("keyed", fixture.base_url,
                                             runtimeProfile="standard")
        self.assertEqual(200, status, updated)
        self.assertEqual("standard", updated["provider"]["runtimeProfile"])
        self.assertTrue(updated["provider"]["hasKey"])
        self.assertNotIn(FAKE_KEY, json.dumps(updated))

    def test_json_adapter_uses_same_gate_for_read_and_denies_write(self):
        (self.workspace / "input.txt").write_text("safe read\n", encoding="utf-8")

        def reply(body, index):
            if index == 0:
                return {"content": json.dumps({
                    "tool": "read", "arguments": {"path": "input.txt"},
                })}
            if index == 1:
                return {"content": json.dumps({
                    "tool": "write",
                    "arguments": {"path": "denied.txt", "content": "must stay absent"},
                })}
            return {"content": "unexpected extra request"}

        fixture = ChatFixture(reply)
        self.addCleanup(fixture.close)
        status, profile = self._save_profile(
            "json-local", fixture.base_url, runtimeProfile="lightweight",
            toolCalling="json")
        self.assertEqual(200, status, profile)
        sid = self._new_session("json-local", task="Read input.txt and do not write files")
        status, result = self._run(sid, provider_id="json-local", model="fixture-model")
        self.assertEqual(200, status, result)
        self.assertEqual("paused", result["status"], result)
        self.assertIsNone(result["completion"], result)
        self.assertTrue(any(item.get("tool_call_id") for item in result.get("pending", [])), result)
        self.assertFalse((self.workspace / "denied.txt").exists())
        self.assertEqual(2, len(fixture.requests))
        for request in fixture.requests:
            self.assertNotIn("tools", request["body"])
            self.assertNotIn("parallel_tool_calls", request["body"])
            self.assertNotIn("Authorization", request["headers"])
        journal_status, journal = self._request(
            "GET", f"/api/sessions/{sid}/journal", csrf=False)
        self.assertEqual(200, journal_status)
        self.assertTrue(any(value.get("error") == "denied"
                            and value.get("awaiting_approval") is True
                            for value in journal["results"].values()))
        self.assertTrue(any(value.get("ok") is True and value.get("path") == "input.txt"
                            for value in journal["results"].values()))

    def test_cli_environment_lightweight_without_api_key_and_profile_save_defaults(self):
        fixture = ChatFixture(lambda _body, _index: {"content": "local fixture reply"})
        self.addCleanup(fixture.close)
        cli_state = Path(self.temp.name) / "cli-state"
        cli_workspace = Path(self.temp.name) / "cli-workspace"
        cli_workspace.mkdir()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {
            "XUENESS_API_BASE": fixture.base_url,
            "XUENESS_MODEL": "env-local-small",
            "XUENESS_API_KEY": "",
            "XUENESS_PROVIDER": "openai",
            "XUENESS_ALLOW_LOOPBACK_HTTP": "0",
        }), redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main([
                "--state", str(cli_state), "run", "--prompt", "Say hello",
                "--root", str(cli_workspace), "--lightweight", "--steps", "1",
                "--output-format", "json",
            ])
        self.assertEqual(2, code, stderr.getvalue())
        result = json.loads(stdout.getvalue())
        self.assertEqual("needs_review", result["status"])
        self.assertEqual(1, len(fixture.requests))
        body = fixture.requests[0]["body"]
        self.assertEqual(1024, body["max_tokens"])
        self.assertNotIn("parallel_tool_calls", body)
        self.assertNotIn("stream_options", body)
        self.assertNotIn("Authorization", fixture.requests[0]["headers"])

        # CLI profile save can select lightweight without requiring an API key;
        # unset context/output fields retain the profile defaults on read.
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli_main([
                "--state", str(cli_state), "providers", "save", "saved-local",
                "--base-url", fixture.base_url, "--model", "local-small",
                "--runtime-profile", "lightweight",
            ])
        self.assertEqual(0, code, stderr.getvalue())
        saved = json.loads(stdout.getvalue())["provider"]
        self.assertFalse(saved["hasKey"])
        self.assertEqual("lightweight", saved["runtimeProfile"])
        self.assertEqual(8192, saved["contextWindow"])
        self.assertEqual(1024, saved["maxOutputTokens"])
        raw = json.loads((cli_state / "providers" / "saved-local.json").read_text())
        self.assertNotIn("apiKey", raw)
        self.assertNotIn("contextWindow", raw)
        self.assertNotIn("maxOutputTokens", raw)


if __name__ == "__main__":
    unittest.main()
