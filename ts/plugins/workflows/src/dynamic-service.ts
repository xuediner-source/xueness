/** Session-owned dynamic runs: explicit launch, durable recovery and host lifecycle. */
import type { HeldFileLock } from '@xueness/sessions';
import { blockedReminders as selectReminders, type BlockedReminder } from './dynamic-blocked-reminder.ts';
import { coldResumeDecision } from './dynamic-lifecycle.ts';
import { compileDynamicWorkflow } from './dynamic-compile.ts';
import { DynamicWorkflowEngine } from './dynamic-engine.ts';
import { DynamicWorkflowStore } from './dynamic-store.ts';
import type { DynamicNode, DynamicWorkflowDriver, DynamicWorkflowRun } from './dynamic-types.ts';
import type { Row } from './plan.ts';

export class DynamicServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface DynamicServiceOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** The host loads the session and checks its current workspace authorization. */
  owner(sessionId: string): Promise<Row>;
  allowRealHost(): boolean;
  driver: DynamicWorkflowDriver;
  answerActor?(run: DynamicWorkflowRun, node: DynamicNode, answer: string): Promise<void>;
}
interface ActiveRun { controller: AbortController; engine: DynamicWorkflowEngine; done: Promise<unknown>; lease: HeldFileLock }
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'paused', 'awaiting_user', 'draft']);
function fail(status: number, message: string): never { throw new DynamicServiceError(status, message); }

