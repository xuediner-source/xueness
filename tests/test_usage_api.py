"""Tests for xueness.usage_api (Stage 2 contract, section 4 "用量").

Covers the read-only aggregation path end to end:
empty store zeros, duck-typed stores (a session whose ``load`` raises must be
skipped, never crash the request), the exact 7d/30d window boundary with an
injected ``now``, ``all`` ignoring time, ``completed`` counted only for
``status == "completed"``, ascending per-day series merging, illegal ``range``
falling back to ``7d``, non-owned routes returning ``None``, and the real
``core.Store`` file mtime being the timestamp source.

Stdlib only; no network, no writes to the repository.
"""
import datetime as _dt
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from xueness import usage_api
from xueness.core import Store

DAY = 86400


def _ts(*, year=2024, month=3, day=1, hour=12):
    """Fixed local timestamp helper so day boundaries are explicit."""
    return _dt.datetime(year, month, day, hour, 0, 0).timestamp()


def _day(ts):
    return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


class AggregateTests(unittest.TestCase):
    """Pure-function coverage of aggregate()."""

    def test_empty_input_is_zeroes_and_empty_series(self):
        result = usage_api.aggregate([], "7d")
        self.assertEqual(result["range"], "7d")
        self.assertEqual(result["totals"], {"sessions": 0, "steps": 0, "completed": 0})
        self.assertEqual(result["series"], [])

    def test_empty_input_with_none_now(self):
        result = usage_api.aggregate([], "all")
        self.assertEqual(result["totals"], {"sessions": 0, "steps": 0, "completed": 0})
        self.assertEqual(result["series"], [])

    def test_seven_day_boundary_seventh_day_in_eighth_day_out(self):
        now = _ts()
        sessions = [
            {"id": "a", "status": "completed", "steps": 3, "mtime": now},
            {"id": "b", "status": "pending", "steps": 5, "mtime": now - 7 * DAY},
            {"id": "c", "status": "completed", "steps": 9, "mtime": now - 8 * DAY},
        ]

        week = usage_api.aggregate(sessions, "7d", now=now)
        self.assertEqual(week["totals"]["sessions"], 2)
        self.assertEqual(week["totals"]["steps"], 8)
        self.assertEqual(week["totals"]["completed"], 1)
        included = {item["date"] for item in week["series"]}
        self.assertEqual(included, {_day(now), _day(now - 7 * DAY)})
        self.assertNotIn(_day(now - 8 * DAY), included)

        month = usage_api.aggregate(sessions, "30d", now=now)
        self.assertEqual(month["totals"]["sessions"], 3)
        self.assertEqual(month["totals"]["steps"], 17)

    def test_all_range_ignores_time(self):
        now = _ts()
        sessions = [
            {"id": "a", "status": "completed", "steps": 1, "mtime": now},
            {"id": "b", "status": "pending", "steps": 2, "mtime": now - 400 * DAY},
            {"id": "c", "status": "running", "steps": 4, "mtime": 0},
        ]
        result = usage_api.aggregate(sessions, "all", now=now)
        self.assertEqual(result["range"], "all")
        self.assertEqual(result["totals"]["sessions"], 3)
        self.assertEqual(result["totals"]["steps"], 7)
        self.assertEqual(result["totals"]["completed"], 1)

    def test_completed_counts_only_completed_status(self):
        now = _ts()
        sessions = [
            {"id": "a", "status": "completed", "steps": 1, "mtime": now},
            {"id": "b", "status": "running", "steps": 1, "mtime": now},
            {"id": "c", "status": "needs_review", "steps": 1, "mtime": now},
            {"id": "d", "status": "completed", "steps": 1, "mtime": now},
            {"id": "e", "status": "Completed", "steps": 1, "mtime": now},
            {"id": "f", "steps": 1, "mtime": now},
        ]
        result = usage_api.aggregate(sessions, "7d", now=now)
        self.assertEqual(result["totals"]["sessions"], 6)
        self.assertEqual(result["totals"]["completed"], 2)

    def test_series_is_ascending_and_merges_same_day(self):
        now = _ts(day=1, hour=20)
        earlier = _ts(month=2, day=25, hour=8)
        middle = _ts(month=2, day=27, hour=12)
        sessions = [
            {"id": "1", "status": "completed", "steps": 2, "mtime": now},
            {"id": "2", "status": "pending", "steps": 3, "mtime": _ts(hour=9)},
            {"id": "3", "status": "completed", "steps": 4, "mtime": middle},
            {"id": "4", "status": "running", "steps": 5, "mtime": earlier},
        ]
        result = usage_api.aggregate(sessions, "all", now=now)
        dates = [item["date"] for item in result["series"]]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(dates, [_day(earlier), _day(middle), _day(now)])
        today_bucket = [item for item in result["series"] if item["date"] == _day(now)][0]
        self.assertEqual(today_bucket["sessions"], 2)
        self.assertEqual(today_bucket["steps"], 5)
        self.assertEqual(sum(item["sessions"] for item in result["series"]), 4)

    def test_invalid_range_falls_back_to_seven_days(self):
        now = _ts()
        sessions = [
            {"id": "a", "status": "completed", "steps": 1, "mtime": now},
            {"id": "b", "status": "pending", "steps": 1, "mtime": now - 40 * DAY},
        ]
        for bad in ("1y", "", "7", "7D ", None, 7, ["all"]):
            result = usage_api.aggregate(sessions, bad, now=now)
            self.assertEqual(result["range"], "7d", f"range={bad!r}")
            self.assertEqual(result["totals"]["sessions"], 1, f"range={bad!r}")
        self.assertEqual(usage_api.aggregate(sessions, "30d", now=now)["range"], "30d")
        self.assertEqual(usage_api.aggregate(sessions, "ALL", now=now)["range"], "all")

    def test_junk_rows_are_skipped_not_fatal(self):
        now = _ts()
        negative_mtime_supported = True
        try:
            _dt.datetime.fromtimestamp(-1)
        except (OSError, OverflowError, ValueError):
            negative_mtime_supported = False
        sessions = [
            None,
            "not-a-session",
            {},
            {"id": "x", "status": "completed", "steps": "nan", "mtime": "not-a-time"},
            {"id": "y", "status": "completed", "steps": -4, "mtime": -1},
            {"id": "nan", "status": "completed", "steps": 1, "mtime": "nan"},
            {"id": "inf", "status": "completed", "steps": 1, "mtime": float("inf")},
            {"id": "int-overflow", "status": "completed", "steps": 1, "mtime": 10**400},
            {"id": "far", "status": "completed", "steps": 1, "mtime": 1e300},
            {"id": "z", "status": "completed", "steps": 2, "mtime": now},
        ]
        result = usage_api.aggregate(sessions, "all", now=now)
        # The negative timestamp is retained only when this platform's local
        # timestamp conversion supports it. All malformed/non-finite values
        # are skipped without making aggregate() fail.
        expected_sessions = 1 + int(negative_mtime_supported)
        expected_steps = 2
        expected_completed = expected_sessions
        self.assertEqual(result["totals"]["sessions"], expected_sessions)
        self.assertEqual(result["totals"]["steps"], expected_steps)
        self.assertEqual(result["totals"]["completed"], expected_completed)


