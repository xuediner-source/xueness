"""Read-only usage aggregation for the Xueness settings UI.

Contract: ``docs/stage2-contract.md`` section "4. 用量（usage）".

The module never writes anything: it only reads the session repository that
``web.py`` puts in ``ctx["store"]``. Standard library only.

Public surface
--------------
``dispatch(method, parts, query, data, ctx)``
    Handles ``GET /api/usage?range=7d|30d|all`` -> ``(200, payload)``.
    Returns ``None`` for anything it does not own.
``build_usage(ctx, range_key=None, now=None)``
    ``ctx -> payload`` convenience wrapper (adds ``updatedAt``).
``aggregate(sessions, range_key=None, now=None)``
    Pure function over ``[{"id", "status", "steps", "mtime": float}]``.
"""
from __future__ import annotations

import datetime as _dt
import math
import re
import time
from pathlib import Path

#: Allowed ``range`` values, in contract order.
RANGES = ("7d", "30d", "all")
#: Used for a missing or unrecognised ``range`` (contract: never an error).
DEFAULT_RANGE = "7d"
#: Window length in seconds for the bounded ranges.
_RANGE_SECONDS = {"7d": 7 * 86400, "30d": 30 * 86400}
#: Session ids are opaque store keys; bound them so a hostile store cannot
#: make us stat outside its own directory.
_SID_RE = re.compile(r"[A-Za-z0-9._-]{1,128}")


def normalize_range(value) -> str:
    """Return a valid range key; anything unknown falls back to ``7d``."""
    if isinstance(value, str):
        candidate = value.strip().lower()
        if candidate in RANGES:
            return candidate
    return DEFAULT_RANGE


def _coerce_now(now=None) -> float:
    """Accept None / int / float / datetime and always yield a timestamp."""
    if now is None:
        return time.time()
    if isinstance(now, _dt.datetime):
        return now.timestamp()
    if isinstance(now, bool):
        return time.time()
    if isinstance(now, (int, float)):
        value = float(now)
        if math.isfinite(value):
            return value
    return time.time()


def _coerce_mtime(value):
    """Return a finite float timestamp, or ``None`` when unusable."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        candidate = float(value)
        return candidate if math.isfinite(candidate) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            pass
        try:
            parsed = _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.timestamp()
    return None


def _coerce_steps(value) -> int:
    """Steps are a non-negative integer; anything else counts as 0."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if value > 0 else 0
    if isinstance(value, float) and math.isfinite(value) and value > 0:
        return int(value)
    return 0


def _day(mtime: float) -> str:
    return _dt.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")


def _iso(ts: float) -> str:
    stamp = _dt.datetime.fromtimestamp(ts, _dt.timezone.utc)
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


def aggregate(sessions, range_key=None, now=None) -> dict:
    """Aggregate normalised sessions into ``{range, totals, series}``.

    ``sessions`` items are ``{"id", "status", "steps", "mtime": float}``.
    ``now`` is injectable so window boundaries are testable; it defaults to
    the wall clock. A session is inside ``7d``/``30d`` when
    ``mtime >= now - window`` (exactly 7 days ago counts, 8 days ago does
    not). ``all`` ignores time entirely. The result never raises: junk rows
    are skipped and an empty input yields zero totals with an empty series.
    """
    key = normalize_range(range_key)
    reference = _coerce_now(now)
    cutoff = None if key == "all" else reference - _RANGE_SECONDS[key]

    totals = {"sessions": 0, "steps": 0, "completed": 0}
    buckets: dict = {}
    for session in sessions or ():
        if not isinstance(session, dict):
            continue
        mtime = _coerce_mtime(session.get("mtime"))
        if mtime is None:
            continue
        if cutoff is not None and mtime < cutoff:
            continue
        steps = _coerce_steps(session.get("steps"))
        totals["sessions"] += 1
        totals["steps"] += steps
        if session.get("status") == "completed":
            totals["completed"] += 1
        day = _day(mtime)
        bucket = buckets.get(day)
        if bucket is None:
            bucket = {"date": day, "sessions": 0, "steps": 0}
            buckets[day] = bucket
        bucket["sessions"] += 1
        bucket["steps"] += steps

    return {"range": key, "totals": totals, "series": [buckets[d] for d in sorted(buckets)]}


def _entry_id(entry):
    if isinstance(entry, dict):
        sid = entry.get("id")
    else:
        sid = getattr(entry, "id", None)
    return sid if isinstance(sid, str) and sid else None


