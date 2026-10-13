"""Integration checks for the runtimes-to-sessions execution seam."""
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.remote import app_server
from xueness.bundled_plugins.runtimes.bridge import ExecutionBridge
from xueness.provider import FakeProvider


class RuntimeExecutionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.state = root / "state"
        self.ctx = app_server.build_app_context(
            self.state,
            web_runs=root / "runs",
            project_dir=root / "project",
            workspace_roots=[root],
            allow_real=True,
        )
        self.bridge = ExecutionBridge(self.ctx)

    def tearDown(self):
        registry = self.ctx.get("plugin_scopes")
        if registry is not None:
            registry.dispose()
        self.temp.cleanup()

    def test_create_and_append_use_the_real_store(self):
        status, body = self.bridge.create_session(
            "workspace-1", first_input={"text": "first request"}
        )
        self.assertEqual(status, 200)
        sid = body["id"]
        saved = self.ctx["store"].load(sid)
        self.assertEqual(saved["workspace_id"], "workspace-1")
        self.assertEqual(saved["messages"][1]["content"], "first request")

        status, body = self.bridge.append_message(sid, "follow up")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], sid)
        saved = self.ctx["store"].load(sid)
        self.assertEqual(saved["messages"][-1]["content"], "follow up")

    def test_async_run_and_stop_share_host_bookkeeping(self):
        status, body = self.bridge.create_session(
            "workspace-2", first_input={"text": "run this"}
        )
        self.assertEqual(status, 200)
        sid = body["id"]

        with patch("xueness.provider_config.resolve", return_value=FakeProvider()):
            status, accepted = self.bridge.start_run_async(sid)
            self.assertEqual(status, 202)
            self.assertEqual(accepted["sessionId"], sid)
            worker = self.bridge.worker(sid)
            self.assertIsNotNone(worker)
            worker.join(15)
            self.assertTrue(worker.done.is_set())
            self.assertIsNone(worker.failure)
            self.assertLess(worker.status, 500)

        saved = self.ctx["store"].load(sid)
        self.assertIn(saved["status"], {"completed", "needs_review", "paused", "stopped"})
        self.assertNotIn(sid, self.ctx["running"])

    def test_stop_sets_the_shared_stop_request_for_a_running_session(self):
        status, body = self.bridge.create_session(
            "workspace-3", first_input={"text": "long request"}
        )
        self.assertEqual(status, 200)
        sid = body["id"]
        self.ctx["running"].add(sid)
        try:
            status, result = self.bridge.stop(sid)
            self.assertEqual(status, 200)
            self.assertTrue(result["stopping"])
            self.assertIn(sid, self.ctx["stop_requested"])
        finally:
            self.ctx["running"].discard(sid)
            self.ctx["stop_requested"].discard(sid)


if __name__ == "__main__":
    unittest.main()
