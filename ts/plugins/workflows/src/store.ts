/**
 * Durable workflow records (Python `WorkflowStore`): one JSON file per run
 * under `<state>/workflows`, replaced atomically under a per-run flock that
 * Python and TypeScript share. `.runner` is the single-owner lock a detached
 * worker holds while it drives the run.
 */
import { existsSync, fstatSync, mkdirSync, openSync, closeSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDict, numericValue, pyEquals, pySlice, pyStrip, pyTruthy, PyValueError, uuid4Hex, isPyIntValue, pyLen } from "@xueness/contracts";
import { type HeldFileLock } from "@xueness/sessions";
import { ACTIVE, ID, resolvePath, stamp, validatePlan, workflowPlanDigest, workspaceFingerprint, type Row } from "./plan.ts";
import { isSymlink, lockPath, readJson, writeJsonAtomic } from "./state-file.ts";

/** Starts the detached owner of one queued run; throws when it cannot start. */
export type WorkerLauncher = (store: WorkflowStore, wid: string) => void;
let defaultLauncher: WorkerLauncher | null = null;
/** The host's worker launcher (the server and CLI set it once). */
export function setWorkerLauncher(launcher: WorkerLauncher | null): void { defaultLauncher = launcher; }

export class WorkflowStore {
  readonly state: string;
  readonly directory: string;
  readonly launcher: WorkerLauncher | null;
  constructor(state: string, options: { launcher?: WorkerLauncher } = {}) {
    this.state = resolvePath(state);
    this.directory = join(this.state, "workflows");
    if (isSymlink(this.directory)) throw new PyValueError("workflow directory cannot be a symlink");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.launcher = options.launcher ?? null;
  }

  path(wid: unknown, suffix = ".json"): string {
    if (typeof wid !== "string" || !ID.test(wid)) throw new PyValueError("invalid workflow id");
    const path = join(this.directory, wid + suffix);
    if (isSymlink(path)) throw new PyValueError("workflow file cannot be a symlink");
    return path;
  }

  lock(wid: unknown, suffix = ".lock", options: { blocking?: boolean; shared?: boolean } = {}): HeldFileLock {
    return lockPath(this.path(wid, suffix), options);
  }

  withLock<T>(wid: unknown, suffix: string, options: { blocking?: boolean; shared?: boolean }, body: () => T): T {
    const held = this.lock(wid, suffix, options);
    try { return body(); } finally { held.release(); }
  }

  load(wid: unknown): Row { return this.withLock(wid, ".lock", { shared: true }, () => this.loadUnlocked(wid)); }
  loadUnlocked(wid: unknown): Row { return readJson(this.path(wid)) as Row; }
  save(record: Row): void { this.withLock(record.id, ".lock", {}, () => this.saveUnlocked(record)); }
  saveUnlocked(record: Row): void { writeJsonAtomic(this.directory, ".workflow-", this.path(record.id), record); }

  update(wid: unknown, change: (record: Row) => void): Row {
    return this.withLock(wid, ".lock", {}, () => {
      const record = this.loadUnlocked(wid);
      change(record);
      record.updated_at = stamp();
      this.saveUnlocked(record);
      return record;
    });
  }

  event(record: Row, kind: string, fields: Row = {}): void {
    record.sequence = Number(numericValue(Object.hasOwn(record, "sequence") ? record.sequence : 0)) + 1;
    const events = Object.hasOwn(record, "events") ? record.events as Row[] : (record.events = []) as Row[];
    events.push({ seq: record.sequence, at: stamp(), type: kind, ...fields });
    record.events = events.slice(-500);
  }

