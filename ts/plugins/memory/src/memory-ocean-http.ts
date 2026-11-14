/**
 * Memory Ocean HTTP, under the memory plugin's `/api/memory` family:
 *
 *   GET  /api/memory/ocean[?root=<workspace>]          graph view; `root` marks this project's memories
 *   POST /api/memory/ocean/memories                     add a memory by hand
 *   POST /api/memory/ocean/memories/<id>                edit (with the version last read)
 *   POST /api/memory/ocean/memories/<id>/forget         delete for good (`confirmed: true`)
 *
 * When `XUENESS_MEMORY_ROOT` is set, the curated track entries for the
 * workspace join the view as read-only lights.
 */
import { buildMemoryIndex } from "./memory-index.ts";
import { pyResolve } from "./memory.ts";
import { oceanGraph } from "./memory-ocean-graph.ts";
import { MemoryOceanStore, OceanError, projectOf, type OceanMemory } from "./memory-ocean-store.ts";

type Reply = [number, unknown];
type Row = Record<string, unknown>;
export const OCEAN_HTTP_ROUTES = ["GET /api/memory/ocean", "POST /api/memory/ocean/memories", "POST /api/memory/ocean/memories/:id", "POST /api/memory/ocean/memories/:id/forget"] as const;
const ID = /^m_[0-9a-f]{12}$/;

export interface OceanHttpOptions { stateDir: string; projectDir: string; memoryRoot: () => string | null }

export function ownsOcean(method: string, parts: readonly string[]): boolean {
  if (parts[0] !== "api" || parts[1] !== "memory" || parts[2] !== "ocean") return false;
  if (parts.length === 3) return method === "GET";
  return parts[3] === "memories" && parts.length >= 4 && parts.length <= 6;
}

function rootOf(query: Record<string, unknown>, fallback: string): string {
  const value = Array.isArray(query.root) ? query.root[0] : query.root;
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new OceanError(400, "invalid workspace");
  return value;
}

/** Curated track entries as read-only memories (memory and user tracks are global; the key track belongs to the project). */
function curated(memoryRoot: string | null, root: string): OceanMemory[] {
  if (!memoryRoot) return [];
  const index = buildMemoryIndex(memoryRoot, pyResolve(root));
  if (!index.ok) return [];
  const project = projectOf(root);
  return index.entries.slice(0, 300).map((entry) => {
    const first = entry.body.split("\n")[0] ?? entry.body;
    return { id: entry.id, summary: Array.from(first).length > 140 ? Array.from(first).slice(0, 139).join("") + "…" : first, text: entry.body,
      kind: entry.track === "user" ? "preference" : "fact", tags: [entry.track === "key" ? "KEY.md" : entry.track === "user" ? "USER.md" : "MEMORY.md"],
      importance: 3, scope: entry.track === "key" ? "project" : "global", project: entry.track === "key" ? project : null, links: [], status: "active",
      source: { by: "user", title: entry.source.file }, createdAt: index.generatedAt, updatedAt: index.generatedAt, version: 0, recalls: 0, lastRecalledAt: null };
  });
}

export function oceanDispatch(options: OceanHttpOptions, method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown): Reply {
  const store = new MemoryOceanStore(options.stateDir);
  const body: Row = data && typeof data === "object" && !Array.isArray(data) ? data as Row : {};
  try {
    if (parts.length === 3) {
      const root = rootOf(query, options.projectDir);
      const file = store.read();
      return [200, oceanGraph(file.memories, file.events, projectOf(root), curated(options.memoryRoot(), root))];
    }
    if (method !== "POST") return [405, { error: "method not allowed" }];
    if (parts.length === 4) {
      const root = typeof body.root === "string" ? rootOf({ root: body.root }, options.projectDir) : options.projectDir;
      const saved = store.remember(body, { root, source: { by: "user" } });
      return [200, { memory: saved.memory, merged: saved.merged }];
    }
    const id = parts[4]!;
    if (!ID.test(id)) return [404, { error: "memory not found" }];
    if (parts.length === 6) {
      if (parts[5] !== "forget") return [404, { error: "not found" }];
      if (body.confirmed !== true) return [400, { error: "forgetting a memory needs confirmed: true" }];
      store.forget(id);
      return [200, { forgotten: id }];
    }
    return [200, { memory: store.update(id, body) }];
  } catch (error) {
    if (error instanceof OceanError) return [error.status, { error: error.message }];
    throw error;
  }
}
