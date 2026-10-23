/**
 * The TS MCP plugin against a scripted stdio server (fake-server.mjs).
 * Mirrors the Python cases in tests/test_mcp.py, test_mcp_version_negotiation.py
 * and test_parity_mcp.py; result text follows ZCode `formatMcpToolResult`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Context, PluginHost } from "@xueness/kernel";
import { createToolEnv, runTool, type ToolDefinition } from "@xueness/engine-tools";
import { createMcp, McpClient, type McpRun } from "../src/index.ts";

const SERVER = join(import.meta.dirname, "fake-server.mjs");
const WS = mkdtempSync(join(tmpdir(), "xueness-mcp-ws-"));
after(() => rmSync(WS, { recursive: true, force: true }));
const stdio = (id: string, ...flags: string[]) => ({ id, command: process.execPath, args: [SERVER, ...flags] });

async function withPlugin<T>(run: McpRun, body: (kernel: Context, call: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createMcp({ run: () => run })], { enabled: { mcp: false } });
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-mcp-artifacts-"));
  const env = createToolEnv({ cwd: run.cwd, artifactsDir: artifacts });
  try {
    await host.start();
    await host.enable("mcp");
    return await body(kernel, async (name, input = {}) => {
      const tool = kernel.tools.get<ToolDefinition>(name);
      assert.ok(tool, `tool ${name} registered`);
      return await runTool(tool, input, env) as unknown as Record<string, unknown>;
    });
  } finally {
    await host.dispose(); await kernel.dispose(); rmSync(artifacts, { recursive: true, force: true });
  }
}

describe("MCP stdio plugin", () => {
  it("registers every page of tools under Python names and calls them", async () => {
    await withPlugin({ servers: [stdio("fake")], cwd: WS }, async (kernel, call) => {
      assert.deepEqual(kernel.tools.list().map((tool) => tool.name), ["mcp__fake__echo", "mcp__fake__fail", "mcp__fake__structured", "mcp__fake__Weird_Name_"]);
      const echo = kernel.tools.get<ToolDefinition>("mcp__fake__echo")!;
      assert.equal(echo.gate, "mcp");
      assert.deepEqual(echo.modelSchema, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
      assert.equal(echo.subject?.({ text: "hi", a: 1 }), '{"arguments":{"a":1,"text":"hi"},"tool":"mcp__fake__echo"}');
      assert.deepEqual(await call("mcp__fake__echo", { text: "hi" }), { ok: true, output: "echo: hi", data: { server: "fake" } });
      const failed = await call("mcp__fake__fail");
      assert.equal(failed.ok, false); assert.equal(failed.output, "MCP tool returned an error:\nbad input");
      assert.deepEqual(failed.error, { code: "mcp_tool_error", message: "bad input" });
      assert.equal((await call("mcp__fake__structured")).output, 'Structured content:\n{\n  "a": 1,\n  "list": [\n    "x"\n  ]\n}');
      // The sanitized model name calls the server's raw tool name.
      assert.equal((await call("mcp__fake__Weird_Name_")).output, "resource text");
    });
  });
  it("answers a server request with method-not-found and still gets the result", async () => {
    await withPlugin({ servers: [stdio("ask", "--ask-first")], cwd: WS }, async (_kernel, call) => {
      assert.equal((await call("mcp__ask__echo", { text: "x" })).output, "echo: x / ask reply: method not found");
    });
  });
  it("adds resource and prompt readers when the server declares them", async () => {
    await withPlugin({ servers: [stdio("res", "--resources")], cwd: WS }, async (kernel, call) => {
      const names = kernel.tools.list().map((tool) => tool.name);
      for (const name of ["mcp__res___xueness_resources_list", "mcp__res___xueness_resources_read", "mcp__res___xueness_prompts_list", "mcp__res___xueness_prompts_read"]) assert.ok(names.includes(name), name);
      assert.deepEqual(await call("mcp__res___xueness_resources_list"), { ok: true, output: '[{"uri": "file:///a", "name": "a"}]', data: { server: "res", untrusted: true } });
      assert.equal((await call("mcp__res___xueness_resources_read", { key: "file:///b" })).output, '{"contents": [{"uri": "file:///b", "text": "contents of file:///b"}]}');
      assert.equal((await call("mcp__res___xueness_prompts_read", { key: "p" })).output, '{"messages": [{"role": "user", "content": {"type": "text", "text": "prompt p"}}]}');
    });
  });
  it("reconnects once when the server went away between calls", async () => {
    await withPlugin({ servers: [stdio("drop", "--exit-after-call")], cwd: WS }, async (_kernel, call) => {
      assert.equal((await call("mcp__drop__echo", { text: "1" })).output, "echo: 1");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await call("mcp__drop__echo", { text: "2" })).output, "echo: 2");
    });
  });
  it("skips a server that cannot start and keeps the others", async () => {
    await withPlugin({ servers: [{ id: "missing", command: join(tmpdir(), "no-such-mcp-server-binary") }, stdio("ok")], cwd: WS }, async (kernel) => {
      assert.ok(kernel.tools.list().every((tool) => tool.name.startsWith("mcp__ok__")));
    });
  });
  it("times out a silent call, kills the process and reports metadata only", async () => {
    await withPlugin({ servers: [{ ...stdio("slow", "--silent-call"), timeout: 0.5 }], cwd: WS }, async (_kernel, call) => {
      const started = Date.now();
      const result = await call("mcp__slow__echo", { text: "x" });
      assert.ok(Date.now() - started < 5000);
      assert.deepEqual(result.error, { code: "mcp_error", message: "timeout after 0.5s" });
    });
  });
  it("gives the child only PATH and HOME on POSIX", { skip: process.platform === "win32" }, async () => {
    process.env.XUENESS_MCP_SECRET_FOR_TEST = "secret";
    try {
      await withPlugin({ servers: [stdio("env", "--env")], cwd: WS }, async (_kernel, call) => {
        const output = String((await call("mcp__env__echo", { text: "x" })).output);
        const seen = output.split("env: ")[1]!.split(",");
        assert.ok(seen.every((key) => ["HOME", "PATH"].includes(key)), output);
      });
    } finally { delete process.env.XUENESS_MCP_SECRET_FOR_TEST; }
  });
});

describe("MCP version negotiation (Python test_mcp_version_negotiation.py)", () => {
  const start = async (server: Record<string, unknown>) => {
    const kernel = Context.create();
    const client = new McpClient(kernel, server, WS);
    try { const ok = await client.start(); return { ok, version: client.negotiatedVersion, error: client.error, info: client.serverInfo }; }
    finally { await client.close(); await kernel.dispose(); }
  };
  it("uses the preferred version when accepted and records server info", async () => {
    const result = await start(stdio("v"));
    assert.equal(result.ok, true); assert.equal(result.version, "2024-11-05"); assert.deepEqual(result.info, { name: "fake", version: "1" });
  });
  it("retries newest first until the server accepts", async () => {
    const result = await start(stdio("v", "--reject=2024-11-05,2025-11-25"));
    assert.equal(result.version, "2025-06-18");
  });
  it("gives up after the whole ladder", async () => {
    const result = await start(stdio("v", "--reject=2024-11-05,2025-03-26,2025-06-18,2025-11-25"));
    assert.equal(result.ok, false); assert.equal(result.error, "server error: code -32602");
  });
  it("refuses an unsupported answer version", async () => {
    const result = await start(stdio("v", "--answer=1999-01-01"));
    assert.equal(result.ok, false); assert.equal(result.error, "unsupported protocol version: 1999-01-01");
  });
  it("a per-server pin is asked first", async () => {
    assert.equal((await start({ ...stdio("v"), protocolVersion: "2025-06-18" })).version, "2025-06-18");
    assert.equal((await start({ ...stdio("v"), protocolVersion: "1.0" })).version, "2024-11-05");
  });
});
