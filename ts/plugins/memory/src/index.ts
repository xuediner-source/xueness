/**
 * Cross-session memory as a TypeScript plugin (Python `bundled_plugins/memory`).
 *
 * The plugin owns no tools. Its agent extension (`memory.context`) loads the
 * three curated tracks from the operator's `XUENESS_MEMORY_ROOT` at the start of
 * every run, as Python's `load_run_memory` does, and adds them to every model
 * request without entering the journal:
 *  - standard runtime: one ZCode `relevant_memory` meta-user reminder right after
 *    the system prompt, led by ZCode's recall sentence and Python's untrusted preamble;
 *  - lightweight runtime: Python's injected block (`UNTRUSTED_PREAMBLE` + memory),
 *    after the workspace guidance and before the skills catalog.
 * Recall reset (ZCode `resetProjectMemoryRecall`, called after compaction and on
 * resume): a new compaction boundary in the journal, or a new run, rereads the
 * tracks from disk, so compacted context never loses memory and never keeps a stale copy.
 */
import type { AgentContext, AgentExtension, ModelRequest } from "@xueness/agent";
import { statSync } from 'node:fs';
import { wrapSystemReminderForSource } from "@xueness/agent";
import { pyStrip } from "@xueness/contracts";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { loadMemory, pyResolve, trackPaths, UNTRUSTED_PREAMBLE } from "./memory.ts";

export * from "./memory.ts";
export * from "./memory-index.ts";
export * from "./memory-recall.ts";

type Row = Record<string, unknown>;
export const MEMORY_ROOT_ENV = "XUENESS_MEMORY_ROOT";
export const RELEVANT_MEMORY_SOURCE = "relevant_memory";
/** ZCode `formatRelevantMemoryAttachment` lead sentence. */
export const MEMORY_RECALL_LEAD = "Retrieved for possible relevance — use only if it actually applies to what the user asked.";

/** Python `memory_api.memory_root()`: the configured root, or null when the variable is unset or blank. */
export function memoryRootFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const raw = env[MEMORY_ROOT_ENV];
  if (raw === undefined) return null;
  const stripped = pyStrip(raw);
  return stripped ? stripped : null;
}

export interface MemoryOptions {
  /** The memory root; defaults to `XUENESS_MEMORY_ROOT`. */
  memoryRoot?: () => string | null;
  /** Settings `general.memoryEnabled !== false`; read at each run start. */
  allowed?: () => boolean;
}

/** Python's run memory for one workspace: null when memory is off, unconfigured or empty. */
export function loadRunMemory(memoryRoot: string | null, root: string): string | null {
  if (!memoryRoot) return null;
  return loadMemory(memoryRoot, pyResolve(root)) || null;
}

const isBoundary = (row: Row): boolean => row._compact_summary === true || row._semantic_summary === true
  || row.role === "system" && typeof row.content === "string" && row.content.startsWith("Older history compacted");

/**
 * The compaction boundaries in the journal (ZCode summaries, semantic summaries and
 * deterministic "Older history compacted" rows); any change means the recall must be reset.
 * A later compaction replaces the earlier summary in place, so the identity uses each
 * boundary's `_message_id` and content length, not just how many there are.
 */
export function compactionEpoch(session: Row): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const marks: string[] = [];
  messages.forEach((row, index) => {
    if (!row || typeof row !== "object" || !isBoundary(row as Row)) return;
    const content = (row as Row).content;
    marks.push(`${index}:${String((row as Row)._message_id ?? "")}:${typeof content === "string" ? content.length : -1}`);
  });
  return marks.join("|");
}

/** The boundary rows themselves: a compaction always writes a new row object, even when its text matches an earlier one. */
const boundaryRows = (session: Row): Row[] => (Array.isArray(session.messages) ? session.messages : []).filter((row): row is Row => !!row && typeof row === "object" && isBoundary(row as Row));
const sameRows = (a: readonly Row[], b: readonly Row[]): boolean => a.length === b.length && a.every((row, index) => row === b[index]);

/** The standard-runtime request message carrying the memory (never journaled). */
export function relevantMemoryMessage(memory: string): Row {
  return { role: "user", content: wrapSystemReminderForSource(RELEVANT_MEMORY_SOURCE, `${MEMORY_RECALL_LEAD}\n\n${UNTRUSTED_PREAMBLE}\n\n${memory}`), _meta_source: RELEVANT_MEMORY_SOURCE };
}

const lightweight = (context: AgentContext): boolean => (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";

export function memoryExtension(options: MemoryOptions = {}): AgentExtension {
  const recall = new WeakMap<Row, { version: string; epoch: string; rows: Row[]; memory: string | null }>();
  const root = options.memoryRoot ?? (() => memoryRootFromEnv());
  const current = (context: AgentContext): string | null => {
    const session = context.session as Row;
    let state = recall.get(session);
    if (!state) { state = { version: '\0', epoch: "\0", rows: [], memory: null }; recall.set(session, state); }
    if (options.allowed?.() === false) { state.version = '\0'; state.memory = null; return null; }
    const directory = root();
    const version = directory ? directory + '|' + Object.values(trackPaths(directory, pyResolve(context.root))).map(path => {
      try { const stat = statSync(path, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeNs}`; } catch { return 'missing'; }
    }).join('|') : '';
    const epoch = compactionEpoch(session); const rows = boundaryRows(session);
    if (state.version !== version || state.epoch !== epoch || !sameRows(state.rows, rows)) { state.version = version; state.epoch = epoch; state.rows = rows; state.memory = loadRunMemory(directory, context.root); }
    return state.memory;
  };
  return {
    id: "memory", capabilities: ["memory.context"],
    beforeRun(context) { recall.delete(context.session as Row); },
    prepareRequest(context, request): ModelRequest {
      const memory = current(context);
      if (!memory) return request;
      if (lightweight(context)) return { ...request, injected: [...request.injected ?? [], `${UNTRUSTED_PREAMBLE}\n\n${memory}`] };
      if (request.messages[0]?.role !== "system") return request;
      return { ...request, messages: [request.messages[0], relevantMemoryMessage(memory), ...request.messages.slice(1)] };
    },
  };
}

export function createMemory(): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "memory", apply() { /* context only; no tools */ } }) };
}

/** The bundled entry. */
export const memory: BundledPlugin = createMemory();

export { createMemoryHttp } from "./http.ts";
export * from './memory-dream-types.ts';
export * from './memory-dream-service.ts';
export * from './memory-dream-http.ts';
export * from './memory-dream-diff.ts';
export * from './memory-dream-tools.ts';
export * from './memory-tool-contract.ts';
export * from './memory-tool-loop.ts';
export * from './memory-extraction.ts';
