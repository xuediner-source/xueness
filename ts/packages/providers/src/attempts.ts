/**
 * The adapters' two retry shapes, shared by OpenAI and Anthropic:
 *
 * - `streamAttempts`: `stream()` / `_stream_lightweight`. Retries happen only
 *   before public output; once a delta was delivered a broken stream fails
 *   closed so callers never see a replayed prefix.
 * - `completeAttempts`: `_request_json` / `_complete_lightweight`, which
 *   remember the last HTTP / transport failure and classify it after the loop.
 *
 * With `deadline === null` both reduce to the historic standard paths. A
 * deadline (monotonic seconds on `clock`) bounds headers, body and backoff.
 */
import { performance } from "node:perf_hooks";
import {
  ProviderCallbackError, ProviderCancelled, ProviderRequestError, ProviderTransportError, RetryableProviderError,
  httpErrorCategory, isStreamStop, toProviderRequestError,
} from "./errors.ts";
import type { HttpRequestSpec } from "./http.ts";
import { DeadlineExpired, raiseIfCancelled, raiseIfDeadlineExpired, sleepWithDeadline, type ProviderClock } from "./transport.ts";

type Dict = Record<string, unknown>;

export interface AttemptContext {
  /** Zero-based attempt number. */
  attempt: number;
  /** Seconds left before the deadline, or null without one. */
  remaining: number | null;
  delivered: () => boolean;
  markDelivered: () => void;
}

export interface AttemptLoop {
  attempts: number;
  deadline: number | null;
  clock: ProviderClock;
  signal?: AbortSignal | null;
  run: (context: AttemptContext) => Promise<Dict>;
}

/** `(urllib.error.URLError, OSError)`: a deadline check's `TimeoutError` is an `OSError` too. */
function isTransport(error: unknown): error is ProviderTransportError | DeadlineExpired {
  return error instanceof ProviderTransportError || error instanceof DeadlineExpired;
}

function transportName(error: ProviderTransportError | DeadlineExpired): string {
  return error instanceof ProviderTransportError ? error.exceptionType : "TimeoutError";
}

/** Failures Python lets propagate untouched: classified errors, cancellation, user stops. */
function passesThrough(error: unknown): boolean {
  return error instanceof ProviderRequestError || error instanceof ProviderCallbackError
    || error instanceof ProviderCancelled || isStreamStop(error);
}

const deadlineError = (exceptionType: string): ProviderRequestError =>
  new ProviderRequestError({ category: "timeout", stage: "deadline", exceptionType });

/** Backoff after a transport failure: 0.25 s doubling, at most 2 s. */
const backoff = (attempt: number): number => Math.min(0.25 * 2 ** attempt, 2.0);

/** `stream()` and `_stream_lightweight`. */
export async function streamAttempts(loop: AttemptLoop): Promise<Dict> {
  const { attempts, deadline, clock, signal } = loop;
  let delivered = false;
  const context = (attempt: number, remaining: number | null): AttemptContext => ({
    attempt, remaining, delivered: () => delivered, markDelivered: () => { delivered = true; },
  });
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        let remaining: number | null = null;
        if (deadline !== null) {
          remaining = deadline - clock.now();
          if (remaining <= 0) throw new DeadlineExpired();
        }
        return await loop.run(context(attempt, remaining));
      } catch (error) {
        if (passesThrough(error)) throw error;
        if (error instanceof RetryableProviderError) {
          raiseIfCancelled(signal);
          delivered = delivered || error.delivered;
          if (delivered || attempt === attempts - 1 || !error.retryable) {
            throw toProviderRequestError(error, {
              status: error.status, retryAfter: error.delay, contextOverflow: error.contextOverflow,
              stage: "response", category: error.category, quotaResetAt: error.quotaResetAt,
              providerCode: error.providerCode, retryAfterMs: error.retryAfterMs,
            });
          }
          await sleepWithDeadline(error.delay, deadline, clock, signal);
        } else if (isTransport(error)) {
          raiseIfCancelled(signal);
          if (deadline !== null && clock.now() >= deadline) throw deadlineError(transportName(error));
          if (delivered || attempt === attempts - 1) throw toProviderRequestError(error, { stage: "read" });
          await sleepWithDeadline(backoff(attempt), deadline, clock, signal);
        } else {
          raiseIfCancelled(signal);
          raiseIfDeadlineExpired(deadline, clock);
          // A malformed response already reached the client: never replayed.
          throw toProviderRequestError(error, { stage: "parse" });
        }
      }
    }
  } catch (error) {
    if (error instanceof DeadlineExpired) throw deadlineError("TimeoutError");
    throw error;
  }
  throw new Error("provider request failed (details suppressed)");
}

