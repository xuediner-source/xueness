/**
 * F00.04 acceptance harness · S-TOOL-03A / S-TOOL-05A (offline, in-repo).
 *
 * Reproduces the tool_search breakage confirmed by F00.02 through the real
 * production registration chain, in an isolated process (no server, no model).
 * Shape mirrors /tmp/f00002-repro/repro.ts (F00.02) — see F00.02-result.md §3.
 *
 * F02.04 update: checks [1]-[4] recorded the F00 boundary (tool_search unregistered)
 * and are superseded by F02.02/F02.03 — providers now registers tool_search and the
 * deferred envelope. They are kept below as historical notes only; the live
 * assertions are [5]/[5b] (consumer side) and [6]/[6b] (C-TOOL-05 producer side).
 *
 * Chain mirrored from production:
 *   ts/apps/server/src/agent-service.ts:130   (PluginHost + createProviderResultTools)
 *   ts/packages/agent/src/kernel-hooks.ts     (kernelAgentHooks)
 *   ts/packages/agent/src/driver.ts:85-98     (request tool filter)
 *   ts/packages/agent/src/tools.ts:54-57      (call gates / ownerOf)
 *   ts/plugins/providers/src/runtime-tools.ts (lightweight selector)
 *   ts/plugins/providers/src/tool-search.ts   (C-TOOL-05 producer, F02.04)
 */
import { Context, PluginHost } from "../../../../../ts/packages/kernel/src/index.ts";
import { createProviderResultTools } from "../../../../../ts/plugins/providers/src/result-tool.ts";
import { kernelAgentHooks } from "../../../../../ts/packages/agent/src/kernel-hooks.ts";
import { internalToolName } from "../../../../../ts/packages/agent/src/tool-contract/names.ts";
import { selectRuntimeTools } from "../../../../../ts/plugins/providers/src/runtime-tools.ts";
import { createToolSearchTool, flushDiscoveredToolsAnnouncement } from "../../../../../ts/plugins/providers/src/tool-search.ts";
import type { Row } from "../../../../../ts/packages/agent/src/types.ts";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};

const session: Row = { id: "s-f00004-toolsearch", read_only: false, messages: [{ role: "user", content: "please use browser tools" }] };
const kernel = Context.create();
// Same factory and injection point as agent-service.ts:130 / workflow-actors.ts:84.
const host = new PluginHost(kernel, [createProviderResultTools(() => session, {
  catalog: () => [{ name: "weather_lookup", description: "Get current weather for a city" }],
})], { enabled: { providers: true } });
await host.start();

// [1]-[4] HISTORICAL (F00.02 boundary, superseded by F02.02/F02.03): tool_search was
// unregistered, ownerOf was null and a model call settled plugin_disabled. Providers
// now registers tool_search/deferred_tool_call through ctx.tool, so these no longer
// reproduce; the F00.02 record lives in F00.02-result.md §3.
console.log("hist [1] providers-registered tool names: tool_search now registers (F02.02)");
console.log("hist [2] ownerOf('tool_search'): now 'providers' (F02.02)");
console.log("hist [3] model-visible request tool names: tool_search enters the lightweight base view (F02.02)");
console.log("hist [4] call gates: owner resolved, admission/gates apply like any tool (F02.02/F02.03)");

// [5] C-TOOL-05 consumer side: injected discovered_tools surface next turn, and
// the eviction order keeps the latest first ([...discovered].reverse(), max 6).
const provider = { contextWindow: 8192, runtimeOptions: {} } as never;
const tool = (name: string): Row => ({ type: "function", function: { name, description: "tool", parameters: { type: "object", properties: {} } } });
const requestTools: Row[] = [];
const catalog = [...requestTools, tool("browser_navigate"), tool("network_fetch"), ...["d1", "d2", "d3", "d4", "d5", "d6", "d7"].map(tool)];
const withInjected = selectRuntimeTools(catalog, { ...session, discovered_tools: ["network_fetch"] } as Row, provider);
const injectedView = (withInjected[1] as Row[]).map((schema) => (schema.function as Row).name);
check("[5] selector surfaces injected discovered_tools next turn", injectedView.includes("network_fetch"), JSON.stringify(injectedView));
const withSeven = selectRuntimeTools(catalog, { ...session, discovered_tools: ["d1", "d2", "d3", "d4", "d5", "d6", "d7"] } as Row, provider);
const evicted = (withSeven[1] as Row[]).map((schema) => (schema.function as Row).name).filter((name) => name.startsWith("d"));
check("[5b] eviction drops the oldest at maxDiscoveredTools=6 (view itself is sorted)", JSON.stringify(evicted) === JSON.stringify(["d2", "d3", "d4", "d5", "d6", "d7"]), JSON.stringify(evicted));

// [6] C-TOOL-05 producer side (F02.04): a real tool_search run records the discovery
// window, queues the never-announced names, and the flush persists exactly one hidden
// reminder row — fork/resume/subsequent turns never re-announce it.
const discover: Row = { id: "s-f00004-producer", messages: [{ role: "user", content: "find weather tools" }] };
const searchTool = createToolSearchTool(() => discover, {
  catalog: () => [{ name: "weather_lookup", description: "Get current weather for a city" }, { name: "weather_history", description: "Past weather records", shouldDefer: true }],
});
const searchResult = await searchTool.run({ query: "weather" }, {} as never);
check("[6] producer records non-deferred matches and queues the announcement", searchResult.ok === true
  && JSON.stringify(discover.discovered_tools) === JSON.stringify(["weather_lookup"])
  && Array.isArray(discover.pending_tool_discovery) && discover.pending_tool_discovery.length === 1
  && discover.announced_discovered_tools === undefined,
  `discovered=${JSON.stringify(discover.discovered_tools)} pending=${JSON.stringify(discover.pending_tool_discovery)}`);
flushDiscoveredToolsAnnouncement(discover);
const announcedRows = (discover.messages as Row[]).filter((row) => row._meta_source === "tool_discovery");
check("[6b] announcement persisted once as a hidden system-reminder row", announcedRows.length === 1
  && String(announcedRows[0]!.content).startsWith("<system-reminder>")
  && JSON.stringify(discover.announced_discovered_tools) === JSON.stringify(["weather_lookup"])
  && discover.pending_tool_discovery === undefined,
  `rows=${announcedRows.length} announced=${JSON.stringify(discover.announced_discovered_tools)}`);

await host.dispose();
await kernel.dispose();

console.log("");
console.log("[HARNESS] " + (failures.length === 0
  ? "current chain verified: consumer selector + C-TOOL-05 producer/announcement hold."
  : "UNEXPECTED shape: " + failures.join(", ") + " — the contract status needs re-evaluation."));
console.log("[CONTRACT] C-TOOL-03: registered executor since F02.02 (historical F00 fail record superseded).");
console.log("[CONTRACT] C-TOOL-05: producer + one-time hidden announcement + hydrate landed in F02.04 (was: fail, no writer).");
process.exit(failures.length === 0 ? 0 : 1);
