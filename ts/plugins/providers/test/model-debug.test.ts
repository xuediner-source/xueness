import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { modelDebugRecord, summarizeModelRequest } from "../src/model-diagnostics.ts";
import { ModelDebugStore } from "../src/model-debug.ts";
import type { Row } from "../src/model-diagnostics.ts";

function fixtureRecord(requestId = "req1", attemptId = "att1"): Row {
  return modelDebugRecord("session1", {
    requestId, attemptId, attempt: 1, maxAttempts: 3, type: "model_request_completed", timestamp: "2026-10-22T00:00:00.000Z",
    modelId: "test-model", providerKind: "anthropic", durationMs: 12, finishReason: "stop", usage: { input_tokens: 2 },
  }, summarizeModelRequest({ messages: [{ role: "user", content: "hi" }], tools: [] }));
}

describe("content-free model diagnostics", () => {
  it("counts canonical text and reasoning while excluding media and tool payloads", () => {
    const summary = summarizeModelRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "S" }, { type: "reasoning", text: "R" }, { type: "image", image: "MEDIA_SENTINEL" }] },
        { role: "user", content: "input" },
        { role: "assistant", content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "B", signature: "SIGNATURE_SENTINEL" }], tool_calls: [{ function: { arguments: "TOOL_SENTINEL" } }] },
        { role: "tool", content: [{ type: "text", text: "T" }, { type: "file", data: "FILE_SENTINEL" }] },
      ],
      tools: [{ function: { name: "TOOL_NAME_SENTINEL", parameters: { secret: "SCHEMA_SENTINEL" } } }],
    });
    assert.deepEqual(summary, { messageCount: 4, toolCount: 1, inputChars: 6, systemChars: 2, assistantChars: 2, toolCallCount: 1 });
    assert.doesNotMatch(JSON.stringify(summary), /SENTINEL|TOOL/);
  });

  it("projects a fixed safe schema and drops nested content, credentials, and unknown fields", () => {
    const summary = modelDebugRecord("session/../private", {
      requestId: "req/one", attemptId: "try\u0001one", attempt: 2, maxAttempts: 0, durationMs: 41, queuedMs: 9,
      modelId: "\u0001model".padEnd(200, "x"), providerKind: "anthropic", type: "model_request_failed",
      reason: "network_error", errorCode: "connection_failed", retryable: true, terminal: false, statusCode: 503,
      phase: "response", finishReason: "tool_calls", usage: { input_tokens: 7, output_tokens: 3, apiKey: "KEY_SENTINEL" },
      message: "MESSAGE_SENTINEL", stack: "STACK_SENTINEL", headers: { authorization: "HEADER_SENTINEL" },
      request: { messages: "PROMPT_SENTINEL", url: "URL_SENTINEL" },
      diagnostics: { textChunks: 2, textChars: 11, reasoningChunks: 1, reasoningChars: 8, toolSnapshots: 3, firstTextMs: 4, firstReasoningMs: 5, reasoning: "REASONING_SENTINEL" },
      response: { contentChars: 12, toolCalls: 1, content: "OUTPUT_SENTINEL", toolArgs: "ARGS_SENTINEL" },
    }, { messageCount: 4, toolCount: 2, inputChars: 20, systemChars: 3, assistantChars: 5, toolCallCount: 1, raw: "NESTED_SENTINEL" });

    assert.equal(summary.schema, "xueness.model-debug.v1");
    assert.equal(summary.sessionId, "session____private");
    assert.equal(summary.requestId, "req_one");
    assert.equal(summary.attemptId, "try_one");
    assert.equal((summary.modelId as string).length, 160);
    assert.deepEqual(summary.request, { messageCount: 4, toolCount: 2, inputChars: 20, systemChars: 3, assistantChars: 5, toolCallCount: 1 });
    assert.deepEqual(summary.diagnostics, { textChunks: 2, textChars: 11, reasoningChunks: 1, reasoningChars: 8, toolSnapshots: 3, firstTextMs: 4, firstReasoningMs: 5 });
    assert.deepEqual(summary.response, { contentChars: 12, toolCalls: 1 });
    assert.deepEqual(summary.usage, { input_tokens: 7, output_tokens: 3, prompt_tokens: 7, completion_tokens: 3 });
    assert.doesNotMatch(JSON.stringify(summary), /SENTINEL|authorization|headers|stack|url|OUTPUT|ARGS|PROMPT|SECRET/);
  });

  it("is disabled without opt-in and creates no state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-model-debug-off-"));
    try {
      const stateDir = join(root, "state");
      const store = new ModelDebugStore(stateDir, { enabled: false });
      store.write(fixtureRecord());
      assert.deepEqual(store.snapshot(), { enabled: false, records: 0, writeFailures: 0 });
      assert.equal(existsSync(stateDir), false);
      assert.equal(new ModelDebugStore(join(root, "default")).snapshot().enabled, process.env.XUENESS_MODEL_DEBUG === "1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("writes private atomic JSON files and retains only the newest managed records", () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-model-debug-store-"));
    try {
      const stateDir = join(root, "state");
      mkdirSync(stateDir);
      const store = new ModelDebugStore(stateDir, { enabled: true, maxRecords: 2 });
      store.write(fixtureRecord("req1"));
      store.write(fixtureRecord("req2"));
      const directory = join(stateDir, "model-debug");
      const first = join(directory, "req1-att1.json");
      utimesSync(first, new Date(1), new Date(1));
      writeFileSync(join(directory, "keep.json"), "outside managed naming rule");
      store.write(fixtureRecord("req3"));

      assert.deepEqual(readdirSync(directory).sort(), ["keep.json", "req2-att1.json", "req3-att1.json"]);
      assert.equal(JSON.parse(readFileSync(join(directory, "req3-att1.json"), "utf8")).schema, "xueness.model-debug.v1");
      assert.equal(store.snapshot().records, 2);
      assert.equal(readdirSync(directory).some((name) => name.startsWith(".model-debug-")), false);
      if (process.platform !== "win32") {
        assert.equal(statSync(directory).mode & 0o777, 0o700);
        assert.equal(statSync(join(directory, "req3-att1.json")).mode & 0o777, 0o600);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("counts link or directory conflicts without throwing or exposing errors", () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-model-debug-failure-"));
    const stateDir = join(root, "state");
    const target = join(root, "outside");
    try {
      mkdirSync(stateDir);
      mkdirSync(target);
      const link = join(stateDir, "model-debug");
      try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); }
      catch { writeFileSync(link, "not a directory"); }
      const store = new ModelDebugStore(stateDir, { enabled: true });
      assert.doesNotThrow(() => store.write(fixtureRecord()));
      assert.deepEqual(store.snapshot(), { enabled: true, records: 0, writeFailures: 1 });
      assert.equal(readdirSync(target).length, 0);
      assert.equal(lstatSync(link).isSymbolicLink() || statSync(link).isFile(), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
