import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { createAutoTitleWorker } from "../src/auto-title.ts";
import type { AgentProvider, Row } from "@xueness/agent";
const provider: AgentProvider = { complete: async () => { throw new Error("request callback owns the model seam"); } };
it("auto-title publication respects a concurrent manual rename and limits repeated failures", async () => {
  const base = mkdtempSync(join(tmpdir(), "xue-title-")), store = new SessionStore(join(base, "state"));
  let calls = 0, release!: (text: string) => void; const pending = new Promise<string>((resolve) => { release = resolve; });
  const worker = createAutoTitleWorker({ store, enabled: () => true, settings: () => ({}), allowModelRequests: true, acceptProvider: () => true, request: async () => { calls++; return pending; } });
  try {
    const session = await store.new("First question", base); (session.messages as Row[]).push({ role: "assistant", content: "First answer" }); session.status = "completed"; await store.save(session);
    const generating = worker.generate(String(session.id), provider);
    while (!calls) await new Promise((resolve) => setTimeout(resolve, 1));
    await store.update(String(session.id), (current) => { current.title = "User title"; current.title_source = "manual"; return true; }); release('{"title":"Generated title"}');
    assert.equal(await generating, null); assert.equal((await store.load(String(session.id))).title, "User title");
    let failures = 0; const failing = createAutoTitleWorker({ store, enabled: () => true, settings: () => ({}), allowModelRequests: true, acceptProvider: () => true, request: async () => { failures++; throw new Error("isolated failure"); } });
    const second = await store.new("Another question", base); (second.messages as Row[]).push({ role: "assistant", content: "Answer" }); second.status = "completed"; await store.save(second);
    for (let i = 0; i < 5; i++) await failing.generate(String(second.id), provider);
    assert.equal(failures, 3); assert.notEqual((await store.load(String(second.id))).title_source, "generated"); await failing.close();
  } finally { await worker.close(); rmSync(base, { recursive: true, force: true }); }
});
it("owns naming work through shutdown, skips child/lightweight turns, and cancels on plugin disable", async () => {
  const base = mkdtempSync(join(tmpdir(), "xue-title-close-")), store = new SessionStore(join(base, "state")); let calls = 0, enabled = true;
  const worker = createAutoTitleWorker({ store, enabled: () => enabled, settings: () => ({}), allowModelRequests: true, acceptProvider: () => true,
    request: async (_provider, _prompt, signal) => { calls++; await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); return null; } });
  try {
    const session = await store.new("Question", base); (session.messages as Row[]).push({ role: "assistant", content: "Answer" }); session.status = "completed"; await store.save(session);
    worker.schedule({ ...session, parent: "parent" }, provider); worker.schedule({ ...session, runtime_profile: "lightweight" }, provider); await worker.drain(); assert.equal(calls, 0);
    worker.schedule(session, provider); while (!calls) await new Promise((resolve) => setTimeout(resolve, 1)); enabled = false; await worker.drain(); assert.notEqual((await store.load(String(session.id))).title_source, "generated");
    enabled = true; worker.schedule(session, provider); while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1)); await worker.close(); assert.equal(calls, 2);
  } finally { await worker.close(); rmSync(base, { recursive: true, force: true }); }
});
