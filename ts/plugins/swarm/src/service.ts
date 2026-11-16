/**
 * The swarm runtime, one per server process (`SwarmService`).
 *
 * It owns the durable records and the board, and an event-driven scheduler:
 * every post, finished member turn or user action "kicks" it; a tick wakes the
 * members that have unseen posts (bounded by `maxActive`) and, when everyone
 * is quiet before the goal is met, lets the monitor nudge the coordinator or
 * mark the swarm stalled. Members run through the host's `MemberRunner`, which
 * builds each member's own kernel and permissions.
 *
 * Every tick and every running member checks that the swarm plugin is still
 * enabled; disabling it pauses running swarms (`plugin_disabled`). A server
 * restart leaves running swarms `interrupted` until the user resumes them
 * (owner decision: no tokens are spent while nobody is watching).
 */
import { randomBytes } from "node:crypto";
import { BOARD_MAX, deliveryText, extractCitations, POST_CHARS, resolveAddress, type Post, type PostKind } from "./board.ts";
import { chooseToRun, monitorCheck, pendingFor } from "./engine.ts";
import { normalizeChannelName, PLAN_LIMITS, planDigest, PlanError, validateReassignment, type ModelChoice, type SwarmPlan } from "./plan.ts";
import { roleCard } from "./prompts.ts";
import type { SwarmSettings } from "./settings.ts";
import { appendPost, classifyFailure, listSwarms, loadSwarm, memberSessionsDirectory, readPosts, saveSwarm, TERMINAL, type CriterionResult, type MemberRecord, type SwarmChannel, type SwarmRecord, type SwarmStatus } from "./store.ts";

export interface MemberRunRequest { swarm: SwarmRecord; member: MemberRecord; input: string; firstTurn: boolean; sessionsDir: string; signal: AbortSignal; shouldStop(): boolean }
export interface MemberRunResult { sessionId: string; steps: number; final: string | null; error: string | null }
export interface MemberRunner { run(request: MemberRunRequest): Promise<MemberRunResult> }
export interface SwarmServiceOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** Null: swarms can be read and controlled but not run (no model host). */
  runner: MemberRunner | null;
  settings(): SwarmSettings;
  now?(): number;
  foldCase?: boolean;
  commandIssue?(rule: string): string | null;
}
export class SwarmServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "SwarmServiceError"; this.status = status; }
}

