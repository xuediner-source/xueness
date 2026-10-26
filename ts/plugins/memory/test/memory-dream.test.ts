import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MemoryDreamOptions, MemoryDreamRow, MemoryDreamTool, MemoryDreamToolContext } from "../src/memory-dream-types.ts";
import { MemoryDreamService, MemoryDreamServiceError } from "../src/memory-dream-service.ts";
import { createMemoryDreamApi, MEMORY_DREAM_ROUTES } from "../src/memory-dream-http.ts";

const sid = (value: number): string => value.toString(16).padStart(32, "0");
const digest = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

function fixture(synthesize?: MemoryDreamOptions["synthesize"], tools?: MemoryDreamTool[]) {
  const base = mkdtempSync(join(tmpdir(), "xueness-memory-dream-"));
  const rootA = join(base, "project-a"), rootB = join(base, "project-b"), stateDir = join(base, "state");
  const currentA = sid(1), sourceA = sid(2), currentB = sid(3), sourceB = sid(4);
  const sessions = new Map<string, MemoryDreamRow>([
    [currentA, { id: currentA, root: rootA, status: "idle", updated_at: "2026-10-22T00:00:00Z", messages: [{ role: "user", _message_id: sid(11), content: "Choose a durable build convention." }] }],
    [sourceA, { id: sourceA, root: rootA, status: "idle", updated_at: "2026-10-23T00:00:00Z", messages: [
      { role: "user", _message_id: sid(12), content: "Use pnpm for builds; API_KEY=not-a-real-secret" },
      { role: "tool", _message_id: sid(13), content: "private provider output" },
      { role: "assistant", _message_id: sid(14), content: "Builds use pnpm." },
    ] }],
    [currentB, { id: currentB, root: rootB, status: "idle", messages: [{ role: "user", _message_id: sid(15), content: "Different project." }] }],
    [sourceB, { id: sourceB, root: rootB, status: "idle", messages: [{ role: "user", _message_id: sid(16), content: "Private to project B." }] }],
  ]);
  const keys = new Map([[rootA, "old A key"], [rootB, "old B key"]]);
  let modelCalls = 0, writeCalls = 0;
  const enabled = new Set(["memory", "sessions", "providers"]);
  const options: MemoryDreamOptions = {
    stateDir,
    enabled: (id) => enabled.has(id),
    allowRealHost: true,
    async owner(id) {
      const row = sessions.get(id);
      if (!row) throw Object.assign(new Error("missing session"), { code: "ENOENT" });
      return row;
    },
    async listSessions(root) { return [...sessions.values()].filter((row) => row.root === root); },
    async readKey(root) { const content = keys.get(root); if (content === undefined) throw new Error("unknown workspace"); return { content, digest: digest(content) }; },
    async writeKey(root, input) {
      writeCalls += 1;
      if (digest(keys.get(root) ?? "") !== input.digest) throw Object.assign(new Error("CAS conflict"), { status: 409 });
      keys.set(root, input.content);
      return { content: input.content, digest: digest(input.content) };
    },
    async synthesize(ownerSessionId, prompt, signal) {
      modelCalls += 1;
      assert.equal(ownerSessionId, currentA);
      assert.match(prompt, /untrusted data/i);
      assert.doesNotMatch(prompt, /not-a-real-secret/);
      if (synthesize) return synthesize(ownerSessionId, prompt, signal);
      return { value: { content: "Use pnpm for builds.\n", summary: "Confirmed build convention", sourceSessionIds: [sourceA] }, usage: { input_tokens: 8, output_tokens: 5 } };
    },
    ...(tools ? { tools } : {}),
  };
  const service = new MemoryDreamService(options);
  return { base, rootA, rootB, stateDir, currentA, sourceA, currentB, sourceB, sessions, keys, enabled, service, get modelCalls() { return modelCalls; }, get writeCalls() { return writeCalls; } };
}

