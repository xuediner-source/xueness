/**
 * Attempt-level helpers shared by the adapters: `_open_with_retry`,
 * `_http_error_metadata`, `_raise_stream_error` and the deadline / backoff
 * rules. Sleeping goes through an injectable clock so tests can record the
 * exact backoff schedule without waiting for it.
 */
import { performance } from "node:perf_hooks";
import { isDict, pyGet, pyJsonLoadsBytes } from "@xueness/contracts";
import { pyUrlSplit } from "./endpoint.ts";
import {
  ProviderCancelled, ProviderRequestError, ProviderTransportError, RetryableProviderError, quotaResetFromMessage,
} from "./errors.ts";
import { openHttp, type HttpRequestSpec, type HttpResponse } from "./http.ts";
import { sanitizeProviderCode } from "./failure-codes.ts";
import { retryAfterMilliseconds, retryAfterSeconds } from "./retry-after.ts";
import { matchesThinkingSignatureRejection } from "./reasoning-history-normalization.ts";

export const QUOTA_ERROR_CODES = new Set(["AccountQuotaExceeded", "QUOTA_EXCEEDED", "insufficient_quota"]);
export const CONTEXT_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_window_exceeded", "model_context_exceeded", "model_context_window_exceeded", "context_exceeded", "prompt_too_long", "1261"]);
const STREAM_ERROR_STATUSES: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, invalid_api_key: 401, permission_error: 403,
  permission_denied: 403, not_found_error: 404, rate_limit_error: 429, rate_limit_exceeded: 429,
  server_error: 500, internal_error: 500, api_error: 500, overloaded_error: 503,
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Time source for deadlines (monotonic seconds) and backoff sleeps. */
export interface ProviderClock {
  now(): number;
  sleep(seconds: number, signal?: AbortSignal | null): Promise<void>;
}

export const SYSTEM_CLOCK: ProviderClock = {
  now: () => performance.now() / 1000,
  // `time.sleep` never returns early; event-loop timers can by a fraction of
  // a millisecond, so wait until the monotonic clock has really advanced.
  sleep: (seconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderCancelled());
    const until = performance.now() + Math.max(0, seconds * 1000);
    let timer: NodeJS.Timeout;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderCancelled());
    };
    const wait = (): void => {
      const left = until - performance.now();
      if (left <= 0) {
        signal?.removeEventListener("abort", onAbort);
        resolve();
        return;
      }
      timer = setTimeout(wait, Math.ceil(left));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(wait, Math.max(0, Math.ceil(until - performance.now())));
  }),
};

/** Python's `TimeoutError("provider request deadline exceeded")` from a deadline check. */
export class DeadlineExpired extends Error {
  override name = "TimeoutError";
  constructor() {
    super("provider request deadline exceeded");
  }
}

export function raiseIfDeadlineExpired(deadline: number | null, clock: ProviderClock): void {
  if (deadline !== null && clock.now() >= deadline) throw new DeadlineExpired();
}

/** `_sleep_with_deadline`. */
export async function sleepWithDeadline(delay: number, deadline: number | null, clock: ProviderClock, signal?: AbortSignal | null): Promise<void> {
  if (deadline === null) {
    await clock.sleep(delay, signal);
    return;
  }
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new DeadlineExpired();
  await clock.sleep(Math.min(Math.max(0, delay), remaining), signal);
  raiseIfDeadlineExpired(deadline, clock);
}

/** `cancel_watch.raise_if_active()`. */
export function raiseIfCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new ProviderCancelled();
}

/** The bounded business code token of an error object (`code` first, then `type`). */
function errorCodeToken(details: Record<string, unknown>): string | null {
  return sanitizeProviderCode(pyGet(details, "code")) ?? sanitizeProviderCode(pyGet(details, "type"));
}

/**
 * `_http_error_metadata`: [contextOverflow, quotaExhausted, resetAt, providerCode]
 * from a tiny error body. Python reads 400/413/429 bodies only; every other
 * error status is read for ZCode's business code alone, with the same bounds.
 */
export async function httpErrorMetadata(response: HttpResponse): Promise<[boolean, boolean, string | null, string | null, boolean]> {
  const status = response.status;
  if (status < 400 || status > 599) return [false, false, null, null, false];
  try {
    response.setIdleTimeout(250);
    const raw = await response.read(8193);
    if (raw.length > 8192) return [false, false, null, null, false];
    const payload = pyJsonLoadsBytes(raw, { rejectDuplicates: true });
    if (!isDict(payload)) return [false, false, null, null, false];
    const error = pyGet(payload, "error");
    const details = isDict(error) ? error : payload;
    const providerCode = errorCodeToken(details);
    if (status !== 400 && status !== 413 && status !== 429) return [false, false, null, providerCode, false];
    const codes = ["code", "type"].map((key) => pyGet(details, key)).filter((code): code is string => typeof code === "string");
    const contextOverflow = (status === 400 || status === 413) && codes.some((code) => CONTEXT_OVERFLOW_CODES.has(code));
    const quota = status === 429 && codes.some((code) => QUOTA_ERROR_CODES.has(code));
    return [contextOverflow, quota, quota ? quotaResetFromMessage(pyGet(details, "message")) : null, providerCode,
      matchesThinkingSignatureRejection(status, pyGet(details, "message"))];
  } catch (error) {
    if (error instanceof ProviderCancelled) throw error;
    return [false, false, null, null, false];
  }
}

