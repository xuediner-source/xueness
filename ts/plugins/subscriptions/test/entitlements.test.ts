/** F13.03: real HTTP entitlement adapters — connectivity, sanitization, error mapping, honest catalog, real ticket path. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { NativeProvider, SubscriptionBroker } from "../src/index.ts";
import {
  ENTITLEMENT_ENDPOINTS, ENTITLEMENT_PATHS, EntitlementClient, EntitlementTickets, entitlementEndpoint, pendingExternalConditions,
  publicEntitlementAccount, publicEntitlementQuota, publicEntitlementSubscription,
} from "../src/entitlements.ts";

const FAKE_WORKER = `
import { createInterface } from "node:readline";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, action, data } = JSON.parse(line);
  if (action === "abort") continue;
  if (action === "generate") out({ id, result: { content: "ok", tool_calls: [], echo: data } });
}
`;

/** The bearer token selects the behaviour, so every failure mode is a real round trip. */
function startEntitlementService(counters: { issued: number }): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const token = String(request.headers.authorization ?? "");
    if (token === "Bearer err418") return void reply(418, { error: "teapot" });
    if (token === "Bearer badjson") return void reply(200, "{not json");
    if (token === "Bearer hang") return void response.setTimeout(0, () => {});
    if (token !== "Bearer tok") return void reply(401, { error: "unauthorized" });
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const payload = body.length ? (JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, unknown>) : {};
      if (request.method === "GET" && request.url === ENTITLEMENT_PATHS.account) {
        return void reply(200, { account: "u@example.org", plan: "pro", region: "eu", verified: true, password: "nope", deep: { evil: 1 } });
      }
      if (request.method === "GET" && request.url === ENTITLEMENT_PATHS.subscription) {
        return void reply(200, { status: "active", plan: "pro", renewsAt: 1893456000000, seats: 3, statusWeird: "x" });
      }
      if (request.method === "GET" && request.url === ENTITLEMENT_PATHS.quota) {
        return void reply(200, { supported: true, plan: "team", checkedAt: 1690000000000, windows: [
          { kind: "daily", usedPercent: 41.5, limit: 100, remaining: 59, resetsAt: 1893456000000, scope: "account", unit: "requests" },
          { kind: "bogus", usedPercent: "x" },
        ] });
      }
      if (request.method === "POST" && request.url === ENTITLEMENT_PATHS.ticket) {
        counters.issued += 1;
        return void reply(200, { ticket: `tkt-${counters.issued}`, expiresAt: Date.now() + 40_000, scope: payload.scope, extra: true });
      }
      reply(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("entitlement service adapters", () => {
  const base = mkdtempSync(join(tmpdir(), "entitlements-"));
  const counters = { issued: 0 };
  let url = "";
  let server: Server;
  let closedPort = 0;

  before(async () => {
    ({ server, url } = await startEntitlementService(counters));
    const throwaway = await startEntitlementService({ issued: 0 });
    closedPort = (throwaway.server.address() as { port: number }).port;
    throwaway.server.close();
    throwaway.server.closeAllConnections();
  });

  after(() => {
    server.close();
    server.closeAllConnections();
    rmSync(base, { recursive: true, force: true });
  });

  it("talks real HTTP to a service implementing the public contract", async () => {
    const client = new EntitlementClient({ base: url, token: "tok" });
    const account = await client.account();
    assert.equal(account.account, "u@example.org");
    assert.equal(account.plan, "pro");
    assert.equal(account.verified, true);
    const subscription = await client.subscription();
    assert.equal(subscription.status, "active");
    assert.equal(subscription.seats, 3);
    assert.equal(subscription.renewsAt, 1893456000000);
    const quota = await client.quota();
    assert.equal(quota.supported, true);
    const ticket = await client.ticket("generate:qoder");
    assert.equal(ticket.ticket, "tkt-1");
    assert.equal(ticket.scope, "generate:qoder");
    assert.ok(ticket.expiresAt !== null && ticket.expiresAt > Date.now());
    assert.equal(new EntitlementClient({ base: url + "/", token: "tok" }).base, url); // trailing slash normalized
  });

  it("maps upstream failures onto the shared request categories", async () => {
    // Thunks, not eager promises: bun flags a rejection without an immediate
    // handler as unhandled and tears the test down.
    const cases: [() => Promise<unknown>, string, number | null][] = [
      [() => new EntitlementClient({ base: url, token: "wrong" }).account(), "authentication_failed", 401],
      [() => new EntitlementClient({ base: url, token: "err418" }).account(), "request_rejected", 418],
      [() => new EntitlementClient({ base: url, token: "badjson" }).account(), "invalid_response", null],
      [() => new EntitlementClient({ base: `http://127.0.0.1:${closedPort}`, token: "tok" }).account(), "connection_failed", null],
    ];
    for (const [attempt, category, status] of cases) {
      await assert.rejects(attempt(), (error: unknown) => {
        assert.equal((error as { category: string }).category, category);
        assert.equal((error as { status: number | null }).status, status);
        return true;
      });
    }
    await assert.rejects(() => new EntitlementClient({ base: url, token: "hang", timeoutMs: 80 }).account(), (error: unknown) =>
      (error as { category: string }).category === "timeout");
    const client = new EntitlementClient({ base: url, token: "tok" });
    await assert.rejects(client.ticket(""), PyValueError);
    await assert.rejects(client.ticket("x".repeat(200)), PyValueError);
    assert.throws(() => new EntitlementClient({ base: "ftp://x", token: "t" }), /entitlement base URL/);
    assert.throws(() => new EntitlementClient({ base: "http://x", token: " " }), /entitlement token/);
  });

  it("sanitizes every public row: whitelists, bounds and drops hostile values", () => {
    const account = publicEntitlementAccount({ account: "a".repeat(500), plan: "p", region: "r", verified: true, evil: "x" });
    assert.deepEqual(Object.keys(account!).sort(), ["account", "plan", "region", "verified"]);
    assert.equal((account!.account as string).length, 160);
    assert.equal(publicEntitlementAccount("nope"), null);
    assert.equal(publicEntitlementAccount({ account: "   " }), null);
    const subscription = publicEntitlementSubscription({ status: "active", plan: "p", renewsAt: 5, startedAt: 5, weird: 1 });
    assert.equal(subscription!.status, "active");
    assert.equal(subscription!.startedAt, 5);
    assert.equal(publicEntitlementSubscription({ status: "weird", expiresAt: -1 }), null); // nothing survives sanitizing
    assert.equal(publicEntitlementSubscription({}), null);
    assert.equal(publicEntitlementSubscription([]), null);
    const quota = publicEntitlementQuota({ supported: true, checkedAt: 1, plan: "p", windows: [{ kind: "daily", usedPercent: 10, limit: 100 }, { kind: "bogus", usedPercent: "x" }] });
    assert.equal(quota!.supported, true);
    assert.equal((quota!.windows as unknown[]).length, 1);
    assert.equal(publicEntitlementQuota(7), null);
  });

  it("caches tickets per scope until shortly before expiry and shares concurrent calls", async () => {
    let clock = 1000;
    let acquired = 0;
    const tickets = new EntitlementTickets(() => clock);
    const acquire = async (scope: string) => { acquired += 1; return { ticket: `t-${acquired}`, scope, expiresAt: clock + 40_000 }; };
    const first = await tickets.get("generate:qoder", acquire);
    const [a, b] = await Promise.all([tickets.get("generate:qoder", acquire), tickets.get("generate:qoder", acquire)]);
    assert.equal(acquired, 1);
    assert.equal(first.ticket, "t-1");
    assert.equal(a.ticket, "t-1");
    assert.equal(b.ticket, "t-1");
    clock += 11_000; // expiry at 41000, skew 30000 → unusable once now passes 11000
    assert.equal((await tickets.get("generate:qoder", acquire)).ticket, "t-2");
    assert.equal(acquired, 2);
    tickets.clear();
    assert.equal((await tickets.get("generate:qoder", acquire)).ticket, "t-3");
    let forever = 0;
    const sticky = async (scope: string) => { forever += 1; return { ticket: `f-${forever}`, scope, expiresAt: null }; };
    const noExpiry = new EntitlementTickets(() => clock);
    await noExpiry.get("s", sticky);
    clock += 10 ** 9;
    assert.equal((await noExpiry.get("s", sticky)).ticket, "f-1"); // no expiry → stays cached
  });

  it("lists private vendor interfaces as pending, never as aligned", () => {
    assert.equal(ENTITLEMENT_ENDPOINTS.filter((endpoint) => endpoint.status === "public").length, 1);
    assert.ok(entitlementEndpoint("user-entitlement"));
    for (const pending of ["codex", "claude", "qwen", "commandcode", "qoder"]) assert.equal(entitlementEndpoint(pending), null);
    const rows = pendingExternalConditions();
    assert.ok(rows.length >= 5);
    for (const row of rows) {
      assert.equal(row.status, "pending");
      assert.ok(String(row.reason).length > 0);
      assert.ok(String(row.reasonEn).length > 0);
    }
    assert.equal(rows.some((row) => row.id === "user-entitlement"), false);
  });

  it("runs the real ticket path through the provider into the worker generate call", async () => {
    const script = join(base, "echo-worker.mjs");
    writeFileSync(script, FAKE_WORKER);
    let available = true;
    const requireAvailable = (): void => { if (!available) throw new Error("plugin disabled or dependency unavailable: subscriptions"); };
    const broker = new SubscriptionBroker(join(base, "state"), requireAvailable, { PATH: process.env.PATH }, script);
    const provider = new NativeProvider(broker, requireAvailable, {
      subscriptionId: "qoder", model: "m1", baseUrl: "http://127.0.0.1:1/v1", capabilities: [], reasoningLevels: [],
      entitlement: { base: url, token: "tok" },
    });
    const issuedBefore = counters.issued;
    const first = await provider.complete([{ role: "user", content: "hi" }], []);
    assert.equal(first.content, "ok");
    const seen = (first.echo as { ticket?: string }).ticket;
    assert.match(String(seen), /^tkt-\d+$/);
    const second = await provider.complete([{ role: "user", content: "again" }], []);
    assert.equal((second.echo as { ticket?: string }).ticket, seen); // cached until expiry
    assert.equal(counters.issued, issuedBefore + 1); // exactly one real ticket issued for both calls
    const plain = new NativeProvider(broker, requireAvailable, { subscriptionId: "qoder", model: "m2", baseUrl: "http://127.0.0.1:1/v1", capabilities: [], reasoningLevels: [] });
    const bare = await plain.complete([{ role: "user", content: "hi" }], []);
    assert.equal(Object.hasOwn(bare.echo as object, "ticket"), false); // no configured service → no ticket, still runs
    available = false;
    await assert.rejects(provider.complete([{ role: "user", content: "hi" }], []), /subscriptions/);
    await broker.shutdown();
  });
});

describe("cross-scope ticket caching (F13.03 review)", () => {
  it("never hands one scope's in-flight ticket to another scope", async () => {
    const tickets = new EntitlementTickets(() => 0);
    const issued: string[] = [];
    const acquire = (scope: string) => async (): Promise<{ ticket: string; scope: string; expiresAt: number | null }> => {
      issued.push(scope);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ticket: `t-${scope}`, scope, expiresAt: null };
    };
    const [first, second] = await Promise.all([
      tickets.get("generate:a", acquire("generate:a")),
      tickets.get("generate:b", acquire("generate:b")),
    ]);
    assert.deepEqual([first.ticket, first.scope], ["t-generate:a", "generate:a"]);
    assert.deepEqual([second.ticket, second.scope], ["t-generate:b", "generate:b"]);
    assert.equal(issued.length, 2);
  });
});