  /** One durable run; `ownerSession` makes it a dynamic run of that conversation. */
  create(planValue: unknown, rootPath: string, reuse?: unknown, ownerSession?: unknown): Row {
    const root = resolvePath(rootPath);
    const plan = validatePlan(planValue, root);
    const wid = uuid4Hex();
    const nodes: Record<string, Row> = Object.fromEntries((plan.nodes as Row[]).map((node) => [node.id as string, { status: "pending", attempts: 0 }]));
    const record: Row = { id: wid, root, plan, status: "created", nodes, concurrency: plan.concurrency, control: "run", created_at: stamp(),
      updated_at: stamp(), events: [], sequence: 0, cache_fingerprint: workspaceFingerprint(root, this.state) };
    record.plan_digest = workflowPlanDigest(record);
    if (typeof ownerSession === "string" && ID.test(ownerSession)) record.owner_session = ownerSession;
    if (pyTruthy(reuse)) {
      const previous = this.load(reuse);
      if (ACTIVE.has(previous.status) || previous.root !== root) throw new PyValueError("reuse requires a settled run in the same workspace");
      const current = workspaceFingerprint(root, this.state);
      const matches = current !== null && previous.cache_fingerprint === current;
      const oldSpecs = new Map(((previous.plan as Row).nodes as Row[]).map((node) => [node.id, node]));
      const reusable = new Set<string>();
      for (let added = true; added;) {
        added = false;
        for (const node of plan.nodes as Row[]) {
          const id = node.id as string;
          const old = (previous.nodes as Record<string, Row>)[id] ?? {};
          if (matches && !reusable.has(id) && oldSpecs.has(id) && pyEquals(oldSpecs.get(id), node) && old.status === "completed" && (node.needs as string[]).every((need) => reusable.has(need))) {
            nodes[id] = { ...old, reused_from: reuse };
            reusable.add(id);
            added = true;
          }
        }
      }
      record.reused_from = reuse;
      record.reuse_cache_valid = matches;
    }
    this.event(record, "created");
    this.save(record);
    return record;
  }

  /** Amend a settled run in place; prior approval and results are invalidated. */
  amend(wid: unknown, planValue: unknown, rootPath: string): Row {
    const root = resolvePath(rootPath);
    const plan = validatePlan(planValue, root);
    return this.update(wid, (record) => {
      if (ACTIVE.has(record.status) || record.status === "awaiting_user") throw new PyValueError("pause or settle the workflow before amending it");
      if (record.root !== root) throw new PyValueError("workflow must stay in its original workspace");
      record.plan = plan;
      record.plan_digest = workflowPlanDigest(record);
      record.nodes = Object.fromEntries((plan.nodes as Row[]).map((node) => [node.id as string, { status: "pending", attempts: 0 }]));
      record.concurrency = plan.concurrency;
      record.control = "run";
      record.status = "created";
      record.cache_fingerprint = workspaceFingerprint(root, this.state);
      this.event(record, "amended");
    });
  }

  /** Checks before the actor transcript is answered (the answer itself is the host's). */
  actorAwaiting(wid: unknown, nodeId: unknown, answer: unknown): { record: Row; sessionId: string } {
    if (typeof answer !== "string" || !pyStrip(answer) || pyLen(answer) > 5000) throw new PyValueError("answer must be 1..5000 characters");
    const record = this.load(wid);
    const nodes = isDict(record.nodes) ? record.nodes : {};
    const node = typeof nodeId === "string" && isDict(nodes[nodeId]) ? nodes[nodeId] as Row : {};
    if (record.status !== "awaiting_user" || node.status !== "awaiting_user" || !pyTruthy(node.session_id)) throw new PyValueError("workflow actor is not awaiting an answer");
    return { record, sessionId: node.session_id as string };
  }

  actorAnswered(wid: unknown, nodeId: string, answer: string): Row {
    return this.update(wid, (row) => {
      (row.nodes as Record<string, Row>)[nodeId]!.status = "pending";
      this.event(row, "actor_answered", { node: nodeId, answer: pySlice(answer, 1000) });
      row.status = "paused";
      row.control = "pause";
    });
  }

