"""Real Store changes, resume/gap recovery, bounded history and revocation."""
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from xueness import plugin_runtime
from xueness.bundled_plugins.runtimes.zcode_v4 import V4Adapter


class RuntimeLiveProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.adapter = V4Adapter(Path(self.temp.name))
        self.session = self.adapter.store.new("first request", Path(self.temp.name))
        self.sid = self.session["id"]

    def tearDown(self):
        self.temp.cleanup()

    def test_long_poll_waits_for_store_changes_and_revocation_ends_it(self):
        ack, first = self.adapter.subscribe({"topic": "conversation/" + self.sid})
        params = {"topic": "conversation/" + self.sid, "base": {"logEpoch": ack["logEpoch"], "seq": first["toSeq"]}}
        result, failures = [], []
        def wait():
            try:
                result.append(self.adapter.subscribe(params, wait_ms=4000))
            except Exception as error:
                failures.append(error)
        worker = threading.Thread(target=wait)
        worker.start()
        time.sleep(.3)
        self.assertTrue(worker.is_alive())
        self.session["streaming"] = {"id": "stream", "status": "streaming", "text": "actual increment"}
        self.session["status"] = "running"
        self.adapter.store.save(self.session)
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(result[0][0]["mode"], "resume")
        deltas = result[0][1]["payload"]["deltas"]
        self.assertTrue(any(delta.get("row", {}).get("text") == "actual increment" for delta in deltas))
        params["base"]["seq"] = result[0][1]["toSeq"]
        worker = threading.Thread(target=wait)
        worker.start()
        time.sleep(.3)
        plugin_runtime.set_enabled(Path(self.temp.name), "runtimes", False)
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertIsInstance(failures[-1], plugin_runtime.PluginDisabled)

    def test_window_page_revision_gap_and_structural_rebase(self):
        for index in range(90):
            self.session["messages"].append({"role": "user" if index % 2 == 0 else "assistant", "content": str(index)})
        self.adapter.store.save(self.session)
        ack, first = self.adapter.subscribe({"topic": "conversation/" + self.sid})
        snapshot = first["payload"]["snapshot"]
        window = snapshot["meta"]["window"]
        self.assertEqual(len(snapshot["rows"]["window"]), 60)
        self.assertTrue(window["hasOlder"])
        page = self.adapter.conversation_page({"sessionId": self.sid, "before": window["start"],
                                               "messageRevision": window["messageRevision"]})
        self.assertEqual(page["meta"]["window"]["start"], 0)
        self.assertEqual(page["rows"]["window"][0]["text"], "first request")
        self.session["messages"] = self.session["messages"][:4]
        self.adapter.store.save(self.session)
        with self.assertRaisesRegex(ValueError, "conversation changed"):
            self.adapter.conversation_page({"sessionId": self.sid, "before": window["start"],
                                           "messageRevision": window["messageRevision"]})
        rebased, response = self.adapter.subscribe({"topic": "conversation/" + self.sid,
            "base": {"logEpoch": ack["logEpoch"], "seq": first["toSeq"]}})
        self.assertEqual(rebased["mode"], "snapshot")
        self.assertNotEqual(rebased["logEpoch"], ack["logEpoch"])
        gap, _ = self.adapter.subscribe({"topic": "conversation/" + self.sid,
            "base": {"logEpoch": rebased["logEpoch"], "seq": response["toSeq"] + 1}})
        self.assertEqual(gap["mode"], "snapshot")

    def test_large_stream_logs_rebase_when_byte_retention_is_exceeded(self):
        ack, first = self.adapter.subscribe({"topic": "conversation/" + self.sid})
        self.session["streaming"] = {"id": "stream", "text": "received " * 600, "status": "streaming"}
        self.session["status"] = "running"
        self.adapter.store.save(self.session)
        with patch("xueness.bundled_plugins.runtimes.zcode_v4.MAX_LOG_BYTES", 1024):
            self.adapter.subscribe({"topic": "conversation/" + self.sid})
        saved = self.adapter._read()["sessions"][self.sid]
        self.assertLess(sum(len(str(event)) for event in saved["events"]), 1024)
        self.assertNotIn("received", str(saved["projection"]))
        resumed, frame = self.adapter.subscribe({"topic": "conversation/" + self.sid,
            "base": {"logEpoch": ack["logEpoch"], "seq": first["toSeq"]}})
        self.assertEqual(resumed["mode"], "snapshot")
        self.assertTrue(any(row.get("text") == self.session["streaming"]["text"]
                            for row in frame["payload"]["snapshot"]["rows"]["window"]))


if __name__ == "__main__":
    unittest.main()
