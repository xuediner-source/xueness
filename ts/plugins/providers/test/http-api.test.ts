import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { createProvidersApi } from "../src/http-api.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, unknown>;
interface Request { method: string; path: string; data?: unknown; expectOk?: boolean }
const oraclePath = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
const normalize = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(normalize);
  if (!isDict(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, ["latencyMs", "testedAt", "verifiedAt", "updatedAt"].includes(k) ? "(dynamic)" : normalize(v)]));
};
async function compare(requests: Request[], allowReal = false, disabled = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "xueness-provider-http-"));
  const stateDir = join(root, "ts"), pythonState = join(root, "python"); mkdirSync(stateDir); mkdirSync(pythonState);
  try {
    const expected = JSON.parse(await runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(oraclePath)}, run_name='__main__')`, JSON.stringify({ stateDir: pythonState, workspace: root, allowReal, disabled: disabled ? ["providers"] : [], requests })));
    const api = createProvidersApi({ stateDir, allowReal, enabled: () => !disabled });
    const actual: unknown[] = [];
    for (const req of requests) {
      const result = Object.hasOwn(req, "data") && !isDict(req.data) ? [400, { error: "invalid json body", code: "invalid_json" }] as [number, Row] : await api.dispatch(req.method, req.path.split("/").filter(Boolean), {}, req.data ?? {});
      assert.ok(result, req.path);
      if (req.expectOk) assert.equal((result[1] as Row).ok, true, JSON.stringify(result));
      actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]);
    }
    assert.deepEqual(normalize(actual), normalize(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const profile = { id: "p", name: "Profile", baseUrl: "https://example.invalid/v1", model: "gpt-6-sol", apiKey: "secret-fixture-key" };
describe("providers feature matches real Python HTTP", { skip: pythonUnavailableReason() ?? false }, () => {
  it("validates, preserves credentials across edits, merges compatibility and deletes", async () => {
    await compare([
      { method: "GET", path: "/api/providers" },
      ...[null, {}, { ...profile, id: ".." }, { ...profile, baseUrl: "https://user:password@example.invalid" }, { ...profile, allowLoopbackHttp: 1 }, { ...profile, capabilities: ["image", "image"] }, { ...profile, reasoningLevels: ["ultra"] }, { ...profile, runtimeProfile: "bad" }, { ...profile, compatibility: { unknown: true } }].map((data) => ({ method: "POST", path: "/api/providers", data })),
      { method: "POST", path: "/api/providers", data: { ...profile, compatibility: { streamUsage: false }, capabilities: ["video", "image"] } },
      { method: "POST", path: "/api/providers", data: { id: "p", name: "Edited", baseUrl: profile.baseUrl, model: profile.model, compatibility: { think: false } } },
      { method: "GET", path: "/api/providers" },
      { method: "POST", path: "/api/providers/default", data: { providerId: "p", reasoningEffort: "high" } },
      { method: "GET", path: "/api/providers/default" },
      { method: "POST", path: "/api/providers/default", data: { clear: true } },
      { method: "DELETE", path: "/api/providers/p" }, { method: "DELETE", path: "/api/providers/p" },
    ]);
  });
  it("refuses diagnostics without host opt-in and disabled plugins", async () => {
    await compare(["test", "discover", "compatibility-test"].map((p) => ({ method: "POST", path: `/api/providers/${p}`, data: { id: "p", mode: "conversation" } })));
    await compare([{ method: "GET", path: "/api/providers" }], false, true);
  });
  it("runs bounded local connection/discovery and all compatibility modes with persisted proof", async () => {
    const recorded: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      recorded.push({ method: req.method, path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
      if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture", created: 1, owned_by: "local", secret: "ignored" }] })); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = JSON.stringify(body.messages);
      const followup = text.includes("receipt from the tool result");
      const json = !body.tools && text.includes("JSON object");
      const content = followup ? body.tools ? "xueness-local-fixture:3+4=7" : '{"answer":"xueness-local-fixture:3+4=7","evidence":[]}' : json ? '{"tool":"xueness_fixture_add","arguments":{"a":3,"b":4}}' : "OK";
      const toolCall = body.tools && !followup ? [{ id: "call-1", type: "function", function: { name: "xueness_fixture_add", arguments: '{"a":3,"b":4}' } }] : [];
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(toolCall.length ? { tool_calls: toolCall.map((c) => ({ ...c, index: 0 })) } : {}) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content, tool_calls: toolCall } }] })); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      await compare([
        { method: "POST", path: "/api/providers", data: { ...profile, baseUrl, runtimeProfile: "lightweight" } },
        ...["test", "discover"].map((a) => ({ method: "POST", path: `/api/providers/${a}`, data: { id: "p" } })),
        ...["conversation", "stream", "native_tool_call", "json_tool_call", "tool_roundtrip", "json_tool_roundtrip"].map((mode) => ({ method: "POST", path: "/api/providers/compatibility-test", data: { id: "p", mode }, expectOk: true })),
        { method: "POST", path: "/api/providers/compatibility-adopt", data: { id: "p", optionsHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" } },
        { method: "GET", path: "/api/providers" },
        { method: "POST", path: "/api/providers", data: { ...profile, baseUrl, runtimeProfile: "lightweight" } },
        { method: "POST", path: "/api/providers/compatibility-adopt", data: { id: "p", optionsHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" } },
      ], true);
      const canonical = (rows: unknown[]): unknown => JSON.parse(JSON.stringify(rows).replace(/local-[0-9a-f]{32}/g, "local-(uuid)"));
      assert.equal(recorded.length, 20, "one request per probe, two for roundtrips");
      assert.deepEqual(canonical(recorded.slice(10)), canonical(recorded.slice(0, 10)), "diagnostics send the same wire payloads as Python");
    } finally { await new Promise<void>((r, j) => server.close((e) => e ? j(e) : r())); }
  });
});
