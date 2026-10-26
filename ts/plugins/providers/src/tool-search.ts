/**
 * Generic `tool_search` (C-TOOL-03, F02.02): one search tool over the kernel's
 * full tool catalog. The catalog input is the live registry of enabled plugins
 * — disabled plugins' tools are absent from it, and a search never enables a
 * plugin or grants permission. It returns real tool references only: every
 * name it reports is a registered, enabled tool the model can call once it is
 * in the request's tool view. Non-deferred matches are recorded in
 * `session.discovered_tools` so the lightweight selector re-exposes them on
 * the next request; deferred (`shouldDefer`) matches are callable in the same
 * turn through the `deferred_tool_call` envelope (F02.03/C-TOOL-04), which
 * unwraps to the real registered tool on the ordinary execution path.
 * Discovered tools are durably persisted and announced exactly once as a hidden
 * `tool_discovery` system-reminder; the persisted window is revalidated against
 * the live catalog on every run (C-TOOL-05, F02.04).
 */
import { isDict, pyJsonDumps, type JsonSchema } from "@xueness/contracts";
import { LIGHTWEIGHT_DEFAULTS, resolveToolSearchMode, sessionOptions, type ToolSearchProviderView } from "@xueness/providers";
import { failure, type ToolDefinition, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import { wrapSystemReminderForSource, type Row } from "@xueness/agent";

/** Identity and exposure metadata only: no handler, no lease, no capability. */
export interface ToolSearchCatalogEntry {
  name: string;
  description: string;
  alwaysLoad?: boolean;
  shouldDefer?: boolean;
}

/** What the host binds so the search sees the live catalog and the run's provider. */
export interface ProviderToolSearchBinding {
  /** The full kernel tool catalog at call time (registered = enabled plugins). */
  catalog: () => readonly ToolSearchCatalogEntry[];
  /** The run's provider for local/native negotiation; null resolves local. */
  provider?: () => ToolSearchProviderView | null;
}

interface SearchInput { query: string }
interface SearchReference { name: string; description: string; deferred: boolean }
interface SearchData {
  query: string;
  mode: "local" | "native";
  results: SearchReference[];
  /** The session's `discovered_tools` after this call; null when nothing was recorded. */
  discovered_tools: string[] | null;
}
type ScopedToolEnv = ToolEnv & { currentSession?: () => Row | null };

const inputSchema: JsonSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1, maxLength: 512 } },
  required: ["query"],
  additionalProperties: false,
};

const SEARCH_TOOL = "tool_search";

