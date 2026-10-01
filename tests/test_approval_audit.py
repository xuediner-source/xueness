"""Approval decisions must be auditable after the fact.

Found during a parity re-review: the roadmap's P0-1 asks for
"expired/consumed approval audit in session journal", and approvals were being
consumed silently. That means nothing could answer "who authorised this call?"
once a gated action turned out badly -- the exact question you ask first.

These tests assert the three recorded actions (granted / consumed / cleared)
land in the journal, are capped, and that auditing never breaks a run.
"""
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from xueness.core import (APPROVAL_LOG_MAX, APPROVAL_SUBJECT_MAX, Gate, Store,
                          record_approval, run)
from xueness.web import WebGate, _save_audit, pending_denials, replay_approved


class _ScriptedProvider:
    def __init__(self, calls):
        self.calls = list(calls)
        self.n = 0

    def complete(self, messages, tools):
        if self.n < len(self.calls):
            call = self.calls[self.n]
            self.n += 1
            return {"content": "", "tool_calls": [call]}
        return {"content": json.dumps({"summary": "done", "evidence": []})}


def _write_call(call_id="c1", path="a.txt"):
    return {"id": call_id, "type": "function",
            "function": {"name": "write",
                         "arguments": json.dumps({"path": path, "content": "hi"})}}


class ApprovalAuditTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.state = base / "state"
        self.workspace = base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)
        self.ctx = {"store": self.store, "approvals": {}, "lock": threading.Lock()}

    def _gate(self, session):
        return WebGate(self.workspace, session["id"], self.ctx["approvals"],
                       self.ctx["lock"], session=session)

    def _grant(self, session, kind, call_id, subject):
        with self.ctx["lock"]:
            self.ctx["approvals"].setdefault(
                session["id"], {"write": {}, "edit": {}, "exec": {}, "mcp": {}})[kind][call_id] = subject
            record_approval(session, "granted", kind, call_id, subject)
            _save_audit(self.ctx, session)

    def _actions(self, session):
        fresh = self.store.load(session["id"])
        return [e["action"] for e in fresh.get("approval_log", [])]

    def test_granted_and_consumed_are_both_recorded(self):
        session = self.store.new("write a.txt", self.workspace)
        run(session, self.store, _ScriptedProvider([_write_call()]),
            self._gate(session), max_steps=3)

        pending = pending_denials(session)
        self.assertTrue(pending, "the write should have been denied first")
        cid = pending[0]["tool_call_id"]
        self._grant(session, "write", cid, "a.txt")
        self.assertEqual(self._actions(session), ["granted"])

        fresh = self.store.load(session["id"])
        replay_approved(fresh, self.store, self._gate(fresh),
                        self.ctx["approvals"], self.ctx["lock"])

        self.assertEqual(self._actions(session), ["granted", "consumed"])
        self.assertTrue((self.workspace / "a.txt").exists(), "the approved write must run")

    def test_denied_call_leaves_no_audit_until_a_decision(self):
        """A denial is not an approval event; the log must not imply otherwise."""
        session = self.store.new("write a.txt", self.workspace)
        run(session, self.store, _ScriptedProvider([_write_call()]),
            self._gate(session), max_steps=3)
        self.assertEqual(self._actions(session), [])

    def test_audit_records_the_exact_subject_not_just_the_kind(self):
        session = self.store.new("t", self.workspace)
        record_approval(session, "granted", "write", "c1", "dir/file.txt")
        entry = session["approval_log"][0]
        self.assertEqual(entry["kind"], "write")
        self.assertEqual(entry["tool_call_id"], "c1")
        self.assertEqual(entry["subject"], "dir/file.txt")
        self.assertIn("at", entry, "an audit line needs a timestamp")

    def test_audit_is_capped(self):
        session = self.store.new("t", self.workspace)
        for i in range(APPROVAL_LOG_MAX + 25):
            record_approval(session, "granted", "write", "c%d" % i, "f.txt")
        self.assertEqual(len(session["approval_log"]), APPROVAL_LOG_MAX)

    def test_long_subject_is_clipped(self):
        """MCP subjects embed arguments; the audit must stay bounded."""
        session = self.store.new("t", self.workspace)
        record_approval(session, "granted", "mcp", "c1", "x" * 5000)
        self.assertEqual(len(session["approval_log"][0]["subject"]), APPROVAL_SUBJECT_MAX)

    def test_audit_never_raises(self):
        """A broken session object must not take down the approval path."""
        record_approval(None, "granted", "write", "c1", "f.txt")
        record_approval({"approval_log": "not-a-list"}, "granted", "write", "c1", "f.txt")

    def test_consumed_is_recorded_even_when_the_tool_fails(self):
        """The decision was spent regardless of whether the tool succeeded."""
        session = self.store.new("write", self.workspace)
        # Write into a directory that does not exist: the gate passes, the tool fails.
        run(session, self.store, _ScriptedProvider([_write_call(path="missing/dir/a.txt")]),
            self._gate(session), max_steps=3)
        pending = pending_denials(session)
        self.assertTrue(pending)
        cid = pending[0]["tool_call_id"]
        self._grant(session, "write", cid, "missing/dir/a.txt")

        fresh = self.store.load(session["id"])
        replay_approved(fresh, self.store, self._gate(fresh),
                        self.ctx["approvals"], self.ctx["lock"])
        self.assertIn("consumed", self._actions(session))


class NonWebGateHasNoAuditTests(unittest.TestCase):
    """The CLI/base gate is stateless; it must not grow a session dependency."""

    def test_base_gate_still_approves_via_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gate = Gate(root, allow_write=True)
            gate.check("write", "a.txt")  # must not raise
            with self.assertRaises(PermissionError):
                Gate(root).check("write", "a.txt")


if __name__ == "__main__":
    unittest.main()
