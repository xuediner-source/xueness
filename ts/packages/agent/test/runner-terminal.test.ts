import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentRunner, type AgentExtension, type Row } from "../src/index.ts";
import { fixture } from "./fixtures.ts";

describe("runner honors terminal goal stops (C-WFL-03)", () => {
  it("never starts a later round after an extension's explicit stop decision", async () => {
    const local = fixture([{ content: "first answer" }, { content: "second answer" }]);
    // The goal owner stops (budget reached / user pause); a second extension
    // still votes continue — the run must not append another turn.
    const stops: AgentExtension = { id: "files", afterRun: () => ({ action: "stop", prompt: "", reason: "已达到目标 token 上限。", stopCode: "budget_limited" }) };
    let votes = 0;
    const other: AgentExtension = { id: "sessions", afterRun: () => { votes += 1; return { action: "continue", prompt: "follow-up" }; } };
    local.hooks.extensions = [stops, other];
    try {
      await local.runner.run(local.session);
      assert.equal(local.requests(), 1, "no further round starts after the terminal stop");
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "user").length, 1, "no continuation prompt is appended");
      assert.equal(local.session.status, "completed");
      assert.equal(votes, 0, "later continue votes never run after a terminal stop");
    } finally { local.close(); }
  });

  it("journals run_stop for terminal decisions, cancellations and deadlines only", async () => {
    const terminal = fixture([{ content: "first answer" }]);
    terminal.hooks.extensions = [{ id: "files", afterRun: () => ({ action: "stop", prompt: "", reason: "已达到目标 token 上限。", stopCode: "budget_limited" }) }];
    try {
      await terminal.runner.run(terminal.session);
      assert.deepEqual(terminal.session.run_stop, { code: "budget_limited", reason: "已达到目标 token 上限。", owner: "files" });
    } finally { terminal.close(); }

    const natural = fixture([{ content: "first answer" }]);
    try {
      await natural.runner.run(natural.session);
      assert.equal("run_stop" in natural.session, false, "natural exhaustion journals no stop record");
    } finally { natural.close(); }

    const cancelled = fixture([{ content: "first answer" }]);
    const controller = new AbortController();
    cancelled.hooks.extensions = [{ id: "files", afterRun: () => controller.abort() }];
    try {
      await cancelled.runner.run(cancelled.session, { signal: controller.signal });
      assert.deepEqual(cancelled.session.run_stop, { code: "cancelled", reason: "run was cancelled" });
    } finally { cancelled.close(); }
  });

  it("keeps bounded plugin continuations working when no terminal stop is returned", async () => {
    const local = fixture([{ content: "first" }, { content: "second" }]);
    let pass = 0;
    local.hooks.extensions = [{ id: "sessions", afterRun: () => (pass++ === 0 ? { action: "continue", prompt: "follow-up" } : { action: "stop" }) }];
    try {
      await local.runner.run(local.session);
      assert.equal(local.requests(), 2);
      assert.equal(local.session.status, "completed");
    } finally { local.close(); }
  });

  it("appends a continuation through an owning appendTurn hook instead of a plain human turn", async () => {
    const local = fixture([{ content: "first" }, { content: "second" }]);
    const appended: Row[] = [];
    let pass = 0;
    const owner: AgentExtension = {
      id: "sessions",
      afterRun: () => (pass++ === 0 ? { action: "continue", prompt: "goal continuation prompt", exclusive: true } : { action: "stop", prompt: "", reason: "verified" }),
      async appendTurn(_context, text) {
        const journal = local.session.messages as Row[];
        journal.push({ role: "user", content: text, _input_kind: "goal_continuation", _meta_source: "target_continuation" });
        local.session.status = "pending"; local.session.completion = null;
        appended.push(journal.at(-1)!);
        return true;
      },
    };
    local.hooks.extensions = [owner];
    try {
      await local.runner.run(local.session);
      assert.equal(local.requests(), 2);
      assert.equal(appended.length, 1);
      assert.equal(appended[0]!._input_kind, "goal_continuation");
      assert.equal((local.session.messages as Row[]).filter((row) => row.role === "user").length, 2);
      assert.equal(local.session.status, "completed");
    } finally { local.close(); }
  });
});
