import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { AgentContext } from "@xueness/agent";
import { Context, PluginHost } from "@xueness/kernel";
import { createToolEnv, runTool, type ToolDefinition } from "@xueness/engine-tools";
import { createMcp, McpCancelledError, McpClient, McpConnectionPool, mcpRuntimeExtension, type McpRun, type McpRuntimeBinding } from "../src/index.ts";
import { RpcChannel } from "../src/rpc.ts";

const BASE = mkdtempSync(join(tmpdir(), "xueness-mcp-runtime-"));
const FIXTURE = join(import.meta.dirname, "runtime-fixture.mjs");
const WS = join(BASE, "workspace");
mkdirSync(WS, { recursive: true });
after(() => rmSync(BASE, { recursive: true, force: true }));

const stdio = (id: string, flags: string[] = [], extra: Record<string, unknown> = {}) => ({ id, command: process.execPath, args: [FIXTURE, ...flags.map((flag) => `--${flag}`)], ...extra });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (check()) return; await wait(10); }
  assert.fail(message);
}
function lines(path: string): string[] { try { return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; } }

interface FixtureRuntime {
  kernel: Context;
  host: PluginHost;
  binding: McpRuntimeBinding;
  artifacts: string;
  call(name: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startPlugin(run: McpRun): Promise<FixtureRuntime> {
  const kernel = Context.create();
  const binding: McpRuntimeBinding = {};
  const host = new PluginHost(kernel, [createMcp({ run: () => run, binding })], { enabled: { mcp: false } });
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-mcp-runtime-artifacts-"));
  await host.start();
  await host.enable("mcp");
  return {
    kernel, host, binding, artifacts,
    async call(name, input = {}, signal) {
      const tool = kernel.tools.get<ToolDefinition>(name);
      assert.ok(tool, `registered tool ${name}`);
      const env = createToolEnv({ cwd: run.cwd, artifactsDir: artifacts, ...(signal ? { signal } : {}) });
      return await runTool(tool, input, env) as unknown as Record<string, unknown>;
    },
    async close() { await host.dispose(); await kernel.dispose(); rmSync(artifacts, { recursive: true, force: true }); },
  };
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

describe("MCP runtime lifecycle", () => {
  it("dedupes initialize and shares only identical owner, cwd and config leases", async () => {
    const initLog = join(BASE, "initialize.log");
    const server = { ...stdio("pool", [], { env: { MCP_INIT_FILE: initLog, MCP_SETTING: "same" }, _elicitation_session: { id: "session-a" } }) };
    const kernel = Context.create();
    const client = new McpClient(kernel, server, WS);
    const starts = await Promise.all([client.start(), client.start(), client.start()]);
    assert.deepEqual(starts, [true, true, true]);
    assert.equal(lines(initLog).length, 1);
    await client.close();

    const pool = new McpConnectionPool(kernel);
    const first = await pool.acquire(server, WS);
    const same = await pool.acquire(server, WS);
    const otherSession = await pool.acquire({ ...server, _elicitation_session: { id: "session-b" } }, WS);
    const otherConfig = await pool.acquire({ ...server, env: { MCP_INIT_FILE: initLog, MCP_SETTING: "changed" } }, WS);
    assert.ok(first && same && otherSession && otherConfig);
    assert.equal(first.connectionId, same.connectionId);
    assert.notEqual(first.connectionId, otherSession.connectionId);
    assert.notEqual(first.connectionId, otherConfig.connectionId);
    assert.equal(lines(initLog).length, 4);
    await first.release();
    assert.equal(first.client.active, true);
    await same.release();
    assert.equal(first.client.active, false);
    await Promise.all([otherSession.release(), otherConfig.release()]);
    await pool.close();
    await kernel.dispose();
  });

  it("refreshes registered tools after tools/list_changed, keeps the first sanitized collision, and unloads them", async () => {
    const runtime = await startPlugin({ servers: [stdio("dynamic", ["dynamic-tools"])], cwd: WS });
    try {
      const changed = await runtime.call("mcp__dynamic__echo", { text: "__change_tools__" });
      assert.equal(changed.output, "changed");
      await eventually(() => runtime.kernel.tools.list().some((tool) => tool.name === "mcp__dynamic__alpha_") && !runtime.kernel.tools.get("mcp__dynamic__echo"), "tool registry did not refresh");
      assert.equal(runtime.kernel.tools.list().filter((tool) => tool.name === "mcp__dynamic__alpha_").length, 1);
      assert.equal((await runtime.call("mcp__dynamic__alpha_")).output, "raw:alpha!");
      await runtime.host.disable("mcp");
      assert.equal(runtime.kernel.tools.list().filter((tool) => tool.name.startsWith("mcp__dynamic__")).length, 0);
      assert.equal(runtime.binding.current, undefined);
    } finally { await runtime.close(); }
  });

  it("adds subscribe tools only for declared capability and keeps resource notifications metadata-only", async () => {
    const runtime = await startPlugin({ servers: [stdio("sub", ["subscriptions"]), stdio("plain", ["resources"])], cwd: WS });
    const emitted: Record<string, unknown>[] = [];
    const extension = mcpRuntimeExtension(runtime.binding);
    const context = { emit: (event: Record<string, unknown>) => emitted.push(event) } as unknown as AgentContext;
    try {
      await extension.beforeRun?.(context);
      const names = runtime.kernel.tools.list().map((tool) => tool.name);
      const subscribe = "mcp__sub___xueness_resources_subscribe";
      const unsubscribe = "mcp__sub___xueness_resources_unsubscribe";
      assert.ok(names.includes(subscribe));
      assert.ok(names.includes(unsubscribe));
      assert.equal(runtime.kernel.tools.get<ToolDefinition>(subscribe)?.gate, "mcp");
      assert.ok(!names.includes("mcp__plain___xueness_resources_subscribe"));
      const result = await runtime.call(subscribe, { key: "file:///secret-uri" });
      assert.equal(result.ok, true);
      await eventually(() => Number(runtime.binding.current?.snapshot().servers.find((server) => server.serverId === "sub")?.resourceUpdatedCount) === 1, "resource metadata was not retained");
      assert.equal(emitted.filter((event) => event.phase === "resources_changed" || event.phase === "resource_updated").length, 0);
      await extension.beforeModelRequest?.(context);
      const visible = JSON.stringify({ snapshot: runtime.binding.current?.snapshot(), emitted });
      assert.ok(visible.includes("resources_changed"));
      assert.ok(visible.includes("resource_updated"));
      assert.ok(!visible.includes("secret-uri"));
      assert.ok(!visible.includes("private content"));
    } finally { await extension.close?.(context); await runtime.close(); }
  });

  it("does not block replies on notification handlers and clears cancelled RPC waiters", async () => {
    const sent: Record<string, unknown>[] = [];
    const controller = new AbortController();
    const channel = new RpcChannel(async (message, signal) => {
      sent.push(message);
      if (message.method === "tools/call") await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true }));
    });
    channel.notificationHandler = async () => { await wait(150); };
    const pending = channel.request("tools/call", {}, 5000, undefined, controller.signal);
    assert.equal(channel.pendingCount, 1);
    controller.abort();
    await assert.rejects(pending, McpCancelledError);
    assert.equal(channel.pendingCount, 0);
    await eventually(() => sent.some((message) => message.method === "notifications/cancelled"), "cancel notification was not sent");
    const started = Date.now();
    const reply = channel.request("ping", {}, 1000, 9).then((value) => value);
    channel.receive({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    channel.receive({ jsonrpc: "2.0", id: 9, result: { alive: true } });
    assert.deepEqual(await reply, { alive: true });
    assert.ok(Date.now() - started < 100);
  });

  it("aborts the active HTTP request, sends cancellation, and never replays the cancelled call", async () => {
    let calls = 0, cancellations = 0, aborted = 0;
    const server = await serve(async (request, response) => {
      const message = await requestBody(request);
      if (message.method === "notifications/cancelled") { cancellations += 1; response.writeHead(202).end(); return; }
      if (message.method === "initialize") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: {} } }));
      else if (message.method === "tools/list") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      else if (message.method === "tools/call") {
        calls += 1;
        if (calls === 1) { response.on("close", () => { if (!response.writableEnded) aborted += 1; }); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "second call" }] } }));
      } else response.writeHead(202).end();
    });
    const runtime = await startPlugin({ servers: [{ id: "http", transport: "http", url: server.url, allowLoopbackHttp: true }], cwd: WS });
    const controller = new AbortController();
    try {
      const first = runtime.call("mcp__http__echo", { text: "side effect" }, controller.signal);
      await eventually(() => calls === 1, "HTTP tool request did not start");
      controller.abort();
      const cancelledResult = await first;
      assert.deepEqual(cancelledResult.error, { code: "cancelled", message: "mcp__http__echo cancelled" });
      await eventually(() => cancellations === 1 && aborted === 1, "HTTP cancellation did not abort the request and send notifications/cancelled");
      await eventually(() => runtime.binding.current?.snapshot().servers[0]?.status === "disconnected", "cancelled HTTP transport did not reset");
      assert.equal(calls, 1);
      const next = await runtime.call("mcp__http__echo", { text: "new invocation" });
      assert.deepEqual(next, { ok: true, output: "second call", data: { server: "http" } });
      assert.equal(calls, 2);
    } finally { await runtime.close(); await server.close(); }
  });
});
