import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentContext, ModelRequest, Row } from "@xueness/agent";
import { modelTools } from "@xueness/agent";
import { ProviderRequestError, reasoningOrigin } from "@xueness/providers";
import { providerRequestShapingExtension } from "../src/request-shaping.ts";

it("uses the pending model's identity, protects media boundaries, and preserves explicit strict intent", async () => {
  const old = { protocol: "anthropic", model: "claude-old", base: "https://example.test/v1" };
  const next = { ...old, model: "claude-next" };
  const extension = providerRequestShapingExtension();
  const mediaUser: Row = { role: "user", content: "attached", _media_refs: [{ id: "test" }] };
  const message: Row = { role: "assistant", content: "old answer", _reasoning_blocks: [{ type: "thinking", thinking: "old", signature: "signed" }], _reasoning_origin: reasoningOrigin(old) };
  const request: ModelRequest = { tools: [], options: {}, messages: [
    { role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: " " }] }, mediaUser, message,
  ] };
  const original = structuredClone(request);
  const context = { provider: { ...old, upcomingProvider: () => next } } as unknown as AgentContext;
  const projected = await extension.prepareRequest!(context, request);
  assert.equal(projected.options.reasoningHistoryNormalized, true);
  assert.ok(projected.messages.includes(mediaUser));
  const assistant = projected.messages.find((item) => item.role === "assistant")!;
  assert.deepEqual(assistant.content, [{ type: "text", text: "old answer" }]);
  assert.deepEqual(request, original);
  const [tool] = modelTools([{ type: "function", function: { name: "read", strict: true } }]);
  assert.equal((tool!.function as Row).strict, true);
});

it("repairs only an explicit signature rejection, once, without rerunning structural normalization", async () => {
  const extension = providerRequestShapingExtension();
  const context = { provider: { protocol: "anthropic" } } as unknown as AgentContext;
  const request: ModelRequest = { tools: [], options: { reasoningHistoryNormalized: true }, messages: [
    { role: "assistant", content: [{ type: "text", text: "(no content)" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "old", providerOptions: { anthropic: { signature: "sig" } } }] },
    { role: "user", content: "continue" },
  ] };
  assert.equal(await extension.retryRequest!(context, request, new ProviderRequestError({ status: 400 })), null);
  const error = new ProviderRequestError({ status: 400, reasoningSignatureRejected: true });
  const repaired = (await extension.retryRequest!(context, request, error))!;
  assert.deepEqual(repaired.messages[0], request.messages[0]);
  assert.deepEqual(repaired.messages[1]!.content, [{ type: "text", text: "[Thinking removed]" }]);
  assert.equal(await extension.retryRequest!(context, repaired, error), null);
  assert.deepEqual((request.messages[1]!.content as Row[])[0]!.providerOptions, { anthropic: { signature: "sig" } });
  assert.equal(Object.hasOwn(error.toJSON(), "reasoningSignatureRejected"), false);
});
