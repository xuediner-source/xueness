/**
 * Drive one queued run to a settled state (Python `workflows.drive`).
 *
 * The owner holds `.runner` for the whole run: dispatch is capped by
 * `record.concurrency`, every finished node is written back with a
 * `node_finished` event, and the settle block keeps the record lock until the
 * runner lock is released. That order is deliberate in Python: a new launcher
 * may take `.runner` at once, but it still blocks on the record lock, so a
 * reader cannot offer a resume while the previous owner prevents it.
 */
import { isDict, numericValue } from "@xueness/contracts";
import { PyBlockingIOError, type HeldFileLock } from "@xueness/sessions";
import { stamp, workspaceFingerprint, type Row } from "./plan.ts";
import { type WorkflowStore } from "./store.ts";
// `RunControl` has one declaration (execute-command.ts); this re-exports it
// rather than redeclaring it, so the plugin's `export *` stays unambiguous.
export type { RunControl } from "./execute-command.ts";
import type { RunControl } from "./execute-command.ts";

/** Runs one ready node; `drive` only reads `status` from the returned row. */
export type NodeExecutor = (store: WorkflowStore, record: Row, spec: Row, control: RunControl) => Promise<Row>;

export interface DriveOptions {
  /** `is_enabled(state, "workflows")`; a disabled plugin pauses the run. */
  enabled?: () => boolean;
}

/** A dispatched node: `done` flips once, with the row the executor returned. */
interface Active {
  done: boolean;
  result: Row;
}

const RUNNER_POLL_MS = 50;
const EXECUTOR_FAILED: Row = { status: "failed", error: "node execution failed; inspect local configuration" };

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * `with store.lock(wid, '.runner'):` blocks until the launcher lets go. The
 * wait polls the nonblocking form instead, so a driver in a server process
 * never parks its event loop behind a peer's lock.
 */
async function acquireRunner(store: WorkflowStore, wid: string): Promise<HeldFileLock> {
  for (;;) {
    try { return store.lock(wid, ".runner", { blocking: false }); } catch (error) { if (!(error instanceof PyBlockingIOError)) throw error; }
    await pause(RUNNER_POLL_MS);
  }
}

function nodesOf(record: Row): Record<string, Row> {
  const nodes = record.nodes;
  return isDict(nodes) ? (nodes as Record<string, Row>) : {};
}

function specsOf(record: Row): Row[] {
  const plan = record.plan;
  return isDict(plan) && Array.isArray(plan.nodes) ? (plan.nodes as Row[]) : [];
}

/** Python's settlement precedence, in order (`control` first, `failed` last). */
export function settledStatus(record: Row): string {
  const nodes = Object.values(nodesOf(record));
  if (record.control === "pause") return "paused";
  if (record.control === "cancel") return "cancelled";
  if (nodes.some((node) => node.status === "awaiting_user")) return "awaiting_user";
  if (nodes.some((node) => node.status === "paused")) return "paused";
  if (nodes.every((node) => node.status === "completed")) return "completed";
  return "failed";
}

/** `is_enabled` may itself throw (a broken plugin state); Python pauses then too. */
function pluginEnabled(options: DriveOptions): boolean {
  try { return options.enabled ? options.enabled() : true; } catch { return false; }
}

export async function drive(
  store: WorkflowStore,
  wid: string,
  execute: NodeExecutor,
  control: RunControl,
  options: DriveOptions = {},
): Promise<void> {
  const runner = await acquireRunner(store, wid);
  try {
    if (store.load(wid).status !== "queued") return;
    store.update(wid, (record) => { record.status = "running"; store.event(record, "started"); });
    const active = new Map<string, Active>();
    let status = "failed";
    for (;;) {
      if (control.ownerGone()) store.control(wid, "cancel");
      if (!pluginEnabled(options)) store.update(wid, (row) => { row.control = "pause"; });
      for (const [nid, task] of [...active]) {
        if (!task.done) continue;
        store.update(wid, (row) => {
          const node = nodesOf(row)[nid];
          if (!node) return;
          Object.assign(node, task.result);
          node.ended_at = stamp();
          store.event(row, "node_finished", { node: nid, status: task.result.status });
        });
        active.delete(nid);
      }
      let record = store.load(wid);
      if (record.control === "run") {
        const limit = Number(numericValue(record.concurrency) ?? 1);
        for (const spec of specsOf(record)) {
          if (active.size >= limit) break;
          const nid = String(spec.id);
          const node = nodesOf(record)[nid];
          if (!node || node.status !== "pending") continue;
          const needs = Array.isArray(spec.needs) ? (spec.needs as string[]) : [];
          if (!needs.every((parent) => nodesOf(record)[parent]?.status === "completed")) continue;
          store.update(wid, (row) => {
            const target = nodesOf(row)[nid];
            if (!target) return;
            target.status = "running";
            target.started_at = stamp();
            target.attempts = Number(numericValue(target.attempts) ?? 0) + 1;
            store.event(row, "node_started", { node: nid });
          });
          const task: Active = { done: false, result: {} };
          active.set(nid, task);
          void execute(store, record, spec, control).then(
            (result) => { task.result = isDict(result) ? result : EXECUTOR_FAILED; task.done = true; },
            () => { task.result = EXECUTOR_FAILED; task.done = true; },
          );
        }
      }
      if (!active.size) { status = settledStatus(store.load(wid)); break; }
      await pause(RUNNER_POLL_MS);
    }
    // Join the executor before publishing a settled run. Hold the record lock
    // until `.runner` is released (Python's comment): a new launcher may
    // acquire `.runner` now, but it waits on this lock before it can queue.
    store.withLock(wid, ".lock", {}, () => {
      const row = store.loadUnlocked(wid);
      row.status = status;
      row.updated_at = stamp();
      if (status === "failed") {
        for (const node of Object.values(nodesOf(row))) if (node.status === "pending") node.status = "blocked";
      }
      store.event(row, "settled", { status });
      row.cache_fingerprint = workspaceFingerprint(String(row.root), store.state);
      store.saveUnlocked(row);
      runner.release();
    });
  } finally {
    runner.release();
  }
}
