import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DynamicWorkflowEngine } from "../src/dynamic-engine.ts";
import { DynamicWorkflowStore } from "../src/dynamic-store.ts";
import type { DynamicAskRequest, DynamicAskResult, DynamicWorkflowDriver } from "../src/dynamic-types.ts";

const SESSION = "a".repeat(32);
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fixture { root: string; store: DynamicWorkflowStore; close(): void }
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "xue-dynamic-engine-"));
  const root = join(base, "workspace"), state = join(base, "state");
  mkdirSync(root); mkdirSync(state);
  return { root, store: new DynamicWorkflowStore(state), close: () => rmSync(base, { recursive: true, force: true }) };
}

function driver(ask: (request: DynamicAskRequest) => Promise<DynamicAskResult> | DynamicAskResult, read: DynamicWorkflowDriver["read"] = async () => null): DynamicWorkflowDriver {
  return { ask: async (request) => await ask(request), read };
}

function queued(f: Fixture, source: string, options: { maxConcurrency?: number; writable?: boolean } = {}): string {
  const draft = f.store.create({ parentSessionId: SESSION, root: f.root, name: "test", source, ...options });
  f.store.update(draft.id, (run) => { run.status = "queued"; run.allowReal = true; });
  return draft.id;
}

function execute(f: Fixture, id: string, fake: DynamicWorkflowDriver, signal?: AbortSignal): Promise<ReturnType<DynamicWorkflowStore["load"]>> {
  const lease = f.store.acquire(id);
  return new DynamicWorkflowEngine(f.store, id, fake).execute(signal).finally(() => lease.release());
}

