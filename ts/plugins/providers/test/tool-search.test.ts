import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Row } from "@xueness/agent";
import { AgentRunner, kernelAgentHooks } from "@xueness/agent";
import { createToolEnv, runTool, toolSafetyMetadata, type ToolDefinition, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { SessionStore } from "@xueness/sessions";
import { ToolBridge } from "@xueness/tool-bridge";
import type { ToolSearchProviderView } from "@xueness/providers";
import { createProviderResultTools, type ProviderToolSearchBinding } from "../src/index.ts";
import { lightweightRuntimeExtension } from "../src/runtime.ts";
import { flushDiscoveredToolsAnnouncement, hydrateDiscoveredTools, searchToolCatalog, type ToolSearchCatalogEntry } from "../src/tool-search.ts";

const entry = (name: string, description: string, extra: Partial<ToolSearchCatalogEntry> = {}): ToolSearchCatalogEntry =>
  ({ name, description, ...extra });

const CATALOG: ToolSearchCatalogEntry[] = [
  entry("read", "Read a UTF-8 file inside the workspace"),
  entry("network_fetch", "Fetch a URL from the network and return the response body"),
  entry("heavy_report", "Compile a long report of workspace statistics", { shouldDefer: true }),
  entry("handoff_core", "Always-loaded handoff tool", { alwaysLoad: true }),
  entry("tool_result_read", "Read a bounded page of the stored JSON text of a full recorded tool result"),
];

const ALPHAS = ["alpha_one", "alpha_two", "alpha_three", "alpha_four"].map((name) => entry(name, `alpha ${name}`));

const session = (): Row => ({ id: "s1", results: {} });

function toolEnv(owner: string, currentSession: () => Row | null): ToolEnv {
  const base = createToolEnv({ cwd: process.cwd(), roots: [process.cwd()], artifactsDir: `${process.cwd()}-artifacts`, owner });
  return Object.assign(base, { currentSession });
}

/** The production factory applied through a real PluginHost, like agent-service does. */
async function started(current: () => Row | null, binding: ProviderToolSearchBinding): Promise<{ kernel: Context; host: PluginHost; search: ToolDefinition<Row> }> {
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createProviderResultTools(current, binding)], { enabled: { providers: true } });
  const statuses = await host.start();
  try {
    assert.equal(statuses[0]?.state, "active", statuses[0]?.error ?? statuses[0]?.issues.join("; ") ?? "providers must start");
  } catch (error) {
    await host.dispose();
    await kernel.dispose();
    throw error;
  }
  const search = kernel.tools.get<ToolDefinition<Row>>("tool_search");
  assert.ok(search, "tool_search must register");
  return { kernel, host, search };
}

async function run(query: string, binding: Partial<ProviderToolSearchBinding> = {}, current: Row = session()): Promise<ToolResult<unknown>> {
  const { kernel, host, search } = await started(() => current, { catalog: () => CATALOG, ...binding });
  try { return await runTool(search, { query }, toolEnv("s1", () => current)); } finally { await host.dispose(); await kernel.dispose(); }
}

const results = (result: ToolResult<unknown>): Row[] => (result.data as Row).results as Row[];

describe("tool_search registration (C-TOOL-03)", () => {
  it("registers through ctx.tool so ownerOf is non-null and an enabled providers plugin no longer answers plugin_disabled", async () => {
    const current = session();
    const { kernel, host, search } = await started(() => current, { catalog: () => CATALOG });
    try {
      assert.equal(kernel.tools.ownerOf("tool_search"), "providers");
      assert.equal(search.gate, "tool_search");
      assert.equal(search.mutating, false);
      assert.equal(search.concurrencySafe, true);
      assert.equal(toolSafetyMetadata(search).readOnly, true, "undeclared readOnly follows !mutating");
      const result = await runTool(search, { query: "fetch" }, toolEnv("s1", () => current));
      assert.equal(result.ok, true, "the model must be able to call tool_search");
    } finally { await host.dispose(); await kernel.dispose(); }
  });
});

