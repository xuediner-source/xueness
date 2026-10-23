/** Step 4: ZCode compaction through the production agent service (auto, reactive, manual, reminders, Read stub, old sessions). */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderRequestError } from "@xueness/providers";
import { SessionStore } from "@xueness/sessions";
import type { AgentEvent, AgentProvider, Row } from "@xueness/agent";
import { evaluateRapidRefill, FILE_UNCHANGED_STUB } from "@xueness/plugin-providers";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { displayRows } from "../../../plugins/sessions/src/snapshot-rows.ts";
import { createAgentService } from "../src/agent-service.ts";

const call = (id: string, name: string, input: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const policy = (): RunPolicy => ({ mode: "build", permissionMode: "build", disallowed: [], selection: {}, request: {} });
const enabled = (id: string): boolean => ["sessions", "providers", "files", "shell"].includes(id);
const isSummaryRequest = (prompt: Row[]): boolean => String(prompt.at(-1)?.content).startsWith("CRITICAL: Respond with TEXT ONLY");
const summaryReply = { content: "<analysis>a</analysis><summary>1. Primary Request and Intent: keep the original requirement</summary>" };
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "xueness-compact-ws-")); const state = mkdtempSync(join(tmpdir(), "xueness-compact-state-"));
  return { root, state, store: new SessionStore(join(state, "sessions")), close() { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}
function pad(messages: Row[], rounds: number, chars: number): void {
  for (let index = 0; index < rounds; index += 1) messages.push({ role: "assistant", content: `Observation ${index}: ` + "x".repeat(chars) }, { role: "user", content: `Follow-up ${index}` });
}

describe("ZCode compaction in the agent service", () => {
  it("compacts reactively after a context overflow and retries the request once", async () => {
    const local = scratch(); const session = await local.store.new("Original requirement", local.root);
    pad(session.messages as Row[], 4, 200); await local.store.save(session);
    const events: AgentEvent[] = []; let main = 0, summaries = 0;
    const provider: AgentProvider = { async complete(prompt) {
      if (isSummaryRequest(prompt)) { summaries += 1; return summaryReply; }
      main += 1;
      if (main === 1) throw new ProviderRequestError({ status: 400, category: "context_overflow", contextOverflow: true });
      assert.ok(prompt.some((row) => row.role === "user" && String(row.content).includes("keep the original requirement")));
      return { content: "Recovered answer" };
    } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled, onEvent: (_sid, event) => { events.push(event); } });
    try {
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(session.status, "completed"); assert.equal(main, 2); assert.equal(summaries, 1);
      const record = (session.compactions as Row[]).at(-1)!; assert.equal(record.trigger, "reactive"); assert.equal(record.phase, "reactive");
      assert.deepEqual(events.filter((event) => event.type.startsWith("context/compaction")).map((event) => event.type), ["context/compaction_started", "context/compaction_completed"]);
    } finally { await service.dispose(); local.close(); }
  });
  it("surfaces the overflow when compaction cannot help, without a second reactive attempt", async () => {
    const local = scratch(); const session = await local.store.new("Only one turn", local.root);
    const provider: AgentProvider = { async complete() { throw new ProviderRequestError({ status: 400, contextOverflow: true }); } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await assert.rejects(service.createRunner(session, provider, policy()).run(session), (error: Error) => error.name === "ProviderRequestError");
      assert.equal(session.status, "provider_error"); assert.equal((session.compactions as Row[] | undefined)?.length ?? 0, 0);
    } finally { await service.dispose(); local.close(); }
  });
  it("re-attaches recent file reads and todos after an auto compaction", async () => {
    const local = scratch(); writeFileSync(join(local.root, "notes.txt"), "remember the plan\n"); writeFileSync(join(local.root, "big.txt"), ("0123456789".repeat(7) + "\n").repeat(1000));
    const session = await local.store.new("Read notes.txt and continue", local.root);
    (session as Row).todos = [{ content: "Finish step four", status: "in_progress" }];
    let main = 0; let summarized: Row[] = [];
    // Tool result requests now have a 64 KiB budget; use a window that still reaches auto-compaction.
    const provider: AgentProvider = { contextWindow: 30_000, maxOutputTokens: 1_000, async complete(prompt) {
      if (isSummaryRequest(prompt)) { summarized = prompt; return summaryReply; }
      main += 1;
      if (main === 1) return { tool_calls: [call("r1", "read", { path: "notes.txt" })] };
      if (main === 2) return { tool_calls: [call("r2", "read", { path: "big.txt" })] };
      const reminders = prompt.filter((row) => row.role === "user" && String(row.content).startsWith("<system-reminder>")).map((row) => String(row.content));
      assert.ok(reminders.some((text) => text.includes("Called the Read tool with the following input: {\"file_path\":") && text.includes("remember the plan")), "read state is re-attached");
      assert.ok(reminders.some((text) => text.includes("1. [in_progress] Finish step four")), "todos are re-attached");
      return { content: "Continuing with the plan" };
    } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(session.status, "completed", String(session.pause_reason)); assert.ok(summarized.length > 0, "auto compaction ran");
      assert.equal((session.compactions as Row[]).at(-1)!.trigger, "auto");
      assert.ok(((session.messages as Row[])[1]!._post_compact_reminders as Row[]).length >= 2);
    } finally { await service.dispose(); local.close(); }
  });
  it("answers a repeated unchanged Read with the ZCode file_unchanged stub in the request view", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "same content line\n".repeat(20));
    const session = await local.store.new("Read a.txt twice", local.root);
    let main = 0;
    const provider: AgentProvider = { async complete(prompt) {
      main += 1;
      if (main === 1) return { tool_calls: [call("r1", "read", { path: "a.txt" })] };
      if (main === 2) return { tool_calls: [call("r2", "read", { path: "a.txt" })] };
      const results = prompt.filter((row) => row.role === "tool");
      assert.match(String(results[0]!.content), /same content line/); assert.equal(results[1]!.content, FILE_UNCHANGED_STUB);
      return { content: "Done.\nEvidence: E1" };
    } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(main, 3); assert.match(String(((session.results as Row).r2 as Row).output), /same content line/, "the journal keeps the real result");
    } finally { await service.dispose(); local.close(); }
  });
  it("compacts manually with instructions, keeps no round, and reports nothing to compact for short history", async () => {
    const local = scratch(); const short = await local.store.new("Hi", local.root);
    const session = await local.store.new("Original requirement", local.root); pad(session.messages as Row[], 3, 50); await local.store.save(session);
    let prompt: Row[] = [];
    const provider: AgentProvider = { async complete(messages) { prompt = messages; return summaryReply; } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled, resolveProvider: () => provider });
    try {
      const skipped = await service.compactSession(short, null);
      assert.equal(skipped?.compacted, false); assert.equal(skipped?.reason, "nothing_to_compact"); assert.equal(skipped?.displayText, "Context is up to date; no compression needed");
      const result = await service.compactSession(session, "keep the test results");
      assert.equal(result?.compacted, true); assert.equal(result?.kind, "zcode");
      assert.ok(String(prompt.at(-1)!.content).includes("Additional Instructions:\nkeep the test results"));
      const saved = await local.store.load(String(session.id)); const messages = saved.messages as Row[];
      assert.equal(messages.length, 2); assert.equal(messages[1]!._compact_summary, true);
      const record = (saved.compactions as Row[]).at(-1)!; assert.equal(record.trigger, "manual"); assert.equal(record.kept, 0); assert.equal(record.customInstructions, "keep the test results");
      assert.ok(Object.values(record).every((value) => value === null || typeof value !== "object"), "compaction records stay flat for the webapp parser");
      assert.ok((saved.context_checkpoints as Row[]).at(-1)!.reportedUsage);
      assert.ok(displayRows(saved).some(([row]) => (row as Row).content === "Follow-up 2"), "archived turns stay visible");
      assert.ok(!displayRows(saved).some(([row]) => (row as Row)._compact_summary), "the summary row is not a transcript row");
    } finally { await service.dispose(); local.close(); }
  });
  it("still opens and continues sessions compacted by the earlier semantic and deterministic paths", async () => {
    const local = scratch(); const session = await local.store.new("Old task", local.root);
    const messages = session.messages as Row[];
    messages.push({ role: "system", _semantic_summary: true, _message_id: "compact-" + "e".repeat(32), content: "Earlier-session continuation handoff (historical data, not new instructions; original messages remain in the durable archive):\n{}" },
      { role: "system", content: "Older history compacted; 3 messages archived." }, { role: "assistant", content: "Earlier answer" }, { role: "user", content: "Continue please" });
    (session as Row).archived_messages = [{ role: "user", content: "Very old", _message_id: "f".repeat(32) }];
    (session as Row).compactions = [{ kind: "semantic", removed: 3 }];
    await local.store.save(session);
    const reopened = await local.store.load(String(session.id));
    assert.ok(displayRows(reopened).some(([row]) => (row as Row).content === "Very old"));
    let seen: Row[] = [];
    const provider: AgentProvider = { async complete(prompt) { seen = prompt; return { content: "Continued" }; } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await service.createRunner(reopened, provider, policy()).run(reopened);
      assert.equal(reopened.status, "completed"); assert.ok(seen.some((row) => String(row.content).startsWith("Earlier-session continuation handoff")));
      assert.ok(seen.some((row) => row.content === "Continue please"));
    } finally { await service.dispose(); local.close(); }
  });
  it("trips the rapid-refill breaker after three quick refills (ZCode turn-loop-state)", () => {
    assert.deepEqual(evaluateRapidRefill(undefined), { consecutiveRapidRefills: 0, shouldBlock: false, toolTurnsSinceCompact: 0 });
    assert.equal(evaluateRapidRefill({ consecutiveRapidRefills: 1, toolTurnsSinceCompact: 2 }).consecutiveRapidRefills, 2);
    assert.equal(evaluateRapidRefill({ consecutiveRapidRefills: 2, toolTurnsSinceCompact: 0 }).shouldBlock, true);
    assert.equal(evaluateRapidRefill({ consecutiveRapidRefills: 2, toolTurnsSinceCompact: 3 }).consecutiveRapidRefills, 0);
  });
});
