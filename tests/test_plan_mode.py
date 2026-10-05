"""``plan`` 权限模式回归（sessions.plan_mode）。

覆盖：计划模式下读取/搜索照常，写、编辑、执行与联网工具一律拒绝并带回双语
说明；唯一例外是本会话在状态目录里的计划草稿文件；模式切换沿用
``permission_mode_history`` 审计；HTTP 继续拒绝非法值，且 sessions 关闭时
``plan`` 不可用。全部使用临时状态目录与内建 fixture，不触达真实模型。
"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import web
from xueness.core import execute
from xueness.bundled_plugins.sessions.plan_mode import draft_policy, is_permission_mode
from xueness.plugin_runtime import set_enabled
from tests.fake_provider_fixture import inject_provider

SID = "a" * 32
OTHER_SID = "b" * 32
CSRF = "test-csrf-token"


def _start(ctx):
    server = web.create_server(0, ctx)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class PlanModeGateTests(unittest.TestCase):
    """直接对 Gate 与工具分发下判定，不经过 HTTP 与模型。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.state = base / "state"
        self.state.mkdir()
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "note.txt").write_text("hello", encoding="utf-8")
        self.lock = threading.Lock()

    def gate(self, permission_mode="plan", session_id=SID, **kwargs):
        return web.WebGate(self.workspace, session_id, {}, self.lock,
                           permission_mode=permission_mode,
                           plan_draft=draft_policy(self.state, session_id), **kwargs)

    def run_tool(self, name, args, gate=None):
        return execute(self.workspace, gate or self.gate(), name, args, {"id": SID})

    def test_plan_joins_the_accepted_permission_modes(self):
        for mode in ("build", "edit", "yolo", "plan"):
            with self.subTest(mode=mode):
                self.assertTrue(is_permission_mode(mode))
                self.assertEqual(self.gate(mode).permission_mode, mode)
        for value in ("nope", "PLAN", None, 1):
            with self.subTest(value=value):
                self.assertFalse(is_permission_mode(value))
        with self.assertRaises(ValueError):
            self.gate("nope")

    def test_reads_and_search_still_work(self):
        for name, args in (("read", {"path": "note.txt"}), ("grep", {"pattern": "hel"}),
                           ("list", {"path": "."}), ("glob", {"pattern": "*.txt"})):
            with self.subTest(tool=name):
                self.assertTrue(self.run_tool(name, args)["ok"])

    def test_mutating_tools_are_denied_with_bilingual_reason(self):
        cases = (("write", {"path": "note.txt", "content": "x"}),
                 ("edit", {"path": "note.txt", "old": "hello", "new": "bye"}),
                 ("exec", {"argv": ["echo", "ok"]}),
                 ("web_fetch", {"url": "https://example.test/"}))
        for name, args in cases:
            with self.subTest(tool=name):
                result = self.run_tool(name, args)
                self.assertFalse(result["ok"])
                # 仍然是既有 denied 协议，但带上新增的计划模式分类与提示。
                self.assertEqual(result["error"], "denied")
                self.assertEqual(result["error_code"], "plan_mode_denied")
                self.assertFalse(result["awaiting_approval"])
                self.assertIn("当前是计划模式（Plan mode）", result["user_reason"])
                self.assertIn("Plan mode is read-only", result["user_reason"])
        self.assertEqual((self.workspace / "note.txt").read_text(encoding="utf-8"), "hello")

    def test_denial_points_at_the_session_plan_draft(self):
        draft = draft_policy(self.state, SID).path
        result = self.run_tool("write", {"path": "plan.md", "content": "x"})
        self.assertIn(str(draft), result["user_reason"])
        self.assertEqual(result["plan_draft_path"], str(draft))

    def test_plan_draft_lives_in_state_dir_and_is_writable(self):
        draft = draft_policy(self.state, SID).path
        self.assertFalse(draft.is_relative_to(self.workspace.resolve()))
        self.assertEqual(draft.parent, (self.state / "plan-drafts").resolve())
        self.assertTrue(self.run_tool("write", {"path": str(draft), "content": "# 计划\n"})["ok"])
        self.assertEqual(draft.read_text(encoding="utf-8"), "# 计划\n")
        self.assertTrue(self.run_tool("edit", {"path": str(draft), "old": "# 计划",
                                               "new": "# 计划 v2"})["ok"])
        self.assertIn("# 计划 v2", draft.read_text(encoding="utf-8"))

    def test_only_the_own_session_draft_is_accepted(self):
        other = draft_policy(self.state, OTHER_SID).path
        for path in (str(other), str(self.state / "plan-drafts" / "evil.md"),
                     str(self.state / "plan-drafts" / ".." / ".." / "escape.md")):
            with self.subTest(path=path):
                self.assertFalse(self.run_tool("write", {"path": path, "content": "x"})["ok"])
                self.assertFalse(Path(path).exists())
        self.assertFalse(other.exists())
        self.assertFalse((self.state / "escape.md").exists())

    def test_draft_exception_exists_only_in_plan_mode(self):
        draft = draft_policy(self.state, SID).path
        for mode in ("build", "edit", "yolo"):
            with self.subTest(permission_mode=mode):
                self.assertFalse(self.run_tool("write", {"path": str(draft), "content": "x"},
                                               gate=self.gate(mode))["ok"])
        self.assertFalse(draft.exists())

    def test_disallowed_tools_and_legacy_plan_run_mode_still_win(self):
        draft = draft_policy(self.state, SID).path
        disallowed = self.gate(disallow=("write",))
        self.assertEqual(self.run_tool("write", {"path": str(draft), "content": "x"},
                                       gate=disallowed)["error"], "denied")
        legacy = self.gate(mode="plan")
        self.assertEqual(self.run_tool("write", {"path": str(draft), "content": "x"},
                                       gate=legacy)["error"], "denied")
        self.assertFalse(draft.exists())


