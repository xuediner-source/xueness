/**
 * Memory Ocean: the memory plugin's own durable store, kept in the host state
 * directory so memory works without any setup (the curated tracks under
 * `XUENESS_MEMORY_ROOT` stay a separate, optional source).
 *
 *     <state>/memory/ocean.json     { version, memories[], events[] }
 *
 * A memory is one reusable fact with a one-line summary (read first) and its
 * full text (read when it fits), a kind, a scope (global or one project),
 * tags, an importance and links to other memories. Writes take a file lock and
 * replace the file atomically; a full store refuses new memories instead of
 * dropping old ones. Events (remember, recall, forget) feed the Memory Ocean
 * view's animations and are capped.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isLink, protectPrivateDirectory, withFileLockSync } from "@xueness/sessions";
import { projectHash, pyResolve } from "./memory.ts";
import { similarity, terms } from "./memory-ocean-terms.ts";

export const OCEAN_KINDS = ["preference", "fact", "decision", "experience", "pitfall"] as const;
export type OceanKind = (typeof OCEAN_KINDS)[number];
export type OceanScope = "global" | "project";
export const MAX_MEMORIES = 2000;
export const MAX_TEXT = 2000;
export const MAX_SUMMARY = 140;
export const MAX_TAGS = 8;
const MAX_EVENTS = 200;
const MAX_LINKS = 12;
/** Two memories in one scope whose terms overlap this much are the same memory. */
const DUPLICATE = 0.82;

export interface OceanLink { to: string; kind: "related" | "supersedes" }
export interface OceanSource { by: "agent" | "user"; sessionId?: string; turnId?: string; title?: string }
export interface OceanMemory {
  id: string; summary: string; text: string; kind: OceanKind; tags: string[]; importance: number;
  scope: OceanScope; project: { key: string; label: string } | null;
  links: OceanLink[]; status: "active" | "archived"; source: OceanSource;
  createdAt: string; updatedAt: string; version: number; recalls: number; lastRecalledAt: string | null;
}
export interface OceanEvent { at: string; kind: "remember" | "recall" | "forget" | "update"; ids: string[]; sessionId?: string }
interface OceanFile { version: 1; memories: OceanMemory[]; events: OceanEvent[] }

export class OceanError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface MemoryDraft {
  text?: unknown; summary?: unknown; kind?: unknown; tags?: unknown; importance?: unknown;
  scope?: unknown; supersedes?: unknown; related?: unknown;
}

const now = (): string => new Date().toISOString();
const chars = (value: string): number => Array.from(value).length;
const cut = (value: string, max: number): string => chars(value) <= max ? value : Array.from(value).slice(0, max - 1).join("") + "…";
const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*\S{6,}/iu;

/** The project a workspace root belongs to: the same key the curated KEY.md track uses. */
export function projectOf(root: string | null | undefined): { key: string; label: string } | null {
  if (typeof root !== "string" || !root.trim() || root.length > 4096 || root.includes("\0")) return null;
  const canonical = pyResolve(root);
  return { key: projectHash(canonical), label: basename(canonical) || canonical };
}

