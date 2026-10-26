/** world.run and world reads: nested runs, usage accounting, input-versioned cache, cross-actor context. */
import { createHash } from "node:crypto";
import { pyEncodeUtf8 } from "@xueness/contracts";

/** Per-run accounting: every ask, read, child run and cache decision is traceable to one run id. */
export interface WorldRunUsage { asks: number; reads: number; subruns: number; cacheHits: number; cacheMisses: number }

/** A settled run: ownership chain (parent/root), the input version it ran against, and its usage. */
export interface WorldRunRecord {
  runId: string; name: string; parentRunId: string | null; rootRunId: string; ownerActorId?: string;
  inputVersion: number; inputFingerprint: string; cached: boolean;
  status: "completed" | "failed"; usage: WorldRunUsage; startedAt: string; finishedAt?: string;
  result?: unknown; error?: string;
}

/** One attributed world read: which run (and actor) read which key. */
export interface WorldReadLogEntry { runId: string; rootRunId: string; actorId?: string; key: string; at: string }

/** What an executor sees. `ctx.run` nests; `ctx.read` reads the world; `ctx.share` hands values to other actors. */
export interface WorldRunContext {
  runId: string; parentRunId: string | null; rootRunId: string; ownerActorId?: string;
  run(name: string, args: unknown, options?: { actorId?: string }): Promise<unknown>;
  read(key: string): Promise<unknown>;
  share(key: string, value: unknown): void;
  shared(key: string): unknown;
  usage: WorldRunUsage;
}

export type WorldExecutor = (args: unknown, ctx: WorldRunContext) => Promise<unknown>;
export interface WorldWorkflowSpec { executor: WorldExecutor; cache?: boolean }

export interface WorkflowWorldOptions {
  /** Backing read function; without it every read fails closed. */
  read?(key: string): Promise<unknown>;
  /** Maximum cached entries per workflow name (default 8, 0 disables caching). */
  cacheLimit?: number;
  /** Depth guard for nested runs (default 8). */
  maxDepth?: number;
  now?(): string;
}

const emptyUsage = (): WorldRunUsage => ({ asks: 0, reads: 0, subruns: 0, cacheHits: 0, cacheMisses: 0 });

/** Stable JSON: object keys sorted recursively so `{a:1,b:2}` and `{b:2,a:1}` are one input. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Canonical fingerprint of run input: the cache follows input versions, so equal inputs replay and any change misses. */
export function inputFingerprint(name: string, args: unknown): string {
  return createHash("sha256").update(pyEncodeUtf8(canonicalJson({ name, args }))).digest("hex");
}

/**
 * The public world SDK: register workflows, then `world.run(name, args)` from
 * the host or `ctx.run(...)` from an executor to nest. Sub-run ownership is
 * recorded (parentRunId/rootRunId/ownerActorId), usage rolls up the tree, and
 * cached results are only replayed when the input fingerprint — the input
 * version — matches exactly.
 */
export class WorkflowWorld {
  readonly #workflows = new Map<string, WorldWorkflowSpec>();
  readonly #options: WorkflowWorldOptions;
  readonly #records: WorldRunRecord[] = [];
  readonly #reads: WorldReadLogEntry[] = [];
  readonly #scopes = new Map<string, Map<string, unknown>>();
  readonly #cache = new Map<string, { fingerprint: string; inputVersion: number; value: unknown }[]>();
  readonly #versions = new Map<string, number>();
  #seq = 0;

