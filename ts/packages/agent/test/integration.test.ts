import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OpenAICompatible } from "@xueness/providers";
import { SessionStore } from "@xueness/sessions";
import { AgentRunner, kernelAgentHooks, type Row } from "../src/index.ts";
import { setup } from "../../tool-bridge/test/support.ts";

describe("agent production adapters", () => {
  it("streams through the real provider, executes a real plugin read through ToolBridge, then reloads its completed journal", async () => {
    const workspace = await setup();
    const state = mkdtempSync(join(tmpdir(), "xueness-agent-state-"));
    writeFileSync(join(workspace.workspace, "hello.txt"), "Hello from the real file plugin\n");
    const requests: Row[] = [];
    const server = createServer((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (chunk: Buffer) => body.push(chunk));
      req.on("end", () => {
        const request = JSON.parse(Buffer.concat(body).toString("utf8")) as Row; requests.push(request);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (requests.length === 1) {
          res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"hello.txt"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n");
        } else {
          res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "The file says hello.\nEvidence: E1" }, finish_reason: "stop" }] }) + "\n\n");
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAICompatible({ base: `http://127.0.0.1:${port}/v1`, model: "local-scripted", key: "", allowLoopbackHttp: true, allowEmptyKey: true });
    const store = new SessionStore(state);
    const session = await store.new("Read hello.txt", workspace.workspace);
    const events: Row[] = [];
    const hooks = kernelAgentHooks(workspace.kernel, { enabled: (id) => ["providers", "sessions"].includes(id) || workspace.host.list().some((entry) => entry.id === id && entry.state === "active") });
    const runner = new AgentRunner({ store, root: workspace.workspace, provider, toolBridge: workspace.bridge, hooks, onEvent: (event) => events.push(event) });
    try {
      await runner.run(session);
      assert.equal(session.status, "completed");
      assert.equal((session.completion as Row).verified, true);
      assert.match(((session.results as Row)["read-1"] as Row).output as string, /Hello from the real file plugin/);
      assert.equal(requests.length, 2);
      assert.ok((requests[0]!.tools as Row[]).some((schema) => (schema.function as Row).name === "read"));
      assert.ok((requests[1]!.messages as Row[]).some((message) => message.role === "tool" && String(message.content).includes("Hello from the real file plugin")));
      assert.ok(events.some((event) => event.type === "assistant_delta"));
      const loaded = await store.load(session.id as string);
      assert.equal(loaded.status, "completed"); assert.equal((loaded.completion as Row).summary, "The file says hello.");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await workspace.close(); rmSync(state, { recursive: true, force: true }); }
  });
});
