"""Regression tests for the stagnation (loop) guard in ``xueness.core.run``.

The guard exists because a model that re-issues the *same* tool call with the
*same* arguments on consecutive steps is not making progress: it is looping, and
finishing the step budget on an unresolvable retry only spends money. When
``STALL_REPEAT_LIMIT`` identical steps occur back to back, the run settles as
``stalled`` and the repeated call is recorded as *not executed* rather than run
again.

These tests pin three behaviours that are easy to break silently when the loop
is refactored, plus two negative controls that keep the positive tests from
passing vacuously:

1. An ordinary repeated tool loop stalls exactly at the threshold, and the
   repeated call's side effect does NOT happen another time.
2. A repeated MCP call that is still awaiting a human approval decision must NOT
   be treated as a stall -- re-issuing a denied call is the approval-retry
   pattern the UI depends on, and ending the run there would hide the pending
   request. (Control: an MCP call that *does* run is a real loop and stalls.)
3. On a stall the journal keeps its tool-call/tool-result pairing invariant:
   every recorded call has a result and every result has a call.
"""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from xueness.core import Gate, Store, STALL_REPEAT_LIMIT, run
from xueness.web import WebGate

#: The exact error text the guard records for a call it refuses to repeat. It is
#: the contract the journal (and the UI reading it) relies on, so it is asserted
#: verbatim rather than matched loosely.
NOT_EXECUTED = "not executed: repeated tool call"

#: A read-only-then-mutating argv that appends one byte to ``runs.txt`` each time
#: it actually executes. Counting bytes in that file is how a test observes how
#: many times a side effect really happened, independent of the journal.
SIDE_EFFECT_ARGV = [
    sys.executable, "-c",
    "from pathlib import Path\n"
    "p = Path('runs.txt')\n"
    "p.write_text((p.read_text() if p.exists() else '') + 'x')",
]


