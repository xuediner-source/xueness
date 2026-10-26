/** H01.01 / H01.02: zero-glue contracts + adapter mount table. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HarnessAdapter, parseHarnessPackage, HARNESS_CONTRACT_API_VERSION } from "../src/adapter.ts";

const sample = {
  sdkApiVersion: HARNESS_CONTRACT_API_VERSION,
  id: "demo_harness",
  version: "1.0.0",
  contributions: [
    { kind: "tool", name: "demo.ping", gate: "read", mutating: false, description: "ping" },
    { kind: "hook", event: "PostToolUse", handler: "onTool" },
    { kind: "verifier", name: "lint", command: "bun test" },
    { kind: "skill", id: "demo", path: "skills/demo.md" },
    { kind: "promptTemplate", id: "intro", template: "You are helpful." },
  ],
};

describe("parseHarnessPackage", () => {
  it("accepts a well-formed package and keeps every contribution", () => {
    const parsed = parseHarnessPackage(sample);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.package.id, "demo_harness");
    assert.equal(parsed.package.contributions.length, 5);
  });

  it("rejects wrong sdk versions, bad ids and duplicate contributions", () => {
    assert.equal(parseHarnessPackage({ ...sample, sdkApiVersion: 99 }).ok, false);
    assert.equal(parseHarnessPackage({ ...sample, id: "Bad Id" }).ok, false);
    assert.equal(parseHarnessPackage({
      ...sample,
      contributions: [
        { kind: "tool", name: "demo.ping", gate: "read", mutating: false, description: "" },
        { kind: "tool", name: "demo.ping", gate: "read", mutating: false, description: "" },
      ],
    }).ok, false);
  });
});

describe("HarnessAdapter", () => {
  it("mounts a package and indexes every contribution without touching core", () => {
    const adapter = new HarnessAdapter();
    const mounted = adapter.mount(sample);
    assert.equal(mounted.ok, true);
    if (!mounted.ok) return;
    assert.equal(adapter.size, 1);
    assert.equal(adapter.list()[0]?.id, "demo_harness");
    assert.equal(adapter.lookup("tool:demo.ping")?.owner, "demo_harness");
    assert.equal(adapter.listByKind("hook").length, 1);
    assert.equal(adapter.listByKind("promptTemplate")[0]?.key, "promptTemplate:intro");
  });

  it("refuses duplicate package ids and contribution conflicts", () => {
    const adapter = new HarnessAdapter();
    assert.equal(adapter.mount(sample).ok, true);
    const again = adapter.mount(sample);
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.code, "already_mounted");

    const clash = adapter.mount({
      sdkApiVersion: HARNESS_CONTRACT_API_VERSION,
      id: "other",
      version: "1.0.0",
      contributions: [{ kind: "tool", name: "demo.ping", gate: "read", mutating: false, description: "" }],
    });
    assert.equal(clash.ok, false);
    if (clash.ok) return;
    assert.equal(clash.code, "contribution_conflict");
    assert.equal(clash.conflictOwner, "demo_harness");
  });

  it("unmounts cleanly and leaves the index empty", () => {
    const adapter = new HarnessAdapter();
    adapter.mount(sample);
    assert.equal(adapter.unmount("demo_harness"), true);
    assert.equal(adapter.size, 0);
    assert.equal(adapter.lookup("tool:demo.ping"), null);
    assert.equal(adapter.unmount("missing"), false);
  });

  it("rejects invalid raw documents with structured issues", () => {
    const adapter = new HarnessAdapter();
    const failed = adapter.mount({ id: "x" });
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.code, "invalid_package");
    assert.ok((failed.issues?.length ?? 0) > 0);
  });
});
