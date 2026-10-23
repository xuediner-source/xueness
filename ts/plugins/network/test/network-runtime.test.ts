import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolEnv } from "@xueness/engine-tools";
import { FetchCache, networkActivityExtension, networkTools, postJson, type HttpExchange, type HttpResponse, type Net, type NetworkActivityEvent } from "../src/index.ts";

interface Reply { status?: number; location?: string; contentType?: string; body?: string }
interface Script { dns?: Record<string, string[]>; replies: Reply[]; onLookup?: (host: string) => Promise<string[]> }

function scripted(script: Script): Net & { lookups: string[]; requests: HttpExchange[]; closes: number } {
  const lookups: string[] = [], requests: HttpExchange[] = [];
  const state = { closes: 0 };
  return { lookups, requests, get closes() { return state.closes; },
    async lookup(host) { lookups.push(host); return script.onLookup ? script.onLookup(host) : script.dns?.[host] ?? ["8.8.8.8"]; },
    async request(exchange): Promise<HttpResponse> {
      requests.push(exchange);
      const reply = script.replies[requests.length - 1] ?? { status: 200, contentType: "text/plain", body: "ok" };
      const bytes = Buffer.from(reply.body ?? "", "utf8");
      return { status: reply.status ?? 200, contentType: reply.contentType ?? "text/plain", ...(reply.location !== undefined ? { location: reply.location } : {}),
        async read(limit) { return bytes.subarray(0, limit); }, close() { state.closes += 1; } };
    },
  };
}

function stateWithDoh(dohEndpoint = ""): string {
  const state = mkdtempSync(join(tmpdir(), "network-runtime-"));
  mkdirSync(join(state, "network"), { recursive: true });
  writeFileSync(join(state, "network", "settings.json"), JSON.stringify({ dohEndpoint }));
  return state;
}

function toolEnv(state: string, signal?: AbortSignal, onNetworkActivity?: (event: NetworkActivityEvent) => void): ToolEnv {
  return { cwd: state, roots: [state], artifactsDir: state, tracker: undefined as never, ...(signal ? { signal } : {}), ...(onNetworkActivity ? { onNetworkActivity } as never : {}) };
}

function fetchTool(state: string, net: Net, options: { cache?: FetchCache; onActivity?: (event: NetworkActivityEvent) => void } = {}) {
  return networkTools({ stateDir: state, net, env: {}, ...options }).find((tool) => tool.name === "web_fetch")!;
}

const eventsFor = (result: any): string => String(result.data?.error_code ?? "ok");

