"""Batch 5 tests: task registry, cooperative stop, write locks, compaction invariants.

Four properties, each of which would be a real defect if it broke:

* a task record carries metadata only -- never the untrusted prompt text
* stopping settles a session at a step boundary and resuming continues from there
* one path has one writer, however the path is spelled
* compaction keeps every user turn and never splits a tool call from its result
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from tests.fs_link_helpers import make_symlink
from xueness.core import Gate, Store, _run_subagent, compact, run
from xueness.provider import FakeProvider
from xueness.task_registry import (
    CANCELLED,
    COMPLETED,
    FAILED,
    RUNNING,
    TaskRegistry,
    mirror,
)
from xueness.write_lock import WriteLocks, owner_for


# ---------------------------------------------------------------------------
# Task registry
# ---------------------------------------------------------------------------

class TaskRegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry = TaskRegistry()

    def test_record_returns_a_running_task(self):
        task = self.registry.record("t1", parent_session="p", agent="reviewer",
                                    prompt="do the thing", root="/ws")
        self.assertEqual(task["id"], "t1")
        self.assertEqual(task["parent"], "p")
        self.assertEqual(task["agent"], "reviewer")
        self.assertEqual(task["status"], RUNNING)
        self.assertEqual(task["steps"], 0)
        self.assertIsNone(task["endedAt"])

    def test_record_stores_prompt_length_not_text(self):
        """The prompt is untrusted text; the mirror must not carry it."""
        sentinel = "SENTINEL_PROMPT_TEXT_DO_NOT_MIRROR"
        self.registry.record("t1", parent_session="p", agent=None,
                             prompt=sentinel, root="/ws")
        blob = json.dumps(self.registry.list(), ensure_ascii=False)
        self.assertNotIn(sentinel, blob)
        self.assertEqual(self.registry.get("t1")["promptChars"], len(sentinel))

    def test_task_ids_are_not_child_session_ids(self):
        # ``sub-`` is the child session id prefix, which must not surface.
        self.assertTrue(self.registry.new_id().startswith("task-"))

    def test_update_merges_and_ignores_immutable_fields(self):
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        self.registry.update("t1", steps=3, summary="halfway", id="hacked", parent="other")
        task = self.registry.get("t1")
        self.assertEqual(task["steps"], 3)
        self.assertEqual(task["summary"], "halfway")
        self.assertEqual(task["id"], "t1", "id must not be mutable")
        self.assertEqual(task["parent"], "p", "parent must not be mutable")

    def test_update_unknown_id_is_ignored(self):
        self.registry.update("nope", steps=1)  # must not raise or create
        self.assertIsNone(self.registry.get("nope"))

    def test_finish_sets_terminal_state_and_truncates(self):
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        task = self.registry.finish("t1", ok=True, summary="y" * 9000, steps=4)
        self.assertEqual(task["status"], COMPLETED)
        self.assertEqual(len(task["summary"]), 4000)
        self.assertEqual(task["steps"], 4)
        self.assertIsNotNone(task["endedAt"])

    def test_finish_failure_records_error(self):
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        task = self.registry.finish("t1", ok=False, error="z" * 900)
        self.assertEqual(task["status"], FAILED)
        self.assertEqual(len(task["error"]), 500)

    def test_cancel_keeps_the_cancelled_status_through_finish(self):
        """A stopped run is not a success and not a failure: it stays cancelled."""
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        self.assertTrue(self.registry.cancel("t1"))
        self.assertTrue(self.registry.is_cancelled("t1"))
        task = self.registry.finish("t1", ok=True, summary="got there anyway")
        self.assertEqual(task["status"], CANCELLED)

    def test_cancel_rejects_unknown_and_finished_tasks(self):
        self.assertFalse(self.registry.cancel("ghost"))
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        self.registry.finish("t1", ok=True)
        self.assertFalse(self.registry.cancel("t1"),
                         "a finished task must not be flipped back to cancelled")

    def test_list_filters_by_parent_and_orders_by_start(self):
        self.registry.record("a", parent_session="p1", agent=None, prompt="x", root="/ws")
        self.registry.record("b", parent_session="p2", agent=None, prompt="x", root="/ws")
        self.assertEqual([t["id"] for t in self.registry.list("p1")], ["a"])
        self.assertEqual(len(self.registry.list()), 2)

    def test_forget_removes_the_task(self):
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        self.registry.forget("t1")
        self.assertIsNone(self.registry.get("t1"))

    def test_mirror_of_none_is_empty(self):
        self.assertEqual(mirror(None, "p"), [])

    def test_mirror_projects_without_persisting(self):
        self.registry.record("t1", parent_session="p", agent=None, prompt="x", root="/ws")
        self.assertEqual([t["id"] for t in mirror(self.registry, "p")], ["t1"])


class SubagentRegistryTests(unittest.TestCase):
    """The registry must actually be used by a delegated run."""

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.registry = TaskRegistry()

    def test_delegated_run_is_registered_and_finished(self):
        class ChatProvider:
            def complete(self, messages, tools):
                return {"content": "Hello from the child."}

        gate = Gate(self.root)
        result = _run_subagent(gate, ChatProvider(), [], "hello", None,
                               depth=0, max_depth=1, registry=self.registry,
                               parent_session="parent-1",
                               state_dir=self.root.parent / "state")
        self.assertTrue(result["ok"])
        task_id = result["task_id"]
        self.assertTrue(task_id.startswith("task-"))
        task = self.registry.get(task_id)
        self.assertIsNotNone(task, "the run must be visible while it happens")
        self.assertIn(task["status"], (COMPLETED, FAILED))
        self.assertEqual(task["parent"], "parent-1")

    def test_delegated_run_leaks_no_child_session_id(self):
        gate = Gate(self.root)
        result = _run_subagent(gate, FakeProvider(), [], "check", None,
                               depth=0, max_depth=1, registry=self.registry,
                               parent_session="p")
        self.assertNotIn("sub-", json.dumps(result, ensure_ascii=False))

    def test_cancelled_task_returns_a_cancelled_result(self):
        gate = Gate(self.root)
        # Pre-cancel by recording then cancelling the id we are about to hand in.
        original_new_id = self.registry.new_id

        def fixed_id():
            return "task-fixed"

        self.registry.new_id = fixed_id
        self.addCleanup(setattr, self.registry, "new_id", original_new_id)
        self.registry.record("task-fixed", parent_session="p", agent=None,
                             prompt="x", root=self.root)
        self.registry.cancel("task-fixed")

        result = _run_subagent(gate, FakeProvider(), [], "check", None,
                               depth=0, max_depth=1, registry=self.registry,
                               parent_session="p")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "cancelled")
        self.assertEqual(self.registry.get("task-fixed")["status"], CANCELLED)


# ---------------------------------------------------------------------------
# Cooperative stop
# ---------------------------------------------------------------------------

class StopTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.store = Store(base / "state")

    def test_should_stop_settles_as_stopped_and_keeps_results(self):
        session = self.store.new("do a thing", self.root)
        seen = {"finished": False}

        def should_stop():
            return seen["finished"]

        out = run(session, self.store, FakeProvider(), Gate(self.root),
                  max_steps=8, should_stop=should_stop,
                  on_event=lambda event: seen.update(finished=True)
                  if event["type"] == "tool_result" else None)
        self.assertEqual(out["status"], "stopped")
        self.assertGreaterEqual(len(out["results"]), 1,
                                "finished tool results must survive a stop")

    def test_stopped_session_can_be_resumed(self):
        session = self.store.new("do a thing", self.root)
        run(session, self.store, FakeProvider(), Gate(self.root), max_steps=8,
            should_stop=lambda: True)
        self.assertEqual(session["status"], "stopped")

        resumed = run(session, self.store, FakeProvider(), Gate(self.root), max_steps=8)
        self.assertIn(resumed["status"], ("completed", "needs_review", "paused"))

    def test_wall_clock_budget_pauses_at_boundary_and_can_resume(self):
        session = self.store.new("bounded run", self.root)
        # The first tool completes; the clock expires before the next provider
        # step, leaving its result and journal pair intact. Advance a controlled
        # clock inside the provider; cold imports and filesystem startup must
        # not race this five-millisecond boundary on slower build machines.
        clock = [0.0]
        class TimedProvider:
            def __init__(self):
                self.calls = 0

            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    clock[0] = 0.02
                    return {"content": "", "tool_calls": [{"id": "wall-read", "type": "function",
                        "function": {"name": "list", "arguments": '{"path":"."}'}}]}
                return {"content": '{"summary":"done","evidence":[]}' }

        provider = TimedProvider()
        with patch('xueness.core.time.monotonic', side_effect=lambda: clock[0]):
            out = run(session, self.store, provider, Gate(self.root), max_steps=8,
                      max_wall_seconds=0.005)
        self.assertEqual(out["status"], "paused")
        self.assertEqual(out["pause_code"], "wall_time_limit_reached")
        self.assertIn("0.005 秒", out["pause_reason"])
        self.assertEqual(provider.calls, 1)
        self.assertEqual(out["steps"], 1)
        self.assertTrue(out["results"]["wall-read"]["ok"])
        self.assertEqual([m["tool_call_id"] for m in out["messages"] if m["role"] == "tool"], ["wall-read"])
        resumed = run(self.store.load(session["id"]), self.store, provider, Gate(self.root),
                      max_wall_seconds=1)
        self.assertIn(resumed["status"], ("completed", "needs_review"))
        self.assertEqual(provider.calls, 2)

    def test_wall_clock_budget_rejects_invalid_values(self):
        for value in (0, -1, True, "12", 3601):
            with self.subTest(value=value), self.assertRaises(ValueError):
                run(self.store.new("invalid clock", self.root), self.store,
                    FakeProvider(), Gate(self.root), max_wall_seconds=value)

    def test_on_step_reports_progress(self):
        session = self.store.new("do a thing", self.root)
        steps = []
        run(session, self.store, FakeProvider(), Gate(self.root), max_steps=3,
            on_step=steps.append)
        self.assertTrue(steps, "progress callback must be invoked")

    def test_a_raising_progress_callback_does_not_break_the_run(self):
        session = self.store.new("do a thing", self.root)

        def boom(_steps):
            raise RuntimeError("reporting failed")

        out = run(session, self.store, FakeProvider(), Gate(self.root), max_steps=2,
                  on_step=boom)
        self.assertNotEqual(out["status"], "running")


# ---------------------------------------------------------------------------
# Write locks
# ---------------------------------------------------------------------------

class WriteLockTests(unittest.TestCase):
    def setUp(self):
        self.locks = WriteLocks()

    def test_first_owner_wins_and_others_are_refused(self):
        self.assertTrue(self.locks.acquire("/tmp/x/a.txt", "s1"))
        self.assertFalse(self.locks.acquire("/tmp/x/a.txt", "s2"))
        self.assertEqual(self.locks.holder("/tmp/x/a.txt"), "s1")

    def test_same_owner_reenters(self):
        self.assertTrue(self.locks.acquire("/tmp/x/a.txt", "s1"))
        self.assertTrue(self.locks.acquire("/tmp/x/a.txt", "s1"))

    def test_release_hands_the_path_to_the_next_owner(self):
        self.locks.acquire("/tmp/x/a.txt", "s1")
        self.locks.release("/tmp/x/a.txt", "s1")
        self.assertTrue(self.locks.acquire("/tmp/x/a.txt", "s2"))

    def test_release_by_a_non_holder_is_a_noop(self):
        self.locks.acquire("/tmp/x/a.txt", "s1")
        self.locks.release("/tmp/x/a.txt", "s2")
        self.assertEqual(self.locks.holder("/tmp/x/a.txt"), "s1")

    def test_relative_and_absolute_paths_share_one_lock(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        (base / "sub").mkdir()
        target = base / "n.txt"
        target.write_text("x", encoding="utf-8")
        self.assertTrue(self.locks.acquire(target, "s1"))
        # Same file spelled through a traversal segment.
        self.assertFalse(self.locks.acquire(base / "sub" / ".." / "n.txt", "s2"))

    def test_symlinked_path_shares_the_lock(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        target = base / "real.txt"
        target.write_text("x", encoding="utf-8")
        link = base / "link.txt"
        make_symlink(link, target)
        self.assertTrue(self.locks.acquire(target, "s1"))
        self.assertFalse(self.locks.acquire(link, "s2"))

    def test_owner_for_uses_session_id(self):
        self.assertEqual(owner_for({"id": "abc"}), "abc")
        self.assertEqual(owner_for({}), "anonymous")
        self.assertEqual(owner_for(None), "anonymous")


class WriteToolConflictTests(unittest.TestCase):
    """The lock must be held by the real write/edit handlers."""

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.gate = Gate(self.root, allow_write=True)
        self.session = {"id": "session-a"}

    def test_concurrent_write_to_one_path_is_refused_without_writing(self):
        from xueness.builtin_tools import dispatch
        from xueness.write_lock import DEFAULT_LOCKS

        target = self.root / "notes.md"
        # Another session already holds this path.
        DEFAULT_LOCKS.acquire(target, "session-b")
        try:
            result = dispatch(self.root, self.gate, "write",
                              {"path": "notes.md", "content": "second writer"},
                              self.session)
            self.assertFalse(result["ok"])
            self.assertTrue(result.get("conflict"))
            self.assertFalse(target.exists(), "a refused write must not touch disk")
        finally:
            DEFAULT_LOCKS.release(target, "session-b")

    def test_write_releases_the_lock_afterwards(self):
        from xueness.builtin_tools import dispatch
        from xueness.write_lock import DEFAULT_LOCKS

        result = dispatch(self.root, self.gate, "write",
                          {"path": "a.txt", "content": "hello"}, self.session)
        self.assertTrue(result["ok"])
        # Another session can now take the path.
        self.assertTrue(DEFAULT_LOCKS.acquire(self.root / "a.txt", "session-b"))
        DEFAULT_LOCKS.release(self.root / "a.txt", "session-b")

    def test_lock_released_even_when_the_edit_fails(self):
        from xueness.builtin_tools import dispatch
        from xueness.write_lock import DEFAULT_LOCKS

        (self.root / "a.txt").write_text("hello", encoding="utf-8")
        # No match -> the handler raises inside the lock.
        result = dispatch(self.root, self.gate, "edit",
                          {"path": "a.txt", "old": "absent", "new": "x"}, self.session)
        self.assertFalse(result["ok"])
        self.assertTrue(DEFAULT_LOCKS.acquire(self.root / "a.txt", "session-b"),
                        "a failed edit must not strand the lock")
        DEFAULT_LOCKS.release(self.root / "a.txt", "session-b")


# ---------------------------------------------------------------------------
# Compaction invariants
# ---------------------------------------------------------------------------

def _long_journal():
    messages = [{"role": "system", "content": "SYSTEM"},
                {"role": "user", "content": "ORIGINAL TASK"}]
    for i in range(6):
        cid = "c%d" % i
        messages.append({"role": "assistant", "content": "",
                         "tool_calls": [{"id": cid}],
                         "function": {"name": "read"}})
        messages.append({"role": "tool", "tool_call_id": cid, "content": "X" * 2000})
    messages.append({"role": "user", "content": "LATER USER TURN"})
    for i in range(6, 10):
        cid = "c%d" % i
        messages.append({"role": "assistant", "content": "",
                         "tool_calls": [{"id": cid}]})
        messages.append({"role": "tool", "tool_call_id": cid, "content": "Y" * 2000})
    return {"messages": messages, "results": {}, "compactions": [], "archived_messages": []}


def _pairs(messages):
    calls, results = set(), set()
    for message in messages:
        for call in message.get("tool_calls") or []:
            calls.add(call.get("id"))
        if message.get("role") == "tool":
            results.add(message.get("tool_call_id"))
    return calls, results


class CompactTests(unittest.TestCase):
    def test_later_user_turns_survive_compaction(self):
        """The bug this batch fixed: a human's later turn was silently dropped."""
        session = _long_journal()
        compact(session, 4000)
        kept = [m["content"] for m in session["messages"] if m["role"] == "user"]
        self.assertIn("ORIGINAL TASK", kept)
        self.assertIn("LATER USER TURN", kept)

    def test_tool_call_pairing_is_never_split(self):
        session = _long_journal()
        compact(session, 4000)
        calls, results = _pairs(session["messages"])
        self.assertEqual(calls - results, set(), "a kept call lost its result")
        self.assertEqual(results - calls, set(), "a kept result lost its call")

    def test_compaction_is_idempotent_for_the_invariants(self):
        session = _long_journal()
        compact(session, 4000)
        compact(session, 4000)
        calls, results = _pairs(session["messages"])
        self.assertEqual(calls - results, set())
        self.assertEqual(results - calls, set())
        kept = [m["content"] for m in session["messages"] if m["role"] == "user"]
        self.assertIn("LATER USER TURN", kept)

    def test_system_and_original_task_are_kept(self):
        session = _long_journal()
        compact(session, 4000)
        contents = [m["content"] for m in session["messages"]]
        self.assertIn("SYSTEM", contents)
        self.assertIn("ORIGINAL TASK", contents)

    def test_dropped_messages_are_archived_and_counted(self):
        session = _long_journal()
        before = len(session["messages"])
        compact(session, 4000)
        entry = session["compactions"][-1]
        self.assertGreater(entry["removed"], 0)
        self.assertEqual(entry["kept_user_turns"], 1)
        self.assertGreater(len(session["archived_messages"]), 0)
        self.assertLess(len(session["messages"]), before)

    def test_short_journal_is_left_alone(self):
        session = {"messages": [{"role": "system", "content": "S"},
                                {"role": "user", "content": "T"}],
                   "results": {}, "compactions": [], "archived_messages": []}
        compact(session, 24000)
        self.assertEqual(len(session["messages"]), 2)


