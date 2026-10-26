import { resolve } from "node:path";
import { isDict, pyEquals, PyValueError } from "@xueness/contracts";
import { ensureMessageIdentity, foldHostPath, preserveInterruptedPartial, realish, type Session } from "@xueness/sessions";
import { turnId } from "./completion.ts";
import { agentSupport, UnsupportedAgentConfiguration } from "./capabilities.ts";
import { driveRun } from "./driver.ts";
import { effectiveExtensions } from "./finalize.ts";
import { installExecutionModel, restoreExecutionModel } from "./execution-selection.ts";
import { appendUserTurn } from "./turns.ts";
import type { AgentContext, AgentRunnerOptions, Row, RunDecision, RunOptions } from "./types.ts";

/** Runs are leased across both TS and Python stores; cancellation is cooperative. */
export class AgentRunner {
  readonly #options: AgentRunnerOptions;
  readonly #active = new Map<string, AbortController>();
  constructor(options: AgentRunnerOptions) {
    if (!options.hooks || typeof options.hooks.enabled !== "function" || typeof options.hooks.toolOwner !== "function") throw new TypeError("agent execution requires persisted plugin policy and tool ownership");
    this.#options = options;
  }
  isRunning(sessionId: string): boolean { return this.#active.has(sessionId); }
  supports(session: Session): { supported: boolean; missingCapabilities: string[] } { return agentSupport(session, this.#options); }
  cancel(sessionId: string): boolean {
    const controller = this.#active.get(sessionId);
    if (!controller) return false;
    controller.abort(); return true;
  }
  continue(session: Session, options: RunOptions = {}): Promise<Session> { return this.run(session, options); }
  async run(session: Session, options: RunOptions = {}): Promise<Session> {
    const settings = this.#options;
    options = { ...options };
    const support = this.supports(session);
    if (!support.supported) throw new UnsupportedAgentConfiguration(support.missingCapabilities);
    if (typeof session.id !== "string") throw new PyValueError("invalid session id");
    const sid = session.id;
    if (this.#active.has(sid)) throw Object.assign(new Error("session is already running"), { name: "BlockingIOError" });
    if (options.maxWallSeconds !== undefined && (typeof options.maxWallSeconds !== "number" || !Number.isFinite(options.maxWallSeconds) || options.maxWallSeconds <= 0 || options.maxWallSeconds > 3600)) throw new PyValueError("max_wall_seconds must be greater than zero and at most 3600");
    if (typeof session.root !== "string" || foldHostPath(realish(session.root)) !== foldHostPath(realish(settings.root))) throw new PyValueError("session workspace differs from permission boundary");
    const controller = new AbortController(); this.#active.set(sid, controller);
    let lease: Awaited<ReturnType<typeof settings.store.lease>> | null = null;
    const signal = AbortSignal.any([controller.signal, options.signal, settings.hostSignal].filter((item): item is AbortSignal => !!item));
    const now = settings.now ?? (() => performance.now() / 1000);
    const extensions = settings.hooks.extensions ?? [];
    const context: AgentContext = {
      session, store: settings.store, provider: settings.provider, stateDir: resolve(settings.stateDir ?? settings.store.directory), root: realish(settings.root), signal,
      // ZCode: no default wall-time cap; a caller or lifecycle hook may still bound the run.
      deadline: options.maxWallSeconds === undefined ? Infinity : now() + options.maxWallSeconds, options, hostSignal: settings.hostSignal,
      enabled(id) { try { return settings.hooks.enabled(id) === true; } catch { return false; } },
      async save() { ensureMessageIdentity(session); await settings.store.save(session); },
      emit(event) {
        for (const extension of effectiveExtensions(context, extensions)) extension.recordEvent?.(context, event);
        try { settings.onEvent?.(event); } catch { /* observational callbacks never change the run outcome */ }
      },
    };
    let returned = false;
    let initialized = false;
    // Execution-scoped temporary selection: resolving it is a pre-request decision
    // whose failures end the run before any model call; restored in the finally below.
    const execution = installExecutionModel(context);
    const previousStreamId = isDict(session.streaming) ? session.streaming.id : null;
    try {
      lease = await settings.store.lease(sid);
      if (Object.hasOwn(session, "history_revision") || Object.hasOwn(session, "history_hash")) {
        const current = await settings.store.load(sid);
        if (!pyEquals(current.history_revision ?? null, session.history_revision ?? null) || !pyEquals(current.history_hash ?? null, session.history_hash ?? null)) throw Object.assign(new Error("session changed before its run lease was acquired"), { name: "BlockingIOError" });
      }
      ensureMessageIdentity(session);
      // C-WFL-03: each run starts without a stop record; it is journaled below
      // when a terminal decision, cancellation or deadline ends the rounds.
      delete session.run_stop;
      initialized = true;
      for (const extension of effectiveExtensions(context, extensions)) {
        const lifecycle = await extension.beforeRun?.(context);
        if (lifecycle?.deadlineSeconds !== undefined) context.deadline = Math.min(context.deadline, now() + Math.max(0, lifecycle.deadlineSeconds));
        if (lifecycle?.stop) { await context.save(); returned = true; return session; }
      }
      for (;;) {
        let iterationReturned = false;
        try { await driveRun(context, settings, now); iterationReturned = true; }
        finally {
          for (const extension of effectiveExtensions(context, extensions)) await extension.settleRun?.(context, iterationReturned);
          if (context.enabled("sessions")) preserveInterruptedPartial(session, session.active_turn_id ?? turnId(session), { previousStreamId });
          delete session.active_turn_id;
          if (iterationReturned) await context.save();
        }
        let decision: RunDecision | void = undefined;
        // C-WFL-03: an explicit terminal stop (budget reached, user pause,
        // completion) is final for this run; no later extension may start
        // another round after it.
        let terminalStop: RunDecision | null = null;
        for (const extension of effectiveExtensions(context, extensions)) {
          const next = await extension.afterRun?.(context);
          if (next?.action === "stop") { terminalStop = { ...next, owner: next.owner ?? extension.id }; decision = undefined; break; }
          if (next?.action === "continue") decision = { ...next, owner: next.owner ?? extension.id };
          if (next?.action === "continue" && next.exclusive) break;
        }
        // C-WFL-03: journal why the rounds ended — an extension's terminal
        // decision, cancellation or the wall-clock deadline — so the stop is
        // inspectable after the run; natural exhaustion journals nothing.
        let runStop: Row | null = null;
        if (signal.aborted || options.shouldStop?.()) runStop = { code: "cancelled", reason: "run was cancelled" };
        else if (now() >= context.deadline) runStop = { code: "deadline", reason: "run exceeded its wall-clock deadline" };
        else if (terminalStop) {
          const extras = terminalStop as unknown as Row;
          const code = extras.stopCode;
          runStop = { code: typeof code === "string" && code ? code : "stopped", reason: String(extras.reason ?? terminalStop.owner ?? ""), owner: terminalStop.owner ?? null };
        }
        if (runStop) session.run_stop = runStop;
        await context.save();
        if (runStop || !decision || decision.action !== "continue" || typeof decision.prompt !== "string" || !decision.prompt.trim() || decision.owner && !context.enabled(decision.owner)) break;
        let appended = false;
        for (const extension of effectiveExtensions(context, extensions)) if (extension.appendTurn && await extension.appendTurn(context, decision.prompt)) { appended = true; break; }
        if (!appended && (!decision.owner || context.enabled(decision.owner))) await appendUserTurn(session, settings.store, decision.prompt);
        else if (!appended) break;
      }
      returned = true; return session;
    } finally {
      try {
        restoreExecutionModel(context, execution);
        if (initialized) for (const extension of extensions) await extension.close?.(context);
        // settleRun cleanup may have changed journal metadata even on failure.
        if (initialized && !returned && isDict(session.streaming) && session.streaming.status === "interrupted" && context.enabled("sessions")) {
          preserveInterruptedPartial(session, turnId(session), { previousStreamId });
        }
      } finally { this.#active.delete(sid); await lease?.release(); }
    }
  }
}
