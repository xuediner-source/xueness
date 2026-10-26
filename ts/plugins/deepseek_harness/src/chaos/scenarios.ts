/**
 * H11.01 — Chaos scenario catalog.
 *
 * Deterministic fault-injection wrappers around an injected `HarnessModel`
 * (H02.05). Each scenario is a stable catalog entry that wraps a healthy
 * model and produces one specific failure mode — network timeout, HTTP 429
 * rate limit, truncated ("partial") JSON, malformed JSON, empty body, or
 * intermittent flakiness — so downstream gates (the H03 acceptance-gate
 * family) can assert resilience against a known, reproducible fault instead
 * of a live outage.
 *
 * Faults are sequenced purely by a call counter (default: every call), never
 * by wall-clock randomness, so tests are deterministic. No I/O is performed:
 * a "timeout" is a raced timer, a "429" is a thrown `ChaosError`.
 */

import type { HarnessModel, ModelResponse } from "../builtins/critic-solver.ts";

/** Fault families the catalog covers; >= 1 entry per family must exist. */
export type ChaosFaultKind =
  | "timeout"
  | "rate_limit"
  | "partial_json"
  | "malformed_json"
  | "empty_body"
  | "flaky";

/** Error thrown by injected faults, carrying the fault taxonomy with it. */
export class ChaosError extends Error {
  readonly kind: ChaosFaultKind;
  /** HTTP status the fault simulates, when meaningful (429 for rate limits). */
  readonly status?: number;
  /** Server-advised retry delay for rate limits, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(kind: ChaosFaultKind, message: string, details: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ChaosError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/** Type guard mirroring `instanceof` across module copies. */
export function isChaosError(error: unknown): error is ChaosError {
  return error instanceof ChaosError;
}

export interface ChaosInjectOptions {
  /** Fault every Nth call (default 1 = every call); other calls pass through. */
  readonly everyN?: number;
  /** How long the model "hangs" before the timeout fires (timeout scenario; default 25ms). */
  readonly hangMs?: number;
  /** Deadline before the call is declared timed out (timeout scenario; default 5ms). */
  readonly timeoutMs?: number;
  /** Retry-After advertised by the simulated 429 (default 10ms). */
  readonly retryAfterMs?: number;
}

export interface ChaosScenario {
  /** Stable catalog id, e.g. "net_timeout". */
  readonly id: string;
  readonly kind: ChaosFaultKind;
  readonly description: string;
  /** Wraps `model` so its `complete` calls exhibit this scenario's fault. */
  inject(model: HarnessModel, options?: ChaosInjectOptions): HarnessModel;
}

/** Shared call sequencing: faults on calls where `(n mod everyN) === 0`. */
function faultOnCall(counter: { n: number }, everyN: number): boolean {
  counter.n += 1;
  if (everyN < 1) throw new Error(`everyN must be >= 1 (got ${everyN})`);
  return counter.n % everyN === 0;
}

const healthyReply = (): ModelResponse => ({
  text: '{"verdict": "accept", "score": 0.9, "reasons": ["ok"]}',
  usage: { promptTokens: 12, completionTokens: 6, cachedTokens: 4 },
});

/** A tiny healthy model; the stress runner and tests use it as the victim. */
export function healthyModel(id = "chaos-victim"): HarnessModel {
  return { id, async complete() { return healthyReply(); } };
}

function wrap(
  model: HarnessModel,
  scenario: ChaosScenario,
  options: ChaosInjectOptions,
  injectFault: (request: Parameters<HarnessModel["complete"]>[0]) => Promise<ModelResponse>,
): HarnessModel {
  const everyN = options.everyN ?? 1;
  const counter = { n: 0 };
  return {
    id: `${model.id}:${scenario.id}`,
    async complete(request) {
      if (!faultOnCall(counter, everyN)) return model.complete(request);
      return injectFault(request);
    },
  };
}

const netTimeout: ChaosScenario = {
  id: "net_timeout",
  kind: "timeout",
  description: "connection stalls: the call exceeds its deadline and aborts with a timeout ChaosError",
  inject(model, options = {}) {
    const hangMs = options.hangMs ?? 25;
    const timeoutMs = options.timeoutMs ?? 5;
    return wrap(model, netTimeout, options, async () => {
      const hang = new Promise<void>((resolve) => setTimeout(resolve, hangMs));
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new ChaosError("timeout", `call exceeded ${timeoutMs}ms deadline`)), timeoutMs),
      );
      await Promise.race([hang, deadline]);
      return healthyReply();
    });
  },
};