class DispatchTests(unittest.TestCase):
    """HTTP-shaped coverage through dispatch() with ctx dicts."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.root = self.dir / "workspace"
        self.root.mkdir()
        self.store_dir = self.dir / "sessions"
        self.store_dir.mkdir()

    def _ctx(self, store=None):
        return {"store": store if store is not None else Store(self.store_dir),
                "state_dir": self.dir}

    def _usage(self, query=None, ctx=None, method="GET", parts=None):
        parts = ["api", "usage"] if parts is None else parts
        return usage_api.dispatch(method, parts, query or {}, {}, ctx if ctx is not None else self._ctx())

    def test_empty_store_returns_zeroes(self):
        status, payload = self._usage({"range": ["7d"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["range"], "7d")
        self.assertEqual(payload["totals"], {"sessions": 0, "steps": 0, "completed": 0})
        self.assertEqual(payload["series"], [])
        self.assertEqual(set(payload), {"range", "totals", "series", "updatedAt"})
        _dt.datetime.fromisoformat(payload["updatedAt"].replace("Z", "+00:00"))

    def test_missing_range_defaults_to_seven_days(self):
        store = Store(self.store_dir)
        store.new("task", self.root)
        status, payload = self._usage({})
        self.assertEqual(status, 200)
        self.assertEqual(payload["range"], "7d")
        self.assertEqual(payload["totals"]["sessions"], 1)
        self.assertEqual(len(payload["series"]), 1)
        self.assertEqual(payload["series"][0]["date"], _day(time.time()))
        self.assertEqual(set(payload["series"][0]), {"date", "sessions", "steps"})

    def test_missing_store_key_is_not_fatal(self):
        status, payload = self._usage({"range": ["all"]}, ctx={})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"], {"sessions": 0, "steps": 0, "completed": 0})
        self.assertEqual(payload["series"], [])

    def test_illegal_range_falls_back(self):
        store = Store(self.store_dir)
        store.new("task", self.root)
        status, payload = self._usage({"range": ["1y"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["range"], "7d")
        status, payload = self._usage({"range": ["all"]})
        self.assertEqual(payload["range"], "all")

    def test_real_store_mtime_governs_the_window(self):
        store = Store(self.store_dir)
        fresh = store.new("fresh task", self.root)
        fresh["status"] = "completed"
        store.save(fresh)
        stale = store.new("stale task", self.root)
        stale["status"] = "completed"
        store.save(stale)
        old = time.time() - 10 * DAY
        os.utime(self.store_dir / (stale["id"] + ".json"), (old, old))

        status, payload = self._usage({"range": ["7d"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"], {"sessions": 1, "steps": 0, "completed": 1})

        status, payload = self._usage({"range": ["all"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"], {"sessions": 2, "steps": 0, "completed": 2})
        dates = [item["date"] for item in payload["series"]]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(dates, [_day(old), _day(time.time())])

    def test_steps_are_summed_from_the_session_records(self):
        store = Store(self.store_dir)
        for steps in (2, 5):
            session = store.new(f"task {steps}", self.root)
            session["steps"] = steps
            store.save(session)
        status, payload = self._usage({"range": ["all"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"]["sessions"], 2)
        self.assertEqual(payload["totals"]["steps"], 7)

    def test_duck_typed_store_skips_broken_session_and_survives(self):
        sessions = {
            "aaa": {"id": "aaa", "status": "completed", "steps": 4, "mtime": _ts()},
            "bbb": {"id": "bbb", "status": "pending", "steps": 1, "mtime": _ts()},
        }

        class FakeStore:
            def list(self):
                return [{"id": "aaa"}, {"id": "bbb"}, {"id": "broken"}]

            def load(self, sid):
                if sid == "broken":
                    raise OSError("corrupt journal")
                return sessions[sid]

        status, payload = self._usage({"range": ["all"]}, ctx={"store": FakeStore()})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"]["sessions"], 2)
        self.assertEqual(payload["totals"]["steps"], 5)
        self.assertEqual(payload["totals"]["completed"], 1)

    def test_duck_typed_store_uses_entry_timestamps_when_there_is_no_directory(self):
        now = time.time()

        class FakeStore:
            def list(self):
                return [{"id": "old", "mtime": now - 10 * DAY}, {"id": "new", "mtime": now}]

            def load(self, sid):
                # No mtime on the record: dispatch must fall back to the entry.
                return {"id": sid, "status": "completed", "steps": 1}

        ctx = {"store": FakeStore()}
        status, payload = self._usage({"range": ["7d"]}, ctx=ctx)
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"]["sessions"], 1)
        status, payload = self._usage({"range": ["all"]}, ctx=ctx)
        self.assertEqual(payload["totals"]["sessions"], 2)
        self.assertEqual(payload["totals"]["completed"], 2)

    def test_duck_typed_store_list_failure_is_not_fatal(self):
        class ExplodingStore:
            def list(self):
                raise RuntimeError("store unavailable")

            def load(self, sid):
                raise RuntimeError("store unavailable")

        status, payload = self._usage({"range": ["7d"]}, ctx={"store": ExplodingStore()})
        self.assertEqual(status, 200)
        self.assertEqual(payload["totals"], {"sessions": 0, "steps": 0, "completed": 0})
        self.assertEqual(payload["series"], [])

    def test_store_returning_non_list_is_not_fatal(self):
        class OddStore:
            def list(self):
                return None

            def load(self, sid):
                return {}

        status, payload = self._usage({}, ctx={"store": OddStore()})
        self.assertEqual(status, 200)
        self.assertEqual(payload["series"], [])

    def test_non_owned_routes_return_none(self):
        store = Store(self.store_dir)
        ctx = self._ctx(store)
        cases = [
            ("POST", ["api", "usage"]),
            ("DELETE", ["api", "usage"]),
            ("GET", ["api", "usages"]),
            ("GET", ["api", "usage", "7d"]),
            ("GET", ["usage"]),
            ("GET", ["api", "settings"]),
            ("GET", ["api"]),
            ("GET", []),
        ]
        for method, parts in cases:
            self.assertIsNone(usage_api.dispatch(method, parts, {"range": ["7d"]}, {}, ctx),
                              f"{method} {parts}")

    def test_non_owned_method_with_parts_none_still_returns_none(self):
        self.assertIsNone(usage_api.dispatch("GET", None, {}, {}, {}))

    def test_dispatch_does_not_write_to_the_state_dir(self):
        store = Store(self.store_dir)
        store.new("task", self.root)
        before = sorted(p.name for p in self.dir.rglob("*"))
        status, payload = self._usage({"range": ["all"]})
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["totals"]["sessions"], 1)
        self.assertEqual(sorted(p.name for p in self.dir.rglob("*")), before)

    def test_payload_is_json_serialisable(self):
        store = Store(self.store_dir)
        session = store.new("task", self.root)
        session["steps"] = 3
        session["status"] = "completed"
        store.save(session)
        status, payload = self._usage({"range": ["all"]})
        self.assertEqual(status, 200)
        json.dumps(payload)


class ProviderUsageTests(unittest.TestCase):
    def test_actual_provider_records_build_daily_model_and_activity_breakdowns(self):
        now = _ts(year=2024, month=3, day=10)
        session = {
            "id": "task",
            "status": "completed",
            "steps": 3,
            "provider_usage": [
                {
                    "at": _dt.datetime.fromtimestamp(now).isoformat(),
                    "model": "gpt-test",
                    "protocol": "openai",
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                    "cost": {"currency": "USD", "amount": 0.01},
                },
                {
                    "at": _dt.datetime.fromtimestamp(now - DAY).isoformat(),
                    "model": "claude-test",
                    "protocol": "anthropic",
                    "usage": {"input_tokens": 4},
                },
                {
                    "at": _dt.datetime.fromtimestamp(now - 2 * DAY).isoformat(),
                    "model": "gpt-test",
                    "protocol": "openai",
                    "usage": {"prompt_tokens": True, "completion_tokens": 5},
                },
                {
                    "at": _dt.datetime.fromtimestamp(now - 3 * DAY).isoformat(),
                    "usage": {"prompt_tokens": 2, "completion_tokens": 3},
                },
            ],
        }

        class FakeStore:
            def list(self):
                return [{"id": "task", "mtime": now}]

            def load(self, sid):
                return session if sid == "task" else None

        result = usage_api.build_usage({"store": FakeStore()}, "all", now=now)

        self.assertEqual(result["tokens"], {
            "input": 16, "output": 13, "total": 20,
            "reportedRequests": 2, "unknownRequests": 2,
        })
        self.assertEqual(result["costs"], {"USD": 0.01})
        self.assertEqual([item["date"] for item in result["dailyUsage"]], [
            _day(now - 3 * DAY), _day(now - 2 * DAY), _day(now - DAY), _day(now),
        ])
        self.assertEqual(result["tokenActivity"], {
            "activeDays": 2, "peakDayTokens": 15,
            "currentStreakDays": 1, "longestStreakDays": 1,
        })
        models = {(item["protocol"], item["model"]): item for item in result["models"]}
        self.assertEqual(models[("openai", "gpt-test")]["totalTokens"], 15)
        self.assertEqual(models[("openai", "gpt-test")]["requestCount"], 2)
        self.assertEqual(models[("anthropic", "claude-test")]["inputTokens"], 4)
        self.assertIn((None, None), models)  # Missing model metadata stays explicitly unknown.

    def test_provider_usage_range_filters_records_without_estimates(self):
        now = _ts(year=2024, month=3, day=10)
        session = {
            "id": "task",
            "provider_usage": [
                {"at": _dt.datetime.fromtimestamp(now).isoformat(), "usage": {"input_tokens": 8, "output_tokens": 2}},
                {"at": _dt.datetime.fromtimestamp(now - 40 * DAY).isoformat(), "usage": {"input_tokens": 100, "output_tokens": 100}},
                {"at": _dt.datetime.fromtimestamp(now).isoformat(), "usage": {"prompt_tokens": 4}},
            ],
        }

        class FakeStore:
            def list(self):
                return [{"id": "task", "mtime": now}]

            def load(self, _sid):
                return session

        week = usage_api.build_usage({"store": FakeStore()}, "7d", now=now)
        self.assertEqual(week["tokens"]["total"], 10)
        self.assertEqual(week["tokens"]["unknownRequests"], 1)
        self.assertEqual(len(week["dailyUsage"]), 1)
        self.assertEqual(week["models"][0]["totalTokens"], 10)


if __name__ == "__main__":
    unittest.main()
