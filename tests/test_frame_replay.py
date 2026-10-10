"""remote.frame_replay: bounded unacked stdio frames, default off.

The flag-off app-server method table and frame fields stay as they were.
These tests drive ``handle_line`` against a ``BytesIO`` so a frame may carry
``xuenessSeq`` without going through the strict harness reader.
"""
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

from xueness.bundled_plugins.remote import app_server, frame_replay
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import set_enabled

WIDE = {
    "high": frame_replay.HIGH_WATER_BYTES,
    "low": frame_replay.LOW_WATER_BYTES,
    "max": frame_replay.MAX_REPLAY_BYTES,
    "grace": frame_replay.GRACE_SECONDS,
}


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FrameReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / "state"
        self.root = self.base / "work"
        self.root.mkdir()
        set_enabled(self.state, "remote", True)

    def context(self):
        return app_server.build_app_context(
            self.state, web_runs=self.base / "runs", project_dir=self.base / "proj",
            workspace_roots=[self.root], allow_real=False)

    def make(self, enabled=False, limits=None, now=None):
        ctx = self.context()
        if enabled:
            save_settings(self.state, {"general": {"remoteFrameReplayEnabled": True}})
        buf = io.BytesIO()
        frames = app_server._Frames(buf)
        server = app_server.AppServer(ctx, frames)
        if limits is not None or now is not None:
            replay = frame_replay.Replay(ctx, limits=limits, now=now)
            server.replay = replay
            frames.bind_replay(replay)
        return server, buf

    def drain(self, buf):
        raw = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        frames = []
        for line in raw.decode("utf-8").splitlines():
            if line.strip():
                frames.append(json.loads(line))
        return frames

    def request(self, server, method, params=None, request_id=1, **extra):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method,
                   "params": params or {}}
        message.update(extra)
        server.handle_line(json.dumps(message).encode())

    def session_with_replies(self, server):
        session = server.ctx["store"].new("test task", self.root)
        session["messages"].append({"role": "assistant", "content": "alpha"})
        session["messages"].append({"role": "assistant", "content": "beta"})
        server.ctx["store"].save(session)
        return session

    def test_constants_match_the_socket_replay_buffer(self):
        self.assertEqual(frame_replay.HIGH_WATER_BYTES, 1024 * 1024)
        self.assertEqual(frame_replay.LOW_WATER_BYTES, frame_replay.HIGH_WATER_BYTES // 4)
        self.assertEqual(frame_replay.MAX_REPLAY_BYTES, 8 * 1024 * 1024)
        self.assertEqual(frame_replay.GRACE_SECONDS, 45.0)
        limits = frame_replay.Replay(self.context()).status_body()["limits"]
        self.assertEqual(limits["highWaterBytes"], frame_replay.HIGH_WATER_BYTES)
        self.assertEqual(limits["lowWaterBytes"], frame_replay.LOW_WATER_BYTES)
        self.assertEqual(limits["maxReplayBytes"], frame_replay.MAX_REPLAY_BYTES)
        self.assertEqual(limits["graceSeconds"], 45.0)

    def test_only_boolean_true_enables_replay(self):
        ctx = self.context()
        self.assertFalse(frame_replay.Replay(ctx).active())
        self.assertFalse(frame_replay.Replay({}).active())
        for value in ("true", 1, 0, None, [], "false"):
            save_settings(self.state, {"general": {"remoteFrameReplayEnabled": value}})
            self.assertFalse(frame_replay.Replay(ctx).active(), repr(value))
        save_settings(self.state, {"general": {"remoteFrameReplayEnabled": True}})
        self.assertTrue(frame_replay.Replay(ctx).active())

    def test_setting_read_is_cached_for_one_second(self):
        ctx = self.context()
        replay = frame_replay.Replay(ctx)
        self.assertFalse(replay.active())
        save_settings(self.state, {"general": {"remoteFrameReplayEnabled": True}})
        self.assertFalse(replay.active())
        replay._cached_until = 0
        self.assertTrue(replay.active())

    def test_flag_off_ignores_saturation_and_hides_transport_methods(self):
        server, buf = self.make(enabled=False)
        replay = server.replay
        replay._saturated = True
        replay._abandoned = True
        self.assertFalse(replay.blocks_new_events())
        self.request(server, "initialize", request_id=1)
        frame = self.drain(buf)[0]
        self.assertEqual(frame["result"]["protocolVersion"], 1)
        self.assertEqual(set(frame["result"]["methods"]), set(server._methods))
        self.assertNotIn("xuenessSeq", frame)
        for name in frame_replay.TRANSPORT_METHODS:
            self.assertNotIn(name, frame["result"]["methods"])
        self.request(server, "transport/ack", {"ack": 0}, request_id=2)
        refused = self.drain(buf)[0]
        self.assertEqual(refused["error"]["code"], app_server.METHOD_NOT_FOUND)
        self.assertNotIn("transport/ack", refused["error"]["data"]["known"])
        self.assertNotIn("xuenessSeq", refused)

    def test_flag_off_pump_still_delivers_the_whole_page(self):
        server, buf = self.make(enabled=False)
        session = self.session_with_replies(server)
        worker = app_server._TurnWorker(server, session["id"], {})
        cursor = worker._pump_events(0)
        frames = self.drain(buf)
        self.assertEqual([frame["params"]["event"]["seq"] for frame in frames], [1, 2, 3])
        self.assertEqual(cursor, 3)
        self.assertTrue(all("xuenessSeq" not in frame for frame in frames))

    def test_flag_on_numbers_frames_and_adds_transport_methods(self):
        server, buf = self.make(enabled=True)
        self.request(server, "initialize", request_id=1)
        frame = self.drain(buf)[0]
        self.assertEqual(frame["result"]["protocolName"], app_server.PROTOCOL_NAME)
        self.assertEqual(frame["result"]["protocolVersion"], 1)
        self.assertEqual(frame["xuenessSeq"], 1)
        self.assertEqual(
            set(frame["result"]["methods"]),
            set(server._methods) | set(frame_replay.TRANSPORT_METHODS))
        self.request(server, "transport/status", {}, request_id=2)
        status = self.drain(buf)[0]["result"]
        self.assertEqual(status["schema"], frame_replay.SCHEMA)
        self.assertEqual(status["enabled"], True)
        self.assertEqual(status["acked"], 0)
        self.assertGreater(status["sent"], 0)

    def test_concurrent_senders_write_in_sequence_order(self):
        server, buf = self.make(enabled=True)
        first_admitted = threading.Event()
        release_first = threading.Event()
        second_started = threading.Event()
        second_finished = threading.Event()
        errors = []
        original_admit = server.replay.admit

        def delayed_admit(payload):
            frames = original_admit(payload)
            if payload["id"] == 1:
                first_admitted.set()
                if not release_first.wait(5):
                    raise TimeoutError("test did not release the first sender")
            return frames

        server.replay.admit = delayed_admit

        def send(number):
            if number == 2:
                second_started.set()
            try:
                server.frames.send({"jsonrpc": "2.0", "id": number, "result": {}})
            except Exception as exc:
                errors.append(exc)
            finally:
                if number == 2:
                    second_finished.set()

        first = threading.Thread(target=send, args=(1,), daemon=True)
        second = threading.Thread(target=send, args=(2,), daemon=True)
        first.start()
        try:
            self.assertTrue(first_admitted.wait(5))
            second.start()
            self.assertTrue(second_started.wait(5))
            # Give the competing sender a chance to overtake the admitted frame.
            second_finished.wait(0.2)
        finally:
            release_first.set()
            first.join(5)
            if second.ident is not None:
                second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        written = self.drain(buf)
        self.assertEqual([frame["xuenessSeq"] for frame in written], [1, 2])
        self.assertEqual([frame["id"] for frame in written], [1, 2])
        server.replay.apply_ack(1)
        self.assertEqual([frame["id"] for frame in server.replay.pending_payloads()], [2])

    def test_ack_drops_the_prefix_and_replay_keeps_the_original_seq(self):
        server, buf = self.make(enabled=True, limits=WIDE)
        sid = "ab" * 16
        server.frames.notification("turn/started", {"sessionId": sid, "cursor": 0})
        server.frames.notification("session/event", {
            "sessionId": sid, "event": {"seq": 4, "type": "assistant.text"}})
        written = self.drain(buf)
        self.assertEqual([frame["xuenessSeq"] for frame in written], [1, 2])
        server.replay.apply_ack(1)
        self.assertEqual(
            [item["xuenessSeq"] for item in server.replay.pending_payloads()], [2])
        self.request(server, "transport/replay", {}, request_id=9)
        replayed = self.drain(buf)
        self.assertEqual(replayed[0]["xuenessSeq"], 2)
        self.assertEqual(replayed[0]["method"], "session/event")
        self.assertEqual(replayed[1]["id"], 9)
        self.assertEqual(replayed[1]["result"], {"schema": frame_replay.SCHEMA, "replayed": 1})
        self.assertEqual(replayed[1]["xuenessSeq"], 3)
        self.assertEqual(
            [item["xuenessSeq"] for item in server.replay.pending_payloads()], [2, 3])
        server.replay.apply_ack(1)
        self.assertEqual(server.replay.status_body()["acked"], 1)

    def test_bool_float_and_ahead_ack_are_rejected(self):
        server, buf = self.make(enabled=True)
        self.request(server, "initialize", request_id=1, xuenessAck=True)
        frame = self.drain(buf)[0]
        self.assertEqual(frame["error"]["code"], app_server.INVALID_PARAMS)
        self.assertNotIn("result", frame)
        self.assertEqual(server.replay.status_body()["acked"], 0)
        self.request(server, "initialize", request_id=2)
        self.drain(buf)
        sent = server.replay.status_body()["sent"]
        self.request(server, "initialize", request_id=3, xuenessAck=sent + 5)
        ahead = self.drain(buf)[0]
        self.assertEqual(ahead["error"]["code"], app_server.INVALID_PARAMS)
        self.assertEqual(server.replay.status_body()["acked"], 0)
        self.request(server, "transport/ack", {"ack": True}, request_id=4)
        self.assertEqual(self.drain(buf)[0]["error"]["code"], app_server.INVALID_PARAMS)
        self.request(server, "transport/ack", {"ack": 1.0}, request_id=5)
        self.assertEqual(self.drain(buf)[0]["error"]["code"], app_server.INVALID_PARAMS)
        self.request(server, "transport/ack", {"ack": -1}, request_id=6)
        self.assertEqual(self.drain(buf)[0]["error"]["code"], app_server.INVALID_PARAMS)
        self.request(server, "transport/ack", {"ack": 0, "extra": 1}, request_id=7)
        self.assertEqual(self.drain(buf)[0]["error"]["code"], app_server.INVALID_PARAMS)
        self.assertEqual(server.replay.status_body()["acked"], 0)

    def test_saturation_pauses_the_pump_until_the_ack_reaches_low_water(self):
        server, buf = self.make(
            enabled=True, limits={"high": 1, "low": 0, "max": 8 * 1024 * 1024, "grace": 45})
        session = self.session_with_replies(server)
        worker = app_server._TurnWorker(server, session["id"], {})
        cursor = worker._pump_events(0)
        frames = self.drain(buf)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["params"]["event"]["seq"], 1)
        self.assertEqual(cursor, 1)
        self.assertTrue(server.replay.blocks_new_events())
        self.assertEqual(worker._pump_events(cursor), 1)
        self.assertEqual(self.drain(buf), [])
        server.frames.notification("turn/finished", {
            "sessionId": session["id"], "ok": True, "cursor": cursor})
        finished = self.drain(buf)
        self.assertEqual(finished[0]["method"], "turn/finished")
        self.assertIn(
            finished[0]["xuenessSeq"],
            [item["xuenessSeq"] for item in server.replay.pending_payloads()])
        server.replay.apply_ack(finished[0]["xuenessSeq"])
        self.assertFalse(server.replay.blocks_new_events())
        nxt = worker._pump_events(cursor)
        more = self.drain(buf)
        self.assertEqual(more[0]["params"]["event"]["seq"], 2)
        self.assertEqual(nxt, 2)

    def test_byte_cap_drops_the_event_and_does_not_advance_the_cursor(self):
        server, buf = self.make(
            enabled=True, limits={"high": 1, "low": 0, "max": 1, "grace": 45})
        before = threading.active_count()
        session = self.session_with_replies(server)
        worker = app_server._TurnWorker(server, session["id"], {})
        cursor = worker._pump_events(0)
        frames = self.drain(buf)
        self.assertEqual([frame["method"] for frame in frames], ["transport/abandoned"])
        self.assertEqual(frames[0]["xuenessSeq"], 1)
        self.assertEqual(frames[0]["params"]["reason"], "replay_limit")
        self.assertEqual(cursor, 0)
        self.assertIsNone(server.replay.pending_payloads())
        self.assertEqual(worker._pump_events(0), 0)
        self.assertEqual(self.drain(buf), [])
        server.frames.notification("turn/finished", {
            "sessionId": session["id"], "ok": True, "cursor": 0})
        later = self.drain(buf)
        self.assertEqual([frame["method"] for frame in later], ["turn/finished"])
        self.request(server, "transport/replay", {}, request_id=8)
        refused = self.drain(buf)[0]
        self.assertEqual(refused["error"]["code"], app_server.REFUSED)
        self.assertIn("event log", refused["error"]["message"])
        names = [thread.name for thread in threading.enumerate()]
        self.assertFalse(any(name.startswith("xueness-frame") for name in names))
        self.assertEqual(threading.active_count(), before)

    def test_grace_on_the_next_send_emits_one_note_and_keeps_turn_frames(self):
        clock = Clock()
        server, buf = self.make(enabled=True, limits=WIDE, now=clock)
        session = self.session_with_replies(server)
        server.frames.notification("turn/started", {"sessionId": session["id"], "cursor": 0})
        self.drain(buf)
        clock.now = 45.0
        server.frames.notification("session/event", {
            "sessionId": session["id"], "event": {"seq": 1, "type": "assistant.text"}})
        held = self.drain(buf)
        self.assertEqual(held[0]["method"], "session/event")
        self.assertFalse(server.replay.status_body()["abandoned"])
        clock.now = 90.0
        worker = app_server._TurnWorker(server, session["id"], {})
        cursor = worker._pump_events(0)
        frames = self.drain(buf)
        self.assertEqual([frame["method"] for frame in frames], ["transport/abandoned"])
        self.assertEqual(cursor, 0)
        self.assertEqual(worker._pump_events(0), 0)
        self.assertEqual(self.drain(buf), [])
        server.frames.notification("turn/finished", {
            "sessionId": session["id"], "ok": False, "cursor": 0})
        finished = self.drain(buf)
        self.assertEqual([frame["method"] for frame in finished], ["turn/finished"])
        self.assertGreater(finished[0]["xuenessSeq"], frames[0]["xuenessSeq"])

    def test_grace_on_receive_emits_the_note_once(self):
        clock = Clock()
        server, buf = self.make(enabled=True, limits=WIDE, now=clock)
        server.frames.notification("turn/started", {"sessionId": "cd" * 16, "cursor": 0})
        self.drain(buf)
        clock.now = 90.0
        self.request(server, "initialize", request_id=1)
        frames = self.drain(buf)
        notes = [frame for frame in frames if frame.get("method") == "transport/abandoned"]
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["params"]["schema"], frame_replay.SCHEMA)
        self.assertTrue(any(frame.get("id") == 1 and "result" in frame for frame in frames))
        self.request(server, "initialize", request_id=2)
        again = self.drain(buf)
        self.assertFalse(any(frame.get("method") == "transport/abandoned" for frame in again))
        self.assertTrue(any(frame.get("id") == 2 and "result" in frame for frame in again))
        server.frames.notification("session/event", {
            "sessionId": "cd" * 16, "event": {"seq": 1, "type": "assistant.text"}})
        self.assertEqual(self.drain(buf), [])


if __name__ == "__main__":
    unittest.main()
