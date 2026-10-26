/** F09.03: background memory-extraction scheduling after settled production turns. */
import { createHash } from "node:crypto";
import { isDict, pyEncodeUtf8 } from "@xueness/contracts";
import type { AgentContext, AgentExtension } from "@xueness/agent";
import { canonicalRoot, isInternal } from "./memory-dream-service.ts";
import type { MemoryDreamRow } from "./memory-dream-types.ts";

type Row = Record<string, unknown>;
const SESSION_ID = /^[a-f0-9]{32}$/;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== "";

export type MemoryExtractionOutcome = "succeeded" | "failed" | "cancelled";

export interface MemoryExtractionSettlement {
  sessionId: string;
  root: string;
  outcome: MemoryExtractionOutcome;
  row: MemoryDreamRow;
  turnId?: string;
}

export interface MemoryExtractionJob {
  root: string;
  sessionId: string;
  key: string;
  turnId: string | null;
}

/** Structurally compatible with the providers' ModelRequestAdmission.acquire. */
export interface MemoryExtractionAdmission {
  acquire(input: { signal?: AbortSignal }): Promise<{ release(): void }>;
}

export interface MemoryExtractionPorts {
  /** Memory and providers must both be on; checked again at job time. */
  enabled(): boolean;
  /** Auxiliary-call admission; the driver binds the shared provider governor. */
  admission?: MemoryExtractionAdmission;
  /** One background extraction; must honour the signal and never partially write. */
  extract(job: MemoryExtractionJob, signal: AbortSignal): Promise<void>;
}

export interface MemoryExtractionSchedulerOptions {
  ports: MemoryExtractionPorts;
  /** Concurrent extractions across different workspaces; one per workspace always. */
  maxParallel?: number;
  /** Bounded dedup memory of completed extraction keys; default 256. */
  maxSeen?: number;
}

const eligibleBody = (row: Row): string | null => {
  if (row.role !== "user" && row.role !== "assistant") return null;
  if (typeof row.content !== "string" || !row.content.trim()) return null;
  if (Object.hasOwn(row, "tool_calls") || truthy(row.tool_call_id) || truthy(row._meta_source) || row._input_kind === "guide" || row._input_kind === "background_notice") return null;
  return row.content;
};

/**
 * The dedup key: a digest of the session's eligible plain-body messages. Two
 * settlements with the same key carry the same extractable evidence, so the
 * second never schedules another extraction.
 */
export function extractionKey(row: MemoryDreamRow): string | null {
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const parts: string[] = [];
  for (const item of messages) {
    if (!isDict(item)) continue;
    const content = eligibleBody(item);
    if (content !== null) parts.push(`${item.role}:${sha256(pyEncodeUtf8(content))}`);
  }
  return parts.length ? sha256(parts.join("\n")) : null;
}

interface QueuedJob { id: number; rootKey: string; job: MemoryExtractionJob; controller: AbortController; done?: Promise<void> }

/** Filters mirroring the dream service: only local, non-internal sessions extract. */
export function extractionEligible(settlement: MemoryExtractionSettlement): boolean {
  if (!SESSION_ID.test(settlement.sessionId)) return false;
  if (settlement.outcome !== "succeeded") return false;
  const { row } = settlement;
  if (row.id !== undefined && row.id !== settlement.sessionId) return false;
  if (truthy(row.remote_connection) || isInternal(row)) return false;
  if (typeof row.root !== "string") return false;
  try { return canonicalRoot(row.root) === canonicalRoot(settlement.root); } catch { return false; }
}

/** Outcome mapping from the agent run loop's own terminal signals. */
export function settlementFromContext(context: Pick<AgentContext, "session" | "signal">): MemoryExtractionSettlement | null {
  const session = context.session as Row & { run_stop?: Row | null };
  const sessionId = typeof session.id === "string" ? session.id : null;
  const root = typeof session.root === "string" ? session.root : null;
  if (!sessionId || !root) return null;
  let outcome: MemoryExtractionOutcome | null = null;
  if (context.signal.aborted || session.run_stop?.code === "cancelled") outcome = "cancelled";
  else if (session.run_stop) outcome = "failed";
  else if (session.status === "completed") outcome = "succeeded";
  else if (session.status === "needs_review") outcome = "failed";
  if (!outcome) return null;
  return { sessionId, root, outcome, row: session as MemoryDreamRow, turnId: typeof session.active_turn_id === "string" ? session.active_turn_id : undefined };
}

export class MemoryExtractionScheduler {
  readonly #ports: MemoryExtractionPorts;
  readonly #maxParallel: number;
  readonly #maxSeen: number;
  readonly #queues = new Map<string, QueuedJob[]>();
  readonly #activeRoots = new Set<string>();
  readonly #active = new Map<number, QueuedJob>();
  readonly #seen = new Map<string, "extracted" | "cancelled" | "failed">();
  #settled = { succeeded: 0, failed: 0, cancelled: 0 };
  #outcomes = { extracted: 0, failed: 0, cancelled: 0 };
  #nextId = 0;
  #closed = false;

