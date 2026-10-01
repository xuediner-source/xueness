"""Exercise feature-owned HTTP routes through the real ``python -m`` entrypoint.

``xueness.web`` has a separate ``__main__`` module identity when launched with
``-m``. These requests cover plugins that return the host's handled-response
sentinel, including the completed model-delta SSE path, so an import-only test
cannot hide a split host contract.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from xueness.core import Store


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class WebModuleStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state_dir = base / "state"
        self.web_runs = base / "web_runs"
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "fixture.txt").write_text("fixture file contents", encoding="utf-8")

        self.sid = uuid.uuid4().hex
        self.stream_id = uuid.uuid4().hex
        session = {
            "id": self.sid,
            "task": "Completed startup fixture",
            "root": str(self.workspace),
            "status": "completed",
            "steps": 1,
            "mode": "build",
            "messages": [
                {"role": "system", "content": "fixture system"},
                {"role": "user", "content": "Read fixture.txt"},
                {"role": "assistant", "content": "The fixture file is available."},
            ],
            "results": {},
            "compactions": [],
            "archived_messages": [],
            "completion": {
                "verified": True,
                "summary": "The fixture file is available.",
                "evidence": [],
            },
            "todos": [],
            "pending_question": None,
            "stream_history": [{
                "id": self.stream_id,
                "text": "Completed fixture delta.",
                "status": "completed",
                "truncated": False,
            }],
        }
        Store(self.state_dir).save(session)

        self.port = _available_port()
        environment = os.environ.copy()
        environment["XUENESS_ALLOW_REAL"] = "0"
        environment["PYTHONUNBUFFERED"] = "1"
        command = [
            sys.executable, "-m", "xueness.web",
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "--state", str(self.state_dir),
            "--web-runs", str(self.web_runs),
            "--workspace-root", str(self.workspace),
        ]
        self.process = subprocess.Popen(
            command,
            cwd=REPOSITORY_ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.process_output = ("", "")
        self.addCleanup(self._stop_server)
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._wait_until_ready()

    def _stop_server(self):
        process = getattr(self, "process", None)
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
        try:
            self.process_output = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            self.process_output = process.communicate(timeout=5)

    def _wait_until_ready(self):
        deadline = time.monotonic() + 10
        last_error = None
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                stdout, stderr = self.process.communicate()
                self.process_output = (stdout, stderr)
                self.fail(f"web module exited during startup: {stderr or stdout}")
            try:
                status, body, _ = self._get("/api/health")
                if status == 200 and json.loads(body).get("service") == "xueness-web":
                    return
            except (OSError, urllib.error.URLError, ValueError) as exc:
                last_error = exc
                time.sleep(0.05)
        self.fail(f"web module did not become ready: {last_error!r}")

    def _get(self, path, headers=None):
        request = urllib.request.Request(self.base_url + path, headers=headers or {})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.read().decode("utf-8"), dict(response.headers)

    def test_plugin_routes_work_through_module_entrypoint_and_completed_delta_sse(self):
        try:
            status, body, _ = self._get("/api/sessions")
            self.assertEqual(status, 200, body)
            listed = json.loads(body)["sessions"]
            self.assertTrue(any(item["id"] == self.sid for item in listed))

            status, body, _ = self._get(f"/api/sessions/{self.sid}")
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)["status"], "completed")

            status, body, _ = self._get(f"/api/sessions/{self.sid}/files")
            self.assertEqual(status, 200, body)
            files = json.loads(body)["files"]
            self.assertIn("fixture.txt", [item["path"] for item in files])

            status, body, _ = self._get(
                f"/api/sessions/{self.sid}/file?{urllib.parse.urlencode({'path': 'fixture.txt'})}"
            )
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)["text"], "fixture file contents")

            status, body, _ = self._get(f"/api/sessions/{self.sid}/events")
            self.assertEqual(status, 200, body)
            events = json.loads(body)["events"]
            self.assertTrue(any(item["type"] == "assistant" for item in events))

            delta_query = urllib.parse.urlencode({"stream_id": self.stream_id, "cursor": 0})
            status, body, headers = self._get(
                f"/api/sessions/{self.sid}/deltas?{delta_query}",
                {"Accept": "text/event-stream"},
            )
            self.assertEqual(status, 200, body)
            self.assertIn("text/event-stream", headers.get("Content-Type", ""))
            self.assertIn("event: model.delta", body)
            self.assertIn("Completed fixture delta.", body)
        finally:
            self._stop_server()

        stderr = self.process_output[1]
        self.assertNotIn("cannot unpack non-iterable object object", stderr)
        self.assertNotIn("TypeError: cannot unpack", stderr)


if __name__ == "__main__":
    unittest.main()
