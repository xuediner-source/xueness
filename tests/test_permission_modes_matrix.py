"""四种权限模式的关键格子：工具类别、继承与 CLI 参数。

不调用真实模型，也不放宽内核 plan 天花。远程执行只检查主体形状，不发起 SSH。
"""
import argparse
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from xueness.bundled_plugins.remote import app_server
from xueness.bundled_plugins.sessions.cli import add_agent_flags, prepare_agent
from xueness.bundled_plugins.sessions.plan_mode import (
    PERMISSION_MODES, draft_policy, is_remote_exec_subject, permission_mode_error,
)
from xueness.bundled_plugins.subagents.runner import run_subagent
from xueness.bundled_plugins.workflows import expert, workflows as workflow_impl
from xueness.cli import main as cli_main
from xueness.core import Gate, Store, execute
from xueness.tool_contract import PlanModeDenied
from xueness.web import WebGate


REMOTE_SUBJECT = json.dumps({
    "connection": "host-a",
    "connection_digest": "abc",
    "argv": ["echo", "remote"],
})
LOCAL_EXEC = json.dumps(["echo", "local"])
BROWSER_SUBJECT = json.dumps({"action": "navigate", "url": "https://example.test"})


def _allows(gate, kind, subject):
    gate.check(kind, subject, "call-1")


def _denies(testcase, gate, kind, subject, *, plan_policy=False):
    with testcase.assertRaises(PlanModeDenied if plan_policy else PermissionError) as caught:
        gate.check(kind, subject, "call-1")
    if not plan_policy:
        testcase.assertNotIsInstance(caught.exception, PlanModeDenied)
    return str(caught.exception)


class PermissionModeMatrixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "workspace"
        self.root.mkdir()
        self.state = Path(self.temp.name) / "state"
        (self.root / "a.txt").write_text("hello", encoding="utf-8")
        self.session_id = "a" * 32

    def web_gate(self, permission_mode, kernel="build"):
        draft = draft_policy(self.state, self.session_id) if permission_mode == "plan" else None
        return WebGate(self.root, self.session_id, {}, threading.Lock(), mode=kernel,
                       session={"id": self.session_id}, permission_mode=permission_mode,
                       plan_draft=draft)

    def core_gate(self, permission_mode, kernel="build", **kwargs):
        draft = draft_policy(self.state, self.session_id) if permission_mode == "plan" else None
        return Gate(self.root, mode=kernel, permission_mode=permission_mode,
                    plan_draft=draft, hold_remote_exec=permission_mode == "yolo", **kwargs)

    def test_vocabulary_has_one_source(self):
        self.assertEqual(PERMISSION_MODES, ("build", "edit", "yolo", "plan"))
        self.assertIs(app_server._PERMISSION_MODES, PERMISSION_MODES)
        self.assertEqual(permission_mode_error(),
                         "permission_mode must be 'build', 'edit', 'yolo', or 'plan'")
        self.assertIn("permission_mode", permission_mode_error())
        with self.assertRaises(ValueError):
            WebGate(self.root, self.session_id, {}, threading.Lock(), permission_mode="sideways")
        with self.assertRaises(ValueError):
            Gate(self.root, permission_mode="sideways")

    def test_each_mode_by_tool_category(self):
        categories = (
            ("read", "read", "a.txt"),
            ("grep", "grep", "."),
            ("write", "write", "a.txt"),
            ("edit", "edit", "a.txt"),
            ("exec", "exec", LOCAL_EXEC),
            ("remote_exec", "exec", REMOTE_SUBJECT),
            ("mcp", "mcp", "server.tool"),
            ("web_fetch", "web_fetch", "https://example.test"),
            ("web_search", "web_search", "query"),
            ("browser", "exec", BROWSER_SUBJECT),
        )
        expect = {
            "build": {"read": "allow", "grep": "allow", "write": "ask", "edit": "ask",
                      "exec": "ask", "remote_exec": "ask", "mcp": "ask",
                      "web_fetch": "ask", "web_search": "ask", "browser": "ask"},
            "edit": {"read": "allow", "grep": "allow", "write": "allow", "edit": "allow",
                     "exec": "ask", "remote_exec": "ask", "mcp": "ask",
                     "web_fetch": "ask", "web_search": "ask", "browser": "ask"},
            "yolo": {"read": "allow", "grep": "allow", "write": "allow", "edit": "allow",
                     "exec": "allow", "remote_exec": "ask", "mcp": "allow",
                     "web_fetch": "allow", "web_search": "allow", "browser": "allow"},
            "plan": {"read": "allow", "grep": "allow", "write": "deny", "edit": "deny",
                     "exec": "deny", "remote_exec": "deny", "mcp": "deny",
                     "web_fetch": "deny", "web_search": "deny", "browser": "deny"},
        }
        for permission_mode in PERMISSION_MODES:
            for label, kind, subject in categories:
                decision = expect[permission_mode][label]
                for gate in (self.web_gate(permission_mode), self.core_gate(permission_mode)):
                    with self.subTest(mode=permission_mode, tool=label, gate=type(gate).__name__):
                        if decision == "allow":
                            _allows(gate, kind, subject)
                        else:
                            text = _denies(self, gate, kind, subject,
                                           plan_policy=permission_mode == "plan")
                            if permission_mode != "plan":
                                self.assertIn("approval", text)

    def test_plan_draft_is_the_only_write_and_kernel_plan_still_wins(self):
        draft = draft_policy(self.state, self.session_id).path
        for factory in (self.web_gate, self.core_gate):
            gate = factory("plan")
            with self.subTest(gate=type(gate).__name__, case="draft"):
                _allows(gate, "write", str(draft))
                written = execute(self.root, gate, "write",
                                  {"path": str(draft), "content": "# 计划\n"})
                self.assertTrue(written["ok"], written)
                self.assertEqual(draft.read_text(encoding="utf-8"), "# 计划\n")
            for mode in ("build", "edit", "yolo"):
                with self.subTest(gate=type(factory("build")).__name__, mode=mode):
                    other = factory(mode)
                    self.assertFalse(execute(self.root, other, "write",
                                             {"path": str(draft), "content": "x"})["ok"])
            legacy = factory("plan", kernel="plan")
            with self.subTest(gate=type(legacy).__name__, case="kernel-draft"):
                text = _denies(self, legacy, "write", str(draft), plan_policy=False)
                self.assertIn("plan mode", text)
            lifted = factory("yolo", kernel="plan")
            with self.subTest(gate=type(lifted).__name__, case="kernel-yolo"):
                self.assertIn("plan mode", _denies(self, lifted, "write", "a.txt"))

    def test_legacy_allow_exec_still_permits_remote_until_yolo_holds_it(self):
        self.assertTrue(is_remote_exec_subject(REMOTE_SUBJECT))
        self.assertFalse(is_remote_exec_subject(LOCAL_EXEC))
        self.assertFalse(is_remote_exec_subject(BROWSER_SUBJECT))
        opened = Gate(self.root, allow_exec=True)
        _allows(opened, "exec", REMOTE_SUBJECT)
        held = Gate(self.root, allow_exec=True, permission_mode="yolo", hold_remote_exec=True)
        self.assertIn("approval", _denies(self, held, "exec", REMOTE_SUBJECT))
        _allows(held, "exec", LOCAL_EXEC)

    def test_subagent_stays_read_only_when_parent_is_yolo(self):
        parent = Gate(self.root, allow_write=True, allow_exec=True,
                      permission_mode="yolo", hold_remote_exec=True)
        captured = {}

        def run_fn(child, store, provider, gate, **kwargs):
            del store, provider, kwargs
            captured["child"] = child
            captured["gate"] = gate
            child["status"] = "completed"
            child["completion"] = {"summary": "read only"}
            return child

        result = run_subagent(
            parent, object(), [], "inspect", None, depth=0, max_depth=1,
            state_dir=self.state, gate_class=Gate, run_fn=run_fn, base_system="base",
            max_steps=2, summary_max=100,
        )
        self.assertTrue(result["ok"], result)
        child_gate = captured["gate"]
        self.assertEqual(captured["child"]["permission_mode"], "plan")
        self.assertEqual(child_gate.mode, "plan")
        self.assertEqual(child_gate.permission_mode, "plan")
        self.assertTrue(child_gate.hold_remote_exec)
        self.assertFalse(child_gate.allow_write)
        self.assertIsNone(child_gate.plan_draft)
        self.assertIn("plan mode", _denies(self, child_gate, "write", "a.txt"))
        self.assertIn("plan mode", _denies(self, child_gate, "exec", REMOTE_SUBJECT))

    def _owned(self, permission_mode, kernel_mode="build", *, nodes):
        sessions = Store(self.state)
        session = sessions.new("owner", self.root)
        session["permission_mode"] = permission_mode
        session["mode"] = kernel_mode
        sessions.save(session)
        record = workflow_impl.WorkflowStore(self.state).create(
            {"nodes": nodes}, self.root, owner_session=session["id"])
        return session, record

    def test_workflow_children_inherit_a_plan_ceiling(self):
        marker = self.root / "pwned"
        command = {"id": "cmd", "kind": "command",
                   "argv": [sys.executable, "-c",
                            "from pathlib import Path; Path('pwned').write_text('x')"]}
        session, record = self._owned("plan", nodes=[command])
        result = workflow_impl._execute(workflow_impl.WorkflowStore(self.state), record,
                                        record["plan"]["nodes"][0])
        self.assertEqual(result["status"], "failed")
        self.assertIn("plan", result["error"])
        self.assertFalse(marker.exists())

        missing = workflow_impl.WorkflowStore(self.state).create(
            {"nodes": [command]}, self.root, owner_session="b" * 32)
        refused = workflow_impl._execute(workflow_impl.WorkflowStore(self.state), missing,
                                         missing["plan"]["nodes"][0])
        self.assertEqual(refused["status"], "failed")
        self.assertFalse(marker.exists())

        session["permission_mode"] = "nope"
        Store(self.state).save(session)
        invalid = workflow_impl.WorkflowStore(self.state).create(
            {"nodes": [command]}, self.root, owner_session=session["id"])
        self.assertEqual(workflow_impl._execute(
            workflow_impl.WorkflowStore(self.state), invalid, invalid["plan"]["nodes"][0])["status"],
            "failed")

        yolo_session, yolo_record = self._owned("yolo", kernel_mode="plan", nodes=[command])
        del yolo_session
        self.assertEqual(workflow_impl._execute(
            workflow_impl.WorkflowStore(self.state), yolo_record,
            yolo_record["plan"]["nodes"][0])["status"], "failed")
        self.assertFalse(marker.exists())

        captured = []

        def fake_run(session, store, provider, gate, **kwargs):
            del store, provider, kwargs
            captured.append(gate)
            session["status"] = "completed"
            session["completion"] = {"summary": "noted"}
            return session

        agent = {"id": "act", "kind": "agent", "prompt": "change the workspace", "writable": True}
        _, writable = self._owned("yolo", nodes=[agent])
        _, capped = self._owned("plan", nodes=[agent])
        with patch("xueness.provider_config.resolve", return_value=type("P", (), {"model": "fixture"})()), \
             patch("xueness.core.run", side_effect=fake_run):
            workflow_impl._execute(workflow_impl.WorkflowStore(self.state), writable,
                                   writable["plan"]["nodes"][0])
            workflow_impl._execute(workflow_impl.WorkflowStore(self.state), capped,
                                   capped["plan"]["nodes"][0])
        self.assertTrue(captured[0].allow_write)
        self.assertEqual(captured[0].mode, "build")
        self.assertFalse(captured[0].allow_exec)
        self.assertFalse(captured[1].allow_write)
        self.assertEqual(captured[1].mode, "plan")

    def test_session_bound_expert_stamps_owner_session(self):
        sessions = Store(self.state)
        session = sessions.new("chat", self.root)
        session["permission_mode"] = "edit"
        sessions.save(session)
        def fake_launch(self, wid, approved=False, allow_real=False, expected_digest=None):
            self.update(wid, lambda row: row.update(status="queued", control="run"))
            return self.load(wid)

        with patch.object(workflow_impl.WorkflowStore, "launch", new=fake_launch):
            record = expert.start(self.state, "修复登录", self.root, session_id=session["id"])
        workflow = workflow_impl.WorkflowStore(self.state).load(record["workflow"])
        self.assertEqual(workflow["owner_session"], session["id"])
        self.assertTrue(workflow["plan"]["nodes"][2]["writable"])

    def test_cli_permission_mode_flag_and_compat(self):
        parser = argparse.ArgumentParser()
        add_agent_flags(parser)
        names = {option for action in parser._actions for option in action.option_strings}
        self.assertIn("--permission-mode", names)
        self.assertIn("--allow-write", names)
        self.assertIn("--allow-exec", names)
        self.assertIn("--mode", names)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(["--permission-mode", "sideways"])

        def prepare(argv, session):
            args = parser.parse_args(argv)
            args.state = self.state
            with patch("xueness.provider_config.resolve", return_value=object()):
                _provider, gate, _names, _memory = prepare_agent(args, parser, Store(self.state), session)
            return args, gate

        fresh = {"root": str(self.root)}
        _args, plan_gate = prepare(["--permission-mode", "plan", "--allow-write", "--allow-exec"], fresh)
        self.assertEqual(plan_gate.permission_mode, "plan")
        self.assertEqual(plan_gate.mode, "build")
        self.assertIn("plan", _denies(self, plan_gate, "write", "a.txt", plan_policy=True).lower())
        _args, yolo_gate = prepare(["--permission-mode", "yolo", "--allow-exec"], fresh)
        _allows(yolo_gate, "write", "a.txt")
        _allows(yolo_gate, "exec", LOCAL_EXEC)
        self.assertIn("approval", _denies(self, yolo_gate, "exec", REMOTE_SUBJECT))
        _args, legacy = prepare(["--allow-exec"], fresh)
        self.assertIsNone(legacy.permission_mode)
        _allows(legacy, "exec", REMOTE_SUBJECT)
        saved = {"root": str(self.root), "permission_mode": "yolo", "mode": "build"}
        _args, not_inherited = prepare([], saved)
        self.assertIsNone(not_inherited.permission_mode)
        self.assertIn("approval", _denies(self, not_inherited, "write", "a.txt"))
        saved_plan = {"root": str(self.root), "id": self.session_id, "permission_mode": "plan", "mode": "build"}
        _args, inherited = prepare([], saved_plan)
        self.assertEqual(inherited.permission_mode, "plan")
        from xueness.bundled_plugins.sessions.cli import _bind_cli_plan_draft
        inherited_args = parser.parse_args([])
        inherited_args.state = self.state
        _bind_cli_plan_draft(inherited_args, inherited, saved_plan)
        draft = draft_policy(self.state, self.session_id).path
        _allows(inherited, "write", str(draft))
        ceiling_args, ceiling = prepare(["--permission-mode", "yolo", "--mode", "plan"], fresh)
        del ceiling_args
        self.assertIn("plan mode", _denies(self, ceiling, "write", "a.txt"))

    def _cli(self, argv):
        stderr, stdout = io.StringIO(), io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(stdout):
            try:
                code = cli_main(["--state", str(self.state), *argv])
            except SystemExit as exc:
                code = exc.code
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_run_persists_plan_and_does_not_apply_saved_yolo(self):
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)
        code, out, err = self._cli(["run", "--prompt", "create demo", "--root", str(self.root),
                                    "--permission-mode", "plan", "--allow-write",
                                    "--output-format", "json"])
        self.assertEqual(code, 2, err)
        summary = json.loads(out)
        saved = Store(self.state).load(summary["id"])
        self.assertEqual(saved["permission_mode"], "plan")
        self.assertEqual(saved["mode"], "build")
        self.assertFalse((self.root / "hello.txt").exists())
        self.assertTrue(saved.get("permission_mode_history"))

        yolo = Store(self.state).new("keep yolo", self.root)
        yolo["permission_mode"] = "yolo"
        Store(self.state).save(yolo)
        code, out, err = self._cli(["run", yolo["id"], "--output-format", "json"])
        self.assertEqual(code, 2, err)
        again = Store(self.state).load(yolo["id"])
        self.assertEqual(again["permission_mode"], "yolo")
        self.assertFalse((self.root / "hello.txt").exists())

        kernel = Store(self.state).new("kernel plan", self.root)
        kernel["mode"] = "plan"
        Store(self.state).save(kernel)
        code, out, err = self._cli(["run", kernel["id"], "--allow-write", "--output-format", "json"])
        self.assertEqual(code, 2, err)
        kept = Store(self.state).load(kernel["id"])
        self.assertEqual(kept["mode"], "plan")
        self.assertFalse((self.root / "hello.txt").exists())

    def test_composer_rejects_unknown_permission_mode_without_granting_it(self):
        from xueness import web
        from xueness.bundled_plugins.sessions import plugin as sessions_plugin
        runs = Path(self.temp.name) / "runs"
        ctx = web.build_context(self.state, runs, self.root, allow_real=True)
        ctx["workspace_roots"] = ()
        with patch.dict(os.environ, {
            "XUENESS_PROVIDER": "openai",
            "XUENESS_API_BASE": "https://api.example.test/v1",
            "XUENESS_MODEL": "gpt-4o",
            "XUENESS_API_KEY": "composer-test-secret",
            "ANTHROPIC_API_KEY": "",
        }):
            status, bad = sessions_plugin.dispatch(
                "POST", ["api", "composer", "prepare"], {},
                {"text": "Inspect this workspace", "permission_mode": "sideways"}, ctx)
            self.assertEqual(status, 400)
            self.assertIn("permission_mode", bad["error"])
            status, ok = sessions_plugin.dispatch(
                "POST", ["api", "composer", "prepare"], {},
                {"text": "Inspect this workspace", "permission_mode": "plan"}, ctx)
        self.assertEqual(status, 200, ok)
        self.assertNotIn("permission_mode", ok)


if __name__ == "__main__":
    unittest.main()
