import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDict, JsonFloat, pyDeepCopy, pyJsonDumps } from "@xueness/contracts";
import {
  checkpointWork, ensureMessageIdentity, preserveInterruptedPartial, publicSegments, replayFinished, settleReasoningTiming,
  settleWork, startWork, SYSTEM_PROMPT,
} from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";
import { oracle } from "./oracle.ts";

const skip = pythonUnavailableReason() ?? false;
type Row = Record<string, unknown>;
const HEX = "0123456789abcdef";

function hexId(f: SessionFactory): string {
  return Array.from({ length: 32 }, () => HEX[f.int(16)]).join("");
}

function identitySession(f: SessionFactory): Row {
  const session = f.session() as Row;
  const ids = [hexId(f), hexId(f), "not-hex", "ABCDEF0123456789ABCDEF0123456789"];
  for (const message of (session.messages as unknown[])) {
    if (!isDict(message)) continue;
    if (f.chance(0.5)) message._message_id = f.pick<unknown>([...ids, 7, null]);
    if (f.chance(0.3)) message._turn_id = f.pick<unknown>(["turn-2", "turn-5", "turn-0", "turn-007", "turn-123456789012345678901", 3, null]);
  }
  if (f.chance(0.6)) session._turn_count = f.pick<unknown>([0, 3, 9, -1, "4", true, new JsonFloat(2), 123456789012345678901n]);
  return session;
}

/** Freshly generated ids are random on both sides; kept ids must match exactly. */
function maskNewIds(before: Row, after: Row): Row {
  const out = pyDeepCopy(after);
  const original = (before.messages as unknown[]) ?? [];
  ((out.messages as unknown[]) ?? []).forEach((message, index) => {
    if (isDict(message) && isDict(original[index]) && message._message_id !== (original[index] as Row)._message_id) message._message_id = "<new>";
    else if (isDict(message) && !isDict(original[index])) message._message_id = "<new>";
  });
  return out;
}

describe("message identity", { skip }, () => {
  it("assigns turn and message ids like _ensure_message_identity", () => {
    const f = new SessionFactory(41);
    const sessions = Array.from({ length: 300 }, () => identitySession(f));
    const expected = oracle({ op: "identity", sessions }) as Row[];
    sessions.forEach((session, index) => {
      const before = pyDeepCopy(session);
      const reply = expected[index]!;
      let actual: Row;
      try {
        ensureMessageIdentity(session);
        actual = { ok: maskNewIds(before, session) };
      } catch (error) {
        actual = { error: (error as Error).name };
      }
      const want = reply.ok ? { ok: maskNewIds(before, reply.ok as Row) } : reply;
      assert.deepEqual(actual, want, pyJsonDumps(before));
    });
  });

  it("copies the system prompt verbatim", () => {
    assert.equal(SYSTEM_PROMPT, oracle({ op: "system" }));
  });
});

function streamSession(f: SessionFactory): { session: Row; turn_id: unknown; previous: unknown } {
  const sid = "0123456789abcdef0123456789abcdef";
  const messages: unknown[] = [];
  for (let index = 0, count = 1 + f.int(6); index < count; index += 1) {
    messages.push({
      role: f.pick(["user", "assistant", "tool", "assistant", "system"]), content: f.text(),
      _turn_id: f.pick(["turn-1", "turn-1", "turn-2", "turn-3"]), _message_id: f.chance(0.9) ? hexId(f) : f.pick<unknown>(["bad", 4]),
    });
  }
  const stream: Row = {
    id: f.chance(0.9) ? sid : f.pick<unknown>(["short", 5]), status: f.chance(0.85) ? "interrupted" : "completed",
    interrupted: f.chance(0.85) ? true : f.pick<unknown>([false, 1]), final_message_index: f.chance(0.85) ? null : f.pick<unknown>([0, 2]),
    text: f.pick<unknown>(["partial", "partial", "", null, f.text()]), reasoning: f.pick<unknown>(["", "thinking", null]),
    reasoning_started_at: "2026-10-18T00:00:00+00:00", reasoning_ended_at: f.pick<unknown>([null, "2026-10-18T00:00:01+00:00"]),
  };
  if (f.chance(0.2)) Object.assign(stream, { transcript_partial: true, transcript_turn_id: f.pick(["turn-1", "turn-2"]), after_message_id: f.chance(0.5) ? (messages[0] as Row | undefined)?._message_id ?? "x" : hexId(f) });
  const session: Row = { id: sid, status: f.chance(0.85) ? "stopped" : "completed", messages, streaming: stream };
  if (f.chance(0.2)) session.interrupted_transcripts = f.chance(0.5) ? [{ stream_id: sid, turn_id: f.pick(["turn-1", "turn-2"]), after_message_id: f.chance(0.5) ? "x" : (messages.at(-1) as Row | undefined)?._message_id ?? "y", text: f.pick(["", "old"]), reasoning: "" }] : f.scalar();
  if (f.chance(0.6)) {
    session.stream_history = Array.from({ length: f.int(4) }, () => ({
      final_message_index: f.pick<unknown>([0, 1, 2, 5, -1, null, true, new JsonFloat(1)]),
      reasoning_started_at: f.pick<unknown>(["2026-10-18T00:00:00.5+00:00", "", null, "x".repeat(41)]),
      reasoning_ended_at: f.pick<unknown>(["2026-10-18T00:00:02+00:00", 5]),
    }));
  }
  if (f.chance(0.4)) session.reasoning_timing = [{ message_index: f.pick<unknown>([0, 1, 9]), started_at: "a", ended_at: "b" }, f.scalar()];
  return { session, turn_id: f.pick<unknown>(["turn-1", "turn-2", "turn-1", "turn-x", 3]), previous: f.pick<unknown>([null, null, sid, "other"]) };
}