const clip = (text: string, max: number): string => (Array.from(text).length <= max ? text : Array.from(text).slice(0, max - 1).join("") + "…");
/** Whether a process id is still running (signal 0 only probes). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class SwarmService {
  readonly stateDir: string;
  readonly #options: SwarmServiceOptions;
  readonly #runs = new Map<string, Map<string, AbortController>>();
  readonly #pending = new Set<Promise<void>>();
  #ticking = false; #again = false; #closed = false;

  constructor(options: SwarmServiceOptions) { this.#options = options; this.stateDir = options.stateDir; }

  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #iso(): string { return new Date(this.#now()).toISOString(); }
  #on(): boolean { try { return this.#options.enabled("swarm"); } catch { return false; } }
  #load(id: string): SwarmRecord { try { return loadSwarm(this.stateDir, id); } catch (error) { throw new SwarmServiceError(404, (error as Error).message); } }
  #member(record: SwarmRecord, name: string): MemberRecord {
    const member = record.members.find((item) => item.name === name);
    if (!member) throw new SwarmServiceError(404, `no member @${name}`);
    return member;
  }

  get(id: string): SwarmRecord { return this.#load(id); }
  list(parentSessionId?: string): SwarmRecord[] { return listSwarms(this.stateDir).filter((record) => !parentSessionId || record.parentSessionId === parentSessionId); }
  posts(id: string, after = 0): Post[] { this.#load(id); return readPosts(this.stateDir, id, after); }
  running(id: string): string[] { return [...this.#runs.get(id)?.keys() ?? []]; }

  start(input: { parentSessionId: string; root: string; plan: SwarmPlan; local: boolean; title?: string }): SwarmRecord {
    if (!this.#on()) throw new SwarmServiceError(403, "plugin disabled or dependency unavailable: swarm");
    const settings = this.#options.settings();
    if (input.plan.members.length > settings.maxMembers) throw new SwarmServiceError(400, `a swarm is limited to ${settings.maxMembers} members by the swarm settings`);
    const now = this.#iso();
    const channels: SwarmChannel[] = [{ name: "main", topic: "General swarm board", createdBy: "system" }];
    for (const member of input.plan.members) {
      for (const chan of member.channels) {
        if (chan !== "*" && chan !== "main" && !channels.some((c) => c.name === chan)) channels.push({ name: chan, topic: "", createdBy: member.name });
      }
    }
    const approvedOwns = [...new Set(input.plan.members.flatMap((m) => m.owns))];
    const approvedCommands = [...new Set(input.plan.members.flatMap((m) => m.commands))];
    const title = input.title?.trim() ? clip(input.title.trim(), 120) : undefined;
    const record: SwarmRecord = {
      v: 1, id: `swarm-${randomBytes(6).toString("hex")}`, parentSessionId: input.parentSessionId, root: input.root, status: "running", pauseReason: null,
      createdAt: now, updatedAt: now, startedAt: now, digest: planDigest(input.plan), goal: input.plan.goal, judge: input.plan.judge,
      ...(title ? { title } : {}), ...(input.plan.acceptance?.length ? { acceptance: [...input.plan.acceptance] } : {}), channels, approvedOwns, approvedCommands,
      approvedModels: input.plan.members.flatMap((m) => m.model ? [{ providerId: m.model.providerId, model: m.model.model ?? null }] : []),
      limits: { maxActive: settings.maxActive ?? (input.local ? 1 : 2), memberMaxSteps: settings.memberMaxSteps, memberMaxTurns: settings.memberMaxTurns, nudgeLimit: settings.nudgeLimit, wallMinutes: settings.wallMinutes },
      members: input.plan.members.map((member) => ({ ...member, sessionId: null, state: "waiting", delivered: 0, turns: 0, steps: 0, summary: "", lastActiveAt: null, error: null, wakeMode: "mentions", failureKind: null, forkFromSessionId: null })),
      monitor: { nudges: 0, lastProgressSeq: 0 }, verification: null, outcome: null, noticed: {}, ownerPid: process.pid,
    };
    saveSwarm(this.stateDir, record);
    this.post(record.id, "system", ["all"], `Swarm started. Goal: ${record.goal}\nEach member has its role card. The coordinator assigns and checks the work; workers report on the board.`, "system");
    return this.#load(record.id);
  }

  /** Append a post; `from` is a member name, "user" or "system" — always set by the host. */
  post(id: string, from: string, to: readonly string[], text: string, kind: PostKind = "post", channel = "main"): Post {
    const record = this.#load(id);
    if (TERMINAL.has(record.status)) throw new SwarmServiceError(409, `the swarm is ${record.status}`);
    const body = typeof text === "string" ? text.trim() : "";
    if (!body || Array.from(body).length > POST_CHARS) throw new SwarmServiceError(400, `a post needs 1..${POST_CHARS} characters`);
    let chan = "main";
    try { chan = normalizeChannelName(channel || "main", "channel"); } catch (error) { throw new SwarmServiceError(400, (error as Error).message); }
    const channels = record.channels ? [...record.channels] : [{ name: "main", topic: "General swarm board", createdBy: "system" }];
    const existingChan = channels.find((c) => c.name === chan);
    if (existingChan?.archived) throw new SwarmServiceError(409, `channel #${chan} is archived`);
    if (!existingChan && chan !== "main") {
      if (channels.length >= 20) throw new SwarmServiceError(400, "too many channels (limit 20)");
      channels.push({ name: chan, topic: "", createdBy: from });
      record.channels = channels;
    }
    if (from !== "user" && from !== "system") this.#member(record, from);
    let resolved;
    const inlineText = kind === "post" || kind === "user" ? body : "";
    try { resolved = resolveAddress(to, from, record.members, inlineText, chan); } catch (error) { throw new SwarmServiceError(400, (error as Error).message); }
    const last = readPosts(this.stateDir, id).at(-1)?.seq ?? 0;
    if (last >= BOARD_MAX) throw new SwarmServiceError(409, `the board is full (${BOARD_MAX} posts)`);
    const citations = extractCitations(body, last);
    const post: Post = {
      seq: last + 1, at: this.#iso(), from, kind, to: resolved.to, recipients: resolved.recipients, text: body,
      ...(chan !== "main" ? { channel: chan } : {}),
      ...(citations.length ? { citations } : {}),
    };
    appendPost(this.stateDir, id, post);
    if (from !== "system" || !existingChan) {
      if (from !== "system") { record.monitor.lastProgressSeq = post.seq; record.monitor.nudges = 0; }
      saveSwarm(this.stateDir, record);
    }
    this.kick();
    return post;
  }

  #setStatus(id: string, status: SwarmStatus, reason: string | null, note: string | null): SwarmRecord {
    const record = this.#load(id);
    record.status = status; record.pauseReason = reason;
    for (const member of record.members) if (member.state === "active") member.state = "waiting";
    saveSwarm(this.stateDir, record);
    for (const controller of this.#runs.get(id)?.values() ?? []) controller.abort();
    if (note) { const seq = (readPosts(this.stateDir, id).at(-1)?.seq ?? 0) + 1; if (seq <= BOARD_MAX) appendPost(this.stateDir, id, { seq, at: this.#iso(), from: "system", kind: "system", to: { names: ["user"], groups: [], all: false }, recipients: [], text: note }); }
    return this.#load(id);
  }

  stop(id: string, reason = "stopped by the user"): SwarmRecord {
    const record = this.#load(id);
    if (TERMINAL.has(record.status)) return record;
    return this.#setStatus(id, "cancelled", reason, `Swarm stopped: ${reason}`);
  }

  resume(id: string): SwarmRecord {
    if (!this.#on()) throw new SwarmServiceError(403, "plugin disabled or dependency unavailable: swarm");
    const record = this.#load(id);
    if (!["paused", "interrupted", "stalled"].includes(record.status)) throw new SwarmServiceError(409, `a ${record.status} swarm cannot be resumed`);
    if (record.ownerPid && record.ownerPid !== process.pid && alive(record.ownerPid) && record.status !== "interrupted") throw new SwarmServiceError(409, "another Xueness process is running this swarm");
    record.status = "running"; record.pauseReason = null; record.monitor.nudges = 0; record.startedAt = this.#iso(); record.ownerPid = process.pid;
    for (const m of record.members) if (m.state !== "killed" && m.error) { m.error = null; m.failureKind = null; }
    saveSwarm(this.stateDir, record);
    this.post(id, "system", ["coordinator"], "The user resumed the swarm. Read the board and continue from where the work stopped.", "system");
    return this.#load(id);
  }

  kill(id: string, name: string, by: string, reason: string): SwarmRecord {
    const record = this.#load(id);
    const member = this.#member(record, name);
    if (member.role === "coordinator") throw new SwarmServiceError(400, "the coordinator cannot be killed; stop the swarm instead");
    member.state = "killed"; member.error = clip(reason || "stopped", 300); member.failureKind = classifyFailure(member.error);
    saveSwarm(this.stateDir, record);
    this.#runs.get(id)?.get(name)?.abort();
    if (!TERMINAL.has(record.status)) this.post(id, "system", ["coordinator"], `@${name} was stopped by ${by === "user" ? "the user" : `@${by}`}: ${member.error}`, "system");
    return this.#load(id);
  }

  waitMember(id: string, name: string, options?: { since?: number; mentionsOnly?: boolean }): { unreadPending: number; nextSeq: number } {
    const record = this.#load(id);
    const member = this.#member(record, name);
    member.wakeMode = options?.mentionsOnly === false ? "any" : "mentions";
    const posts = readPosts(this.stateDir, id);
    const latestSeq = posts.at(-1)?.seq ?? 0;
    if (typeof options?.since === "number" && Number.isSafeInteger(options.since) && options.since >= 0) {
      member.waitSince = options.since;
      // Forward only: a member may skip posts it already read on the board, never have delivered ones sent again.
      member.delivered = Math.max(member.delivered, Math.min(options.since, latestSeq));
    }
    const unreadPending = pendingFor(member, posts).length;
    saveSwarm(this.stateDir, record);
    if (unreadPending > 0) this.kick();
    return { unreadPending, nextSeq: latestSeq };
  }

  memberDone(id: string, name: string, summary: string): void {
    const record = this.#load(id);
    const member = this.#member(record, name);
    member.state = "done"; member.wakeMode = "mentions"; member.summary = clip(summary.trim(), 2000);
    saveSwarm(this.stateDir, record);
    this.post(id, name, ["coordinator"], `Done: ${member.summary}`, "done");
  }

  switchModel(id: string, name: string, model: ModelChoice | null, by: string): SwarmRecord {
    if (!this.#on()) throw new SwarmServiceError(403, "plugin disabled or dependency unavailable: swarm");
    const record = this.#load(id);
    if (TERMINAL.has(record.status)) throw new SwarmServiceError(409, `the swarm is ${record.status}`);
    const member = this.#member(record, name);
    if (member.state === "killed") throw new SwarmServiceError(409, `@${name} is killed`);
    this.#requireApprovedModel(record, model, by);
    const hadError = Boolean(member.error);
    member.model = model; member.error = null; member.failureKind = null;
    if (hadError && member.state === "done") member.state = "waiting";
    if (record.status === "stalled" && (member.role === "coordinator" || hadError)) {
      record.status = "running"; record.pauseReason = null; record.monitor.nudges = 0; record.startedAt = this.#iso(); record.ownerPid = process.pid;
    }
    saveSwarm(this.stateDir, record);
    const label = model ? `${model.providerId}${model.model ? `/${model.model}` : ""}` : "inherit (session default)";
    const target = name !== by ? [name] : [member.role === "coordinator" ? "user" : "coordinator"];
    if (!TERMINAL.has(record.status)) this.post(id, "system", target, `Model for @${name} switched to ${label} by ${by === "user" ? "the user" : `@${by}`}. Continue from your current state.`, "system");
    return this.#load(id);
  }

  reassign(
    id: string,
    input: { from: string; to: string; task?: string; owns?: readonly string[]; commands?: readonly string[]; fork?: boolean; model?: ModelChoice | null },
    by: string,
  ): SwarmRecord {
    if (!this.#on()) throw new SwarmServiceError(403, "plugin disabled or dependency unavailable: swarm");
    const record = this.#load(id);
    if (TERMINAL.has(record.status)) throw new SwarmServiceError(409, `the swarm is ${record.status}`);
    if (input.from === input.to) throw new SwarmServiceError(400, "cannot reassign a member to itself");
    const source = this.#member(record, input.from);
    const target = this.#member(record, input.to);
    if (source.role === "coordinator" || target.role === "coordinator") throw new SwarmServiceError(400, "the coordinator cannot participate in task reassignment");
    if (target.state === "killed") throw new SwarmServiceError(409, `target member @${target.name} is killed`);
    // A member acting on its own stays inside what the user approved for these two members and
    // cannot remove the check on its work; the user can do either from the panel or the CLI.
    const byUser = by === "user";
    if (!byUser && source.role !== "worker") throw new SwarmServiceError(403, `only the user can reassign a ${source.role}; ask on the board`);
    if (input.model !== undefined) this.#requireApprovedModel(record, input.model, by);
    const rawOwns = input.owns ?? [...new Set([...target.owns, ...source.owns])];
    const rawCommands = input.commands ?? [...new Set([...target.commands, ...source.commands])];
    if (target.role !== "worker" && rawOwns.length) throw new SwarmServiceError(400, `only workers own paths; @${target.name} is a ${target.role}`);
    const approvedOwns = new Set(byUser ? record.approvedOwns ?? record.members.flatMap((m) => m.owns) : [...source.owns, ...target.owns]);
    const approvedCommands = new Set(byUser ? record.approvedCommands ?? record.members.flatMap((m) => m.commands) : [...source.commands, ...target.commands]);
    const foldCase = this.#options.foldCase ?? process.platform === "win32";
    let validated: { owns: string[]; commands: string[] };
    try {
      // The source's paths are free for the overlap check; it is stopped only once everything is accepted.
      validated = validateReassignment(record.members.map((m) => m === source ? { ...m, state: "killed" } : m), target.name, rawOwns, rawCommands, approvedOwns, approvedCommands, foldCase);
    } catch (error) {
      throw new SwarmServiceError(error instanceof PlanError ? 400 : 500, (error as Error).message);
    }
    for (const cmd of validated.commands) {
      const issue = this.#options.commandIssue?.(`exec(${cmd})`);
      if (issue) throw new SwarmServiceError(400, `reassigned command ${cmd}: ${issue}`);
    }
    source.state = "killed"; source.error = clip(`reassigned to @${target.name}`, 300); source.failureKind = null;
    this.#runs.get(id)?.get(source.name)?.abort();
    target.owns = validated.owns; target.commands = validated.commands;
    target.error = null; target.failureKind = null;
    if (target.state === "done") target.state = "waiting";
    const brief = input.task?.trim() ? clip(input.task.trim(), PLAN_LIMITS.task) : "";
    if (brief) target.task = brief;
    if (input.model !== undefined) target.model = input.model;
    if (input.fork && source.sessionId && !target.sessionId && !target.forkFromSessionId) target.forkFromSessionId = source.sessionId;
    saveSwarm(this.stateDir, record);
    this.post(
      id,
      "system",
      [target.name],
      `Task reassigned from @${source.name} to @${target.name} by ${by === "user" ? "the user" : `@${by}`}.${target.owns.length ? ` Owned paths: ${target.owns.join(", ")}.` : ""}${brief ? ` Task: ${clip(brief, 800)}` : ""}`,
      "system",
    );
    return this.#load(id);
  }

  /** The user may pick any configured model. A member may only pick one the approved plan already names, or inherit. */
  #requireApprovedModel(record: SwarmRecord, model: ModelChoice | null, by: string): void {
    if (by === "user" || model === null) return;
    const approved = record.approvedModels ?? record.members.flatMap((m) => m.model ? [m.model] : []);
    if (!approved.some((item) => item.providerId === model.providerId && (item.model ?? null) === (model.model ?? null))) {
      throw new SwarmServiceError(403, `model ${model.providerId}${model.model ? `/${model.model}` : ""} is not in the approved plan; use "inherit", a model the plan names, or ask the user to switch it`);
    }
  }

  /**
   * With a done-contract the verdict is graded, not asserted: every criterion needs its own result
   * with what the verifier checked, and "pass" is refused while any criterion is unmet.
   */
  verify(id: string, name: string, verdict: "pass" | "fail", findings: string, results: readonly CriterionResult[] = []): void {
    const record = this.#load(id);
    if (this.#member(record, name).role !== "verifier") throw new SwarmServiceError(403, "only the verifier reports a verdict");
    const contract = record.acceptance ?? [];
    let criteria: CriterionResult[] | undefined;
    if (contract.length) {
      const byNumber = new Map(results.map((item) => [item.criterion, item]));
      const missing = contract.map((_, index) => index + 1).filter((number) => !byNumber.has(number));
      if (missing.length) throw new SwarmServiceError(400, `grade every acceptance criterion; missing: ${missing.join(", ")}`);
      criteria = contract.map((_, index) => { const item = byNumber.get(index + 1)!; return { criterion: index + 1, met: item.met === true, evidence: clip(String(item.evidence ?? "").trim(), 600) }; });
      const bare = criteria.filter((item) => !item.evidence).map((item) => item.criterion);
      if (bare.length) throw new SwarmServiceError(400, `say what you checked for criterion ${bare.join(", ")} (a file you read or a command you ran)`);
      const unmet = criteria.filter((item) => !item.met).map((item) => item.criterion);
      if (verdict === "pass" && unmet.length) throw new SwarmServiceError(400, `the verdict cannot be pass while criterion ${unmet.join(", ")} is not met`);
    }
    record.verification = { verdict, findings: clip(findings.trim(), 4000), at: this.#iso(), ...(criteria ? { criteria } : {}) };
    saveSwarm(this.stateDir, record);
    const graded = criteria ? ` [${criteria.map((item) => `${item.criterion}:${item.met ? "met" : "NOT MET"}`).join(" ")}]` : "";
    this.post(id, name, ["coordinator"], clip(`Verification ${verdict.toUpperCase()}${graded}: ${record.verification.findings}`, POST_CHARS), "verdict");
  }

  finish(id: string, name: string, outcome: "completed" | "failed", summary: string): SwarmRecord {
    const record = this.#load(id);
    if (this.#member(record, name).role !== "coordinator") throw new SwarmServiceError(403, "only the coordinator finishes the swarm");
    // The contract is a hard threshold while someone can still grade it; with every verifier stopped, the user decides.
    if (outcome === "completed" && record.acceptance?.length && record.verification?.verdict !== "pass"
      && record.members.some((member) => member.role === "verifier" && member.state !== "killed")) {
      throw new SwarmServiceError(409, "the acceptance criteria have not passed verification; send the work to @verifier, or finish as failed and say what is unmet");
    }
    record.outcome = { status: outcome, summary: clip(summary.trim(), 4000) };
    saveSwarm(this.stateDir, record);
    return this.#setStatus(id, outcome, null, `Swarm ${outcome}: ${record.outcome.summary}`);
  }

  /** Stamp a status notice as shown to the parent conversation; false when it already was. */
  markNoticed(id: string, key: string): boolean {
    const record = this.#load(id);
    if (record.noticed[key]) return false;
    record.noticed[key] = true;
    saveSwarm(this.stateDir, record);
    return true;
  }

  /** At start-up: a swarm whose process is gone is interrupted until the user resumes it. */
  recoverInterrupted(): number {
    let count = 0;
    for (const record of this.list()) {
      if (record.status !== "running" || record.ownerPid === process.pid || (record.ownerPid && alive(record.ownerPid))) continue;
      this.#setStatus(record.id, "interrupted", "server_restart", null); count += 1;
    }
    return count;
  }

  /** Resolves once the swarm is no longer running and none of its members is mid-turn (for the CLI). */
  async wait(id: string, signal?: AbortSignal): Promise<SwarmRecord> {
    for (;;) {
      const record = this.#load(id);
      if ((record.status !== "running" || this.#closed) && !this.running(id).length) return record;
      if (signal?.aborted) return record;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const runs of this.#runs.values()) for (const controller of runs.values()) controller.abort();
    await Promise.allSettled([...this.#pending]);
  }

  /** Schedule a tick soon; ticks never overlap. */
  kick(): void { if (!this.#closed) queueMicrotask(() => this.#tick()); }

  #tick(): void {
    if (this.#ticking) { this.#again = true; return; }
    this.#ticking = true;
    try { do { this.#again = false; this.#tickOnce(); } while (this.#again && !this.#closed); }
    finally { this.#ticking = false; }
  }

  #tickOnce(): void {
    for (const record of this.list().filter((item) => item.status === "running" && item.ownerPid === process.pid)) {
      if (!this.#on()) { this.#setStatus(record.id, "paused", "plugin_disabled", "Swarm paused: the swarm plugin was disabled."); continue; }
      if (!this.#options.runner) continue;
      const running = new Set(this.running(record.id));
      const posts = readPosts(this.stateDir, record.id);
      const chosen = chooseToRun(record, posts, running);
      for (const name of chosen) this.#launch(record.id, name, posts);
      if (chosen.length || running.size) continue;
      const action = monitorCheck(record, posts, running, this.#now());
      if (action.kind === "nudge") {
        record.monitor.nudges += 1;
        saveSwarm(this.stateDir, record);
        this.post(record.id, "system", ["coordinator"], action.text, "system");
      } else if (action.kind === "stall") {
        const msg = action.reason === "wall_clock"
          ? "Swarm stalled: it reached its time limit. Resume it to continue."
          : action.reason === "coordinator_quota"
            ? "Swarm stalled: the coordinator hit a quota or rate limit. Switch its model or resume to continue."
            : action.reason === "coordinator_error"
              ? "Swarm stalled: the coordinator failed. Switch its model, inspect its error, or resume to continue."
              : "Swarm stalled: nobody is working and the coordinator did not finish. Read the board, then resume or stop it.";
        this.#setStatus(record.id, "stalled", action.reason, msg);
      }
    }
  }

  #launch(id: string, name: string, posts: readonly Post[]): void {
    const record = this.#load(id);
    const member = this.#member(record, name);
    const pending = pendingFor(member, posts);
    const firstTurn = member.turns === 0 && !member.sessionId;
    const input = [firstTurn ? roleCard(record, member) : "", deliveryText(pending, posts)].filter(Boolean).join("\n\n");
    member.state = "active"; member.delivered = Math.max(member.delivered, ...pending.map((post) => post.seq)); member.lastActiveAt = this.#iso();
    saveSwarm(this.stateDir, record);
    const controller = new AbortController();
    const runs = this.#runs.get(id) ?? new Map<string, AbortController>();
    runs.set(name, controller); this.#runs.set(id, runs);
    const runner = this.#options.runner!;
    const task = (async () => {
      let result: MemberRunResult;
      try {
        result = await runner.run({ swarm: record, member, input, firstTurn, sessionsDir: memberSessionsDirectory(this.stateDir, id), signal: controller.signal,
          shouldStop: () => controller.signal.aborted || this.#closed || !this.#on() });
      } catch (error) { result = { sessionId: member.sessionId ?? "", steps: 0, final: null, error: clip(error instanceof Error ? error.message : String(error), 300) }; }
      finally { this.#runs.get(id)?.delete(name); }
      let fresh: SwarmRecord;
      try { fresh = this.#load(id); } catch { return; }
      const current = fresh.members.find((item) => item.name === name);
      if (current) {
        current.sessionId = result.sessionId || current.sessionId; current.turns += 1; current.steps += result.steps;
        current.lastActiveAt = this.#iso(); current.error = result.error; current.failureKind = classifyFailure(result.error);
        if (current.state === "active") current.state = "waiting";
        saveSwarm(this.stateDir, fresh);
        if (result.error && !TERMINAL.has(fresh.status) && current.state !== "killed" && current.role !== "coordinator") {
          try {
            this.post(id, "system", ["coordinator"], `@${name} ${current.failureKind === "quota" ? "hit quota/rate limit" : "failed"}: ${clip(result.error, 240)}. Use swarm_model to switch its model or swarm_reassign to hand off its paths.`, "system");
          } catch { /* board full or stopped */ }
        }
        // A reply that ended the turn without a post still reaches someone: members report to the coordinator, the coordinator to the user.
        const final = result.final?.trim();
        if (final && !TERMINAL.has(fresh.status) && current.state !== "killed") {
          try { this.post(id, name, current.role === "coordinator" ? ["user"] : ["coordinator"], clip(final, POST_CHARS)); } catch { /* the board refused it; the transcript keeps it */ }
        }
      }
      this.kick();
    })();
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }
}
