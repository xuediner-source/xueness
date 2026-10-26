/** F13.03: entitlement service configuration — private persistence, validation and the accounts HTTP action. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { createAccountsHttp, SubscriptionBroker } from "../src/index.ts";
import { clearEntitlementConfig, configurableEndpoint, entitlementClient, entitlementConfig, entitlementSeam, publicEntitlementConfigs, saveEntitlementConfig } from "../src/entitlement-config.ts";

describe("entitlement service configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "entitlement-config-"));
  const stateDir = join(root, "state");
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("stores the service privately and reduces it to hasToken in public rows", () => {
    assert.equal(entitlementConfig(stateDir, "qoder"), null);
    const saved = saveEntitlementConfig(stateDir, "qoder", "https://ent.example.internal/v1///", "  user-token  ", 12345);
    assert.deepEqual(saved, { base: "https://ent.example.internal/v1", token: "user-token", savedAt: 12345 });
    assert.deepEqual(entitlementConfig(stateDir, "qoder"), saved);
    assert.deepEqual(entitlementSeam(stateDir, "qoder"), { base: saved.base, token: saved.token });
    assert.ok(entitlementClient(stateDir, "qoder"));
    assert.equal(entitlementClient(stateDir, "codex"), null); // nothing configured

    const path = join(stateDir, "subscriptions", "entitlements.json");
    assert.ok(existsSync(path));
    const stored = JSON.parse(readFileSync(path, "utf8")) as { qoder?: { token?: string } };
    assert.equal(stored.qoder!.token, "user-token"); // token persisted in the private store

    const rows = publicEntitlementConfigs(stateDir, true);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ["base", "hasToken", "providerId", "savedAt", "status"]);
    assert.equal(rows[0]!.hasToken, true);
    assert.deepEqual(publicEntitlementConfigs(stateDir, false), []); // plugin unavailable → nothing leaks

    assert.equal(clearEntitlementConfig(stateDir, "qoder"), true);
    assert.equal(clearEntitlementConfig(stateDir, "qoder"), false);
    assert.equal(entitlementConfig(stateDir, "qoder"), null);
    assert.deepEqual(publicEntitlementConfigs(stateDir, true), []);
  });

  it("validates provider ids, base URLs and tokens", () => {
    assert.throws(() => saveEntitlementConfig(stateDir, "not-a-vendor", "https://x", "t"), PyValueError);
    assert.throws(() => saveEntitlementConfig(stateDir, "qoder", "ftp://x", "t"), /http/);
    assert.throws(() => saveEntitlementConfig(stateDir, "qoder", "", "t"), /http/);
    assert.throws(() => saveEntitlementConfig(stateDir, "qoder", "https://x", " "), /token/);
    assert.throws(() => saveEntitlementConfig(stateDir, "qoder", "https://x", "t".repeat(5000)), /token/);
    assert.throws(() => saveEntitlementConfig(stateDir, "qoder", "https://" + "x".repeat(2100), "t"), /base URL/);
    assert.throws(() => clearEntitlementConfig(stateDir, "not-a-vendor"), PyValueError);
  });

  it("exposes only the public contract endpoint as configurable", () => {
    assert.equal(configurableEndpoint("user-entitlement")!.status, "public");
    assert.equal(configurableEndpoint("qoder"), null);
    assert.equal(configurableEndpoint("codex"), null);
  });

  it("saves and removes entitlement services through the accounts HTTP surface", async () => {
    const broker = new SubscriptionBroker(stateDir, () => {}, { PATH: process.env.PATH });
    const http = createAccountsHttp({ stateDir, enabled: () => true, requireAvailable: () => {}, broker });
    const get = async (): Promise<unknown> => (await http.dispatch("GET", ["api", "subscriptions"], {}, {}))![1];
    const before = await get() as { entitlements: unknown[]; pendingInterfaces: { id: string }[] };
    assert.equal(before.entitlements.length, 0);
    assert.ok(before.pendingInterfaces.length >= 5); // honest pending list is always visible

    const saved = await http.dispatch("POST", ["api", "subscriptions", "qoder", "entitlement"], {}, { base: "https://ent.example.internal/v1", token: "tok" });
    assert.equal(saved![0], 200);
    const after = await get() as { entitlements: { providerId: string; hasToken: boolean; status: string }[] };
    assert.deepEqual(after.entitlements.map(({ providerId, hasToken, status }) => ({ providerId, hasToken, status })), [{ providerId: "qoder", hasToken: true, status: "public" }]);

    assert.equal((await http.dispatch("POST", ["api", "subscriptions", "qoder", "entitlement"], {}, { base: "ftp://x", token: "t" }))![0], 400);
    assert.equal((await http.dispatch("POST", ["api", "subscriptions", "nope", "entitlement"], {}, { base: "https://x", token: "t" }))![0], 404);

    const removed = await http.dispatch("POST", ["api", "subscriptions", "qoder", "entitlement"], {}, { base: "https://ent.example.internal/v1" });
    assert.equal(removed![0], 200);
    assert.equal(((removed![1] as { result: { removed: boolean } }).result).removed, true);
    assert.equal(((await get()) as { entitlements: unknown[] }).entitlements.length, 0);
    await broker.shutdown();
  });
});
