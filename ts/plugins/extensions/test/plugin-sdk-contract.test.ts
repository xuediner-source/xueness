/** F07.06: plugin SDK contract — public types, example plugin, compat rules, contribution checks. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { componentOwners, uninstallPackage } from "../src/components.ts";
import {
  EXAMPLE_PACKAGE, SDK_API_VERSION, compatVerdict, contributionIssues, describePackage,
} from "../src/contribution.ts";
import { installAll, loadManifests } from "../src/sdk.ts";
import { validateInline } from "../src/validate.ts";

const stateDir = mkdtempSync(join(tmpdir(), "xueness-sdk-contract-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

it("publishes one SDK api version and decides compatibility by rule", () => {
  assert.equal(SDK_API_VERSION, 1);
  assert.deepEqual(compatVerdict(1), { supported: true, mode: "exact", note: "targets SDK apiVersion 1" });
  const legacy = compatVerdict(0);
  assert.equal(legacy.supported, false, "apiVersion 0 is not a valid target");
  assert.deepEqual(compatVerdict(2), { supported: false, reason: "package-newer", note: "package needs SDK apiVersion 2; this host provides 1" });
  assert.equal(compatVerdict("1").supported, false);
  assert.equal(compatVerdict(1.5).supported, false);
});

it("ships an isolated example plugin that passes the whole contract", () => {
  assert.equal(contributionIssues(EXAMPLE_PACKAGE).length, 0);
  const inline = validateInline(EXAMPLE_PACKAGE);
  assert.equal(inline.ok, true, JSON.stringify(inline.errors));
  const description = describePackage(EXAMPLE_PACKAGE)!;
  assert.equal(description.id, "xueness-example-greeter");
  assert.deepEqual(description.components.byKind, { commands: ["greet"], hooks: ["on-session-start"], skills: ["greeting"] });
  assert.deepEqual(description.components.alwaysLoad, ["commands/greet"]);
  assert.deepEqual(description.settings, ["style"]);
  assert.deepEqual(description.events, ["example-greeter.session-started"]);
});

it("builds, installs, enables, disables and uninstalls the example plugin without main-app code", () => {
  // Build: the contract audit is the build gate for a data package.
  assert.equal(contributionIssues(EXAMPLE_PACKAGE).length, 0);
  // Install: batch install validates first, writes disabled.
  const installed = installAll(stateDir, [EXAMPLE_PACKAGE]);
  assert.equal(installed.ok, true, JSON.stringify(installed.errors));
  assert.equal(loadManifests(stateDir)[0]!.enabled, false);
  const owners = componentOwners(stateDir);
  assert.equal(owners.rows.length, 3);
  assert.ok(owners.rows.every((row) => row.owner === "xueness-example-greeter"));

  // Enable: republish the document with enabled true (the SDK's only switch for data packages).
  const enabled = installAll(stateDir, [{ ...EXAMPLE_PACKAGE, enabled: true }]);
  assert.equal(enabled.ok, true);
  assert.equal(componentOwners(stateDir).rows.every((row) => row.enabled), true);

  // Disable: same document, enabled false.
  assert.equal(installAll(stateDir, [EXAMPLE_PACKAGE]).ok, true);
  assert.equal(componentOwners(stateDir).rows.every((row) => row.enabled), false);

  // Uninstall: the document is disabled again, so removal is allowed.
  const removed = uninstallPackage(stateDir, EXAMPLE_PACKAGE.id);
  assert.equal(removed.ok, true);
  assert.equal(loadManifests(stateDir).length, 0);
});

it("rejects contract violations with pointed issues", () => {
  const badNamespace = contributionIssues({ ...EXAMPLE_PACKAGE, events: [{ name: "other.thing", description: "x" }] });
  assert.ok(badNamespace.some((issue) => issue.message.includes("must be namespaced example-greeter.*")));

  const badSetting = contributionIssues({ ...EXAMPLE_PACKAGE, settings: { style: { type: "colour" } } });
  assert.ok(badSetting.some((issue) => issue.message.includes("type string|number|boolean|enum")));

  const badEnum = contributionIssues({ ...EXAMPLE_PACKAGE, settings: { style: { type: "enum", title: "t", description: "d", default: "a", options: [] } } });
  assert.ok(badEnum.some((issue) => issue.message.includes("unique non-empty string options")));

  const selfDependency = contributionIssues({ ...EXAMPLE_PACKAGE, dependencies: [EXAMPLE_PACKAGE.id] });
  assert.ok(selfDependency.some((issue) => issue.message.includes("must not depend on itself")));

  const futureSdk = contributionIssues({ ...EXAMPLE_PACKAGE, apiVersion: 2 });
  assert.ok(futureSdk.some((issue) => issue.path === "xueness-example-greeter/apiVersion"));

  assert.equal(contributionIssues("not an object").length, 1);
  assert.equal(describePackage({ ...EXAMPLE_PACKAGE, version: "one" }), null);
});
