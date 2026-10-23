import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assess, compact, currentTurnAliases, currentTurnToolIds, evidenceAliases, partitionUnits, recordCompletionHistory, toolExecutionStatus, turnId, validateMessage, type Row } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { call, fixture, oracle, project, session } from "./fixtures.ts";

describe("agent Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("partitions interleaved calls, multiple results and orphans exactly", () => {
    const rows: Row[][] = [[], [{ role: "tool", tool_call_id: "missing", content: "orphan" }], [
      { role: "assistant", content: "a", tool_calls: [call("a"), call("b")] },
      { role: "user", content: "human turn" }, { role: "assistant", tool_calls: [call("c")] },
      { role: "tool", tool_call_id: "c", content: "c" }, { role: "tool", tool_call_id: "a", content: "a" },
      { role: "tool", tool_call_id: "b", content: "b" }, { role: "assistant", content: "done" },
    ]];
    const expected = oracle(rows.map((messages) => ({ op: "partition", messages })));
    rows.forEach((messages, index) => assert.deepEqual(partitionUnits(messages).map((unit) => ({ ...unit, ids: [...unit.ids].sort() })), expected[index]));
  });
  it("matches compaction across masking, drop, user preservation, annotations and Unicode", () => {
    const inputs: Row[] = [];
    for (let seed = 0; seed < 30; seed += 1) {
      const value = session(); value.read_only = true;
      const messages = value.messages as Row[];
      for (let turn = 0; turn < seed % 7 + 1; turn += 1) {
        const id = `call-${turn}`;
        messages.push({ role: "assistant", content: "Inspect 🕊️ ".repeat(seed * 3), tool_calls: [call(id)] });
        messages.push({ role: "tool", tool_call_id: id, content: "large output 中文🧪".repeat(seed * 8 + 3) });
        if (turn % 2) messages.push({ role: "user", content: `Keep human words exactly ${turn} \n\t中文🕊️` });
      }
      value.message_annotations = { "2": { owner: "sessions", label: "a" }, "3": "tool", "-1": "invalid" };
      value.reasoning_history = [{ message_index: 2, text: "r" }, { message_index: 4, text: "r2" }, { message_index: true, text: "bad" }];
      value.reasoning_timing = [{ message_index: 2, started_at: "start", ended_at: "end" }];
      inputs.push({ op: "compact", session: value, maxChars: [300, 2400, 50000][seed % 3], maxTokens: 80, instructions: "  Carry\n these  facts  " });
    }
    const expected = oracle(inputs);
    inputs.forEach((input, index) => { const value = structuredClone(input.session as Row); compact(value, input.maxChars as number, input.maxTokens as number, input.instructions as string); assert.deepEqual(value, expected[index], `seed ${index}`); });
  });
  it("matches evidence, retry supersession, private envelopes and bounded history", () => {
    const value = session();
    (value.messages as Row[]).push({ role: "assistant", tool_calls: [call("failed", '{"x": 1}'), call("succeeded", '{"x":1}')] });
    value.results = { failed: { ok: false }, succeeded: { ok: true }, old: { ok: true, evidence_eligible: false } };
    value.evidence_aliases = { fake: "succeeded", E4: "old", E7: "succeeded" };
    value.delivery_requirements = { z: "中文", a: [true, 3] };
    value.completion_history = Array.from({ length: 205 }, () => ({ status: "old" }));
    const record = { status: "verified", verified: true, summary: "🕊️".repeat(4100), delivery_status: "passed" };
    const texts = ["plain", '{"answer":"done","evidence":[{"evidence_id":"E7","observation":"read file"}]}',
      'Surrounding prose\n\n```json\n{"summary":"hidden","evidence":[{"tool_call_id":"succeeded","observation":"observed"}]}\n```\n\nAfter',
      "Native answer\nEvidence: E7", "Code example\n```\nEvidence: E7", '{"answer":"done","evidence":[{"evidence_id":"E99","observation":"bad"}]}'];
    const inputs = texts.map((content) => ({ op: "completion", session: structuredClone(value), content, native: true, record }));
    const expected = oracle(inputs);
    inputs.forEach((input, index) => {
      const local = input.session;
      const aliases = evidenceAliases(local); const ids = currentTurnToolIds(local); recordCompletionHistory(local, record);
      assert.deepEqual({ aliases, ids, currentAliases: currentTurnAliases(aliases, ids), toolStatus: toolExecutionStatus(local, ids), turnId: turnId(local), assessment: assess(input.content, local.results as Row, aliases, true), history: local.completion_history }, expected[index]);
    });
  });
  it("validates provider intent with the same errors before effects", () => {
    const messages: unknown[] = [null, [], {}, { content: 3 }, { content: null }, { tool_calls: {} }, { tool_calls: [null] },
      { tool_calls: [{ id: "", type: "function" }] }, { tool_calls: [call("same"), call("same")] }, { tool_calls: [call("used")] },
      { tool_calls: [{ ...call("a"), type: "other" }] }, { tool_calls: [{ ...call("a"), function: { name: "read", arguments: {} } }] }];
    const expected = oracle(messages.map((message) => ({ op: "validate", message, usedIds: ["used"] })));
    messages.forEach((message, index) => { let result: unknown; try { result = { result: validateMessage(message, ["used"]) }; } catch (error) { result = { error: (error as Error).name, message: (error as Error).message }; } assert.deepEqual(result, expected[index]); });
  });
  // Repeated calls and output-token cuts follow ZCode in TS only; see zcode-loop.test.ts.
  it("runs the real Python driver and TS loop through completion, invalid evidence without repair, questions and explicit limits", async () => {
    const cases = [
      { responses: [{ content: "plain answer" }], outcomes: [] },
      { responses: [{ content: "read", tool_calls: [call("r1")] }, { content: "Done\nEvidence: E1" }], outcomes: [{ ok: true, content: "file" }] },
      { responses: [{ content: "read", tool_calls: [call("r1")] }, { content: "Done\nEvidence: E99" }, { content: "Done\nEvidence: E1" }], outcomes: [{ ok: true, content: "file" }] },
      { responses: [{ tool_calls: [call("r1")] }], outcomes: [{ ok: true, awaiting_user: true, question: "Which file?" }] },
      { responses: [{ tool_calls: [call("r1")] }], outcomes: [{ ok: true }], maxSteps: 1 },
      { responses: [{ tool_calls: [call("r1", "broken")] }, { content: "Tool failed" }], outcomes: [] },
    ];
    const inputs = cases.map((item) => ({ op: "run", session: session(), ...item }));
    const expected = oracle(inputs);
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index]!;
      const local = fixture(item.responses, item.outcomes);
      try { await local.runner.run(local.session, { maxSteps: item.maxSteps }); assert.deepEqual(project(local.session), expected[index], `driver case ${index}`); }
      finally { local.close(); }
    }
  });
});
