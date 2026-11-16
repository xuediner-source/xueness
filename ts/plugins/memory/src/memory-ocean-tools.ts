/**
 * The agent's two Memory Ocean tools.
 *
 * `memory_remember` saves a memory straight away (the owner chose direct
 * saving: every memory is visible, editable and forgettable in Memory Ocean,
 * and memory can be switched off). The standard runtime offers it directly. The
 * lightweight runtime starts without it and finds it through `tool_search`: its
 * schema was a sixth of the tool schemas a lightweight request carries, and an 8K
 * window has no room for it. `memory_recall` searches on demand and is deferred: the run's
 * recalled memories are already in context, so it rarely needs a slot.
 * Both touch only the host state directory, never the workspace.
 */
import type { CapabilityDeclaration } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { MemoryOceanStore, OCEAN_KINDS, OceanError, projectOf } from "./memory-ocean-store.ts";
import { rankMemories } from "./memory-ocean-recall.ts";

type Row = Record<string, unknown>;
export const REMEMBER_TOOL = "memory_remember";
export const RECALL_TOOL = "memory_recall";
const REQUIRES: CapabilityDeclaration = { fs: { read: ["state"], write: ["state"] } };

const failure = (code: string, message: string): ToolResult<never> => ({ ok: false, output: message, error: { code, message } });
const sessionOf = (env: { currentSession?: () => Row | null }): Row => env.currentSession?.() ?? {};

export function rememberTool(store: () => MemoryOceanStore): ToolDefinition<Row> {
  return {
    name: REMEMBER_TOOL,
    description: "Save a durable memory for future conversations: a user preference, a project fact or decision, or a lesson or pitfall worth reusing. Save only stable, reusable information the user would want kept, never secrets or one-off details. Keep `text` short and self-contained. To correct an outdated memory, pass its id as `supersedes`.",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: {
      text: { type: "string", description: "The memory itself, self-contained (at most 2000 characters)." },
      summary: { type: "string", description: "One line, at most 140 characters; defaults to the first line of text." },
      kind: { type: "string", enum: [...OCEAN_KINDS], description: "preference, fact, decision, experience or pitfall (default fact)." },
      tags: { type: "array", items: { type: "string" }, maxItems: 8, description: "Short topic tags." },
      importance: { type: "integer", minimum: 1, maximum: 5, description: "1 trivial … 5 essential (default 3)." },
      scope: { type: "string", enum: ["project", "global"], description: "project (default): this workspace only; global: every project." },
      supersedes: { type: "string", description: "Id of a memory this one replaces." },
      related: { type: "array", items: { type: "string" }, maxItems: 5, description: "Ids of related memories." },
    } },
    gate: "planning", mutating: false, readOnly: false, concurrencySafe: false, requires: REQUIRES, subjectKind: "text",
    subject: (input) => typeof input.text === "string" ? input.text.slice(0, 200) : "",
    async run(input, env) {
      const session = sessionOf(env);
      try {
        const { memory, merged, superseded } = store().remember(input, { root: typeof session.root === "string" ? session.root : env.cwd, source: {
          by: "agent", ...typeof session.id === "string" ? { sessionId: session.id } : {},
          ...typeof session.active_turn_id === "string" ? { turnId: session.active_turn_id } : {},
          ...typeof session.title === "string" && session.title ? { title: session.title.slice(0, 120) } : {} } });
        const where = memory.scope === "global" ? "global" : `project ${memory.project?.label ?? ""}`.trim();
        const note = merged ? `Merged into existing memory ${memory.id}` : `Saved memory ${memory.id}`;
        return { ok: true, output: `${note} (${memory.kind}, ${where}): ${memory.summary}${superseded ? ` — replaces ${superseded}` : ""}`,
          data: { id: memory.id, merged, superseded, scope: memory.scope, kind: memory.kind } };
      } catch (error) {
        if (error instanceof OceanError) return failure("memory_refused", error.message);
        throw error;
      }
    },
  };
}

export function recallTool(store: () => MemoryOceanStore): ToolDefinition<Row> {
  return {
    name: RECALL_TOOL,
    description: "Search saved memories (Memory Ocean) when an earlier preference, decision or project fact may matter. Returns the best matches with their ids.",
    inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", description: "Keywords to look for." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "How many matches (default 5)." },
    } },
    gate: "planning", mutating: false, readOnly: true, concurrencySafe: true, shouldDefer: true, requires: REQUIRES, subjectKind: "text",
    subject: (input) => typeof input.query === "string" ? input.query.slice(0, 200) : "",
    async run(input, env) {
      if (typeof input.query !== "string" || !input.query.trim()) return failure("invalid_argument", "query is required");
      const limit = typeof input.limit === "number" ? Math.min(10, Math.max(1, Math.round(input.limit))) : 5;
      const session = sessionOf(env);
      const project = projectOf(typeof session.root === "string" ? session.root : env.cwd);
      let memories;
      try { memories = store().active(project); }
      catch (error) { if (error instanceof OceanError) return failure("memory_unavailable", error.message); throw error; }
      const hits = rankMemories(memories, input.query).filter((hit) => hit.reason === "match").slice(0, limit);
      if (!hits.length) return { ok: true, output: "No saved memory matches.", data: { matches: [] } };
      const matches = hits.map(({ memory }) => ({ id: memory.id, kind: memory.kind, scope: memory.scope, summary: memory.summary, text: memory.text, tags: memory.tags, updatedAt: memory.updatedAt }));
      return { ok: true, output: matches.map((match) => `(${match.id}) [${match.kind}${match.scope === "global" ? ", global" : ""}] ${match.summary}\n${match.text}`).join("\n\n"), data: { matches } };
    },
  };
}
