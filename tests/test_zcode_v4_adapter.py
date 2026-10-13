"""Focused contract tests for the runtimes-owned ZCode v4 adapter."""
import tempfile
import unittest
from pathlib import Path

from xueness.bundled_plugins.runtimes.zcode_v4 import (
    V4Adapter,
    V4_WIRE_PROTOCOL_VERSION,
)
from xueness.bundled_plugins.runtimes import plugin


class ZCodeV4AdapterTests(unittest.TestCase):
    def make(self):
        self.temp = tempfile.TemporaryDirectory()
        return V4Adapter(Path(self.temp.name), require_plugin=False)

    def tearDown(self):
        if hasattr(self, "temp"):
            self.temp.cleanup()

    def create_session(self, adapter):
        return adapter.command({
            "commandId": "create-1", "clientId": "desktop-1", "sessionId": None,
            "type": "createSession", "issuedAt": 1,
            "payload": {"workspaceId": "workspace-1", "firstInput": {"text": "hello"}},
        })

    def test_hello_uses_v4_wire_version_and_trusted_delivery_profile(self):
        adapter = self.make()
        hello = adapter.hello({"kind": "clientHello", "protocolVersion": 3,
                               "clientId": "desktop-1", "clientKind": "desktop",
                               "appVersion": "test"})
        self.assertEqual(hello["protocolVersion"], V4_WIRE_PROTOCOL_VERSION)
        self.assertEqual(hello["clientMode"], "desktop-continuous")
        self.assertEqual(hello["deliveryProfile"], "continuous")

    def test_subscribe_snapshot_then_resume_delta_after_send(self):
        adapter = self.make()
        created = self.create_session(adapter)
        sid = created["result"]["sessionId"]
        ack, frame = adapter.subscribe({"topic": "conversation/" + sid})
        self.assertEqual(ack["mode"], "snapshot")
        snapshot = frame["payload"]["snapshot"]
        self.assertEqual(snapshot["protocolVersion"], 1)
        send = adapter.command({"commandId": "send-1", "clientId": "desktop-1",
                                "sessionId": sid, "type": "sendText", "issuedAt": 2,
                                "payload": {"text": "next"}})
        self.assertEqual(send["status"], "accepted")
        resumed, delta_frame = adapter.subscribe({
            "topic": "conversation/" + sid,
            "base": {"logEpoch": ack["logEpoch"], "seq": snapshot["seq"]},
        })
        self.assertEqual(resumed["mode"], "resume")
        self.assertTrue(delta_frame["payload"]["deltas"])
        self.assertEqual(delta_frame["payload"]["deltas"][-1]["op"], "state.updated")

    def test_cas_stale_and_command_idempotency(self):
        adapter = self.make()
        created = self.create_session(adapter)
        sid = created["result"]["sessionId"]
        stale = adapter.command({"commandId": "fork-1", "clientId": "desktop-1",
                                 "sessionId": sid, "type": "forkAssistant", "issuedAt": 2,
                                 "baseRevision": 0, "baseLogEpoch": "wrong",
                                 "payload": {"target": {"rowId": 0, "entityId": "x"}}})
        self.assertEqual(stale["status"], "stale")
        first = adapter.command({"commandId": "send-2", "clientId": "desktop-1",
                                 "sessionId": sid, "type": "sendText", "issuedAt": 3,
                                 "payload": {"text": "one"}})
        again = adapter.command({"commandId": "send-2", "clientId": "desktop-1",
                                 "sessionId": sid, "type": "sendText", "issuedAt": 4,
                                 "payload": {"text": "one"}})
        self.assertEqual(first, again)

    def test_unsupported_or_unsafe_commands_are_rejected(self):
        adapter = self.make()
        created = self.create_session(adapter)
        sid = created["result"]["sessionId"]
        session = adapter._read()["sessions"][sid]
        fork = adapter.command({"commandId": "fork-2", "clientId": "desktop-1",
                                "sessionId": sid, "type": "forkAssistant", "issuedAt": 2,
                                "baseRevision": session["revision"], "baseLogEpoch": session["logEpoch"],
                                "payload": {"target": {"rowId": 0, "entityId": "x"}}})
        self.assertEqual(fork["status"], "rejected")
        self.assertEqual(fork["reasonCode"], "fault.forkUnavailable")
        stopped = adapter.command({"commandId": "stop-1", "clientId": "desktop-1",
                                   "sessionId": sid, "type": "stop", "issuedAt": 3,
                                   "payload": {}})
        self.assertEqual(stopped["status"], "rejected")
        self.assertEqual(stopped["reasonCode"], "guard.notStoppable")
        resumed = adapter.command({"commandId": "resume-1", "clientId": "desktop-1",
                                   "sessionId": sid, "type": "resumeWorkflowRun", "issuedAt": 4,
                                   "payload": {"workId": "work-1"}})
        self.assertEqual(resumed["status"], "rejected")
        self.assertEqual(resumed["reasonCode"], "proto.unsupportedCommand")

    def test_plugin_dispatch_owns_v4_route_and_state_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            ctx = {"state_dir": Path(temp)}
            hello = plugin.dispatch("POST", ["api", "runtimes", "v4"], {}, {
                "kind": "clientHello", "protocolVersion": 3,
                "clientId": "desktop-1", "appVersion": "test",
            }, ctx)
            self.assertEqual(hello[0], 200)
            self.assertEqual(hello[1]["protocolVersion"], 3)


if __name__ == "__main__":
    unittest.main()
