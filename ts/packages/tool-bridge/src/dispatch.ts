/**
 * Dispatching tool events to plugin handlers, after Python's plugin_runtime.
 *
 * Observational handlers are isolated: a throw or a timeout becomes a
 * diagnostic, never a failed call. A deny or a rewrite counts only from a
 * plugin whose manifest declares the event. before_tool_effect is the strict
 * exception: any anomaly there refuses the call (fail closed). Every
 * intervention and anomaly lands in a bounded log; an error is recorded by
 * its name only, since its message may carry untrusted data.
 */
import type { ToolResult } from "@xueness/engine-tools";
import type { Context, ToolEventName, ToolEventParticipant } from "@xueness/kernel";

export const TOOL_EVENT_TIMEOUT_MS = 10_000;
export const TOOL_EVENT_REASON_MAX = 500;
export const TOOL_EVENT_DETAIL_MAX = 200;
export const TOOL_EVENT_DIAGNOSTICS_MAX = 50;

export type ToolEventDiagnosticKind = "deny" | "deny_ignored" | "error" | "timeout" | "invalid_result" | "rewrite" | "rewrite_rejected";

export interface ToolEventDiagnostic {
  readonly at: number;
  readonly event: ToolEventName;
  readonly plugin: string;
  readonly kind: ToolEventDiagnosticKind;
  readonly detail: string;
  readonly callId: string;
}

/** What a handler receives. Frozen: a handler changes a result only by returning a rewrite. */
export interface ToolEventPayload {
  readonly event: ToolEventName;
  readonly tool: string;
  /** Gate kind. */
  readonly kind: string;
  /** What the permission decision is about; null when the call could not be understood. */
  readonly subject: string | null;
  readonly callId: string;
  /** The session the call belongs to. */
  readonly owner: string | null;
  readonly result?: Readonly<ToolResult>;
}

export const policyUnavailable = (): ToolResult => ({
  ok: false, output: "tool execution policy unavailable",
  error: { code: "tool_policy_unavailable", message: "tool execution policy unavailable" },
  data: { retryable: false },
});

