/**
 * Auxiliary model calls (conversation titles, semantic handoffs, compaction
 * summaries, goal verification, memory dream synthesis) under the same
 * process admission governor as agent requests: one slot per in-flight call,
 * the foreground scope keeps user-visible auxiliary work from queueing behind
 * governed runs, and each outcome feeds the shared AIMD feedback.
 */
import type { ModelRequestAdmission } from "@xueness/providers";
import { admitAttempt, classifyModelFailure, isStreamStop, ModelFailureReason, ModelRetryReason, ProviderCancelled, reasoningOrigin } from "@xueness/providers";
import { admissionWithScope, providerAdmissionForState } from "./admission-policy.ts";

/**
 * The aux entry scope: user-visible auxiliary calls share the state
 * directory's governor but never queue behind background runs (C-MDL-05).
 */
export function auxiliaryModelAdmission(stateDir: string): ModelRequestAdmission | undefined {
  const shared = providerAdmissionForState(stateDir);
  return shared ? admissionWithScope(shared, { foreground: true }) : undefined;
}

/** The attempt's verdict from one adapter failure; `null` settles as a plain ended attempt. */
function failureEventOf(error: unknown, signal: AbortSignal | undefined): { type: string; reason: string; retryable: boolean; retryAfterMs?: number } | null {
  if (isStreamStop(error) || error instanceof ProviderCancelled) return null;
  const failure = classifyModelFailure(error, signal);
  if (failure.retryable) {
    // Auth repair retries are not provider verdicts; the attempt merely ends.
    if (failure.retryReason === ModelRetryReason.AuthRefresh || failure.retryReason === ModelRetryReason.ReasoningSignatureRepair) return null;
    return { type: "model_retry_scheduled", reason: failure.retryReason, retryable: true, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
  }
  // A terminal rate limit is still one concurrency signal; the ticket settles it as throttled.
  if (failure.reason === ModelFailureReason.RateLimited || failure.reason === ModelFailureReason.ProviderOverloaded) return { type: "model_request_failed", reason: failure.reason, retryable: false, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
  return null;
}

/**
 * Runs one bounded auxiliary adapter call under admission. The ticket is the
 * call's single slot: acquired here, settled exactly once from the outcome,
 * released in `finally` — no caller holds a second slot for the same request.
 */
export async function runWithModelAdmission<T>(
  admission: ModelRequestAdmission | undefined,
  provider: { model?: string; base?: string },
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  const attempt = await admitAttempt({ admission, model: reasoningOrigin(provider), signal });
  try {
    const value = await call();
    attempt.ticket?.publish?.({ type: "model_request_completed" });
    return value;
  } catch (error) {
    const event = failureEventOf(error, signal);
    if (event) attempt.ticket?.publish?.(event);
    throw error;
  } finally {
    attempt.release();
  }
}
