/**
 * H12.01 — Harness telemetry event schema.
 *
 * Schema, validation and secret redaction for the desktop harness's
 * telemetry events. Events follow the H02.06 trajectory vocabulary
 * (`session` / `exchange` / `verdict`, see `trajectory-recorder.ts`) and
 * extend it with `error` and `metric` events so the harness can record the
 * full lifecycle. Everything here is pure: no DOM, no timers, no I/O —
 * `validateHarnessTelemetryEvent` decides what a well-formed event is and
 * `redactHarnessTelemetryEvent` produces a safe deep copy with secrets
 * stripped before anything is persisted or exported.
 */

/** Marker written in place of a redacted secret value. */
export const REDACTED = "[redacted]";

/** Event kinds the schema knows; mirrors H02.06 plus error/metric. */
export type HarnessTelemetryEventKind = "session" | "exchange" | "verdict" | "error" | "metric";

/** Model call usage counters (subset of the H02.05 `TokenUsage`). */
export interface TelemetryUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/** Session lifecycle event: models involved and the task being solved. */
export interface TelemetrySessionEvent {
  type: "session";
  /** ISO-8601 timestamp. */
  at: string;
  session: string;
  task: string;
  solverModel: string;
  criticModel: string;
}

/** One model call: role, model, tokens and wall-clock latency in ms. */
export interface TelemetryExchangeEvent {
  type: "exchange";
  at: string;
  session: string;
  round: number;
  role: string;
  modelId: string;
  callIndex: number;
  /** Round-trip latency in milliseconds. */
  durationMs: number;
  usage: TelemetryUsage;
}

/** Critic verdict for a round, with the patched path when accepted. */
export interface TelemetryVerdictEvent {
  type: "verdict";
  at: string;
  session: string;
  round: number;
  verdict: "accept" | "reject";
  path: string | null;
}

/** Harness failure: rejected model replies, transport errors, crashes. */
export interface TelemetryErrorEvent {
  type: "error";
  at: string;
  session: string;
  stage: string;
  message: string;
}

/** Generic key/value metric point (cache hit rate, queue depth, ...). */
export interface TelemetryMetricEvent {
  type: "metric";
  at: string;
  session: string;
  name: string;
  value: number;
}

export type HarnessTelemetryEvent =
  | TelemetrySessionEvent
  | TelemetryExchangeEvent
  | TelemetryVerdictEvent
  | TelemetryErrorEvent
  | TelemetryMetricEvent;

/** Result of validating an untrusted value against the schema. */
export interface HarnessTelemetryValidation {
  valid: boolean;
  /** Human-readable schema violations, in field order; empty when valid. */
  errors: string[];
  /** The validated event when `valid`; otherwise null. */
  event: HarnessTelemetryEvent | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_KINDS = new Set<string>(["session", "exchange", "verdict", "error", "metric"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Validate an untrusted value against the telemetry schema. Unknown extra
 * fields are preserved (forward compatibility); only declared fields are
 * checked. Never throws — malformed input becomes `errors` entries.
 */
export function validateHarnessTelemetryEvent(raw: unknown): HarnessTelemetryValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { valid: false, errors: ["event must be an object"], event: null };
  }
  const value = raw;
  const type = value.type;
  if (typeof type !== "string" || !EVENT_KINDS.has(type)) {
    return { valid: false, errors: [`type must be one of session|exchange|verdict|error|metric`], event: null };
  }
  if (!isIsoDate(value.at)) errors.push("at must be an ISO-8601 timestamp");
  if (!isNonEmptyString(value.session)) errors.push("session must be a non-empty string");

  if (type === "session") {
    if (!isNonEmptyString(value.task)) errors.push("session event requires a non-empty task");
    if (!isNonEmptyString(value.solverModel)) errors.push("session event requires a non-empty solverModel");
    if (!isNonEmptyString(value.criticModel)) errors.push("session event requires a non-empty criticModel");
  } else if (type === "exchange") {
    if (!Number.isInteger(value.round) || (value.round as number) < 1) errors.push("exchange round must be an integer >= 1");
    if (!isNonEmptyString(value.role)) errors.push("exchange event requires a non-empty role");
    if (!isNonEmptyString(value.modelId)) errors.push("exchange event requires a non-empty modelId");
    if (!Number.isInteger(value.callIndex) || (value.callIndex as number) < 0) errors.push("exchange callIndex must be an integer >= 0");
    if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
      errors.push("exchange durationMs must be a finite number >= 0");
    }
    const usage = value.usage;
    if (!isRecord(usage)) {
      errors.push("exchange event requires a usage object");
    } else {
      for (const field of ["promptTokens", "completionTokens", "cachedTokens"] as const) {
        const token = usage[field];
        if (typeof token !== "number" || !Number.isFinite(token) || token < 0) {
          errors.push(`usage.${field} must be a finite number >= 0`);
        }
      }
    }
  } else if (type === "verdict") {
    if (!Number.isInteger(value.round) || (value.round as number) < 1) errors.push("verdict round must be an integer >= 1");
    if (value.verdict !== "accept" && value.verdict !== "reject") errors.push("verdict must be accept or reject");
    if (value.path !== null && typeof value.path !== "string") errors.push("verdict path must be a string or null");
  } else if (type === "error") {
    if (!isNonEmptyString(value.stage)) errors.push("error event requires a non-empty stage");
    if (!isNonEmptyString(value.message)) errors.push("error event requires a non-empty message");
  } else {
    if (!isNonEmptyString(value.name)) errors.push("metric event requires a non-empty name");
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) errors.push("metric value must be a finite number");
  }

  if (errors.length > 0) return { valid: false, errors, event: null };
  return { valid: true, errors: [], event: value as unknown as HarnessTelemetryEvent };
}

