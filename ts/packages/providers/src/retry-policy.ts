/**
 * ZCode's model retry policy: `adapters/model/retry-policy.ts` (options and
 * environment), `retry-budget.ts` (budget tiers) and `calculateRetryDelay`
 * from `runner-retry.ts`. Delays are milliseconds; `maxAttempts` counts the
 * first request, while the environment names the number of retries.
 */
export interface ModelRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}
export type ResolvedModelRetryOptions = Required<ModelRetryOptions>;

export const ModelRetryBudget = { Default: "default", Unbounded: "unbounded", SingleAttempt: "single-attempt" } as const;
export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

export const DEFAULT_MODEL_RETRY_OPTIONS: Readonly<ResolvedModelRetryOptions> = Object.freeze({
  backoffFactor: 2, baseDelayMs: 2_000, jitter: true, maxAttempts: 10 + 1, maxDelayMs: 60_000,
});
export const MODEL_RETRY_ENV = {
  maxRetries: "XUENESS_MODEL_RETRY_MAX_RETRIES", baseDelayMs: "XUENESS_MODEL_RETRY_BASE_DELAY_MS",
  backoffFactor: "XUENESS_MODEL_RETRY_BACKOFF_FACTOR", maxDelayMs: "XUENESS_MODEL_RETRY_MAX_DELAY_MS",
} as const;
/** Status events report an unbounded budget as `maxAttempts: 0` (Infinity does not serialize). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;
/** Provider Retry-After values up to five minutes override the local backoff curve. */
export const MAX_REASONABLE_RETRY_AFTER_MS = 5 * 60_000;

type Env = Record<string, string | undefined>;

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
const positiveNumber = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
const nonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

/** `resolveAiSdkModelRetryOptions`: explicit options, then the environment, then ZCode's defaults. */
export function resolveModelRetryOptions(options: ModelRetryOptions | undefined, env: Env = process.env): ResolvedModelRetryOptions {
  const retries = parseNonNegativeInteger(env[MODEL_RETRY_ENV.maxRetries]);
  const fromEnv: ModelRetryOptions = {
    backoffFactor: parsePositiveNumber(env[MODEL_RETRY_ENV.backoffFactor]),
    baseDelayMs: parseNonNegativeInteger(env[MODEL_RETRY_ENV.baseDelayMs]),
    maxAttempts: retries === undefined ? undefined : retries + 1,
    maxDelayMs: parseNonNegativeInteger(env[MODEL_RETRY_ENV.maxDelayMs]),
  };
  const defaults = DEFAULT_MODEL_RETRY_OPTIONS;
  return {
    backoffFactor: positiveNumber(options?.backoffFactor, positiveNumber(fromEnv.backoffFactor, defaults.backoffFactor)),
    baseDelayMs: nonNegativeInteger(options?.baseDelayMs, nonNegativeInteger(fromEnv.baseDelayMs, defaults.baseDelayMs)),
    jitter: options?.jitter ?? defaults.jitter,
    maxAttempts: positiveInteger(options?.maxAttempts, positiveInteger(fromEnv.maxAttempts, defaults.maxAttempts)),
    maxDelayMs: nonNegativeInteger(options?.maxDelayMs, nonNegativeInteger(fromEnv.maxDelayMs, defaults.maxDelayMs)),
  };
}

/** `resolveRetryOptionsForBudget`: single-attempt narrows `maxAttempts` to 1. */
export function resolveRetryOptionsForBudget(retry: ResolvedModelRetryOptions, budget: ModelRetryBudget | undefined): ResolvedModelRetryOptions {
  return budget === ModelRetryBudget.SingleAttempt ? { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS } : retry;
}

/** `retryBudgetAllows`: may another attempt follow `attempt` (1-based) completed ones? */
export function retryBudgetAllows(budget: ModelRetryBudget | undefined, attempt: number, maxAttempts: number): boolean {
  return budget === ModelRetryBudget.Unbounded || attempt < maxAttempts;
}

/** `retryBudgetMaxAttempts`: the value written to status events. */
export function retryBudgetMaxAttempts(budget: ModelRetryBudget | undefined, maxAttempts: number): number {
  return budget === ModelRetryBudget.Unbounded ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}

/**
 * `calculateRetryDelay`: `base * factor^(attempt-1)` capped at `maxDelayMs`
 * with 50–100% jitter, unless the provider's Retry-After is reasonable
 * (at most five minutes, or shorter than the uncapped exponential delay).
 */
export function calculateRetryDelay(retry: ResolvedModelRetryOptions, attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const uncapped = retry.baseDelayMs * retry.backoffFactor ** Math.max(0, attempt - 1);
  const capped = Math.min(uncapped, retry.maxDelayMs);
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    && (retryAfterMs <= MAX_REASONABLE_RETRY_AFTER_MS || retryAfterMs < uncapped)) return retryAfterMs;
  if (!retry.jitter || capped === 0) return capped;
  return Math.round(capped * (0.5 + random() * 0.5));
}
