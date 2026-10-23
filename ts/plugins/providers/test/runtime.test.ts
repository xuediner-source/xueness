import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { AgentRunner, type Row, type AgentProvider } from "@xueness/agent";
import { ProviderRequestError } from "@xueness/providers";
import { decodeTextResponse, streamAnswerText, partialAnswer, textMessages, windowResult, selectRuntimeTools, promptView, observeUsage, calibrationFactor, providerKey, lightweightRuntimeExtension } from "../src/runtime.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { fixture, call } from "../../../packages/agent/test/fixtures.ts";

const oracle = (inputs: Row[]): unknown[] => JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts", "test-support", "python", "agent_runtime_oracle.py"), "utf8"), JSON.stringify(inputs)));
const tools = ["read", "write", "edit", "exec", "ask_user", "tool_search", "tool_result_read", "grep", "list", "network_fetch"].map((name) => ({ type: "function", function: { name, description: "tool", parameters: { type: "object", properties: {} } } }));
describe("lightweight runtime Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches full JSON envelope decoding, partial answer visibility and explicit tool transcripts", () => {
    const responses: Row[] = [
      { content: '{"tool":"read","arguments":{"path":"a"}}' }, { content: '{"tool":"missing","arguments":{}}' },
      { content: '{"answer":"hi"}' }, { content: '{"summary":"done","evidence":[]}' }, { content: '[1]' },
      { content: '{"answer":"a","answer":"b"}' }, { content: '{"answer":"hi","extra":3}' }, { content: 'prose {"answer":"hi"}' },
      { content: '{"answer":"\\ud800"}' }, { content: '{"tool":"read","arguments":{"x":NaN}}' },
      { content: null }, { content: "", tool_calls: [call("r1")] },
    ];
    const prefix = '{"answer":"Hello\\n中文🕊️\\uD83D\\uDE00","evidence":[{"evidence_id":"E1","observation":"private"}]}';
    const texts = Array.from({ length: prefix.length + 1 }, (_, index) => prefix.slice(0, index));
    const messages = [{ role: "system", content: "s" }, { role: "assistant", content: "", tool_calls: [call("r1")] }, { role: "tool", tool_call_id: "r1", content: '{"ok":true}' }, { role: "user", content: "next" }];
    const inputs: Row[] = [...responses.map((response) => ({ op: "decode", response, tools })), ...texts.map((text) => ({ op: "stream", text })), ...responses.map((response) => ({ op: "partial", response, json: true })), { op: "text", messages }];
    const actual = [...responses.map((response) => decodeTextResponse(response, tools, () => "local-fixed")), ...texts.map(streamAnswerText), ...responses.map((response) => partialAnswer(response, true)), textMessages(messages)];
    assert.deepEqual(actual, oracle(inputs));
  });
  it("preserves source-file and stored-result cursor semantics and bounded search sources", () => {
    const results = [
      { ok: true, path: "a'中文.txt", output: "x".repeat(2500), offset: 4, totalChars: 3000, nextOffset: 2504, truncated: true },
      { ok: true, path: "a.txt", output: "", offset: 4000, totalChars: 3000, nextOffset: null, truncated: false },
      { ok: true, tool_call_id: "source", output_untrusted: "read data".repeat(300), offset: 0, totalChars: 10000, nextOffset: 2700 },
      { ok: true, output: Array.from({ length: 20 }, (_, index) => ({ url: `https://example.org/${index}`, title: `Title ${index}`, description: "untrusted".repeat(60) })) },
      { ok: false, output: "x".repeat(10000), error: "failure", evidence_id: "E1" },
    ];
    const messages = results.map((result) => ({ role: "tool", tool_call_id: "r1", content: pyJsonDumps(result) }));
    assert.deepEqual(messages.map((message) => windowResult(message)), oracle(messages.map((message) => ({ op: "window", message }))));
  });
  it("selects optional tools and enforces prompt budgets without losing human requirements", () => {
    const inputs: Row[] = [];
    for (const context of [2048, 4096, 8192, 16384]) {
      for (const mode of ["native", "json"]) {
        const provider = { contextWindow: context, maxOutputTokens: 512, toolCalling: mode };
        const messages: Row[] = [{ role: "system", content: "normal system" }, { role: "user", content: "Please use network_fetch then grep the result" }];
        for (let index = 0; index < 4; index += 1) messages.push({ role: "assistant", tool_calls: [call("r" + index)] }, { role: "tool", tool_call_id: "r" + index, content: pyJsonDumps({ ok: true, output: "large observed text ".repeat(100), evidence_id: "E" + (index + 1) }) });
        messages.push({ role: "user", content: "Keep this human requirement verbatim 🕊️" });
        inputs.push({ op: "select", provider, tools, session: { messages, discovered_tools: ["list", "grep"] } });
        inputs.push({ op: "prompt", provider, tools: tools.slice(0, 2), messages, options: { maxChars: 24000 } });
      }
    }
    const expected = oracle(inputs);
    inputs.forEach((input, index) => {
      let actual: unknown;
      if (input.op === "select") actual = selectRuntimeTools(input.tools as Row[], input.session as Row, input.provider as any);
      else { try { actual = { result: promptView(input.messages as Row[], input.tools as Row[], input.provider as any, input.options as any) }; } catch (error) { actual = { error: (error as Error).name, message: (error as Error).message }; } }
      assert.deepEqual(actual, expected[index], `case ${index}`);
    });
  });
  it("calibrates only reported counters under a provider-specific key", () => {
    const provider = { model: "local", base: "https://example.test/v1", toolCalling: "native", contextWindow: 8192 };
    const inputs = [100, 600, 1200, 0].map((actual) => ({ op: "budget", provider, session: { runtime_budget: { baseEstimatedInputTokens: 400 } }, usage: { prompt_tokens: actual } }));
    const expected = oracle(inputs);
    inputs.forEach((input, index) => { observeUsage(input.session, provider, input.usage); assert.deepEqual({ key: providerKey(provider), session: input.session, factor: calibrationFactor((input.session as Row).runtime_budget_calibration, provider) }, expected[index]); });
  });
});