describe("dynamic workflow engine", () => {
  it("restores completed ask/report nodes without dispatching or duplicating reports", async () => {
    const f = fixture();
    try {
      let calls = 0;
      const source = `const actor = agent("writer");\nconst answer = await actor.ask("write");\nreport(answer);\nreturn answer;`;
      const id = queued(f, source);
      const fake = driver((request) => { calls += 1; request.rememberSession("b".repeat(32)); return { status: "completed", value: { text: "done" } }; });
      await execute(f, id, fake);
      assert.equal(calls, 1);
      assert.equal(f.store.load(id).reports.length, 1);

      f.store.update(id, (run) => { run.status = "queued"; });
      const restored = await execute(f, id, fake);
      assert.equal(restored.status, "completed");
      assert.equal(calls, 1);
      assert.equal(restored.reports.length, 1);
    } finally { f.close(); }
  });

  it("serializes each actor, runs another actor concurrently, and retunes live capacity", async () => {
    const f = fixture();
    try {
      let releaseSame!: () => void, releaseOther!: () => void, startedFirst!: () => void, startedOther!: () => void;
      const sameGate = new Promise<void>((resolve) => { releaseSame = resolve; });
      const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
      const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
      const otherStarted = new Promise<void>((resolve) => { startedOther = resolve; });
      const activeActors = new Set<string>();
      let active = 0, peak = 0;
      const source = `const same = agent("same");\nconst other = agent("other");\nawait Promise.all([same.ask("same-1"), same.ask("same-2"), other.ask("other")]);`;
      const id = queued(f, source, { maxConcurrency: 1 });
      const fake = driver(async (request) => {
        const actor = request.actor.name!;
        assert.equal(activeActors.has(actor), false, `actor ${actor} overlapped its own requests`);
        activeActors.add(actor); active += 1; peak = Math.max(peak, active);
        if (request.instructions === "same-1") startedFirst();
        if (request.instructions === "other") startedOther();
        try {
          await (request.instructions === "same-1" ? sameGate : request.instructions === "other" ? otherGate : Promise.resolve());
          request.rememberSession(actor === "same" ? "c".repeat(32) : "d".repeat(32));
          return { status: "completed", value: request.instructions };
        } finally { activeActors.delete(actor); active -= 1; }
      });
      const engine = new DynamicWorkflowEngine(f.store, id, fake);
      const lease = f.store.acquire(id);
      const execution = engine.execute().finally(() => lease.release());
      await firstStarted;
      engine.setMaxConcurrency(2);
      await otherStarted;
      assert.equal(peak, 2);
      releaseSame();
      await tick();
      releaseOther();
      const run = await execution;
      assert.equal(run.status, "completed");
      assert.equal(peak, 2);
      assert.equal(active, 0);
    } finally { f.close(); }
  });

  it("holds at a hole, resumes after resolution, and keeps earlier reports unique", async () => {
    const f = fixture();
    try {
      const source = `report("before");\nconst answer = await hole("checkpoint", "Confirm the result");\nreport(answer);\nreturn answer;`;
      const id = queued(f, source);
      const fake = driver(() => { throw new Error("a hole must not call the model driver"); });
      const held = await execute(f, id, fake);
      assert.equal(held.status, "awaiting_user");
      const hole = Object.values(held.nodes).find((node) => node.kind === "hole");
      assert.ok(hole);
      f.store.update(id, (run) => {
        run.nodes[hole.id]!.result = { approved: true };
        run.nodes[hole.id]!.status = "completed";
        delete run.nodes[hole.id]!.question;
        run.status = "queued";
      });
      const resumed = await execute(f, id, fake);
      assert.equal(resumed.status, "completed");
      assert.deepEqual(resumed.reports, ["before", { approved: true }]);
      assert.equal(resumed.events.filter((event) => event.type === "node_awaiting_user").length, 1);
    } finally { f.close(); }
  });

  it("recomputes imported mismatches but rejects a mismatch in the same run", async () => {
    const f = fixture();
    try {
      let calls = 0, reads = 0;
      writeFileSync(join(f.root, "input.txt"), "one");
      const fake = driver((request) => {
        calls += 1; request.rememberSession("e".repeat(32));
        return { status: "completed", value: request.instructions };
      }, async (_run, _op, args) => { reads += 1; return String(args[0]); });
      const firstId = queued(f, `const actor = agent("writer");\nconst content = await files.read("input.txt");\nconst answer = await actor.ask("old");\nreturn { content, answer };`);
      await execute(f, firstId, fake);
      const amendedSource = `const actor = agent("writer");\nconst content = await files.read("input.txt");\nconst answer = await actor.ask("new");\nreturn { content, answer };`;
      const amended = f.store.amend(firstId, amendedSource);
      assert.ok(Object.values(amended.actors).every(actor => actor.sessionId === undefined));
      assert.ok(Object.values(amended.nodes).some((node) => node.kind === "ask" && node.status === "completed"));
      assert.ok(Object.values(amended.nodes).some((node) => node.kind === "read" && node.status === "completed"));
      f.store.update(amended.id, (run) => { run.status = "queued"; });
      const recomputed = await execute(f, amended.id, fake);
      assert.equal(recomputed.status, "completed");
      assert.equal(calls, 2);
      assert.equal(reads, 1);

      writeFileSync(join(f.root, "input.txt"), "two");
      const changedWorkspace = f.store.amend(amended.id, amendedSource);
      assert.equal(Object.keys(changedWorkspace.nodes).length, 0);

      f.store.update(amended.id, (run) => {
        run.status = "queued";
        run.nodes["ask#1@1"]!.inputHash = "0".repeat(64);
      });
      const rejected = await execute(f, amended.id, fake);
      assert.equal(rejected.status, "failed");
      assert.match(rejected.error ?? "", /input changed during recovery/);
      assert.equal(calls, 2);
    } finally { f.close(); }
  });

  it("cancels queued work and drains the in-flight driver before settling", async () => {
    const f = fixture();
    try {
      let started!: () => void, settled = false, calls = 0;
      const firstStarted = new Promise<void>((resolve) => { started = resolve; });
      const source = `const first = agent("first");\nconst second = agent("second");\nawait Promise.all([first.ask("one"), second.ask("two")]);`;
      const id = queued(f, source, { maxConcurrency: 1 });
      const fake = driver(async (request) => {
        calls += 1;
        started();
        return await new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () => setTimeout(() => { settled = true; reject(new Error("driver drained after abort")); }, 20), { once: true });
        });
      });
      const controller = new AbortController();
      const execution = execute(f, id, fake, controller.signal);
      await firstStarted;
      controller.abort();
      const run = await execution;
      assert.equal(run.status, "cancelled");
      assert.equal(settled, true);
      assert.equal(calls, 1);
      assert.equal(Object.values(run.nodes).filter((node) => node.status === "running").length, 0);
    } finally { f.close(); }
  });

  it("validates ask schemas and distinguishes actor questions from retryable pauses", async () => {
    const f = fixture();
    try {
      let calls = 0;
      const id = queued(f, `interface Reply { ok: boolean }\nconst actor = agent("schema");\nreturn await actor.ask<Reply>("answer");`);
      const run = await execute(f, id, driver(() => { calls += 1; return { status: "completed", value: { ok: "yes" } }; }));
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /does not match schema/);
      assert.equal(calls, 1);

      const source = `const actor = agent("reviewer");\nreturn await actor.ask("review");`;
      const awaitingId = queued(f, source);
      const waiting = await execute(f, awaitingId, driver((request) => {
        request.rememberSession("f".repeat(32));
        return { status: "awaiting_user", question: "Please answer" };
      }));
      const waitingNode = Object.values(waiting.nodes).find((node) => node.kind === "ask");
      assert.equal(waiting.status, "awaiting_user");
      assert.equal(waitingNode?.status, "awaiting_user");
      assert.equal(waitingNode?.question, "Please answer");
      f.store.update(awaitingId, (record) => { record.nodes[waitingNode!.id]!.status = "pending"; delete record.nodes[waitingNode!.id]!.question; record.status = "queued"; });
      const answered = await execute(f, awaitingId, driver((request) => {
        assert.equal(request.actor.sessionId, "f".repeat(32));
        return { status: "completed", value: "approved" };
      }));
      assert.equal(answered.status, "completed");

      const pausedId = queued(f, source);
      const paused = await execute(f, pausedId, driver((request) => {
        request.rememberSession("9".repeat(32));
        return { status: "paused", question: "provider disabled" };
      }));
      const pausedNode = Object.values(paused.nodes).find((node) => node.kind === "ask");
      assert.equal(paused.status, "paused");
      assert.equal(pausedNode?.status, "pending");
      assert.equal(pausedNode?.error, "provider disabled");
      assert.equal(pausedNode?.question, undefined);
      f.store.update(pausedId, (record) => { record.status = "queued"; });
      const resumed = await execute(f, pausedId, driver((request) => {
        assert.equal(request.actor.sessionId, "9".repeat(32));
        return { status: "completed", value: "resumed" };
      }));
      assert.equal(resumed.status, "completed");
    } finally { f.close(); }
  });
});
