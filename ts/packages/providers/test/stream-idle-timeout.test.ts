import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS, MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS,
  ModelStreamIdleTimeoutError, ProviderCancelled, classifyModelFailure, isModelStreamIdleTimeoutError,
  openHttp, pyUrlSplit, readNextWithStreamIdleTimeout, readSse, resolveModelStreamIdleTimeoutMs,
  type HttpRequestSpec,
} from "../src/index.ts";

let port = 0;
let server: http.Server;
// Keep total stream time above one idle period, with CI scheduling headroom.
const DATA_INTERVAL_MS = 700, TEST_IDLE_TIMEOUT_MS = 1200;

before(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (request.url === "/comments") {
      const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 10);
      response.on("close", () => clearInterval(heartbeat));
      return;
    }
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 10);
    const timers = [
      setTimeout(() => response.write("data: first\n\n"), DATA_INTERVAL_MS),
      setTimeout(() => response.write("data: second\n\n"), DATA_INTERVAL_MS * 2),
      setTimeout(() => { response.end("data: [DONE]\n\n"); }, DATA_INTERVAL_MS * 3),
    ];
    response.on("close", () => {
      clearInterval(heartbeat);
      timers.forEach(clearTimeout);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const spec = (path: string): HttpRequestSpec => ({
  url: pyUrlSplit(`http://127.0.0.1:${port}${path}`), method: "GET", headers: { Accept: "text/event-stream" },
  body: null, timeoutMs: 1_000, proxy: null,
});

async function readPayloads(path: string, idleTimeoutMs: number): Promise<string[]> {
  const response = await openHttp(spec(path));
  try {
    const payloads: string[] = [];
    for await (const payload of readSse(response, { idleTimeoutMs })) payloads.push(payload);
    return payloads;
  } finally {
    response.close();
  }
}

describe("provider stream idle timeout", () => {
  it("resolves finite retry limits and classifies the typed timeout safely", () => {
    assert.equal(DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS, 600_000);
    assert.equal(MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS, 30_000);
    assert.equal(resolveModelStreamIdleTimeoutMs(), 600_000);
    assert.equal(resolveModelStreamIdleTimeoutMs({ retryNumber: 2 }), 660_000);
    assert.equal(resolveModelStreamIdleTimeoutMs({ baseTimeoutMs: 0, retryNumber: 2 }), 0);
    assert.equal(resolveModelStreamIdleTimeoutMs({ baseTimeoutMs: Number.POSITIVE_INFINITY }), 600_000);
    const error = new ModelStreamIdleTimeoutError();
    assert.equal(isModelStreamIdleTimeoutError(error), true);
    assert.deepEqual([error.category, error.stage, error.exceptionType, error.code],
      ["timeout", "read", "ModelStreamIdleTimeoutError", "MODEL_STREAM_IDLE_TIMEOUT"]);
    const failure = classifyModelFailure(error);
    assert.deepEqual([failure.code, failure.reason, failure.retryReason, failure.retryable, failure.message],
      ["model_request_timeout", "stream_idle_timeout", "stream_idle_timeout", true, "The model stream stopped producing data."]);
    assert.deepEqual(Object.keys(error.toJSON()), [
      "status", "category", "stage", "trace_id", "exception_type", "context_overflow", "quota_reset_at", "retry_after",
    ]);
  });

  it("cleans timers and abort listeners after read completion or cancellation", async () => {
    let timedOut = 0;
    const value = await readNextWithStreamIdleTimeout({ next: async () => ({ done: false as const, value: "ready" }) }, {
      timeoutMs: 15, onTimeout: () => { timedOut += 1; },
    });
    assert.deepEqual(value, { done: false, value: "ready" });
    await delay(25);
    assert.equal(timedOut, 0);

    const signalState: { aborted: boolean; abortListener?: () => void } = { aborted: false };
    const signal = {
      get aborted() { return signalState.aborted; },
      addEventListener: (_type: string, listener: unknown) => { signalState.abortListener = listener as () => void; },
      removeEventListener: () => { signalState.abortListener = undefined; },
    } as unknown as AbortSignal;
    const pending = readNextWithStreamIdleTimeout({ next: () => new Promise<IteratorResult<string>>(() => undefined) }, {
      timeoutMs: 15, signal, onTimeout: () => { timedOut += 1; },
    });
    signalState.aborted = true;
    signalState.abortListener?.();
    await assert.rejects(pending, ProviderCancelled);
    assert.equal(signalState.abortListener, undefined);
    await delay(25);
    assert.equal(timedOut, 0);
  });

  it("ignores comment heartbeats for idleness while each data payload starts a fresh period", async () => {
    await assert.rejects(readPayloads("/comments", TEST_IDLE_TIMEOUT_MS), isModelStreamIdleTimeoutError);
    assert.deepEqual(await readPayloads("/data", TEST_IDLE_TIMEOUT_MS), ["first", "second", "[DONE]"]);
  });
});
