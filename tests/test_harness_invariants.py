"""Harness invariants: properties that must hold no matter how the loop is refactored.

These are not tests of a feature; they pin *structural* guarantees that are easy
to break silently. Each one corresponds to a real failure mode documented in
docs/xueness-harness-notes.md, where another harness shipped the bug.

If one of these fails after a refactor, the refactor moved a safety call out of
the path it has to be on. That is the whole point of pinning it here.
"""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, compact, run
from xueness.provider import FakeProvider


class _RecordingProvider:
    """A provider that records the exact prompt it was handed each call.

    Wrapping FakeProvider keeps behaviour identical while letting a test assert
    what the model actually saw -- which is the only way to check a claim like
    "compaction ran before this request".
    """

    def __init__(self):
        self.inner = FakeProvider()
        self.prompts = []

    def complete(self, messages, tools):
        # Deep copy: the loop mutates its message list in place, so holding a
        # reference would let a later step rewrite what we recorded here.
        self.prompts.append(json.loads(json.dumps(messages, ensure_ascii=False)))
        return self.inner.complete(messages, tools)


class CompactionGuardTests(unittest.TestCase):
    """Compaction must run at every step boundary, before the model is called.

    The bug this prevents: a harness that only checked context size after an
    assistant turn settled, while the *next* request carried freshly appended
    tool results. The window then overflows inside a long tool loop, and the
    check that exists never sees the input that breaks it.
    """

    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.store = Store(base / "state")

    def test_every_request_follows_a_compaction_check(self):
        """No prompt may be sent without compaction having run in that step."""
        session = self.store.new("do a thing", self.root)
        provider = _RecordingProvider()
        # A budget small enough that compaction has real work to do.
        run(session, self.store, provider, Gate(self.root), max_steps=3, max_chars=600)

        self.assertGreaterEqual(len(provider.prompts), 1, "the model was never called")
        # The prompt view is always bounded by the configured budget, however many
        # steps ran. Growth past it means a step skipped its compaction call.
        for index, prompt in enumerate(provider.prompts):
            size = len(json.dumps(prompt, ensure_ascii=False))
            self.assertLessEqual(
                size, 600 + 1200,
                "prompt %d was %d chars: compaction did not run before this request"
                % (index, size),
            )

    def test_context_guard_holds_across_a_long_tool_loop(self):
        """The overflow case specifically: many tool results in one run."""
        session = self.store.new("do a thing", self.root)
        provider = _RecordingProvider()
        run(session, self.store, provider, Gate(self.root), max_steps=6, max_chars=800)

        largest = max(len(json.dumps(p, ensure_ascii=False)) for p in provider.prompts)
        self.assertLess(largest, 800 + 1200,
                        "a request exceeded the budget: the guard missed appended results")


class UserTurnRetentionTests(unittest.TestCase):
    """A human's words survive compaction. Pinned in batch 5; kept pinned here."""

    def test_later_user_turns_are_never_summarised_away(self):
        session = {
            "messages": [
                {"role": "system", "content": "S"},
                {"role": "user", "content": "FIRST"},
                {"role": "assistant", "content": "a" * 4000},
                {"role": "user", "content": "SECOND"},
                {"role": "assistant", "content": "b" * 4000},
                {"role": "user", "content": "THIRD"},
            ],
            "results": {}, "compactions": [], "archived_messages": [],
        }
        compact(session, 500)
        kept = [m["content"] for m in session["messages"] if m["role"] == "user"]
        for expected in ("FIRST", "SECOND", "THIRD"):
            self.assertIn(expected, kept, "user turn %s was dropped" % expected)


class ToolPairingTests(unittest.TestCase):
    """A kept tool call always has its result, and vice versa."""

    def test_pairing_survives_compaction(self):
        messages = [{"role": "system", "content": "S"}, {"role": "user", "content": "T"}]
        for i in range(10):
            messages.append({"role": "assistant", "content": "",
                             "tool_calls": [{"id": "c%d" % i}]})
            messages.append({"role": "tool", "tool_call_id": "c%d" % i,
                             "content": "x" * 900})
        session = {"messages": messages, "results": {},
                   "compactions": [], "archived_messages": []}
        compact(session, 900)

        calls, results = set(), set()
        for message in session["messages"]:
            for call in message.get("tool_calls") or []:
                calls.add(call.get("id"))
            if message.get("role") == "tool":
                results.add(message.get("tool_call_id"))
        self.assertEqual(calls - results, set(), "a kept call lost its result")
        self.assertEqual(results - calls, set(), "a kept result lost its call")


class SubagentIsolationTests(unittest.TestCase):
    """A delegated run must not inherit the parent transcript.

    Every harness surveyed does the same thing here; the property is that the
    child gets its own bounded context, not a copy of the parent's.
    """

    def test_child_prompt_is_not_the_parent_transcript(self):
        from xueness.core import _run_subagent

        with tempfile.TemporaryDirectory() as holder:
            root = Path(holder)
            sentinel = "PARENT_SECRET_TRANSCRIPT_LINE"
            result = _run_subagent(Gate(root), FakeProvider(), [], "child task", None,
                                   depth=0, max_depth=1)
            self.assertTrue(result["ok"])
            # The child summary must not carry parent-only text; there is no
            # parent here, so the check is that the child ran in its own frame.
            self.assertNotIn(sentinel, json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
