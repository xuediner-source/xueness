/**
 * Approvals answered in process: a tool call that needs the user's approval
 * waits where it is, and the turn continues once the user answers.
 *
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0)
 * `apps/zcode-cli/packages/core/src/permission/broker.ts` (ManualPermissionBroker:
 * one pending record per request, answer by call id, an unknown id is a miss,
 * abort ends the wait) and `tool/executor/permission-responder-race.ts` (the
 * answer channel exists before the request is visible; the first answer wins,
 * later answers never change it).
 *
 * Defined outcomes:
 * - answer: first answer settles the wait; a repeat of the same decision is a
 *   duplicate, a different later decision is a conflict. Neither changes anything.
 * - stop: `stopped()` turns true or the call's signal aborts → cancel.
 * - no one can answer (sessions plugin off, host shutting down) → defer: the
 *   call returns approval_required and the next run replays an approval.
 * - session deleted or reset → close: the wait is denied.
 * - a second wait for a call id that is already waiting → denied (ZCode rejects
 *   a duplicate pending request).
 * - reject with feedback: the user's note rides on the denial (ZCode
 *   `tool/executor/permission-response.ts`: a deny response carries `reason`,
 *   which becomes the model-visible permission error).
 * - allow for this session: an in-memory allow list per session, keyed by tool,
 *   kind and exact subject, answers later identical asks without waiting (ZCode
 *   `permission/service.ts` grantSessionPermission / `permission-rules-persistence.ts`
 *   sessionPermissionUpdates: session rules live in memory only). Cleared on
 *   stop, close (delete/reset) and forgetSession. Only the ordinary ask
 *   (approval_required) can be remembered: alwaysAsk, ask rules and remote
 *   exec ask every time (ZCode: a session grant is an allow rule, and
 *   alwaysAsk / ask rules win over allow rules).
 * - timeout: optional, off by default, as in ZCode `permission/broker.ts`
 *   (`timeoutMs` only when `permissionTimeoutMs` is configured; no default).
 *   A timeout denies the call with reason `permission_timeout`.
 */
import type { ApprovalAnswer, ApprovalRequest, Approver } from "./bridge.ts";

export type LiveDecision = "approve" | "reject";
/** "once" approves this call only; "session" also allows identical calls for the rest of the session. */
export type LiveScope = "once" | "session" | "project";

export interface WaitingApproval {
  readonly sessionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly kind: string;
  readonly subject: string;
  readonly code: string;
  readonly message: string;
  readonly remember?: ApprovalRequest["remember"];
}

export type LiveAnswerOutcome =
  | { readonly status: "answered"; readonly approval: WaitingApproval }
  | { readonly status: "duplicate" | "conflict"; readonly approval: WaitingApproval; readonly decision: LiveDecision }
  | { readonly status: "none" };

export interface LiveApproverOptions {
  /** Polled while waiting; true cancels the wait (the user pressed stop). */
  stopped?: () => boolean;
  /** False when nobody can answer now; the call is then deferred to a replay. */
  available?: () => boolean;
  /** Called once with the settled answer, before the call continues. */
  onAnswer?: (approval: WaitingApproval, answer: ApprovalAnswer) => void;
  pollMs?: number;
  /** Deny the call when nobody answers within this many ms. Off when undefined (ZCode default). */
  timeoutMs?: number;
}

/** Asks that a session allowance never answers: each such call is approved once. */
export const ONE_SHOT_APPROVAL_CODES: ReadonlySet<string> = new Set(["always_ask", "ask_rule", "remote_exec", "plan_exit", "guarded"]);

/** May "allow for this session" cover later asks with this decision code? */
export function sessionAllowable(code: string): boolean {
  return !ONE_SHOT_APPROVAL_CODES.has(code);
}

interface Entry { readonly approval: WaitingApproval; settle(answer: ApprovalAnswer): void }

/** Answered call ids kept per session so a repeated answer has a defined reply. */
const ANSWERED_LIMIT = 100;

export class ApprovalWaits {
  readonly #waiting = new Map<string, Map<string, Entry>>();
  readonly #answered = new Map<string, Map<string, { approval: WaitingApproval; decision: LiveDecision }>>();
  readonly #sessionAllowed = new Map<string, Set<string>>();

