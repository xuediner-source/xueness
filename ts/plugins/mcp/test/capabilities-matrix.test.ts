/** F06.02: the MCP core protocol capability matrix against real scripted servers. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createToolEnv, runTool, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { createMcp, McpClient, type McpRun } from "../src/index.ts";

const SERVER = join(import.meta.dirname, "fake-server.mjs");
const BASE = mkdtempSync(join(tmpdir(), "xueness-mcp-matrix-"));
const WS = join(BASE, "workspace");
mkdirSync(WS, { recursive: true });
after(() => rmSync(BASE, { recursive: true, force: true }));

const stdio = (id: string, ...flags: string[]) => ({ id, command: process.execPath, args: [SERVER, ...flags] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (check()) return; await wait(10); }
  assert.fail(message);
}
const lines = (path: string): string[] => { try { return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; } };

async function withPlugin<T>(run: McpRun, body: (kernel: Context, call: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createMcp({ run: () => run })], { enabled: { mcp: false } });
  await host.start();
  await host.enable("mcp");
  try {
    const env = createToolEnv({ cwd: run.cwd, artifactsDir: join(BASE, "artifacts") });
    return await body(kernel, async (name, input = {}) => {
      const tool = kernel.tools.get<ToolDefinition>(name);
      assert.ok(tool, `tool ${name} registered`);
      return await runTool(tool, input, env) as unknown as Record<string, unknown>;
    });
  } finally { await host.dispose(); await kernel.dispose(); }
}

describe("MCP capability matrix (F06.02)", () => {
  it("negotiates a supported protocol version and records the declared capabilities", async () => {
    const kernel = Context.create();
    const client = new McpClient(kernel, stdio("vnew", "--answer=2025-06-18"), WS);
    assert.equal(await client.start(), true);
    assert.equal(client.negotiatedVersion, "2025-06-18");
    assert.deepEqual(client.serverInfo, { name: "fake", version: "1" });
    assert.equal((client.capabilities.tools as Record<string, unknown>).listChanged, true);
    await client.close();
    const refusing = new McpClient(kernel, stdio("vbad", "--answer=1999-01-01"), WS);
    assert.equal(await refusing.start(), false);
    assert.ok(refusing.error);
    await refusing.close();
    await kernel.dispose();
  });

  it("registers only the capability groups the server declared", async () => {
    await withPlugin({ servers: [stdio("plain"), stdio("res", "--resources"), stdio("sub", "--subscribe")], cwd: WS }, async (kernel, call) => {
      const names = kernel.tools.list().map((tool) => tool.name);
      assert.ok(names.includes("mcp__plain__echo"));
      assert.ok(!names.some((name) => name.startsWith("mcp__plain___xueness_")));
      for (const name of ["mcp__res___xueness_resources_list", "mcp__res___xueness_resources_read", "mcp__res___xueness_prompts_list", "mcp__res___xueness_prompts_read"]) assert.ok(names.includes(name), name);
      assert.ok(!names.includes("mcp__res___xueness_resources_subscribe"));
      for (const name of ["mcp__sub___xueness_resources_subscribe", "mcp__sub___xueness_resources_unsubscribe"]) assert.ok(names.includes(name), name);
      assert.deepEqual(await call("mcp__sub___xueness_resources_subscribe", { key: "file:///watched" }), { ok: true, output: "MCP resource subscribe request completed.", data: { server: "sub", untrusted: true } });
    });
  });

  it("walks every catalog page for tools, resources and prompts", async () => {
    await withPlugin({ servers: [stdio("paged", "--resources", "--paged-catalogs")], cwd: WS }, async (_kernel, call) => {
      const resources = JSON.parse(String((await call("mcp__paged___xueness_resources_list")).output)) as { uri: string }[];
      assert.deepEqual(resources.map((item) => item.uri), ["file:///a", "file:///b", "file:///c"]);
      const prompts = JSON.parse(String((await call("mcp__paged___xueness_prompts_list")).output)) as { name: string }[];
      assert.deepEqual(prompts.map((item) => item.name), ["p1", "p2", "p3"]);
      const prompt = JSON.parse(String((await call("mcp__paged___xueness_prompts_read", { key: "p2", arguments: { topic: "ships" } })).output)) as { messages: { content: { text: string } }[] };
      assert.equal(prompt.messages[0]!.content.text, "prompt p2 about ships");
    });
    const kernel = Context.create();
    const client = new McpClient(kernel, stdio("pages"), WS);
    assert.equal(await client.start(), true);
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["echo", "fail", "structured", "Weird Name!"]);
    await client.close();
    await kernel.dispose();
  });

  it("stops paging at the page limit when a server never finishes its catalog", async () => {
    const kernel = Context.create();
    const client = new McpClient(kernel, stdio("endless", "--endless-cursor"), WS);
    assert.equal(await client.start(), true);
    assert.deepEqual(await client.listTools(), []);
    assert.ok(client.error);
    await client.close();
    await kernel.dispose();
  });

  it("records progress notifications for a requested progress token and cancels a slow call", async () => {
    const kernel = Context.create();
    const client = new McpClient(kernel, stdio("prog", "--progress"), WS);
    assert.equal(await client.start(), true);
    const outcome = await client.callTool("echo", { text: "x" }, undefined, 7);
    assert.deepEqual({ ok: outcome.ok, text: outcome.text }, { ok: true, text: "echo: x" });
    assert.equal(client.progressCount, 2);
    assert.deepEqual(client.progressSignals.map(({ progressToken, progress, total }) => ({ progressToken, progress, total })), [
      { progressToken: 7, progress: 1, total: 2 },
      { progressToken: 7, progress: 2, total: 2 },
    ]);
    await client.callTool("echo", { text: "y" }); // no token: no progress expected
    assert.equal(client.progressCount, 2);
    await client.close();

    const cancelLog = join(BASE, "cancel.log");
    const slow = new McpClient(kernel, { ...stdio("slow", "--delay-call=1500"), env: { MCP_CANCEL_FILE: cancelLog } }, WS);
    assert.equal(await slow.start(), true);
    const controller = new AbortController();
    const pending = slow.callTool("echo", { text: "slow" }, controller.signal);
    await wait(80);
    controller.abort();
    assert.equal((await pending).cancelled, true);
    await eventually(() => lines(cancelLog).length === 1, "notifications/cancelled did not reach the server");
    await slow.close();
    await kernel.dispose();
  });

  it("feeds a tools/list_changed catalog change into the next request round", async () => {
    const kernel = Context.create();
    const client = new McpClient(kernel, stdio("chg", "--change-after-call"), WS);
    assert.equal(await client.start(), true);
    assert.equal((await client.callTool("echo", { text: "x" })).text, "renamed");
    await eventually(() => client.toolsDirty, "tools/list_changed was not observed");
    const revision = client.toolListRevision;
    assert.ok(revision >= 1);
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["beta"]);
    assert.equal(client.toolsDirty, false);
    await client.close();
    await kernel.dispose();

    await withPlugin({ servers: [stdio("live", "--change-after-call")], cwd: WS }, async (kernel2, call) => {
      assert.equal((await call("mcp__live__echo", { text: "x" })).output, "renamed");
      await eventually(() => !!kernel2.tools.get("mcp__live__beta") && !kernel2.tools.get("mcp__live__echo"), "registry did not refresh after list_changed");
      assert.deepEqual(await call("mcp__live__beta", { text: "next" }), { ok: true, output: "beta: next", data: { server: "live" } });
    });
  });

  it("negotiates the HTTP protocol matrix: paging, prompt arguments and SSE progress", async () => {
    const seen: unknown[] = [];
    const reply = (response: ServerResponse, id: unknown, result: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string; params?: Record<string, unknown> };
        seen.push(message.method);
        if (message.method === "initialize") return reply(response, message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} }, serverInfo: { name: "http-matrix" } });
        if (message.method === "tools/list") {
          const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
          return reply(response, message.id, cursor ? { tools: [{ name: "three" }] } : { tools: [{ name: "one" }, { name: "two" }], nextCursor: "h2" });
        }
        if (message.method === "resources/list") return reply(response, message.id, { resources: [{ uri: "file:///h", name: "h" }] });
        if (message.method === "prompts/get") {
          const topic = ((message.params as { arguments?: { topic?: string } } | undefined)?.arguments ?? {}).topic ?? "";
          return reply(response, message.id, { messages: [{ role: "user", content: { type: "text", text: `hp:${topic}` } }] });
        }
        if (message.method === "tools/call") {
          const token = ((message.params as { _meta?: { progressToken?: number } } | undefined)?._meta ?? {}).progressToken;
          if (token === undefined) return reply(response, message.id, { content: [{ type: "text", text: "plain" }] });
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 4 } })}\n\n`);
          response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "with progress" }] } })}\n\n`);
          return response.end();
        }
        response.writeHead(202).end();
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const kernel = Context.create();
    const client = new McpClient(kernel, { id: "httpm", transport: "http", url: `http://127.0.0.1:${port}/mcp`, allowLoopbackHttp: true }, WS);
    try {
      assert.equal(await client.start(), true);
      assert.equal(client.negotiatedVersion, "2025-03-26");
      assert.equal((client.capabilities.resources as Record<string, unknown>).subscribe, true);
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["one", "two", "three"]);
      assert.equal((await client.catalog("resources")).length, 1);
      const prompt = await client.read("prompts", "hp", { topic: "t" });
      assert.equal((prompt.messages as { content: { text: string } }[])[0]!.content.text, "hp:t");
      assert.equal((await client.callTool("one", {})).text, "plain");
      assert.equal((await client.callTool("one", {}, undefined, 42)).text, "with progress");
      assert.equal(client.progressCount, 1);
      assert.deepEqual({ ...client.progressSignals[0]! }, { type: "progress", progressToken: 42, progress: 1, total: 4, observedAt: client.progressSignals[0]!.observedAt });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      await kernel.dispose();
    }
  });
});
