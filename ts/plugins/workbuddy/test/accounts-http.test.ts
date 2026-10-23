import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { createWorkbuddy } from "../src/api.ts";
import { Gateway } from "../src/gateway.ts";
import { workbuddyLayout } from "../src/layout.ts";

type Credentials = {
  account: { uid: string; nickname: string; enterpriseId: string };
  auth: { accessToken: string; refreshToken: string; domain: string; expiresAt: number };
};

type Fixture = { root: string; stateDir: string; assets: string; plugin: ReturnType<typeof createWorkbuddy>; setEnabled(value: boolean): void };
const fixtures: Fixture[] = [];
after(() => {
  for (const item of fixtures) {
    item.plugin.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "xueness-workbuddy-accounts-"));
  const stateDir = join(root, "state");
  const assets = join(root, "empty-assets");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(assets, { recursive: true });
  let enabled = true;
  const plugin = createWorkbuddy({ stateDir, assets, enabled: () => enabled, env: {} });
  const item = { root, stateDir, assets, plugin, setEnabled(value: boolean) { enabled = value; } };
  fixtures.push(item);
  return item;
}

function credentials(uid: string, nickname: string, accessToken: string, refreshToken: string): Credentials {
  return {
    account: { uid, nickname, enterpriseId: "fixture-tenant" },
    auth: { accessToken, refreshToken, domain: "fixture.invalid", expiresAt: 1_900_000_000 },
  };
}

async function call(plugin: ReturnType<typeof createWorkbuddy>, method: string, parts: string[], body: unknown = null) {
  return await plugin.http.dispatch(method, parts, {}, body);
}

function authFiles(stateDir: string): string[] {
  const dir = join(stateDir, "workbuddy", "auths");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
}

function snapshot(stateDir: string): string[] {
  return authFiles(stateDir).map((name) => createHash("sha256").update(readFileSync(join(stateDir, "workbuddy", "auths", name))).digest("hex"));
}

function assertNoCredentialFields(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /"auth"\s*:|accessToken|refreshToken/iu);
  for (const secret of ["synthetic-access-first", "synthetic-refresh-first", "synthetic-access-updated", "synthetic-refresh-updated", "gateway-secret-must-not-escape", "gateway-refresh-secret", "gateway-raw-json-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
}

it("imports, updates and deletes private accounts without returning credentials", async () => {
  const item = fixture();
  let ensureCalls = 0;
  item.plugin.gateway.ensure = async () => { ensureCalls += 1; };
  item.plugin.gateway.status = async () => ({
    token: "gateway-secret-must-not-escape",
    accounts: [{
      uid: "uid-a", nickname: "gateway nickname", credits: 25.5, cooling: true, until: "2030-01-01T00:00:00Z",
      disabled: true, last_success: "2029-01-01T00:00:00Z", last_err: "rejected synthetic-access-updated",
      in_flight: 2, breaker_fails: 3, breaker_until: "2030-01-02T00:00:00Z", refreshToken: "gateway-refresh-secret",
    }],
    raw: "{\"accessToken\":\"gateway-raw-json-secret\"}",
  });

  const invalid = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: { account: { uid: "uid-a" }, auth: {} } });
  assert.equal(invalid?.[0], 400);
  assert.deepEqual(authFiles(item.stateDir), []);

  const first = credentials("uid-a", "first nickname", "synthetic-access-first", "synthetic-refresh-first");
  const added = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: { ...first, extra: "not persisted" } });
  assert.equal(added?.[0], 200);
  const addedBody = added?.[1] as { ok: boolean; accounts: { id: string; uid: string; nickname: string }[]; gatewayAvailable: boolean };
  assertNoCredentialFields(addedBody);
  assert.equal(addedBody.ok, true);
  assert.equal(addedBody.gatewayAvailable, false);
  assert.equal(addedBody.accounts.length, 1);
  const accountId = addedBody.accounts[0]!.id;
  assert.match(accountId, /^[a-f0-9]{24}$/u);
  assert.equal(ensureCalls, 0, "account import must not start the gateway");

  const second = credentials("uid-a", "updated nickname", "synthetic-access-updated", "synthetic-refresh-updated");
  const updated = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: second });
  assert.equal(updated?.[0], 200);
  const updatedBody = updated?.[1] as { accounts: { id: string; nickname: string }[] };
  assertNoCredentialFields(updatedBody);
  assert.equal(updatedBody.accounts.length, 1);
  assert.equal(updatedBody.accounts[0]!.id, accountId, "same UID keeps the opaque filename ID");
  assert.equal(authFiles(item.stateDir).length, 1);
  const stored = JSON.parse(readFileSync(join(item.stateDir, "workbuddy", "auths", authFiles(item.stateDir)[0]!), "utf8"));
  assert.equal(stored.auth.accessToken, "synthetic-access-updated");
  assert.deepEqual(Object.keys(stored).sort(), ["account", "auth"]);

  const beforeInvalid = snapshot(item.stateDir);
  const rejected = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: { ...second, auth: { ...second.auth, refreshToken: "" } } });
  assert.equal(rejected?.[0], 400);
  assert.deepEqual(snapshot(item.stateDir), beforeInvalid, "invalid credentials must not alter stored files");

  const other = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: credentials("uid-b", "second", "synthetic-access-b", "synthetic-refresh-b") });
  assert.equal(other?.[0], 200);
  assert.equal(authFiles(item.stateDir).length, 2);

  const listed = await call(item.plugin, "GET", ["api", "workbuddy", "accounts"]);
  assert.equal(listed?.[0], 200);
  const listBody = listed?.[1] as { ok: boolean; gatewayAvailable: boolean; accounts: Record<string, unknown>[] };
  assert.equal(listBody.gatewayAvailable, true);
  const merged = listBody.accounts.find((account) => account.uid === "uid-a")!;
  assert.deepEqual(merged, {
    id: accountId, uid: "uid-a", nickname: "gateway nickname", credits: 25.5, cooling: true, disabled: true,
    inFlight: 2, lastSuccess: "2029-01-01T00:00:00Z", lastError: "rejected [redacted]", cooldownUntil: "2030-01-01T00:00:00Z",
  });
  assertNoCredentialFields(listBody);

  const removed = await call(item.plugin, "DELETE", ["api", "workbuddy", "accounts", accountId]);
  assert.equal(removed?.[0], 200);
  const removedBody = removed?.[1] as { accounts: { uid: string }[] };
  assertNoCredentialFields(removedBody);
  assert.deepEqual(removedBody.accounts.map((account) => account.uid), ["uid-b"]);
  assert.equal(authFiles(item.stateDir).length, 1, "delete removes only the matching account file");
  assert.equal((await call(item.plugin, "DELETE", ["api", "workbuddy", "accounts", accountId]))?.[0], 404);
});