class CompactOverBudgetTests(unittest.TestCase):
    """The budget must hold even when nothing is droppable, and big output
    must be recoverable rather than destroyed."""

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)

    def _one_huge_output(self, read_only=False):
        messages = [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "T"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
            {"role": "tool", "tool_call_id": "c1", "content": "Z" * 20000},
        ]
        session = {"messages": messages, "results": {},
                   "compactions": [], "archived_messages": [],
                   "root": str(self.root)}
        if read_only:
            session["read_only"] = True
        return session

    def test_a_single_oversized_output_cannot_blow_the_budget(self):
        """Dropping is not the only lever: with nothing droppable, the oversized
        body still has to be bounded instead of being sent verbatim."""
        session = self._one_huge_output()
        compact(session, 4000)
        body = [m for m in session["messages"] if m["role"] == "tool"][0]["content"]
        self.assertLess(len(body), 5000, "the oversized body was sent unbounded")

    def test_oversized_output_is_offloaded_and_recoverable(self):
        session = self._one_huge_output()
        original = [m for m in session["messages"] if m["role"] == "tool"][0]["content"]
        compact(session, 4000)
        body = [m for m in session["messages"] if m["role"] == "tool"][0]["content"]
        self.assertIn(".xueness/artifacts/c1.txt", body, "no pointer back to the full text")
        artifact = self.root / ".xueness" / "artifacts" / "c1.txt"
        self.assertTrue(artifact.exists(), "the full output was not written anywhere")
        self.assertEqual(artifact.read_text(encoding="utf-8"), original,
                         "the artifact must be the original bytes, not the window")

    def test_read_only_run_truncates_instead_of_writing(self):
        """Offloading writes a file; a read-only run must not, and must fall
        back to truncation rather than silently skipping the bound."""
        session = self._one_huge_output(read_only=True)
        compact(session, 4000)
        body = [m for m in session["messages"] if m["role"] == "tool"][0]["content"]
        self.assertIn("[truncated in context]", body)
        self.assertFalse((self.root / ".xueness").exists(),
                         "a read-only run wrote an artifact")

    def test_user_turns_are_never_windowed(self):
        big = "BIGUSER" * 3000
        session = {"messages": [{"role": "system", "content": "S"},
                                {"role": "user", "content": big},
                                {"role": "assistant", "content": "x"}],
                   "results": {}, "compactions": [], "archived_messages": [],
                   "root": str(self.root)}
        compact(session, 4000)
        kept = [m for m in session["messages"] if m["role"] == "user"][0]["content"]
        self.assertEqual(kept, big, "a user turn was clipped; it must stay verbatim")