describe("tool_search local search", () => {
  it("matches names and descriptions and returns real catalog references", async () => {
    const byName = await run("fetch");
    assert.equal(byName.ok, true);
    assert.deepEqual(results(byName), [{ name: "network_fetch", description: "Fetch a URL from the network and return the response body", deferred: false }]);
    assert.equal((byName.data as Row).mode, "local");
    const byDescription = await run("report statistics");
    assert.deepEqual(results(byDescription).map((row) => row.name), ["heavy_report"]);
  });

  it("never returns names outside the bound catalog: a disabled plugin's tool cannot appear", async () => {
    assert.deepEqual(results(await run("ghost_tool")), []);
    const without = await run("workspace statistics", { catalog: () => CATALOG.filter((item) => item.name !== "heavy_report") });
    const names = results(without).map((row) => row.name);
    assert.equal(names.includes("heavy_report"), false, "a tool removed from the live catalog is unsearchable");
    assert.ok(names.every((name) => ["read", "network_fetch", "handoff_core", "tool_result_read"].includes(String(name))),
      "every reference is a real registered catalog entry");
  });

  it("bounds results by the session's toolSearchResults option (default 3)", async () => {
    assert.equal(results(await run("alpha", { catalog: () => ALPHAS })).length, 3, "the default toolSearchResults is 3");
    const one: Row = { ...session(), runtime_profile: "lightweight", lightweight_options: { toolSearchResults: 1 } };
    assert.equal(results(await run("alpha", { catalog: () => ALPHAS }, one)).length, 1);
  });

  it("records non-deferred matches in session.discovered_tools, newest at the end", async () => {
    const current = session();
    const first = await run("fetch", {}, current);
    assert.deepEqual(current.discovered_tools, ["network_fetch"]);
    assert.deepEqual((first.data as Row).discovered_tools, ["network_fetch"]);
    const deferred = await run("report", {}, current);
    assert.deepEqual(current.discovered_tools, ["network_fetch"], "a deferred match is not recorded");
    assert.equal((deferred.data as Row).discovered_tools, null);
    await run("handoff", {}, current);
    assert.deepEqual(current.discovered_tools, ["network_fetch", "handoff_core"], "a re-found name moves to the end (newest)");
  });

  it("caps recorded discoveries at maxDiscoveredTools and skips recording when it is 0", async () => {
    const capped: Row = { ...session(), runtime_profile: "lightweight", lightweight_options: { maxDiscoveredTools: 1 } };
    await run("alpha", { catalog: () => ALPHAS }, capped);
    assert.deepEqual(capped.discovered_tools, ["alpha_three"], "the newest discovery evicts the oldest");
    await run("alpha_two", { catalog: () => ALPHAS }, capped);
    assert.deepEqual(capped.discovered_tools, ["alpha_two"]);
    const off: Row = { ...session(), runtime_profile: "lightweight", lightweight_options: { maxDiscoveredTools: 0 } };
    await run("fetch", {}, off);
    assert.equal(off.discovered_tools, undefined, "maxDiscoveredTools=0 disables discovery recording");
  });

  it("keeps shouldDefer tools searchable in the catalog (F02.01) and marks them deferred in results", async () => {
    const found = results(await run("long report"));
    assert.deepEqual(found.map((row) => row.name), ["heavy_report"]);
    assert.equal(found[0]?.deferred, true, "searchable, but callable only through the deferred-call path (F02.03)");
  });

  it("searches alwaysLoad entries like any other and never changes exposure rules", async () => {
    assert.deepEqual(results(await run("handoff")).map((row) => row.name), ["handoff_core"]);
  });

  it("answers no-match with ok and an empty list, and refuses an empty query", async () => {
    const none = await run("zzz_unmatchable");
    assert.equal(none.ok, true);
    assert.deepEqual(results(none), []);
    const blank = await run("");
    assert.equal(blank.ok, false);
    assert.equal(blank.error?.code, "invalid_argument");
  });

  it("is deterministic for the same query and catalog", async () => {
    assert.deepEqual(results(await run("network read")), results(await run("network read")));
  });

  it("refuses a foreign owner session and records nothing there", async () => {
    const parent = session();
    const { kernel, host, search } = await started(() => parent, { catalog: () => CATALOG });
    try {
      const result = await runTool(search, { query: "fetch" }, toolEnv("child", () => parent));
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "unknown_session");
      assert.equal(parent.discovered_tools, undefined);
    } finally { await host.dispose(); await kernel.dispose(); }
  });
});

