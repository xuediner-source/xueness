import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentContext } from "@xueness/agent";
import {
  MemoryExtractionScheduler,
  extractionEligible,
  extractionKey,
  memoryExtractionExtension,
  settlementFromContext,
  type MemoryExtractionAdmission,
  type MemoryExtractionPorts,
  type MemoryExtractionSettlement,
} from "../src/memory-extraction.ts";

const sid = (value: number): string => value.toString(16).padStart(32, "0");
const defer = (): { promise: Promise<void>; resolve(): void } => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const context = (session: Record<string, unknown>, aborted = false): AgentContext =>
  ({ session, signal: { aborted } } as unknown as AgentContext);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: sid(1), root: "/tmp/x", status: "idle", messages: [], ...overrides };
}

interface Harness {
  base: string;
  rootA: string;
  rootB: string;
  extractions: { job: { root: string; sessionId: string; key: string; turnId: string | null }; signal: AbortSignal }[];
  gate(index?: number): { promise: Promise<void>; resolve(): void };
  admissionTickets: number;
  released: number;
  allow: boolean;
  scheduler: MemoryExtractionScheduler;
  settlement(sessionId: string, root: string, messages: unknown[], outcome?: "succeeded" | "failed" | "cancelled", turnId?: string): MemoryExtractionSettlement;
}

function harness(options: { maxParallel?: number; fail?: boolean } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), "xueness-memory-extraction-"));
  const rootA = join(base, "a"), rootB = join(base, "b");
  const extractions: Harness["extractions"] = [];
  const gates: { promise: Promise<void>; resolve(): void }[] = [];
  let admissionTickets = 0, released = 0;
  const allow = { value: true };
  const ports: MemoryExtractionPorts = {
    enabled: () => allow.value,
    admission: {
      async acquire() { admissionTickets += 1; return { release: () => { released += 1; } }; },
    } satisfies MemoryExtractionAdmission,
    async extract(job, signal) {
      const gate = defer();
      gates.push(gate);
      extractions.push({ job, signal });
      // A real extraction honours the abort signal instead of running forever.
      await Promise.race([gate.promise, new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }))]);
      if (options.fail && !signal.aborted) throw new Error("provider unavailable");
    },
  };
  const scheduler = new MemoryExtractionScheduler({ ports, maxParallel: options.maxParallel });
  return {
    base, rootA, rootB, extractions,
    gate: (index?: number) => gates[index ?? gates.length - 1] ?? defer(),
    get admissionTickets() { return admissionTickets; },
    get released() { return released; },
    allow: allow.value,
    scheduler,
    settlement(sessionId, root, messages, outcome = "succeeded", turnId) {
      return { sessionId, root, outcome, row: row({ id: sessionId, root, messages }), turnId };
    },
  };
}

const userTurn = (content: string): unknown => ({ role: "user", content });

async function close(h: Harness): Promise<void> {
  await h.scheduler.close();
  rmSync(h.base, { recursive: true, force: true });
}

