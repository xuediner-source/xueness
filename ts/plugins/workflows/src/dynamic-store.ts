/** Durable, private JSON records for native dynamic workflows. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pyEncodeUtf8, pyJsonDumps, PyValueError, uuid4Hex } from "@xueness/contracts";
import type { HeldFileLock } from "@xueness/sessions";
import { ensurePrivateDirectory, isSymlink, lockPath, writeJsonAtomic } from "./state-file.ts";
import { compileDynamicWorkflow } from "./dynamic-compile.ts";
import { resolvePath, workspaceFingerprint } from "./plan.ts";
import type { DynamicNode, DynamicWorkflowRun } from "./dynamic-types.ts";

const ID = /^[a-f0-9]{32}$/;
const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 2;
const IMPORTED_NODE = "importedCache";

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function asRun(value: unknown): DynamicWorkflowRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PyValueError("invalid dynamic workflow record");
  const run = value as Partial<DynamicWorkflowRun>;
  if (typeof run.id !== "string" || !ID.test(run.id) || typeof run.root !== "string" ||
      typeof run.source !== "string" || !run.actors || !run.nodes || !Array.isArray(run.events) || !Array.isArray(run.reports)) {
    throw new PyValueError("incomplete dynamic workflow record");
  }
  return value as DynamicWorkflowRun;
}

/** Per-state-directory dynamic workflow records under `<state>/dynamic-workflows`. */
export class DynamicWorkflowStore {
  readonly stateDir: string;
  readonly directory: string;

  constructor(stateDir: string) {
    if (isSymlink(stateDir)) throw new PyValueError("dynamic workflow state directory cannot be a symlink");
    this.stateDir = resolvePath(stateDir);
    this.directory = join(this.stateDir, "dynamic-workflows");
    if (isSymlink(join(this.stateDir, "dynamic-workflows"))) throw new PyValueError("dynamic workflow directory cannot be a symlink");
    ensurePrivateDirectory(this.directory, "dynamic workflow directory cannot be a symlink");
  }