def _call(call_id, name, arguments):
    """Build one provider tool call in the shape ``validate_message`` accepts."""
    return {"id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


class _ScriptedProvider:
    """Replays a fixed list of tool-call steps, then emits a plain completion.

    Keeping the provider deterministic and offline means the only thing under
    test is the loop guard, not a model or the network.
    """

    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = 0  # provider invocations, including the final completion

    def complete(self, messages, tools):
        index = self.calls
        self.calls += 1
        if index < len(self.steps):
            return {"content": "", "tool_calls": self.steps[index]}
        return {"content": json.dumps({"summary": "stopped", "evidence": []})}


class StallGuardTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.store = Store(self.root / "state")

    # -- helpers -----------------------------------------------------------

    def _side_effect_count(self):
        target = self.root / "runs.txt"
        return len(target.read_text()) if target.exists() else 0

    @staticmethod
    def _journal_pairs(session):
        """Return (call_ids, result_ids) as seen in the journal messages."""
        calls, results = set(), set()
        for message in session["messages"]:
            for call in message.get("tool_calls") or []:
                calls.add(call.get("id"))
            if message.get("role") == "tool":
                results.add(message.get("tool_call_id"))
        return calls, results

    # -- 1. ordinary repeated tool loop ------------------------------------

    def test_ordinary_repeat_loop_stalls_at_threshold_and_skips_the_repeat(self):
        """A verbatim repeat settles as ``stalled`` at the threshold, not later."""
        steps = [[_call("e%d" % i, "exec", {"argv": SIDE_EFFECT_ARGV})] for i in range(1, 6)]
        session = self.store.new("repeat the same exec", self.root)
        provider = _ScriptedProvider(steps)

        out = run(session, self.store, provider, Gate(self.root, allow_exec=True), max_steps=8)

        # Settles exactly at the threshold, well inside an 8-step budget: the
        # whole point of the guard is to stop early rather than burn the budget.
        self.assertEqual(out["status"], "stalled")
        self.assertEqual(out["steps"], STALL_REPEAT_LIMIT)

        # The repeated call never ran: only the first (LIMIT - 1) distinct steps
        # produced a side effect.
        self.assertEqual(self._side_effect_count(), STALL_REPEAT_LIMIT - 1)

        # The first two calls succeeded; the third is recorded as not executed.
        self.assertTrue(out["results"]["e1"]["ok"])
        self.assertTrue(out["results"]["e2"]["ok"])
        self.assertEqual(out["results"]["e3"], {"ok": False, "error": NOT_EXECUTED})

        # The provider was not consulted again after the stall.
        self.assertEqual(provider.calls, STALL_REPEAT_LIMIT)

    def test_below_threshold_repeat_is_not_a_stall(self):
        """Two identical steps can be a legitimate re-read; only three are a loop."""
        self.assertGreaterEqual(STALL_REPEAT_LIMIT, 3, "guard threshold changed; update this test")
        steps = [[_call("e%d" % i, "exec", {"argv": SIDE_EFFECT_ARGV})]
                 for i in range(1, STALL_REPEAT_LIMIT)]
        session = self.store.new("two identical execs", self.root)
        provider = _ScriptedProvider(steps)

        out = run(session, self.store, provider, Gate(self.root, allow_exec=True),
                  max_steps=STALL_REPEAT_LIMIT - 1)

        # The step budget ran out before the threshold could be reached.
        self.assertEqual(out["status"], "paused")
        self.assertEqual(self._side_effect_count(), STALL_REPEAT_LIMIT - 1)
        self.assertNotIn(NOT_EXECUTED, json.dumps(out["results"]))

    # -- 2. MCP awaiting approval must not falsely stall --------------------

    def test_mcp_awaiting_approval_does_not_falsely_stall(self):
        """Re-issuing a denied MCP call is an approval retry, not a loop.

        The WebGate denies every MCP call until a human approves the exact
        tool_call_id, so the model legitimately repeats the identical call each
        turn. Treating that as a stall would end the run before the operator can
        act, which is the very pattern the two-part check protects.
        """
        steps = [[_call("m%d" % i, "mcp__srv__echo", {"text": "ping"})] for i in range(1, 4)]
        session = self.store.new("mcp awaiting approval", self.root)
        provider = _ScriptedProvider(steps)

        server_calls = []

        def mcp_call(tool_name, arguments):
            server_calls.append((tool_name, arguments))
            return {"ok": True, "content": "RUN"}

        # WebGate + an empty approvals table => every call is denied pending a
        # human decision (exactly the state the UI renders as "pending").
        gate = WebGate(self.root, session["id"], {}, threading.Lock(),
                       mode="build", session=session)
        out = run(session, self.store, provider, gate, max_steps=5,
                  mcp_tools=[{"type": "function", "function": {"name": "mcp__srv__echo"}}],
                  mcp_call=mcp_call)

        # It must NOT be reported as a stall, and it must NOT have ended early.
        self.assertNotEqual(out["status"], "stalled")
        self.assertNotIn(NOT_EXECUTED, json.dumps(out["results"]))

        # All three retry turns really ran (3 call turns + 1 completion turn).
        self.assertEqual(provider.calls, 4)
        # Every attempt was denied by the gate, so the server was never reached.
        self.assertEqual(server_calls, [])
        for call_id in ("m1", "m2", "m3"):
            self.assertEqual(out["results"][call_id], {"ok": False, "error": "denied"})

    def test_control_mcp_repeat_that_actually_runs_still_stalls(self):
        """Proof the test above is not vacuous: a *successful* MCP repeat is a loop.

        With MCP auto-approved the identical calls succeed, so the repeat is a
        real loop and the guard must fire just like any other tool.
        """
        steps = [[_call("m%d" % i, "mcp__srv__echo", {"text": "ping"})] for i in range(1, 4)]
        session = self.store.new("mcp approved loop", self.root)
        provider = _ScriptedProvider(steps)

        server_calls = []

        def mcp_call(tool_name, arguments):
            server_calls.append((tool_name, arguments))
            return {"ok": True, "content": "RUN"}

        out = run(session, self.store, provider, Gate(self.root, allow_mcp=True), max_steps=8,
                  mcp_tools=[{"type": "function", "function": {"name": "mcp__srv__echo"}}],
                  mcp_call=mcp_call)

        self.assertEqual(out["status"], "stalled")
        self.assertEqual(out["results"]["m3"], {"ok": False, "error": NOT_EXECUTED})
        # The third identical call was recorded but never sent to the server.
        self.assertEqual(len(server_calls), STALL_REPEAT_LIMIT - 1)

    # -- 3. journal pairing on stall ---------------------------------------

    def test_journal_tool_call_result_pairing_on_stall(self):
        """Every kept call has a result and every result has a call, even on stall."""
        steps = [[_call("c%d" % i, "list", {"path": "."})] for i in range(1, 4)]
        session = self.store.new("pairing on stall", self.root)
        provider = _ScriptedProvider(steps)

        out = run(session, self.store, provider, Gate(self.root), max_steps=8)
        self.assertEqual(out["status"], "stalled")

        calls, results = self._journal_pairs(out)
        self.assertEqual(calls - results, set(), "a journaled call lost its result")
        self.assertEqual(results - calls, set(), "a journaled result lost its call")
        self.assertEqual(calls, {"c1", "c2", "c3"})
        self.assertEqual(results, {"c1", "c2", "c3"})

        # The stalled call is present in the journal *and* persisted in results,
        # so a reload of the session cannot see a half-recorded call.
        persisted = self.store.load(session["id"])
        persisted_calls, persisted_results = self._journal_pairs(persisted)
        self.assertEqual(persisted_calls, persisted_results)
        self.assertEqual(persisted_results, {"c1", "c2", "c3"})
        self.assertEqual(persisted["results"]["c3"], {"ok": False, "error": NOT_EXECUTED})

        # The recorded result the model sees for the skipped call matches the
        # persisted one byte for byte.
        stalled_message = next(
            message for message in out["messages"]
            if message.get("role") == "tool" and message.get("tool_call_id") == "c3")
        self.assertEqual(json.loads(stalled_message["content"]),
                         {"ok": False, "error": NOT_EXECUTED})


if __name__ == "__main__":
    unittest.main()