  constructor(options: WorkflowWorldOptions = {}) { this.#options = options; }

  register(name: string, spec: WorldWorkflowSpec): this {
    if (typeof name !== "string" || !name.trim()) throw new Error("world workflow name must be non-empty");
    if (typeof spec.executor !== "function") throw new Error("world workflow requires an executor function");
    this.#workflows.set(name, { executor: spec.executor, ...(spec.cache === undefined ? {} : { cache: spec.cache }) });
    return this;
  }

  /** Top-level entry point: launches a root run owned by the host. */
  run(name: string, args: unknown, options: { actorId?: string } = {}): Promise<unknown> {
    return this.#launch(name, args, null, null, options.actorId);
  }

  /** Run records, oldest first: the ownership and usage ledger. */
  records(): readonly WorldRunRecord[] { return this.#records; }
  record(runId: string): WorldRunRecord | undefined { return this.#records.find(record => record.runId === runId); }
  /** Children of a run, in launch order — the nesting audit trail. */
  children(runId: string): readonly WorldRunRecord[] { return this.#records.filter(record => record.parentRunId === runId); }
  /** Attributed reads, oldest first. */
  readLog(): readonly WorldReadLogEntry[] { return this.#reads; }

  async #launch(name: string, args: unknown, parent: WorldRunContext | null, parentRecord: WorldRunRecord | null, actorId?: string): Promise<unknown> {
    const spec = this.#workflows.get(name);
    if (!spec) throw new Error(`world workflow '${name}' is not registered`);
    const maxDepth = this.#options.maxDepth ?? 8;
    const depth = parentRecord ? this.#depthOf(parentRecord) + 1 : 0;
    if (depth > maxDepth) throw new Error(`world run nesting exceeds maxDepth ${maxDepth}`);
    const runId = `wr-${++this.#seq}`;
    const rootRunId = parentRecord?.rootRunId ?? runId;
    const fingerprint = inputFingerprint(name, args);
    const cacheable = (spec.cache ?? true) && (this.#options.cacheLimit ?? 8) > 0;
    const versions = this.#versions;
    let inputVersion = versions.get(`${name}#${fingerprint}`);
    if (inputVersion === undefined) {
      inputVersion = (versions.get(name) ?? 0) + 1;
      versions.set(`${name}#${fingerprint}`, inputVersion);
      versions.set(name, inputVersion);
    }
    const entry = cacheable ? this.#cacheEntries(name).find(hit => hit.fingerprint === fingerprint) : undefined;
    const usage = emptyUsage();
    const startedAt = (this.#options.now ?? (() => new Date().toISOString()))();
    const record: WorldRunRecord = {
      runId, name, parentRunId: parentRecord?.runId ?? null, rootRunId, ...(actorId === undefined ? {} : { ownerActorId: actorId }),
      inputVersion, inputFingerprint: fingerprint, cached: entry !== undefined, status: "completed", usage, startedAt,
    };
    this.#records.push(record);
    if (parent) { parent.usage.subruns += 1; }
    if (entry) {
      usage.cacheHits += 1;
      record.finishedAt = startedAt;
      record.result = entry.value;
      return entry.value;
    }
    usage.cacheMisses += cacheable ? 1 : 0;
    const context: WorldRunContext = {
      runId, parentRunId: record.parentRunId, rootRunId, ...(actorId === undefined ? {} : { ownerActorId: actorId }),
      run: (childName, childArgs, childOptions = {}) => this.#launch(childName, childArgs, context, record, childOptions.actorId),
      read: key => this.#worldRead(key, record, actorId, usage),
      share: (key, value) => this.#scope(rootRunId).set(key, value),
      shared: key => this.#scope(rootRunId).get(key),
      usage,
    };
    try {
      const result = await spec.executor(args, context);
      record.result = result;
      record.finishedAt = (this.#options.now ?? (() => new Date().toISOString()))();
      if (cacheable) {
        const entries = this.#cacheEntries(name);
        entries.unshift({ fingerprint, inputVersion, value: result });
        const limit = this.#options.cacheLimit ?? 8;
        if (entries.length > limit) entries.length = limit;
      }
      return result;
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = (this.#options.now ?? (() => new Date().toISOString()))();
      return Promise.reject(error);
    }
  }

  #depthOf(record: WorldRunRecord): number {
    let depth = 0, current: WorldRunRecord | undefined = record;
    while (current?.parentRunId) { current = this.record(current.parentRunId); depth += 1; }
    return depth;
  }

  #scope(rootRunId: string): Map<string, unknown> {
    let scope = this.#scopes.get(rootRunId);
    if (!scope) { scope = new Map(); this.#scopes.set(rootRunId, scope); }
    return scope;
  }

  #cacheEntries(name: string): { fingerprint: string; inputVersion: number; value: unknown }[] {
    let entries = this.#cache.get(name);
    if (!entries) { entries = []; this.#cache.set(name, entries); }
    return entries;
  }

  async #worldRead(key: string, record: WorldRunRecord, actorId: string | undefined, usage: WorldRunUsage): Promise<unknown> {
    const reader = this.#options.read;
    if (!reader) throw new Error(`world read of '${key}' failed: no read function is configured`);
    const value = await reader(key);
    usage.reads += 1;
    this.#reads.push({ runId: record.runId, rootRunId: record.rootRunId, ...(actorId === undefined ? {} : { actorId }), key, at: (this.#options.now ?? (() => new Date().toISOString()))() });
    return value;
  }
}
