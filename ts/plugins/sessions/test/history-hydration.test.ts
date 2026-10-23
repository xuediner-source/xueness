import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { type AgentContext, type AgentRunnerOptions } from "@xueness/agent";
import { runTools } from "../../../packages/agent/src/tools.ts";
import { hydrateSessionToolHistory, projectSessionHistory } from "../src/history-hydration.ts";
type Row = Record<string, any>;

const call = (id: string, name = "read") => ({ id, type: "function", function: { name, arguments: "{}" } });
const assistant = (...calls: Row[]): Row => ({ role: "assistant", content: "thinking", tool_calls: calls });
const parsed = (message: Row): Row => pyJsonLoads(String(message.content)) as Row;

describe("session tool history hydration", () => {
  it("restores a missing tool message from a structured result and ignores archived history", () => {
    const user = { role: "user", content: "keep this", _message_id: "user-1" };
    const answer = assistant(call("known"));
    const result = { ok: true, output: "already executed", data: { value: 7 } };
    const archived = assistant(call("archived"));
    const session: Row = { messages: [user, answer], archived_messages: [archived], results: { known: result } };

    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 1, interrupted: 0 });
    assert.equal(session.messages[0], user);
    assert.equal(session.messages[1], answer);
    assert.deepEqual(parsed(session.messages[2]), result);
    assert.equal(session.messages[2].tool_call_id, "known");
    assert.deepEqual(session.archived_messages, [archived]);
    assert.equal(session.results.archived, undefined);
    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 0, interrupted: 0 });
    assert.equal(session.messages.length, 3);
  });

  it("marks only missing results in a partial batch interrupted and is idempotent", async () => {
    const user = { role: "user", content: "do two things", _message_id: "u-2" };
    const answer = assistant(call("done"), call("cut-off"));
    const doneTool = { role: "tool", tool_call_id: "done", content: pyJsonDumps({ ok: true, output: "done output" }) };
    const session: Row = {
      messages: [user, answer, doneTool],
      archived_messages: [assistant(call("old-call"))],
      results: { done: { ok: true, output: "done output" } },
    };

    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 0, interrupted: 1 });
    assert.equal(session.messages[0], user);
    assert.equal(session.messages[1], answer);
    assert.equal(session.messages[2].tool_call_id, "cut-off");
    assert.equal(session.messages[3], doneTool);
    assert.deepEqual(parsed(session.messages[2]), {
      ok: false,
      output: "[Tool execution was interrupted before resume]",
      error: { code: "tool_interrupted", message: "Tool execution was interrupted before resume" },
      retryable: false,
    });
    assert.equal(session.results.done.output, "done output");
    assert.equal(session.results["cut-off"].error.code, "tool_interrupted");
    assert.equal(session.results["old-call"], undefined);
    let dispatched = 0;
    const context = {
      session,
      signal: new AbortController().signal,
      options: {},
      save: async () => {},
      enabled: () => true,
      emit: () => {},
    } as unknown as AgentContext;
    const runner = {
      hooks: { extensions: [], toolOwner: () => "files" },
      toolBridge: { call: async () => { dispatched += 1; return { ok: true }; } },
    } as unknown as AgentRunnerOptions;
    await runTools(context, runner, [answer.tool_calls[1]], []);
    assert.equal(dispatched, 0);
    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 0, interrupted: 0 });
    assert.equal(session.messages.length, 4);
    assert.equal(session.messages[1].content, "thinking");
  });

  it("recovers boolean-ok JSON tool history and leaves legacy text as non-success history", () => {
    const answer = assistant(call("json-result"), call("legacy-text"));
    const jsonTool = { role: "tool", tool_call_id: "json-result", content: pyJsonDumps({ ok: true, output: "saved" }), _tool_media: [{ id: "media-1" }] };
    const legacyTool = { role: "tool", tool_call_id: "legacy-text", content: "old plain output", _read_state: { cursor: 3 } };
    const session: Row = { messages: [answer, jsonTool, legacyTool], results: {} };

    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 1, interrupted: 1 });
    assert.deepEqual(session.results["json-result"], { ok: true, output: "saved" });
    assert.deepEqual(session.results["legacy-text"], {
      ok: false,
      output: "[Tool execution was interrupted before resume]",
      error: { code: "tool_interrupted", message: "Tool execution was interrupted before resume" },
      retryable: false,
    });
    assert.equal(session.messages[1], jsonTool);
    assert.equal(session.messages[2], legacyTool);
    assert.equal(legacyTool.content, "old plain output");
    assert.deepEqual(legacyTool._read_state, { cursor: 3 });
    assert.equal(session.results["legacy-text"].ok, false);
  });

  it("preserves an approval_required placeholder rather than replacing it with interruption", () => {
    const answer = assistant(call("approval"));
    const placeholder = {
      ok: false,
      output: "Waiting for approval",
      error: { code: "approval_required", message: "Confirm the operation" },
      data: { awaitingApproval: true, waiting: true },
    };
    const tool = { role: "tool", tool_call_id: "approval", content: pyJsonDumps(placeholder), _read_state: { approval: true } };
    const session: Row = { messages: [answer, tool] };

    assert.deepEqual(hydrateSessionToolHistory(session), { restored: 1, interrupted: 0 });
    assert.deepEqual(session.results.approval, placeholder);
    assert.equal(session.messages[1], tool);
    assert.equal(session.messages[1].content, pyJsonDumps(placeholder));
  });

  it("projects tool results after their assistant in call order, takes the last duplicate, and omits orphans", () => {
    const answer = assistant(call("second"), call("first"), { type: "function", function: { name: "no-id", arguments: "{}" } });
    const secondOld = { role: "tool", tool_call_id: "second", content: "old" };
    const first = { role: "tool", tool_call_id: "first", content: "first", _tool_media: [{ id: "media-2" }] };
    const orphan = { role: "tool", tool_call_id: "orphan", content: "not for a call" };
    const secondLast = { role: "tool", tool_call_id: "second", content: "last", _read_state: { cursor: 9 } };
    const user = { role: "user", content: "next", _message_id: "user-3" };
    const journal = [answer, secondOld, first, orphan, secondLast, user];
    const before = structuredClone(journal);

    const projected = projectSessionHistory(journal);
    assert.deepEqual(projected, [answer, secondLast, first, user]);
    assert.equal(projected[1], secondLast);
    assert.deepEqual(projected[1]._read_state, { cursor: 9 });
    assert.deepEqual(projected[2]!._tool_media, [{ id: "media-2" }]);
    assert.deepEqual(journal, before);
  });

  it("rejects duplicate assistant call IDs without changing the journal or inventing IDs", () => {
    const answer = assistant(call("duplicate"), call("duplicate"));
    const journal = [answer];
    const before = structuredClone(journal);

    assert.throws(() => hydrateSessionToolHistory({ messages: journal }), /duplicate assistant tool call id/);
    assert.throws(() => projectSessionHistory(journal), /duplicate assistant tool call id/);
    assert.deepEqual(journal, before);
    assert.equal(answer.tool_calls[0].id, "duplicate");
  });
});