/** Deterministic term match over names and descriptions; higher score wins, registration order breaks ties. */
export function searchToolCatalog(query: string, catalog: readonly ToolSearchCatalogEntry[]): ToolSearchCatalogEntry[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/).filter((term) => term.length > 0))];
  if (!terms.length) return [];
  const scored: Array<{ entry: ToolSearchCatalogEntry; score: number }> = [];
  for (const entry of catalog) {
    if (entry.name === SEARCH_TOOL) continue; // always available to the caller; a self-hit only wastes a slot
    const name = entry.name.toLowerCase();
    const description = String(entry.description ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 8;
      else if (name.includes(term)) score += 4;
      else if (term.length > 1 && description.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}

/** The bounded numbers the search honors, from the session's validated runtime options. */
function searchOptions(session: Row): { limit: number; maxDiscovered: number } {
  const options = sessionOptions(session);
  const limit = options.toolSearchResults;
  const maxDiscovered = options.maxDiscoveredTools;
  return {
    limit: typeof limit === "number" && Number.isInteger(limit) ? limit : LIGHTWEIGHT_DEFAULTS.toolSearchResults as number,
    maxDiscovered: typeof maxDiscovered === "number" && Number.isInteger(maxDiscovered) ? maxDiscovered : LIGHTWEIGHT_DEFAULTS.maxDiscoveredTools as number,
  };
}

/** Newest at the end: the selector reads `[...discovered].reverse()` as newest-first. */
function recordDiscovered(session: Row, names: string[], maxDiscovered: number): string[] | null {
  if (maxDiscovered <= 0 || !names.length) return null;
  const previous = Array.isArray(session.discovered_tools) ? session.discovered_tools.filter((name): name is string => typeof name === "string") : [];
  const next = [...previous.filter((name) => !names.includes(name)), ...names].slice(-maxDiscovered);
  session.discovered_tools = next;
  return next;
}

export interface DiscoveredToolReference { name: string; description: string }

/** C-TOOL-05: revalidate the persisted discovery window against the live catalog (cold restore, fork/resume). */
export function hydrateDiscoveredTools(session: Row, catalogNames: readonly string[]): void {
  if (!catalogNames.length) return;
  const known = new Set(catalogNames.filter((name): name is string => typeof name === "string"));
  const { maxDiscovered } = searchOptions(session);
  const previous = Array.isArray(session.discovered_tools) ? session.discovered_tools.filter((name): name is string => typeof name === "string") : [];
  const deduped: string[] = [];
  for (const name of previous) {
    if (!known.has(name)) continue;
    const idx = deduped.indexOf(name);
    if (idx >= 0) deduped.splice(idx, 1);
    deduped.push(name);
  }
  const capped = maxDiscovered <= 0 ? [] : deduped.slice(-maxDiscovered);
  if (JSON.stringify(capped) !== JSON.stringify(previous)) session.discovered_tools = capped;
  const activeWindow = new Set(capped);
  const pending = Array.isArray(session.pending_tool_discovery) ? session.pending_tool_discovery.filter(isDict) : [];
  const kept = maxDiscovered <= 0 ? [] : pending.filter((entry) => typeof entry.name === "string" && known.has(entry.name as string) && activeWindow.has(entry.name as string));
  if (kept.length !== pending.length) { if (kept.length) session.pending_tool_discovery = kept; else delete session.pending_tool_discovery; }
}

/** Queue only names in the recorded discovery window that the session has never announced. */
function queueDiscoveredAnnouncement(session: Row, results: SearchReference[], discovered: readonly string[]): void {
  const inWindow = new Set(discovered);
  const announced = new Set(Array.isArray(session.announced_discovered_tools) ? session.announced_discovered_tools.filter((name): name is string => typeof name === "string") : []);
  const pending = Array.isArray(session.pending_tool_discovery) ? session.pending_tool_discovery.filter(isDict) : [];
  const queued = new Set(pending.map((entry) => String(entry.name)));
  const merged = [...pending, ...results.filter((reference) => !reference.deferred && inWindow.has(reference.name) && !announced.has(reference.name) && !queued.has(reference.name))
    .map((reference) => ({ name: reference.name, description: reference.description }))];
  if (merged.length !== pending.length) session.pending_tool_discovery = merged;
}

/** Persist the one-time hidden discovery announcement; `announced_discovered_tools` keeps it from ever repeating. */
export function flushDiscoveredToolsAnnouncement(session: Row): void {
  const pending = Array.isArray(session.pending_tool_discovery) ? session.pending_tool_discovery.filter(isDict) : [];
  delete session.pending_tool_discovery;
  const references = pending
    .filter((entry) => typeof entry.name === "string" && !!entry.name && typeof entry.description === "string")
    .map((entry) => ({ name: entry.name as string, description: entry.description as string }))
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
  if (!references.length || !Array.isArray(session.messages)) return;
  const announced = new Set(Array.isArray(session.announced_discovered_tools) ? session.announced_discovered_tools.filter((name): name is string => typeof name === "string") : []);
  const fresh = references.filter((entry) => !announced.has(entry.name));
  if (!fresh.length) return;
  const body = ["Tools discovered with tool_search are now part of this session's tool view and can be called directly:",
    ...fresh.map((entry) => `- ${entry.name}: ${entry.description}`)].join("\n");
  session.messages.push({ role: "user", content: wrapSystemReminderForSource("tool_discovery", body), _meta_source: "tool_discovery", _discovered_tools: true });
  session.announced_discovered_tools = [...new Set([...announced, ...fresh.map((entry) => entry.name)])];
}

export function createToolSearchTool(session: () => Row | null, binding: ProviderToolSearchBinding): ToolDefinition<SearchInput, SearchData> {
  return {
    name: SEARCH_TOOL,
    description: "Search the tool catalog of enabled plugins by keywords and return real tool references. " +
      "Non-deferred matches become callable from the next request; deferred matches are callable in the same turn through deferred_tool_call.",
    inputSchema,
    gate: SEARCH_TOOL,
    mutating: false,
    concurrencySafe: true,
    requires: {},
    async run(input, env): Promise<ToolResult<SearchData>> {
      const scopedEnv = env as ScopedToolEnv;
      const current = typeof scopedEnv.currentSession === "function" ? scopedEnv.currentSession() : session();
      if (!current || scopedEnv.owner !== undefined && current.id !== scopedEnv.owner) {
        return failure("unknown_session", "tool_search needs the current session to record discovered tools");
      }
      const mode = resolveToolSearchMode(binding.provider?.() ?? null);
      if (mode === "native") {
        // The provider declares the protocol capability but no provider-side
        // search surface is wired in this build: fail instead of faking results.
        return failure("native_tool_search_unavailable", "native tool search is enabled for this provider's protocol, but no provider-side search surface is wired; no result is available");
      }
      const { limit, maxDiscovered } = searchOptions(current);
      const results = searchToolCatalog(input.query, binding.catalog())
        .slice(0, limit)
        .map((entry): SearchReference => ({ name: entry.name, description: String(entry.description ?? ""), deferred: entry.shouldDefer === true }));
      const discovered = recordDiscovered(current, results.filter((reference) => !reference.deferred).map((reference) => reference.name), maxDiscovered);
      if (discovered) queueDiscoveredAnnouncement(current, results, discovered);
      const output = results.length
        ? `${results.length} tool(s) match ${JSON.stringify(input.query)}:\n${pyJsonDumps(results.map(({ name, description, deferred }) => ({ name, description, deferred })))}\n` +
          "These names are real registered tools of enabled plugins. Non-deferred ones enter the tool view on the next request; " +
          "deferred ones (deferred: true) are callable in this same turn with deferred_tool_call({tool: name, input: arguments})."
        : `No registered tool matches ${JSON.stringify(input.query)}. Try shorter or different keywords; matches return real tool names of enabled plugins.`;
      return { ok: true, output, data: { query: input.query, mode, results, discovered_tools: discovered } };
    },
  };
}
