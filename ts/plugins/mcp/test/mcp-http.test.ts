/**
 * Streamable HTTP and legacy SSE transports against an in-process server
 * (Python mcp_http.py / sse.py behaviour: loopback http only when allowed,
 * env-named auth headers, Mcp-Session-Id, JSON or SSE replies, same-origin
 * SSE endpoint).
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Context } from "@xueness/kernel";
import { authHeaders, checkedUrl, McpClient } from "../src/index.ts";

type Row = Record<string, unknown>;
const tools = [{ name: "echo", inputSchema: { type: "object" } }];
function reply(message: Row): Row | null {
  const params = (message.params ?? {}) as Row;
  if (message.method === "initialize") return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-fake" } };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") return { content: [{ type: "text", text: "echo: " + String((params.arguments as Row).text) }] };
  return null;
}
async function body(request: IncomingMessage): Promise<Row> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row;
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
async function exercise(server: Row) {
  const kernel = Context.create();
  const client = new McpClient(kernel, server, process.cwd());
  try {
    const started = await client.start();
    if (!started) return { started, error: client.error };
    const listed = await client.listTools();
    const called = await client.callTool("echo", { text: "hi" });
    return { started, listed: listed.map((tool) => tool.name), called, version: client.negotiatedVersion };
  } finally { await client.close(); await kernel.dispose(); }
}

describe("MCP Streamable HTTP", () => {
  for (const mode of ["json", "sse"] as const) it(`speaks JSON-RPC over POST with ${mode} replies and keeps the session id`, async () => {
    const seen: Row[] = [];
    const server = await serve(async (request, response) => {
      const message = await body(request);
      seen.push({ method: message.method, session: request.headers["mcp-session-id"] ?? null, version: request.headers["mcp-protocol-version"] ?? null, auth: request.headers.authorization ?? null });
      if (!("id" in message)) { response.writeHead(202).end(); return; }
      const result = reply(message);
      const out = result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "x" } };
      const headers: Record<string, string> = message.method === "initialize" ? { "Mcp-Session-Id": "session-1" } : {};
      if (mode === "json") response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(out));
      else response.writeHead(200, { ...headers, "Content-Type": "text/event-stream" }).end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify(out)}\n\n`);
    });
    process.env.XUENESS_MCP_TEST_TOKEN = "Bearer t0ken";
    try {
      const result = await exercise({ id: "h", transport: "http", url: server.url, allowLoopbackHttp: true, headersEnv: { Authorization: "XUENESS_MCP_TEST_TOKEN" } });
      assert.deepEqual(result, { started: true, listed: ["echo"], called: { ok: true, text: "echo: hi", error: null, toolError: false }, version: "2025-03-26" });
      assert.deepEqual(seen[0], { method: "initialize", session: null, version: null, auth: "Bearer t0ken" });
      assert.deepEqual(seen.at(-1), { method: "tools/call", session: "session-1", version: "2025-03-26", auth: "Bearer t0ken" });
    } finally { delete process.env.XUENESS_MCP_TEST_TOKEN; await server.close(); }
  });
  it("a rejected request is a suppressed transport failure", async () => {
    const server = await serve(async (request, response) => {
      const message = await body(request);
      if (!("id" in message)) { response.writeHead(202).end(); return; }
      const result = message.method === "tools/call" ? null : reply(message);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -1, message: "secret detail" } }));
    });
    try {
      const result = await exercise({ id: "h", transport: "streamable-http", url: server.url, allowLoopbackHttp: true });
      assert.deepEqual(result.called, { ok: false, text: "", error: "HTTP MCP server rejected request", toolError: false });
    } finally { await server.close(); }
  });
  it("refuses plain http without the loopback opt-in, URLs with credentials or queries, and bad auth config", async () => {
    assert.throws(() => checkedUrl({ url: "http://127.0.0.1:1/mcp" }));
    assert.throws(() => checkedUrl({ url: "http://localhost:1/mcp", allowLoopbackHttp: true }), "a hostname is not a loopback literal");
    assert.throws(() => checkedUrl({ url: "https://u:p@example.com/mcp" }));
    assert.throws(() => checkedUrl({ url: "https://example.com/mcp?x=1" }));
    assert.equal(checkedUrl({ url: "https://example.com/mcp" }), "https://example.com/mcp");
    assert.equal(checkedUrl({ url: "http://[::1]:9/mcp", allowLoopbackHttp: true }), "http://[::1]:9/mcp");
    assert.throws(() => authHeaders({ headersEnv: { Cookie: "X" } }), /invalid authentication header configuration/);
    assert.throws(() => authHeaders({ headersEnv: { "X-Api-Key": "XUENESS_MCP_NOT_SET" } }), /missing or invalid/);
    const result = await exercise({ id: "h", transport: "http", url: "http://127.0.0.1:1/mcp" });
    assert.deepEqual(result, { started: false, error: "HTTP MCP initialization failed (details suppressed)" });
  });
  it("does not follow a redirect", async () => {
    const server = await serve((_request, response) => { response.writeHead(307, { Location: "https://example.com/elsewhere" }).end(); });
    try {
      assert.equal((await exercise({ id: "h", transport: "http", url: server.url, allowLoopbackHttp: true })).started, false);
    } finally { await server.close(); }
  });
});

describe("MCP legacy SSE", () => {
  it("POSTs to the same-origin endpoint and reads replies from the stream", async () => {
    let stream: ServerResponse | null = null;
    const server = await serve(async (request, response) => {
      if (request.method === "GET") {
        stream = response;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: endpoint\ndata: /messages?session=1\n\n");
        return;
      }
      const message = await body(request);
      response.writeHead(202).end();
      const result = "id" in message ? reply(message) : null;
      if (result) stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
    try {
      const result = await exercise({ id: "s", transport: "sse", url: server.url, allowLoopbackHttp: true });
      assert.deepEqual(result.called, { ok: true, text: "echo: hi", error: null, toolError: false });
    } finally { await server.close(); }
  });
  it("refuses a cross-origin endpoint", async () => {
    const server = await serve((request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: endpoint\ndata: http://127.0.0.2:9/messages\n\n");
    });
    try {
      assert.deepEqual(await exercise({ id: "s", transport: "sse", url: server.url, allowLoopbackHttp: true, timeout: 1 }), { started: false, error: "SSE MCP initialization failed" });
    } finally { await server.close(); }
  });
});