it("rejects all account routes while disabled without changing account files", async () => {
  const item = fixture();
  const added = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: credentials("uid-disabled", "disabled", "synthetic-disabled-access", "synthetic-disabled-refresh") });
  assert.equal(added?.[0], 200);
  const accountId = ((added?.[1] as { accounts: { id: string }[] }).accounts[0]!).id;
  const before = snapshot(item.stateDir);
  item.setEnabled(false);
  assert.equal((await call(item.plugin, "GET", ["api", "workbuddy", "accounts"]))?.[0], 403);
  assert.equal((await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: credentials("uid-new", "new", "a", "b") }))?.[0], 403);
  assert.equal((await call(item.plugin, "DELETE", ["api", "workbuddy", "accounts", accountId]))?.[0], 403);
  assert.equal((await call(item.plugin, "GET", ["api", "workbuddy", "status"]))?.[0], 403);
  assert.deepEqual(snapshot(item.stateDir), before);
});

it("keeps locally stored accounts visible offline and never starts an empty pool", async () => {
  const item = fixture();
  const empty = await call(item.plugin, "GET", ["api", "workbuddy", "accounts"]);
  assert.equal(empty?.[0], 200);
  assert.deepEqual(empty?.[1], { ok: true, accounts: [], gatewayAvailable: false });
  assert.equal(existsSync(join(item.stateDir, "workbuddy", "config.json")), false);

  const added = await call(item.plugin, "POST", ["api", "workbuddy", "accounts"], { credentials: credentials("uid-offline", "offline account", "synthetic-offline-access", "synthetic-offline-refresh") });
  assert.equal(added?.[0], 200);
  assert.equal(existsSync(join(item.stateDir, "workbuddy", "config.json")), false, "import stores credentials without starting the gateway");

  const offline = await call(item.plugin, "GET", ["api", "workbuddy", "accounts"]);
  assert.equal(offline?.[0], 200);
  const body = offline?.[1] as { gatewayAvailable: boolean; accounts: Record<string, unknown>[] };
  assert.equal(body.gatewayAvailable, false);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0]!.uid, "uid-offline");
  assert.equal(body.accounts[0]!.credits, null);
  assert.equal(body.accounts[0]!.lastSuccess, null);
  assert.equal(body.accounts[0]!.lastError, null);
  assert.equal(body.accounts[0]!.cooldownUntil, null);
  assert.equal(existsSync(join(item.stateDir, "workbuddy", "config.json")), false, "missing gateway binary leaves the account offline");
});

it("reloads only an owned gateway child and leaves an empty pool stopped", async () => {
  const item = fixture();
  const gateway = new Gateway(workbuddyLayout(item.stateDir, {}, item.assets));
  let running = true;
  let stops = 0;
  let starts = 0;
  Object.defineProperty(gateway, "running", { configurable: true, get: () => running });
  gateway.stop = async () => { stops += 1; running = false; };
  gateway.ensure = async () => { starts += 1; running = true; };

  await gateway.reloadOwned(true);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  await gateway.reloadOwned(false);
  assert.equal(stops, 2);
  assert.equal(starts, 1, "deleting the final account does not restart the pool");
  await gateway.reloadOwned(true);
  assert.equal(stops, 2, "external or already-stopped processes are left alone");
  assert.equal(starts, 1);
});
