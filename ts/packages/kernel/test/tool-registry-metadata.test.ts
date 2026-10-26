import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Context, type ToolDescriptor } from "@xueness/kernel";

const run = async () => ({ ok: true });

describe("tool registry safety and exposure metadata", () => {
  it("carries declared safety and exposure fields through the registry and its declaration view", async () => {
    const kernel = Context.create();
    const deferred: ToolDescriptor = { name: "heavy_report", gate: "read", mutating: false, concurrencySafe: true, readOnly: true, shouldDefer: true };
    const always: ToolDescriptor = { name: "handoff_core", gate: "read", mutating: false, concurrencySafe: true, alwaysLoad: true };
    const destructive: ToolDescriptor = { name: "wipe_cache", gate: "exec", mutating: true, concurrencySafe: false, destructive: true };
    kernel.tool({ ...deferred, run } as ToolDescriptor);
    kernel.tool({ ...always, run } as ToolDescriptor);
    kernel.tool({ ...destructive, run } as ToolDescriptor);
    const names = (tools: ToolDescriptor[]) => tools.map((tool) => tool.name).sort();
    assert.deepEqual(names(kernel.tools.list()), ["handoff_core", "heavy_report", "wipe_cache"]);
    assert.equal(kernel.tools.get("heavy_report")?.shouldDefer, true);
    assert.equal(kernel.tools.get("handoff_core")?.alwaysLoad, true);
    assert.equal(kernel.tools.get("wipe_cache")?.destructive, true);
    // A plugin-restricted declaration keeps the new fields and stays a plain declaration.
    const plugin = kernel.restrict("plugin:extras", { owner: "extras", tools: [deferred] });
    assert.deepEqual(plugin.tools.get("heavy_report"), deferred);
    await kernel.dispose();
  });
  it("keeps descriptors without the new fields unchanged in the declaration view", async () => {
    const kernel = Context.create();
    const plain = { name: "peek", gate: "read", mutating: false, concurrencySafe: true };
    kernel.tool({ ...plain, run } as ToolDescriptor);
    const declaration = kernel.tools.list<ToolDescriptor>()[0]!;
    assert.deepEqual(declaration, { ...plain, run });
    assert.ok(!("alwaysLoad" in declaration) && !("shouldDefer" in declaration) && !("readOnly" in declaration) && !("destructive" in declaration));
    await kernel.dispose();
  });
});