/**
 * Parse one JSONL telemetry line into a validated event. Blank lines are
 * skipped (`event` null, no errors) so exporters can feed whole files
 * through line by line.
 */
export function parseHarnessTelemetryLine(line: string): HarnessTelemetryValidation {
  const text = line.trim();
  if (text.length === 0) return { valid: false, errors: [], event: null };
  try {
    return validateHarnessTelemetryEvent(JSON.parse(text) as unknown);
  } catch {
    return { valid: false, errors: ["line is not valid JSON"], event: null };
  }
}

/**
 * Object-key segments whose values are always secret, whatever they
 * contain. Keys are split on punctuation and camelCase first, so
 * `X-API-Key`/`sessionToken` match while `promptTokens` does not.
 */
const SECRET_SEGMENTS = new Set(["api", "key", "authorization", "auth", "token", "secret", "password", "passwd", "credential", "cookie", "bearer"]);

const isSecretKey = (key: string): boolean => {
  const segments = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((segment) => SECRET_SEGMENTS.has(segment));
};

/**
 * Redact secret-looking substrings inside a free-text value: Bearer
 * headers, `sk-` style model keys, `token=...` assignments. Non-secret
 * text passes through untouched.
 */
export function redactText(text: string): string {
  let out = text.replace(/(\bbearer\s+)([a-z0-9._~+/=-]{8,})/gi, (_match, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(/\b(?:sk-[a-z0-9_-]{16,}|(?:xox[baprs]|ghp|gho|github_pat)[-_][a-z0-9]{16,})/gi, REDACTED);
  return out.replace(/\b(api[-_]?key|token|password|secret)(\s*[:=]\s*)(\S+)/gi, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

const redactUnknown = (value: unknown, depth: number): unknown => {
  if (depth > 8) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSecretKey(key) && (typeof inner === "string" || typeof inner === "number") ? REDACTED : redactUnknown(inner, depth + 1);
    }
    return out;
  }
  return value;
};

/**
 * Deep copy a telemetry event with secrets removed: values under
 * secret-sounding keys (api key, authorization, token, …) become
 * `"[redacted]"` and secret-shaped substrings inside free text (Bearer
 * tokens, `sk-` keys, `token=…`) are masked. The input event is never
 * mutated.
 */
export function redactHarnessTelemetryEvent(event: HarnessTelemetryEvent): HarnessTelemetryEvent {
  return redactUnknown(event, 0) as HarnessTelemetryEvent;
}
