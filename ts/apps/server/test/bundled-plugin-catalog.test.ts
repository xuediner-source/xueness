import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUNDLED_PLUGIN_IDS } from "@xueness/contracts";
import { catalogItems, setPluginEnabled } from "@xueness/plugin-extensions";
import { CATALOG_DIR, loadCatalogManifests } from "../src/manifests.ts";

test("the served catalog includes every shipped bundled plugin", () => {
  const shipped = readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
  assert.deepEqual([...BUNDLED_PLUGIN_IDS].sort(), shipped);
  assert.deepEqual([...loadCatalogManifests().keys()].sort(), shipped);
});

test("every bundled catalog row declares features for the desktop smoke report", () => {
  for (const [id, row] of loadCatalogManifests()) {
    const features = row.features;
    assert.ok(Array.isArray(features), `${id}: catalog row must declare features`);
    assert.ok(features.length > 0, `${id}: features must not be empty`);
    for (const feature of features as Record<string, unknown>[]) {
      assert.equal(typeof feature.id, "string", `${id}: feature id must be a string`);
      assert.equal(typeof feature.name, "string", `${id}: ${String(feature.id)} must have a name`);
      assert.equal(typeof feature.nameEn, "string", `${id}: ${String(feature.id)} must have a nameEn`);
    }
  }
});

test("initial adapters are effective without marketplace markers while optional integrations stay off", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "xueness-initial-plugins-"));
  try {
    const options = { stateDir, manifests: loadCatalogManifests, ui: new Map(), ownedSegments: new Set<string>() };
    const rows = catalogItems(options);
    for (const id of ["native_ops", "batch_calls"]) {
      const row = rows.find((item) => item.id === id)!;
      assert.ok(row, id);
      assert.equal(row.installed, true);
      assert.equal(row.enabled, true);
      assert.equal(row.effective, true);
      assert.equal(row.installPackage, undefined);
    }
    for (const id of ["workbuddy", "subscriptions", "model_monitor"]) {
      const row = rows.find((item) => item.id === id)!;
      assert.equal(row.installed, false);
      assert.equal(row.enabled, false);
      assert.equal(row.effective, false);
    }
    const disabled = await setPluginEnabled(options, "native_ops", false);
    assert.equal(disabled.find((row) => row.id === "native_ops")?.effective, false);
    assert.equal(disabled.find((row) => row.id === "batch_calls")?.effective, true);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
