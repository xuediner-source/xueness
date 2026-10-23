/**
 * Sessions-owned work segments (`sessions/work_activity.py`).
 *
 * A run opens a segment with an in-process monotonic clock; a journal save
 * that observes a waiting or terminal state closes it with the measured
 * `active_ms`. Nothing is inferred from wall-clock subtraction: a segment
 * whose process died keeps no duration, and a clock from another process
 * (Python or an earlier TypeScript process) is never known here.
 */
import {
  isDict, isPyFloatValue, isPyIntValue, numericValue, PyAttributeError, pyDictGet, pyEquals, pyFloatValue, pyLen, pyRound,
  pyTruthy, PyTypeError, pyTypeName, pyUtcNow, uuid4Hex,
} from "@xueness/contracts";

export const MAX_SEGMENTS = 256;
const CLOCKS = new Map<string, number>();
const RUNS = new Map<object, string>();
const STATES = new Set(["running", "completed", "stopped", "failed", "waiting_approval", "waiting_user", "paused", "unknown", "continued"]);
const STATUS_STATES: Record<string, string> = {
  running: "running", completed: "completed", stopped: "stopped", provider_error: "failed", error: "failed", failed: "failed",
  awaiting_user: "waiting_user", paused: "waiting_approval", needs_review: "paused",
};

type Row = Record<string, unknown>;

function trim<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_SEGMENTS) map.delete(map.keys().next().value as K);
}

/** `{...}.get(status, 'unknown')`; an unhashable status raises like Python. */
function state(session: Row): string {
  const status = pyDictGet(session, "status");
  if (status === "paused") return pyDictGet(session, "pause_code") === "approval_required" ? "waiting_approval" : "paused";
  unhashable(status);
  return typeof status === "string" && Object.hasOwn(STATUS_STATES, status) ? STATUS_STATES[status]! : "unknown";
}

function unhashable(value: unknown): void {
  if (Array.isArray(value) || isDict(value)) throw new PyTypeError(`unhashable type: '${pyTypeName(value)}'`);
}

function rows(session: Row): unknown[] {
  const value = pyDictGet(session, "work_segments");
  return Array.isArray(value) ? value.slice(-MAX_SEGMENTS) : [];
}

function clockKey(row: Row): string | null {
  const id = pyDictGet(row, "id");
  unhashable(id);
  return typeof id === "string" ? id : null;
}

function close(row: Row, next: string): void {
  const key = clockKey(row);
  const started = key === null ? undefined : CLOCKS.get(key);
  if (key !== null) CLOCKS.delete(key);
  const duration = started !== undefined ? performance.now() - started : null;
  row.active_ms = duration !== null && Number.isFinite(duration) && duration >= 0 ? pyFloatValue(pyRound(duration, 3)) : null;
  row.state = next;
  row.ended_at = pyUtcNow();
}

/** `start`: close any running segment and open a new one for `turnId`. */
export function startWork(session: Row, options: { reason?: string; turnId?: unknown } = {}): void {
  const reason = options.reason ?? "run";
  const turnId = pyTruthy(options.turnId) ? options.turnId : pyDictGet(session, "active_turn_id");
  if (typeof turnId !== "string" || !turnId || pyLen(turnId) > 128) return;
  const existing = rows(session);
  for (const row of existing) {
    if (isDict(row) && row.state === "running") close(row, reason === "guidance" ? "continued" : "unknown");
  }
  const messages = pyDictGet(session, "messages");
  if (pyTruthy(messages) && !Array.isArray(messages) && !isDict(messages) && typeof messages !== "string") {
    throw new PyTypeError(`'${pyTypeName(messages)}' object is not reversible`);
  }
  let anchor: unknown = null;
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (isDict(message) && message._turn_id === turnId && message.role === "user") {
      anchor = pyDictGet(message, "_message_id");
      break;
    }
  }
  const row: Row = { id: uuid4Hex(), turn_id: turnId, reason, anchor_message_id: anchor, state: "running", active_ms: null, started_at: pyUtcNow() };
  CLOCKS.set(row.id as string, performance.now());
  RUNS.set(session, row.id as string);
  trim(RUNS);
  trim(CLOCKS);
  const retained = [...existing, row].slice(-MAX_SEGMENTS);
  const first = existing[0];
  if (existing.length >= MAX_SEGMENTS && isDict(first)) {
    const head = retained[0];
    if (!isDict(head)) throw new PyAttributeError(`'${pyTypeName(head)}' object has no attribute 'get'`);
    if (pyEquals(pyDictGet(head, "turn_id"), pyDictGet(first, "turn_id"))) head.prefix_missing = true;
  }
  session.work_segments = retained;
}

/** `checkpoint`: a save that observes a waiting or terminal state closes running segments. */
export function checkpointWork(session: Row): void {
  const next = state(session);
  if (next === "running") return;
  for (const row of rows(session)) {
    if (isDict(row) && row.state === "running" && row.reason !== "approval_replay") close(row, next);
  }
}

/** `settle`: close the segment this process opened for the run. */
export function settleWork(session: Row, options: { returned?: boolean } = {}): void {
  const returned = options.returned ?? true;
  const owned = RUNS.get(session);
  RUNS.delete(session);
  let next = returned ? state(session) : "failed";
  if (next === "running") next = "unknown";
  for (const row of rows(session)) {
    if (!isDict(row) || !pyEquals(pyDictGet(row, "id"), owned ?? null)) continue;
    if (row.state === "running") close(row, next);
    else if (!returned) row.state = "failed";
  }
}

/** `replay_finished`: close approval-replay segments after a host execution. */
export function replayFinished(session: Row, outcome: unknown): void {
  RUNS.delete(session);
  const next = outcome === "succeeded" ? "continued" : outcome === "failed" ? "failed" : outcome === "waiting" ? "waiting_approval" : "unknown";
  for (const row of rows(session)) {
    if (isDict(row) && row.state === "running" && row.reason === "approval_replay") close(row, next);
  }
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && pyLen(value) <= 128;
}

/** `public_segments`: validated, bounded segments; a running row without a local clock is unknown. */
export function publicSegments(session: Row): Row[] {
  const result: Row[] = [];
  for (const row of rows(session)) {
    if (!isDict(row)) continue;
    unhashable(row.state);
    if (typeof row.state !== "string" || !STATES.has(row.state)) continue;
    if (["id", "turn_id"].some((key) => typeof row[key] !== "string" || !row[key] || pyLen(row[key] as string) > 128)) continue;
    const value: Row = { id: row.id, turn_id: row.turn_id, state: row.state };
    if (row.state === "running" && !CLOCKS.has(row.id as string)) value.state = "unknown";
    for (const key of ["started_at", "ended_at", "anchor_message_id", "reason"]) {
      if (boundedString(row[key])) value[key] = row[key];
    }
    if (row.prefix_missing === true) value.prefix_missing = true;
    const duration = row.active_ms;
    const numeric = isPyIntValue(duration) || isPyFloatValue(duration) ? numericValue(duration) : null;
    value.active_ms = row.state !== "running" && numeric !== null && Number.isFinite(numeric) && numeric >= 0 ? duration : null;
    result.push(value);
  }
  return result;
}
