/**
 * ZCode's runner retry (`adapters/model` attempt loop with `runner-retry.ts`,
 * `retry-budget.ts` and `runner-status.ts`) at the shared agent driver.
 *
 * A classified transient failure before any committed output waits —
 * Retry-After first, else exponential backoff with jitter — and re-sends the
 * same request. Standard-profile adapters then make one HTTP attempt each,
 * so this loop owns the schedule. Status events mirror ZCode's
 * `model_request_failed` and `model_retry_scheduled`.
 */
import { randomBytes } from "node:crypto";
import {
  calculateRetryDelay, classifyModelFailure, isRetryableFailure, ModelRetryBudget, ProviderCancelled, ProviderRequestError, reportedUsage, resolveModelRetryOptions,
  resolveRetryOptionsForBudget, retryBudgetAllows, retryBudgetMaxAttempts, type ClassifiedModelFailure, type ModelRetryOptions, type ResolvedModelRetryOptions, type ModelRequestAdmissionTicket,
} from "@xueness/providers";
import type { AgentContext, AgentExtension, Row } from "./types.ts";

export interface ModelRetrySettings extends ModelRetryOptions {
  /** Defaults to "single-attempt" for the lightweight profile (its own `transportRetries` apply), else "default". */
  budget?: ModelRetryBudget;
  random?: () => number;
  /** ZCode event-idle timeout, 10 minutes by default; each retry adds 30 seconds. */
  streamIdleTimeoutMs?: number;
}

/** What `modelRetryScheduled` observers and `model_retry_scheduled` events carry. */
export interface ModelRetryInfo extends Row {
  requestId: string;
  attempt: number;
  nextAttempt: number;
  /** 0 means unbounded (ZCode `UNBOUNDED_RETRY_MAX_ATTEMPTS`). */
  maxAttempts: number;
  delayMs: number;
  reason: string;
  errorCode: string;
  message: string;
}

const SLICE_MS = 250;

export class ModelRetry {
  readonly requestId = randomBytes(8).toString("hex");
  readonly budget: ModelRetryBudget;
  readonly retry: ResolvedModelRetryOptions;
  readonly #random: () => number;
  readonly #now: () => number;
  #attempt = 1;
  #attemptId = "";
  #started: number | null = null;
  #ticket?: ModelRequestAdmissionTicket;
  #diagnostics?: Row;
  #queuedMs?: number;
  #modelInfo?: Row;
  #emptyRetries = 0;