class StagedCompactionTests(unittest.TestCase):
    """Stage 1 masks stale output before stage 2 drops anything.

    Masking is the cheaper, safer lever; doing it first means a moderate overage
    never reaches the lossy stage. The archived copy is what makes the marker
    honest.
    """

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)

    def _units(self, count=12, size=900):
        messages = [{"role": "system", "content": "S"}, {"role": "user", "content": "T"}]
        for i in range(count):
            messages.append({"role": "assistant", "content": "",
                             "tool_calls": [{"id": "c%d" % i}]})
            messages.append({"role": "tool", "tool_call_id": "c%d" % i,
                             "content": "X" * size})
        return {"messages": messages, "results": {}, "compactions": [],
                "archived_messages": [], "root": str(self.root)}

    def test_masking_alone_can_avoid_dropping(self):
        session = self._units()
        compact(session, 9000)
        entry = session["compactions"][-1]
        self.assertGreater(entry["masked"], 0, "nothing was masked")
        self.assertEqual(entry["removed"], 0,
                         "units were dropped although masking already sufficed")

    def test_masked_originals_are_archived_verbatim(self):
        """The marker points at the journal, so the journal must still have it."""
        session = self._units()
        compact(session, 9000)
        masked = session["compactions"][-1]["masked"]
        originals = [m for m in session["archived_messages"]
                     if m.get("role") == "tool" and len(m.get("content", "")) == 900]
        self.assertEqual(len(originals), masked,
                         "a masked body was shortened without archiving the original")

    def test_pairing_and_user_turns_survive_masking(self):
        session = self._units()
        compact(session, 9000)
        calls, results = set(), set()
        for message in session["messages"]:
            for call in message.get("tool_calls") or []:
                calls.add(call.get("id"))
            if message.get("role") == "tool":
                results.add(message.get("tool_call_id"))
        self.assertEqual(calls, results, "masking broke a call/result pairing")
        users = [m["content"] for m in session["messages"] if m["role"] == "user"]
        self.assertIn("T", users)

    def test_tight_budget_still_drops(self):
        """Masking must not become an excuse to exceed the budget."""
        session = self._units()
        compact(session, 1200)
        self.assertGreater(session["compactions"][-1]["removed"], 0)


if __name__ == "__main__":
    unittest.main()