describe("extraction eligibility", () => {
  it("keys only plain user and assistant bodies, ignoring tool, guide and notice rows", () => {
    const messages = [
      { role: "user", content: "Ship the release." },
      { role: "assistant", tool_calls: [{ id: "t1" }] },
      { role: "tool", tool_call_id: "t1", content: "output" },
      { role: "user", content: "guide text", _input_kind: "guide" },
      { role: "user", content: "notice", _meta_source: "background_notice" },
      { role: "assistant", content: "Done." },
    ];
    const key = extractionKey(row({ messages }));
    assert.equal(key, extractionKey(row({ messages })));
    assert.equal(extractionKey(row({ messages: [{ role: "user", content: "Ship the release." }, { role: "assistant", content: "Done." }] })), key);
    assert.notEqual(extractionKey(row({ messages: [...messages, { role: "user", content: "More." }] })), key);
    assert.equal(extractionKey(row({ messages: [{ role: "tool", content: "only tools" }] })), null);
  });

  it("accepts only local, non-internal sessions rooted in the settling workspace", () => {
    const root = process.cwd();
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "succeeded", row: row({ id: sid(9), root }) }), true);
    assert.equal(extractionEligible({ sessionId: "not-a-session", root, outcome: "succeeded", row: row({ id: "not-a-session", root }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "failed", row: row({ id: sid(9), root }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "succeeded", row: row({ id: sid(8), root }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "succeeded", row: row({ id: sid(9), root, remote_connection: { url: "ssh://host" } }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "succeeded", row: row({ id: sid(9), root, session_kind: "workflow" }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root, outcome: "succeeded", row: row({ id: sid(9), root: null }) }), false);
    assert.equal(extractionEligible({ sessionId: sid(9), root: join(root, "elsewhere"), outcome: "succeeded", row: row({ id: sid(9), root }) }), false);
  });

  it("maps the run loop's terminal signals to settlements", () => {
    const base = { id: sid(1), root: "/tmp/x" };
    assert.equal(settlementFromContext(context({ ...base, status: "completed" }))?.outcome, "succeeded");
    assert.equal(settlementFromContext(context({ ...base, status: "completed" }, true))?.outcome, "cancelled");
    assert.equal(settlementFromContext(context({ ...base, status: "running", run_stop: { code: "cancelled" } }))?.outcome, "cancelled");
    assert.equal(settlementFromContext(context({ ...base, status: "running", run_stop: { code: "error" } }))?.outcome, "failed");
    assert.equal(settlementFromContext(context({ ...base, status: "needs_review" }))?.outcome, "failed");
    assert.equal(settlementFromContext(context({ root: "/tmp/x", status: "completed" })), null);
    const withTurn = settlementFromContext(context({ ...base, status: "completed", active_turn_id: "turn-7" }));
    assert.equal(withTurn?.turnId, "turn-7");
  });
});

const tick = async (): Promise<void> => { await new Promise((done) => setImmediate(done)); };

describe("memory extraction scheduler", () => {
  it("extracts once per settled successful production turn under admission", async () => {
    const h = harness();
    try {
      assert.equal(h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("Choose pnpm.")], "succeeded", "turn-1")), true);
      await tick();
      assert.equal(h.extractions.length, 1);
      const { job, signal } = h.extractions[0]!;
      assert.equal(job.sessionId, sid(1));
      assert.equal(job.root, h.rootA);
      assert.equal(job.turnId, "turn-1");
      assert.equal(typeof job.key, "string");
      assert.equal(signal.aborted, false);
      assert.ok(h.admissionTickets >= 1);
      h.gate().resolve();
      await tick();
      await h.scheduler.close();
      assert.equal(h.released, h.admissionTickets);
      const stats = h.scheduler.stats();
      assert.equal(stats.settled.succeeded, 1);
      assert.equal(stats.outcomes.extracted, 1);
      assert.equal(stats.active + stats.queued, 0);
    } finally { await close(h); }
  });

  it("never enqueues failed or cancelled turns but still counts them", async () => {
    const h = harness();
    try {
      assert.equal(h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("x")], "failed")), false);
      assert.equal(h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("x")], "cancelled")), false);
      await tick();
      assert.equal(h.extractions.length, 0);
      assert.equal(h.admissionTickets, 0);
      assert.deepEqual(h.scheduler.stats().settled, { succeeded: 0, failed: 1, cancelled: 1 });
    } finally { await close(h); }
  });

  it("deduplicates identical evidence and re-extracts only new evidence", async () => {
    const h = harness();
    try {
      h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("Same question")]));
      await tick();
      h.gate().resolve();
      await tick();
      assert.equal(h.scheduler.settle(h.settlement(sid(2), h.rootA, [userTurn("Same question")])), false);
      assert.equal(h.extractions.length, 1);
      assert.equal(h.scheduler.settle(h.settlement(sid(3), h.rootA, [userTurn("Same question"), userTurn("New decision")])), true);
      await tick();
      assert.equal(h.extractions.length, 2);
      assert.equal(h.extractions[1]!.job.sessionId, sid(3));
      h.gate().resolve();
      await h.scheduler.close();
      assert.equal(h.extractions.length, 2);
    } finally { await close(h); }
  });

  it("serializes per workspace while different workspaces run in parallel", async () => {
    const h = harness({ maxParallel: 2 });
    try {
      for (const id of [sid(1), sid(2)]) h.scheduler.settle(h.settlement(id, h.rootA, [userTurn(`a-${id}`)]));
      for (const id of [sid(3), sid(4)]) h.scheduler.settle(h.settlement(id, h.rootB, [userTurn(`b-${id}`)]));
      await tick();
      const activeA = h.extractions.filter((item) => item.job.root === h.rootA);
      const activeB = h.extractions.filter((item) => item.job.root === h.rootB);
      assert.equal(activeA.length, 1);
      assert.equal(activeB.length, 1);
      assert.equal(h.scheduler.stats().active, 2);
      assert.equal(h.scheduler.stats().queued, 2);
      h.gate(0).resolve(); // sid(1) on A and sid(3) on B run first
      h.gate(1).resolve();
      await tick();
      assert.equal(h.extractions.length, 4);
      h.gate(2).resolve();
      h.gate(3).resolve();
      await h.scheduler.close();
      assert.equal(h.extractions.length, 4);
      const aOrder = h.extractions.filter((item) => item.job.root === h.rootA).map((item) => item.job.sessionId);
      assert.deepEqual(aOrder, [sid(1), sid(2)]);
    } finally { await close(h); }
  });

  it("cancels queued and running extractions of one session without touching others", async () => {
    const h = harness();
    try {
      h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("first")]));
      await tick();
      h.scheduler.settle(h.settlement(sid(2), h.rootA, [userTurn("second")]));
      assert.equal(h.scheduler.cancel(sid(2)), 1);
      assert.equal(h.scheduler.settle(h.settlement(sid(2), h.rootA, [userTurn("second")])), true);
      assert.equal(h.scheduler.cancel(sid(1)), 1);
      // Abort is synchronous: the running extraction's signal is already aborted.
      assert.equal(h.extractions[0]!.signal.aborted, true);
      await tick();
      // Freeing workspace A admits the re-queued sid(2) job.
      assert.equal(h.extractions.length, 2);
      await h.scheduler.close();
      const stats = h.scheduler.stats();
      assert.equal(stats.outcomes.cancelled, 2);
      assert.equal(stats.queued, 0);
    } finally { await close(h); }
  });

  it("records failed extractions without ever throwing into the run loop", async () => {
    const h = harness({ fail: true });
    try {
      h.scheduler.settle(h.settlement(sid(1), h.rootA, [userTurn("extract me")]));
      await tick();
      h.gate().resolve();
      await tick();
      await h.scheduler.close();
      assert.equal(h.scheduler.stats().outcomes.failed, 1);
      assert.equal(h.released, h.admissionTickets);
    } finally { await close(h); }
  });

  it("skips scheduling while memory is disabled and closes down in-flight work", async () => {
    const h = harness();
    try {
      const ports: MemoryExtractionPorts = { enabled: () => false, extract: async () => {} };
      const off = new MemoryExtractionScheduler({ ports });
      assert.equal(off.settle(h.settlement(sid(1), h.rootA, [userTurn("x")])), false);
      await off.close();
      h.scheduler.settle(h.settlement(sid(5), h.rootA, [userTurn("y")]));
      await tick();
      await h.scheduler.close();
      assert.equal(h.extractions[0]!.signal.aborted, true);
      assert.equal(h.scheduler.stats().outcomes.cancelled, 1);
    } finally { await close(h); }
  });
});

describe("memory extraction extension", () => {
  it("settles after each run and never fails the run that produced the settlement", async () => {
    const h = harness();
    try {
      const extension = memoryExtractionExtension(h.scheduler);
      assert.equal(extension.id, "memory");
      assert.deepEqual(extension.capabilities, ["memory.extraction"]);
      extension.afterRun?.(context({ id: sid(6), root: h.rootA, status: "completed", messages: [userTurn("via extension")] }, false));
      await tick();
      assert.equal(h.extractions.length, 1);
      h.gate().resolve();
      extension.afterRun?.(context({ status: "completed" } as Record<string, unknown>));
      extension.afterRun?.(context({ id: sid(7), root: h.rootA, status: "needs_review" }));
      extension.afterRun?.(context({ id: sid(7), root: h.rootA, status: "running" }));
      await h.scheduler.close();
      assert.equal(h.extractions.length, 1);
    } finally { await close(h); }
  });
});
