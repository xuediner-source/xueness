"""Focused lifecycle checks for the plugin-owned pi-lite process boundary."""
import sys
import tempfile
import unittest
from pathlib import Path

from xueness.bundled_plugins.runtimes.pi_sidecar import (
    PiLiteSidecarSupervisor,
    SidecarProtocolError,
    start_local_provider,
)
from xueness.bundled_plugins.runtimes.runtime import save_selection


def _worker_script(body):
    return (
        "import json,sys,time\n"
        "for raw in sys.stdin.buffer:\n"
        " r=json.loads(raw)\n"
        + body
    )


class PiLiteSidecarTests(unittest.TestCase):
    def _supervisor(self, temp):
        state = Path(temp)
        save_selection(state, "pi-lite")
        return PiLiteSidecarSupervisor(state)

    def _request(self, rid="r1"):
        return {"version": 1, "requestId": rid, "sessionId": "s1",
                "method": "turn/start", "payload": {}}

    def test_strict_jsonl_round_trip_and_bounded_process_cleanup(self):
        script = _worker_script(
            " base={'version':1,'requestId':r['requestId'],'sessionId':r['sessionId'],"
            "'method':r['method'],'ok':True}\n"
            " print(json.dumps({**base,'payload':{'type':'text-delta','text':'hi'}},separators=(',',':')),flush=True)\n"
            " print(json.dumps({**base,'payload':{'type':'result','value':'ok'}},separators=(',',':')),flush=True)\n"
        )
        with tempfile.TemporaryDirectory() as temp:
            supervisor = self._supervisor(temp)
            sidecar = supervisor.start("demo", [sys.executable, "-u", "-c", script])
            frames = []
            final = sidecar.request_stream(self._request(), frames.append)
            self.assertEqual(len(frames), 2)
            self.assertEqual(final["payload"]["value"], "ok")
            stopped = supervisor.stop("demo")
            self.assertEqual(stopped["status"], "stopped")
            self.assertFalse(sidecar.status()["status"] == "running")

    def test_malformed_child_output_fails_closed(self):
        script = _worker_script(" sys.stdout.write('{}\\n'); sys.stdout.flush()\n")
        with tempfile.TemporaryDirectory() as temp:
            supervisor = self._supervisor(temp)
            sidecar = supervisor.start("bad", [sys.executable, "-u", "-c", script])
            with self.assertRaises(SidecarProtocolError):
                sidecar.request(self._request(), timeout=2)
            supervisor.close_all()

    def test_bundled_worker_command_is_available_without_remote_provider_call(self):
        with tempfile.TemporaryDirectory() as temp:
            supervisor = self._supervisor(temp)
            sidecar = start_local_provider(supervisor, "provider")
            response = sidecar.request(self._request(), timeout=2)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "runtime.providerFailure")
            self.assertIn("provider", response["error"]["message"])
            supervisor.close_all()


if __name__ == "__main__":
    unittest.main()
