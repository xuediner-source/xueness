"""Provider compatibility diagnostics use only deterministic loopback wire fixtures."""
from __future__ import annotations

import json
import threading
import tempfile
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.providers import providers_api
from xueness.bundled_plugins.providers.provider import OpenAICompatible
from xueness.plugin_runtime import set_enabled
from xueness import web


SECRET = "compatibility-fixture-secret"
TOOL = "xueness_fixture_add"
RECEIPT = "xueness-local-fixture:3+4=7"


def _wire_server(state, *, statuses=None, invalid_tool=False, wrong_tool_name=False,
                 extra_tool_args=False, omit_done=False, spoof_attempts=False,
                 sse=False):
    statuses = list(statuses or [])

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            state.setdefault("requests", []).append({"path": self.path, "body": body})
            request_index = len(state["requests"]) - 1
            status = statuses[request_index] if request_index < len(statuses) else 200
            self.send_response(status)
            if status != 200:
                raw = json.dumps({"error": f"rejected {SECRET}"}).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(raw)
                return

            if body.get("stream") and sse:
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                for item in (
                    {"choices": [{"delta": {"content": "RETRIED_STREAM"}, "finish_reason": None}]},
                    {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                ):
                    self.wfile.write(b"data: " + json.dumps(item).encode() + b"\n\n")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            if body.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                messages = body.get("messages", [])
                if any(message.get("role") == "tool" for message in messages):
                    events = [
                        {"choices": [{"delta": {"content": RECEIPT}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                    ]
                elif body.get("tools"):
                    events = [
                        {"choices": [{"delta": {"tool_calls": [{
                            "index": 0, "id": "fixture-call-1", "type": "function",
                            "function": {"name": TOOL, "arguments": "{\"a\":"},
                        }]}, "finish_reason": None}]},
                        {"choices": [{"delta": {"tool_calls": [{
                            "index": 0, "function": {"arguments": "3,\"b\":4}"},
                        }]}, "finish_reason": "tool_calls"}]},
                    ]
                else:
                    events = [
                        {"choices": [{"delta": {"content": "STREAM_OK"}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                    ]
                for item in events:
                    self.wfile.write(b"data: " + json.dumps(item).encode() + b"\n\n")
                if not omit_done:
                    self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            messages = body.get("messages", [])
            if any(message.get("role") == "tool" for message in messages):
                content = RECEIPT
                message = {"role": "assistant", "content": content}
            elif body.get("tools"):
                args = {"a": 3, "b": 4}
                if invalid_tool or extra_tool_args:
                    args = {"a": 3, "b": 4, "path": "must-not-be-accepted"}
                message = {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "fixture-call-1", "type": "function",
                    "function": {"name": "wrong_tool" if invalid_tool or wrong_tool_name else TOOL,
                                 "arguments": json.dumps(args)},
                }]}
            elif any("tool_call" in str(message.get("content", "")) for message in messages):
                message = {"role": "assistant", "content": json.dumps({
                    "tool_call": {"name": TOOL, "arguments": {"a": 3, "b": 4}},
                }, separators=(",", ":"))}
            else:
                message = {"role": "assistant", "content": "COMPAT_OK"}
            if spoof_attempts:
                message["_request_attempts"] = 900
            raw = json.dumps({"choices": [{"message": message}]}).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class ProviderCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.state_dir = root / "state"
        self.state_dir.mkdir()
        (self.state_dir / "providers").mkdir()
        self.ctx = {"state_dir": self.state_dir, "allow_real": True}
        self.loopback = patch.dict("os.environ", {"XUENESS_ALLOW_LOOPBACK_HTTP": "1"})
        self.loopback.start()
        self.addCleanup(self.loopback.stop)
        self.addCleanup(self.temp.cleanup)

    def save_profile(self, base_url, **overrides):
        payload = {
            "id": "local-fixture", "name": "Local fixture", "baseUrl": base_url,
            "model": "user-selected-local-model", "protocol": "openai", "apiKey": SECRET,
            "runtimeProfile": "lightweight", "contextWindow": 8192,
            "maxOutputTokens": 1024, "toolCalling": "native", "compatibility": {},
        }
        payload.update(overrides)
        status, body = providers_api.dispatch("POST", ["api", "providers"], {}, payload, self.ctx)
        self.assertEqual(status, 200, body)
        return body["provider"]

    def run_check(self, mode, compatibility=None):
        body = {"id": "local-fixture", "mode": mode}
        if compatibility is not None:
            body["compatibility"] = compatibility
        return providers_api.dispatch(
            "POST", ["api", "providers", "compatibility-test"], {}, body, self.ctx)

    def adopt(self, options_hash):
        return providers_api.dispatch(
            "POST", ["api", "providers", "compatibility-adopt"], {},
            {"id": "local-fixture", "optionsHash": options_hash}, self.ctx)

    def with_server(self, state, **options):
        server = _wire_server(state, **options)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/v1"

    def test_conversation_is_plain_and_optional_compatibility_fields_are_explicit(self):
        state = {}
        self.save_profile(self.with_server(state))
        status, result = self.run_check("conversation", {
            "parallelToolCalls": False, "toolChoice": "required", "think": False,
        })
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"], result)
        body = state["requests"][0]["body"]
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertNotIn("parallel_tool_calls", body)
        self.assertIs(body["think"], False)
        self.assertEqual("user-selected-local-model", body["model"])
        self.assertEqual(128, body["max_tokens"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_native_tool_call_requires_exact_name_and_argument_schema(self):
        state = {}
        self.save_profile(self.with_server(state))
        status, result = self.run_check("native_tool_call", {
            "toolChoice": "required", "parallelToolCalls": False,
        })
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"], result)
        body = state["requests"][0]["body"]
        self.assertEqual(1, result["details"]["requestCount"])
        self.assertEqual(TOOL, body["tools"][0]["function"]["name"])
        self.assertEqual("required", body["tool_choice"])
        self.assertIs(body["parallel_tool_calls"], False)
        self.assertTrue(result["details"]["toolCallValidated"])
        self.assertFalse(result["details"]["fixtureExecuted"])

    def test_native_call_rejects_wrong_name_and_extra_arguments(self):
        state = {}
        self.save_profile(self.with_server(state, invalid_tool=True))
        status, result = self.run_check("native_tool_call")
        self.assertEqual(200, status)
        self.assertFalse(result["ok"])
        self.assertEqual(1, result["details"]["requestCount"])
        self.assertIn("unexpected function name", result["error"])

    def test_native_call_rejects_wrong_name_even_when_arguments_match(self):
        state = {}
        self.save_profile(self.with_server(state, wrong_tool_name=True))
        status, result = self.run_check("native_tool_call")
        self.assertEqual(200, status)
        self.assertFalse(result["ok"])
        self.assertIn("unexpected function name", result["error"])

    def test_native_call_rejects_extra_arguments_with_the_expected_function_name(self):
        state = {}
        self.save_profile(self.with_server(state, extra_tool_args=True))
        status, result = self.run_check("native_tool_call")
        self.assertEqual(200, status)
        self.assertFalse(result["ok"])
        self.assertIn("outside the required", result["error"])

    def test_json_tool_call_is_plain_json_without_native_tool_fields(self):
        state = {}
        self.save_profile(self.with_server(state))
        status, result = self.run_check("json_tool_call", {
            "toolChoice": "required", "parallelToolCalls": True,
        })
        self.assertEqual(200, status, result)
        self.assertTrue(result["ok"], result)
        body = state["requests"][0]["body"]
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertNotIn("parallel_tool_calls", body)
        self.assertTrue(result["details"]["jsonToolCallValidated"])

    def test_json_tool_call_requires_lightweight_profile_before_network(self):
        state = {}
        self.save_profile(self.with_server(state), runtimeProfile="standard")
        status, result = self.run_check("json_tool_call")
        self.assertEqual(400, status)
        self.assertIn("lightweight", result["error"])
        self.assertEqual([], state.get("requests", []))

    def test_stream_check_requires_actual_sse_delta_and_done_marker(self):
        state = {}
        self.save_profile(self.with_server(state))
        status, result = self.run_check("stream", {"streamUsage": False})
        self.assertEqual(200, status, result)
        self.assertTrue(result["ok"], result)
        body = state["requests"][0]["body"]
        self.assertTrue(body["stream"])
        self.assertNotIn("stream_options", body)
        self.assertEqual(1, result["details"]["deltaCount"])
        self.assertTrue(result["details"]["doneReceived"])


    def test_stream_check_rejects_finish_without_done_marker(self):
        state = {}
        self.save_profile(self.with_server(state, omit_done=True))
        status, result = self.run_check("stream", {"streamUsage": False})
        self.assertEqual(200, status)
        self.assertFalse(result["ok"])
        self.assertEqual(1, result["details"]["requestCount"])
        self.assertEqual("stream", result["details"]["failedStep"])

    def test_tool_result_roundtrip_is_two_requests_and_uses_only_fixed_arithmetic_receipt(self):
        state = {}
        self.save_profile(self.with_server(state))
        status, result = self.run_check("tool_roundtrip", {"think": True})
        self.assertEqual(200, status, result)
        self.assertTrue(result["ok"], result)
        self.assertEqual(2, result["details"]["requestCount"])
        self.assertEqual(2, len(state["requests"]))
        first, second = (item["body"] for item in state["requests"])
        self.assertEqual(TOOL, first["tools"][0]["function"]["name"])
        self.assertTrue(first["stream"])
        self.assertTrue(second["stream"])
        messages = second["messages"]
        tool_result = next(message for message in messages if message.get("role") == "tool")
        self.assertEqual("fixture-call-1", tool_result["tool_call_id"])
        self.assertEqual({"sum": 7, "receipt": RECEIPT}, json.loads(tool_result["content"]))
        self.assertTrue(result["details"]["toolCallValidated"])
        self.assertTrue(result["details"]["toolResultFollowupValidated"])
        self.assertTrue(result["details"]["fixtureExecuted"])
        self.assertTrue(result["details"]["doneReceived"])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_400_is_reported_without_response_body_and_never_auto_retries(self):
        state = {}
        self.save_profile(self.with_server(state, statuses=[400, 200]))
        status, rejected = self.run_check("native_tool_call", {
            "toolChoice": "required", "parallelToolCalls": False, "think": False,
        })
        self.assertEqual(200, status)
        self.assertFalse(rejected["ok"])
        self.assertEqual(1, rejected["details"]["requestCount"])
        self.assertEqual(400, rejected["details"]["httpStatus"])
        self.assertEqual(1, len(state["requests"]))
        self.assertNotIn(SECRET, json.dumps(rejected))
        self.assertIn("tool_choice", rejected["details"]["requests"][0]["fields"])
        # A second request happens only after an explicit caller action with a new candidate.
        status, accepted = self.run_check("native_tool_call", {})
        self.assertEqual(200, status)
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(2, len(state["requests"]))
        self.assertNotIn("tool_choice", state["requests"][1]["body"])

    def test_diagnostic_persists_safe_history_without_changing_active_options(self):
        state = {}
        saved = self.save_profile(self.with_server(state), compatibility={})
        profile_path = self.state_dir / "providers" / "local-fixture.json"
        before = json.loads(profile_path.read_text(encoding="utf-8"))
        status, result = self.run_check("native_tool_call", {"think": False})
        self.assertEqual(200, status)
        self.assertTrue(result["ok"])
        after = json.loads(profile_path.read_text(encoding="utf-8"))
        self.assertEqual(before["compatibility"], after["compatibility"])
        self.assertEqual(before["_profileRevision"], after["_profileRevision"])
        self.assertEqual(result["optionsHash"], providers_api._compatibility_hash({"think": False}))
        self.assertEqual({"think": False}, next(iter(after["_compatibilityDiagnostics"].values()))["compatibility"])
        stored_check = next(iter(after["_compatibilityDiagnostics"].values()))["checks"]["native_tool_call"]
        self.assertTrue(stored_check["ok"])
        self.assertTrue(stored_check["testedAt"])
        self.assertNotIn("messages", stored_check)
        self.assertNotIn("content", stored_check)
        self.assertNotIn(SECRET, json.dumps(after["_compatibilityDiagnostics"]))
        self.assertNotIn(SECRET, json.dumps(result))
        providers = providers_api.dispatch("GET", ["api", "providers"], {}, {}, self.ctx)[1]["providers"]
        current = next(item for item in providers if item["id"] == "local-fixture")
        self.assertEqual({}, current.get("compatibility", {}))
        self.assertEqual(result["optionsHash"], current["compatibilityDiagnostics"][0]["optionsHash"])
        self.assertEqual(["native_tool_call"], [item["mode"] for item in current["compatibilityDiagnostics"][0]["checks"]])
        self.assertEqual(saved["model"], current["model"])
        self.assertNotIn("compatibilityVerification", current)

    def test_adopt_requires_all_required_passing_modes_and_does_not_select_profile(self):
        state = {}
        saved = self.save_profile(self.with_server(state))
        profile_path = self.state_dir / "providers" / "local-fixture.json"
        before = json.loads(profile_path.read_text(encoding="utf-8"))
        candidate = {"think": False, "parallelToolCalls": False}
        first_status, first = self.run_check("conversation", candidate)
        self.assertEqual(200, first_status, first)
        self.assertTrue(first["ok"], first)
        incomplete_status, incomplete = self.adopt(first["optionsHash"])
        self.assertEqual(409, incomplete_status, incomplete)
        self.assertIn("all required", incomplete["error"])
        self.assertEqual(before["compatibility"], json.loads(profile_path.read_text(encoding="utf-8"))["compatibility"])

        for mode in ("stream", "tool_roundtrip"):
            status, result = self.run_check(mode, candidate)
            self.assertEqual(200, status, result)
            self.assertTrue(result["ok"], result)
            self.assertEqual(first["optionsHash"], result["optionsHash"])
        status, adopted = self.adopt(first["optionsHash"])
        self.assertEqual(200, status, adopted)
        self.assertEqual(candidate, adopted["provider"]["compatibility"])
        self.assertEqual({"conversation", "stream", "tool_roundtrip"},
                         {item["mode"] for item in adopted["provider"]["compatibilityVerification"]["checks"]})
        self.assertEqual(first["optionsHash"], adopted["provider"]["compatibilityVerification"]["optionsHash"])
        self.assertTrue(adopted["provider"]["compatibilityVerification"]["verifiedAt"])
        self.assertNotIn(SECRET, json.dumps(adopted))
        stored = json.loads(profile_path.read_text(encoding="utf-8"))
        self.assertEqual(candidate, stored["compatibility"])
        self.assertEqual(saved["id"], adopted["provider"]["id"])

    def test_json_profile_requires_json_tool_check_and_profile_save_invalidates_history(self):
        state = {}
        self.save_profile(self.with_server(state), toolCalling="json")
        candidate = {"think": False}
        first_status, first = self.run_check("conversation", candidate)
        self.assertEqual(200, first_status, first)
        for mode in ("stream", "json_tool_call"):
            status, result = self.run_check(mode, candidate)
            self.assertEqual(200, status, result)
            self.assertTrue(result["ok"], result)
        status, adopted = self.adopt(first["optionsHash"])
        self.assertEqual(200, status, adopted)
        check_modes = {item["mode"] for item in adopted["provider"]["compatibilityVerification"]["checks"]}
        self.assertEqual({"conversation", "stream", "json_tool_call"}, check_modes)

        # Saving any connection/runtime field rotates the revision and removes
        # the old verified provenance, even when the old options hash is known.
        self.save_profile(self.with_server(state), model="different-local-model", toolCalling="json")
        stale_status, stale = self.adopt(first["optionsHash"])
        self.assertEqual(409, stale_status, stale)
        listing = providers_api.dispatch("GET", ["api", "providers"], {}, {}, self.ctx)[1]["providers"]
        current = next(item for item in listing if item["id"] == "local-fixture")
        self.assertNotIn("compatibilityVerification", current)

    def test_profile_revision_change_during_a_check_prevents_stale_result_persistence(self):
        self.save_profile("http://127.0.0.1:9191/v1")

        class ConcurrentEdit:
            runtime_profile = "lightweight"

            def compatibility_test(inner_self, mode, compatibility=None, timeout=8):
                self.save_profile("http://127.0.0.1:9191/v1", model="changed-during-test")
                return {"ok": True, "details": {
                    "mode": mode, "requestCount": 1,
                    "assistantTextReceived": True,
                    "requests": [{"step": "conversation", "fields": ["model", "messages"]}],
                }}

        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=ConcurrentEdit()):
            status, result = self.run_check("conversation", {"think": False})
        self.assertEqual(409, status, result)
        stored = json.loads((self.state_dir / "providers" / "local-fixture.json").read_text(encoding="utf-8"))
        self.assertEqual("changed-during-test", stored["model"])
        self.assertNotIn("_compatibilityDiagnostics", stored)

    def test_compatibility_route_requires_proof_and_redacts_untrusted_error_history(self):
        self.save_profile("http://127.0.0.1:9191/v1")

        class FakeResult:
            runtime_profile = "lightweight"

            def __init__(inner_self, result):
                inner_self.result = result

            def compatibility_test(inner_self, mode, compatibility=None, timeout=8):
                return inner_self.result

        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=FakeResult({"ok": True, "details": {
                       "mode": "conversation", "requestCount": 1,
                   }})):
            status, result = self.run_check("conversation")
        self.assertEqual(502, status)
        self.assertNotIn("compatibilityDiagnostics", providers_api.dispatch(
            "GET", ["api", "providers"], {}, {}, self.ctx)[1]["providers"][0])

        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=FakeResult({"ok": False, "error": "remote body " + SECRET,
                       "details": {"mode": "conversation", "requestCount": 1,
                                   "failedStep": "remote body " + SECRET}})):
            status, result = self.run_check("conversation")
        self.assertEqual(200, status, result)
        self.assertNotIn(SECRET, json.dumps(result))
        history = json.loads((self.state_dir / "providers" / "local-fixture.json").read_text(encoding="utf-8"))
        self.assertNotIn(SECRET, json.dumps(history["_compatibilityDiagnostics"]))

    def test_real_model_gate_and_invalid_requests_stop_before_network(self):
        state = {}
        self.save_profile(self.with_server(state))
        self.ctx["allow_real"] = False
        self.assertEqual(403, self.run_check("conversation")[0])
        self.ctx["allow_real"] = True
        self.assertEqual(400, self.run_check("conversation", {"unlisted": True})[0])
        self.assertEqual(400, self.run_check("conversation", {"apiKey": SECRET})[0])
        self.assertEqual(400, self.run_check("conversation", {"baseUrl": "http://127.0.0.1"})[0])
        self.assertEqual(400, self.run_check("unknown")[0])
        self.assertEqual([], state.get("requests", []))

    def test_http_route_obeys_provider_plugin_gate_before_model_request_gate(self):
        root = Path(self.temp.name)
        project = root / "project"
        project.mkdir()
        ctx = web.build_context(
            self.state_dir, root / "web-runs", project,
            csrf="compatibility-http-csrf", allow_real=False,
        )
        server = web.create_server(0, ctx)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        endpoint = f"http://127.0.0.1:{server.server_address[1]}/api/providers/compatibility-test"

        def request():
            outgoing = urllib.request.Request(
                endpoint,
                data=json.dumps({"id": "local-fixture", "mode": "conversation"}).encode(),
                headers={"Content-Type": "application/json", "X-CSRF-Token": "compatibility-http-csrf"},
            )
            try:
                with urllib.request.urlopen(outgoing, timeout=3) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as exc:
                with exc:
                    return exc.code, json.loads(exc.read())

        set_enabled(self.state_dir, "providers", False)
        disabled_status, disabled_body = request()
        self.assertEqual(403, disabled_status, disabled_body)
        set_enabled(self.state_dir, "providers", True)
        gated_status, gated_body = request()
        self.assertEqual(403, gated_status, gated_body)
        self.assertIn("real model requests are disabled", gated_body["error"])

    def test_real_chat_retry_counter_is_adapter_owned_and_not_taken_from_remote(self):
        state = {}
        base = self.with_server(state, statuses=[429, 200])
        provider = OpenAICompatible(
            base=base, model="user-selected-local-model", key=SECRET,
            allow_loopback_http=True, runtime_profile="standard",
        )
        result = provider.complete([{"role": "user", "content": "hello"}], [])
        self.assertEqual(2, result["_request_attempts"])
        self.assertEqual(2, len(state["requests"]))

        spoof_state = {}
        spoof_base = self.with_server(spoof_state, spoof_attempts=True)
        spoof_provider = OpenAICompatible(
            base=spoof_base, model="user-selected-local-model", key=SECRET,
            allow_loopback_http=True, runtime_profile="standard",
        )
        spoofed = spoof_provider.complete([{"role": "user", "content": "hello"}], [])
        self.assertEqual(1, spoofed["_request_attempts"])

    def test_real_stream_retry_counter_counts_only_requests_actually_sent(self):
        state = {}
        provider = OpenAICompatible(
            base=self.with_server(state, statuses=[429, 200], sse=True),
            model="user-selected-local-model", key=SECRET,
            allow_loopback_http=True, runtime_profile="standard",
        )
        deltas = []
        result = provider.stream([{"role": "user", "content": "hello"}], [], deltas.append)
        self.assertEqual(2, result["_request_attempts"])
        self.assertEqual("RETRIED_STREAM", result["content"])
        self.assertEqual(["RETRIED_STREAM"], deltas)
        self.assertEqual(2, len(state["requests"]))


if __name__ == "__main__":
    unittest.main()