describe("transcript projections", { skip }, () => {
  it("preserve interrupted partials and settle reasoning timing like history.py", () => {
    const f = new SessionFactory(7);
    const cases = Array.from({ length: 400 }, () => streamSession(f));
    const expected = oracle({ op: "transcript", cases }) as Row[];
    // Guard against a vacuous comparison: both outcomes must occur.
    const changed = expected.filter((reply) => reply.changed === true).length;
    assert.ok(changed > 20 && changed < 380, `${changed} changed`);
    cases.forEach((item, index) => {
      const session = pyDeepCopy(item.session);
      let actual: Row;
      try {
        const changed = preserveInterruptedPartial(session, item.turn_id, { previousStreamId: item.previous });
        settleReasoningTiming(session);
        actual = { changed, session };
      } catch (error) {
        actual = { error: (error as Error).name };
      }
      assert.deepEqual(actual, expected[index], pyJsonDumps(item));
    });
  });
});

type Step = [string, ...unknown[]];

function workCase(f: SessionFactory): { session: Row; steps: Step[] } {
  const session: Row = {
    id: "s", status: "running", active_turn_id: f.pick<unknown>(["turn-1", null, "", "x".repeat(129)]),
    messages: [{ role: "user", _turn_id: "turn-1", _message_id: "m1" }, { role: "user", _turn_id: "turn-2", _message_id: "m2" }],
  };
  if (f.chance(0.2)) session.work_segments = [{ id: "old", turn_id: "turn-1", state: "running", reason: f.pick(["run", "approval_replay"]) }, f.scalar()];
  const steps: Step[] = [];
  for (let index = 0; index < 2 + f.int(8); index += 1) {
    switch (f.int(6)) {
      case 0: steps.push(["start", f.pick(["run", "guidance", "approval_replay"]), f.pick<unknown>(["turn-1", "turn-2", null])]); break;
      case 1: steps.push(["status", f.pick<unknown>(["running", "completed", "paused", "awaiting_user", "provider_error", "needs_review", "odd", null])]); break;
      case 2: steps.push(["checkpoint"]); break;
      case 3: steps.push(["settle", f.chance(0.7)]); break;
      case 4: steps.push(["replay", f.pick<unknown>(["succeeded", "failed", "waiting", null])]); break;
      default: steps.push(["public"]);
    }
  }
  return { session, steps };
}

/** Segment ids, times and durations differ by construction; their shape must not. */
function maskWork(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskWork);
  if (!isDict(value)) return value;
  const out: Row = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "id" && typeof item === "string" && item.length === 32) out[key] = "<id>";
    else if ((key === "started_at" || key === "ended_at") && typeof item === "string") out[key] = "<time>";
    else if (key === "active_ms" && item !== null) out[key] = item instanceof JsonFloat || typeof item === "number" ? "<ms>" : item;
    else out[key] = maskWork(item);
  }
  return out;
}

describe("work segments", { skip }, () => {
  it("open, close and project segments like work_activity.py", () => {
    const f = new SessionFactory(19);
    const cases = Array.from({ length: 300 }, () => workCase(f));
    const expected = oracle({ op: "work", cases }) as Row[];
    const closed = JSON.stringify(expected).match(/"active_ms":\d/g) ?? [];
    assert.ok(closed.length > 50, `only ${closed.length} measured segments`);
    cases.forEach((item, index) => {
      const session = pyDeepCopy(item.session);
      const trace: unknown[] = [];
      let actual: Row;
      try {
        for (const [kind, a, b] of item.steps) {
          if (kind === "start") startWork(session, { reason: a as string, turnId: b });
          else if (kind === "status") session.status = a;
          else if (kind === "checkpoint") checkpointWork(session);
          else if (kind === "settle") settleWork(session, { returned: a as boolean });
          else if (kind === "replay") replayFinished(session, a);
          else trace.push(publicSegments(session));
        }
        actual = { session, trace };
      } catch (error) {
        actual = { error: (error as Error).name };
      }
      assert.deepEqual(maskWork(actual), maskWork(expected[index]), pyJsonDumps(item));
    });
  });
});