  /** Register synchronously, so the request can be answered as soon as it is visible. */
  request(sessionId: string, request: ApprovalRequest, options: LiveApproverOptions = {}): Promise<ApprovalAnswer> {
    const approval: WaitingApproval = Object.freeze({
      sessionId, callId: request.callId, tool: request.tool, kind: request.kind, subject: request.subject, code: request.code, message: request.message, remember: request.remember,
    });
    let sessions = this.#waiting.get(sessionId);
    if (sessions?.has(request.callId)) return Promise.resolve({ behavior: "deny", message: `approval already pending for ${request.callId}` });
    if (request.signal.aborted) return Promise.resolve({ behavior: "cancel" });
    return new Promise<ApprovalAnswer>((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => entry.settle({ behavior: "cancel" });
      const entry: Entry = {
        approval,
        settle: (answer) => {
          const current = this.#waiting.get(sessionId);
          if (current?.get(request.callId) !== entry) return;
          current.delete(request.callId);
          if (!current.size) this.#waiting.delete(sessionId);
          if (poll) clearInterval(poll);
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          try { options.onAnswer?.(approval, answer); } catch { /* audit never changes the decision */ }
          resolve(answer);
        },
      };
      if (!sessions) { sessions = new Map(); this.#waiting.set(sessionId, sessions); }
      sessions.set(request.callId, entry);
      request.signal.addEventListener("abort", abort, { once: true });
      if (options.stopped) {
        const stopped = options.stopped;
        poll = setInterval(() => { let stop = false; try { stop = stopped(); } catch { stop = true; } if (stop) { this.forgetSession(sessionId); entry.settle({ behavior: "cancel" }); } }, options.pollMs ?? 100);
        poll.unref?.();
      }
      const timeoutMs = options.timeoutMs;
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => entry.settle({
          behavior: "deny", reason: "permission_timeout",
          message: `approval request timed out after ${timeoutMs}ms without an answer from the user; treat this ${request.kind} call as denied and do not retry it unless the user asks`,
        }), timeoutMs);
        timer.unref?.();
      }
    });
  }

  /** The bridge's approver for one session's run. */
  approver(sessionId: string, options: LiveApproverOptions = {}): Approver {
    return (request) => {
      let available = true;
      try { available = options.available?.() ?? true; } catch { available = false; }
      if (!available) return { behavior: "defer" };
      let stopped = false;
      try { stopped = options.stopped?.() ?? false; } catch { stopped = true; }
      if (stopped) { this.forgetSession(sessionId); return { behavior: "cancel" }; }
      if (sessionAllowable(request.code) && this.#sessionAllowed.get(sessionId)?.has(sessionKey(request))) {
        const approval: WaitingApproval = Object.freeze({ sessionId, callId: request.callId, tool: request.tool, kind: request.kind, subject: request.subject, code: request.code, message: request.message });
        const answer: ApprovalAnswer = { behavior: "allow" };
        try { options.onAnswer?.(approval, answer); } catch { /* audit never changes the decision */ }
        return answer;
      }
      return this.request(sessionId, request, options);
    };
  }

  /** Settle a waiting call with the user's decision. */
  answer(sessionId: string, callId: string, decision: LiveDecision, message?: string, scope: LiveScope = "once"): LiveAnswerOutcome {
    const answered = this.#answered.get(sessionId)?.get(callId);
    if (answered) return { status: answered.decision === decision ? "duplicate" : "conflict", approval: answered.approval, decision: answered.decision };
    const entry = this.#waiting.get(sessionId)?.get(callId);
    if (!entry) return { status: "none" };
    let memory = this.#answered.get(sessionId);
    if (!memory) { memory = new Map(); this.#answered.set(sessionId, memory); }
    memory.set(callId, { approval: entry.approval, decision });
    while (memory.size > ANSWERED_LIMIT) memory.delete(memory.keys().next().value as string);
    if (decision === "approve" && scope === "session" && sessionAllowable(entry.approval.code)) {
      let allowed = this.#sessionAllowed.get(sessionId);
      if (!allowed) { allowed = new Set(); this.#sessionAllowed.set(sessionId, allowed); }
      allowed.add(sessionKey(entry.approval));
    }
    entry.settle(decision === "approve" ? { behavior: "allow", ...(scope === "project" && entry.approval.code === "approval_required" ? { remember: entry.approval.remember?.exact ?? [] } : {}) } : { behavior: "deny", reason: "user_denied", ...(message ? { feedback: message } : {}) });
    return { status: "answered", approval: entry.approval };
  }

  /** Calls allowed for the rest of this session (tool, kind, subject). */
  sessionAllowed(sessionId: string): { tool: string; kind: string; subject: string }[] {
    return [...this.#sessionAllowed.get(sessionId) ?? []].map((key) => { const [tool = "", kind = "", subject = ""] = key.split("\u0000"); return { tool, kind, subject }; });
  }

  /** Drop the session's allow list (stop, delete, reset). */
  forgetSession(sessionId: string): void {
    this.#sessionAllowed.delete(sessionId);
  }

  get(sessionId: string, callId: string): WaitingApproval | null {
    return this.#waiting.get(sessionId)?.get(callId)?.approval ?? null;
  }

  /** The decision already given for a call that no longer waits, if any. */
  answered(sessionId: string, callId: string): LiveDecision | null {
    return this.#answered.get(sessionId)?.get(callId)?.decision ?? null;
  }

  waiting(sessionId?: string): WaitingApproval[] {
    const sessions = sessionId === undefined ? [...this.#waiting.values()] : [this.#waiting.get(sessionId) ?? new Map<string, Entry>()];
    return sessions.flatMap((calls) => [...calls.values()].map((entry) => entry.approval));
  }

  /** Nobody can answer now: end the waits as approval_required, to replay later. */
  defer(sessionId?: string): number {
    return this.#settleAll(sessionId, { behavior: "defer" });
  }

  /** The session was deleted or reset: deny its waits and forget its answers. */
  close(sessionId: string, message = "the session was closed while this call waited for approval"): number {
    this.#answered.delete(sessionId);
    this.forgetSession(sessionId);
    return this.#settleAll(sessionId, { behavior: "deny", message });
  }

  #settleAll(sessionId: string | undefined, answer: ApprovalAnswer): number {
    const sessions = sessionId === undefined ? [...this.#waiting.values()] : [this.#waiting.get(sessionId)].filter((calls): calls is Map<string, Entry> => !!calls);
    const entries = sessions.flatMap((calls) => [...calls.values()]);
    for (const entry of entries) entry.settle(answer);
    return entries.length;
  }
}

function sessionKey(call: { readonly tool: string; readonly kind: string; readonly subject: string }): string {
  return `${call.tool}\u0000${call.kind}\u0000${call.subject}`;
}
