"""Dependency-aware tool concurrency: safe reads batch, side effects stay serial.

Aligned with ZCode's ZCODE_MAX_TOOL_CONCURRENCY (default 10): within one model
turn, consecutive calls declared ``concurrency_safe`` and passing every static
policy pre-check run concurrently in a thread pool; every other call runs
alone, in the original order. Results, events, approvals, hooks and pause
semantics must stay identical to the serial loop. All tests use an isolated
state directory and injected fake handlers -- no network, no real model.
"""
import contextlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import (
    DEFAULT_TOOL_CONCURRENCY, TOOL_CONCURRENCY_ENV, Gate, Store, run,
    _concurrent_batch_units, _tool_concurrency_limit,
)
from xueness.plugin_runtime import catalog
from xueness.tool_registry import REGISTRY_BY_NAME


def _call(cid, name, **arguments):
    # Scheduler tests need valid write arguments to reach their fake handler.
    if name == 'write' and 'path' in arguments:
        arguments = {'content': 'fixture payload', **arguments}
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


class _OverlapTracker:
    """Records active spans; flags any overlap involving an exclusive span.

    A read-only span is marked non-exclusive: it may overlap other read-only
    spans (that is the feature under test) but must never overlap an exclusive
    one. Write execution, approval prompts and -- in the limit=1 test -- every
    span are exclusive: they may never overlap anything at all.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active = []  # list of (label, exclusive)
        self.violations = []

    @contextlib.contextmanager
    def span(self, label, exclusive=False):
        with self._lock:
            if exclusive and self._active:
                self.violations.append((label, list(self._active)))
            if not exclusive and any(flag for _label, flag in self._active):
                self.violations.append((label, list(self._active)))
            self._active.append((label, exclusive))
        try:
            yield
        finally:
            with self._lock:
                self._active.remove((label, exclusive))


class _ScriptedProvider:
    """Yields each scripted turn once, then a plain (unverified) answer."""

    def __init__(self, turns):
        self.turns = list(turns)

    def complete(self, messages, tools):
        if self.turns:
            return self.turns.pop(0)
        return {"content": "done"}


class ToolConcurrencyTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.root = base / "ws"
        self.root.mkdir()
        self.store = Store(base / "state")
        self.patches = []

    def tearDown(self):
        while self.patches:
            self.patches.pop().stop()

    def replace_handler(self, name, handler):
        active = patch.object(REGISTRY_BY_NAME[name], "handler", handler)
        active.start()
        self.patches.append(active)

    def run_turn(self, provider, gate, **kwargs):
        events = []
        session = self.store.new("concurrency", self.root)
        out = run(session, self.store, provider, gate, max_steps=6,
                  on_event=events.append, **kwargs)
        return out, events

    def tool_message_order(self, session):
        return [message.get("tool_call_id") for message in session["messages"]
                if message.get("role") == "tool"]

    def test_env_parsing_falls_back_on_invalid_values(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(TOOL_CONCURRENCY_ENV, None)
            self.assertEqual(_tool_concurrency_limit(), DEFAULT_TOOL_CONCURRENCY)
            for raw, expected in (("3", 3), (" 2 ", 2), ("1", 1), ("25", 25),
                                  ("abc", 10), ("0", 10), ("-4", 10),
                                  ("10.5", 10), ("", 10)):
                os.environ[TOOL_CONCURRENCY_ENV] = raw
                self.assertEqual(_tool_concurrency_limit(), expected, raw)

    def test_scheduler_splits_mixed_sequence_by_order(self):
        gate = Gate(self.root)
        calls = [_call("r1", "read", path="a"), _call("r2", "read", path="b"),
                 _call("w1", "write", path="c"), _call("r3", "read", path="d"),
                 _call("r4", "read", path="e")]
        plugin_enabled = lambda pid: True  # noqa: E731 - test stub
        units = _concurrent_batch_units(
            calls, gate=gate, session={"results": {}}, light=False,
            light_tool_names=frozenset(), remote_bound=False,
            plugin_enabled=plugin_enabled, max_concurrency=10)
        self.assertEqual(units, [(True, calls[:2]), (False, [calls[2]]),
                                 (True, calls[3:])])
        # Cap respected: a longer run of safe calls splits into capped batches,
        # and a leftover singleton drops back to the serial path.
        units_capped = _concurrent_batch_units(
            calls[:2] + [_call("r5", "read", path="f")], gate=gate,
            session={"results": {}}, light=False, light_tool_names=frozenset(),
            remote_bound=False, plugin_enabled=plugin_enabled, max_concurrency=2)
        self.assertEqual([(concurrent, [c["id"] for c in group])
                          for concurrent, group in units_capped],
                         [(True, ["r1", "r2"]), (False, ["r5"])])
        # Serial tool shapes never join a batch: a mutating call, an approval
        # kind, an unknown tool and a missing id each stay alone.
        mixed = [_call("x1", "write"), _call("x2", "web_fetch", url="https://x"),
                 _call("x3", "not_a_tool"), {"id": "", "type": "function",
                                             "function": {"name": "read", "arguments": "{}"}},
                 _call("x5", "todo_write", todos=[]), _call("x6", "tool_search", query="x")]
        units_mixed = _concurrent_batch_units(
            mixed, gate=gate, session={"results": {}}, light=False,
            light_tool_names=frozenset(), remote_bound=False,
            plugin_enabled=plugin_enabled, max_concurrency=10)
        self.assertEqual([(concurrent, [c["id"] for c in group])
                          for concurrent, group in units_mixed],
                         [(False, ["x1"]), (False, ["x2"]), (False, ["x3"]),
                          (False, [""]), (False, ["x5"]), (False, ["x6"])])
        # A policy-deniable call is excluded up front so its serial
        # short-circuit semantics are untouched.
        restricted = Gate(self.root, disallow=("read",))
        units_denied = _concurrent_batch_units(
            [_call("d1", "read", path="a"), _call("d2", "read", path="b")],
            gate=restricted, session={"results": {}}, light=False,
            light_tool_names=frozenset(), remote_bound=False,
            plugin_enabled=plugin_enabled, max_concurrency=10)
        self.assertEqual([(concurrent, [c["id"] for c in group])
                          for concurrent, group in units_denied],
                         [(False, ["d1"]), (False, ["d2"])])

    def test_batch_limit_one_is_fully_serial(self):
        with patch.dict(os.environ, {TOOL_CONCURRENCY_ENV: "1"}):
            self.assertEqual(_tool_concurrency_limit(), 1)
            tracker = _OverlapTracker()
            original = REGISTRY_BY_NAME["read"].handler

            def timed_read(r, g, a, s, c):
                with tracker.span("read:" + str(a.get("path")), exclusive=True):
                    time.sleep(0.1)
                return {"ok": True, "path": a.get("path")}

            self.replace_handler("read", timed_read)
            provider = _ScriptedProvider([
                {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                               _call("r2", "read", path="b"),
                                               _call("r3", "read", path="c")]},
            ])
            out, _events = self.run_turn(provider, Gate(self.root))
        self.assertEqual(tracker.violations, [])
        self.assertTrue(all(out["results"][cid]["ok"] for cid in ("r1", "r2", "r3")))
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "r3"])

    def test_safe_reads_run_concurrently(self):
        # A 3-party barrier: every call must be inside its handler at the same
        # time, so serial execution times out and fails the run's results.
        barrier = threading.Barrier(3, timeout=15)
        original = REGISTRY_BY_NAME["read"].handler

        def barrier_read(r, g, a, s, c):
            barrier.wait()
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", barrier_read)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b"),
                                           _call("r3", "read", path="c")]},
        ])
        out, events = self.run_turn(provider, Gate(self.root))
        for cid in ("r1", "r2", "r3"):
            self.assertTrue(out["results"][cid]["ok"], out["results"][cid])
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "r3"])
        self.assertEqual([e.get("id") for e in events if e.get("type") == "tool_result"],
                         ["r1", "r2", "r3"])

    def test_results_are_recorded_in_call_order_despite_completion_order(self):
        tracker = _OverlapTracker()
        finished = {}
        original = REGISTRY_BY_NAME["read"].handler

        def staggered_read(r, g, a, s, c):
            path = str(a.get("path"))
            with tracker.span("read:" + path):
                time.sleep({"slow": 0.35}.get(path, 0.05))
                finished[path] = time.monotonic()
            return {"ok": True, "path": path}

        self.replace_handler("read", staggered_read)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="slow"),
                                           _call("r2", "read", path="fast2"),
                                           _call("r3", "read", path="fast3")]},
        ])
        out, events = self.run_turn(provider, Gate(self.root))
        # The later calls really did finish first: recording order below is
        # therefore evidence of call-order replay, not of accidental ordering.
        self.assertLess(finished["fast2"], finished["slow"])
        self.assertLess(finished["fast3"], finished["slow"])
        self.assertEqual(tracker.violations, [])
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "r3"])
        self.assertEqual([e.get("id") for e in events if e.get("type") == "tool_result"],
                         ["r1", "r2", "r3"])
        self.assertEqual([e["tool_call_id"] for e in out["messages"]
                          if e.get("role") == "tool"], ["r1", "r2", "r3"])

    def test_writes_and_mixed_batches_stay_serial_and_ordered(self):
        barrier = threading.Barrier(2, timeout=15)
        tracker = _OverlapTracker()
        original_read = REGISTRY_BY_NAME["read"].handler
        original_write = REGISTRY_BY_NAME["write"].handler

        def paired_read(r, g, a, s, c):
            with tracker.span("read:" + str(a.get("path"))):
                barrier.wait()
            return {"ok": True, "path": a.get("path")}

        def approved_write(r, g, a, s, c):
            with tracker.span("write:" + str(a.get("path")), exclusive=True):
                g.check("write", str(a.get("path")))
                time.sleep(0.05)
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", paired_read)
        self.replace_handler("write", approved_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b"),
                                           _call("w1", "write", path="c"),
                                           _call("r3", "read", path="d"),
                                           _call("r4", "read", path="e")]},
        ])
        gate = Gate(self.root, interactive=True, approval_prompt=lambda *a, **k: "y")
        out, _events = self.run_turn(provider, gate)
        self.assertEqual(tracker.violations, [])
        for cid in ("r1", "r2", "w1", "r3", "r4"):
            self.assertTrue(out["results"][cid]["ok"], out["results"][cid])
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "w1", "r3", "r4"])

    def test_writes_execute_one_at_a_time(self):
        tracker = _OverlapTracker()
        original_write = REGISTRY_BY_NAME["write"].handler
        started = time.monotonic()

        def slow_write(r, g, a, s, c):
            with tracker.span("write:" + str(a.get("path")), exclusive=True):
                g.check("write", str(a.get("path")))
                time.sleep(0.12)
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("write", slow_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("w1", "write", path="a"),
                                           _call("w2", "write", path="b"),
                                           _call("w3", "write", path="c")]},
        ])
        gate = Gate(self.root, interactive=True, approval_prompt=lambda *a, **k: "y")
        out, _events = self.run_turn(provider, gate)
        self.assertEqual(tracker.violations, [])
        self.assertTrue(all(out["results"][cid]["ok"] for cid in ("w1", "w2", "w3")))
        self.assertGreaterEqual(time.monotonic() - started, 0.36,
                                "three 0.12s writes must not overlap")
        self.assertEqual(self.tool_message_order(out), ["w1", "w2", "w3"])

    def test_approval_interaction_never_overlaps_other_calls(self):
        tracker = _OverlapTracker()
        prompts = []
        original_read = REGISTRY_BY_NAME["read"].handler
        original_write = REGISTRY_BY_NAME["write"].handler

        def slow_read(r, g, a, s, c):
            with tracker.span("read:" + str(a.get("path"))):
                time.sleep(0.2)
            return {"ok": True, "path": a.get("path")}

        def approved_write(r, g, a, s, c):
            # One exclusive span covering the prompt and the execution: the
            # approval conversation may never race another call.
            with tracker.span("write", exclusive=True):
                g.check("write", str(a.get("path")))
                time.sleep(0.05)
            return {"ok": True, "path": a.get("path")}

        def prompt(question):
            prompts.append(question)
            return "y"

        self.replace_handler("read", slow_read)
        self.replace_handler("write", approved_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("w1", "write", path="b")]},
        ])
        gate = Gate(self.root, interactive=True, approval_prompt=prompt)
        out, _events = self.run_turn(provider, gate)
        self.assertEqual(tracker.violations, [])
        self.assertEqual(len(prompts), 1)
        self.assertIn("write", prompts[0])
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertTrue(out["results"]["w1"]["ok"])
        # The read ran inside a batch of one (its own unit), the write alone
        # after it: the write's approval never raced the read.

    def test_denied_approval_halts_and_later_calls_are_not_executed(self):
        tracker = _OverlapTracker()
        original_read = REGISTRY_BY_NAME["read"].handler
        original_write = REGISTRY_BY_NAME["write"].handler

        def denied_write(r, g, a, s, c):
            with tracker.span("write", exclusive=True):
                g.check("write", str(a.get("path")))
            return {"ok": True}

        self.replace_handler("read", lambda r, g, a, s, c: {"ok": True})
        self.replace_handler("write", denied_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("w1", "write", path="a"),
                                           _call("r1", "read", path="b")]},
        ])
        out, _events = self.run_turn(provider, Gate(self.root, interactive=True,
                                                    approval_prompt=lambda *a, **k: "n"))
        self.assertEqual(out["status"], "needs_review")
        self.assertFalse(out["results"]["w1"]["ok"])
        self.assertEqual(out["results"]["r1"].get("error"), "not executed: run paused")
        self.assertEqual(self.tool_message_order(out), ["w1", "r1"])

    def test_one_failing_member_does_not_affect_its_batch(self):
        barrier = threading.Barrier(3, timeout=15)
        original = REGISTRY_BY_NAME["read"].handler

        def bomb_or_ok(r, g, a, s, c):
            barrier.wait()
            if str(a.get("path")) == "bomb":
                raise RuntimeError("boom")
            return {"ok": True, "path": a.get("path")}

        self.replace_handler("read", bomb_or_ok)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="bomb"),
                                           _call("r2", "read", path="ok2"),
                                           _call("r3", "read", path="ok3")]},
        ])
        out, _events = self.run_turn(provider, Gate(self.root))
        self.assertFalse(out["results"]["r1"]["ok"])
        self.assertEqual(out["results"]["r1"].get("error"), "RuntimeError")
        self.assertTrue(out["results"]["r2"]["ok"])
        self.assertTrue(out["results"]["r3"]["ok"])
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "r3"])

    def test_plan_mode_behaviour_is_unchanged_and_reads_still_batch(self):
        barrier = threading.Barrier(2, timeout=15)
        prompts = []
        original_read = REGISTRY_BY_NAME["read"].handler
        original_write = REGISTRY_BY_NAME["write"].handler

        def paired_read(r, g, a, s, c):
            barrier.wait()
            return {"ok": True, "path": a.get("path")}

        def denied_write(r, g, a, s, c):
            g.check("write", str(a.get("path")))
            return {"ok": True}

        self.replace_handler("read", paired_read)
        self.replace_handler("write", denied_write)
        provider = _ScriptedProvider([
            {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                           _call("r2", "read", path="b"),
                                           _call("w1", "write", path="c")]},
        ])
        gate = Gate(self.root, mode="plan", interactive=True,
                    approval_prompt=lambda *a, **k: prompts.append("asked") or "y")
        out, _events = self.run_turn(provider, gate)

        def normalised(results):
            return {cid: {k: v for k, v in value.items() if k != "evidence_id"}
                    for cid, value in results.items()}

        concurrent_results = normalised(out["results"])
        self.assertTrue(out["results"]["r1"]["ok"])
        self.assertTrue(out["results"]["r2"]["ok"])
        self.assertFalse(out["results"]["w1"]["ok"])
        self.assertEqual(out["results"]["w1"].get("error"), "denied")
        self.assertEqual(prompts, [], "plan mode must deny before any approval")
        self.assertEqual(self.tool_message_order(out), ["r1", "r2", "w1"])
        # Identical outcomes when the run is forced fully serial.
        self.replace_handler("read", lambda r, g, a, s, c: {"ok": True, "path": a.get("path")})
        with patch.dict(os.environ, {TOOL_CONCURRENCY_ENV: "1"}):
            serial_provider = _ScriptedProvider([
                {"content": "", "tool_calls": [_call("r1", "read", path="a"),
                                               _call("r2", "read", path="b"),
                                               _call("w1", "write", path="c")]},
            ])
            serial_out, _serial_events = self.run_turn(serial_provider, gate)
        self.assertEqual(normalised(serial_out["results"]), concurrent_results)
        self.assertEqual(serial_out["status"], out["status"])

    def test_feature_is_registered_in_the_sessions_catalog(self):
        items = catalog(self.store.directory)
        sessions = next(p for p in items if p["id"] == "sessions")
        feature = next(f for f in sessions["features"] if f["id"] == "sessions.tool_concurrency")
        self.assertEqual(feature["name"], "依赖感知的工具并发调度")
        self.assertEqual(feature["nameEn"], "Dependency-aware tool concurrency")


if __name__ == "__main__":
    unittest.main()
