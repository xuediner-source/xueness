import { installOptionalFixture } from "../../../test-support/optional-artifacts.ts";
/** F07.05: component package format, alwaysLoad, install/upgrade/uninstall, ownership panel. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { catalogItems, type PluginCatalogOptions } from "../src/catalog.ts";
import {
  componentOwner, componentOwners, componentSummary, componentsDigest, effectiveComponents, uninstallPackage,
} from "../src/components.ts";
import { dispatchMarketplace, installPackage, marketplaceCatalog } from "../src/marketplace.ts";
import { installAll, loadManifests } from "../src/sdk.ts";
import { validateInline } from "../src/validate.ts";

type Report = { ok?: unknown; kind?: unknown; items?: unknown };
const firstErrors = (report: Report): Array<{ message: string }> => (report.items as Array<{ errors: Array<{ message: string }> }>)[0]!.errors;

const stateDir = mkdtempSync(join(tmpdir(), "xueness-components-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

const quietEnv = { env: { ...process.env, XUENESS_MARKETPLACE_URL: "" } as NodeJS.ProcessEnv };

const greeter = {
  id: "xueness-example-greeter", version: "1.0.0", apiVersion: 1, enabled: false, builtin: "skills", capabilities: [],
  components: {
    skills: [{ id: "greeting", description: "Compose a greeting" }],
    commands: [{ id: "greet", description: "Print a greeting", alwaysLoad: true }],
    hooks: [{ id: "on-session-start", description: "Session hook" }],
    mcp: [{ id: "greeter-store", description: "Greeter memory", alwaysLoad: true }],
  },
};

it("accepts a declarative component package and rejects malformed ones", () => {
  const ok = validateInline(greeter);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.kind, "manifest");

  const unknownKind = validateInline({ ...greeter, components: { panels: [{ id: "x" }] } });
  assert.equal(unknownKind.ok, false);
  assert.ok(firstErrors(unknownKind).some((error) => error.message.includes("unknown component kind")));

  const badEntry = validateInline({ ...greeter, components: { skills: [{ id: "Bad Id" }] } });
  assert.equal(badEntry.ok, false);

  const duplicate = validateInline({ ...greeter, components: { skills: [{ id: "greeting" }, { id: "greeting" }] } });
  assert.equal(duplicate.ok, false);
  assert.ok(firstErrors(duplicate).some((error) => error.message.includes("duplicate component")));

  const badFlag = validateInline({ ...greeter, components: { skills: [{ id: "greeting", alwaysLoad: "yes" }] } });
  assert.equal(badFlag.ok, false);
  assert.ok(firstErrors(badFlag).some((error) => error.message.includes("alwaysLoad must be a boolean")));
});

it("registers component ownership and detects conflicting claims", () => {
  assert.equal(installAll(stateDir, [greeter]).ok, true);
  const other = { ...greeter, id: "xueness-example-rival", builtin: "skills", components: { skills: [{ id: "greeting" }] } };
  assert.equal(installAll(stateDir, [other]).ok, true);

  const { rows, conflicts } = componentOwners(stateDir);
  assert.equal(rows.length, 5);
  assert.equal(componentOwner(stateDir, "commands", "greet"), "xueness-example-greeter");
  assert.equal(componentOwner(stateDir, "mcp", "greeter-store"), "xueness-example-greeter");
  assert.deepEqual(conflicts.get("skills/greeting"), ["xueness-example-greeter", "xueness-example-rival"]);
});

it("shows component ownership in the plugin panel rows", () => {
  const options: PluginCatalogOptions = {
    stateDir,
    manifests: () => new Map([["skills", { id: "skills", name: "Skills" }], ["hooks", { id: "hooks", name: "Hooks" }]]),
    ui: new Map(),
    ownedSegments: new Set(),
  };
  const skills = catalogItems(options).find((row) => row.id === "skills")!;
  const summary = skills.components as Record<string, unknown>;
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.byKind, { commands: ["greet"], hooks: ["on-session-start"], mcp: ["greeter-store"], skills: ["greeting", "greeting"] });
  assert.deepEqual(summary.alwaysLoad, ["commands/greet", "mcp/greeter-store"]);
  assert.deepEqual(summary.conflicts, ["skills/greeting"]);

  const hooks = catalogItems(options).find((row) => row.id === "hooks")!;
  assert.equal((hooks.components as Record<string, unknown>).total, 0);
});

it("gates components on the owning plugin being effective and enabled (no new tasks when disabled)", () => {
  const effective = [{ id: "skills", effective: true }, { id: "hooks", effective: false }];
  let active = effectiveComponents(stateDir, effective);
  assert.equal(active.length, 0, "a disabled package contributes no components");
  assert.deepEqual(active, []);

  const enabled = { ...greeter, enabled: true };
  assert.equal(installAll(stateDir, [enabled]).ok, true);
  active = effectiveComponents(stateDir, effective);
  assert.equal(active.length, 4);
  const greet = active.find((item) => item.kind === "commands" && item.id === "greet")!;
  assert.equal(greet.loadPolicy, "always");
  const greeting = active.find((item) => item.kind === "skills" && item.id === "greeting")!;
  assert.equal(greeting.loadPolicy, "on-demand");
  assert.ok(active.every((item) => item.owner === "xueness-example-greeter" || item.owner === "xueness-example-rival"));

  const blocked = effectiveComponents(stateDir, [{ id: "skills", effective: false }, { id: "hooks", effective: true }]);
  assert.equal(blocked.length, 0, "a blocked adapter contributes no components");
});

it("upgrades a component package by version and keeps alwaysLoad stable", () => {
  const before = componentOwners(stateDir).rows.find((row) => row.key === "commands/greet")!;
  assert.equal(before.version, "1.0.0");
  const upgraded = { ...greeter, version: "1.1.0", enabled: true, components: { ...greeter.components, commands: [{ id: "greet", description: "Print a greeting", alwaysLoad: true }] } };
  assert.equal(installAll(stateDir, [upgraded]).ok, true);
  const after = componentOwners(stateDir).rows.find((row) => row.key === "commands/greet")!;
  assert.equal(after.version, "1.1.0");
  assert.equal(after.alwaysLoad, true);
  assert.equal(after.enabled, true);
  const declaration = { kind: "commands" as const, id: "greet", description: "Print a greeting", alwaysLoad: true };
  assert.equal(componentsDigest([declaration]), componentsDigest([{ alwaysLoad: true, kind: "commands", id: "greet", description: "Print a greeting" }]));
});

it("refuses to uninstall an enabled package, then uninstalls a disabled one", () => {
  const refused = uninstallPackage(stateDir, "xueness-example-greeter");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /disable the package before uninstalling/u);

  const disabled = { ...greeter, version: "1.1.0", enabled: false };
  assert.equal(installAll(stateDir, [disabled]).ok, true);
  const removed = uninstallPackage(stateDir, "xueness-example-greeter");
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, "xueness-example-greeter");
  assert.equal(loadManifests(stateDir).some((item) => item.id === "xueness-example-greeter"), false);
  assert.equal(uninstallPackage(stateDir, "xueness-example-greeter").ok, false);
  assert.equal(uninstallPackage(stateDir, "not-installed").ok, false);
});

it("uninstalls through the marketplace route and keeps optional plugins un-auto-installed", () => {
  const listing = marketplaceCatalog(stateDir, quietEnv);
  const workbuddy = listing.find((item) => item.id === "xueness-workbuddy")!;
  installOptionalFixture(stateDir, "workbuddy");

  const answer = dispatchMarketplace("POST", ["api", "plugins", "marketplace", "xueness-workbuddy", "uninstall"], {}, stateDir, quietEnv);
  assert.equal(answer![0], 200);
  assert.equal((answer![1] as Record<string, unknown>).removed, "xueness-workbuddy");
  assert.equal(loadManifests(stateDir).some((item) => item.id === "xueness-workbuddy"), false);

  const refused = dispatchMarketplace("POST", ["api", "plugins", "marketplace", "xueness-example-rival", "uninstall"], {}, stateDir, quietEnv);
  assert.equal(refused![0], 200, "disabled rival uninstalls through the route too");

  for (const optional of ["xueness-subscriptions", "xueness-model-monitor"]) {
    assert.equal(marketplaceCatalog(stateDir, quietEnv).find((item) => item.id === optional)!.installedVersion, null, `${optional} never auto-installs`);
  }
  assert.equal(loadManifests(stateDir).length, 0, "no marketplace listing wrote a manifest on its own");
});