  #safe(): void {
    if (isSymlink(this.stateDir) || isSymlink(this.directory)) throw new PyValueError("dynamic workflow directory cannot be a symlink");
  }

  path(id: unknown, suffix = ".json"): string {
    this.#safe();
    if (typeof id !== "string" || !ID.test(id)) throw new PyValueError("invalid dynamic workflow id");
    const path = join(this.directory, `${id}${suffix}`);
    if (isSymlink(path)) throw new PyValueError("dynamic workflow file cannot be a symlink");
    return path;
  }

  /** Acquire the single-owner runner lock; callers must release it. */
  acquire(id: unknown): HeldFileLock {
    return lockPath(this.path(id, ".runner"), { blocking: false });
  }

  #withLock<T>(id: unknown, body: () => T, shared = false): T {
    const held = lockPath(this.path(id, ".lock"), { shared });
    try { return body(); } finally { held.release(); }
  }

  #loadUnlocked(id: unknown): DynamicWorkflowRun {
    return asRun(JSON.parse(readFileSync(this.path(id), "utf8")) as unknown);
  }

  load(id: unknown): DynamicWorkflowRun {
    return this.#withLock(id, () => this.#loadUnlocked(id), true);
  }

  update(id: unknown, change: (run: DynamicWorkflowRun) => void): DynamicWorkflowRun {
    return this.#withLock(id, () => {
      const run = this.#loadUnlocked(id);
      change(run);
      run.updatedAt = now();
      writeJsonAtomic(this.directory, ".dynamic-workflow-", this.path(id), run);
      return run;
    });
  }

  create(input: {
    parentSessionId: string; root: string; name: string; source: string;
    maxConcurrency?: number; writable?: boolean;
  }): DynamicWorkflowRun {
    if (!input || typeof input.parentSessionId !== "string" || !ID.test(input.parentSessionId)) {
      throw new PyValueError("parentSessionId must be a 32-character session id");
    }
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw new PyValueError("name must be 1..120 characters");
    if (typeof input.source !== "string") throw new PyValueError("source must be a string");
    const maxConcurrency = input.maxConcurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
      throw new PyValueError("maxConcurrency must be 1..8");
    }
    const writable = input.writable ?? false;
    if (typeof writable !== "boolean") throw new PyValueError("writable must be a boolean");
    const root = resolvePath(input.root);
    const compiled = compileDynamicWorkflow(input.source);
    if (compiled.diagnostics.length) {
      const error = new PyValueError("dynamic workflow source has diagnostics") as PyValueError & { diagnostics: typeof compiled.diagnostics };
      error.diagnostics = compiled.diagnostics;
      throw error;
    }
    const id = uuid4Hex();
    const timestamp = now();
    const run: DynamicWorkflowRun = {
      id, parentSessionId: input.parentSessionId, root, name: input.name.trim(), source: input.source,
      sourceHash: hash(input.source), status: "draft", maxConcurrency, writable, createdAt: timestamp, updatedAt: timestamp,
      actors: {}, nodes: {}, events: [], reports: [], allowReal: false, workspaceFingerprint: null,
    };
    this.#event(run, "created");
    writeJsonAtomic(this.directory, ".dynamic-workflow-", this.path(id), run);
    return run;
  }

  /**
   * Amend a settled run into a new draft. Read-only results are copied only
   * when the workspace fingerprint still matches; reports and events start fresh.
   */
  amend(id: unknown, source: string): DynamicWorkflowRun {
    const held = this.acquire(id);
    try {
      const previous = this.load(id);
      if (["queued", "running"].includes(previous.status)) {
        throw new PyValueError("only a settled dynamic workflow can be amended");
      }
      const next = this.create({
        parentSessionId: previous.parentSessionId, root: previous.root, name: previous.name, source,
        maxConcurrency: previous.maxConcurrency, writable: previous.writable,
      });
      const current = workspaceFingerprint(previous.root, this.stateDir);
      const reusable = !previous.writable && current !== null && previous.workspaceFingerprint === current;
      return this.update(next.id, (run) => {
        run.workspaceFingerprint = current;
        run.importedFrom = previous.id;
        if (reusable) {
          run.actors = JSON.parse(JSON.stringify(previous.actors)) as DynamicWorkflowRun["actors"];
          // Reused results do not move transcripts between run-owned session directories.
          for (const actor of Object.values(run.actors)) { delete actor.sessionId; actor.asks = 0; }
          const oldNodes = previous.nodes;
          for (const [nodeId, oldNode] of Object.entries(oldNodes)) {
            if ((oldNode.kind !== "ask" && oldNode.kind !== "read") || oldNode.status !== "completed") continue;
            const imported = JSON.parse(JSON.stringify(oldNode)) as DynamicNode & Record<string, unknown>;
            imported[IMPORTED_NODE] = true;
            run.nodes[nodeId] = imported;
          }
        }
        this.#event(run, reusable ? "amended_with_cache" : "amended");
      });
    } finally { held.release(); }
  }

  /** Approval digest bound to exactly the execution-relevant run settings. */
  digest(run: DynamicWorkflowRun): string {
    const body = pyJsonDumps({ root: run.root, sourceHash: run.sourceHash, writable: run.writable, maxConcurrency: run.maxConcurrency },
      { sortKeys: true, ensureAscii: false, separators: [",", ":"] });
    return createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
  }

  /** Internal metadata event helper shared with the engine. */
  static event(run: DynamicWorkflowRun, type: string, fields: { nodeId?: string; actorId?: string; phase?: string; message?: string } = {}): void {
    DynamicWorkflowStore.#appendEvent(run, type, fields);
  }

  #event(run: DynamicWorkflowRun, type: string): void { DynamicWorkflowStore.#appendEvent(run, type); }

  static #appendEvent(run: DynamicWorkflowRun, type: string, fields: { nodeId?: string; actorId?: string; phase?: string; message?: string } = {}): void {
    const seq = run.events.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
    run.events.push({ seq, type, at: now(), ...fields });
    if (run.events.length > 1000) run.events = run.events.slice(-1000);
  }

  list(): DynamicWorkflowRun[] {
    this.#safe();
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return []; }
    const runs: DynamicWorkflowRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!ID.test(id) || isSymlink(join(this.directory, name)) || !existsSync(join(this.directory, name))) continue;
      try { runs.push(this.load(id)); } catch { /* Ignore corrupt or concurrently removed records. */ }
    }
    return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