  list(): Row[] {
    const result: Row[] = [];
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return result; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const stem = name.slice(0, -5);
      if (!ID.test(stem) || isSymlink(join(this.directory, name))) continue;
      try {
        const record = this.load(stem);
        const view: Row = {};
        for (const key of ["id", "status", "created_at", "updated_at", "root", "concurrency"]) {
          if (!Object.hasOwn(record, key)) throw new PyValueError("incomplete workflow record");
          view[key] = record[key];
        }
        view.name = (record.plan as Row).name;
        if (!isDict(record.plan) || !Object.hasOwn(record.plan, "name")) continue;
        result.push(view);
      } catch { continue; }
    }
    return result.sort((a, b) => Number(numericValue(b.updated_at)) - Number(numericValue(a.updated_at)));
  }

  launch(wid: unknown, approved = false, allowReal = false, expectedDigest: string | null = null): Row {
    this.withLock(wid, ".runner", { blocking: false }, () => {
      this.update(wid, (record) => {
        if (ACTIVE.has(record.status)) throw new PyValueError("run already active; recover a stale run first");
        if (expectedDigest !== null && workflowPlanDigest(record) !== expectedDigest) throw new PyValueError("workflow plan changed after approval");
        const specs = (record.plan as Row).nodes as Row[];
        if (specs.some((node) => node.kind === "command") && !approved) throw new PyValueError("explicit approval of this plan is required");
        if (specs.some((node) => node.kind === "agent") && !allowReal) throw new PyValueError("real model execution is not enabled");
        for (const node of Object.values(record.nodes as Record<string, Row>)) if (node.status !== "completed") node.status = "pending";
        record.status = "queued"; record.control = "run";
        this.event(record, "queued");
      });
      const launcher = this.launcher ?? defaultLauncher;
      try {
        if (!launcher) throw Object.assign(new Error("workflow worker launcher is not configured"), { code: "ENOEXEC", syscall: "spawn" });
        launcher(this, wid as string);
      } catch (error) {
        this.update(wid, (record) => { record.status = "failed"; });
        throw error;
      }
    });
    return this.load(wid);
  }

  control(wid: unknown, action: unknown, concurrency?: unknown): Row {
    if (action === "recover") {
      return this.withLock(wid, ".runner", { blocking: false }, () => this.update(wid, (record) => {
        if (!ACTIVE.has(record.status)) throw new PyValueError("only a stale active run can be recovered");
        for (const node of Object.values(record.nodes as Record<string, Row>)) {
          if (node.status === "running") { node.status = "interrupted"; node.error = "worker disappeared; effects may have occurred"; }
        }
        record.status = "interrupted"; record.control = "pause";
        this.event(record, "recovered");
      }));
    }
    return this.update(wid, (record) => {
      if (action === "concurrency") {
        if (!isPyIntValue(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 8) throw new PyValueError("concurrency must be 1..8");
        record.concurrency = concurrency;
      } else if (action === "pause" || action === "cancel") {
        if (!ACTIVE.has(record.status)) throw new PyValueError("run is not active");
        record.control = action;
        record.status = action === "pause" ? "pausing" : "stopping";
      } else throw new PyValueError("unknown control action");
      this.event(record, action as string, { concurrency: record.concurrency });
    });
  }

  log(wid: unknown, node: unknown): { output: string; truncated: boolean } {
    const record = this.load(wid);
    if (typeof node !== "string" || !Object.hasOwn(record.nodes as Row, node)) throw new PyValueError("node not found");
    const path = this.path(wid, "." + node + ".log");
    if (!existsSync(path)) return { output: "", truncated: false };
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(16000, size));
      const read = buffer.length ? readSync(fd, buffer, 0, buffer.length, Math.max(0, size - 16000)) : 0;
      return { output: buffer.subarray(0, read).toString("utf8"), truncated: size > 16000 };
    } finally { closeSync(fd); }
  }
}

/** `FileNotFoundError` from a record read. */
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