const cancelled = (tool: string): ToolResult => ({ ok: false, output: `${tool} cancelled`, error: { code: "cancelled", message: `${tool} cancelled` } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects. */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** A tool result: ok, model-facing output, and an error with a stable code exactly when it failed. */
function resultProblem(value: unknown): string | null {
  if (!isRecord(value)) return "result must be an object";
  if (typeof value.ok !== "boolean") return "ok must be a boolean";
  if (typeof value.output !== "string") return "output must be a string";
  const error = value.error as Record<string, unknown> | undefined;
  if (value.ok ? error !== undefined : !isRecord(error) || typeof error.code !== "string" || !/^[a-z_]+$/.test(error.code) || typeof error.message !== "string") {
    return "error must be {code, message} exactly when ok is false";
  }
  return null;
}

/** Why a proposed rewrite cannot be accepted, or null (Python's _rewrite_problem). */
export function rewriteProblem(original: ToolResult, rewritten: unknown): string | null {
  if (!isRecord(rewritten)) return "rewritten result must be an object";
  if (rewritten.ok !== original.ok) return "ok must stay unchanged";
  if (!isJsonValue(rewritten)) return "rewritten result must stay JSON-serialisable";
  return resultProblem(rewritten);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A frozen copy for handlers, so observing cannot change what the model gets. */
function snapshot(result: ToolResult): Readonly<ToolResult> {
  let copy: ToolResult;
  try {
    copy = structuredClone(result);
  } catch {
    copy = { ok: result.ok, output: result.output, ...(result.error ? { error: { ...result.error } } : {}) };
  }
  return deepFreeze(copy);
}

const TIMEOUT = Symbol("timeout");
const ABORTED = Symbol("aborted");
type Outcome = { ok: true; value: unknown } | { ok: false; why: "error" | "timeout" | "aborted" };

export interface ToolEventDispatcherOptions {
  timeoutMs?: number;
  onDiagnostic?: (entry: ToolEventDiagnostic) => void;
}

export class ToolEventDispatcher {
  readonly #kernel: Context;
  readonly #timeoutMs: number;
  readonly #onDiagnostic: ((entry: ToolEventDiagnostic) => void) | null;
  readonly #log: ToolEventDiagnostic[] = [];

  constructor(kernel: Context, options: ToolEventDispatcherOptions = {}) {
    this.#kernel = kernel;
    this.#timeoutMs = options.timeoutMs ?? TOOL_EVENT_TIMEOUT_MS;
    this.#onDiagnostic = options.onDiagnostic ?? null;
  }

  /** Interventions and anomalies, oldest first, at most TOOL_EVENT_DIAGNOSTICS_MAX. */
  get diagnostics(): ToolEventDiagnostic[] {
    return this.#log.map((entry) => ({ ...entry }));
  }

  /** Every subscriber observes; a declared one may deny with a reason. Returns the denial or null. */
  async before(payload: ToolEventPayload, signal: AbortSignal): Promise<ToolResult | null> {
    for (const participant of this.#participants(payload.event)) {
      const outcome = await this.#invoke(participant, payload, signal, true);
      if (!outcome.ok || !isRecord(outcome.value) || outcome.value.decision !== "deny") continue;
      if (!participant.declared) {
        this.#record(payload, participant.plugin, "deny_ignored", "toolEvents does not declare this event");
        continue;
      }
      const reason = typeof outcome.value.reason === "string" ? outcome.value.reason.trim().slice(0, TOOL_EVENT_REASON_MAX) : "";
      if (!reason) {
        this.#record(payload, participant.plugin, "deny_ignored", "deny without a usable reason");
        continue;
      }
      this.#record(payload, participant.plugin, "deny", reason);
      const message = `denied by plugin ${participant.plugin}`;
      return { ok: false, output: `${message}: ${reason}`, error: { code: "plugin_denied", message }, data: { plugin: participant.plugin, userReason: reason } };
    }
    return null;
  }

  /** Strict policies of declared plugins, after the permission check and before any effect. Fails closed. */
  async effect(payload: ToolEventPayload, signal: AbortSignal): Promise<ToolResult | null> {
    let participants: ToolEventParticipant[];
    try {
      participants = this.#kernel.toolEventParticipants(payload.event);
    } catch {
      return policyUnavailable();
    }
    for (const participant of participants) {
      const outcome = await this.#invoke(participant, payload, signal, true);
      if (!outcome.ok) return outcome.why === "aborted" ? cancelled(payload.tool) : policyUnavailable();
      const value = outcome.value;
      if (value === undefined || value === null) continue;
      const result = isRecord(value) && value.decision === "deny" ? value.result : undefined;
      if (isRecord(result) && result.ok === false && isJsonValue(result) && resultProblem(result) === null) {
        this.#record(payload, participant.plugin, "deny", String((result.error as { code: string }).code));
        return structuredClone(result) as unknown as ToolResult;
      }
      this.#record(payload, participant.plugin, "invalid_result", "");
      return policyUnavailable();
    }
    return null;
  }

  /** Started observers own pre-effect work; cancellation drains it before the tool lease returns. */
  async authorized(payload: ToolEventPayload, signal: AbortSignal): Promise<boolean> {
    for (const participant of this.#participants(payload.event)) {
      if (signal.aborted) return false;
      const outcome = await this.#invoke(participant, payload, signal, false);
      if (signal.aborted || !outcome.ok && outcome.why === "aborted") return false;
    }
    return !signal.aborted;
  }

  /** Every subscriber observes the result; a declared one may rewrite it, keeping `ok` and the result shape. */
  async after(payload: ToolEventPayload, result: ToolResult, signal: AbortSignal): Promise<ToolResult> {
    let current = result;
    for (const participant of this.#participants(payload.event)) {
      const outcome = await this.#invoke(participant, { ...payload, result: snapshot(current) }, signal, true);
      if (!outcome.ok || !isRecord(outcome.value) || outcome.value.decision !== "rewrite") continue;
      if (!participant.declared) {
        this.#record(payload, participant.plugin, "rewrite_rejected", "toolEvents does not declare this event");
        continue;
      }
      const problem = rewriteProblem(current, outcome.value.result);
      if (problem) {
        this.#record(payload, participant.plugin, "rewrite_rejected", problem);
        continue;
      }
      current = structuredClone(outcome.value.result) as unknown as ToolResult;
      this.#record(payload, participant.plugin, "rewrite", "");
    }
    return current;
  }

  #participants(event: ToolEventName): ToolEventParticipant[] {
    try {
      return this.#kernel.toolEventParticipants(event);
    } catch {
      // Observation degrades instead of failing the call.
      return [];
    }
  }

  /** Isolate errors; started unbounded observers must settle even after cancellation. */
  async #invoke(participant: ToolEventParticipant, payload: ToolEventPayload, signal: AbortSignal, bounded: boolean): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const frozen = Object.freeze({ ...payload, event: participant.event });
    try {
      if (signal.aborted) return { ok: false, why: "aborted" };
      const task = Promise.resolve().then(() => signal.aborted ? ABORTED : participant.handler(frozen));
      if (!bounded) { const value = await task; return signal.aborted || value === ABORTED ? { ok: false, why: "aborted" } : { ok: true, value }; }
      const races: Promise<unknown>[] = [task];
      if (bounded) races.push(new Promise((resolve) => (timer = setTimeout(() => resolve(TIMEOUT), this.#timeoutMs))));
      races.push(new Promise((resolve) => {
        onAbort = () => resolve(ABORTED);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }));
      const value = await Promise.race(races);
      if (value === TIMEOUT) {
        this.#record(payload, participant.plugin, "timeout", `handler exceeded ${this.#timeoutMs / 1000}s`);
        return { ok: false, why: "timeout" };
      }
      return value === ABORTED ? { ok: false, why: "aborted" } : { ok: true, value };
    } catch (error) {
      this.#record(payload, participant.plugin, "error", error instanceof Error ? error.name : typeof error);
      return { ok: false, why: "error" };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  #record(payload: ToolEventPayload, plugin: string, kind: ToolEventDiagnosticKind, detail: string): void {
    const entry: ToolEventDiagnostic = Object.freeze({
      at: Date.now(), event: payload.event, plugin, kind, detail: detail.slice(0, TOOL_EVENT_DETAIL_MAX), callId: payload.callId,
    });
    this.#log.push(entry);
    if (this.#log.length > TOOL_EVENT_DIAGNOSTICS_MAX) this.#log.splice(0, this.#log.length - TOOL_EVENT_DIAGNOSTICS_MAX);
    try {
      this.#onDiagnostic?.(entry);
    } catch {
      // A diagnostics sink must never break a call.
    }
  }
}
