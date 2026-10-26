import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RuntimeEventHotWindow, reduceSessionRuntimeEvents, type SessionRuntimeEvent } from "@xueness/contracts";
import { RuntimeEventConflict, SessionRuntimeEventLog } from "../src/runtime-event-log.ts";

const sid = "c".repeat(32);
function temp(): string { return mkdtempSync(join(tmpdir(), "xueness-runtime-retention-")); }
function allEvents(log: SessionRuntimeEventLog): SessionRuntimeEvent[] {
  const rows: SessionRuntimeEvent[] = [];
  for (let after = 0; ; ) {
    const page = log.readPage({ after, limit: 500 });
    rows.push(...page.events);
    if (!page.hasMore) return rows;
    after = page.next;
  }
}

describe("transient hot turn-window retention (C-SES-03)", () => {
  it("keeps hot memory bounded while the durable ledger keeps every audit fact", () => {
    const root = temp();
    try {
      let now = 0;
      const log = new SessionRuntimeEventLog(root, sid, new RuntimeEventHotWindow({ turnWindow: 2, sealedTurnGraceMs: 0, maxEvents: 40 }, () => now));
      for (let turn = 1; turn <= 6; turn++) {
        for (let i = 0; i < 10; i++) log.append({ type: i % 2 ? "AssistantDelta" : "TurnPhase", turnId: `turn-${turn}`, payload: i % 2 ? { text: `t${turn}-${i}` } : { phase: `p${i}` } });
        now += 1000;
      }
      const stats = log.hot.stats();
      assert.ok(stats.turns <= 2, `turns=${stats.turns}`);
      assert.ok(stats.events <= 40, `events=${stats.events}`);
      assert.ok(stats.evicted > 0);
      const page = log.readPage({ after: 0, limit: 500 });
      assert.equal(page.head, 60);
      assert.equal(page.events.length, 60);
      assert.deepEqual(page.events.map((event) => event.sequenceNumber), Array.from({ length: 60 }, (_, index) => index + 1));
      assert.equal(readFileSync(log.path, "utf8").trimEnd().split("\n").length, 61);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("drops sealed-turn transient deltas after the grace period but keeps durable facts resident", () => {
    let now = 10_000;
    const window = new RuntimeEventHotWindow({ turnWindow: 4, sealedTurnGraceMs: 120_000, maxEvents: 500 }, () => now);
    window.admit({ schema: "xueness.session-runtime.v1", id: "e1", sessionId: sid, turnId: "turn-1", type: "RunStarted", timestamp: "2026-10-25T00:00:00.000Z", sequenceNumber: 1, payload: {} });
    window.admit({ schema: "xueness.session-runtime.v1", id: "e2", sessionId: sid, turnId: "turn-1", type: "AssistantDelta", timestamp: "2026-10-25T00:00:00.000Z", sequenceNumber: 2, payload: { text: "streaming" } });
    window.admit({ schema: "xueness.session-runtime.v1", id: "e3", sessionId: sid, turnId: "turn-1", type: "ToolResult", timestamp: "2026-10-25T00:00:00.000Z", sequenceNumber: 3, payload: { toolCallId: "c1", name: "read", ok: true } });
    window.admit({ schema: "xueness.session-runtime.v1", id: "e4", sessionId: sid, turnId: "turn-2", type: "RunStarted", timestamp: "2026-10-25T00:00:00.000Z", sequenceNumber: 4, payload: {} });
    const withinGrace = window.tail(0, 500)!.map((event) => event.sequenceNumber);
    assert.deepEqual(withinGrace, [1, 2, 3, 4]);
    now += 120_001;
    window.admit({ schema: "xueness.session-runtime.v1", id: "e5", sessionId: sid, turnId: "turn-2", type: "TurnPhase", timestamp: "2026-10-25T00:00:00.000Z", sequenceNumber: 5, payload: { phase: "tools" } });
    const afterGrace = window.tail(0, 500)!.map((event) => [event.sequenceNumber, event.type]);
    assert.deepEqual(afterGrace, [[1, "RunStarted"], [3, "ToolResult"], [4, "RunStarted"], [5, "TurnPhase"]]);
    assert.equal(window.tail(3, 500)!.length, 2);
  });

  it("slims resident model requests while the ledger keeps usage details", () => {
    const root = temp();
    try {
      const log = new SessionRuntimeEventLog(root, sid, new RuntimeEventHotWindow());
      log.append({ type: "ModelRequest", turnId: "turn-1", payload: { phase: "completed", requestId: "r1", usage: { prompt_tokens: 12 }, response: { contentChars: 900 } } });
      const resident = log.readTail(0, 10)![0]!;
      assert.equal(resident.payload.usage, undefined);
      assert.equal(resident.payload.response, undefined);
      assert.equal(resident.payload.phase, "completed");
      assert.ok(log.hot.stats().slimmed >= 1);
      const durable = log.readPage({ limit: 10 }).events[0]!;
      assert.deepEqual(durable.payload.usage, { prompt_tokens: 12 });
      assert.deepEqual(durable.payload.response, { contentChars: 900 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns null from readTail once eviction opens a gap at the cursor", () => {
    const root = temp();
    try {
      let now = 0;
      const log = new SessionRuntimeEventLog(root, sid, new RuntimeEventHotWindow({ turnWindow: 1, sealedTurnGraceMs: 0, maxEvents: 4 }, () => now));
      for (let turn = 1; turn <= 3; turn++) {
        for (let i = 0; i < 4; i++) log.append({ type: "TurnPhase", turnId: `turn-${turn}`, payload: { phase: "p" } });
        now += 5000;
      }
      const floor = log.hot.floor;
      assert.ok(log.readTail(floor - 1, 10) !== null);
      assert.equal(log.readTail(0, 10), null);
      assert.equal(log.readPage({ after: 0, limit: 500 }).events.length, 12);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("indexed durable pagination (C-SES-03)", () => {
  it("pages a large history without repeated full-ledger scans, across cold instances", () => {
    const root = temp();
    try {
      const writer = new SessionRuntimeEventLog(root, sid);
      for (let index = 1; index <= 1200; index++) writer.append({
        type: index % 3 === 0 ? "AssistantDelta" : index % 3 === 1 ? "TurnPhase" : "ToolCall",
        turnId: `turn-${1 + Math.floor((index - 1) / 100)}`,
        payload: index % 3 === 0 ? { text: `delta-${index}` } : index % 3 === 1 ? { phase: "working" } : { toolCallId: `call-${index}`, name: "read" },
      });
      const seen: SessionRuntimeEvent[] = [];
      let cursor = 0, pages = 0;
      let reader = new SessionRuntimeEventLog(root, sid);
      let epoch = "";
      while (true) {
        const page = reader.readPage({ after: cursor, limit: 500, ...(epoch ? { epoch } : {}) });
        epoch = page.epoch;
        seen.push(...page.events);
        cursor = page.next;
        pages++;
        if (!page.hasMore) break;
      }
      assert.equal(pages, 3);
      assert.equal(seen.length, 1200);
      assert.equal(reader.fullScans, 1);
      assert.ok(existsSync(reader.indexPath));
      const cold = new SessionRuntimeEventLog(root, sid);
      const deep = cold.readPage({ after: 700, limit: 100, epoch });
      assert.equal(cold.fullScans, 0);
      assert.deepEqual(deep.events.map((event) => event.sequenceNumber), Array.from({ length: 100 }, (_, index) => 701 + index));
      assert.equal(deep.snapshot!.lastSequenceNumber, 700);
      const full = allEvents(new SessionRuntimeEventLog(root, sid));
      assert.equal(full.length, 1200);
      const expected = reduceSessionRuntimeEvents(full.slice(0, 700));
      assert.deepEqual({ ...deep.snapshot, gaps: deep.snapshot!.gaps }, { ...expected, gaps: expected.gaps });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps cursors valid across recovery and rejects foreign epochs or ahead-of-head cursors", () => {
    const root = temp();
    try {
      const writer = new SessionRuntimeEventLog(root, sid);
      for (let index = 0; index < 30; index++) writer.append({ type: "TurnPhase", turnId: "turn-1", payload: { phase: "p" } });
      const first = writer.readPage({ after: 0, limit: 10 });
      const cold = new SessionRuntimeEventLog(root, sid);
      const resumed = cold.readPage({ after: first.next, epoch: first.epoch, limit: 10 });
      assert.equal(resumed.epoch, first.epoch);
      assert.equal(resumed.events[0]!.sequenceNumber, first.next + 1);
      assert.equal(cold.fullScans, 0);
      assert.throws(() => cold.readPage({ after: 5, epoch: "00000000-0000-4000-8000-000000000000" }), RuntimeEventConflict);
      assert.throws(() => cold.readPage({ after: 31 }), RuntimeEventConflict);
      const torn = new SessionRuntimeEventLog(root, sid);
      writeFileSync(torn.indexPath, "{corrupt");
      const repaired = torn.readPage({ after: 0, limit: 500 });
      assert.equal(torn.fullScans, 1);
      assert.equal(repaired.head, 30);
      assert.equal(new SessionRuntimeEventLog(root, sid).readPage({ after: 0 }).head, 30);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reuses rebuild checkpoints so a deep page never rescans the prefix", () => {
    const root = temp();
    try {
      const writer = new SessionRuntimeEventLog(root, sid);
      for (let index = 1; index <= 1100; index++) writer.append({ type: "ToolResult", turnId: `turn-${1 + Math.floor((index - 1) / 50)}`, payload: { toolCallId: `call-${index}`, name: "read", ok: index % 7 !== 0 } });
      writer.metadata();
      rmSync(join(writer.indexPath), { force: true });
      const cold = new SessionRuntimeEventLog(root, sid);
      const primed = cold.readPage({ after: 0, limit: 1 });
      assert.equal(cold.fullScans, 1);
      assert.deepEqual(cold.readPage({ after: 0, limit: 1 }).events.map((event) => event.sequenceNumber), [1]);
      const deep = cold.readPage({ after: 1024, limit: 6 });
      assert.equal(cold.fullScans, 1);
      assert.deepEqual(deep.events.map((event) => event.sequenceNumber), [1025, 1026, 1027, 1028, 1029, 1030]);
      const baseline = reduceSessionRuntimeEvents(allEvents(new SessionRuntimeEventLog(root, sid)).slice(0, 1024));
      assert.deepEqual(deep.snapshot, baseline);
      assert.equal(primed.head, 1100);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