/** Validated draft fields; throws `OceanError(400)` with the reason. */
export function normalizeDraft(draft: MemoryDraft): { text: string; summary: string; kind: OceanKind; tags: string[]; importance: number; scope: OceanScope } {
  if (typeof draft.text !== "string" || !draft.text.trim()) throw new OceanError(400, "text is required");
  const text = draft.text.replace(/\r\n?/gu, "\n").trim();
  if (chars(text) > MAX_TEXT) throw new OceanError(400, `text is longer than ${MAX_TEXT} characters; save the reusable part only`);
  if (SECRET.test(text) || typeof draft.summary === "string" && SECRET.test(draft.summary)) throw new OceanError(400, "this looks like it contains a secret (key, token or password); secrets are never stored in memory");
  const given = typeof draft.summary === "string" ? oneLine(draft.summary) : "";
  const summary = cut(given || oneLine(text.split("\n")[0] ?? text), MAX_SUMMARY);
  const kind = (OCEAN_KINDS as readonly unknown[]).includes(draft.kind) ? draft.kind as OceanKind : "fact";
  const tags = [...new Set((Array.isArray(draft.tags) ? draft.tags : []).filter((tag): tag is string => typeof tag === "string")
    .map((tag) => cut(oneLine(tag).toLowerCase().replace(/^#/u, ""), 32)).filter(Boolean))].slice(0, MAX_TAGS);
  const rank = typeof draft.importance === "number" && Number.isFinite(draft.importance) ? Math.round(draft.importance) : 3;
  const importance = Math.min(5, Math.max(1, rank));
  const scope: OceanScope = draft.scope === "global" ? "global" : "project";
  return { text, summary, kind, tags, importance, scope };
}

export class MemoryOceanStore {
  readonly directory: string;
  readonly file: string;
  #cache: { stamp: string; data: OceanFile } | null = null;

  constructor(stateDir: string) {
    this.directory = join(stateDir, "memory");
    this.file = join(this.directory, "ocean.json");
  }

  /** Every memory and the recent events; a missing or unreadable store reads as empty. */
  read(): OceanFile {
    let stamp: string;
    try { const stat = statSync(this.file, { bigint: true }); stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`; }
    catch { return { version: 1, memories: [], events: [] }; }
    if (this.#cache?.stamp === stamp) return this.#cache.data;
    let data: OceanFile = { version: 1, memories: [], events: [] };
    try {
      if (isLink(this.file)) throw new Error("link");
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<OceanFile>;
      data = { version: 1, memories: Array.isArray(parsed.memories) ? parsed.memories.filter(valid) : [], events: Array.isArray(parsed.events) ? parsed.events : [] };
    } catch { /* a damaged store reads as empty; the next write replaces it */ }
    this.#cache = { stamp, data };
    return data;
  }

  active(project: { key: string } | null): OceanMemory[] {
    return this.read().memories.filter((memory) => memory.status === "active" && (memory.scope === "global" || !!project && memory.project?.key === project.key));
  }

  /** Save a memory; a near-duplicate in the same scope is merged into instead. */
  remember(draft: MemoryDraft, context: { root?: string | null; source: OceanSource }): { memory: OceanMemory; merged: boolean; superseded: string | null } {
    const fields = normalizeDraft(draft);
    const project = fields.scope === "project" ? projectOf(context.root) : null;
    if (fields.scope === "project" && !project) throw new OceanError(400, "a project memory needs a workspace; use scope \"global\"");
    return this.#mutate((data) => {
      const supersedes = typeof draft.supersedes === "string" && draft.supersedes ? data.memories.find((memory) => memory.id === draft.supersedes) : undefined;
      if (typeof draft.supersedes === "string" && draft.supersedes && !supersedes) throw new OceanError(404, `no memory ${draft.supersedes}`);
      const related = (Array.isArray(draft.related) ? draft.related : []).filter((id): id is string => typeof id === "string" && data.memories.some((memory) => memory.id === id)).slice(0, 5);
      const sameScope = (memory: OceanMemory): boolean => memory.status === "active" && memory.scope === fields.scope && (fields.scope === "global" || memory.project?.key === project?.key);
      const wanted = terms(`${fields.summary} ${fields.text}`);
      const twin = data.memories.find((memory) => memory !== supersedes && sameScope(memory) && similarity(wanted, terms(`${memory.summary} ${memory.text}`)) >= DUPLICATE);
      const at = now();
      if (twin) {
        twin.tags = [...new Set([...twin.tags, ...fields.tags])].slice(0, MAX_TAGS);
        twin.importance = Math.max(twin.importance, fields.importance);
        if (chars(fields.text) > chars(twin.text)) { twin.text = fields.text; twin.summary = fields.summary; }
        twin.updatedAt = at; twin.version += 1;
        addLinks(twin, related.map((to) => ({ to, kind: "related" as const })));
        record(data, { at, kind: "update", ids: [twin.id], sessionId: context.source.sessionId });
        return { memory: twin, merged: true, superseded: null };
      }
      if (data.memories.filter((memory) => memory.status === "active").length >= MAX_MEMORIES) throw new OceanError(409, `Memory Ocean is full (${MAX_MEMORIES} memories); forget some before saving more`);
      const memory: OceanMemory = { id: "m_" + randomBytes(6).toString("hex"), ...fields, project, links: [], status: "active",
        source: context.source, createdAt: at, updatedAt: at, version: 1, recalls: 0, lastRecalledAt: null };
      addLinks(memory, [...related.map((to) => ({ to, kind: "related" as const })), ...supersedes ? [{ to: supersedes.id, kind: "supersedes" as const }] : []]);
      if (supersedes) { supersedes.status = "archived"; supersedes.updatedAt = at; supersedes.version += 1; }
      data.memories.push(memory);
      prune(data);
      record(data, { at, kind: "remember", ids: [memory.id], sessionId: context.source.sessionId });
      return { memory, merged: false, superseded: supersedes?.id ?? null };
    });
  }

  /** Edit fields of one memory; `version` must match the stored one. */
  update(id: string, patch: MemoryDraft & { version?: unknown; status?: unknown }): OceanMemory {
    return this.#mutate((data) => {
      const memory = data.memories.find((item) => item.id === id);
      if (!memory) throw new OceanError(404, "memory not found");
      if (patch.version !== memory.version) throw new OceanError(409, "memory changed; reload before saving");
      const fields = normalizeDraft({ text: patch.text ?? memory.text, summary: patch.summary ?? memory.summary, kind: patch.kind ?? memory.kind,
        tags: patch.tags ?? memory.tags, importance: patch.importance ?? memory.importance, scope: memory.scope });
      Object.assign(memory, { text: fields.text, summary: fields.summary, kind: fields.kind, tags: fields.tags, importance: fields.importance });
      if (patch.status === "active" || patch.status === "archived") memory.status = patch.status;
      memory.updatedAt = now(); memory.version += 1;
      record(data, { at: memory.updatedAt, kind: "update", ids: [id] });
      return memory;
    });
  }

  /** Remove one memory for good, with every link that points at it. */
  forget(id: string): void {
    this.#mutate((data) => {
      const before = data.memories.length;
      data.memories = data.memories.filter((memory) => memory.id !== id);
      if (data.memories.length === before) throw new OceanError(404, "memory not found");
      for (const memory of data.memories) memory.links = memory.links.filter((link) => link.to !== id);
      record(data, { at: now(), kind: "forget", ids: [id] });
    });
  }

  /** Count a recall: these memories were put into a run's context. */
  recalled(ids: readonly string[], sessionId: string | undefined): void {
    if (!ids.length) return;
    try {
      this.#mutate((data) => {
        const at = now();
        for (const memory of data.memories) if (ids.includes(memory.id)) { memory.recalls += 1; memory.lastRecalledAt = at; }
        record(data, { at, kind: "recall", ids: [...ids], sessionId });
      });
    } catch { /* recall statistics never fail a run */ }
  }

  #mutate<T>(change: (data: OceanFile) => T): T {
    if (isLink(this.directory)) throw new OceanError(500, "the memory directory cannot be a link");
    if (!existsSync(this.directory)) { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); protectPrivateDirectory(this.directory); }
    return withFileLockSync(join(this.directory, ".ocean.lock"), { shared: false, timeoutSeconds: 5 }, () => {
      this.#cache = null;
      const data = structuredClone(this.read());
      const result = change(data);
      const temporary = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.#cache = null;
      return result;
    });
  }
}

function valid(value: unknown): value is OceanMemory {
  const memory = value as OceanMemory | null;
  return !!memory && typeof memory === "object" && typeof memory.id === "string" && typeof memory.text === "string" && typeof memory.summary === "string"
    && (OCEAN_KINDS as readonly string[]).includes(memory.kind) && Array.isArray(memory.tags) && Array.isArray(memory.links);
}

function addLinks(memory: OceanMemory, links: readonly OceanLink[]): void {
  for (const link of links) if (link.to !== memory.id && !memory.links.some((item) => item.to === link.to)) memory.links.push(link);
  memory.links = memory.links.slice(-MAX_LINKS);
}

function record(data: OceanFile, event: OceanEvent): void {
  data.events.push(event.sessionId ? event : { at: event.at, kind: event.kind, ids: event.ids });
  data.events = data.events.slice(-MAX_EVENTS);
}

/** Archived memories make room first, oldest first, when the store passes its cap. */
function prune(data: OceanFile): void {
  const excess = data.memories.length - MAX_MEMORIES;
  if (excess <= 0) return;
  const archived = data.memories.filter((memory) => memory.status === "archived").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, excess);
  const drop = new Set(archived.map((memory) => memory.id));
  data.memories = data.memories.filter((memory) => !drop.has(memory.id));
}