export class DynamicWorkflowService {
  readonly store: DynamicWorkflowStore;
  readonly #options: DynamicServiceOptions;
  readonly #active = new Map<string, ActiveRun>();
  #closed = false;
  constructor(options: DynamicServiceOptions) {
    this.#options = options;
    this.store = new DynamicWorkflowStore(options.stateDir);
  }
  async #owner(sessionId: string): Promise<Row> {
    if (this.#closed) fail(409, 'workflow host is closed');
    if (!this.#options.enabled('workflows') || !this.#options.enabled('sessions')) fail(403, 'workflows and sessions must be enabled');
    const owner = await this.#options.owner(sessionId);
    if (owner.remote_connection) fail(409, 'local script workflows require a local session');
    return owner;
  }
  async #owned(sessionId: string, id: string): Promise<{ run: DynamicWorkflowRun; owner: Row }> {
    const owner = await this.#owner(sessionId), run = this.store.load(id);
    if (run.parentSessionId !== sessionId || run.root !== owner.root) fail(403, 'workflow belongs to another session or workspace');
    return { run, owner };
  }
  async list(sessionId: string): Promise<DynamicWorkflowRun[]> {
    const owner = await this.#owner(sessionId);
    return this.store.list().filter(run => run.parentSessionId === sessionId && run.root === owner.root);
  }
  async get(sessionId: string, id: string): Promise<DynamicWorkflowRun & { digest: string; active: boolean }> {
    const { run } = await this.#owned(sessionId, id);
    return { ...run, digest: this.store.digest(run), active: this.#active.has(id) };
  }
  async create(sessionId: string, source: string, options: { name?: string; maxConcurrency?: number; writable?: boolean } = {}): Promise<DynamicWorkflowRun & { digest: string }> {
    const owner = await this.#owner(sessionId);
    const run = this.store.create({ parentSessionId: sessionId, root: String(owner.root), name: options.name ?? 'Dynamic workflow', source,
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }), ...(options.writable === undefined ? {} : { writable: options.writable }) });
    return { ...run, digest: this.store.digest(run) };
  }
  async start(sessionId: string, id: string, options: { digest: string; confirmed: boolean; allowReal?: boolean }): Promise<DynamicWorkflowRun> {
    const { run, owner } = await this.#owned(sessionId, id);
    if (!options.confirmed || options.digest !== this.store.digest(run)) fail(409, 'review and confirm the current script digest');
    if (this.#active.has(id)) fail(409, 'workflow is already running');
    if (!terminal.has(run.status)) fail(409, 'recover the interrupted owner before resuming');
    if (run.status === 'awaiting_user') fail(409, 'resolve the pending question before resuming');
    if (run.status === 'completed') return run;
    if (run.writable && (owner.mode === 'plan' || owner.permission_mode === 'plan' || owner.read_only === true)) fail(403, 'session plan mode does not permit writable actors');
    const compiled = compileDynamicWorkflow(run.source);
    if (compiled.diagnostics.length) fail(422, 'script has compilation diagnostics');
    if (compiled.sites.some(site => site.kind === 'ask') && (!options.allowReal || !this.#options.allowRealHost() || !this.#options.enabled('providers'))) fail(403, 'model execution requires the existing host switch and explicit allowReal');
    let lease: HeldFileLock;
    try { lease = this.store.acquire(id); } catch { return fail(409, 'workflow has a live owner'); }
    // A start that raced `close()` across its awaits must not register a run
    // the drain already passed: the closed check and the registration below
    // are one synchronous section, so close() either saw this run or cannot
    // start draining before it registers.
    if (this.#closed) { lease.release(); return fail(409, 'workflow host is closed'); }
    const controller = new AbortController(), engine = new DynamicWorkflowEngine(this.store, id, this.#options.driver);
    try {
      this.store.update(id, value => { value.status = 'queued'; value.allowReal = options.allowReal === true; value.approvedDigest = options.digest; delete value.error; });
      const active: ActiveRun = { controller, engine, lease, done: Promise.resolve() };
      this.#active.set(id, active);
      active.done = Promise.resolve().then(() => engine.execute(controller.signal)).finally(() => {
        this.#active.delete(id); lease.release();
      });
      // The engine persists its outcome; a background rejection is observed here too.
      void active.done.catch(() => {});
      return this.store.load(id);
    } catch (error) { lease.release(); throw error; }
  }
  async cancel(sessionId: string, id: string): Promise<DynamicWorkflowRun> {
    const { run } = await this.#owned(sessionId, id), active = this.#active.get(id);
    if (active) { active.controller.abort(); await active.done; return this.store.load(id); }
    if (run.status === 'running' || run.status === 'queued') fail(409, 'workflow is owned by another host; use that host or recover after it exits');
    return this.store.update(id, value => { if (value.status !== 'completed') value.status = 'cancelled'; });
  }
  async concurrency(sessionId: string, id: string, limit: number): Promise<DynamicWorkflowRun> {
    const { run } = await this.#owned(sessionId, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) fail(400, 'maxConcurrency must be 1..8');
    const active = this.#active.get(id);
    if (!active && (run.status === 'running' || run.status === 'queued')) fail(409, 'use the owning host to change live concurrency');
    if (active) active.engine.setMaxConcurrency(limit);
    else this.store.update(id, value => { value.maxConcurrency = limit; });
    return this.store.load(id);
  }
  async recover(sessionId: string, id: string): Promise<DynamicWorkflowRun> {
    const { run } = await this.#owned(sessionId, id);
    if (this.#active.has(id)) fail(409, 'workflow has a live owner');
    let lease: HeldFileLock;
    try { lease = this.store.acquire(id); } catch { return fail(409, 'workflow has a live owner'); }
    try {
      // The runner lease is the owner probe: acquiring it proves no live
      // owner, so the cold-resume decision for a running/queued run is to
      // mark it interrupted — never to execute alongside a wedged peer.
      if (coldResumeDecision(run.status, false) !== 'recover_interrupted') return run;
      return this.store.update(id, value => {
        value.status = 'interrupted';
        for (const node of Object.values(value.nodes)) if (node.status === 'running') node.status = 'interrupted';
      });
    } finally { lease.release(); }
  }
  async amend(sessionId: string, id: string, source: string): Promise<DynamicWorkflowRun & { digest: string }> {
    await this.#owned(sessionId, id);
    if (this.#active.has(id)) fail(409, 'settle the workflow before amending');
    const run = this.store.amend(id, source);
    return { ...run, digest: this.store.digest(run) };
  }
  async resolve(sessionId: string, id: string, nodeId: string, answer: unknown): Promise<DynamicWorkflowRun> {
    const { run } = await this.#owned(sessionId, id), node = run.nodes[nodeId];
    if (this.#active.has(id) || run.status !== 'awaiting_user' || !node || node.status !== 'awaiting_user') fail(409, 'node is not waiting for an answer');
    if (node.kind === 'hole') {
      const encoded = JSON.stringify(answer);
      if (encoded === undefined) fail(400, 'hole answer must be JSON data');
      return this.store.update(id, value => { const target = value.nodes[nodeId]!; target.result = JSON.parse(encoded); target.status = 'completed'; delete target.question; value.status = 'paused'; });
    }
    if (node.kind !== 'ask' || typeof answer !== 'string' || !answer.trim() || !this.#options.answerActor) fail(400, 'actor question requires a text answer');
    await this.#options.answerActor(run, node, answer as string);
    return this.store.update(id, value => { const target = value.nodes[nodeId]!; target.status = 'pending'; delete target.question; value.status = 'paused'; });
  }
  async wait(id: string): Promise<void> { await this.#active.get(id)?.done; }
  /**
   * C-WFL-04: the session's live runs blocked on a pending question, as
   * deduped reminder descriptors for the host's background-notice queue.
   * Count-only changes never appear here because only `awaiting_user` runs
   * with an awaiting node remind.
   */
  async blockedReminders(sessionId: string): Promise<BlockedReminder[]> {
    return selectReminders(await this.list(sessionId));
  }
  async close(): Promise<void> {
    this.#closed = true;
    // Drain, don't drop: every in-flight run is aborted and awaited — its
    // engine settles the run on disk and the lease releases in the done
    // chain — and the loop re-checks so a registration that slipped between
    // the flag and a snapshot is still drained before close returns.
    for (;;) {
      const active = [...this.#active.values()];
      if (!active.length) break;
      for (const run of active) run.controller.abort();
      await Promise.allSettled(active.map(run => run.done));
    }
  }
}
