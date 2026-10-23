/**
 * Sanitized provider failures, ported from `providers/provider.py`.
 *
 * Classification follows Python's exception families: HTTP status errors,
 * transport (`OSError` / `URLError`) failures that may be retried, protocol
 * (`ValueError`, `KeyError`, ...) failures that are never retried, stream
 * callback failures and cooperative stops. Messages never carry upstream
 * text, URLs or credentials.
 */
import { randomBytes } from "node:crypto";
import { pySlice } from "@xueness/contracts";
import { sanitizeProviderCode } from "./failure-codes.ts";

export type ProviderErrorStage = "connect" | "read" | "parse" | "deadline" | "response";
export type TransportCategory = "timeout" | "service_unready" | "connection_failed";

const STAGES = new Set<string>(["connect", "read", "parse", "deadline", "response"]);

/** `_http_error_category`. */
export function httpErrorCategory(status: unknown): string {
  if (status === 400 || status === 413 || status === 422) return "request_rejected";
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 404) return "endpoint_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503) return "service_unready";
  if (typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599) return "upstream_failure";
  return "http_error";
}

/** `max(low, min(value, high))` with Python's NaN behaviour (NaN becomes `low`). */
export function pyClamp(value: number, low: number, high: number): number {
  const capped = high < value ? high : value;
  return capped > low ? capped : low;
}

function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

const ISO_BODY = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])";
const ISO_FULL = new RegExp(`^${ISO_BODY}$`);
const ISO_SEARCH = new RegExp(`(?<![0-9A-Za-z])(${ISO_BODY})(?![0-9A-Za-z])`, "g");
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** `_normalize_iso_reset`: a bounded ISO timestamp with zone, as UTC `...Z`. */
export function normalizeIsoReset(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !ISO_FULL.test(value)) return null;
  const parts = ISO_PARTS.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  const micros = parts[7] ? Number(parts[7].padEnd(6, "0")) : 0;
  const offset = parts[8] ? (parts[8] === "-" ? -1 : 1) * (Number(parts[9]) * 60 + Number(parts[10])) : 0;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute - offset, second, 0);
  const utcYear = date.getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null; // Python's OverflowError
  const pad = (number: number, width = 2): string => String(number).padStart(width, "0");
  const fraction = micros ? `.${pad(micros, 6)}` : "";
  return `${pad(utcYear, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:`
    + `${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${fraction}Z`;
}

/** `_quota_reset_from_message`: the first valid timestamp in a bounded message. */
export function quotaResetFromMessage(message: unknown): string | null {
  if (typeof message !== "string" || Array.from(message).length > 2048) return null;
  for (const match of message.matchAll(ISO_SEARCH)) {
    const normalized = normalizeIsoReset(match[1]);
    if (normalized !== null) return normalized;
  }
  return null;
}

export interface ProviderRequestErrorInit {
  status?: unknown;
  retryAfter?: unknown;
  contextOverflow?: boolean;
  category?: string | null;
  stage?: string;
  traceId?: string;
  exceptionType?: string | null;
  quotaResetAt?: unknown;
  /** Bounded `code` / `type` token of the error body (ZCode business codes). */
  providerCode?: unknown;
  /** Unclamped server-directed delay in milliseconds (ZCode `parseRetryAfterMs`). */
  retryAfterMs?: unknown;
  transport?: TransportHint | null;
  reasoningSignatureRejected?: boolean;
}

export type TransportHint = "tls" | "proxy";
/** At most one day: a longer server-directed wait is not a retry schedule. */
const MAX_RETRY_AFTER_MS = 86_400_000;

function boundedRetryAfterMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RETRY_AFTER_MS ? Math.round(value) : null;
}

/** `ProviderRequestError`: safe classification only. */
export class ProviderRequestError extends Error {
  override name = "ProviderRequestError";
  readonly status: number | null;
  readonly category: string;
  readonly stage: ProviderErrorStage;
  readonly traceId: string;
  readonly exceptionType: string | null;
  readonly contextOverflow: boolean;
  readonly quotaResetAt: string | null;
  readonly retryAfter: number | null;
  /** ZCode classification facts; never part of the Python-compatible `toJSON`. */
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;
  readonly transport: TransportHint | null;
  readonly reasoningSignatureRejected: boolean;

  constructor(init: ProviderRequestErrorInit = {}) {
    super("provider request failed (details suppressed)");
    const status = init.status;
    this.status = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    this.category = init.category || (this.status !== null ? httpErrorCategory(this.status) : "request_failed");
    this.stage = (init.stage !== undefined && STAGES.has(init.stage) ? init.stage : "response") as ProviderErrorStage;
    this.traceId = typeof init.traceId === "string" && /^[0-9a-f]{16}$/.test(init.traceId) ? init.traceId : newTraceId();
    this.exceptionType = typeof init.exceptionType === "string" ? pySlice(init.exceptionType, 80) : null;
    this.contextOverflow = Boolean(init.contextOverflow);
    this.quotaResetAt = this.category === "quota_exhausted" ? normalizeIsoReset(init.quotaResetAt) : null;
    const retryable = this.category !== "quota_exhausted"
      && (this.status === 429 || (this.status !== null && this.status >= 500 && this.status <= 599));
    this.retryAfter = retryable && typeof init.retryAfter === "number" ? pyClamp(init.retryAfter, 0, 2) : null;
    this.providerCode = sanitizeProviderCode(init.providerCode);
    this.retryAfterMs = boundedRetryAfterMs(init.retryAfterMs);
    this.transport = init.transport === "tls" || init.transport === "proxy" ? init.transport : null;
    this.reasoningSignatureRejected = init.reasoningSignatureRejected === true;
  }