def _entry_mtime(entry):
    if isinstance(entry, dict):
        for field in ("mtime", "updatedAt", "createdAt"):
            mtime = _coerce_mtime(entry.get(field))
            if mtime is not None:
                return mtime
    return None


def _store_directory(store):
    directory = getattr(store, "directory", None)
    if directory is None:
        return None
    try:
        return Path(directory)
    except TypeError:
        return None


def _file_mtime(directory, sid):
    """``<sid>.json`` mtime inside the store directory, or ``None``."""
    if directory is None or not _SID_RE.fullmatch(sid):
        return None
    try:
        stat = (directory / (sid + ".json")).stat()
    except OSError:
        return None
    return _coerce_mtime(stat.st_mtime)


def _session_mtime(session):
    for field in ("mtime", "updatedAt"):
        mtime = _coerce_mtime(session.get(field))
        if mtime is not None:
            return mtime
    return None


def _collect_sessions(store) -> list:
    """Normalise any store-shaped object into aggregate() input.

    Duck typing: only ``.list()`` (ids) and ``.load(sid)`` (full session) are
    used. A session whose ``load`` raises is skipped; a store that cannot even
    list yields no sessions. Nothing here may raise.
    """
    if store is None:
        return []
    try:
        entries = store.list()
    except Exception:
        return []
    if not isinstance(entries, (list, tuple)):
        return []
    directory = _store_directory(store)
    sessions: list = []
    for entry in entries:
        sid = _entry_id(entry)
        if sid is None:
            continue
        try:
            session = store.load(sid)
        except Exception:
            continue
        if not isinstance(session, dict):
            continue
        mtime = _file_mtime(directory, sid)
        if mtime is None:
            mtime = _session_mtime(session)
        if mtime is None:
            mtime = _entry_mtime(entry)
        if mtime is None:
            # Unresolvable timestamp: keep the session visible rather than
            # silently dropping it; it buckets into the current day.
            mtime = time.time()
        sessions.append({
            "id": sid,
            "status": session.get("status"),
            "steps": session.get("steps", 0),
            "mtime": mtime,
            "provider_usage": session.get("provider_usage", []),
        })
    return sessions


