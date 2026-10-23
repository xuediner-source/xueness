import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderCallbackError, ProviderRequestError } from "@xueness/providers";
import { AgentRunner, appendUserTurn, answerSession, compact, type AgentExtension, type AgentProvider, type Row } from "../src/index.ts";
import { call, fixture } from "./fixtures.ts";

describe("agent lifecycle and durable boundaries", () => {
  it("stops a stream, preserves partial display text, releases its lease and resumes without replay", async () => {
    const local = fixture([]);
    let calls = 0;
    const provider: AgentProvider = {
      async complete() { throw new Error("stream expected"); },
      async stream(_messages, _tools, observers) {
        if (calls++ === 0) { local.runner.cancel(local.session.id as string); observers?.onDelta?.("partial response"); }
        return { content: "resumed answer" };
      },
    };
    const runner = new AgentRunner({ store: local.store, provider, toolBridge: { call: async () => { throw new Error("no effects"); }, callAll: async () => [] },
      hooks: { ...local.hooks, showReasoning: () => true }, root: local.directory });
    // Use the public cancel method from inside a streaming callback.
    provider.stream = async (_messages, _tools, observers) => {
      if (calls++ === 0) { runner.cancel(local.session.id as string); observers?.onReasoningDelta?.("bounded reasoning"); observers?.onDelta?.("partial response"); }
      return { content: "resumed answer" };
    };
    try {
      await runner.run(local.session);
      assert.equal(local.session.status, "stopped");
      assert.equal(runner.isRunning(local.session.id as string), false);
      assert.equal((local.session.interrupted_transcripts as Row[])[0]?.reasoning, "bounded reasoning");
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "assistant").length, 0);
      await runner.continue(local.session);
      assert.equal(local.session.status, "completed");
      assert.equal(calls, 2);
      const lease = await local.store.lease(local.session.id as string); await lease.release();
    } finally { local.close(); }
  });
  it("distinguishes provider failures, callback failures, local failures and timeout stops", async () => {
    for (const [error, status, reason] of [
      [new ProviderRequestError({ category: "authentication_failed" }), "provider_error", undefined],
      [new ProviderCallbackError("Error"), "paused", "local stream callback failed"],
      [new Error("private callback details"), "paused", "local run failed"],
    ] as const) {
      const local = fixture([]);
      local.provider.complete = async () => { throw error; };
      try { await assert.rejects(local.runner.run(local.session), (actual) => actual === error); assert.equal(local.session.status, status); assert.equal(local.session.pause_reason, reason); }
      finally { local.close(); }
    }
    const local = fixture([]);
    let ticks = 0;
    const runner = new AgentRunner({ store: local.store, provider: { complete: async () => { ticks = 200; return { content: "late" }; } },
      hooks: local.hooks, root: local.directory, toolBridge: { call: async () => { throw new Error("no late effects"); }, callAll: async () => [] }, now: () => ticks });
    try { await runner.run(local.session, { maxWallSeconds: 10 }); assert.equal(local.session.pause_code, "wall_time_limit_reached"); assert.equal(local.session.steps, 0); }
    finally { local.close(); }
  });
  it("fails closed on plugin policy errors and rechecks tool ownership after the provider", async () => {
    const local = fixture([{ tool_calls: [call("r1")] }], [{ ok: true }]);
    let files = true, requests = 0;
    local.hooks.enabled = (id) => id === "providers" || id === "sessions" || id === "files" && files;
    local.provider.complete = async () => { files = false; return requests++ ? { content: "The files plugin is disabled." } : { tool_calls: [call("r1")] }; };
    // ZCode: the disabled-plugin result goes back to the model instead of ending the turn.
    try { await local.runner.run(local.session); assert.equal(local.effects(), 0); assert.equal(local.session.status, "completed"); assert.equal(requests, 2); assert.equal(((local.session.results as Row).r1 as Row).error_code, "plugin_disabled"); }
    finally { local.close(); }
    const broken = fixture([]);
    broken.hooks.enabled = () => { throw new Error("bad policy state"); };
    try { await broken.runner.run(broken.session); assert.equal(broken.requests(), 0); assert.equal(broken.session.status, "paused"); }
    finally { broken.close(); }
  });
  it("keeps product hooks within their effective plugin and always settles/closes a run", async () => {
    const calls: string[] = [];
    const extension: AgentExtension = {
      id: "files", beforeRun: () => { calls.push("beforeRun"); }, runStarted: () => { calls.push("started"); },
      beforeModelRequest: () => { calls.push("beforeModel"); }, completionChecks: () => ({ file: { status: "passed" } }),
      settleRun: (_ctx, returned) => { calls.push("settle:" + returned); }, afterRun: () => { calls.push("afterRun"); }, close: () => { calls.push("close"); },
    };
    const local = fixture([{ content: "answer" }]); local.hooks.extensions = [extension];
    try { await local.runner.run(local.session); assert.deepEqual(calls, ["beforeRun", "started", "beforeModel", "settle:true", "afterRun", "close"]); assert.equal((local.session.completion as Row).delivery_status, "passed"); }
    finally { local.close(); }
    calls.length = 0;
    const disabled = fixture([{ content: "answer" }]); disabled.hooks.extensions = [{ ...extension, id: "off" }];
    try { await disabled.runner.run(disabled.session); assert.deepEqual(calls, ["close"]); }
    finally { disabled.close(); }
  });
  it("honors bounded plugin continuations through persisted human turns", async () => {
    const local = fixture([{ content: "first" }, { content: "second" }]);
    let pass = 0;
    local.hooks.extensions = [{ id: "sessions", afterRun: () => pass++ === 0 ? { action: "continue", prompt: "follow-up" } : { action: "stop" } }];
    try { await local.runner.run(local.session); assert.equal(local.requests(), 2); assert.equal(local.session.status, "completed"); assert.equal((local.session.messages as Row[]).filter((row) => row.role === "user").length, 2); assert.equal((local.session.completion_history as Row[]).length, 2); }
    finally { local.close(); }
  });
  it("does not execute intent when its durable publication fails", async () => {
    const local = fixture([{ tool_calls: [call("r1")] }], [{ ok: true }]);
    const save = local.store.save.bind(local.store);
    local.store.save = async (value) => {
      if ((value.messages as Row[]).some((row) => row.role === "assistant" && row.tool_calls)) throw new Error("disk full");
      await save(value);
    };
    try { await assert.rejects(local.runner.run(local.session), /disk full/); assert.equal(local.effects(), 0); const lease = await local.store.lease(local.session.id as string); await lease.release(); }
    finally { local.close(); }
  });
  it("pauses on approval and does not start a later side effect from the same response", async () => {
    const local = fixture([{ tool_calls: [call("r1"), call("r2")] }], [{ ok: false, output: "approve", error: { code: "approval_required", message: "approve" }, data: { awaitingApproval: true } }, { ok: true }]);
    try {
      await local.runner.run(local.session); assert.equal(local.effects(), 1); assert.equal(local.session.status, "paused"); assert.equal((local.session.messages as Row[]).filter((row) => row.role === "tool").length, 2);
      assert.equal(local.session.pause_code, "approval_required"); assert.equal(local.session.pause_reason, "等待你批准工具调用；批准后继续。");
    } finally { local.close(); }
  });
  it("ends the turn like ZCode when evidence references are invalid: no repair round, no blocked tools", async () => {
    const local = fixture([{ tool_calls: [call("r1")] }, { content: "Done\nEvidence: E9" }, { tool_calls: [call("r2")] }], [{ ok: true, content: "file" }, { ok: true }]);
    local.session.completion_reference_repair = { used: true, pending: true };
    try {
      await local.runner.run(local.session); assert.equal(local.requests(), 2); assert.equal(local.effects(), 1); assert.equal(local.session.status, "completed");
      const completion = local.session.completion as Row;
      assert.equal(completion.status, "unverified"); assert.equal(completion.error_code, "invalid_evidence_reference"); assert.equal(completion.summary, "Done");
      assert.equal(local.session.pause_reason, undefined); assert.equal(local.session.pause_code, undefined); assert.equal(Object.hasOwn(local.session, "completion_reference_repair"), false);
    } finally { local.close(); }
  });
  it("offloads oversized text for writable runs and keeps read-only runs free of artifact writes", () => {
    for (const readOnly of [false, true]) {
      const local = fixture([]);
      const content = "large output\n".repeat(3000);
      local.session.read_only = readOnly;
      (local.session.messages as Row[]).push({ role: "assistant", tool_calls: [call("r1")] }, { role: "tool", tool_call_id: "r1", content });
      try {
        compact(local.session, 2000);
        const artifact = join(local.directory, ".xueness", "artifacts", "r1.txt");
        assert.equal(existsSync(artifact), !readOnly);
        if (!readOnly) assert.equal(readFileSync(artifact, "utf8"), content);
        assert.equal((local.session.archived_messages as Row[])[0]?.content, content);
      } finally { local.close(); }
    }
  });
  it("releases invocation media bindings on both successful and failed requests", async () => {
    for (const fail of [false, true]) {
      const local = fixture([{ content: "answer" }]); let released = 0;
      const provider: AgentProvider = { async complete(messages, _tools, options) { assert.equal(messages[1], (local.session.messages as Row[])[1]); assert.ok(options?.media); if (fail) throw new Error("local failure"); return { content: "answer" }; } };
      const runner = new AgentRunner({ root: local.directory, store: local.store, provider, hooks: local.hooks,
        toolBridge: { call: async () => { throw new Error("no tools"); }, callAll: async () => [] },
        bindPrompt: (_context, messages) => ({ messages, media: {} as any, release() { released += 1; } }) });
      try { if (fail) await assert.rejects(runner.run(local.session)); else await runner.run(local.session); assert.equal(released, 1); }
      finally { local.close(); }
    }
  });
  it("appends turns and answers only at valid conversation boundaries", async () => {
    const local = fixture([]);
    try {
      await appendUserTurn(local.session, local.store, "  follow-up  "); assert.equal((local.session.messages as Row[]).at(-1)?.content, "follow-up");
      local.session.status = "running"; await assert.rejects(appendUserTurn(local.session, local.store, "race"), /not ready/);
      local.session.status = "awaiting_user"; local.session.pending_question = "where?";
      await answerSession(local.session, local.store, "  here  "); assert.equal(local.session.status, "paused"); assert.equal(local.session.pending_question, null); assert.equal((local.session.messages as Row[]).at(-1)?.content, "Operator answer: here");
    } finally { local.close(); }
  });
});