describe("tool_search local/native negotiation", () => {
  it("runs the local catalog search when no provider capability is declared", async () => {
    const result = await run("fetch", { provider: () => ({ protocol: "openai", toolCalling: "native" }) });
    assert.equal(result.ok, true);
    assert.equal((result.data as Row).mode, "local");
  });

  it("fails honestly instead of faking results when a native capability has no wired surface", async () => {
    const current = session();
    const native: ToolSearchProviderView = { protocol: "anthropic", toolCalling: "native", nativeToolSearch: true };
    const result = await run("fetch", { provider: () => native }, current);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "native_tool_search_unavailable");
    assert.equal(current.discovered_tools, undefined, "no silent local fallback masquerading as a native success");
  });
});

describe("searchToolCatalog scoring", () => {
  it("prefers exact names over substrings over descriptions and keeps registration order for ties", () => {
    const entries = [entry("fetch_helper", "A helper"), entry("fetch", "Fetch things"), entry("other", "Use this to fetch a URL from the network")];
    assert.deepEqual(searchToolCatalog("fetch", entries).map((item) => item.name), ["fetch", "fetch_helper", "other"]);
    assert.deepEqual(searchToolCatalog("zzz", entries), []);
  });
});

describe("tool_search end-to-end (lightweight two-step discovery)", () => {
  it("exposes a discovered real tool on the next request and executes its call through the bridge", async () => {
    const parent = mkdtempSync(join(tmpdir(), "xueness-search-e2e-"));
    const workspace = join(parent, "workspace");
    const store = new SessionStore(join(parent, "state"));
    const value = { id: "a".repeat(32), root: workspace, task: "task", status: "pending", steps: 0,
      messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null } as unknown as Row;
    const kernel = Context.create({ roots: { workspace: [workspace], state: join(parent, "state"), temp: join(parent, "temp") } });
    let alphaRuns = 0;
    kernel.tool({ name: "alpha_two", description: "The alpha two tool", inputSchema: { type: "object", properties: {} }, gate: "read", mutating: false, concurrencySafe: true, requires: {},
      async run() { alphaRuns += 1; return { ok: true, output: "alpha-two-ran" }; } } as unknown as Parameters<Context["tool"]>[0]);
    const host = new PluginHost(kernel, [createProviderResultTools(() => value, {
      catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
      provider: () => provider,
    })], { enabled: { providers: true } });
    const script: Row[] = [
      { tool_calls: [{ id: "c1", type: "function", function: { name: "tool_search", arguments: JSON.stringify({ query: "alpha" }) } }] },
      { tool_calls: [{ id: "c2", type: "function", function: { name: "alpha_two", arguments: "{}" } }] },
      { content: "Discovery done." },
    ];
    let step = 0;
    const seen: string[][] = [];
    const provider = {
      runtimeProfile: "lightweight", toolCalling: "native", contextWindow: 8192, maxOutputTokens: 1024,
      async complete(_messages: Row[], tools: Row[]) {
        seen.push(tools.map((schema) => String((schema.function as Row).name)).sort());
        return structuredClone(script[step++]!);
      },
    };
    try {
      assert.deepEqual((await host.start()).map((status) => status.state), ["active"]);
      const env = createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir: join(parent, "artifacts"), owner: String(value.id) });
      env.currentSession = () => value;
      const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: "build" }), env });
      const hooks = kernelAgentHooks(kernel, { enabled: (id) => id === "providers" || id === "kernel", extensions: [lightweightRuntimeExtension()] });
      const runner = new AgentRunner({ root: workspace, store, provider, hooks, toolBridge: bridge });
      await runner.run(value as never, { maxSteps: 8 });
      assert.deepEqual(seen[0], ["deferred_tool_call", "tool_result_read", "tool_search"], "before discovery only the base view is exposed (with the deferred envelope, F02.03)");
      assert.deepEqual(seen[1], ["alpha_two", "deferred_tool_call", "tool_result_read", "tool_search"], "the discovered real tool joins the next request");
      assert.deepEqual(value.discovered_tools, ["alpha_two"]);
      assert.equal(alphaRuns, 1, "the discovered tool executed for real");
      assert.equal((value.results as Row).c2 ? ((value.results as Row).c2 as Row).ok : false, true);
      assert.equal(String(((value.results as Row).c2 as Row).output), "alpha-two-ran");
      assert.equal(value.status, "completed");
    } finally {
      await host.dispose();
      await kernel.dispose();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("tool_search discovery persistence & one-time announcement (C-TOOL-05)", () => {
  it("queues pending_tool_discovery for non-deferred matches and never for already-announced names", async () => {
    const current = session();
    await run("fetch", {}, current);
    assert.deepEqual(current.discovered_tools, ["network_fetch"]);
    assert.deepEqual(current.pending_tool_discovery,
      [{ name: "network_fetch", description: "Fetch a URL from the network and return the response body" }]);
    current.announced_discovered_tools = ["network_fetch"];
    current.pending_tool_discovery = [];
    await run("handoff", {}, current);
    assert.deepEqual(current.pending_tool_discovery, [{ name: "handoff_core", description: "Always-loaded handoff tool" }],
      "only the never-announced name is queued");
  });

  it("flushes exactly one hidden announcement row and never repeats it", async () => {
    const current: Row = { ...session(), messages: [{ role: "user", content: "task" }] };
    await run("fetch", {}, current);
    flushDiscoveredToolsAnnouncement(current);
    const rows = current.messages as Row[];
    const announcements = rows.filter((row) => row._meta_source === "tool_discovery");
    assert.equal(announcements.length, 1);
    assert.equal(announcements[0]!.role, "user");
    assert.ok(String(announcements[0]!.content).startsWith("<system-reminder>"));
    assert.ok(String(announcements[0]!.content).includes("network_fetch"));
    assert.deepEqual(current.announced_discovered_tools, ["network_fetch"]);
    assert.equal(current.pending_tool_discovery, undefined, "the pending queue drains");
    flushDiscoveredToolsAnnouncement(current);
    assert.equal((current.messages as Row[]).filter((row) => row._meta_source === "tool_discovery").length, 1,
      "a second flush with nothing pending appends nothing");
  });

  it("drops a pending entry whose name was already announced instead of re-announcing", async () => {
    const current: Row = { ...session(), messages: [{ role: "user", content: "task" }], announced_discovered_tools: ["network_fetch"] };
    await run("fetch", {}, current);
    assert.equal(current.pending_tool_discovery, undefined, "an already-announced name is never queued");
    flushDiscoveredToolsAnnouncement(current);
    assert.equal((current.messages as Row[]).filter((row) => row._meta_source === "tool_discovery").length, 0);
  });

  it("hydrates the persisted window on restore: prune, dedupe, re-cap; empty catalog is a no-op", async () => {
    const current: Row = { ...session(), discovered_tools: ["ghost_tool", "network_fetch", "network_fetch", "read"] };
    hydrateDiscoveredTools(current, ["read", "network_fetch", "tool_search", "tool_result_read"]);
    assert.deepEqual(current.discovered_tools, ["network_fetch", "read"], "unknown names drop, duplicates merge, newest-at-end order kept");
    const many = [...Array(9).keys()].map((index) => `d${index}`);
    const capped: Row = { ...session(), discovered_tools: many };
    hydrateDiscoveredTools(capped, many);
    assert.deepEqual(capped.discovered_tools, many.slice(-6), "maxDiscoveredTools default 6 re-caps the window");
    const untouched: Row = { ...session(), discovered_tools: ["network_fetch"] };
    hydrateDiscoveredTools(untouched, []);
    assert.deepEqual(untouched.discovered_tools, ["network_fetch"], "an empty catalog never wipes the persisted window");
    const withPending: Row = { ...session(), discovered_tools: ["read"], pending_tool_discovery: [{ name: "ghost_tool", description: "x" }, { name: "read", description: "y" }] };
    hydrateDiscoveredTools(withPending, ["read"]);
    assert.deepEqual(withPending.pending_tool_discovery, [{ name: "read", description: "y" }], "queued entries prune with the window");
    const newestOrder: Row = { ...session(), discovered_tools: ["network_fetch", "read", "network_fetch"] };
    hydrateDiscoveredTools(newestOrder, ["read", "network_fetch"]);
    assert.deepEqual(newestOrder.discovered_tools, ["read", "network_fetch"], "duplicate moves to newest-at-end position");
    const zeroCap: Row = { ...session(), runtime_profile: "lightweight", lightweight_options: { maxDiscoveredTools: 0 }, discovered_tools: ["read"], pending_tool_discovery: [{ name: "read", description: "y" }] };
    hydrateDiscoveredTools(zeroCap, ["read"]);
    assert.deepEqual(zeroCap.discovered_tools, [], "maxDiscoveredTools 0 clears the persisted window instead of hitting slice(-0)");
    assert.equal(zeroCap.pending_tool_discovery, undefined);
  });

  it("queues only tools kept in the discovered window when maxDiscoveredTools < toolSearchResults", async () => {
    const current: Row = { ...session(), runtime_profile: "lightweight", lightweight_options: { toolSearchResults: 3, maxDiscoveredTools: 1 } };
    await run("read fetch handoff", {}, current);
    assert.equal((current.discovered_tools as string[]).length, 1);
    const kept = (current.discovered_tools as string[])[0]!;
    assert.deepEqual((current.pending_tool_discovery as Row[]).map((r) => r.name), [kept]);
  });
});

describe("tool_search end-to-end (same-turn deferred call, C-TOOL-04)", () => {
  it("searches a deferred tool and executes it in the same turn through deferred_tool_call", async () => {
    const parent = mkdtempSync(join(tmpdir(), "xueness-deferred-e2e-"));
    const workspace = join(parent, "workspace");
    const store = new SessionStore(join(parent, "state"));
    const value = { id: "b".repeat(32), root: workspace, task: "task", status: "pending", steps: 0,
      messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null } as unknown as Row;
    const kernel = Context.create({ roots: { workspace: [workspace], state: join(parent, "state"), temp: join(parent, "temp") } });
    let alphaRuns = 0;
    kernel.tool({ name: "alpha_two", description: "The alpha two tool", inputSchema: { type: "object", properties: {} }, gate: "read", mutating: false, concurrencySafe: true, shouldDefer: true, requires: {},
      async run() { alphaRuns += 1; return { ok: true, output: "alpha-two-ran-same-turn" }; } } as unknown as Parameters<Context["tool"]>[0]);
    const host = new PluginHost(kernel, [createProviderResultTools(() => value, {
      catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
      provider: () => provider,
    })], { enabled: { providers: true } });
    const script: Row[] = [
      { tool_calls: [{ id: "c1", type: "function", function: { name: "tool_search", arguments: JSON.stringify({ query: "alpha" }) } }] },
      { tool_calls: [{ id: "c2", type: "function", function: { name: "deferred_tool_call", arguments: JSON.stringify({ tool: "alpha_two" }) } }] },
      { content: "Discovery and deferred call done." },
    ];
    let step = 0;
    const seen: string[][] = [];
    const provider = {
      runtimeProfile: "lightweight", toolCalling: "native", contextWindow: 8192, maxOutputTokens: 1024,
      async complete(_messages: Row[], tools: Row[]) {
        seen.push(tools.map((schema) => String((schema.function as Row).name)).sort());
        return structuredClone(script[step++]!);
      },
    };
    try {
      assert.deepEqual((await host.start()).map((status) => status.state), ["active"]);
      const env = createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir: join(parent, "artifacts"), owner: String(value.id) });
      env.currentSession = () => value;
      const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: "build" }), env });
      const hooks = kernelAgentHooks(kernel, { enabled: (id) => id === "providers" || id === "kernel", extensions: [lightweightRuntimeExtension()] });
      const runner = new AgentRunner({ root: workspace, store, provider, hooks, toolBridge: bridge });
      await runner.run(value as never, { maxSteps: 8 });
      assert.ok(seen[0]!.includes("deferred_tool_call"), "the deferred envelope rides with tool_search in the base view");
      assert.ok(!seen[1]!.includes("alpha_two"), "the deferred target never enters the request schema, even after discovery");
      assert.equal(alphaRuns, 1, "the wrapped call executed for real in the same turn");
      const stored = (value.results as Row).c2 as Row;
      assert.equal(stored.ok, true);
      assert.equal(String(stored.output), "alpha-two-ran-same-turn");
      const toolMessage = (value.messages as Row[]).find((message) => message.role === "tool" && message.tool_call_id === "c2");
      assert.ok(toolMessage, "the deferred result is journaled under its model call id");
      assert.equal(value.discovered_tools, undefined, "a deferred hit is never recorded for exposure (F02.02 boundary kept)");
      assert.equal(value.status, "completed");
    } finally {
      await host.dispose();
      await kernel.dispose();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("pages a deferred result back through tool_result_read like any stored result", async () => {
    const parent = mkdtempSync(join(tmpdir(), "xueness-deferred-page-"));
    const workspace = join(parent, "workspace");
    const store = new SessionStore(join(parent, "state"));
    const value = { id: "c".repeat(32), root: workspace, task: "task", status: "pending", steps: 0,
      messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null } as unknown as Row;
    const kernel = Context.create({ roots: { workspace: [workspace], state: join(parent, "state"), temp: join(parent, "temp") } });
    kernel.tool({ name: "long_read", description: "A deferred long read", inputSchema: { type: "object", properties: {} }, gate: "read", mutating: false, concurrencySafe: true, shouldDefer: true, requires: {},
      async run() { return { ok: true, output: "x".repeat(2000) }; } } as unknown as Parameters<Context["tool"]>[0]);
    const host = new PluginHost(kernel, [createProviderResultTools(() => value, {
      catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
    })], { enabled: { providers: true } });
    const script: Row[] = [
      { tool_calls: [{ id: "c1", type: "function", function: { name: "deferred_tool_call", arguments: JSON.stringify({ tool: "long_read" }) } }] },
      { tool_calls: [{ id: "c2", type: "function", function: { name: "tool_result_read", arguments: JSON.stringify({ tool_call_id: "c1", limit: 100 }) } }] },
      { content: "Paged." },
    ];
    let step = 0;
    const provider = {
      runtimeProfile: "lightweight", toolCalling: "native", contextWindow: 8192, maxOutputTokens: 1024,
      async complete(_messages: Row[], tools: Row[]) { void tools; return structuredClone(script[step++]!); },
    };
    try {
      assert.deepEqual((await host.start()).map((status) => status.state), ["active"]);
      const env = createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir: join(parent, "artifacts"), owner: String(value.id) });
      env.currentSession = () => value;
      const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: "build" }), env });
      const hooks = kernelAgentHooks(kernel, { enabled: (id) => id === "providers" || id === "kernel", extensions: [lightweightRuntimeExtension()] });
      const runner = new AgentRunner({ root: workspace, store, provider, hooks, toolBridge: bridge });
      await runner.run(value as never, { maxSteps: 8 });
      const page = (value.results as Row).c2 as Row;
      assert.equal(page.ok, true, "tool_result_read pages the deferred result by its call id");
      assert.equal((page.data as Row).sourceType, "stored_result");
      assert.equal(String(page.output).length, 100);
      assert.equal(value.status, "completed");
    } finally {
      await host.dispose();
      await kernel.dispose();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
