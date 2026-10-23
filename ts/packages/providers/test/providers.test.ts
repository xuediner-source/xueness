/**
 * Adapter behaviors that need no Python oracle: cancellation, real-clock
 * deadlines, socket-level edge cases and the invocation media binding.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AnthropicMessages, OpenAICompatible, ProviderCancelled, ProviderRequestError, SYSTEM_CLOCK, isStreamStop, type MediaBinding,
} from "../src/index.ts";
import { MESSAGES, PNG_B64, SSE_HEAD, TEXT_STREAM, chunk, events, json } from "./support/http-fixtures.ts";
import { ScriptedServer } from "./support/scripted-server.ts";

let server: ScriptedServer;
before(async () => {
  server = await ScriptedServer.start();
});
after(async () => {
  await server.close();
});

const openai = (id: string, extra: Record<string, unknown> = {}) =>
  new OpenAICompatible({ base: server.base("ts", id), model: "gpt-4o", key: "k", allowLoopbackHttp: true, env: {}, ...extra });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("provider adapters", () => {
  it("settle an aborted stream as a user stop without retrying", async () => {
    server.script("abort", [[SSE_HEAD + events([chunk({ content: "x" })], { done: false }), { hang: true }]]);
    const controller = new AbortController();
    const seen: unknown[] = [];
    const error = await rejection(openai("abort").stream(MESSAGES, [], {
      onDelta: (text) => {
        seen.push(text);
        setTimeout(() => controller.abort(), 10);
      },
    }, { signal: controller.signal }));
    assert.ok(error instanceof ProviderCancelled && isStreamStop(error));
    assert.deepEqual(seen, ["x"]);
    assert.equal(server.requests("ts", "abort").length, 1);
  });

  it("never wake SYSTEM_CLOCK.sleep before the requested time", async () => {
    for (let round = 0; round < 15; round += 1) {
      const start = performance.now();
      await SYSTEM_CLOCK.sleep(0.003);
      assert.ok(performance.now() - start >= 3, "slept the full duration");
    }
  });

  it("report an expired run deadline as a deadline timeout on the real clock", async () => {
    server.script("deadline", [[SSE_HEAD, { hang: true }]]);
    const provider = openai("deadline");
    const start = performance.now();
    provider.requestDeadline = SYSTEM_CLOCK.now() + 0.3;
    const error = await rejection(provider.stream(MESSAGES, []));
    assert.ok(error instanceof ProviderRequestError);
    assert.deepEqual([error.category, error.stage], ["timeout", "deadline"]);
    assert.ok(performance.now() - start >= 300);
  });

  it("never time out a read before the deadline that bounds it", async () => {
    // Timers can fire a little early (Node's socket timer counts whole
    // milliseconds); Python's socket timeout never does. Make every timer fire
    // 30 ms early: the read, whose timeout is the time left, must still last
    // until the deadline, which then reports itself without a retry.
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      original(callback, typeof ms === "number" && ms > 30 ? ms - 30 : ms, ...args)) as unknown as typeof setTimeout;
    try {
      server.script("idle", [[SSE_HEAD, { hang: true }]]);
      const sleeps: number[] = [];
      const provider = openai("idle", { clock: { now: SYSTEM_CLOCK.now, sleep: async (seconds: number) => void sleeps.push(seconds) } });
      const start = performance.now();
      provider.requestDeadline = SYSTEM_CLOCK.now() + 0.1;
      const error = await rejection(provider.stream(MESSAGES, []));
      assert.ok(error instanceof ProviderRequestError);
      assert.deepEqual([error.category, error.stage, sleeps], ["timeout", "deadline", []]);
      assert.ok(performance.now() - start >= 100);
    } finally {
      globalThis.setTimeout = original;
    }
  });

  it("treat a reset that ends an EOF-delimited stream as a connection reset", async () => {
    server.script("reset", [[SSE_HEAD + events([chunk({ content: "x" })], { done: false }), { delay: 20 }, { reset: true }]]);
    const deltas: unknown[] = [];
    const error = await rejection(openai("reset").stream(MESSAGES, [], { onDelta: (text) => void deltas.push(text) }));
    assert.ok(error instanceof ProviderRequestError);
    assert.deepEqual([error.category, error.stage, error.exceptionType], ["connection_failed", "read", "ConnectionResetError"]);
    assert.deepEqual(deltas, ["x"], "delivered output is never replayed");
  });

  it("classify a quota error even when its body arrives in a later segment", async () => {
    // Python's single `read1` can miss such a body (a 429 retry); this port
    // waits up to the same 0.25 s classification budget for it.
    const body = JSON.stringify({ error: { code: "insufficient_quota" } });
    const head = `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`;
    server.script("quota", [[head, { delay: 30 }, body]]);
    const error = await rejection(openai("quota").complete(MESSAGES, []));
    assert.ok(error instanceof ProviderRequestError);
    assert.deepEqual([error.status, error.category], [429, "quota_exhausted"]);
    assert.equal(server.requests("ts", "quota").length, 1);
  });

  it("resolve _media_refs only through an invocation media binding", async () => {
    server.script("media", [json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] })]);
    const message = { role: "user", content: "see", _media_refs: [{ id: "m1" }] };
    const binding: MediaBinding = {
      resolve: (item, _provider, media) => {
        assert.equal(item, message);
        const attachments = [{ mimeType: "image/png", data: PNG_B64 }];
        media.account(attachments);
        return attachments;
      },
    };
    const result = await openai("media").complete([message], [], { media: binding });
    assert.equal(result["content"], "ok");
    const sent = JSON.parse(server.requests("ts", "media")[0]?.body ?? "{}") as { messages: { content: unknown }[] };
    assert.deepEqual(sent.messages[0]?.content, [
      { type: "text", text: "see" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
    await assert.rejects(openai("media").complete([message], []), { name: "ValueError", message: "media references require an authorized invocation" });
  });

  it("send the Messages API headers and body for Anthropic", async () => {
    server.script("anthropic", [json(200, { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" })]);
    const provider = new AnthropicMessages({ base: server.base("ts", "anthropic"), model: "claude-x", key: "secret", allowLoopbackHttp: true, env: {} });
    const result = await provider.complete(MESSAGES, []);
    assert.deepEqual([result["content"], result["_finish_reason"], result["_request_attempts"]], ["hi", "stop", 1]);
    const [request] = server.requests("ts", "anthropic");
    assert.equal(request?.path, "/messages");
    assert.deepEqual([request?.headers["x-api-key"], request?.headers["anthropic-version"]], ["secret", "2023-06-01"]);
    assert.equal(JSON.parse(request?.body ?? "{}").system, "You are terse.");
  });

  it("retry a reset before any output and report the attempt count", async () => {
    server.script("retry", [[{ reset: true }], TEXT_STREAM]);
    const sleeps: number[] = [];
    const provider = openai("retry", { clock: { now: SYSTEM_CLOCK.now, sleep: async (seconds: number) => void sleeps.push(seconds) } });
    const result = await provider.stream(MESSAGES, []);
    assert.deepEqual([result["content"], result["_request_attempts"], sleeps], ["Hello 世界", 2, [0.25]]);
  });
});
