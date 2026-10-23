/** Round 10: the MCP resource/prompt catalog routes Python used to serve, against fake-server.mjs. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createMcpOpsHttp } from "../src/mcp-ops-http.ts";

const SERVER = join(import.meta.dirname, "fake-server.mjs");
const STATE = mkdtempSync(join(tmpdir(), "xueness-mcp-catalog-state-"));
after(() => rmSync(STATE, { recursive: true, force: true }));
mkdirSync(join(STATE, "resources", "mcp"), { recursive: true });
writeFileSync(join(STATE, "resources", "mcp", "fake.json"), JSON.stringify({ id: "fake", command: process.execPath, args: [SERVER] }));
const http = createMcpOpsHttp({ stateDir: STATE, enabled: () => true, projectDir: STATE, webRuns: STATE, allowedRoots: () => [] });
const call = (method: string, path: string, data: unknown = {}) => http.dispatch(method, path.split("/").filter(Boolean), {}, data);

describe("MCP catalog HTTP", () => {
  it("owns the four catalog routes and nothing beside them", () => {
    for (const path of ["/api/mcp/fake/resources", "/api/mcp/fake/prompts", "/api/mcp/fake/resources/read", "/api/mcp/fake/prompts/read"]) assert.equal(http.owns("POST", path.split("/").filter(Boolean)), true, path);
    assert.equal(http.owns("POST", ["api", "mcp", "fake", "tools"]), false);
    assert.equal(http.owns("POST", ["api", "mcp", "fake", "resources", "list"]), false);
  });
  it("needs confirmation, a known server and POST", async () => {
    assert.deepEqual(await call("POST", "/api/mcp/fake/resources", {}), [400, { error: "confirm MCP request first" }]);
    assert.deepEqual(await call("POST", "/api/mcp/fake/resources", []), [400, { error: "MCP request failed (details suppressed)" }]);
    assert.deepEqual(await call("POST", "/api/mcp/missing/resources", { confirmed: true }), [404, { error: "MCP server not found" }]);
    assert.deepEqual(await call("GET", "/api/mcp/fake/prompts"), [405, { error: "method not allowed" }]);
  });
  it("lists and reads resources and prompts", async () => {
    assert.deepEqual(await call("POST", "/api/mcp/fake/resources", { confirmed: true }), [200, { resources: [{ uri: "file:///a", name: "a" }] }]);
    assert.deepEqual(await call("POST", "/api/mcp/fake/prompts", { confirmed: true }), [200, { prompts: [{ name: "p" }] }]);
    assert.deepEqual(await call("POST", "/api/mcp/fake/resources/read", { confirmed: true, key: "file:///a" }), [200, { result: { contents: [{ uri: "file:///a", text: "contents of file:///a" }] } }]);
    const [status, body] = (await call("POST", "/api/mcp/fake/prompts/read", { confirmed: true, key: "p", arguments: {} }))!;
    assert.equal(status, 200);
    assert.equal((body as any).result.messages[0].content.text, "prompt p");
    assert.deepEqual(await call("POST", "/api/mcp/fake/resources/read", { confirmed: true, key: "" }), [400, { error: "MCP request failed (details suppressed)" }]);
  });
});
