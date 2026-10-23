import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeNative } from "../src/tool-protocol.ts";
import { normalizeModelToolArguments } from "../src/tool-input-normalization.ts";
import { validateMessage } from "../../agent/src/messages.ts";
import { runTools } from "../../agent/src/tools.ts";
import type { AgentContext, AgentRunnerOptions, Row } from "../../agent/src/types.ts";

function callsOf(value: unknown): Row[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected normalized response");
  const calls = (value as Row).tool_calls;
  if (!Array.isArray(calls)) throw new Error("expected normalized calls");
  return calls as Row[];
}

function diagnosticOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const diagnostic = (value as Row)._protocol_diagnostic;
  return diagnostic && typeof diagnostic === "object" ? (diagnostic as Row).code as string | undefined : undefined;
}

function call(id: string, name: unknown, args: unknown = "{}", extra: Row = {}): Row {
  return { id, type: "function", ...extra, function: { name, arguments: args } };
}

function toolHarness() {
  const session: Row = { id: "a".repeat(32), messages: [], results: {}, evidence_aliases: {} };
  let bridgeCalls = 0, ownerCalls = 0;
  const context = {
    session, stateDir: ".", signal: new AbortController().signal, options: {},
    save: async () => {}, enabled: () => true, emit: () => {},
  } as unknown as AgentContext;
  const runner = {
    hooks: { extensions: [], toolOwner: (name: string) => { ownerCalls += 1; return name === "read" ? "files" : null; } },
    toolBridge: { async call() { bridgeCalls += 1; return { ok: true }; }, async callAll() { throw new Error("not used"); } },
  } as unknown as AgentRunnerOptions;
  return { session, context, runner, bridgeCalls: () => bridgeCalls, ownerCalls: () => ownerCalls };
}

describe("model tool input normalization", () => {
  it("normalizes absent, null, BOM JSON, object, and scalar arguments", () => {
    for (const input of [undefined, null, "", "null"]) assert.equal(normalizeModelToolArguments(input), "{}");
    const bom = normalizeModelToolArguments("\ufeff{\"x\":1}");
    assert.equal(bom.startsWith("\ufeff"), false);
    assert.deepEqual(JSON.parse(bom), { x: 1 });
    assert.deepEqual(JSON.parse(normalizeModelToolArguments({ x: 1 })), { x: 1 });
    assert.equal(normalizeModelToolArguments(7), "7");
    assert.equal(normalizeModelToolArguments(true), "true");
  });

  it("preserves malformed and duplicate-key text and refuses to execute either", async () => {
    const badArguments = ["{broken", "{\"x\":1,\"x\":2}"];
    for (const args of badArguments) {
      assert.equal(normalizeModelToolArguments(args), args);
      const normalized = normalizeNative({ tool_calls: [call("bad", "read", args)] });
      assert.equal((callsOf(normalized)[0]!.function as Row).arguments, args);
      const message = { role: "assistant", content: "", tool_calls: callsOf(normalized) };
      validateMessage(message);
      const harness = toolHarness();
      await runTools(harness.context, harness.runner, callsOf(normalized), [{ function: { name: "read" } }], false);
      assert.equal(harness.bridgeCalls(), 0);
      assert.equal((harness.session.results as Row).bad && ((harness.session.results as Row).bad as Row).error_code, "invalid_tool_arguments");
    }
  });

  it("trims names, preserves eligible empty names, and retains native envelope diagnostics", () => {
    const trimmed = normalizeNative({ tool_calls: [call("trim", "  read  ")] });
    assert.equal(((callsOf(trimmed)[0]!.function as Row).name), "read");
    const empty = normalizeNative({ tool_calls: [call("empty", "   ")] });
    assert.equal((callsOf(empty)[0]!.function as Row).name, "");
    assert.doesNotThrow(() => validateMessage({ role: "assistant", tool_calls: callsOf(empty) }));
    assert.equal(diagnosticOf(normalizeNative({ tool_calls: [call("provider", " ", "{}", { providerExecuted: true })] })), "invalid_native_envelope");
    assert.equal(diagnosticOf(normalizeNative({ tool_calls: [call("bad-name", 3)] })), "invalid_native_envelope");
    assert.equal(diagnosticOf(normalizeNative({ tool_calls: [call("same", "read"), call("same", "read")] })), "duplicate_call_id");
    assert.equal(diagnosticOf(normalizeNative({ tool_calls: [{ type: "function", function: { name: "read", arguments: "{}" } }] })), "invalid_native_envelope");
    assert.equal(diagnosticOf(normalizeNative({ tool_calls: [call("wrong-type", "read", "{}", { type: "custom" })] })), "invalid_native_envelope");
  });

  it("closes an empty-name call as unknown_tool without owner lookup or bridge dispatch", async () => {
    const normalized = normalizeNative({ tool_calls: [call("empty-id", "  ")] });
    const harness = toolHarness();
    await runTools(harness.context, harness.runner, callsOf(normalized), [], false);
    assert.equal(harness.ownerCalls(), 0);
    assert.equal(harness.bridgeCalls(), 0);
    assert.deepEqual((harness.session.results as Row)["empty-id"], { ok: false, error: "unknown tool", error_code: "unknown_tool" });
    assert.equal((harness.session.messages as Row[]).some((message) => message.tool_call_id === "empty-id"), true);
  });
});
