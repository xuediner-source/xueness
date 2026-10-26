import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MEMORY_TOOL_NAMES } from "../src/memory-tool-contract.ts";
import { MemoryToolLoopService, type MemoryIndexSyncInfo, type MemoryToolLoopOptions } from "../src/memory-tool-loop.ts";
import type { MemoryDreamRow } from "../src/memory-dream-types.ts";

const sid = (value: number): string => value.toString(16).padStart(32, "0");
const digest = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
type Row = Record<string, unknown>;
type Step = Row | ((info: { messages: Row[]; tools: Row[]; signal: AbortSignal }) => Row | Promise<Row>);

const call = (name: string, args: Row = {}): Row =>
  ({ id: `${name}-${Math.random().toString(16).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

const happyScript = (h: { sourceA: string; midA: string }): Step[] => [
  { tool_calls: [call("memory_read_key"), call("memory_read_evidence", { sessionId: h.sourceA })] },
  { tool_calls: [
    call("memory_propose_change", { op: "update", entry: "Build", summary: "Builds use pnpm for this repository.", evidence: [h.midA] }),
    call("memory_submit", { summary: "Switch the build tool to pnpm." }),
  ] },
];

interface Harness {
  base: string; rootA: string; rootB: string; currentA: string; sourceA: string; sourceB: string; midA: string;
  sessions: Map<string, MemoryDreamRow>; keys: Map<string, string>; calls: { messages: Row[]; tools: Row[]; signal: AbortSignal }[];
  syncs: MemoryIndexSyncInfo[]; script: Step[]; enabled: Set<string>; service: MemoryToolLoopService;
  cas: { fail: boolean }; writeCalls: number;
  propose(sources?: string[]): Promise<{ id: string; startDigest: string; name: string; status: string }>;
  startToReady(draft: { id: string; startDigest: string }): Promise<Record<string, any>>;
  close(): Promise<void>;
}

function harness(options: { limits?: MemoryToolLoopOptions["limits"]; allowRealHost?: boolean } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), "xueness-memory-tool-loop-"));
  const rootA = join(base, "project-a"), rootB = join(base, "project-b");
  const currentA = sid(1), sourceA = sid(2), sourceB = sid(4);
  const midA = "message-source-a-1";
  const sessions = new Map<string, MemoryDreamRow>([
    [currentA, { id: currentA, root: rootA, status: "idle", updated_at: "2026-10-24T00:00:00Z", messages: [{ role: "user", _message_id: "message-owner-1", content: "Curate our project memory." }] }],
    [sourceA, { id: sourceA, root: rootA, status: "idle", updated_at: "2026-10-24T00:00:00Z", messages: [
      { role: "user", _message_id: midA, content: "Use pnpm for builds; API_KEY=not-a-real-secret" },
      { role: "assistant", _message_id: "message-source-a-2", content: "Builds use pnpm now." },
    ] }],
    [sourceB, { id: sourceB, root: rootB, status: "idle", messages: [{ role: "user", _message_id: "message-b-1", content: "Private to project B." }] }],
  ]);
  const keys = new Map([[rootA, "## Build\n\nUse npm.\n"]]);
  const cas = { fail: false };
  const calls: Harness["calls"] = [];
  const syncs: MemoryIndexSyncInfo[] = [];
  const script: Step[] = [];
  const enabled = new Set(["memory", "sessions", "providers"]);
  let writeCalls = 0, scriptRound = 0;
  const ports: MemoryToolLoopOptions = {
    stateDir: join(base, "state"),
    enabled: (id) => enabled.has(id),
    allowRealHost: options.allowRealHost ?? true,
    limits: options.limits,
    async owner(id) {
      const row = sessions.get(id);
      if (!row) throw Object.assign(new Error("missing session"), { code: "ENOENT" });
      return row;
    },
    async readKey(root) { const content = keys.get(root); if (content === undefined) throw new Error("unknown workspace"); return { content, digest: digest(content) }; },
    async writeKey(root, input) {
      writeCalls += 1;
      // Simulates a concurrent KEY.md write landing between revalidation and this call.
      if (cas.fail) { cas.fail = false; throw Object.assign(new Error("CAS conflict"), { status: 409 }); }
      if (digest(keys.get(root) ?? "") !== input.digest) throw Object.assign(new Error("CAS conflict"), { status: 409 });
      keys.set(root, input.content);
      return { content: input.content, digest: digest(input.content) };
    },
    async model(messages, tools, signal) {
      calls.push({ messages, tools, signal });
      const step = script.length ? script[Math.min(scriptRound, script.length - 1)]! : {};
      scriptRound += 1;
      return typeof step === "function" ? await step({ messages, tools, signal }) : step;
    },
    async syncIndex(_root, info) { syncs.push(info); },
  };
  const service = new MemoryToolLoopService(ports);
  return {
    base, rootA, rootB, currentA, sourceA, sourceB, midA, sessions, keys, calls, syncs, script, enabled, service, cas,
    get writeCalls() { return writeCalls; },
    // Each proposed loop replays the script from its first step.
    propose: (sources: string[] = [sourceA]) => { scriptRound = 0; return service.propose(currentA, { sourceSessionIds: sources }) as Promise<{ id: string; startDigest: string; name: string; status: string }>; },
    async startToReady(draft: { id: string; startDigest: string }) {
      await service.start(currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      await service.wait(draft.id);
      return service.get(currentA, draft.id) as Promise<Record<string, any>>;
    },
    close: async () => { await service.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

describe("memory tool loop", () => {
  it("runs the restricted loop to a reviewable candidate with verified evidence", async () => {
    const h = harness();
    try {
      h.script.push(...happyScript(h));
      const draft = await h.propose();
      assert.equal(draft.status, "draft");
      assert.equal(draft.name, "Project memory tool loop");
      const ready = await h.startToReady(draft);
      assert.equal(ready.status, "ready");
      assert.equal(ready.usage, "unknown");
      assert.equal(ready.active, false);
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.calls[0]!.tools.map((tool) => (tool as { function: { name: string } }).function.name), [...MEMORY_TOOL_NAMES]);
      assert.match(JSON.stringify(h.calls[0]!.messages[0]), /untrusted data/i);
      // Evidence travels through the loop redacted, never as raw secrets.
      const transcript = JSON.stringify(h.calls[1]!.messages);
      assert.match(transcript, /API_KEY=\[REDACTED\]/);
      assert.equal(transcript.includes("not-a-real-secret"), false);
      assert.equal(ready.candidate?.content, "## Build\nBuilds use pnpm for this repository.\n");
      assert.deepEqual(ready.candidate?.sourceSessionIds, [h.sourceA]);
      const loop = (ready.provenance?.toolLoop ?? {}) as Record<string, unknown>;
      assert.deepEqual({ rounds: loop.rounds, toolCalls: loop.toolCalls, evidenceReads: loop.evidenceReads, keyReads: loop.keyReads },
        { rounds: 2, toolCalls: 4, evidenceReads: 1, keyReads: 1 });
      const verification = await h.service.verify(h.currentA, draft.id);
      assert.deepEqual(verification.map((item) => item.verified), [true]);
    } finally { await h.close(); }
  });

  it("never accepts changes that cite evidence the loop did not read", async () => {
    const h = harness();
    try {
      h.script.push(
        { tool_calls: [call("memory_read_evidence", { sessionId: h.sourceA })] },
        { tool_calls: [
          call("memory_propose_change", { op: "add", entry: "Verified", summary: "Read evidence.", evidence: [h.midA] }),
          call("memory_propose_change", { op: "add", entry: "Hallucinated", summary: "Never read.", evidence: ["message-never-returned"] }),
          call("memory_submit", { summary: "Mixed quality." }),
        ] },
      );
      const ready = await h.startToReady(await h.propose());
      assert.equal(ready.status, "ready");
      const verification = await h.service.verify(h.currentA, ready.id);
      assert.deepEqual(verification.map((item) => item.verified), [true, false]);
      assert.match(verification[1]!.reasons.join("; "), /was never read/);
      assert.equal(ready.candidate?.content.includes("## Verified"), true);
      assert.equal(ready.candidate?.content.includes("Hallucinated"), false);
      const loop = ready.provenance?.toolLoop as { verification?: { verified: boolean }[] };
      assert.equal(loop.verification?.filter((item) => !item.verified).length, 1);
      // A loop where nothing is verifiable settles cancelled instead of reviewing emptiness.
      const blind = harness();
      try {
        blind.script.push({ tool_calls: [
          call("memory_propose_change", { op: "add", entry: "Blind", summary: "No reads at all.", evidence: [blind.midA] }),
          call("memory_submit", { summary: "Trust me." }),
        ] });
        const cancelled = await blind.startToReady(await blind.propose());
        assert.equal(cancelled.status, "cancelled");
        assert.match(String(cancelled.error), /no verified changes/);
      } finally { await blind.close(); }
    } finally { await h.close(); }
  });

  it("rejects reviewed changes, recomputes the digest and can cancel the remainder", async () => {
    const h = harness();
    try {
      h.script.push(
        { tool_calls: [call("memory_read_evidence", { sessionId: h.sourceA })] },
        { tool_calls: [
          call("memory_propose_change", { op: "add", entry: "Alpha", summary: "Keep me.", evidence: [h.midA] }),
          call("memory_propose_change", { op: "add", entry: "Beta", summary: "Drop me.", evidence: [h.midA] }),
          call("memory_submit", { summary: "Two changes." }),
        ] },
      );
      const ready = await h.startToReady(await h.propose());
      const before = ready.applyDigest as string;
      const kept = await h.service.reject(h.currentA, ready.id, { indexes: [1], reason: "Beta is wrong" });
      assert.equal(kept.status, "ready");
      assert.notEqual(kept.applyDigest, before);
      assert.equal(kept.candidate?.content.includes("## Alpha"), true);
      assert.equal(kept.candidate?.content.includes("## Beta"), false);
      const rejections = ((kept.provenance?.toolLoop ?? {}) as { rejections?: unknown[] }).rejections;
      assert.equal(rejections?.length, 1);
      await assert.rejects(h.service.apply(h.currentA, ready.id, { digest: before, confirmed: true }), /candidate/);
      const cancelled = await h.service.reject(h.currentA, ready.id, {});
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.candidate, undefined);
      await assert.rejects(h.service.reject(h.currentA, ready.id, {}), /only a ready/);
    } finally { await h.close(); }
  });

  it("applies exactly once, syncs the index after the durable write and honours CAS and plan mode", async () => {
    const h = harness();
    try {
      h.script.push(...happyScript(h));
      const ready = await h.startToReady(await h.propose());
      const applied = await h.service.apply(h.currentA, ready.id, { digest: ready.applyDigest as string, confirmed: true });
      assert.equal(applied.status, "applied");
      assert.equal(applied.appliedKeyDigest, digest(ready.candidate!.content));
      assert.equal(h.keys.get(h.rootA), ready.candidate!.content);
      assert.equal(h.writeCalls, 1);
      assert.equal(h.syncs.length, 1);
      assert.equal(h.syncs[0]!.keyDigest, applied.appliedKeyDigest);
      assert.deepEqual(h.syncs[0]!.sourceSessionIds, [h.sourceA]);
      assert.equal(h.syncs[0]!.toolLoop.accepted, 1);
      await h.service.apply(h.currentA, ready.id, { digest: ready.applyDigest as string, confirmed: true });
      assert.equal(h.writeCalls, 1);
      assert.equal(h.syncs.length, 1);
      await assert.rejects(h.service.apply(h.currentA, ready.id, { digest: "0".repeat(64), confirmed: true }), /does not match/);
      // Plan mode never writes project memory.
      h.sessions.get(h.currentA)!.mode = "plan";
      const planned = await h.startToReady(await h.propose());
      await assert.rejects(h.service.apply(h.currentA, planned.id, { digest: planned.applyDigest as string, confirmed: true }), /plan mode/);
      h.sessions.get(h.currentA)!.mode = "default";
      // A concurrent KEY.md write landing after revalidation fails the CAS instead of overwriting; no half-applied state remains.
      const conflicted = await h.startToReady(await h.propose());
      h.cas.fail = true;
      await assert.rejects(h.service.apply(h.currentA, conflicted.id, { digest: conflicted.applyDigest as string, confirmed: true }), /changed; reload/);
      assert.equal((await h.service.get(h.currentA, conflicted.id)).status, "ready");
      assert.equal(h.syncs.length, 1);
    } finally { await h.close(); }
  });

  it("confines the model to the restricted tools and enforces the loop budgets", async () => {
    const h = harness({ limits: { maxRounds: 3, maxToolCalls: 6 } });
    try {
      h.script.push(
        { tool_calls: [call("web_search", { query: "pnpm" }), call("memory_read_evidence", { sessionId: h.sourceB })] },
        { tool_calls: [call("memory_submit", { summary: "Nothing usable." })] },
      );
      const done = await h.startToReady(await h.propose());
      assert.equal(done.status, "cancelled");
      assert.match(String(done.error), /no verified changes/);
      const transcript = JSON.stringify(h.calls[1]!.messages);
      assert.match(transcript, /only the restricted memory tools/);
      assert.match(transcript, /must be one of the selected source sessions/);
    } finally { await h.close(); }
    const spin = harness({ limits: { maxRounds: 2 } });
    try {
      spin.script.push({ tool_calls: [call("memory_read_key")] });
      const rounds = await spin.startToReady(await spin.propose());
      assert.equal(spin.calls.length, 2);
      assert.equal(rounds.status, "failed");
      assert.match(String(rounds.error), /round budget/);
    } finally { await spin.close(); }
    const chatty = harness({ limits: { maxToolCalls: 1, maxRounds: 5 } });
    try {
      chatty.script.push({ tool_calls: [call("memory_read_key"), call("memory_read_key")] });
      const tools = await chatty.startToReady(await chatty.propose());
      assert.equal(tools.status, "failed");
      assert.match(String(tools.error), /tool call budget/);
    } finally { await chatty.close(); }
    const mute = harness();
    try {
      mute.script.push({ content: "I considered the evidence." });
      const finished = await mute.startToReady(await mute.propose());
      assert.equal(finished.status, "failed");
      assert.match(String(finished.error), /without calling memory_submit/);
    } finally { await mute.close(); }
  });

  it("cancels a running loop without applying or half-writing anything", async () => {
    const h = harness();
    try {
      h.script.push((info) => new Promise((resolve) => {
        info.signal.addEventListener("abort", () => resolve({ content: "" }), { once: true });
      }));
      const draft = await h.propose();
      const running = await h.service.start(h.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      assert.equal(running.status, "running");
      assert.equal(running.active, true);
      for (let i = 0; i < 100 && h.calls.length < 1; i += 1) await new Promise((done) => setTimeout(done, 10));
      assert.equal(h.calls.length, 1);
      const cancelled = await h.service.cancel(h.currentA, draft.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.candidate, undefined);
      assert.equal(h.writeCalls, 0);
      assert.equal(h.syncs.length, 0);
      assert.equal(h.keys.get(h.rootA), "## Build\n\nUse npm.\n");
      // The workspace lease is free again: a second loop on the same root starts and settles.
      h.script.length = 0;
      h.script.push({ tool_calls: [call("memory_submit", { summary: "Nothing." })] });
      const second = await h.startToReady(await h.propose());
      assert.notEqual(second.status, "running");
    } finally { await h.close(); }
  });

  it("fails the start when the base KEY or a captured source has drifted", async () => {
    const h = harness();
    try {
      const keyDraft = await h.propose();
      h.keys.set(h.rootA, "operator edited KEY.md");
      await assert.rejects(h.service.start(h.currentA, keyDraft.id, { digest: keyDraft.startDigest, confirmed: true, allowReal: true }), /inputs changed/);
      h.keys.set(h.rootA, "## Build\n\nUse npm.\n");
      const sourceDraft = await h.propose();
      (h.sessions.get(h.sourceA)!.messages as Row[])[0]!.content = "A different decision.";
      await assert.rejects(h.service.start(h.currentA, sourceDraft.id, { digest: sourceDraft.startDigest, confirmed: true, allowReal: true }), /inputs changed/);
      assert.equal(h.calls.length, 0);
    } finally { await h.close(); }
  });

  it("gates proposals, starts and reads behind host switches and session ownership", async () => {
    const h = harness();
    try {
      await assert.rejects(h.propose([h.sourceB]), /another workspace/);
      await assert.rejects(h.propose([h.currentA, h.currentA]), /unique/);
      h.sessions.get(h.currentA)!.status = "running";
      await assert.rejects(h.propose([h.currentA]), /must be idle/);
      h.sessions.get(h.currentA)!.status = "idle";
      const draft = await h.propose();
      await assert.rejects(h.service.start(h.currentA, draft.id, { digest: "0".repeat(64), confirmed: true, allowReal: true }), /confirm the current/);
      await assert.rejects(h.service.start(h.currentA, draft.id, { digest: draft.startDigest, confirmed: false, allowReal: true }), /confirm the current/);
      await assert.rejects(h.service.start(h.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: false }), /real model/);
      h.enabled.delete("providers");
      await assert.rejects(h.propose(), /must be enabled/);
      h.enabled.add("providers");
      h.sessions.get(h.currentA)!.remote_connection = { url: "ssh://host" };
      await assert.rejects(h.propose(), /local main session/);
      delete h.sessions.get(h.currentA)!.remote_connection;
      await assert.rejects(h.service.get(h.sourceB, draft.id), /another session or workspace/);
      assert.equal((await h.service.list(h.sourceB)).length, 0);
      await assert.rejects(h.service.cancel(h.sourceB, draft.id), /another session/);
    } finally { await h.close(); }
    const locked = harness({ allowRealHost: false });
    try {
      const off = await locked.propose();
      await assert.rejects(locked.service.start(locked.currentA, off.id, { digest: off.startDigest, confirmed: true, allowReal: true }), /host switch/);
      assert.equal(locked.calls.length, 0);
    } finally { await locked.close(); }
  });
});
