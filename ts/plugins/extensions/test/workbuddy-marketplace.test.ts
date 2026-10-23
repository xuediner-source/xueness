import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { catalogItems, setPluginEnabled, type PluginCatalogOptions } from "../src/catalog.ts";
import { installPackage, marketplaceCatalog } from "../src/marketplace.ts";
import { loadManifests } from "../src/sdk.ts";

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

  const listing = marketplaceCatalog(stateDir, { env: { ...process.env, XUENESS_MARKETPLACE_URL: "" } });
  const offered = listing.find((item) => item.id === "xueness-workbuddy")!;
  assert.equal(offered.source, "bundled");
  assert.match(String(offered.sha256), /^[a-f0-9]{64}$/u);
  installPackage(stateDir, offered.id as string, offered.sha256, false, { env: { ...process.env, XUENESS_MARKETPLACE_URL: "" } });
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
