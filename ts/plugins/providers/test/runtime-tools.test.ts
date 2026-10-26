import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRuntimeTools, type RuntimeToolPolicy } from "../src/runtime-tools.ts";

type Row = Record<string, unknown>;
const schema = (name: string): Row => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } });
const provider = { contextWindow: 8192, maxOutputTokens: 512, toolCalling: "native" };
const selected = (schemas: Row[], session: Row, policy?: RuntimeToolPolicy): string[] =>
  selectRuntimeTools(schemas, session, provider, policy)[1].map((row) => String((row.function as Row).name));
const catalogNames = (schemas: Row[], session: Row, policy?: RuntimeToolPolicy): string[] =>
  selectRuntimeTools(schemas, session, provider, policy)[0].map((row) => String((row.function as Row).name));

describe("lightweight exposure rules", () => {
  // A real request catalog carries the providers discovery pair whenever the
  // plugin is enabled; the selector can only expose schemas the catalog holds.
  const catalog = ["read", "write", "edit", "exec", "grep", "network_fetch", "handoff_core", "heavy_report", "tool_search", "deferred_tool_call"].map(schema);

  it("force-loads declared alwaysLoad tools into the selected view without them being discovered or mentioned", () => {
    assert.ok(selected(catalog, { messages: [] }, { alwaysLoad: ["handoff_core"] }).includes("handoff_core"));
  });
  it("does not count alwaysLoad tools against maxDiscoveredTools", () => {
    const cramped = { ...provider, lightweightOptions: { maxDiscoveredTools: 1 } };
    const session = { messages: [], discovered_tools: ["network_fetch", "grep", "heavy_report"] };
    const view = selectRuntimeTools(catalog, session, cramped, { alwaysLoad: ["handoff_core"] })[1].map((row) => String((row.function as Row).name));
    assert.ok(view.includes("handoff_core"));
    assert.equal(view.filter((name) => ["network_fetch", "grep", "heavy_report"].includes(name)).length, 1);
  });
  it("holds deferred tools out of the selected view while keeping them in the request-side catalog", () => {
    const session = { messages: [{ role: "user", content: "please grep the result" }], discovered_tools: ["heavy_report"] };
    const view = selected(catalog, session, { deferred: ["heavy_report"] });
    assert.ok(!view.includes("heavy_report"), "deferred wins over discovered and mentioned");
    assert.ok(catalogNames(catalog, session, { deferred: ["heavy_report"] }).includes("heavy_report"), "the catalog is not deleted");
    assert.ok(!selected(catalog, { messages: [] }, { deferred: ["read"] }).includes("read"), "deferred removes even base tools");
  });
  it("resolves the alwaysLoad-versus-deferred conflict in favor of alwaysLoad", () => {
    assert.ok(selected(catalog, { messages: [] }, { alwaysLoad: ["heavy_report"], deferred: ["heavy_report"] }).includes("heavy_report"));
  });
  it("never re-exposes a disabled plugin's tool from discovered_tools when its schema is no longer in the catalog", () => {
    // The disabled plugin's schema was removed upstream (kernelAgentHooks.tools + driver owner filter).
    const enabledCatalog = catalog.filter((row) => (row.function as Row).name !== "heavy_report");
    const session = { messages: [], discovered_tools: ["heavy_report", "network_fetch"] };
    const view = selected(enabledCatalog, session, { alwaysLoad: ["handoff_core"] });
    assert.ok(!view.includes("heavy_report"));
    assert.ok(view.includes("network_fetch"));
  });
  it("is deterministic for identical inputs", () => {
    const session = { messages: [{ role: "user", content: "use network_fetch" }], discovered_tools: ["grep"] };
    const policy = { alwaysLoad: ["handoff_core"], deferred: ["heavy_report"] };
    assert.deepEqual(selected(catalog, session, policy), selected(catalog, session, policy));
    assert.deepEqual(catalogNames(catalog, session, policy), catalogNames(catalog, session, policy));
  });
  it("keeps the plain selector contract untouched when no exposure policy is given", () => {
    const session = { messages: [], discovered_tools: ["network_fetch"] };
    assert.deepEqual(selected(catalog, session), ["deferred_tool_call", "edit", "exec", "network_fetch", "read", "tool_search", "write"]);
  });
  it("rides the deferred envelope with tool_search: present in every base view, gone when discovery is off (F02.03)", () => {
    const minimal = { ...provider, lightweightOptions: { initialTools: "minimal" } };
    for (const session of [{ messages: [] }, { read_only: true, messages: [] }]) {
      const names = (p: typeof provider): string[] => selectRuntimeTools(catalog, session, p)[1].map((row) => String((row.function as Row).name));
      assert.ok(names(provider).includes("deferred_tool_call"), JSON.stringify(session));
      assert.ok(names(minimal).includes("deferred_tool_call"), "the minimal view keeps the envelope beside tool_search");
    }
    const off = { ...provider, lightweightOptions: { maxDiscoveredTools: 0 } };
    const view = selectRuntimeTools(catalog, { messages: [] }, off)[1].map((row) => String((row.function as Row).name));
    assert.ok(!view.includes("deferred_tool_call") && !view.includes("tool_search"), "no discovery surface, no deferred envelope");
  });
});