  constructor(context: AgentContext, now: () => number) {
    const settings = context.options.modelRetry;
    const lightweight = (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";
    this.budget = settings?.budget ?? (lightweight ? ModelRetryBudget.SingleAttempt : ModelRetryBudget.Default);
    this.retry = resolveRetryOptionsForBudget(resolveModelRetryOptions(settings), this.budget);
    this.#random = settings?.random ?? Math.random;
    this.#now = now;
  }

  /** Completed attempts beyond the first. */
  get retries(): number { return this.#attempt - 1; }
  get canRetryEmpty(): boolean { return this.#emptyRetries < 1 && this.#attempt < this.retry.maxAttempts; }

  #base(context: AgentContext): Row {
    const provider = context.provider.upcomingProvider?.() ?? context.provider;
    return { requestId: this.requestId, attemptId: this.#attemptId, attempt: this.#attempt,
      maxAttempts: retryBudgetMaxAttempts(this.budget, this.retry.maxAttempts), timestamp: new Date().toISOString(),
      ...this.#queuedMs === undefined ? {} : { queuedMs: this.#queuedMs },
      ...this.#modelInfo ?? {
        ...provider.model ? { modelId: provider.model.slice(0, 160) } : {},
        ...provider.protocol ? { providerKind: provider.protocol } : {} } };
  }

  async #publish(context: AgentContext, type: "model_request_started" | "model_request_completed" | "model_request_failed" | "model_request_queued" | "model_request_admitted", info: Row, extensions: readonly AgentExtension[]): Promise<void> {
    const hook = ({ model_request_started: "modelRequestStarted", model_request_completed: "modelRequestCompleted", model_request_failed: "modelRequestFailed", model_request_queued: "modelRequestQueued", model_request_admitted: "modelRequestAdmitted" } as const)[type];
    for (const extension of extensions) { try { await extension[hook]?.(context, info); } catch { /* status observers never change execution */ } }
    context.emit({ type, ...info });
    try { await this.#ticket?.publish?.({ type, ...info }); } catch { /* ticket observers cannot change model execution */ }
  }

  begin(modelInfo?: Row): void { this.#attemptId = randomBytes(8).toString("hex"); this.#started = null; this.#ticket = undefined; this.#diagnostics = undefined; this.#queuedMs = undefined; this.#modelInfo = modelInfo; }
  ticket(ticket: ModelRequestAdmissionTicket | undefined): void { this.#ticket = ticket; }
  diagnostics(value: Row | undefined): void { this.#diagnostics = value; }
  async queued(context: AgentContext, extensions: readonly AgentExtension[]): Promise<void> { await this.#publish(context, "model_request_queued", this.#base(context), extensions); }
  async admitted(context: AgentContext, queuedMs: number, extensions: readonly AgentExtension[]): Promise<void> {
    this.#queuedMs = queuedMs;
    await this.#publish(context, "model_request_admitted", this.#base(context), extensions);
  }
  facts(context: AgentContext): Row { return this.#base(context); }
  #duration(): number { return this.#started === null ? 0 : Math.max(0, (this.#now() - this.#started) * 1000); }

  async started(context: AgentContext, extensions: readonly AgentExtension[]): Promise<void> {
    if (!this.#attemptId || this.#started !== null) this.begin();
    this.#started = this.#now();
    await this.#publish(context, "model_request_started", this.#base(context), extensions);
  }

  async completed(context: AgentContext, response: Row, extensions: readonly AgentExtension[]): Promise<void> {
    const usage = reportedUsage(response._usage);
    await this.#publish(context, "model_request_completed", { ...this.#base(context), durationMs: this.#duration(),
      response: { contentChars: typeof response.content === "string" ? response.content.length : 0, toolCalls: Array.isArray(response.tool_calls) ? response.tool_calls.length : 0 },
      ...this.#diagnostics ? { diagnostics: this.#diagnostics } : {},
      ...typeof response._finish_reason === "string" ? { finishReason: response._finish_reason } : {},
      ...Object.keys(usage).length ? { usage } : {} }, extensions);
  }

  async failed(context: AgentContext, error: unknown, signal: AbortSignal, extensions: readonly AgentExtension[], terminal: boolean, override?: ClassifiedModelFailure): Promise<void> {
    const failure = override ?? classifyModelFailure(error, signal);
    await this.#publish(context, "model_request_failed", { ...this.#base(context), durationMs: this.#duration(), terminal,
      ...this.#diagnostics ? { diagnostics: this.#diagnostics } : {},
      reason: failure.reason, retryable: failure.retryable, message: failure.message, errorCode: failure.code,
      ...error instanceof ProviderRequestError ? { phase: error.stage } : {},
      ...failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {},
      ...failure.providerCode !== undefined ? { providerErrorCode: failure.providerCode } : {},
      ...failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {} }, extensions);
  }

  /** Adapter HTTP attempts per model attempt: one whenever this loop may retry. */
  get transportAttempts(): number | undefined {
    return this.budget === ModelRetryBudget.Unbounded || this.retry.maxAttempts > 1 ? 1 : undefined;
  }

  /** Classify `error`, publish its status, and wait before a permitted retry; false means fail now. */
  async next(context: AgentContext, error: unknown, signal: AbortSignal, stopped: () => boolean, extensions: readonly AgentExtension[], options: { committed?: boolean; empty?: boolean; beforeWait?: () => Promise<void> } = {}): Promise<boolean> {
    const failure: ClassifiedModelFailure = stopped() || signal.aborted ? classifyModelFailure(new ProviderCancelled(), signal) : options.empty ? { code: "invalid_model_response", reason: "unknown", retryReason: "server_error", retryable: true,
      message: "Model returned no text, no tool calls, and no usage before completing the turn." } : classifyModelFailure(error, signal);
    const base = this.#base(context);
    const facts: Row = { ...failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {},
      ...failure.providerCode !== undefined ? { providerErrorCode: failure.providerCode } : {},
      ...failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {} };
    const delayMs = calculateRetryDelay(this.retry, this.#attempt, failure.retryAfterMs, this.#random);
    const allowed = !options.committed && isRetryableFailure(failure) && !stopped() && !signal.aborted && context.enabled("providers")
      && (options.empty ? this.canRetryEmpty : retryBudgetAllows(this.budget, this.#attempt, this.retry.maxAttempts))
      && (!Number.isFinite(context.deadline) || this.#now() + delayMs / 1000 < context.deadline);
    await this.failed(context, error, signal, extensions, !allowed, failure);
    if (!allowed) return false;
    if (options.empty) this.#emptyRetries += 1;
    const info: ModelRetryInfo = { ...base, requestId: this.requestId, attempt: this.#attempt, nextAttempt: this.#attempt + 1,
      maxAttempts: Number(base.maxAttempts), delayMs, reason: failure.retryReason, errorCode: failure.code, message: failure.message, ...facts };
    context.emit({ type: "model_retry_scheduled", ...info });
    try { await this.#ticket?.publish?.({ type: "model_retry_scheduled", ...info }); } catch { /* observational */ }
    for (const extension of extensions) {
      try { await extension.modelRetryScheduled?.(context, { ...info }); } catch { /* observers never change the schedule */ }
    }
    await options.beforeWait?.();
    await sleepUnlessStopped(delayMs, signal, () => stopped() || !context.enabled("providers"));
    this.#attempt += 1;
    return true;
  }
}

/** Abortable sleep that also honours cooperative stops (`shouldStop`) between short slices. */
async function sleepUnlessStopped(delayMs: number, signal: AbortSignal, stopped: () => boolean): Promise<void> {
  let left = Math.max(0, delayMs);
  do {
    if (signal.aborted || stopped()) throw new ProviderCancelled("model retry cancelled");
    const slice = Math.min(SLICE_MS, left);
    if (slice > 0) await new Promise<void>((resolve) => {
      const timer = setTimeout(done, slice);
      function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    });
    left -= slice;
  } while (left > 0);
  if (signal.aborted || stopped()) throw new ProviderCancelled("model retry cancelled");
}