/** urllib's `HTTPError` for a non-2xx status, with the classification facts already read. */
export class HttpStatusError extends Error {
  override name = "HTTPError";
  readonly status: number;
  readonly contextOverflow: boolean;
  readonly quotaExhausted: boolean;
  readonly quotaResetAt: string | null;
  readonly delay: number;
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;
  readonly reasoningSignatureRejected: boolean;
  constructor(status: number, contextOverflow: boolean, quotaExhausted: boolean, quotaResetAt: string | null, delay: number,
    providerCode: string | null = null, retryAfterMs: number | null = null, reasoningSignatureRejected = false) {
    super(`HTTP Error ${status}`);
    this.status = status;
    this.contextOverflow = contextOverflow;
    this.quotaExhausted = quotaExhausted;
    this.quotaResetAt = quotaResetAt;
    this.delay = delay;
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
    this.reasoningSignatureRejected = reasoningSignatureRejected;
  }
}

/** `opener.open(request)` with `_NoRedirect`: a 2xx response, or a typed failure. */
export async function openChecked(spec: HttpRequestSpec): Promise<HttpResponse> {
  const response = await openHttp(spec);
  const status = response.status;
  if (status >= 200 && status < 300) return response;
  try {
    if (REDIRECTS.has(status)) {
      const location = response.header("location") ?? response.header("uri");
      // urllib refuses other schemes with an HTTPError; `_NoRedirect` turns the rest into URLError.
      if (location !== undefined && ["http", "https", "ftp", ""].includes(pyUrlSplit(location).scheme)) {
        throw new ProviderTransportError("connection_failed", "URLError", `provider redirect blocked (${status})`);
      }
    }
    const [contextOverflow, quota, resetAt, providerCode, signatureRejected] = await httpErrorMetadata(response);
    throw new HttpStatusError(status, contextOverflow, quota, resetAt, retryAfterSeconds(response.header("retry-after")),
      providerCode, retryAfterMilliseconds((name) => response.header(name)), signatureRejected);
  } finally {
    response.close();
  }
}

/** `_open_with_retry`: classify only transient status codes. */
export async function openWithRetry(spec: HttpRequestSpec, delivered: () => boolean = () => false): Promise<HttpResponse> {
  try {
    return await openChecked(spec);
  } catch (error) {
    if (!(error instanceof HttpStatusError)) throw error;
    const status = error.status;
    throw new RetryableProviderError({
      retryable: !error.quotaExhausted && (status === 429 || (status >= 500 && status <= 599)),
      delay: error.delay, delivered: delivered(), status, contextOverflow: error.contextOverflow,
      category: error.quotaExhausted ? "quota_exhausted" : null, quotaResetAt: error.quotaResetAt,
      providerCode: error.providerCode, retryAfterMs: error.retryAfterMs,
      reasoningSignatureRejected: error.reasoningSignatureRejected,
    });
  }
}

/** `_raise_stream_error`: an SSE error envelope is classified like an HTTP error. */
export function raiseStreamError(payload: Record<string, unknown>): never {
  const details = pyGet(payload, "error");
  let status: number | null = null;
  let overflow = false;
  let quota = false;
  let resetAt: string | null = null;
  let providerCode: string | null = null;
  if (isDict(details)) {
    providerCode = errorCodeToken(details);
    for (const field of ["status", "code", "type"]) {
      const value = pyGet(details, field);
      if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
        status = value;
        break;
      }
    }
    const codes = ["code", "type"].map((field) => pyGet(details, field)).filter((code): code is string => typeof code === "string");
    quota = codes.some((code) => QUOTA_ERROR_CODES.has(code));
    if (status === null) {
      for (const code of codes) {
        if (CONTEXT_OVERFLOW_CODES.has(code)) status = 400;
        else if (QUOTA_ERROR_CODES.has(code)) status = 429;
        else status = Object.hasOwn(STREAM_ERROR_STATUSES, code) ? (STREAM_ERROR_STATUSES[code] as number) : null;
        if (status !== null) break;
      }
    }
    overflow = (status === 400 || status === 413) && codes.some((code) => CONTEXT_OVERFLOW_CODES.has(code));
    if (quota) resetAt = quotaResetFromMessage(pyGet(details, "message"));
  }
  if (status === null) throw new ProviderRequestError({ category: "upstream_failure", stage: "response", providerCode });
  throw new RetryableProviderError({
    retryable: !quota && (status === 429 || (status >= 500 && status <= 599)),
    status, contextOverflow: overflow, category: quota ? "quota_exhausted" : null, quotaResetAt: resetAt, providerCode,
    reasoningSignatureRejected: matchesThinkingSignatureRejection(status, isDict(details) ? pyGet(details, "message") : undefined),
  });
}