describe("network fetch runtime", () => {
  it("rechecks and pins every redirect host and closes every response", async () => {
    const state = stateWithDoh();
    const net = scripted({ dns: { "start.example": ["8.8.8.8"], "next.example": ["1.1.1.1"] }, replies: [
      { status: 302, location: "https://next.example/final?from=redirect" }, { status: 200, contentType: "text/html", body: "<p>Done</p>" },
    ] });
    const activities: NetworkActivityEvent[] = [];
    const result = await fetchTool(state, net, { onActivity: (event) => activities.push(event) }).run({ url: "https://start.example/start" }, toolEnv(state));
    assert.equal(eventsFor(result), "ok");
    assert.deepEqual(net.lookups, ["start.example", "next.example"]);
    assert.deepEqual(net.requests.map((request) => [request.host, request.address, request.path]), [
      ["start.example", "8.8.8.8", "/start"], ["next.example", "1.1.1.1", "/final?from=redirect"],
    ]);
    assert.equal(net.closes, 2);
    assert.equal(result.data?.redirects, 1);
    assert.equal(result.data?.finalUrl, "https://next.example/final?from=redirect");
    assert.equal(result.data?.fullContent, "Done");
    assert.equal(result.data?.output, "Done");
    assert.deepEqual(activities.map(({ phase, redirects }) => [phase, redirects]), [["started", 0], ["redirected", 1], ["started", 1], ["completed", 1]]);
  });

  it("upgrades HTTP input and resolves relative redirects with queries", async () => {
    const state = stateWithDoh();
    const net = scripted({ replies: [{ status: 302, location: "../final?next=2" }, { body: "finished" }] });
    const result = await fetchTool(state, net).run({ url: "http://example.com/a/b?old=1" }, toolEnv(state));
    assert.deepEqual(net.requests.map(({ host, path }) => [host, path]), [["example.com", "/a/b?old=1"], ["example.com", "/final?next=2"]]);
    assert.equal(result.data?.url, "http://example.com/a/b?old=1");
    assert.equal(result.data?.finalUrl, "https://example.com/final?next=2");
    assert.equal(result.data?.fullContent, "finished");
  });

  it("blocks a private literal redirect after DNS validation", async () => {
    const state = stateWithDoh();
    const net = scripted({ dns: { "127.0.0.1": ["127.0.0.1"] }, replies: [{ status: 302, location: "https://127.0.0.1/private?x=1" }] });
    const result = await fetchTool(state, net).run({ url: "https://example.com/start" }, toolEnv(state));
    assert.equal(eventsFor(result), "ssrf_blocked");
    assert.deepEqual(net.lookups, ["example.com", "127.0.0.1"]);
    assert.equal(net.requests.length, 1);
    assert.equal(net.closes, 1);
  });

  it("refuses HTTPS downgrade redirects", async () => {
    const state = stateWithDoh();
    const net = scripted({ replies: [{ status: 302, location: "http://other.example/private" }] });
    const result = await fetchTool(state, net).run({ url: "https://example.com/start" }, toolEnv(state));
    assert.equal(eventsFor(result), "redirect_downgrade_blocked");
    assert.deepEqual(net.lookups, ["example.com"]);
    assert.equal(net.requests.length, 1);
    assert.equal(net.closes, 1);
  });

  it("reports redirect loops and the five-hop limit as bounded errors", async () => {
    const state = stateWithDoh();
    const loop = scripted({ replies: [{ status: 302, location: "/start" }] });
    const loopResult = await fetchTool(state, loop).run({ url: "https://example.com/start" }, toolEnv(state));
    assert.equal(eventsFor(loopResult), "redirect_loop");
    assert.equal(loop.closes, 1);
    const replies = Array.from({ length: 6 }, (_value, index) => ({ status: 302, location: `/hop-${index + 1}` }));
    const limit = scripted({ replies });
    const limitResult = await fetchTool(state, limit).run({ url: "https://example.com/hop-0" }, toolEnv(state));
    assert.equal(eventsFor(limitResult), "redirect_limit_exceeded");
    assert.equal(limit.requests.length, 6);
    assert.equal(limit.closes, 6);
  });

  it("cancels DNS between hops under the original request budget", async () => {
    const state = stateWithDoh();
    const controller = new AbortController();
    const net = scripted({ replies: [{ status: 302, location: "https://next.example/final" }], onLookup: async (host) => {
      if (host === "next.example") { setImmediate(() => controller.abort()); return new Promise<string[]>(() => {}); }
      return ["8.8.8.8"];
    } });
    const result = await fetchTool(state, net).run({ url: "https://example.com/start" }, toolEnv(state, controller.signal));
    assert.equal(eventsFor(result), "network_cancelled");
    assert.equal(net.requests.length, 1);
    assert.equal(net.closes, 1);
  });

  it("uses full content bytes in the existing cache and scopes entries to DoH settings", async () => {
    const state = stateWithDoh("https://dns-a.example/dns-query");
    const cache = new FetchCache();
    const net = scripted({ replies: [{ body: "x".repeat(20_000) }, { body: "y".repeat(20_000) }] });
    const tool = fetchTool(state, net, { cache });
    const first = await tool.run({ url: "https://example.com/page" }, toolEnv(state));
    assert.equal(String(first.data?.fullContent).length, 20_000);
    assert.ok(first.output.length < 20_000);
    assert.equal(first.output.includes('"fullContent"'), false);
    assert.equal(cache.bytes, Buffer.byteLength(String(first.data?.fullContent), "utf8"));
    const hitEvents: NetworkActivityEvent[] = [];
    await tool.run({ url: "https://example.com/page" }, toolEnv(state, undefined, (event) => hitEvents.push(event)));
    assert.equal(net.requests.length, 1);
    assert.equal(hitEvents[0]?.phase, "cache_hit");
    writeFileSync(join(state, "network", "settings.json"), JSON.stringify({ dohEndpoint: "https://dns-b.example/dns-query" }));
    await tool.run({ url: "https://example.com/page" }, toolEnv(state));
    assert.equal(net.requests.length, 2);
  });

  it("emits one privacy-safe request lifecycle and binds/releases the agent extension", async () => {
    const state = stateWithDoh();
    const net = scripted({ replies: [{ body: "secret-body" }] });
    const observed: NetworkActivityEvent[] = [], fallback: NetworkActivityEvent[] = [];
    const tool = fetchTool(state, net, { onActivity: (event) => fallback.push(event) });
    await tool.run({ url: "https://example.com/page?token=secret" }, toolEnv(state, undefined, (event) => observed.push(event)));
    assert.deepEqual(observed.map((event) => event.phase), ["started", "completed"]);
    assert.equal(fallback.length, 0);
    assert.equal(new Set(observed.map((event) => event.requestId)).size, 1);
    assert.ok(observed.every((event) => !JSON.stringify(event).includes("secret")));
    assert.ok(observed.every((event) => !Object.hasOwn(event, "headers") && !Object.hasOwn(event, "body")));
    const emitted: NetworkActivityEvent[] = [];
    const env: { onNetworkActivity?: (event: NetworkActivityEvent) => void } = {};
    const extension = networkActivityExtension(env);
    extension.beforeRun({ emit: (event) => emitted.push(event) });
    env.onNetworkActivity?.(observed[0]!);
    extension.close({ emit: () => {} });
    assert.equal(emitted.length, 1);
    assert.equal(env.onNetworkActivity, undefined);
    const ledgerError = new Error("activity ledger unavailable");
    const failedNet = scripted({ replies: [{ status: 302, location: "/next" }, { body: "ok" }] }), failedCache = new FetchCache();
    await assert.rejects(() => fetchTool(state, failedNet, { cache: failedCache }).run({ url: "https://example.com/fail" },
      toolEnv(state, undefined, (event) => { if (event.phase === "redirected") throw ledgerError; })), (error: unknown) => error === ledgerError);
    assert.equal(failedNet.requests.length, 1);
    assert.equal(failedNet.closes, 1);
    assert.equal(failedCache.size, 0);
  });

  it("keeps JSON POST redirects as ordinary errors without replaying the request", async () => {
    const net = scripted({ replies: [{ status: 307, location: "https://other.example/replay" }] });
    await assert.rejects(() => postJson(net, "https://example.com/search", { query: "q" }, {}, {}), (error: any) => error.code === "http_permanent");
    assert.equal(net.requests.length, 1);
    assert.equal(net.requests[0]?.method, "POST");
    assert.equal(net.closes, 1);
  });
});
