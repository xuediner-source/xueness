import { installOptionalFixture } from "../../../test-support/optional-artifacts.ts";
import { loadOptionalModule, optionalArtifact, optionalInstalled, optionalRoot } from "@xueness/kernel";
import { createExtensionsHttp } from "../src/index.ts";
import { artifactBytes } from "../../../test-support/optional-artifacts.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { catalogItems, setPluginEnabled, type PluginCatalogOptions } from "../src/catalog.ts";
import { installPackage, marketplaceCatalog } from "../src/marketplace.ts";
import { installAll, loadManifests } from "../src/sdk.ts";

const stateDir = mkdtempSync(join(tmpdir(), "xueness-workbuddy-marketplace-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

const metadata = new Map<string, Record<string, unknown>>([
  ["providers", { id: "providers", name: "Providers" }],
  ["workbuddy", { id: "workbuddy", name: "WorkBuddy" }],
  ["subscriptions", { id: "subscriptions", name: "Subscriptions" }],
  ["model_monitor", { id: "model_monitor", name: "Model monitor" }],
]);
const options: PluginCatalogOptions = {
  stateDir,
  manifests: () => metadata,
  ui: new Map(),
  ownedSegments: new Set(),
};
const optionalIds = ["workbuddy", "subscriptions", "model_monitor"];
const rows = () => catalogItems(options);
const row = (id: string) => rows().find((item) => item.id === id)!;

it("keeps WorkBuddy optional until marketplace install and explicit enable", async () => {
  for (const id of optionalIds) {
    assert.equal(row(id).installed, false, `${id} starts uninstalled`);
    assert.equal(row(id).enabled, false, `${id} starts disabled`);
    assert.equal(row(id).effective, false, `${id} starts ineffective`);
  }

  installAll(stateDir, [{ id: "xueness-workbuddy", version: "1.0.0", apiVersion: 1, builtin: "workbuddy", capabilities: [], enabled: false }]);
  assert.equal(row("workbuddy").installed, false, "legacy markers cannot activate missing code");
  await assert.rejects(setPluginEnabled(options, "workbuddy", true), /install/i);
  assert.throws(() => loadOptionalModule(stateDir, "workbuddy"), /Download/);

  const listing = marketplaceCatalog(stateDir, { env: { ...process.env, XUENESS_MARKETPLACE_URL: "" } });
  const offered = listing.find((item) => item.id === "xueness-workbuddy")!;
  assert.equal(offered.source, "GitHub");
  assert.equal(listing.length, 3);
  assert.equal(offered.delivery, "official");
  assert.match(String(offered.sha256), /^[a-f0-9]{64}$/u);
  const api = createExtensionsHttp({ stateDir, enabled: true, env: {}, downloadArtifact: async artifact => artifactBytes(artifact) });
  const result = await api.dispatch("POST", ["api", "plugins", "marketplace", "xueness-workbuddy", "install"], {}, { sha256: offered.sha256 });
  assert.equal(result?.[0], 200, JSON.stringify(result));
  assert.equal(optionalInstalled(stateDir, "workbuddy"), true);
  assert.equal(typeof (loadOptionalModule(stateDir, "workbuddy") as Record<string, unknown>).createWorkbuddy, "function");
  assert.equal(loadManifests(stateDir).find((item) => item.id === "xueness-workbuddy")?.enabled, false);
  assert.equal(row("workbuddy").installed, true);
  assert.equal(row("workbuddy").enabled, false);
  assert.equal(row("workbuddy").effective, false);

  const enabled = await setPluginEnabled(options, "workbuddy", true);
  const active = enabled.find((item) => item.id === "workbuddy")!;
  assert.equal(active.enabled, true);
  assert.equal(active.effective, true);

  const disabled = await setPluginEnabled(options, "workbuddy", false);
  const inactive = disabled.find((item) => item.id === "workbuddy")!;
  assert.equal(inactive.enabled, false);
  assert.equal(inactive.effective, false);
  for (const id of optionalIds.slice(1)) {
    const item = disabled.find((entry) => entry.id === id)!;
    assert.equal(item.installed, false, `${id} remains uninstalled`);
    assert.equal(item.enabled, false, `${id} remains disabled`);
    assert.equal(item.effective, false, `${id} remains ineffective`);
  }
});


it("loads verified payloads and refuses modified code before module evaluation", () => {
  for (const id of ["subscriptions", "model_monitor"]) {
    installOptionalFixture(stateDir, id);
    assert.equal(optionalInstalled(stateDir, id), true);
    const module = loadOptionalModule(stateDir, id) as Record<string, unknown>;
    assert.equal(typeof module[id === "subscriptions" ? "createSubscriptions" : "createModelMonitorHttp"], "function");
    const path = join(optionalRoot(stateDir, optionalArtifact(id)!), "backend/src/index.ts"), original = readFileSync(path);
    const damaged = Buffer.from(original); damaged[0] = damaged[0]! ^ 1; writeFileSync(path, damaged);
    assert.equal(optionalInstalled(stateDir, id), false);
    assert.throws(() => loadOptionalModule(stateDir, id), /Download/);
    writeFileSync(path, original); assert.equal(optionalInstalled(stateDir, id), true);
  }
});

it("rejects changed catalogs and damaged downloads before writing any plugin state", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "xueness-official-failure-"));
  try {
    let calls = 0;
    const artifact = optionalArtifact("model_monitor")!;
    const api = createExtensionsHttp({ stateDir: temporary, enabled: true, env: {}, downloadArtifact: async () => { calls++; return Buffer.from("damaged"); } });
    const path = ["api", "plugins", "marketplace", artifact.packageId, "install"];
    assert.equal((await api.dispatch("POST", path, {}, { sha256: "0".repeat(64) }))?.[0], 400);
    assert.equal(calls, 0);
    assert.equal((await api.dispatch("POST", path, {}, { sha256: artifact.sha256 }))?.[0], 400);
    assert.equal(calls, 1);
    assert.equal(optionalInstalled(temporary, artifact.id), false);
    assert.equal(loadManifests(temporary).length, 0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
