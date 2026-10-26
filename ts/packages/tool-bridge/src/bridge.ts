/**
 * Tool bridge: the one door from a model's tool call to a plugin's tool.
 *
 *   lease ─ input and subject ─ before_tool_execution ─ permission (ask → approver)
 *         ─ before_tool_effect ─ after_tool_authorization ─ run ─ after_tool_execution
 *
 * The kernel lends the tool for the call: unloading its plugin aborts the
 * call and waits for it to settle. Every outcome is a result with a stable
 * code (unknown tool, invalid input, path outside the workspace, a plugin's
 * deny, a permission refusal, a pending approval, a failing tool), so one bad
 * call never ends a run. Observers of after_tool_execution see every result
 * of a known tool, refusals included, as in Python's registry.
 *
 * With an approver an ask waits in place (see approval-waits.ts): the answer
 * channel is opened first, then the host is told (onApprovalRequest) so the
 * request becomes visible, and the call continues with the user's answer. A
 * denial is an ordinary result; only a denied plan-mode exit ends the turn.
 */
import { formatSchemaIssues, validateSchema } from "@xueness/contracts";
import { failure, runTool, type ToolDefinition, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import type { Context, ToolLease } from "@xueness/kernel";
import type { PermissionDecision, PermissionRequest, PermissionSession, RememberOptions } from "@xueness/permissions";
import { ToolEventDispatcher, type ToolEventDiagnostic, type ToolEventPayload } from "./dispatch.ts";
import { callSubject, type CallSubject } from "./subject.ts";
import { withPlanExitDeniedTurnStop } from "./turn-control.ts";
import { ToolDeadline, ToolDeadlineCancelledError, ToolDeadlineExceededError, deadlineFailure } from "./tool-deadline.ts";
import { DEFAULT_BATCH_CONCURRENCY, parallelEligible, planBatches, runBatches } from "./batch-scheduler.ts";

export interface ToolCall {
  /** The model's tool call id; a one-shot approval is bound to it. */
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
}

export interface ApprovalRequest {
  readonly callId: string;
  readonly tool: string;
  readonly kind: string;
  readonly subject: string;
  /** approval_required, ask_rule or remote_exec. */
  readonly code: string;
  readonly message: string;
  /** Rules the user may remember; null when only a one-shot approval can pass. */
  readonly remember: RememberOptions | null;
  /** Aborted when the call is cancelled: stop asking. */
  readonly signal: AbortSignal;
}

export type ApprovalAnswer =
  | { readonly behavior: "allow"; /** Rules to remember for the rest of the session. */ readonly remember?: readonly string[] }
  /**
   * `message` replaces the default denial text; `feedback` is the user's note,
   * appended for the model (ZCode permission-response: deny carries `reason`);
   * `reason` is the machine code in the result data (user_denied, permission_timeout).
   */
  | { readonly behavior: "deny"; readonly message?: string; readonly feedback?: string; readonly reason?: string }
  /** Nobody can answer now: return approval_required so a later run replays an approval. */
  | { readonly behavior: "defer" }
  /** The user stopped the run while the call waited. */
  | { readonly behavior: "cancel" };

export type Approver = (request: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>;

export interface ToolBridgeOptions {
  /** The kernel's own context; a plugin's cannot lease tools or dispatch tool events. */
  kernel: Context;
  permissions: PermissionSession;
  /** The session's tool environment (one read tracker per session); the bridge adds each call's signal. */
  env: ToolEnv | (() => ToolEnv);
  /** Asks the user. Without one an ask comes back as approval_required, to approve (grantOnce) and replay. */
  approver?: Approver;
  /** Bound on one observational tool event handler. */
  eventTimeoutMs?: number;
  /** How many concurrency-safe calls of one batch run at once; default DEFAULT_BATCH_CONCURRENCY (10). */
  batchConcurrency?: number;
  onDiagnostic?: (entry: ToolEventDiagnostic) => void;
}

export interface CallOptions {
  signal?: AbortSignal;
  /**
   * Called once the approver is listening, before waiting: the host makes the
   * request visible (journal placeholder, event). If it fails, nobody can see
   * the request, so the call returns approval_required instead of waiting.
   */
  onApprovalRequest?: (request: ApprovalRequest) => void | Promise<void>;
  /** Called after authorization and before entering the actual handler. */
  onExecutionStarted?: (call: ToolCall) => void | Promise<void>;
}

/** How many concurrency-safe calls of one batch run at once (C-TOOL-07 default; see batchConcurrency). */
export const BATCH_CONCURRENCY = DEFAULT_BATCH_CONCURRENCY;

type AnyTool = ToolDefinition<any, unknown>;
interface Passage {
  result: ToolResult;
  /** Set once the call reached the tool events; after_tool_execution then sees the result. */
  payload: ToolEventPayload | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const cancelled = (tool: string): ToolResult => failure("cancelled", `${tool} cancelled`);

function failureOf(error: unknown): ToolResult {
  const code = (error as { code?: unknown } | null)?.code;
  return failure(typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "invalid_argument", error instanceof Error ? error.message : String(error));
}

function refusal(decision: Extract<PermissionDecision, { behavior: "deny" }>): ToolResult {
  if (decision.code === "plan_mode") {
    return { ...failure("plan_mode_denied", decision.message), user_reason: decision.message, data: { reason: decision.code, ...(decision.planDraft ? { planDraft: decision.planDraft } : {}) } };
  }
  return { ...failure("permission_denied", decision.message), user_reason: "当前权限策略禁止此工具；请调整权限或任务要求。", data: { reason: decision.code, ...(decision.rule ? { rule: decision.rule } : {}) } };
}

function pending(decision: Extract<PermissionDecision, { behavior: "ask" }>, request: PermissionRequest): ToolResult {
  return {
    ok: false,
    output: `${decision.message}; waiting for the user to approve this call`,
    error: { code: "approval_required", message: decision.message },
    user_reason: "等待你批准工具调用；批准后继续。",
    data: {
      awaitingApproval: true, reason: decision.code, kind: request.kind, subject: request.subject, remember: decision.remember,
      ...(decision.rule ? { rule: decision.rule } : {}),
    },
  };
}

/** The journal entry shown while a call waits in process; same shape as approval_required, plus `waiting`. */
export function awaitingApprovalResult(request: Omit<ApprovalRequest, "signal">): ToolResult {
  return {
    ok: false,
    output: `${request.message}; waiting for the user to approve this call`,
    error: { code: "approval_required", message: request.message },
    user_reason: "等待你批准工具调用；批准后继续。",
    data: { awaitingApproval: true, waiting: true, reason: request.code, kind: request.kind, subject: request.subject, remember: request.remember },
  };
}

function answerOf(value: unknown): ApprovalAnswer {
  if (isRecord(value) && (value.behavior === "defer" || value.behavior === "cancel")) return { behavior: value.behavior };
  if (isRecord(value) && value.behavior === "allow" && (value.remember === undefined || (Array.isArray(value.remember) && value.remember.every((rule) => typeof rule === "string")))) {
    return value as ApprovalAnswer;
  }
  if (isRecord(value) && value.behavior === "deny") {
    return { behavior: "deny", ...(typeof value.message === "string" ? { message: value.message } : {}), ...(typeof value.feedback === "string" && value.feedback.trim() ? { feedback: value.feedback.trim() } : {}), ...(typeof value.reason === "string" && value.reason ? { reason: value.reason } : {}) };
  }
  // Anything else is no approval: fail closed.
  return { behavior: "deny", message: "the approval answer was not understood" };
}

/** Guarded danger prompts authorize exactly this call, never a stored permission update. */
function guardedOnceAnswer(answer: ApprovalAnswer): boolean {
  if (answer.behavior !== "allow") return true;
  const value = answer as unknown as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "behavior" && key !== "remember")) return false;
  return answer.remember === undefined || answer.remember.length === 0;
}

export class ToolBridge {
  readonly #kernel: Context;
  readonly #permissions: PermissionSession;
  readonly #env: ToolEnv | (() => ToolEnv);
  readonly #approver: Approver | null;
  readonly #batchConcurrency: number | undefined;
  readonly #events: ToolEventDispatcher;

  constructor(options: ToolBridgeOptions) {
    if (options.kernel.restricted) throw new TypeError("the tool bridge needs the kernel's own context, not a plugin's");
    this.#kernel = options.kernel;
    this.#permissions = options.permissions;
    this.#env = options.env;
    this.#approver = options.approver ?? null;
    this.#batchConcurrency = options.batchConcurrency;
    this.#events = new ToolEventDispatcher(options.kernel, {
      ...(options.eventTimeoutMs !== undefined ? { timeoutMs: options.eventTimeoutMs } : {}),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  get permissions(): PermissionSession {
    return this.#permissions;
  }

  /** Tool event interventions and anomalies, oldest first (bounded). */
  get diagnostics(): ToolEventDiagnostic[] {
    return this.#events.diagnostics;
  }

  /** Run one call through permissions and tool events. Never throws for a bad call. */
  async call(call: ToolCall, options: CallOptions = {}): Promise<ToolResult> {
    if (!isRecord(call) || typeof call.name !== "string" || typeof call.id !== "string" || !call.id) {
      return failure("invalid_argument", "a tool call needs a name and an id");
    }
    const lease = this.#kernel.tools.lease<AnyTool>(call.name);
    if (!lease) return failure("unknown_tool", `unknown tool ${call.name}`);
    let passage: Passage;
    try {
      const base = typeof this.#env === "function" ? this.#env() : this.#env;
      const signals = [lease.signal, options.signal, base.signal].filter((signal): signal is AbortSignal => signal !== undefined);
      passage = await this.#through(lease, call, base, AbortSignal.any(signals), options);
    } catch (error) {
      passage = { result: failureOf(error), payload: null };
    } finally {
      // Unloading the plugin no longer waits for this call; observers below do not hold it up.
      lease.release();
    }
    if (!passage.payload) return passage.result;
    // Observers see cancelled calls too, so they get their own bound instead of the call's signal.
    return this.#events.after({ ...passage.payload, event: "after_tool_execution" }, passage.result, new AbortController().signal);
  }

  /**
   * Run a model turn's calls, results in call order. Consecutive
   * concurrency-safe calls (pure reads) run together under the configured
   * cap (batchConcurrency, default 10); every other call runs alone, after
   * the ones before it. Planning is the C-TOOL-07 batch scheduler's.
   */
  async callAll(calls: readonly ToolCall[], options: CallOptions = {}): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    const eligible = (call: ToolCall): boolean => { const tool = this.#kernel.tools.get<AnyTool>(call.name); return !!tool && parallelEligible(tool) && !tool.mutating; };
    const groups = planBatches({ calls, eligible, concurrencyCap: this.#batchConcurrency });
    await runBatches({ calls, groups, execute: async (call, index) => { results[index] = await this.call(call, options); } });
    return results;
  }

  async #through(lease: ToolLease<AnyTool>, call: ToolCall, base: ToolEnv, signal: AbortSignal, options: CallOptions): Promise<Passage> {
    const tool = lease.tool;
    const input = call.input ?? {};
    let prepared: CallSubject | ToolResult;
    const issues = validateSchema(tool.inputSchema, input);
    if (issues.length) prepared = failure("invalid_argument", `invalid ${tool.name} input: ${formatSchemaIssues(issues)}`);
    else prepared = (tool.precheck?.(input as never) as ToolResult | null | undefined) ?? await callSubject(tool, input as Record<string, unknown>, base, this.#permissions).catch(failureOf);
    const understood = "subjectKind" in prepared ? prepared : null;
    const payload: ToolEventPayload = {
      event: "before_tool_execution", tool: tool.name, kind: tool.gate, subject: understood?.subject ?? null, callId: call.id, owner: base.owner ?? null,
    };
    const passage = (result: ToolResult): Passage => ({ result, payload });
    const denial = await this.#events.before(payload, signal);
    if (denial) return passage(denial);
    if (!understood) return passage(prepared as ToolResult);
    if (signal.aborted) return passage(cancelled(tool.name));
    const refused = await this.#authorize(tool, call.id, understood, signal, options);
    if (refused) return passage(refused);
    const effect = await this.#events.effect({ ...payload, event: "before_tool_effect" }, signal);
    if (effect) return passage(effect);
    if (!(await this.#events.authorized({ ...payload, event: "after_tool_authorization" }, signal))) return passage(cancelled(tool.name));
    const roots = understood.draftRoot ? [...base.roots, understood.draftRoot] : base.roots;
    await options.onExecutionStarted?.(call);
    if (signal.aborted) return passage(cancelled(tool.name));
    // C-TOOL-06: a declared per-tool deadline charges active execution only; a nested
    // model request's queue time pauses it (env.deadlineControl) and cancel wins instantly.
    if (!(typeof tool.timeoutMs === "number" && Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)) return passage(await runTool(tool, input, { ...base, roots, signal }));
    const deadline = new ToolDeadline({ timeoutMs: tool.timeoutMs, signal });
    try {
      return passage(await deadline.race(runTool(tool, input, { ...base, roots, signal: deadline.signal, deadlineControl: deadline })));
    } catch (error) {
      if (error instanceof ToolDeadlineExceededError) return passage(deadlineFailure(tool.name, error));
      if (error instanceof ToolDeadlineCancelledError) return passage(cancelled(tool.name));
      throw error;
    }
  }

  /** Null when the call may run; otherwise the refusal, the pending approval or the cancellation. */
  async #authorize(tool: AnyTool, callId: string, subject: CallSubject, signal: AbortSignal, options: CallOptions): Promise<ToolResult | null> {
    if (subject.paths && subject.paths.length > 1) {
      // A multi-file call (ApplyPatch) passes only if every path would pass alone.
      for (const path of subject.paths) {
        const refused = await this.#authorize(tool, callId, { subject: path, subjectKind: "path", draftRoot: null }, signal, options);
        if (refused) return refused;
      }
      return null;
    }
    const request: PermissionRequest = { tool: tool.name, kind: tool.gate, subject: subject.subject, subjectKind: subject.subjectKind, callId };
    let decision = this.#permissions.check(request);
    if (decision.behavior === "ask") {
      if (!this.#approver) return pending(decision, request);
      const answer = await this.#ask(decision, request, signal, options);
      if (!answer || answer.behavior === "cancel") return cancelled(tool.name);
      if (answer.behavior === "defer") return pending(decision, request);
      if (answer.behavior === "deny") {
        // ZCode turn-control: a denial is an ordinary result, except leaving plan mode.
        const base = answer.message || `the user declined this ${tool.gate} call`;
        const text = answer.feedback ? `${base}. The user's feedback: ${answer.feedback}` : base;
        const denied: ToolResult = { ...failure("permission_denied", text), data: { reason: answer.reason ?? "user_denied", ...(answer.feedback ? { feedback: answer.feedback } : {}) } };
        return withPlanExitDeniedTurnStop(denied, { tool: tool.name, planEnabled: this.#permissions.mode === "plan" });
      }
      if (decision.code === "guarded" && !guardedOnceAnswer(answer)) {
        return { ...failure("permission_denied", "guarded mode accepts one-time approval only"), data: { reason: "guarded_once_only" } };
      }
      for (const rule of answer.remember ?? []) {
        try {
          this.#permissions.remember(rule);
        } catch {
          // An unusable rule still leaves this one approval standing.
        }
      }
      decision = this.#permissions.check(request);
      if (decision.behavior === "ask") {
        this.#permissions.grantOnce(callId, request.kind, request.subject);
        decision = this.#permissions.check(request);
      }
    }
    if (decision.behavior === "deny") return refusal(decision);
    // Approved, yet the policy still asks (it changed while the user answered): let the host decide again.
    if (decision.behavior === "ask") return pending(decision, request);
    return null;
  }

  async #ask(decision: Extract<PermissionDecision, { behavior: "ask" }>, request: PermissionRequest, signal: AbortSignal, options: CallOptions): Promise<ApprovalAnswer | null> {
    const approver = this.#approver as Approver;
    // Ends the approver's wait when the call is cancelled, answered or never shown.
    const asking = new AbortController();
    const onAbort = (): void => asking.abort();
    if (signal.aborted) asking.abort(); else signal.addEventListener("abort", onAbort, { once: true });
    const aborted = new Promise<null>((resolve) => {
      if (asking.signal.aborted) resolve(null); else asking.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    try {
      const question: ApprovalRequest = Object.freeze({
        callId: request.callId as string, tool: request.tool, kind: request.kind, subject: request.subject,
        code: decision.code, message: decision.message, remember: decision.remember, signal: asking.signal,
      });
      // The approver registers its answer channel synchronously, before the request is visible.
      let answer: Promise<ApprovalAnswer>;
      try { answer = Promise.resolve(approver(question)).then(answerOf, (): ApprovalAnswer => ({ behavior: "deny", message: "the approval failed" })); }
      catch { answer = Promise.resolve({ behavior: "deny", message: "the approval failed" }); }
      if (options.onApprovalRequest) {
        try { await options.onApprovalRequest(question); }
        catch {
          // Nobody can see the request: stop waiting and leave it for a replay.
          asking.abort();
          void answer.catch(() => {});
          return signal.aborted ? null : { behavior: "defer" };
        }
      }
      return await Promise.race([answer, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      asking.abort();
    }
  }
}