def build_usage(ctx, range_key=None, now=None) -> dict:
    """Full usage payload for a ctx dict (read-only)."""
    context = ctx if isinstance(ctx, dict) else {}
    sessions = _collect_sessions(context.get("store"))
    result = aggregate(sessions, range_key, now)
    reference = _coerce_now(now)
    key = normalize_range(range_key)
    cutoff = None if key == 'all' else reference - _RANGE_SECONDS[key]
    tokens = {"input": 0, "output": 0, "total": 0, "reportedRequests": 0, "unknownRequests": 0}
    costs = {}
    daily = {}
    models = {}
    saw_provider_usage = False

    def bucket_for(collection, key, *, model=None, protocol=None):
        bucket = collection.get(key)
        if bucket is None:
            bucket = {
                "inputTokens": 0, "outputTokens": 0, "totalTokens": 0,
                "requestCount": 0, "unknownRequests": 0, "costs": {},
            }
            if model is not None or protocol is not None:
                bucket["model"] = model
                bucket["protocol"] = protocol
            collection[key] = bucket
        return bucket

    def add_cost(bucket_costs, cost):
        if (isinstance(cost, dict) and isinstance(cost.get('currency'), str)
                and type(cost.get('amount')) in (float, int)
                and math.isfinite(cost['amount']) and cost['amount'] >= 0):
            currency = cost['currency'][:10]
            bucket_costs[currency] = bucket_costs.get(currency, 0) + cost['amount']

    for session in sessions:
        for record in session.get("provider_usage", []):
            if not isinstance(record, dict):
                continue
            saw_provider_usage = True
            stamp = _coerce_mtime(record.get("at"))
            if cutoff is not None and (stamp is None or stamp < cutoff):
                continue
            usage = record.get("usage", {})
            if not isinstance(usage, dict):
                usage = {}
            incoming = usage.get("prompt_tokens", usage.get("input_tokens"))
            outgoing = usage.get("completion_tokens", usage.get("output_tokens"))
            if type(incoming) is not int or incoming < 0:
                incoming = None
            if type(outgoing) is not int or outgoing < 0:
                outgoing = None
            total = usage.get("total_tokens")
            if type(total) is not int or total < 0:
                total = incoming + outgoing if incoming is not None and outgoing is not None else None
            if incoming is not None:
                tokens['input'] += incoming
            if outgoing is not None:
                tokens['output'] += outgoing
            if total is not None:
                tokens['total'] += total
            complete_breakdown = incoming is not None and outgoing is not None
            if complete_breakdown:
                tokens['reportedRequests'] += 1
            elif usage:
                tokens['unknownRequests'] += 1

            model_value = record.get("model")
            model = model_value.strip()[:160] if isinstance(model_value, str) and model_value.strip() else None
            protocol_value = record.get("protocol")
            protocol = protocol_value if protocol_value in ("openai", "anthropic") else None
            model_key = (protocol or "", model or "")
            model_bucket = bucket_for(models, model_key, model=model, protocol=protocol)
            model_bucket.setdefault("model", model)
            model_bucket.setdefault("protocol", protocol)
            model_bucket["requestCount"] += 1
            if incoming is not None:
                model_bucket["inputTokens"] += incoming
            if outgoing is not None:
                model_bucket["outputTokens"] += outgoing
            if total is not None:
                model_bucket["totalTokens"] += total
            if not complete_breakdown and usage:
                model_bucket["unknownRequests"] += 1
            add_cost(model_bucket["costs"], record.get("cost"))

            if stamp is not None:
                date = _day(stamp)
                day_bucket = bucket_for(daily, date)
                day_bucket["date"] = date
                day_bucket["requestCount"] += 1
                if incoming is not None:
                    day_bucket["inputTokens"] += incoming
                if outgoing is not None:
                    day_bucket["outputTokens"] += outgoing
                if total is not None:
                    day_bucket["totalTokens"] += total
                if not complete_breakdown and usage:
                    day_bucket["unknownRequests"] += 1
                add_cost(day_bucket["costs"], record.get("cost"))
                day_models = day_bucket.setdefault("models", {})
                daily_model = bucket_for(day_models, model_key, model=model, protocol=protocol)
                daily_model.setdefault("model", model)
                daily_model.setdefault("protocol", protocol)
                daily_model["requestCount"] += 1
                if incoming is not None:
                    daily_model["inputTokens"] += incoming
                if outgoing is not None:
                    daily_model["outputTokens"] += outgoing
                if total is not None:
                    daily_model["totalTokens"] += total
                if not complete_breakdown and usage:
                    daily_model["unknownRequests"] += 1
                add_cost(daily_model["costs"], record.get("cost"))

            cost = record.get("cost")
            add_cost(costs, cost)

    if saw_provider_usage:
        result['tokens'] = tokens
        result['costs'] = costs
        result['costSource'] = 'provider-reported only; missing prices are not estimated'
        result['dailyUsage'] = [
            {**item, "models": sorted(item["models"].values(), key=lambda model: (-model["totalTokens"], -model["requestCount"], model.get("model") or ""))}
            for _, item in sorted(daily.items())
        ]
        result['models'] = sorted(models.values(), key=lambda model: (-model["totalTokens"], -model["requestCount"], model.get("model") or ""))
        active_days = sorted(date for date, item in daily.items() if item["totalTokens"] > 0)
        date_set = set(active_days)
        current_date = _day(reference)
        current_streak = 0
        if current_date in date_set:
            cursor = _dt.datetime.strptime(current_date, "%Y-%m-%d").date()
            while cursor.isoformat() in date_set:
                current_streak += 1
                cursor -= _dt.timedelta(days=1)
        longest_streak = 0
        streak = 0
        previous = None
        for date in active_days:
            current = _dt.datetime.strptime(date, "%Y-%m-%d").date()
            streak = streak + 1 if previous is not None and current == previous + _dt.timedelta(days=1) else 1
            longest_streak = max(longest_streak, streak)
            previous = current
        result['tokenActivity'] = {
            "activeDays": len(active_days),
            "peakDayTokens": max((daily[date]["totalTokens"] for date in daily), default=0),
            "currentStreakDays": current_streak,
            "longestStreakDays": longest_streak,
        }
    result["updatedAt"] = _iso(_coerce_now(now))
    return result


def _range_param(query):
    if not isinstance(query, dict):
        return None
    value = query.get("range")
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    return value


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``GET /api/usage``; return ``None`` for anything else.

    ``range`` is optional and defaults to ``7d``; an unknown value falls back
    to ``7d`` instead of failing.
    """
    del data  # GET has no body; usage is read-only.
    if method != "GET":
        return None
    if list(parts or []) != ["api", "usage"]:
        return None
    return 200, build_usage(ctx, _range_param(query))
