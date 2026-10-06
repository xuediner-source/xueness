"""sessions.events_cursor: incremental cursor paging on the legacy events route.

Two layers, mirroring tests/test_events_v1.py:

* Pure helpers: cursor/limit parsing, the numbered derivation and the paging
  envelope (growth, shrink-after-compaction, bounds).
* The real HTTP route ``/api/sessions/{id}/events`` through a real server in
  an isolated state directory: the default-off feature flag, strict 400s,
  SSE windows and session/state-directory isolation.

The legacy response (no cursor parameter) must stay byte-for-byte the old
shape in every flag state; that invariant is asserted first.
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from xueness import web
from xueness.bundled_plugins.sessions import events_cursor
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.core import session_events
from xueness.plugin_runtime import set_enabled


def _session(sid, messages, *, status="pending", steps=0, pending_question=None):
    return {
        "id": sid,
        "task": "test task",
        "root": "/tmp",
        "status": status,
        "steps": steps,
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "task"},
                     *messages],
        "results": {},
        "pending_question": pending_question,
    }


def _assistant_call(call_id, name, arguments):
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": call_id, "function": {"name": name, "arguments": arguments}}]}


def _tool_result(call_id):
    return {"role": "tool", "tool_call_id": call_id, "content": "x"}


#: messages -> legacy events: status(1), tool_call(2), tool_result(3),
#: assistant(4), user(5), assistant(6). The first user message is the task
#: itself and never becomes an event.
SID_A = "a" * 32
SESSION_A = _session(SID_A, [
    _assistant_call("t1", "write", '{"path":"hello.txt","content":"hi"}'),
    _tool_result("t1"),
    {"role": "assistant", "content": "partial text"},
    {"role": "user", "content": "more"},
    {"role": "assistant", "content": "final"},
], status="running", steps=2)
HEAD_A = 6


class CursorParsingTests(unittest.TestCase):
    """requested_cursor/requested_limit: strict, symmetric, bounded."""

    def test_absent_parameters_mean_legacy_request(self):
        self.assertIsNone(events_cursor.requested_cursor({}))
        self.assertIsNone(events_cursor.requested_cursor({'limit': ['10']}))
        # Blank values (parse_qs drops most of them) also mean "not provided".
        self.assertIsNone(events_cursor.requested_cursor({'cursor': ['']}))
        self.assertIsNone(events_cursor.requested_cursor({'cursor': [''], 'since': ['']}))

    def test_cursor_and_since_are_aliases(self):
        self.assertEqual(events_cursor.requested_cursor({'cursor': ['5']}), 5)
        self.assertEqual(events_cursor.requested_cursor({'since': ['5']}), 5)
        self.assertEqual(events_cursor.requested_cursor({'cursor': ['5'], 'since': ['5']}), 5)

    def test_repeated_conflicting_parameter_values_are_rejected(self):
        with self.assertRaises(events_cursor.CursorError) as raised:
            events_cursor.requested_cursor({'cursor': ['2', '9']})
        self.assertEqual(str(raised.exception), 'conflicting cursor values')

    def test_conflicting_values_are_rejected(self):
        with self.assertRaises(events_cursor.CursorError) as raised:
            events_cursor.requested_cursor({'cursor': ['1'], 'since': ['2']})
        self.assertEqual(str(raised.exception), 'conflicting cursor values')

    def test_non_decimal_values_are_rejected(self):
        for bad in ('abc', '-1', '1.5', '+1', ' 1', '0x10', '1_0', '1e3', ' '):
            with self.subTest(value=bad):
                with self.assertRaises(events_cursor.CursorError) as raised:
                    events_cursor.requested_cursor({'cursor': [bad]})
                self.assertEqual(str(raised.exception), 'invalid cursor')

    def test_cursor_beyond_json_safe_integers_is_rejected(self):
        self.assertEqual(events_cursor.requested_cursor(
            {'cursor': [str(events_cursor.MAX_CURSOR)]}), events_cursor.MAX_CURSOR)
        with self.assertRaises(events_cursor.CursorError) as raised:
            events_cursor.requested_cursor({'cursor': ['9' * 30]})
        self.assertEqual(str(raised.exception), 'cursor too large')

    def test_limit_defaults_and_clamps(self):
        self.assertEqual(events_cursor.requested_limit({}), 200)
        self.assertEqual(events_cursor.requested_limit({'limit': ['0']}), 1)
        self.assertEqual(events_cursor.requested_limit({'limit': ['500']}), 500)
        self.assertEqual(events_cursor.requested_limit({'limit': ['501']}), 500)
        self.assertEqual(events_cursor.requested_limit({'limit': ['9' * 30]}), 500)

    def test_limit_is_strict_for_cursor_requests(self):
        for bad in ('abc', '-2', '1.5', ''):
            with self.subTest(value=bad):
                with self.assertRaises(events_cursor.CursorError) as raised:
                    events_cursor.requested_limit({'limit': [bad]})
                self.assertEqual(str(raised.exception), 'invalid limit')


class PagingTests(unittest.TestCase):
    """numbered_events/page: dense seq, forward windows, resync on shrink."""

    def test_seq_is_dense_and_covers_the_legacy_derivation(self):
        events = events_cursor.numbered_events(SESSION_A)
        self.assertEqual([event['seq'] for event in events], list(range(1, HEAD_A + 1)))
        self.assertEqual([event['type'] for event in events],
                         ['status', 'tool_call', 'tool_result', 'assistant', 'user', 'assistant'])
        # Every numbered event is the legacy payload plus its seq.
        legacy = session_events(SESSION_A, 10 ** 9)
        for numbered, plain in zip(events, legacy):
            self.assertEqual({**numbered, 'seq': None}, {**plain, 'seq': None})

    def test_first_window_and_followups_page_forward(self):
        first = events_cursor.page(SESSION_A, 0, 3)
        self.assertEqual([event['seq'] for event in first['events']], [1, 2, 3])
        self.assertEqual(first['next_cursor'], 3)
        self.assertTrue(first['has_more'])
        self.assertEqual(first['id'], SID_A)
        self.assertEqual(first['status'], 'running')
        self.assertEqual(first['steps'], 2)

        second = events_cursor.page(SESSION_A,
                                    events_cursor.requested_cursor(
                                        {'cursor': [first['next_cursor_token']]}), 3)
        self.assertEqual([event['seq'] for event in second['events']], [4, 5, 6])
        self.assertEqual(second['next_cursor'], 6)
        self.assertFalse(second['has_more'])

        caught_up = events_cursor.page(SESSION_A,
                                       events_cursor.requested_cursor(
                                           {'cursor': [second['next_cursor_token']]}), 3)
        self.assertEqual(caught_up['events'], [])
        self.assertEqual(caught_up['next_cursor'], HEAD_A)
        self.assertFalse(caught_up['has_more'])

    def test_limit_is_clamped_inside_page(self):
        self.assertEqual(len(events_cursor.page(SESSION_A, 0, 0)['events']), 1)
        self.assertEqual(len(events_cursor.page(SESSION_A, 0, -5)['events']), 1)
        window = events_cursor.page(SESSION_A, 0, 10 ** 9)
        self.assertEqual(len(window['events']), HEAD_A)
        self.assertFalse(window['has_more'])

    def test_cursor_ahead_of_head_is_rejected(self):
        for cursor in (HEAD_A + 1, HEAD_A + 1000, events_cursor.MAX_CURSOR):
            with self.subTest(cursor=cursor):
                with self.assertRaises(events_cursor.CursorError) as raised:
                    events_cursor.page(SESSION_A, cursor, 200)
                self.assertEqual(str(raised.exception), 'cursor ahead of session head')
                self.assertEqual(raised.exception.status, 409)
                self.assertEqual(raised.exception.resync_cursor, 0)

    def test_legacy_nonzero_numeric_cursor_requires_resync(self):
        with self.assertRaises(events_cursor.ResyncRequired) as raised:
            events_cursor.page(SESSION_A, 3, 200)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.resync_cursor, 0)

    def test_growth_appends_without_renumbering(self):
        before = events_cursor.numbered_events(SESSION_A)
        grown = json.loads(json.dumps(SESSION_A))
        grown['messages'].append({"role": "assistant", "content": "one more"})
        after = events_cursor.numbered_events(grown)
        self.assertEqual(after[:HEAD_A], before)
        self.assertEqual(after[-1]['seq'], HEAD_A + 1)
        token = events_cursor.page(SESSION_A, 0, 200)['next_cursor_token']
        window = events_cursor.page(grown,
                                    events_cursor.requested_cursor({'since': [token]}), 200)
        self.assertEqual([event['seq'] for event in window['events']], [HEAD_A + 1])
        self.assertEqual(window['next_cursor'], HEAD_A + 1)

    def test_shrink_after_compaction_forces_a_resync(self):
        initial = events_cursor.page(SESSION_A, 0, 200)
        head = len(events_cursor.numbered_events(SESSION_A))
        compacted = json.loads(json.dumps(SESSION_A))
        # Compaction drops whole older turns into archived_messages.
        compacted['messages'] = compacted['messages'][:3]
        smaller = len(events_cursor.numbered_events(compacted))
        self.assertLess(smaller, head)
        with self.assertRaises(events_cursor.ResyncRequired):
            events_cursor.page(compacted,
                               events_cursor.requested_cursor(
                                   {'cursor': [initial['next_cursor_token']]}), 200)
        # A client that resyncs from 0 sees the new, shorter derivation.
        fresh = events_cursor.page(compacted, 0, 200)
        self.assertEqual(fresh['next_cursor'], smaller)
        self.assertFalse(fresh['has_more'])

    def test_same_length_replacement_invalidates_consumed_prefix(self):
        prior = events_cursor.page(SESSION_A, 0, 3)
        replaced = json.loads(json.dumps(SESSION_A))
        replaced['messages'][2]['tool_calls'][0]['function']['arguments'] = '{"path":"changed"}'
        self.assertEqual(len(events_cursor.numbered_events(replaced)), HEAD_A)
        with self.assertRaises(events_cursor.ResyncRequired):
            events_cursor.page(replaced,
                               events_cursor.requested_cursor(
                                   {'cursor': [prior['next_cursor_token']]}), 200)

    def test_shrink_then_regrow_cannot_reuse_old_numeric_position_token(self):
        prior = events_cursor.page(SESSION_A, 0, 200)
        changed = json.loads(json.dumps(SESSION_A))
        changed['messages'] = changed['messages'][:3]
        changed['messages'].extend([
            {'role': 'assistant', 'content': 'new event one'},
            {'role': 'assistant', 'content': 'new event two'},
            {'role': 'assistant', 'content': 'new event three'},
            {'role': 'assistant', 'content': 'new event four'},
        ])
        self.assertEqual(len(events_cursor.numbered_events(changed)), HEAD_A)
        with self.assertRaises(events_cursor.ResyncRequired):
            events_cursor.page(changed,
                               events_cursor.requested_cursor(
                                   {'cursor': [prior['next_cursor_token']]}), 200)

    def test_status_and_steps_travel_in_the_envelope(self):
        # seq 1 is the mutable status event; later windows never re-deliver it,
        # so its current values must ride along in the envelope every time.
        later = json.loads(json.dumps(SESSION_A))
        later['status'] = 'completed'
        later['steps'] = 7
        token = events_cursor.page(SESSION_A, 0, 200)['next_cursor_token']
        window = events_cursor.page(later,
                                    events_cursor.requested_cursor({'cursor': [token]}), 200)
        self.assertEqual(window['events'], [])
        self.assertEqual(window['status'], 'completed')
        self.assertEqual(window['steps'], 7)

    def test_pending_question_appends_at_the_tail(self):
        with_question = json.loads(json.dumps(SESSION_A))
        with_question['pending_question'] = 'which file?'
        events = events_cursor.numbered_events(with_question)
        self.assertEqual(events[-1]['type'], 'pending_question')
        self.assertEqual(events[-1]['seq'], HEAD_A + 1)
        # Answering clears it again; a cursor at the old head must resync.
        self.assertEqual(len(events_cursor.numbered_events(SESSION_A)), HEAD_A)
        with self.assertRaises(events_cursor.CursorError):
            events_cursor.page(SESSION_A, HEAD_A + 1, 200)


class FlagTests(unittest.TestCase):
    """The persistent flag binds to the state directory and defaults to off."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"
        self.state.mkdir(parents=True)
        self.ctx = {"state_dir": self.state}

    def tearDown(self):
        self.temp.cleanup()

    def test_disabled_without_settings(self):
        self.assertFalse(events_cursor.enabled(self.ctx))

    def test_enabled_only_by_an_explicit_boolean(self):
        save_settings(self.state, {"general": {"sessionsEventsCursorEnabled": True}})
        self.assertTrue(events_cursor.enabled(self.ctx))
        save_settings(self.state, {"general": {"sessionsEventsCursorEnabled": False}})
        self.assertFalse(events_cursor.enabled(self.ctx))
        save_settings(self.state, {"general": {"sessionsEventsCursorEnabled": "true"}})
        self.assertFalse(events_cursor.enabled(self.ctx))

    def test_a_non_object_section_is_ignored(self):
        save_settings(self.state, {"general": "broken"})
        self.assertFalse(events_cursor.enabled(self.ctx))