class PlanModeHttpTests(unittest.TestCase):
    """权限模式来自 Web 运行请求：校验、审计与插件开关。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.project = base / "proj"
        self.project.mkdir()
        self.ctx = web.build_context(base / "state", base / "runs", self.project,
                                     allow_real=False, csrf=CSRF)
        self.server = _start(self.ctx)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _post(self, path, data):
        request = urllib.request.Request(
            self.base + path, data=json.dumps(data).encode(),
            headers={"X-CSRF-Token": CSRF, "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")

    def _session(self):
        return self.ctx["store"].new("plan then build", self.project)["id"]

    def _run(self, sid, **extra):
        def no_cost_run(session, store, provider, gate, steps, max_chars, **kwargs):
            session["observed_permission_mode"] = gate.permission_mode
            session["observed_plan_draft"] = str(gate.plan_draft.path) if gate.plan_draft else None
            session.update(status="completed", steps=1, mode="build",
                           completion={"verified": True, "summary": "ok"},
                           pending_question=None, todos=[], hook_log=[])
            store.save(session)
            return session

        with patch("xueness.web.run", side_effect=no_cost_run):
            with inject_provider(ctx=self.ctx):
                return self._post(f"/api/sessions/{sid}/run",
                                  {"provider": "real", "steps": 1, **extra})

    def _history(self, sid):
        session = self.ctx["store"].load(sid)
        return [(entry["from"], entry["to"])
                for entry in session.get("permission_mode_history", [])]

    def test_plan_then_build_switch_is_audited(self):
        sid = self._session()
        code, body = self._run(sid, permission_mode="plan")
        self.assertEqual(code, 200, body)
        saved = self.ctx["store"].load(sid)
        self.assertEqual(saved["permission_mode"], "plan")
        self.assertEqual(saved["observed_permission_mode"], "plan")
        self.assertEqual(saved["observed_plan_draft"],
                         str(draft_policy(self.ctx["state_dir"], sid).path))
        self.assertFalse(Path(saved["observed_plan_draft"]).is_relative_to(self.project.resolve()))
        self.assertEqual(self._history(sid), [("build", "plan")])

        code, body = self._run(sid, permission_mode="build")
        self.assertEqual(code, 200, body)
        self.assertEqual(self.ctx["store"].load(sid)["permission_mode"], "build")
        self.assertEqual(self._history(sid), [("build", "plan"), ("plan", "build")])

    def test_saved_plan_mode_reaches_the_gate_without_explicit_value(self):
        sid = self._session()
        self.assertEqual(self._run(sid, permission_mode="plan")[0], 200)
        code, body = self._run(sid)
        self.assertEqual(code, 200, body)
        saved = self.ctx["store"].load(sid)
        self.assertEqual(saved["observed_permission_mode"], "plan")
        self.assertEqual(self._history(sid), [("build", "plan")])

    def test_unknown_permission_mode_is_rejected(self):
        sid = self._session()
        for value in ("nope", "Plan", "auto", 1, True):
            with self.subTest(value=value):
                code, body = self._post(f"/api/sessions/{sid}/run",
                                        {"provider": "real", "steps": 1,
                                         "permission_mode": value})
                self.assertEqual(code, 400, body)
                self.assertIn("permission_mode", body)
        self.assertNotIn("permission_mode", self.ctx["store"].load(sid))
        self.assertEqual(self._history(sid), [])

    def test_invalid_saved_permission_mode_is_rejected(self):
        sid = self._session()
        session = self.ctx["store"].load(sid)
        session["permission_mode"] = "tiny"
        self.ctx["store"].save(session)
        code, body = self._run(sid)
        self.assertEqual(code, 400, body)
        self.assertIn("saved permission mode is invalid", body)

    def test_plan_needs_the_sessions_plugin(self):
        sid = self._session()
        set_enabled(self.ctx["state_dir"], "sessions", False)
        self.addCleanup(set_enabled, self.ctx["state_dir"], "sessions", True)
        code, body = self._post(f"/api/sessions/{sid}/run",
                                {"provider": "real", "steps": 1, "permission_mode": "plan"})
        self.assertEqual(code, 403, body)
        self.assertIn("sessions", body)
        self.assertNotIn("permission_mode", self.ctx["store"].load(sid))

    def test_plan_mode_denied_run_is_not_approvable(self):
        sid = self._session()
        self.assertEqual(self._run(sid, permission_mode="plan")[0], 200)
        session = self.ctx["store"].load(sid)
        session["messages"].append({"role": "assistant", "content": "", "tool_calls": [
            {"id": "write1", "type": "function", "function": {
                "name": "write",
                "arguments": json.dumps({"path": "note.txt", "content": "x"})}}]})
        session["results"]["write1"] = {"ok": False, "error": "denied",
                                        "error_code": "plan_mode_denied"}
        self.ctx["store"].save(session)
        self.assertEqual(web.pending_denials(session), [])


if __name__ == "__main__":
    unittest.main()