/** `_request_json` and `_complete_lightweight`. */
export async function completeAttempts(loop: AttemptLoop): Promise<Dict> {
  const { attempts, deadline, clock, signal } = loop;
  let lastHttp: RetryableProviderError | null = null;
  let lastTransport: ProviderTransportError | DeadlineExpired | null = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        let remaining: number | null = null;
        if (deadline !== null) {
          remaining = deadline - clock.now();
          if (remaining <= 0) throw new DeadlineExpired();
        }
        return await loop.run({ attempt, remaining, delivered: () => false, markDelivered: () => undefined });
      } catch (error) {
        if (passesThrough(error)) throw error;
        if (error instanceof RetryableProviderError) {
          raiseIfCancelled(signal);
          lastHttp = error;
          raiseIfDeadlineExpired(deadline, clock);
          if (attempt === attempts - 1 || !error.retryable) break;
          await sleepWithDeadline(error.delay, deadline, clock, signal);
        } else if (isTransport(error)) {
          raiseIfCancelled(signal);
          lastTransport = error;
          raiseIfDeadlineExpired(deadline, clock);
          if (attempt === attempts - 1) break;
          await sleepWithDeadline(backoff(attempt), deadline, clock, signal);
        } else {
          raiseIfCancelled(signal);
          raiseIfDeadlineExpired(deadline, clock);
          // A complete response with invalid JSON/shape is not replayed.
          throw toProviderRequestError(error, { stage: "parse" });
        }
      }
    }
  } catch (error) {
    if (error instanceof DeadlineExpired) throw deadlineError("TimeoutError");
    throw error;
  }
  // Never include remote bodies, URLs or exception strings; they may contain credentials.
  if (lastHttp !== null) {
    throw new ProviderRequestError({
      status: lastHttp.status, retryAfter: lastHttp.delay, contextOverflow: lastHttp.contextOverflow,
      category: lastHttp.category || httpErrorCategory(lastHttp.status), quotaResetAt: lastHttp.quotaResetAt,
      stage: "response", exceptionType: lastHttp.name, providerCode: lastHttp.providerCode, retryAfterMs: lastHttp.retryAfterMs,
      reasoningSignatureRejected: lastHttp.reasoningSignatureRejected,
    });
  }
  if (lastTransport !== null) {
    if (deadline !== null && clock.now() >= deadline) throw deadlineError(transportName(lastTransport));
    throw toProviderRequestError(lastTransport, { stage: "read" });
  }
  throw new ProviderRequestError({ category: "invalid_response", stage: "parse" });
}

export interface PostSpecInput {
  url: HttpRequestSpec["url"];
  headers: Record<string, string>;
  body: Uint8Array;
  /** Per-operation socket timeout in seconds (Python's `timeout=`). */
  timeout: number;
  deadline: number | null;
  clock: ProviderClock;
  signal?: AbortSignal | null;
  proxy?: HttpRequestSpec["proxy"];
}

/** One POST attempt's HTTP spec; the deadline is re-based onto `performance.now()`. */
export function postSpec(input: PostSpecInput): HttpRequestSpec {
  // Read `clock` first so the re-based deadline is never earlier than the
  // caller's (`_SocketDeadlineGuard` fires at, never before, the deadline).
  const left = input.deadline === null ? null : input.deadline - input.clock.now();
  const spec: HttpRequestSpec = {
    url: input.url, method: "POST", headers: input.headers, body: input.body,
    timeoutMs: Math.max(1, input.timeout * 1000), signal: input.signal ?? null,
    deadlineMs: left === null ? null : performance.now() + left * 1000,
  };
  if (input.proxy !== undefined) spec.proxy = input.proxy;
  return spec;
}
