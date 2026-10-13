"""ZCode protocol v4 adapter backed by the Xueness session journal.

The adapter owns protocol receipts and the bounded v4 topic log. Session
content and execution remain owned by the sessions plugin and are reached
through :mod:`runtimes.bridge`.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from ... import plugin_runtime
from ...resources import _atomic_write_json
from .projection import session_to_rows, session_to_snapshot

V4_WIRE_PROTOCOL_VERSION = 3
STATE_FILENAME = "zcode-v4-state.json"
MAX_EVENTS = 2000
MAX_LOG_BYTES = 8 * 1024 * 1024
MAX_COMMANDS = 512
MAX_FRAME_BYTES = 1024 * 1024
MAX_WAIT_MS = 25_000
POLL_SECONDS = 0.2
_SUPPORTED = {"createSession", "sendText", "stop", "forkAssistant"}
_CAS_COMMANDS = {"forkAssistant"}


def _now() -> float:
    return time.time() * 1000


def _strict_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _id(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _fingerprint(item: Mapping[str, Any]) -> str:
    value = {key: item[key] for key in item if key != "issuedAt"}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _new_meta(session_id: str) -> dict[str, Any]:
    return {"id": session_id, "logEpoch": uuid.uuid4().hex, "seq": 0,
            "revision": 0, "events": [], "commands": {}, "projection": None}


class V4Adapter:
    """Durable v4 transport over one real Xueness Store."""

    def __init__(self, state_dir: Path | str, *, store: Any = None,
                 ctx: Mapping[str, Any] | None = None,
                 require_plugin: bool = True):
        self.state_dir = Path(state_dir)
        self.ctx = dict(ctx or {})
        self._direct = store is None and not self.ctx.get("store") and not self.ctx.get("handler")
        self.store = store or self.ctx.get("store")
        if self.store is None:
            from ...core import Store
            self.store = Store(self.state_dir)
        self.ctx.setdefault("state_dir", self.state_dir)
        self.ctx.setdefault("store", self.store)
        self.require_plugin = require_plugin
        self._path = self.state_dir / STATE_FILENAME

    def _guard(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if self.require_plugin:
            plugin_runtime.require_enabled(self.state_dir, "runtimes")
            plugin_runtime.require_enabled(self.state_dir, "sessions")

    @contextmanager
    def _lock(self, session_id: str | None = None) -> Iterator[None]:
        del session_id
        locks = self.state_dir / ".locks"
        locks.mkdir(parents=True, exist_ok=True)
        from ...session_lease import exclusive_lock
        with exclusive_lock(locks, "zcode-v4.lock"):
            yield

    def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return {"version": 2, "sessions": {}, "globalCommands": {}}
        if self._path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("v4 adapter state exceeds size limit")
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("version") not in (1, 2):
            raise ValueError("invalid v4 adapter state")
        raw["version"] = 2
        raw.setdefault("sessions", {})
        raw.setdefault("globalCommands", {})
        if not isinstance(raw["sessions"], dict) or not isinstance(raw["globalCommands"], dict):
            raise ValueError("invalid v4 adapter state")
        for sid, meta in list(raw["sessions"].items()):
            if not isinstance(sid, str) or not isinstance(meta, dict):
                del raw["sessions"][sid]
                continue
            meta.setdefault("id", sid)
            meta.setdefault("logEpoch", uuid.uuid4().hex)
            meta.setdefault("seq", 0)
            meta.setdefault("revision", 0)
            meta.setdefault("events", [])
            meta.setdefault("commands", {})
            meta.setdefault("projection", None)
        return raw

    def _write(self, state: dict[str, Any]) -> None:
        for meta in state.get("sessions", {}).values():
            if not isinstance(meta, dict):
                continue
            events = meta.get("events")
            if isinstance(events, list) and len(events) > MAX_EVENTS:
                meta["events"] = events[-MAX_EVENTS:]
            commands = meta.get("commands")
            if isinstance(commands, dict) and len(commands) > MAX_COMMANDS:
                meta["commands"] = dict(list(commands.items())[-MAX_COMMANDS:])
            cached = meta.get("projection")
            if isinstance(cached, dict) and "fingerprints" not in cached:
                meta["projection"] = self._projection(cached)
        # Full-text stream upserts need byte retention as well as event counts.
        logs = []
        total = 0
        for meta in state.get("sessions", {}).values():
            if not isinstance(meta, dict):
                continue
            sizes = [len(json.dumps(event, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
                     for event in meta.get("events", [])]
            total += sum(sizes)
            logs.append((meta, sizes))
        for meta, sizes in logs:
            count = 0
            for size in sizes:
                if total <= MAX_LOG_BYTES:
                    break
                total -= size
                count += 1
            if count:
                meta["events"] = meta["events"][count:]
        if len(state.get("globalCommands", {})) > MAX_COMMANDS:
            state["globalCommands"] = dict(list(state["globalCommands"].items())[-MAX_COMMANDS:])
        _atomic_write_json(self._path, state)

    def _load(self, sid: str) -> dict[str, Any]:
        try:
            session = self.store.load(sid)
        except (OSError, ValueError, FileNotFoundError) as exc:
            raise KeyError("fault.subscribe.sessionNotFound") from exc
        if not isinstance(session, dict) or session.get("id") != sid:
            raise KeyError("fault.subscribe.sessionNotFound")
        return session

    def _meta(self, state: dict[str, Any], sid: str) -> dict[str, Any]:
        meta = state["sessions"].get(sid)
        if not isinstance(meta, dict):
            meta = _new_meta(sid)
            state["sessions"][sid] = meta
        return meta

    @staticmethod
    def _projection(snapshot: Mapping[str, Any]) -> dict[str, Any]:
        def digest(value):
            return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                separators=(",", ":"), allow_nan=False).encode("ascii")).hexdigest()
        # Cache identities and hashes rather than a second full transcript.
        return {"fingerprints": {key: digest(value) for key, value in snapshot.items()
                    if key not in {"seq", "revision", "logEpoch", "rows"}},
                "rows": {"window": [{"rowId": row["rowId"], "digest": digest(row)}
                         for row in snapshot.get("rows", {}).get("window", [])]}}

    def _sync(self, state: dict[str, Any], sid: str,
              session: Mapping[str, Any] | None = None) -> dict[str, Any]:
        session = dict(session) if session is not None else self._load(sid)
        meta = self._meta(state, sid)
        snapshot = self._snapshot_from_session(session, meta)
        current = self._projection(snapshot)
        previous = meta.get("projection")
        if previous != current:
            before_rows = {row.get("rowId"): row for row in (previous or {}).get("rows", {}).get("window", [])
                           if isinstance(row, dict)}
            after_rows = {row.get("rowId"): row for row in snapshot.get("rows", {}).get("window", [])
                          if isinstance(row, dict)}
            after_digests = {row["rowId"]: row["digest"] for row in current["rows"]["window"]}
            before_ids, after_ids = list(before_rows), list(after_rows)
            if previous is not None and after_ids[:len(before_ids)] != before_ids:
                # v4 row.removed means remove the target AND every later row,
                # not deletion by arbitrary id. Window eviction/reordering and
                # compaction therefore start a fresh snapshot generation.
                meta.update(logEpoch=uuid.uuid4().hex, seq=0, events=[])
                before_rows = {}
            meta["revision"] = int(meta.get("revision", 0)) + 1
            # Advance ``seq`` only when a concrete delta is appended below.
            # Incrementing it before constructing events leaves an unfilled
            # sequence number that a resume client can never replay.
            state_patch = {key: copy.deepcopy(snapshot[key]) for key in snapshot
                           if key not in {"protocolVersion", "sessionId", "logEpoch",
                                          "seq", "revision", "rows"}
                           and current["fingerprints"].get(key) != (previous or {}).get("fingerprints", {}).get(key)}
            state_patch["revision"] = meta["revision"]
            events = []
            for row_id in after_rows:
                if row_id in before_rows:
                    continue
                meta["seq"] += 1
                events.append({"seq": meta["seq"], "delta": {"op": "row.appended", "row": copy.deepcopy(after_rows[row_id])}})
            for row_id in after_rows:
                if row_id in before_rows and after_digests[row_id] != before_rows[row_id].get("digest"):
                    meta["seq"] += 1
                    events.append({"seq": meta["seq"], "delta": {"op": "row.upserted", "row": copy.deepcopy(after_rows[row_id])}})
            meta["seq"] += 1
            events.append({"seq": meta["seq"], "delta": {"op": "state.updated", "patch": state_patch}})
            meta.setdefault("events", []).extend(events)
            meta["events"] = meta["events"][-MAX_EVENTS:]
            meta["projection"] = current
        snapshot["seq"] = meta["seq"]
        snapshot["revision"] = meta["revision"]
        snapshot["logEpoch"] = meta["logEpoch"]
        return snapshot

    def _snapshot_from_session(self, session: Mapping[str, Any], meta: Mapping[str, Any]) -> dict[str, Any]:
        snapshot = session_to_snapshot(session, log_epoch=str(meta.get("logEpoch", "")),
                                       seq=int(meta.get("seq", 0)),
                                       revision=int(meta.get("revision", 0)))
        status = session.get("status")
        rows = snapshot["rows"]["window"]
        fork_allowed = status != "running" and any(row.get("kind") == "assistantText" for row in rows)
        enabled = {"allowed": True}
        fork = {"allowed": fork_allowed}
        if not fork_allowed:
            fork["reasonCode"] = "guard.noSafeForkBoundary"
        unsupported = {"allowed": False, "reasonCode": "proto.unsupportedCommand"}
        snapshot.update({
            "availability": {"fork": fork, "compact": copy.deepcopy(unsupported),
                              "switchModelConfig": copy.deepcopy(enabled), "setFollowupMode": copy.deepcopy(unsupported),
                              "queueEdit": copy.deepcopy(unsupported), "sendQueuedNow": copy.deepcopy(unsupported),
                              "pauseGoal": copy.deepcopy(unsupported), "resumeGoal": copy.deepcopy(unsupported)},
            "inputRouting": {"mode": "enqueue" if status == "running" else "startNow"},
            "meta": {**snapshot["meta"], "title": session.get("title") or session.get("task", ""),
                     "titleSource": session.get("title_source") if session.get("title_source") in {"default", "generated", "custom"}
                     else ("custom" if session.get("title") else "default")},
            "queue": {"items": [], "autoDrain": True}, "pendingInteractions": [],
            "pendingCommands": [], "backgroundWorks": [],
            "subagents": {"revision": 0, "childSessionIds": [], "running": [], "endedTotal": 0},
            "goal": None, "plan": None, "workspaceHookAdmission": None,
        })
        snapshot["meta"]["session"] = self._public_session(session)
        if not self._direct:
            worker = self._bridge().worker(str(session.get("id", "")))
            running = worker is not None and not worker.done.is_set()
            running = running or str(session.get("id", "")) in self.ctx.get("running", set())
            if running:
                snapshot["control"].update({"phase": "running", "sessionEnded": False,
                    "canStop": True, "stopState": "stoppable", "stopTargetKind": "assistant"})
                if worker:
                    active = {"kind": "primaryTurn", "startedAt": worker.started_at}
                    active["foregroundExecutionId"] = worker.execution_id
                    snapshot["control"]["activeWorks"] = [active]
        return snapshot

    def _public_session(self, session: Mapping[str, Any]) -> dict[str, Any]:
        from ..sessions.http_routes import public_session_payload
        if self.ctx.get("lock") is not None and self.ctx.get("approvals") is not None:
            return public_session_payload(self.ctx, dict(session))
        # Local protocol-only callers have no web services. Keep a narrow
        # source-derived detail envelope without private messages or secrets.
        return {key: copy.deepcopy(session[key]) for key in (
            "id", "task", "title", "root", "status", "steps", "runtime_mode", "runtime_profile",
            "streaming", "completion", "pending_question", "history_revision") if key in session} | {
                "pending": [], "approved": {}, "changed_files": []}

    def conversation_page(self, params: Mapping[str, Any]) -> dict[str, Any]:
        """Read older rows from the same projection, guarded by source revision."""
        self._guard()
        item = _strict_object(params, "conversation page")
        if set(item) != {"sessionId", "before", "messageRevision"}:
            raise ValueError("invalid conversation page fields")
        sid = _id(item["sessionId"], "sessionId")
        session = self._load(sid)
        from ..sessions.message_actions import revision
        if item["messageRevision"] != revision(session):
            raise ValueError("conversation changed; retry loading older rows")
        snapshot = session_to_snapshot(session, before=item["before"])
        snapshot["meta"]["session"] = self._public_session(session)
        return snapshot

    def hello(self, message: Mapping[str, Any]) -> dict[str, Any]:
        self._guard()
        item = _strict_object(message, "client hello")
        if set(item) - {"kind", "protocolVersion", "clientId", "clientKind", "appVersion", "capabilities"}:
            raise ValueError("unknown clientHello fields")
        if item.get("kind") != "clientHello" or item.get("protocolVersion") != V4_WIRE_PROTOCOL_VERSION:
            raise ValueError("unsupported v4 clientHello")
        _id(item.get("clientId"), "clientId"); _id(item.get("appVersion"), "appVersion")
        kind = item.get("clientKind", "desktop")
        if kind not in {"desktop", "web", "mobileRemote", "mobileApp"}:
            raise ValueError("invalid clientKind")
        return {"kind": "hello", "protocolVersion": V4_WIRE_PROTOCOL_VERSION,
                "connectionId": uuid.uuid4().hex,
                "clientMode": "desktop-continuous" if kind == "desktop" else "web-remote-replayable",
                "deliveryProfile": "continuous" if kind == "desktop" else "replayable",
                "serverTime": _now(), "capabilities": {"nativeDialogs": False,
                "localTerminal": False, "binaryFrames": False, "compression": "none"}, "auth": {}}

    def subscribe(self, params: Mapping[str, Any], *, wait_ms: int = 0) -> tuple[dict[str, Any], dict[str, Any]]:
        """Bounded long poll; every observation is one authoritative Store read.

        No background worker is retained. A disconnected caller can resume
        with the last applied logEpoch/seq. Never hold the journal lock while
        waiting for a writer, and recheck plugin revocation at each poll.
        """
        if type(wait_ms) is not int or not 0 <= wait_ms <= MAX_WAIT_MS:
            raise ValueError("waitMs must be an integer between 0 and 25000")
        params = _strict_object(params, "subscribe params")
        deadline = time.monotonic() + wait_ms / 1000
        signature = None
        refresh_at = 0.0
        while True:
            self._guard()
            sid = str(params.get("topic", "")).split("/", 1)[-1]
            current_signature = self._source_signature(sid)
            now = time.monotonic()
            if current_signature != signature or now >= refresh_at or now >= deadline:
                ack, frame = self._subscribe_once(params)
                signature, refresh_at = current_signature, now + 2
                if (ack["mode"] == "snapshot" or frame["payload"].get("deltas")
                        or time.monotonic() >= deadline):
                    return ack, frame
            time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))

    def _source_signature(self, sid: str) -> tuple[Any, ...]:
        # Validate the identity through Store before using it as a path.
        path = self.store._path(sid)
        directory = Path(self.store.directory)
        result = []
        for candidate in (path, directory / "session-message-queues" / (sid + ".json"),
                          directory / "session-turn-inputs" / (sid + ".json")):
            try:
                stat = candidate.stat()
                result.append((stat.st_size, stat.st_mtime_ns, stat.st_ino))
            except FileNotFoundError:
                result.append(None)
        return tuple(result)

    def _subscribe_once(self, params: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        self._guard()
        item = _strict_object(params, "subscribe params")
        if set(item) - {"topic", "base", "visibility"}:
            raise ValueError("unknown subscribe fields")
        topic = _id(item.get("topic"), "topic")
        if topic is None or not topic.startswith("conversation/"):
            raise ValueError("only conversation topics are supported")
        sid = topic.split("/", 1)[1]
        base = item.get("base")
        if base is not None and (not isinstance(base, dict) or set(base) != {"logEpoch", "seq"}
                                 or not isinstance(base.get("logEpoch"), str)
                                 or type(base.get("seq")) is not int or base["seq"] < 0):
            raise ValueError("base must contain logEpoch and a nonnegative integer seq")
        with self._lock(sid):
            state = self._read(); session = self._load(sid)
            old_meta = state["sessions"].get(sid)
            old_watermark = (old_meta.get("logEpoch"), old_meta.get("seq")) if old_meta else None
            snapshot = self._sync(state, sid, session); meta = self._meta(state, sid)
            sub_id = uuid.uuid4().hex
            epoch, seq = meta["logEpoch"], int(meta["seq"])
            requested = base.get("seq") if isinstance(base, dict) else None
            resume = (isinstance(base, dict) and base.get("logEpoch") == epoch
                      and type(requested) is int and 0 <= requested <= seq)
            events = meta.get("events", []); first = events[0]["seq"] if events else seq + 1
            if resume and requested < first - 1: resume = False
            replay = [event for event in events if isinstance(event, dict) and event.get("seq", -1) > (requested if type(requested) is int else seq)]
            if resume and [event["seq"] for event in replay] != list(range(requested + 1, seq + 1)):
                resume = False
            if resume:
                payload = {"kind": "deltas", "deltas": [copy.deepcopy(event["delta"])
                           for event in replay]}; mode, from_seq = "resume", requested
            else:
                payload, mode, from_seq = {"kind": "snapshot", "snapshot": snapshot}, "snapshot", 0
            if old_watermark != (epoch, seq):
                self._write(state)
            return ({"subscriptionId": sub_id, "mode": mode, "logEpoch": epoch},
                    {"topic": topic, "subscriptionId": sub_id, "fromSeq": from_seq,
                     "toSeq": seq, "sentAt": _now(), "payload": payload})

    def _ack(self, cid: str, status: str, revision: int, *, reason: str | None = None,
             result: dict[str, Any] | None = None) -> dict[str, Any]:
        ack: dict[str, Any] = {"commandId": cid, "status": status, "revisionAtDecision": revision}
        if reason: ack["reasonCode"] = reason
        if result is not None: ack["result"] = result
        return ack

    def _store_receipt(self, bucket: dict[str, Any], cid: str, client: str,
                       digest: str, ack: dict[str, Any]) -> None:
        bucket[cid] = {"clientId": client, "fingerprint": digest, "ack": copy.deepcopy(ack)}

    def _previous(self, bucket: Mapping[str, Any], cid: str, client: str, digest: str) -> dict[str, Any] | None:
        previous = bucket.get(cid)
        if not isinstance(previous, dict): return None
        if previous.get("clientId") != client or previous.get("fingerprint") != digest:
            return self._ack(cid, "rejected", 0, reason="proto.commandIdReuse")
        return copy.deepcopy(previous.get("ack")) if isinstance(previous.get("ack"), dict) else None

    def _error_ack(self, cid: str, reason: str, revision: int = 0) -> dict[str, Any]:
        return self._ack(cid, "rejected", revision, reason=reason)

    def _commit(self, state: dict[str, Any], bucket: dict[str, Any], cid: str,
                client: str, digest: str, ack: dict[str, Any]) -> dict[str, Any]:
        self._store_receipt(bucket, cid, client, digest, ack); self._write(state); return ack

    def _bridge(self):
        from .bridge import create_execution_bridge
        return create_execution_bridge(self.ctx)

    def command(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        self._guard(); item = _strict_object(envelope, "command envelope")
        allowed = {"ttft", "commandId", "clientId", "sessionId", "baseRevision", "baseLogEpoch", "type", "payload", "issuedAt"}
        if set(item) - allowed: raise ValueError("unknown command envelope fields")
        cid = _id(item.get("commandId"), "commandId"); client = _id(item.get("clientId"), "clientId")
        if cid is None or client is None: raise ValueError("commandId and clientId are required")
        issued = item.get("issuedAt")
        if isinstance(issued, bool) or not isinstance(issued, (int, float)) or not math.isfinite(float(issued)):
            raise ValueError("issuedAt must be a finite number")
        typ = item.get("type"); payload = _strict_object(item.get("payload", {}), "command payload")
        sid = _id(item.get("sessionId"), "sessionId", nullable=True); digest = _fingerprint(item)
        with self._lock(sid):
            state = self._read(); bucket = state["globalCommands"] if sid is None else self._meta(state, sid)["commands"]
            prior = self._previous(bucket, cid, client, digest)
            if prior is not None: return prior
            if typ not in _SUPPORTED:
                ack = self._error_ack(cid, "proto.unsupportedCommand"); return self._commit(state, bucket, cid, client, digest, ack)
            if (typ == "createSession" and sid is not None) or (typ != "createSession" and sid is None):
                ack = self._error_ack(cid, "proto.invalidSessionId"); return self._commit(state, bucket, cid, client, digest, ack)
            if typ in _CAS_COMMANDS and (type(item.get("baseRevision")) is not int or not isinstance(item.get("baseLogEpoch"), str)):
                ack = self._error_ack(cid, "proto.invalidCas"); return self._commit(state, bucket, cid, client, digest, ack)
            allowed_payload = {
                "createSession": {"workspaceId", "firstInput", "modelSelection", "runtimeMode"},
                "sendText": {"text", "requestedDelivery", "modelSelection"},
                "stop": {"expectedForegroundExecutionId"},
                "forkAssistant": {"target"},
            }[typ]
            if set(payload) - allowed_payload:
                ack = self._error_ack(cid, "proto.unknownPayloadField")
                return self._commit(state, bucket, cid, client, digest, ack)
            if typ == "createSession": return self._create(state, cid, client, digest, payload)
            session = self._load(sid)  # type: ignore[arg-type]
            meta = self._meta(state, sid)  # type: ignore[arg-type]
            self._sync(state, sid, session)  # type: ignore[arg-type]
            if isinstance(item.get("baseLogEpoch"), str) and item["baseLogEpoch"] != meta["logEpoch"]:
                ack = self._ack(cid, "stale", meta["revision"], reason="proto.staleEpoch"); return self._commit(state, bucket, cid, client, digest, ack)
            if type(item.get("baseRevision")) is int and item["baseRevision"] != meta["revision"]:
                ack = self._ack(cid, "stale", meta["revision"], reason="proto.staleRevision"); return self._commit(state, bucket, cid, client, digest, ack)
            if typ == "sendText": return self._send(state, sid, cid, client, digest, payload)
            if typ == "stop": return self._stop(state, sid, cid, client, digest, payload, session)
            return self._fork(state, sid, cid, client, digest, payload, session)

    def _create(self, state, cid, client, digest, payload):
        workspace, first = payload.get("workspaceId"), payload.get("firstInput")
        if not isinstance(workspace, str) or not workspace.strip():
            ack = self._error_ack(cid, "proto.invalidPayload"); return self._commit(state, state["globalCommands"], cid, client, digest, ack)
        if first is not None and (not isinstance(first, dict)
                                  or set(first) - {"text", "modelSelection", "mode"}):
            ack = self._error_ack(cid, "proto.unsupportedCapability"); return self._commit(state, state["globalCommands"], cid, client, digest, ack)
        try:
            if self._direct:
                task = first.get("text") if isinstance(first, dict) else "New conversation"
                if not isinstance(task, str) or not task.strip():
                    raise ValueError("firstInput.text must be a non-empty string")
                session = self.store.new(task.strip(), self.state_dir)
                session["workspace_id"] = workspace.strip(); self.store.save(session)
                status, body = 200, {"id": session["id"]}
            else:
                status, body = self._bridge().create_session(workspace, first_input=first,
                    runtime_mode=payload.get("runtimeMode"), model_selection=payload.get("modelSelection"))
            if status >= 400: raise ValueError(str((body or {}).get("error", "session creation failed")))
            sid = body["id"]; meta = self._meta(state, sid); session = self._load(sid); self._sync(state, sid, session)
            result = {"type": "createSession", "sessionId": sid}
            if isinstance(first, dict):
                text = first.get("text")
                if not isinstance(text, str) or not text.strip(): raise ValueError("firstInput.text must be a non-empty string")
                if self._direct:
                    result["input"] = {"delivery": "startNow", "inputId": uuid.uuid4().hex}
                else:
                    run_status, run = self._bridge().start_run_async(sid, options={"mode": first.get("mode", "build")})
                    if run_status >= 400: raise ValueError(str((run or {}).get("error", "cannot start session")))
                    result["input"] = {"delivery": "startNow", "inputId": uuid.uuid4().hex, "executionId": run["executionId"]}
            ack = self._ack(cid, "accepted", meta["revision"], result=result)
        except (OSError, ValueError, KeyError, TypeError):
            ack = self._error_ack(cid, "fault.sessionCreateFailed")
        return self._commit(state, state["globalCommands"], cid, client, digest, ack)

    def _send(self, state, sid, cid, client, digest, payload):
        meta = self._meta(state, sid); delivery = payload.get("requestedDelivery", "startNow")
        text = payload.get("text")
        if delivery != "startNow":
            ack = self._ack(cid, "rejected", meta["revision"], reason="proto.unsupportedDelivery"); return self._commit(state, meta["commands"], cid, client, digest, ack)
        if not isinstance(text, str) or not text.strip():
            ack = self._error_ack(cid, "proto.invalidPayload", meta["revision"]); return self._commit(state, meta["commands"], cid, client, digest, ack)
        try:
            if self._direct:
                from ...core import append_user_turn
                from ...session_lease import lease
                with lease(self.store, sid):
                    append_user_turn(self.store.load(sid), self.store, text)
                run = {}
            else:
                status, body = self._bridge().append_message(sid, text, model_selection=payload.get("modelSelection"))
                if status >= 400: raise ValueError(str((body or {}).get("error", "message rejected")))
                run_status, run = self._bridge().start_run_async(sid, options={})
                if run_status >= 400: raise ValueError(str((run or {}).get("error", "run rejected")))
            self._sync(state, sid, self._load(sid)); meta = self._meta(state, sid)
            result = {"type": "inputAccepted", "delivery": "startNow", "inputId": uuid.uuid4().hex}
            if run.get("executionId"):
                result["executionId"] = run["executionId"]
            ack = self._ack(cid, "accepted", meta["revision"], result=result)
        except (OSError, ValueError, KeyError, TypeError):
            ack = self._ack(cid, "rejected", meta["revision"], reason="fault.inputRejected")
        return self._commit(state, meta["commands"], cid, client, digest, ack)

    def _stop(self, state, sid, cid, client, digest, payload, session):
        meta = self._meta(state, sid)
        busy = session.get("status") == "running" or sid in self.ctx.get("running", set())
        if not self._direct:
            worker = self._bridge().worker(sid)
            busy = busy or (worker is not None and not worker.done.is_set())
        if not busy:
            ack = self._ack(cid, "rejected", meta["revision"], reason="guard.notStoppable"); return self._commit(state, meta["commands"], cid, client, digest, ack)
        expected = payload.get("expectedForegroundExecutionId")
        worker = None if self._direct else self._bridge().worker(sid)
        if expected is not None and (worker is None or expected != worker.execution_id):
            ack = self._ack(cid, "stale", meta["revision"], reason="proto.staleExecution"); return self._commit(state, meta["commands"], cid, client, digest, ack)
        try:
            if self._direct:
                def stop_direct(current):
                    current["status"] = "stopped"
                    return True
                self.store.update(sid, stop_direct)
            else:
                status, body = self._bridge().stop(sid, expected_execution_id=expected)
                if status >= 400: raise ValueError(str((body or {}).get("error", "stop rejected")))
            ack = self._ack(cid, "accepted", meta["revision"], result={"type": "inputDisposition", "delivery": "startNow"})
        except (OSError, ValueError, KeyError):
            ack = self._ack(cid, "rejected", meta["revision"], reason="fault.stopRejected")
        return self._commit(state, meta["commands"], cid, client, digest, ack)

    def _fork(self, state, sid, cid, client, digest, payload, session):
        meta = self._meta(state, sid); target = payload.get("target")
        try:
            rows = session_to_rows(session, session_id=sid, tail=60)
            row = next(row for row in rows if isinstance(target, dict) and
                       (row.get("rowId") == target.get("rowId") or row.get("entityId") == target.get("entityId")))
            turn = int(str(row.get("turnId", "")).split("-", 1)[1])
            from ..sessions.forking import fork_turn
            result = fork_turn(self.ctx, sid, turn=turn, enforce_workspace=True)
            child = result["session"]["id"]; self._meta(state, child); self._sync(state, child, self._load(child))
            ack = self._ack(cid, "accepted", meta["revision"], result={"type": "forkAssistant", "sessionId": child})
        except (StopIteration, ValueError, KeyError, OSError, TypeError):
            ack = self._ack(cid, "rejected", meta["revision"], reason="fault.forkUnavailable")
        return self._commit(state, meta["commands"], cid, client, digest, ack)

    def query_commands(self, keys: list[Mapping[str, Any]]) -> list[dict[str, Any] | str]:
        self._guard()
        if not isinstance(keys, list) or not keys or len(keys) > 64: raise ValueError("commands query requires 1..64 keys")
        with self._lock():
            state = self._read(); result: list[dict[str, Any] | str] = []
            for raw in keys:
                key = _strict_object(raw, "command key")
                if set(key) != {"sessionId", "commandId"}: raise ValueError("invalid command key")
                cid = _id(key.get("commandId"), "commandId"); sid = _id(key.get("sessionId"), "sessionId", nullable=True)
                bucket = state["globalCommands"] if sid is None else state["sessions"].get(sid, {}).get("commands", {})
                entry = bucket.get(cid) if isinstance(bucket, dict) else None
                result.append(copy.deepcopy(entry["ack"]) if isinstance(entry, dict) and isinstance(entry.get("ack"), dict) else "unknown")
            return result


def create_adapter(ctx: Mapping[str, Any]) -> V4Adapter:
    state_dir = ctx.get("state_dir")
    if state_dir is None: raise ValueError("runtime state directory is unavailable")
    return V4Adapter(state_dir, store=ctx.get("store"), ctx=ctx)