def _start(ctx):
    server = web.create_server(0, ctx)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class EventsCursorRouteTests(unittest.TestCase):
    """The real HTTP handler, with an isolated state directory per test."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / "state", base / "runs", base / "project",
                                     allow_real=False, csrf="test-csrf-token")
        self.server = _start(self.ctx)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.sid = self.ctx["store"].new("test task", self.ctx["web_runs"])["id"]
        self._save(SESSION_A)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    # -- helpers ---------------------------------------------------------

    def _save(self, session):
        session = json.loads(json.dumps(session))
        session["id"] = self.sid
        session["root"] = str(self.ctx["web_runs"])
        self.ctx["store"].save(session)
        return session

    def _get(self, path, accept=None):
        req = urllib.request.Request(self.base + path)
        if accept:
            req.add_header("Accept", accept)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)
            finally:
                exc.close()

    def _post(self, path, data):
        req = urllib.request.Request(
            self.base + path, data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json", "X-CSRF-Token": "test-csrf-token"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def _enable(self, enabled=True):
        save_settings(self.ctx["state_dir"],
                      {"general": {"sessionsEventsCursorEnabled": enabled}})

    def _events_path(self, query=""):
        return f"/api/sessions/{self.sid}/events" + (f"?{query}" if query else "")

    # -- backward compatibility -------------------------------------------

    def test_legacy_response_is_unchanged_without_cursor(self):
        for flag in (False, True):
            with self.subTest(flag=flag):
                self._enable(flag)
                code, body, _ = self._get(self._events_path())
                self.assertEqual(code, 200)
                payload = json.loads(body)
                # Exactly the legacy keys, in the legacy derivation.
                self.assertEqual(set(payload), {"id", "status", "steps", "events"})
                self.assertEqual(payload["id"], self.sid)
                self.assertEqual(payload["events"], session_events(SESSION_A, 200))
                for event in payload["events"]:
                    self.assertNotIn("seq", event)

    def test_legacy_limit_and_sse_behaviour_is_unchanged(self):
        self._enable(True)
        # Malformed limits still fall back to 200 on the legacy path.
        code, body, _ = self._get(self._events_path("limit=abc"))
        self.assertEqual(code, 200)
        self.assertEqual(len(json.loads(body)["events"]), HEAD_A)
        code, body, headers = self._get(self._events_path(), accept="text/event-stream")
        self.assertEqual(code, 200)
        self.assertIn("text/event-stream", headers.get("Content-Type", ""))
        self.assertIn("event: status", body)
        self.assertNotIn("id: ", body)

    # -- the feature flag --------------------------------------------------

    def test_cursor_request_rejected_while_flag_off(self):
        for query in ("cursor=0", "since=3", "cursor=1&limit=5"):
            with self.subTest(query=query):
                code, body, _ = self._get(self._events_path(query))
                self.assertEqual(code, 400)
                payload = json.loads(body)
                self.assertEqual(payload["error"], "sessions.events_cursor not enabled")
                self.assertEqual(payload["feature"], "sessions.events_cursor")

    def test_flag_takes_effect_without_restart(self):
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 400)
        self._enable(True)
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 200)
        self._enable(False)
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 400)

    def test_settings_api_accepts_only_a_boolean_flag(self):
        code, payload = self._post("/api/settings/general",
                                   {"values": {"sessionsEventsCursorEnabled": True}})
        self.assertEqual(code, 200, payload)
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 200)
        code, payload = self._post("/api/settings/general",
                                   {"values": {"sessionsEventsCursorEnabled": "yes"}})
        self.assertEqual(code, 400)
        self.assertIn("sessionsEventsCursorEnabled", payload["error"])

    def test_disabled_sessions_plugin_beats_the_flag(self):
        self._enable(True)
        set_enabled(self.ctx["state_dir"], "sessions", False)
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 403)
        self.assertEqual(self._get(self._events_path())[0], 403)
        set_enabled(self.ctx["state_dir"], "sessions", True)
        self.assertEqual(self._get(self._events_path("cursor=0"))[0], 200)

    # -- incremental windows ------------------------------------------------

    def test_incremental_paging_walks_the_whole_timeline(self):
        self._enable(True)
        seen, cursor = [], 0
        for _ in range(10):
            code, body, _ = self._get(self._events_path(f"cursor={cursor}&limit=2"))
            self.assertEqual(code, 200)
            payload = json.loads(body)
            self.assertEqual(set(payload),
                             {"id", "status", "steps", "events", "next_cursor",
                              "next_cursor_token", "has_more"})
            seen.extend(event["seq"] for event in payload["events"])
            self.assertEqual(payload["next_cursor"],
                             payload["events"][-1]["seq"] if payload["events"] else
                             (events_cursor.requested_cursor({'cursor': [cursor]}).position
                              if isinstance(cursor, str) else cursor))
            cursor = payload["next_cursor_token"]
            if not payload["has_more"]:
                self.assertEqual(payload["next_cursor"], HEAD_A)
                break
        self.assertEqual(seen, list(range(1, HEAD_A + 1)))
        # A caught-up poll delivers nothing new and keeps the cursor.
        code, body, _ = self._get(self._events_path(f"cursor={cursor}"))
        payload = json.loads(body)
        self.assertEqual(code, 200)
        self.assertEqual(payload["events"], [])
        self.assertEqual(payload["next_cursor"], HEAD_A)
        self.assertFalse(payload["has_more"])

    def test_since_alias_and_conflicting_values(self):
        self._enable(True)
        first = json.loads(self._get(self._events_path("cursor=0&limit=2"))[1])
        token = first['next_cursor_token']
        code, body, _ = self._get(self._events_path(f"since={token}&limit=2"))
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual([event["seq"] for event in payload["events"]], [3, 4])
        code, body, _ = self._get(self._events_path("cursor=2&since=3"))
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(body)["error"], "conflicting cursor values")
        code, body, _ = self._get(self._events_path(f"cursor={token}&since={token}"))
        self.assertEqual(code, 200)

    def test_invalid_cursor_values_are_400(self):
        self._enable(True)
        for value, message in (("abc", "invalid cursor"), ("-1", "invalid cursor"),
                               ("1.5", "invalid cursor"), ("+1", "invalid cursor"),
                               ("%201", "invalid cursor"), ("9" * 30, "cursor too large")):
            with self.subTest(value=value):
                code, body, _ = self._get(self._events_path(f"cursor={value}"))
                self.assertEqual(code, 400)
                payload = json.loads(body)
                self.assertEqual(payload["error"], message)
                self.assertEqual(payload["errorCode"], "xueness.error.invalid_argument")

    def test_cursor_ahead_of_head_requires_resync_even_for_huge_values(self):
        self._enable(True)
        # All values stay below MAX_CURSOR: they parse, then fail the head
        # check. Values beyond MAX_CURSOR are covered above as "too large".
        for cursor in (HEAD_A + 1, 10 ** 12, 10 ** 15):
            with self.subTest(cursor=cursor):
                code, body, _ = self._get(self._events_path(f"cursor={cursor}"))
                self.assertEqual(code, 409)
                payload = json.loads(body)
                self.assertEqual(payload["error"], "cursor ahead of session head")
                self.assertEqual(payload["resync_cursor"], 0)

    def test_limit_is_strict_and_clamped_in_cursor_mode(self):
        self._enable(True)
        code, body, _ = self._get(self._events_path("cursor=0&limit=abc"))
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(body)["error"], "invalid limit")
        code, body, _ = self._get(self._events_path("cursor=0&limit=0"))
        self.assertEqual(code, 200)
        self.assertEqual(len(json.loads(body)["events"]), 1)

    def test_limit_clamps_at_500_for_large_sessions(self):
        self._enable(True)
        messages = [{"role": "assistant", "content": f"line {index}"}
                    for index in range(600)]
        self._save(_session(self.sid, messages))
        code, body, _ = self._get(self._events_path("cursor=0&limit=99999"))
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(len(payload["events"]), 500)
        self.assertTrue(payload["has_more"])
        self.assertEqual(payload["next_cursor"], 500)
        first = json.loads(body)
        code, body, _ = self._get(self._events_path(
            f"cursor={first['next_cursor_token']}&limit=99999"))
        payload = json.loads(body)
        self.assertEqual(len(payload["events"]), 101)
        self.assertFalse(payload["has_more"])
        self.assertEqual(payload["next_cursor"], 601)

    def test_sse_stream_carries_the_incremental_window(self):
        self._enable(True)
        first = json.loads(self._get(self._events_path("cursor=0&limit=2"))[1])
        code, body, headers = self._get(self._events_path(
            f"cursor={first['next_cursor_token']}&limit=2"),
                                        accept="text/event-stream")
        self.assertEqual(code, 200)
        self.assertIn("text/event-stream", headers.get("Content-Type", ""))
        self.assertRegex(body, r"id: c1\.3\.[0-9a-f]{64}")
        self.assertRegex(body, r"id: c1\.4\.[0-9a-f]{64}")
        self.assertNotIn("id: c1.1.", body)
        self.assertNotIn("id: c1.2.", body)
        self.assertNotIn("id: c1.5.", body)
        # Every SSE event id is a resumable prefix-revision token.
        self.assertIn("event: assistant", body)
        last_id = next(line.removeprefix('id: ') for line in body.splitlines()
                       if line.startswith('id: c1.4.'))
        code, page, _ = self._get(self._events_path(f"cursor={last_id}"))
        self.assertEqual(code, 200)
        self.assertEqual([event['seq'] for event in json.loads(page)['events']], [5, 6])

    # -- growth, shrink and isolation ----------------------------------------

    def test_new_events_arrive_incrementally_as_the_journal_grows(self):
        self._enable(True)
        initial = json.loads(self._get(self._events_path("cursor=0&limit=500"))[1])
        token = initial['next_cursor_token']
        _, body, _ = self._get(self._events_path(f"cursor={token}"))
        self.assertEqual(json.loads(body)["events"], [])
        grown = json.loads(json.dumps(SESSION_A))
        grown["messages"].extend([
            {"role": "user", "content": "again"},
            {"role": "assistant", "content": "reply"},
        ])
        self._save(grown)
        code, body, _ = self._get(self._events_path(f"cursor={token}"))
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual([event["seq"] for event in payload["events"]], [HEAD_A + 1, HEAD_A + 2])
        self.assertEqual([event["type"] for event in payload["events"]], ["user", "assistant"])

    def test_shrunk_journal_rejects_the_stale_cursor(self):
        self._enable(True)
        self._save(_session(self.sid, []))  # compaction dropped every turn
        code, body, _ = self._get(self._events_path(f"cursor={HEAD_A}"))
        self.assertEqual(code, 409)
        payload = json.loads(body)
        self.assertEqual(payload["error"], "cursor ahead of session head")
        self.assertEqual(payload["resync_cursor"], 0)
        code, body, _ = self._get(self._events_path("cursor=0"))
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual([event["seq"] for event in payload["events"]], [1])
        self.assertEqual(payload["events"][0]["type"], "status")

    def test_sessions_never_leak_into_each_other(self):
        self._enable(True)
        other = self.ctx["store"].new("other task", self.ctx["web_runs"])
        other_sid = other["id"]
        sentinel = "B-ONLY-SENTINEL"
        other["messages"].extend([
            {"role": "user", "content": "m1"},
            {"role": "assistant", "content": sentinel},
            {"role": "user", "content": "m2"},
            {"role": "assistant", "content": "tail"},
            {"role": "user", "content": "m3"},
            {"role": "assistant", "content": "end"},
        ])
        self.ctx["store"].save(other)
        other_head = len(events_cursor.numbered_events(other))
        self.assertGreater(other_head, HEAD_A)

        code, body, _ = self._get(self._events_path("cursor=0&limit=500"))
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload["id"], self.sid)
        self.assertNotIn(sentinel, body)
        self.assertEqual(max(event["seq"] for event in payload["events"]), HEAD_A)

        # A legacy numeric cursor needs a safe resync; cursors remain
        # session-bound even if two sessions happen to have matching heads.
        code, body, _ = self._get(self._events_path(f"cursor={other_head}"))
        self.assertEqual(code, 409)
        self.assertEqual(json.loads(body)["resync_cursor"], 0)

        # The other session pages its own timeline, not this one's.
        code, body, _ = self._get(f"/api/sessions/{other_sid}/events?cursor=0")
        self.assertEqual(code, 200)
        self.assertIn(sentinel, body)
        self.assertEqual(json.loads(body)["id"], other_sid)

    def test_unknown_session_and_invalid_sid_are_404(self):
        self._enable(True)
        self.assertEqual(self._get(f"/api/sessions/{'9' * 32}/events?cursor=0")[0], 404)
        self.assertEqual(self._get("/api/sessions/notasid/events?cursor=0")[0], 404)

    def test_separate_state_directories_are_fully_isolated(self):
        self._enable(True)
        with tempfile.TemporaryDirectory() as foreign:
            base = Path(foreign)
            ctx = web.build_context(base / "state", base / "runs", base / "project",
                                    allow_real=False, csrf="other")
            server = _start(ctx)
            try:
                url = f"http://127.0.0.1:{server.server_address[1]}/api/sessions/{self.sid}/events"
                req = urllib.request.Request(url + "?cursor=0")
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        code = resp.status
                except urllib.error.HTTPError as exc:
                    try:
                        code = exc.code
                    finally:
                        exc.close()
                self.assertEqual(code, 404)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
