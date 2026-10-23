import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";
import { handoffModelJson, requestConversationTitle } from "@xueness/plugin-providers";
import { switchableProvider } from "@xueness/plugin-sessions";
import { OpenAICompatible } from "@xueness/providers";
import type { Row } from "@xueness/agent";
it("uses the completed adapter for naming and applies a pending switch before a private verifier request", async () => {
  const requests: Row[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const content = requests.length === 1 ? '{"title":"Bound title"}' : '{"checked":true}';
    res.setHeader("Content-Type", "text/event-stream"); res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const original = new OpenAICompatible({ base, model: "completed-model", key: "local", allowLoopbackHttp: true, compatibility: { toolChoice: "required", parallelToolCalls: true } }); original.requestDeadline = 1e9;
  const next = new OpenAICompatible({ base, model: "next-model", key: "local", maxOutputTokens: 2000, allowLoopbackHttp: true });
  const session: Row = {}, provider = switchableProvider(original, session); provider.switchTo({ provider_id: "next", model: "next-model" }, next);
  try {
    const title = await requestConversationTitle(provider, [{ role: "user", content: "Title" }], new AbortController().signal); assert.equal(title, '{"title":"Bound title"}'); assert.equal(requests[0]!.model, "completed-model"); assert.ok(provider.pendingSelection());
    const [result] = await handoffModelJson(provider, [{ role: "user", content: "Verify" }], { outputTokens: 300 }); assert.deepEqual(result, { checked: true }); assert.equal(requests[1]!.model, "next-model");
    assert.equal(next.maxOutputTokens, 2000); assert.equal(next.requestDeadline, 1e9); assert.equal(provider.pendingSelection(), null);
    assert.equal(requests[0]!.tool_choice, undefined); assert.equal(requests[0]!.parallel_tool_calls, undefined); assert.ok(Number(requests[0]!.max_tokens) <= 256); assert.equal(requests[1]!.max_tokens, 300);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