  constructor(options: MemoryExtractionSchedulerOptions) {
    this.#ports = options.ports;
    this.#maxParallel = Math.max(1, Math.floor(options.maxParallel ?? 2));
    this.#maxSeen = Math.max(1, Math.floor(options.maxSeen ?? 256));
  }

  stats(): { active: number; queued: number; settled: Readonly<Record<MemoryExtractionOutcome, number>>; outcomes: Readonly<Record<"extracted" | "failed" | "cancelled", number>> } {
    return { active: this.#active.size, queued: [...this.#queues.values()].reduce((sum, queue) => sum + queue.length, 0), settled: { ...this.#settled }, outcomes: { ...this.#outcomes } };
  }

  #remember(key: string, outcome: "extracted" | "cancelled" | "failed"): void {
    this.#seen.set(key, outcome);
    while (this.#seen.size > this.#maxSeen) this.#seen.delete(this.#seen.keys().next().value as string);
  }

  /**
   * One settled turn. Never throws: scheduling is observational to the run.
   * Failed and cancelled turns are counted but never enqueue; a successful
   * production turn enqueues unless its evidence key was already extracted.
   */
  settle(input: MemoryExtractionSettlement): boolean {
    if (input.outcome !== "succeeded") { this.#settled[input.outcome] += 1; return false; }
    this.#settled.succeeded += 1;
    if (this.#closed) return false;
    let key: string | null = null;
    try {
      if (!this.#ports.enabled() || !extractionEligible(input)) return false;
      key = extractionKey(input.row);
    } catch { return false; }
    if (!key) return false;
    const rootKey = sha256(canonicalRoot(input.root)), dedupe = `${rootKey}:${key}`;
    if (this.#seen.has(dedupe)) return false;
    const queued: QueuedJob = { id: this.#nextId++, rootKey, job: { root: canonicalRoot(input.root), sessionId: input.sessionId, key, turnId: input.turnId ?? null }, controller: new AbortController() };
    const list = this.#queues.get(rootKey) ?? [];
    list.push(queued);
    this.#queues.set(rootKey, list);
    this.#pump();
    return true;
  }

  #pump(): void {
    if (this.#closed) return;
    for (const [rootKey, queue] of this.#queues) {
      if (this.#active.size >= this.#maxParallel || this.#activeRoots.has(rootKey)) continue;
      const next = queue.shift();
      if (!queue.length) this.#queues.delete(rootKey);
      if (!next) continue;
      this.#activeRoots.add(rootKey);
      this.#active.set(next.id, next);
      next.done = this.#run(rootKey, next);
    }
  }

  async #run(rootKey: string, queued: QueuedJob): Promise<void> {
    const { job, controller } = queued;
    let outcome: "extracted" | "failed" | "cancelled" = "failed";
    try {
      if (!this.#ports.enabled()) { outcome = "cancelled"; return; }
      // The auxiliary call enters admission first; its ticket covers the whole extraction.
      const ticket = this.#ports.admission ? await this.#ports.admission.acquire({ signal: controller.signal }) : null;
      try {
        if (controller.signal.aborted) { outcome = "cancelled"; return; }
        await this.#ports.extract(job, controller.signal);
        // A well-behaved extraction resolves (rather than throws) on abort; it still extracted nothing.
        outcome = controller.signal.aborted ? "cancelled" : "extracted";
      } finally { ticket?.release(); }
    } catch (error) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      void error;
    } finally {
      this.#active.delete(queued.id);
      this.#activeRoots.delete(rootKey);
      // Only completed extractions dedup; failed or cancelled runs may be retried on the next settlement.
      const dedupe = `${rootKey}:${job.key}`;
      if (outcome === "extracted") this.#remember(dedupe, outcome); else this.#seen.delete(dedupe);
      this.#outcomes[outcome] += 1;
      this.#pump();
    }
  }

  /** Drops queued jobs and aborts the running extraction of one session. */
  cancel(sessionId: string): number {
    let dropped = 0;
    for (const [rootKey, queue] of this.#queues) {
      const kept = queue.filter((queued) => {
        if (queued.job.sessionId === sessionId) { dropped += 1; this.#seen.delete(`${rootKey}:${queued.job.key}`); return false; }
        return true;
      });
      if (kept.length) this.#queues.set(rootKey, kept); else this.#queues.delete(rootKey);
    }
    for (const queued of this.#active.values()) if (queued.job.sessionId === sessionId) { queued.controller.abort(); dropped += 1; }
    return dropped;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queues.clear();
    const running = [...this.#active.values()];
    for (const queued of running) queued.controller.abort();
    await Promise.allSettled(running.map((queued) => queued.done ?? Promise.resolve()));
  }
}

/**
 * The production bridge: after each settled run, hand the outcome to the
 * scheduler. The extension is observational — it can never fail the run that
 * produced the settlement, even if scheduling itself is broken.
 */
export function memoryExtractionExtension(scheduler: MemoryExtractionScheduler): AgentExtension {
  return {
    id: "memory",
    capabilities: ["memory.extraction"],
    afterRun(context: AgentContext) {
      try {
        const settlement = settlementFromContext(context);
        if (settlement) scheduler.settle(settlement);
      } catch { /* observational: never fail the run */ }
    },
  };
}
