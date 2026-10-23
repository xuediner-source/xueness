import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUNDLED_PLUGIN_IDS, catalogIssues, dependencyOrder, HttpFamilyIndex, upgradeManifestV1, validateManifest, type HttpFamilyManifest, type PluginManifest, type ToolFacts,
} from "../src/index.ts";
import { PROJECT_ROOT, pythonToolFacts, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";

const v1Manifests = (): Array<Record<string, unknown>> => BUNDLED_PLUGIN_IDS.map((id) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "catalog", `${id}.json`), "utf8")));

function upgradeAll(facts: Record<string, ToolFacts> = {}): { manifests: PluginManifest[]; assumed: string[] } {
  const manifests: PluginManifest[] = [];
  const assumed: string[] = [];
  for (const v1 of v1Manifests()) {
    const upgraded = upgradeManifestV1(v1, facts);
    assert.deepEqual(upgraded.issues, [], String(v1.id));
    const result = validateManifest(upgraded.document);
    assert.deepEqual(result.issues, [], String(v1.id));
    manifests.push(result.manifest as PluginManifest);
    assumed.push(...upgraded.assumed);
  }
  return { manifests, assumed };
}

describe("version 1 manifests", () => {
  it("upgrade every bundled manifest to a valid version 2 manifest without losing a field", () => {
    const { manifests } = upgradeAll();
    assert.equal(manifests.length, 31);
    v1Manifests().forEach((v1, index) => {
      const v2 = manifests[index] as PluginManifest & Record<string, unknown>;
      for (const [key, value] of Object.entries(v1)) {
        if (key === "apiVersion" || key === "capabilities" || key === "tools") continue;
        if (key === "toolEvents") {
          const events = value as { events: string[]; priority?: number };
          assert.deepEqual(v2.toolEvents, { events: events.events, priority: events.priority ?? 0 });
        } else assert.deepEqual(v2[key], value, `${String(v1.id)}.${key}`);
      }
      assert.deepEqual(v2.tools.map((tool) => tool.name), v1.tools);
    });
    const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    assert.deepEqual(byId.get("mcp")?.capabilities, { fs: { read: [], write: [] }, net: { connect: ["*"], listen: [] }, exec: ["*"], secrets: [] });
    assert.deepEqual(byId.get("files")?.capabilities.fs, { read: ["workspace"], write: ["workspace"] });
    assert.deepEqual(byId.get("sessions")?.capabilities.exec, []);
  });

  it("form a consistent catalog: one owner per contribution, known dependencies, no cycles", () => {
    const { manifests } = upgradeAll();
    assert.deepEqual(catalogIssues(manifests), []);
    // Route ownership is unchanged: the same families map to the same plugins.
    assert.deepEqual(new HttpFamilyIndex(manifests).families(), new HttpFamilyIndex(v1Manifests() as unknown as HttpFamilyManifest[]).families());
    const { order, cyclic } = dependencyOrder(manifests);
    assert.deepEqual(cyclic, []);
    assert.equal(order.length, 31);
    for (const manifest of manifests) {
      for (const dep of manifest.dependencies) assert.ok(order.indexOf(dep) < order.indexOf(manifest.id), `${dep} before ${manifest.id}`);
    }
  });

  it("refuses what version 1 never had and guards tools without facts", () => {
    assert.deepEqual(upgradeManifestV1({ apiVersion: 2, capabilities: ["gpu"], tools: [1] }).issues.map((issue) => issue.path), ["/apiVersion", "/capabilities/0", "/tools"]);
    const { document, assumed } = upgradeManifestV1({ apiVersion: 1, capabilities: [], tools: ["mystery"] });
    assert.deepEqual(assumed, ["mystery"]);
    assert.deepEqual((document as { tools: unknown }).tools, [{ name: "mystery", gate: "unknown", mutating: true, concurrencySafe: false }]);
  });

  it("takes Gate kinds and flags from the Python tool registry", { skip: pythonUnavailableReason() ?? false }, () => {
    const facts: Record<string, ToolFacts> = pythonToolFacts();
    const { manifests, assumed } = upgradeAll(facts);
    // These three are defined by the Python core itself, not by a plugin's tools().
    assert.deepEqual(assumed.sort(), ["mcp__*", "skill_read", "task"]);
    const tools = new Map(manifests.flatMap((manifest) => manifest.tools.map((tool) => [tool.name, tool] as const)));
    assert.deepEqual(tools.get("read"), { name: "read", gate: "read", mutating: false, concurrencySafe: true });
    assert.deepEqual(tools.get("exec"), { name: "exec", gate: "exec", mutating: true, concurrencySafe: false });
    assert.deepEqual(tools.get("delivery_plan"), { name: "delivery_plan", gate: "todo_write", mutating: false, concurrencySafe: false });
    assert.equal(Object.keys(facts).length + assumed.length, tools.size);
  });
});