  /** The public, content-free facts (snake_case like the Python attributes). */
  toJSON(): Record<string, unknown> {
    return {
      status: this.status, category: this.category, stage: this.stage, trace_id: this.traceId,
      exception_type: this.exceptionType, context_overflow: this.contextOverflow,
      quota_reset_at: this.quotaResetAt, retry_after: this.retryAfter,
    };
  }
}

/** A caller's stream callback failed; not a provider failure and never retried. */
export class ProviderCallbackError extends Error {
  override name = "ProviderCallbackError";
  readonly exceptionType: string;
  readonly traceId = newTraceId();
  readonly stage = "stream_callback";
  constructor(exceptionType: unknown) {
    super("provider stream callback failed");
    this.exceptionType = pySlice(typeof exceptionType === "string" ? exceptionType : "Exception", 80);
  }
}

/** Cooperative cancellation: settles as a user stop, never as a provider failure. */
export class ProviderCancelled extends Error {
  override name = "ProviderCancelled";
  readonly xuenessStreamControl = "stop";
  constructor(message = "provider read cancelled") {
    super(message);
  }
}

/** `getattr(exc, "_xueness_stream_control", None) == "stop"`. */
export function isStreamStop(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { xuenessStreamControl?: unknown }).xuenessStreamControl === "stop";
}

/** Python's `type(exc).__name__` for a thrown value. */
export function exceptionTypeName(error: unknown): string {
  if (error instanceof Error) {
    const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (error.name && error.name !== "Error") return error.name;
    return typeof ctor === "string" && ctor ? ctor : "Exception";
  }
  return "Exception";
}

/** `_notify_stream_callback`. */
export function notifyStreamCallback<T>(callback: (value: T) => unknown, value: T): void {
  try {
    callback(value);
  } catch (error) {
    if (isStreamStop(error)) throw error;
    // Never retain or stringify the callback's error: it may hold private data.
    throw new ProviderCallbackError(exceptionTypeName(error));
  }
}

/** `OSError` / `URLError` families: retried while no output was delivered. */
export class ProviderTransportError extends Error {
  readonly category: TransportCategory;
  readonly exceptionType: string;
  /** TLS validation and proxy failures keep Python's `URLError` name; the hint feeds ZCode classification. */
  readonly hint: TransportHint | null;
  constructor(category: TransportCategory, exceptionType: string, message = "provider transport failed", hint: TransportHint | null = null) {
    super(message);
    this.name = exceptionType;
    this.category = category;
    this.exceptionType = exceptionType;
    this.hint = hint;
  }
}

/** A protocol failure (`ValueError`, `http.client.HTTPException`, ...): never retried. */
export class ProviderProtocolError extends Error {
  constructor(exceptionType: string, message: string) {
    super(message);
    this.name = exceptionType;
  }
}

export interface RetryableInit {
  retryable: boolean;
  delay?: number;
  delivered?: boolean;
  status?: number | null;
  contextOverflow?: boolean;
  category?: string | null;
  quotaResetAt?: unknown;
  providerCode?: unknown;
  retryAfterMs?: number | null;
  reasoningSignatureRejected?: boolean;
}

/** `_RetryableProviderError`: an HTTP status (or stream error envelope) to classify. */
export class RetryableProviderError extends Error {
  override name = "_RetryableProviderError";
  readonly retryable: boolean;
  readonly delay: number;
  readonly delivered: boolean;
  readonly status: number | null;
  readonly contextOverflow: boolean;
  readonly category: string | null;
  readonly quotaResetAt: string | null;
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;
  readonly reasoningSignatureRejected: boolean;
  constructor(init: RetryableInit) {
    super("provider request failed");
    this.retryable = init.retryable;
    this.delay = init.delay ?? 0.25;
    this.delivered = init.delivered ?? false;
    this.status = init.status ?? null;
    this.contextOverflow = Boolean(init.contextOverflow);
    this.category = init.category ?? null;
    this.quotaResetAt = normalizeIsoReset(init.quotaResetAt);
    this.providerCode = sanitizeProviderCode(init.providerCode);
    this.retryAfterMs = boundedRetryAfterMs(init.retryAfterMs);
    this.reasoningSignatureRejected = init.reasoningSignatureRejected === true;
  }
}

export interface ToRequestErrorOptions {
  status?: number | null;
  retryAfter?: number | null;
  contextOverflow?: boolean;
  stage?: ProviderErrorStage;
  category?: string | null;
  quotaResetAt?: unknown;
  providerCode?: unknown;
  retryAfterMs?: number | null;
}

/** `_provider_request_error`: classify any failure into a sanitized error. */
export function toProviderRequestError(error: unknown, options: ToRequestErrorOptions = {}): ProviderRequestError {
  let category = options.category ?? null;
  if (options.status !== undefined && options.status !== null) category = category || httpErrorCategory(options.status);
  else if (error instanceof ProviderTransportError) category = category || error.category;
  else category = category || "invalid_response";
  return new ProviderRequestError({
    status: options.status ?? null, retryAfter: options.retryAfter ?? null,
    contextOverflow: options.contextOverflow ?? false, category, stage: options.stage ?? "response",
    exceptionType: error instanceof ProviderTransportError ? error.exceptionType : exceptionTypeName(error),
    quotaResetAt: options.quotaResetAt ?? null,
    providerCode: options.providerCode ?? null, retryAfterMs: options.retryAfterMs ?? null,
    transport: error instanceof ProviderTransportError ? error.hint : null,
    reasoningSignatureRejected: typeof error === "object" && error !== null && "reasoningSignatureRejected" in error && error.reasoningSignatureRejected === true,
  });
}
