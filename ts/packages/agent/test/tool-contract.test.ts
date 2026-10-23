/**
 * The ZCode model contract layer (Step 3): ZCode names, descriptions and
 * schemas outbound; Xueness names inbound; old sessions keep working.
 * Expected texts come from ZCode v3.15.1 (aac4755, Apache-2.0)
 * core/tests/tool-contracts.test.ts and input-validation-model-content.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contractFor, internalToolName, journalCall, modelMessages, modelToolName, modelTools, orderProviderVisibleTools, type AdapterContext,
} from "../src/index.ts";

const root = "/ws";
const context: AdapterContext = { root, accepts: () => false };
const fn = (name: string, parameters: Record<string, unknown> = { type: "object", properties: {} }) => ({ type: "function", function: { name, description: `${name} (xueness)`, parameters } });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

describe("tool contract names", () => {
  it("maps both ways and leaves other tools alone", () => {
    for (const [internal, model] of [["exec", "Bash"], ["read", "Read"], ["write", "Write"], ["edit", "Edit"], ["glob", "Glob"], ["grep", "Grep"],
      ["todo_read", "TodoRead"], ["todo_write", "TodoWrite"], ["ask_user", "AskUserQuestion"], ["exec_output", "TaskOutput"], ["exec_kill", "TaskStop"], ["exit_plan_mode", "ExitPlanMode"], ["enter_plan_mode", "EnterPlanMode"]]) {
      assert.equal(modelToolName(internal!), model);
      assert.equal(internalToolName(model!), internal);
      assert.equal(contractFor(model!)?.internal, internal);
    }
    assert.equal(modelToolName("web_fetch"), "web_fetch");
    assert.equal(internalToolName("mcp__x__y"), "mcp__x__y");
  });

  it("shows the ZCode table in provider order with ZCode descriptions", () => {
    const shown = modelTools([fn("web_fetch"), fn("exec"), fn("read"), fn("todo_write"), fn("edit")]);
    const names = shown.map((tool) => (tool.function as { name: string }).name);
    assert.deepEqual(names, orderProviderVisibleTools(names, (name) => name));
    assert.deepEqual([...names].sort(), ["Bash", "Edit", "Read", "TodoWrite", "web_fetch"]);
    const bash = shown.find((tool) => (tool.function as { name: string }).name === "Bash")!.function as { description: string; parameters: { required: string[] } };
    assert.match(bash.description, /^Executes a bash command/);
    assert.deepEqual(bash.parameters.required, ["command"]);
    assert.equal((shown.find((tool) => (tool.function as { name: string }).name === "web_fetch")!.function as { description: string }).description, "web_fetch (xueness)");
  });
});

describe("inbound calls", () => {
  it("stores the Xueness name and arguments and keeps the model's call", () => {
    const { call: stored, error } = journalCall(call("c1", "Read", { file_path: "/ws/src/a.ts", offset: 1, limit: 20 }), context);
    assert.equal(error, null);
    assert.equal((stored.function as { name: string }).name, "read");
    assert.deepEqual(JSON.parse((stored.function as { arguments: string }).arguments), { path: "/ws/src/a.ts", limit: 20 });
    assert.deepEqual(stored._model_call, { name: "Read", arguments: JSON.stringify({ file_path: "/ws/src/a.ts", offset: 1, limit: 20 }) });
    // ZCode coerces numeric strings only where its schema says so (Bash timeout, TaskOutput timeout), not Read.
    assert.match(journalCall(call("c1b", "Read", { file_path: "/ws/a", limit: "20" }), context).error ?? "", /`limit` type is expected as `integer` but provided as `string`/);
  });

  it("clamps the Bash timeout and maps run_in_background", () => {
    const fg = JSON.parse((journalCall(call("c2", "Bash", { command: "ls", timeout: 9_000_000 }), context).call.function as { arguments: string }).arguments);
    assert.deepEqual(fg, { command: "ls", timeout_ms: 600_000 });
    const bg = JSON.parse((journalCall(call("c3", "Bash", { command: "npm run dev", run_in_background: "true" }), context).call.function as { arguments: string }).arguments);
    assert.deepEqual(bg, { command: "npm run dev", background: true });
  });

  it("returns the ZCode InputValidationError text for bad input", () => {
    const { error } = journalCall(call("c4", "Edit", { file_path: "/ws/a", old_string: "x" }), context);
    assert.ok(error?.startsWith("<tool_use_error>InputValidationError: Edit failed due to the following issue"), error ?? "");
    assert.match(error!, /new_string/);
  });

  it("passes legacy Xueness names through unchanged", () => {
    const legacy = call("c5", "exec", { command: "ls" });
    assert.deepEqual(journalCall(legacy, context), { call: legacy, error: null });
  });
});

describe("the request view of the journal", () => {
  it("replays new calls verbatim and old sessions through the reverse mapping", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [
        { ...call("n1", "read", { path: "/ws/a.ts" }), _model_call: { name: "Read", arguments: "{\"file_path\":\"/ws/a.ts\"}" } },
        call("o1", "exec", { command: "npm test", cwd: "pkg", timeout_ms: 1000 }),
        call("o2", "edit", { path: "src/b.ts", old_string: "a", new_string: "b" }),
      ] },
      { role: "tool", tool_call_id: "n1", content: JSON.stringify({ ok: true, output: "1\tx" }) },
      { role: "tool", tool_call_id: "o1", content: JSON.stringify({ ok: false, output: "Exit code 1\nFAIL", error: { code: "command_failed", message: "exit code 1" } }) },
      { role: "tool", tool_call_id: "o2", content: JSON.stringify({ ok: false, output: "String to replace not found in file.\nString: a", error: { code: "not_found" } }) },
    ];
    const view = modelMessages(messages, context);
    const calls = (view[0]!.tool_calls as Array<{ function: { name: string; arguments: string }; _model_call?: unknown }>);
    assert.deepEqual(calls.map((c) => c.function.name), ["Read", "Bash", "Edit"]);
    assert.equal(calls[0]!.function.arguments, "{\"file_path\":\"/ws/a.ts\"}");
    assert.equal(calls.some((c) => "_model_call" in c), false);
    assert.deepEqual(JSON.parse(calls[1]!.function.arguments), { command: "cd pkg && npm test", timeout: 1000 });
    assert.equal(JSON.parse(calls[2]!.function.arguments).file_path, "/ws/src/b.ts");
    assert.equal(view[1]!.content, "1\tx");
    assert.equal(view[2]!.content, "Exit code 1\nFAIL", "Bash failures stay plain text");
    assert.equal(view[3]!.content, "<tool_use_error>String to replace not found in file.\nString: a</tool_use_error>");
  });

  it("gives empty results the ZCode no-output text and leaves other tools alone", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: [call("e1", "exec", { command: "true" }), call("w1", "web_fetch", { url: "https://x" })] },
      { role: "tool", tool_call_id: "e1", content: JSON.stringify({ ok: true, output: "" }) },
      { role: "tool", tool_call_id: "w1", content: JSON.stringify({ ok: true, output: "" }) },
    ];
    const view = modelMessages(messages, context);
    assert.equal(view[1]!.content, "(Bash completed with no output)");
    assert.equal(view[2]!.content, messages[2]!.content);
  });
});