describe("lightweight agent integration", () => {
  it("decodes JSON tool intent through the normal tool bridge and hides its wire syntax from streaming", async () => {
    const local = fixture([], [{ ok: true, output: "observed" }]);
    let requests = 0; const visible: string[] = [];
    const provider: AgentProvider = { runtimeProfile: "lightweight", toolCalling: "json", contextWindow: 8192, maxOutputTokens: 1024,
      async complete() { throw new Error("stream expected"); }, async stream(_messages, _tools, observers) {
        const content = requests++ === 0 ? '{"tool":"read","arguments":{}}' : '{"answer":"Done","evidence":[{"evidence_id":"E1","observation":"read result"}]}';
        for (const char of content) observers?.onDelta?.(char);
        return { content };
      } };
    const hooks = { ...local.hooks, extensions: [lightweightRuntimeExtension()] };
    const runner = new AgentRunner({ root: local.directory, store: local.store, provider, hooks, toolBridge: { call: async () => ({ ok: true, output: "observed" }), callAll: async () => [] }, onEvent: (event) => { if (event.type === "assistant_delta") visible.push(String(event.text)); } });
    try { await runner.run(local.session); assert.equal(local.session.status, "completed"); assert.equal(visible.join(""), "Done"); assert.equal((local.session.completion as Row).verified, true); }
    finally { local.close(); }
  });
  it("retries overflow once only before visible output and retains the full journal", async () => {
    const local = fixture([]); let requests = 0;
    const provider: AgentProvider = { runtimeProfile: "lightweight", toolCalling: "native", contextWindow: 8192, maxOutputTokens: 1024,
      async complete() { requests += 1; if (requests === 1) throw new ProviderRequestError({ contextOverflow: true }); return { content: "answer" }; } };
    const runner = new AgentRunner({ root: local.directory, store: local.store, provider, hooks: { ...local.hooks, extensions: [lightweightRuntimeExtension()] }, toolBridge: { call: async () => { throw new Error("no tool"); }, callAll: async () => [] } });
    try { await runner.run(local.session); assert.equal(requests, 2); assert.equal((local.session.runtime_budget as Row).overflowRetry, true); assert.equal((local.session.archived_messages as Row[]).length, 0); }
    finally { local.close(); }
  });
});
