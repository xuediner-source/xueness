/** The owned worker protocol (Python `subscriptions/broker.py` + `provider.py`) against a fake worker speaking the same JSON lines. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ProviderCancelled, ProviderRequestError } from "@xueness/providers";
import { NativeProvider, SubscriptionBroker, SubscriptionRequestError } from "../src/index.ts";

const FAKE_WORKER = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, action, data, target } = JSON.parse(line);
  if (action === "abort") { appendFileSync(process.env.FAKE_LOG, target + "\\n"); continue; }
  if (action === "env") out({ id, result: { keys: Object.keys(process.env).sort(), store: process.env.XUENESS_SUBSCRIPTIONS_STORE, cwd: process.cwd(), pid: process.pid } });
  else if (action === "generate") {
    out({ id, chunk: { type: "reasoning", text: "think" } }); out({ id, chunk: { type: "content", text: "hel" } }); out({ id: "other", chunk: { type: "content", text: "stray" } });
    process.stdout.write(JSON.stringify({ id, chunk: { type: "content", text: "lo" } }).slice(0, 10)); setTimeout(() => process.stdout.write(JSON.stringify({ id, chunk: { type: "content", text: "lo" } }).slice(10) + "\\n"), 20);
    setTimeout(() => out({ id, result: data.model === "bad" ? { content: 1 } : { content: "hello", tool_calls: [], echo: data, _usage: { input_tokens: 3, output_tokens: 2 } } }), 40);
  } else if (action === "fail") out({ id, error: "upstream said no", errorInfo: { category: "rate_limited", status: 429 } });
  else if (action === "odd") out({ id, error: "x".repeat(900), errorInfo: { category: "made_up", status: 99 } });
  else if (action === "array") out({ id, result: [1, 2] });
  else if (action === "die") process.exit(1);
  // "hang": never answers.
}
`;

describe("subscription worker broker", () => {
  const base = mkdtempSync(join(tmpdir(), "subscription-broker-")), script = join(base, "fake-worker.mjs"), log = join(base, "aborts.log");
  writeFileSync(script, FAKE_WORKER); writeFileSync(log, "");
  let available = true;
  const requireAvailable = (): void => { if (!available) throw new Error("plugin disabled or dependency unavailable: subscriptions"); };
  const env = { PATH: process.env.PATH, FAKE_LOG: log, OPENAI_API_KEY: "secret", MY_TOKEN: "secret", CODEX_HOME: "/codex", QODER_ACCESS_TOKEN: "kept" };
  const broker = new SubscriptionBroker(join(base, "state"), requireAvailable, env, script);
  after(async () => { await broker.shutdown(); rmSync(base, { recursive: true, force: true }); });

  it("does not start a worker for status-only calls and starts one on demand with a filtered environment", async () => {
    assert.deepEqual(await broker.call("status", "qoder", {}, { start: false }), {});
    assert.equal(broker.running(), false);
    const reply = await broker.call("env", "qoder");
    assert.equal(broker.running(), true);
    assert.deepEqual((reply.keys as string[]).filter((key) => key in env || key === "XUENESS_SUBSCRIPTIONS_STORE"), ["CODEX_HOME", "FAKE_LOG", "PATH", "QODER_ACCESS_TOKEN", "XUENESS_SUBSCRIPTIONS_STORE"]);
    assert.equal(reply.store, join(base, "state", "subscriptions"));
  });

  it("streams chunks, ignores other requests' lines and maps worker failures to sanitized errors", async () => {
    const chunks: unknown[] = [];
    const result = await broker.call("generate", "qoder", { model: "m" }, { onChunk: (chunk) => chunks.push(chunk) });
    assert.deepEqual(chunks.map((chunk) => (chunk as { text: string }).text), ["think", "hel", "lo"]);
    assert.equal(result.content, "hello");
    await assert.rejects(broker.call("fail", "qoder"), (error: unknown) => error instanceof SubscriptionRequestError && error.message === "upstream said no" && error.category === "rate_limited" && error.status === 429);
    await assert.rejects(broker.call("odd", "qoder"), (error: unknown) => error instanceof SubscriptionRequestError && error.message.length === 700 && error.category === "request_failed" && error.status === null);
    assert.deepEqual(await broker.call("array", "qoder"), {});
    await assert.rejects(broker.call("env", "qoder", {}, { requestDeadline: performance.now() / 1000 - 1 }), (error: unknown) => error instanceof SubscriptionRequestError && error.category === "timeout");
  });

  it("aborts a cancelled request in the worker and times out at the request deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(broker.call("hang", "qoder", {}, { signal: controller.signal }), ProviderCancelled);
    await assert.rejects(broker.call("hang", "qoder", {}, { requestDeadline: performance.now() / 1000 + 0.1 }), (error: unknown) => error instanceof SubscriptionRequestError && error.category === "timeout");
    await broker.call("env", "qoder");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length, 2);
  });

  it("serves the provider seam: deltas, usage and request errors", async () => {
    const record = { subscriptionId: "qoder", model: "m", baseUrl: "https://example.invalid", capabilities: ["tools"], maxOutputTokens: 512 };
    const provider = new NativeProvider(broker, requireAvailable, record, null);
    provider.sessionId = "s-1";
    const deltas: string[] = [], reasoning: string[] = [];
    const reply = await provider.stream([{ role: "user", content: "hi" }], [], { onDelta: (text: unknown) => deltas.push(String(text)), onReasoningDelta: (text: unknown) => reasoning.push(String(text)) });
    assert.deepEqual([deltas, reasoning], [["hel", "lo"], ["think"]]);
    assert.deepEqual((reply.echo as Record<string, unknown>), { model: "m", messages: [{ role: "user", content: "hi" }], tools: [], sessionId: "s-1", reasoningEffort: null, maxTokens: 512 });
    assert.equal(reply._request_attempts, 1); assert.ok(reply._usage);
    const bad = new NativeProvider(broker, requireAvailable, { ...record, model: "bad" });
    await assert.rejects(bad.complete([], []), (error: unknown) => error instanceof ProviderRequestError);
  });

  it("waits for the real owned process to exit before shutdown resolves", async () => {
    const reply = await broker.call("env", "qoder");
    const pid = reply.pid as number;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0));
    await broker.shutdown();
    assert.equal(broker.running(), false);
    assert.throws(() => process.kill(pid, 0), "shutdown must release the actual process before resolving");
    await broker.shutdown();
  });

  it("stops the worker when it exits or the plugin becomes unavailable", async () => {
    await assert.rejects(broker.call("die", "qoder"), (error: unknown) => error instanceof SubscriptionRequestError && error.category === "connection_failed");
    assert.equal(broker.running(), false);
    await broker.call("env", "qoder");
    available = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(broker.running(), false);
    await assert.rejects(broker.call("env", "qoder"), /plugin disabled/);
  });
});