const proposeA = (f: ReturnType<typeof fixture>) => f.service.propose(f.currentA, { sourceSessionIds: [f.sourceA] });
async function closeFixture(f: ReturnType<typeof fixture>): Promise<void> { await f.service.close(); rmSync(f.base, { recursive: true, force: true }); }

describe("memory dream service", () => {
  it("creates a zero-model draft with stable transcript evidence and enforces project ownership", async () => {
    const f = fixture();
    try {
      const draft = await proposeA(f);
      assert.equal(draft.status, "draft");
      assert.equal(f.modelCalls, 0);
      assert.equal(draft.sourceSessionIds.length, 1);
      assert.equal(draft.sources[0]?.messages.length, 2);
      assert.equal(draft.sources[0]?.messages[0]?.content.includes("[REDACTED]"), true);
      assert.equal((await f.service.list(f.currentB)).length, 0);
      await assert.rejects(f.service.get(f.currentB, draft.id), (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 403);
      const stored = await f.service.get(f.currentA, draft.id);
      assert.equal(stored.startDigest, draft.startDigest);
      assert.equal(stored.applyDigest, null);
    } finally { await closeFixture(f); }
  });

  it("requires explicit real-model approval, exposes usage, and applies exactly once with CAS provenance", async () => {
    const f = fixture();
    try {
      const draft = await proposeA(f);
      assert.equal(f.modelCalls, 0);
      await assert.rejects(f.service.start(f.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: false }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 403);
      await f.service.start(f.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      await f.service.wait(draft.id);
      const ready = await f.service.get(f.currentA, draft.id);
      assert.equal(ready.status, "ready");
      assert.deepEqual(ready.usage, { input_tokens: 8, output_tokens: 5 });
      assert.equal(ready.applyDigest !== null, true);
      assert.equal(ready.candidate?.content, "Use pnpm for builds.\n");
      const applied = await f.service.apply(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: true });
      assert.equal(applied.status, "applied");
      assert.equal(applied.provenance?.source, "memory-dream");
      assert.equal(f.keys.get(f.rootA), "Use pnpm for builds.\n");
      assert.equal(f.writeCalls, 1);
      await f.service.apply(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: true });
      assert.equal(f.writeCalls, 1);
    } finally { await closeFixture(f); }
  });

  it("reviews a ready candidate as a unified diff and reverts an applied dream to its baseline", async () => {
    const f = fixture();
    try {
      const draft = await proposeA(f);
      await assert.rejects(f.service.diff(f.currentA, draft.id), (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      await f.service.start(f.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      await f.service.wait(draft.id);
      const ready = await f.service.get(f.currentA, draft.id);
      const diff = await f.service.diff(f.currentA, draft.id);
      assert.equal(diff.baseDigest, digest("old A key"));
      assert.equal(diff.candidateDigest, digest("Use pnpm for builds.\n"));
      assert.equal(diff.oldLines, 1);
      assert.equal(diff.newLines, 1);
      assert.equal(diff.addedLines, 1);
      assert.equal(diff.removedLines, 1);
      assert.equal(diff.truncated, false);
      assert.deepEqual(diff.hunks[0]?.lines.map((line) => line.op), ["remove", "add"]);
      assert.deepEqual(diff.hunks[0]?.lines.map((line) => line.text), ["old A key", "Use pnpm for builds."]);
      const applied = await f.service.apply(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: true });
      assert.equal(applied.status, "applied");
      await assert.rejects(f.service.revert(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: false }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      await assert.rejects(f.service.revert(f.currentA, draft.id, { digest: digest("other candidate"), confirmed: true }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      const reverted = await f.service.revert(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: true });
      assert.equal(reverted.status, "reverted");
      assert.equal(f.keys.get(f.rootA), "old A key");
      assert.equal(f.writeCalls, 2);
      assert.equal(typeof reverted.provenance?.revertKeyDigest, "string");
      assert.equal(reverted.provenance?.source, "memory-dream");
      await f.service.revert(f.currentA, draft.id, { digest: ready.applyDigest!, confirmed: true });
      assert.equal(f.writeCalls, 2);
      await assert.rejects(f.service.cancel(f.currentA, draft.id),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
    } finally { await closeFixture(f); }
  });

  it("refuses to revert when project memory drifted or the owner session is read-only", async () => {
    const f = fixture();
    try {
      const drifted = await proposeA(f);
      await f.service.start(f.currentA, drifted.id, { digest: drifted.startDigest, confirmed: true, allowReal: true });
      await f.service.wait(drifted.id);
      const driftedReady = await f.service.get(f.currentA, drifted.id);
      await f.service.apply(f.currentA, drifted.id, { digest: driftedReady.applyDigest!, confirmed: true });
      f.keys.set(f.rootA, "operator edited KEY.md");
      await assert.rejects(f.service.revert(f.currentA, drifted.id, { digest: driftedReady.applyDigest!, confirmed: true }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      const second = await proposeA(f);
      await f.service.start(f.currentA, second.id, { digest: second.startDigest, confirmed: true, allowReal: true });
      await f.service.wait(second.id);
      const secondReady = await f.service.get(f.currentA, second.id);
      await f.service.apply(f.currentA, second.id, { digest: secondReady.applyDigest!, confirmed: true });
      f.sessions.get(f.currentA)!.read_only = true;
      await assert.rejects(f.service.revert(f.currentA, second.id, { digest: secondReady.applyDigest!, confirmed: true }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 403);
    } finally { await closeFixture(f); }
  });

  it("runs the bounded read-only dream tool loop before producing the candidate", async () => {
    const prompts: string[] = [], contexts: MemoryDreamToolContext[] = [];
    const tool: MemoryDreamTool = {
      name: "read_project_key", description: "Re-read the current project KEY.md (read-only).",
      async invoke(context) { contexts.push({ root: context.root, sourceSessionIds: [...context.sourceSessionIds] }); return { content: "old A key", digest: "unchecked" }; },
    };
    let calls = 0;
    const f = fixture(async (_owner, prompt) => {
      prompts.push(prompt);
      calls += 1;
      return calls === 1
        ? { value: { dreamTool: "read_project_key", input: {} }, usage: "unknown" }
        : { value: { content: "Use pnpm for builds.\n", summary: "Confirmed build convention", sourceSessionIds: [f.sourceA] }, usage: { input_tokens: 8, output_tokens: 5 } };
    }, [tool]);
    try {
      const draft = await proposeA(f);
      await f.service.start(f.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      await f.service.wait(draft.id);
      const ready = await f.service.get(f.currentA, draft.id);
      assert.equal(ready.status, "ready");
      assert.equal(f.modelCalls, 2);
      assert.equal(calls, 2);
      assert.match(prompts[0]!, /read_project_key/);
      assert.match(prompts[1]!, /"tool":\s*"read_project_key"/);
      assert.match(prompts[1]!, /old A key/);
      assert.deepEqual(contexts, [{ root: f.rootA, sourceSessionIds: [f.sourceA] }]);
      assert.equal(ready.candidate?.content, "Use pnpm for builds.\n");
    } finally { await closeFixture(f); }
  });

  it("rejects start when either the base KEY or a captured source has drifted", async () => {
    const f = fixture();
    try {
      const keyDraft = await proposeA(f);
      f.keys.set(f.rootA, "operator edited KEY.md");
      await assert.rejects(f.service.start(f.currentA, keyDraft.id, { digest: keyDraft.startDigest, confirmed: true, allowReal: true }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      const sourceDraft = await proposeA(f);
      (f.sessions.get(f.sourceA)!.messages as MemoryDreamRow[])[0]!.content = "New project decision.";
      await assert.rejects(f.service.start(f.currentA, sourceDraft.id, { digest: sourceDraft.startDigest, confirmed: true, allowReal: true }),
        (error: unknown) => error instanceof MemoryDreamServiceError && error.status === 409);
      assert.equal(f.modelCalls, 0);
    } finally { await closeFixture(f); }
  });

  it("drains on cancellation, disable and close without applying the candidate", async () => {
    const f = fixture(async (_sid, _prompt, signal) => await new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ value: { content: "never apply", summary: "cancelled", sourceSessionIds: [f.sourceA] }, usage: "unknown" }), { once: true });
    }));
    try {
      const draft = await proposeA(f);
      await f.service.start(f.currentA, draft.id, { digest: draft.startDigest, confirmed: true, allowReal: true });
      f.enabled.delete("memory");
      const cancelled = await f.service.cancel(f.currentA, draft.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(f.writeCalls, 0);
      f.enabled.add("memory");
      const next = await proposeA(f);
      await f.service.start(f.currentA, next.id, { digest: next.startDigest, confirmed: true, allowReal: true });
      await f.service.close();
      const persisted = JSON.parse(readFileSync(join(f.stateDir, "memory-dreams", `${next.id}.json`), "utf8")) as MemoryDreamRow;
      assert.equal(persisted.status, "cancelled");
      assert.equal(f.writeCalls, 0);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("caps combined evidence at 40000 Unicode code points", async () => {
    const f = fixture();
    try {
      (f.sessions.get(f.sourceA)!.messages as MemoryDreamRow[]).push({ role: "assistant", _message_id: sid(17), content: "😀".repeat(50_000) });
      (f.sessions.get(f.currentA)!.messages as MemoryDreamRow[])[0]!.content = "😺".repeat(50_000);
      const draft = await f.service.propose(f.currentA, { sourceSessionIds: [f.sourceA, f.currentA] });
      const total = draft.sources.flatMap((source) => source.messages).reduce((sum, message) => sum + Array.from(message.content).length, 0);
      assert.equal(total, 40_000);
    } finally { await closeFixture(f); }
  });

  it("routes only collection writes and explicit start, cancel and apply actions", async () => {
    const f = fixture();
    try {
      const api = createMemoryDreamApi(f.service), base = ["api", "sessions", f.currentA, "memory-dreams"];
      assert.deepEqual(api.routes, [
        "GET /api/sessions/:id/memory-dreams", "POST /api/sessions/:id/memory-dreams", "GET /api/sessions/:id/memory-dreams/:dreamId",
        "GET /api/sessions/:id/memory-dreams/:dreamId/diff", "POST /api/sessions/:id/memory-dreams/:dreamId/start", "POST /api/sessions/:id/memory-dreams/:dreamId/cancel", "POST /api/sessions/:id/memory-dreams/:dreamId/apply", "POST /api/sessions/:id/memory-dreams/:dreamId/revert",
      ]);
      assert.equal(api.owns("POST", [...base, sid(31)]), true);
      assert.equal(api.owns("GET", ["api", "memory", "tracks"]), false);
      const proposed = await api.dispatch("POST", base, {}, { sourceSessionIds: [f.sourceA] });
      assert.equal(proposed?.[0], 200);
      const record = proposed?.[1] as { id: string };
      assert.equal((await api.dispatch("POST", [...base, record.id], {}, {}))?.[0], 405);
      assert.equal((await api.dispatch("GET", [...base, record.id], {}, {}))?.[0], 200);
      assert.equal((await api.dispatch("POST", [...base, record.id, "start"], {}, { digest: "bad", confirmed: true, allowReal: true }))?.[0], 409);
      assert.equal((await api.dispatch("GET", [...base, record.id, "diff"], {}, {}))?.[0], 409);
      assert.equal((await api.dispatch("POST", [...base, record.id, "revert"], {}, { digest: "bad", confirmed: true }))?.[0], 409);
      assert.equal((await api.dispatch("GET", [...base, "f".repeat(32), "diff"], {}, {}))?.[0], 404);
    } finally { await closeFixture(f); }
  });
});
