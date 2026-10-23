import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Row } from "../src/index.ts";
import { OUTPUT_TOKEN_CONTINUE_PROMPT } from "../src/loop-guards.ts";
import { call, fixture } from "./fixtures.ts";

/** Records every provider request so tests can inspect the model-visible prompt. */
function recording(responses: Row[], outcomes: Row[] = [], extra: Parameters<typeof fixture>[2] = {}) {
  const local = fixture(responses, outcomes, extra);
  const seen: Row[][] = [];
  const original = local.provider.complete.bind(local.provider);
  local.provider.complete = async (messages, tools, options) => { seen.push(structuredClone(messages)); return original(messages, tools, options); };
  return { ...local, seen };
}
const assistants = (session: Row): unknown[] => (session.messages as Row[]).filter((row) => row.role === "assistant").map((row) => row.content);

describe("ZCode-aligned agent loop (TS only)", () => {
  it("has no default step or wall-time cap and stops when the model stops calling tools", async () => {
    let ticks = 0;
    const calls = Array.from({ length: 12 }, (_, i) => ({ tool_calls: [call(`r${i}`, JSON.stringify({ i }))] }));
    const local = recording([...calls, { content: "All twelve reads are done." }], calls.map(() => ({ ok: true, content: "file" })), { now: () => ticks });
    const complete = local.provider.complete;
    local.provider.complete = async (...args) => { ticks += 50; return complete(...args); };
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "completed"); assert.equal(local.session.steps, 13); assert.equal(local.effects(), 12);
      assert.equal(local.session.pause_code, undefined); assert.ok(ticks > 120);
    } finally { local.close(); }
  });
  it("still honors explicit caller bounds", async () => {
    const local = recording([{ tool_calls: [call("r1", '{"i":1}')] }, { tool_calls: [call("r2", '{"i":2}')] }, { content: "late" }], [{ ok: true }, { ok: true }]);
    try { await local.runner.run(local.session, { maxSteps: 2 }); assert.equal(local.session.status, "paused"); assert.equal(local.session.pause_code, "step_limit_reached"); assert.equal(local.effects(), 2); }
    finally { local.close(); }
  });
  it("warns once after three identical calls and keeps running instead of stalling", async () => {
    const repeated = Array.from({ length: 4 }, (_, i) => ({ tool_calls: [call(`r${i}`, '{"path": "a.txt"}')] }));
    const local = recording([...repeated, { content: "Stopped repeating." }], repeated.map(() => ({ ok: true, content: "same" })));
    const warning = "You have called read with the same input 3 times in a row.";
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "completed"); assert.equal(local.effects(), 4);
      assert.deepEqual(local.seen.map((messages) => String(messages[0]!.content).includes(warning)), [false, false, false, true, false]);
      assert.ok(Object.values(local.session.results as Row).every((result) => (result as Row).ok === true));
    } finally { local.close(); }
  });
  it("resumes an output-token cut with a turn-local prompt that is never persisted", async () => {
    const local = recording([{ content: "Part one", _finish_reason: "length" }, { content: " part two", _finish_reason: "max_tokens" }, { content: "Done." }]);
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "completed"); assert.equal(local.session.steps, 3);
      assert.deepEqual(assistants(local.session), ["Part one", " part two", "Done."]);
      assert.ok(!(local.session.messages as Row[]).some((row) => row.content === OUTPUT_TOKEN_CONTINUE_PROMPT));
      const tail = (messages: Row[]) => messages.slice(2).map((row) => [row.role, row.content]);
      assert.deepEqual(tail(local.seen[1]!), [["assistant", "Part one"], ["user", OUTPUT_TOKEN_CONTINUE_PROMPT]]);
      assert.deepEqual(tail(local.seen[2]!), [["assistant", "Part one"], ["user", OUTPUT_TOKEN_CONTINUE_PROMPT], ["assistant", " part two"], ["user", OUTPUT_TOKEN_CONTINUE_PROMPT]]);
    } finally { local.close(); }
  });
  it("pauses with the incomplete record after the fourth consecutive cut", async () => {
    const local = recording(Array.from({ length: 4 }, (_, i) => ({ content: `p${i}`, _finish_reason: "length" })));
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "paused"); assert.equal(local.session.steps, 4);
      assert.match(String((local.session.completion as Row).error_code), /^generation_/);
      assert.deepEqual(assistants(local.session), ["p0", "p1", "p2", "p3"]);
    } finally { local.close(); }
  });
  it("runs tool calls from a cut response and feeds non-approval failures back to the model", async () => {
    const local = recording([{ content: "", tool_calls: [call("r1")], _finish_reason: "length" }, { tool_calls: [call("r2", '{"x":1}')] }, { content: "Handled the failure." }],
      [{ ok: true }, { ok: false, error: "boom", retryable: false }]);
    try { await local.runner.run(local.session); assert.equal(local.session.status, "completed"); assert.equal(local.effects(), 2); assert.equal(local.seen.length, 3); }
    finally { local.close(); }
  });
  it("suspends only for an approval request", async () => {
    const local = recording([{ tool_calls: [call("r1")] }], [{ ok: false, error: { code: "approval_required", message: "needs approval" }, data: { awaitingApproval: true } }]);
    try { await local.runner.run(local.session); assert.equal(local.session.status, "paused"); assert.equal(local.session.pause_code, "approval_required"); assert.equal(local.seen.length, 1); }
    finally { local.close(); }
  });
});
