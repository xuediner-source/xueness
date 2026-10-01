"""Xueness Event Protocol v1 tests.

Two layers:

* Pure derivation is asserted **byte-for-byte** against the frozen golden file
  ``tools/protocol-v1-golden.json``. Any shape or ordering change that breaks
  the contract fails here.
* The HTTP route ``/api/sessions/{id}/events.v1`` is exercised through the real
  handler (JSON + SSE), not by calling the derivation directly.

The golden file is the contract; editing it is a protocol change, not a test fix.
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import web
from xueness.events import (
    DEFAULT_LIMIT,
    ERROR_INVALID_ARGUMENT,
    MAX_LIMIT,
    SCHEMA_ENVELOPE,
    SCHEMA_EVENT,
    derive_events,
    error_code,
    head_seq,
    page_events,
    sse_body,
)

GOLDEN_PATH = Path(__file__).resolve().parent.parent / "tools" / "protocol-v1-golden.json"


def _golden() -> dict:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


class DerivationTests(unittest.TestCase):
    """derive_events must reproduce the frozen v1 event list exactly."""

    def setUp(self):
        self.golden = _golden()
        self.session = self.golden["session"]
        self.events = derive_events(self.session)

    def test_matches_golden_events_verbatim(self):
        self.assertEqual(self.events, self.golden["expected"]["events"])

    def test_seq_is_dense_from_one(self):
        self.assertEqual([e["seq"] for e in self.events], list(range(1, len(self.events) + 1)))

    def test_every_event_carries_common_fields(self):
        for event in self.events:
            self.assertEqual(event["schema"], SCHEMA_EVENT)
            self.assertEqual(event["sessionId"], self.session["id"])
            self.assertIsInstance(event["seq"], int)
            self.assertGreaterEqual(event["seq"], 1)
            self.assertIsInstance(event["type"], str)

    def test_turn_ids_increment_after_first_user_message(self):
        turn_by_seq = {e["seq"]: e.get("turnId") for e in self.events if "turnId" in e}
        # golden: tool.call/assistant.text before the second user turn are turn-1,
        # everything after it is turn-2.
        self.assertEqual(turn_by_seq[2], "turn-1")
        self.assertEqual(turn_by_seq[4], "turn-1")
        self.assertEqual(turn_by_seq[6], "turn-2")
        self.assertEqual(turn_by_seq[8], "turn-2")
        self.assertEqual(self.events[4]["turnId"], "turn-2")

    def test_tool_result_inherits_name_and_subject(self):
        results = [e for e in self.events if e["type"] == "tool.result"]
        self.assertEqual(results[0]["name"], "write")
        self.assertEqual(results[0]["subject"], "hello.txt")
        self.assertEqual(results[1]["name"], "read")
        self.assertEqual(results[1]["subject"], "hello.txt")

    def test_completion_counts_evidence(self):
        completion = [e for e in self.events if e["type"] == "session.completion"][0]
        self.assertTrue(completion["verified"])
        self.assertEqual(completion["evidenceCount"], 2)

    def test_unpaired_tool_result_yields_empty_labels(self):
        session = {
            "id": "a" * 32,
            "status": "pending",
            "steps": 0,
            "messages": [
                {"role": "user", "content": "task"},
                {"role": "tool", "tool_call_id": "orphan", "content": "x"},
            ],
            "results": {"orphan": {"ok": False, "error": "boom"}},
        }
        events = derive_events(session)
        result = [e for e in events if e["type"] == "tool.result"][0]
        self.assertEqual(result["name"], "")
        self.assertEqual(result["subject"], "")
        self.assertEqual(result["errorCode"], "xueness.error.tool_failed")

    def test_first_user_message_is_not_a_turn_event(self):
        turns = [e for e in self.events if e["type"] == "turn.user"]
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["preview"], "再读一次")

    def test_derivation_does_not_mutate_session(self):
        before = json.dumps(self.session, sort_keys=True, ensure_ascii=False)
        derive_events(self.session)
        self.assertEqual(json.dumps(self.session, sort_keys=True, ensure_ascii=False), before)


class ErrorCodeTests(unittest.TestCase):
    """The mapping is deterministic and order-sensitive (contract section 4)."""

    def setUp(self):
        self.golden = _golden()

    def test_matches_golden_error_codes(self):
        for case in self.golden["errorCodes"]:
            with self.subTest(error=case["error"], ok=case["ok"]):
                self.assertEqual(error_code(case["ok"], case["error"]), case["expect"])

    def test_ok_always_empty(self):
        self.assertEqual(error_code(True, "denied"), "")

    def test_order_denied_beats_invalid(self):
        # Contract: denied matches on equality OR prefix, and is checked before
        # invalid/required, so a "denied..." string wins over any later keyword.
        self.assertEqual(error_code(False, "denied: invalid permission"), "xueness.error.denied")
        self.assertEqual(error_code(False, "denied required approval"), "xueness.error.denied")

    def test_order_cancel_beats_not_found_and_invalid(self):
        self.assertEqual(error_code(False, "cancelled: not found"), "xueness.error.cancelled")
        self.assertEqual(error_code(False, "canceled invalid request"), "xueness.error.cancelled")

    def test_order_not_found_beats_invalid(self):
        self.assertEqual(error_code(False, "invalid path: no such file"), "xueness.error.not_found")

    def test_case_insensitive_and_whitespace_tolerant(self):
        self.assertEqual(error_code(False, "  DENIED  "), "xueness.error.denied")
        self.assertEqual(error_code(False, "Not Found"), "xueness.error.not_found")


class PaginationTests(unittest.TestCase):
    """page_events envelope semantics (contract sections 2 and 5)."""

    def setUp(self):
        self.golden = _golden()
        self.session = self.golden["session"]
        self.events = derive_events(self.session)

    def test_matches_golden_envelopes(self):
        for case in self.golden["expected"]["envelopes"]:
            req, exp = case["request"], case["expect"]
            with self.subTest(cursor=req["cursor"], limit=req["limit"]):
                env = page_events(self.session, self.events, req["cursor"], req["limit"])
                self.assertEqual([e["seq"] for e in env["events"]], exp["eventSeqs"])
                self.assertEqual(env["cursor"], exp["cursor"])
                self.assertEqual(env["nextCursor"], exp["nextCursor"])
                self.assertEqual(env["head"], exp["head"])
                self.assertEqual(env["hasMore"], exp["hasMore"])

    def test_envelope_shape(self):
        env = page_events(self.session, self.events, 0, DEFAULT_LIMIT)
        self.assertEqual(env["schema"], SCHEMA_ENVELOPE)
        self.assertEqual(env["protocolVersion"], 1)
        self.assertEqual(env["sessionId"], self.session["id"])
        self.assertEqual(env["status"], self.session["status"])
        self.assertEqual(env["mode"], "build")

    def test_head_is_full_list_not_window(self):
        env = page_events(self.session, self.events, 0, 2)
        self.assertEqual(env["head"], head_seq(self.events))
        self.assertEqual(len(env["events"]), 2)

    def test_cursor_beyond_head_is_not_an_error(self):
        env = page_events(self.session, self.events, 999, DEFAULT_LIMIT)
        self.assertEqual(env["events"], [])
        self.assertEqual(env["nextCursor"], 999)
        self.assertFalse(env["hasMore"])

    def test_limit_clamped_to_bounds(self):
        env_zero = page_events(self.session, self.events, 0, 0)
        self.assertEqual(len(env_zero["events"]), 1)
        env_negative = page_events(self.session, self.events, 0, -5)
        self.assertEqual(len(env_negative["events"]), 1)
        env_huge = page_events(self.session, self.events, 0, 10_000)
        self.assertEqual(len(env_huge["events"]), len(self.events))

    def test_empty_event_list(self):
        env = page_events({"id": "b" * 32, "status": "pending", "steps": 0}, [], 0, DEFAULT_LIMIT)
        self.assertEqual(env["head"], 0)
        self.assertEqual(env["events"], [])
        self.assertEqual(env["nextCursor"], 0)
        self.assertFalse(env["hasMore"])


class SafetyTests(unittest.TestCase):
    """Payloads must never leak file bodies or memory text."""

    def test_tool_result_never_carries_file_body(self):
        sentinel = "SENTINEL_FILE_BODY_DO_NOT_LEAK"
        session = {
            "id": "c" * 32,
            "status": "completed",
            "steps": 1,
            "messages": [
                {"role": "user", "content": "read it"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "t1", "function": {"name": "read", "arguments": '{"path":"secret.txt"}'}}
                    ],
                },
                {"role": "tool", "tool_call_id": "t1", "content": sentinel},
            ],
            "results": {"t1": {"ok": True, "content": sentinel}},
            "completion": {"verified": True, "summary": "done", "evidence": []},
        }
        blob = json.dumps(derive_events(session), ensure_ascii=False)
        self.assertNotIn(sentinel, blob)
        self.assertIn("secret.txt", blob)

    def test_subject_is_capped(self):
        long_path = "z" * 500
        session = {
            "id": "d" * 32,
            "status": "pending",
            "steps": 0,
            "messages": [
                {"role": "user", "content": "task"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "t1", "function": {"name": "read", "arguments": json.dumps({"path": long_path})}}
                    ],
                },
            ],
        }
        event = [e for e in derive_events(session) if e["type"] == "tool.call"][0]
        self.assertEqual(len(event["subject"]), 200)


class SseBodyTests(unittest.TestCase):
    def test_sse_frames_sequences_and_types(self):
        golden = _golden()
        events = derive_events(golden["session"])[:2]
        body = sse_body(events).decode()
        self.assertIn("id: 1", body)
        self.assertIn("event: session.status", body)
        self.assertIn("id: 2", body)
        self.assertIn("event: tool.call", body)
        # Events are separated by a blank line.
        self.assertIn("\n\n", body)

    def test_empty_events_yield_empty_body(self):
        self.assertEqual(sse_body([]), b"")


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class EventsRouteTests(unittest.TestCase):
    """The real HTTP handler, not a direct function call."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        project_dir = base / "proj"
        (project_dir / "xueness" / "static").mkdir(parents=True)
        dist = project_dir / "webapp" / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
        self.ctx = web.build_context(base / "state", base / "runs", project_dir,
                                     allow_real=False, csrf="test-csrf-token")
        self.server = _start(self.ctx)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        # Write the golden session straight into the store so the route has a
        # realistic journal to derive from.
        self.golden = _golden()
        session = self.golden["session"]
        session.setdefault("root", self.temp.name)
        self.ctx["store"].save(session)
        self.sid = session["id"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def _get(self, path, accept=None):
        req = urllib.request.Request(self.base + path)
        if accept:
            req.add_header("Accept", accept)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)

    def test_json_route_matches_golden_window(self):
        code, body, headers = self._get(
            f"/api/sessions/{self.sid}/events.v1?cursor=4&limit=2")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload["schema"], SCHEMA_ENVELOPE)
        self.assertEqual([e["seq"] for e in payload["events"]], [5, 6])
        self.assertEqual(payload["nextCursor"], 6)
        self.assertEqual(payload["head"], 9)
        self.assertTrue(payload["hasMore"])

    def test_default_window_returns_everything(self):
        code, body, _ = self._get(f"/api/sessions/{self.sid}/events.v1")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual([e["seq"] for e in payload["events"]], list(range(1, 10)))
        self.assertFalse(payload["hasMore"])

    def test_sse_route_streams_events(self):
        code, body, headers = self._get(
            f"/api/sessions/{self.sid}/events.v1?cursor=4&limit=2",
            accept="text/event-stream")
        self.assertEqual(code, 200)
        self.assertIn("text/event-stream", headers.get("Content-Type", ""))
        self.assertIn("id: 5", body)
        self.assertIn("event: turn.user", body)

    def test_invalid_cursor_is_rejected(self):
        code, body, _ = self._get(f"/api/sessions/{self.sid}/events.v1?cursor=nope")
        self.assertEqual(code, 400)
        payload = json.loads(body)
        self.assertEqual(payload["error"], "invalid cursor")
        self.assertEqual(payload["errorCode"], ERROR_INVALID_ARGUMENT)

    def test_invalid_limit_is_rejected(self):
        code, body, _ = self._get(f"/api/sessions/{self.sid}/events.v1?limit=abc")
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(body)["error"], "invalid limit")

    def test_out_of_range_limit_is_clamped_not_rejected(self):
        code, body, _ = self._get(f"/api/sessions/{self.sid}/events.v1?limit=99999")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["head"], 9)

    def test_unknown_session_is_404(self):
        code, _, _ = self._get(f"/api/sessions/{'9' * 32}/events.v1")
        self.assertEqual(code, 404)

    def test_legacy_events_route_still_works(self):
        # The additive v1 route must not disturb the legacy shape.
        code, body, _ = self._get(f"/api/sessions/{self.sid}/events?limit=200")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertIn("events", payload)
        self.assertNotIn("schema", payload)
        self.assertEqual(payload["id"], self.sid)


if __name__ == "__main__":
    unittest.main()