const rateLimit429: ChaosScenario = {
  id: "rate_limit_429",
  kind: "rate_limit",
  description: "server throttles the call: rejects with a 429 ChaosError advertising retryAfterMs",
  inject(model, options = {}) {
    const retryAfterMs = options.retryAfterMs ?? 10;
    return wrap(model, rateLimit429, options, async () => {
      throw new ChaosError("rate_limit", "HTTP 429: too many requests", { status: 429, retryAfterMs });
    });
  },
};

/** Truncates a JSON document at a code-point boundary, keeping it unparseable. */
export function truncateJsonPrefix(json: string, ratio = 0.5): string {
  const cut = Math.max(1, Math.floor([...json].length * ratio));
  return [...json].slice(0, cut).join("");
}

const partialJson: ChaosScenario = {
  id: "partial_json",
  kind: "partial_json",
  description: "stream drops mid-body: resolves successfully but the JSON text is truncated",
  inject(model, options = {}) {
    return wrap(model, partialJson, options, async () => ({
      text: truncateJsonPrefix('{"verdict": "accept", "score": 0.9, "reasons": ["looks fine"]}'),
      usage: { promptTokens: 12, completionTokens: 6 },
    }));
  },
};

const malformedJson: ChaosScenario = {
  id: "malformed_json",
  kind: "malformed_json",
  description: "payload is syntactically valid text but not JSON at all",
  inject(model, options = {}) {
    return wrap(model, malformedJson, options, async () => ({
      text: "the model politely declines to emit JSON today",
      usage: { promptTokens: 12, completionTokens: 6 },
    }));
  },
};

const emptyBody: ChaosScenario = {
  id: "empty_body",
  kind: "empty_body",
  description: "upstream returns success but the body is empty whitespace",
  inject(model, options = {}) {
    return wrap(model, emptyBody, options, async () => ({ text: "   ", usage: { promptTokens: 3, completionTokens: 0 } }));
  },
};

const flakyIntermittent: ChaosScenario = {
  id: "flaky_intermittent",
  kind: "flaky",
  description: "every 3rd call throttles with a 429 while the rest succeed (retry-path exercise)",
  inject(model, options = {}) {
    const merged: ChaosInjectOptions = { ...options, everyN: options.everyN ?? 3 };
    const retryAfterMs = options.retryAfterMs ?? 5;
    return wrap(model, flakyIntermittent, merged, async () => {
      throw new ChaosError("rate_limit", "HTTP 429: transient throttle", { status: 429, retryAfterMs });
    });
  },
};

/** The catalog. Order is part of the contract (stable run ordering). */
export const CHAOS_SCENARIOS: readonly ChaosScenario[] = [
  netTimeout,
  rateLimit429,
  partialJson,
  malformedJson,
  emptyBody,
  flakyIntermittent,
];

/**
 * Fault kinds a scenario of `kind` is *expected* to throw. Families that
 * resolve with bad text (partial/malformed/empty) expect no throw at all, so
 * any observed fault there — and any `faultKinds` outside this set — is an
 * unexpected error rather than the injected fault.
 */
export function expectedChaosFaultKinds(kind: ChaosFaultKind): readonly ChaosFaultKind[] {
  switch (kind) {
    case "timeout": return ["timeout"];
    case "rate_limit": return ["rate_limit"];
    case "flaky": return ["rate_limit"];
    case "partial_json":
    case "malformed_json":
    case "empty_body":
      return [];
  }
}

export const CHAOS_FAULT_KINDS: readonly ChaosFaultKind[] = [
  "timeout", "rate_limit", "partial_json", "malformed_json", "empty_body", "flaky",
];

export function chaosScenarioById(id: string): ChaosScenario | undefined {
  return CHAOS_SCENARIOS.find((scenario) => scenario.id === id);
}

/** Every fault family in `CHAOS_FAULT_KINDS` has at least one scenario. */
export function chaosCatalogCovered(): boolean {
  const kinds = new Set(CHAOS_SCENARIOS.map((scenario) => scenario.kind));
  return CHAOS_FAULT_KINDS.every((kind) => kinds.has(kind));
}
