/**
 * F10.02 — the workflow VM harness. A controlled runtime that real hosts launch
 * in production: scripts reach the outside world only through explicitly
 * registered world ports, under an injectable clock, with cancellation,
 * wall-clock timeouts, operation/port-call budgets and structured error
 * propagation. `runDynamicHarness` never throws: every failure is returned as
 * a coded result, so hosts can log, meter and retry without try/catch walls.
 */
import { compileDynamicWorkflow } from "./dynamic-compile.ts";
import { DynamicEvaluationError } from "./dynamic-evaluate-internal.ts";
import { evaluateDynamicWorkflow } from "./dynamic-evaluate.ts";
import type { DynamicActor, DynamicScriptHost, DynamicUsageBox } from "./dynamic-types.ts";
import type { JsonSchema } from "@xueness/contracts";

/** Time source for deadlines and delays; scripts never see the clock. */
export interface DynamicClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The production clock: real wall time and real timers. */
export const systemDynamicClock: DynamicClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Deterministic clock for tests: time only moves when the host advances it. */
export class ManualDynamicClock implements DynamicClock {
  private currentMs: number;
  private readonly waiters: { at: number; resolve: () => void }[] = [];
  constructor(startMs = 0) { this.currentMs = startMs; }
  now(): number { return this.currentMs; }
  sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.waiters.push({ at: this.currentMs + ms, resolve }); });
  }
  advance(ms: number): void {
    this.currentMs += ms;
    const due = this.waiters.filter((waiter) => waiter.at <= this.currentMs);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      if (this.waiters[index]!.at <= this.currentMs) this.waiters.splice(index, 1);
    }
    for (const waiter of due) waiter.resolve();
  }
}

/** An explicit capability the host offers to scripts. */
export interface DynamicWorldPort {
  readonly ops: readonly string[];
  call(op: string, args: readonly unknown[]): Promise<unknown>;
}
export type DynamicWorldPorts = Record<string, DynamicWorldPort>;

/** Convenience constructor so hosts declare ports without object literals. */
export function defineDynamicWorldPort(ops: readonly string[], call: (op: string, args: readonly unknown[]) => Promise<unknown>): DynamicWorldPort {
  return { ops: [...ops], call };
}

/**
 * The built-in capability map: which port and operation serves each host
 * capability the compiled language can invoke. Everything else a script tries
 * to reach is rejected with DYNAMIC_PORT before any host code runs.
 */
const CAPABILITY_PORTS = {
  ask: { port: "agents", op: "ask" },
  filesRead: { port: "files", op: "read" },
  filesGlob: { port: "files", op: "glob" },
  report: { port: "events", op: "report" },
  log: { port: "events", op: "log" },
  phase: { port: "events", op: "phase" },
  hole: { port: "holes", op: "ask" },
} as const;

export interface DynamicHarnessBudget { operations?: number; portCalls?: number }

export interface DynamicHarnessOptions {
  source: string;
  args?: unknown;
  /** Without a port for a capability, scripts using it fail with DYNAMIC_PORT. */
  ports?: DynamicWorldPorts;
  clock?: DynamicClock;
  budget?: DynamicHarnessBudget;
  /** Wall-clock budget; when it elapses the run terminates with DYNAMIC_TIMEOUT. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DynamicHarnessUsage { operations: number; portCalls: number; elapsedMs: number; deadline: boolean }
export interface DynamicHarnessFailure { code: string; message: string; line?: number; column?: number }
export interface DynamicHarnessResult {
  ok: boolean;
  value?: unknown;
  failure?: DynamicHarnessFailure;
  usage: DynamicHarnessUsage;
  ports: readonly string[];
}

const WATCHDOG_TICK_MS = 20;

export async function runDynamicHarness(options: DynamicHarnessOptions): Promise<DynamicHarnessResult> {
  const clock = options.clock ?? systemDynamicClock;
  const ports: DynamicWorldPorts = options.ports ?? {};
  const portNames = Object.keys(ports).sort();
  const budget = options.budget ?? {};
  const maxPortCalls = budget.portCalls ?? 100_000;
  if (!Number.isSafeInteger(maxPortCalls) || maxPortCalls < 1) throw new Error("budget.portCalls must be a positive safe integer");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("timeoutMs must be a positive finite number");

  const startedMs = clock.now();
  const deadlineAt = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : startedMs + options.timeoutMs;
  const usage: DynamicHarnessUsage = { operations: 0, portCalls: 0, elapsedMs: 0, deadline: false };
  const failUsage = (): DynamicHarnessResult => ({ ok: false, usage, ports: portNames });

  const compiled = compileDynamicWorkflow(options.source);
  if (compiled.diagnostics.length > 0) {
    const first = compiled.diagnostics[0]!;
    usage.elapsedMs = clock.now() - startedMs;
    return { ...failUsage(), failure: { code: first.code, message: first.message, line: first.line, column: first.column } };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortExternal = (): void => { controller.abort(); };
  options.signal?.addEventListener("abort", abortExternal, { once: true });
  if (options.signal?.aborted) abortExternal();

  const sideEffects: Promise<unknown>[] = [];
  // Fire-and-forget ports must never surface as an unhandled rejection when the
  // script keeps running (or returns) before the port settles.
  const trackSideEffect = (promise: Promise<unknown>): void => {
    promise.catch(() => undefined);
    sideEffects.push(promise);
  };
  const guard: (code: string, message: string) => never = (code, message) => { throw new DynamicEvaluationError(code, message); };

  const reach = (capability: (typeof CAPABILITY_PORTS)[keyof typeof CAPABILITY_PORTS]): DynamicWorldPort => {
    if (clock.now() >= deadlineAt) {
      timedOut = true;
      usage.deadline = true;
      controller.abort();
      guard("DYNAMIC_TIMEOUT", `wall-clock budget of ${options.timeoutMs}ms elapsed`);
    }
    usage.portCalls += 1;
    if (usage.portCalls > maxPortCalls) guard("DYNAMIC_BUDGET", `port-call budget exceeded (${maxPortCalls})`);
    const port = ports[capability.port];
    if (!port) guard("DYNAMIC_PORT", `capability '${capability.port}.${capability.op}' has no registered world port`);
    if (!port.ops.includes(capability.op)) guard("DYNAMIC_PORT", `world port '${capability.port}' does not expose operation '${capability.op}'`);
    return port;
  };

  const invokePort = async (capability: (typeof CAPABILITY_PORTS)[keyof typeof CAPABILITY_PORTS], args: readonly unknown[]): Promise<unknown> => {
    const { port, op } = capability;
    return reach(capability).call(op, args);
  };

  const host: DynamicScriptHost = {
    createActor: (siteId: string, name?: string, persona?: string | { system?: string; model?: string }): DynamicActor => ({
      id: siteId,
      ...(name === undefined ? {} : { name }),
      persona: typeof persona === "string" ? { system: persona } : persona ?? {},
    }),
    ask: (siteId: string, actor: DynamicActor, instructions: string, schema?: JsonSchema): Promise<unknown> =>
      invokePort(CAPABILITY_PORTS.ask, [siteId, actor, instructions, ...(schema === undefined ? [] : [schema])]),
    read: (siteId: string, operation: "files.read" | "files.glob", args: unknown[]): Promise<unknown> =>
      invokePort(operation === "files.read" ? CAPABILITY_PORTS.filesRead : CAPABILITY_PORTS.filesGlob, [siteId, args]),
    report: (siteId: string, item: unknown): void => { trackSideEffect(invokePort(CAPABILITY_PORTS.report, [siteId, item])); },
    log: (message: string): void => { trackSideEffect(invokePort(CAPABILITY_PORTS.log, [message])); },
    phase: (name: string): void => { trackSideEffect(invokePort(CAPABILITY_PORTS.phase, [name])); },
    hole: (siteId: string, name: string, prompt?: string): Promise<unknown> =>
      invokePort(CAPABILITY_PORTS.hole, [siteId, name, ...(prompt === undefined ? [] : [prompt])]),
  };

  const usageBox: DynamicUsageBox = { operations: 0 };
  const evaluation = evaluateDynamicWorkflow(compiled, host, {
    signal: controller.signal,
    maxOperations: budget.operations,
    args: options.args,
    usage: usageBox,
  });
  void evaluation.catch(() => undefined);

  let finishDeadline: ((error: DynamicEvaluationError) => void) | undefined;
  const deadlineHit = new Promise<never>((_resolve, reject) => { finishDeadline = reject; });
  let finished = false;
  if (options.timeoutMs !== undefined) {
    const watchdog: Promise<void> = (async (): Promise<void> => {
      while (!finished) {
        await clock.sleep(WATCHDOG_TICK_MS);
        if (finished) return;
        if (clock.now() >= deadlineAt) {
          timedOut = true;
          usage.deadline = true;
          controller.abort();
          finishDeadline?.(new DynamicEvaluationError("DYNAMIC_TIMEOUT", `wall-clock budget of ${options.timeoutMs}ms elapsed`));
          return;
        }
      }
    })();
    void watchdog.catch(() => undefined);
  }

  let outcome: { value?: unknown; failure?: DynamicHarnessFailure };
  try {
    const value = await Promise.race([evaluation, deadlineHit]);
    const settled = await Promise.allSettled(sideEffects);
    const failedSide = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failedSide) {
      const reason = failedSide.reason instanceof Error ? failedSide.reason : new Error(String(failedSide.reason));
      outcome = { failure: { code: "DYNAMIC_PORT", message: `world port rejected the call: ${reason.message}` } };
    } else outcome = { value };
  } catch (error) {
    const failure = toFailure(error, timedOut);
    for (const side of sideEffects) void side.catch(() => undefined);
    outcome = { failure };
  } finally {
    finished = true;
    options.signal?.removeEventListener("abort", abortExternal);
  }

  usage.operations = usageBox.operations;
  usage.elapsedMs = clock.now() - startedMs;
  return outcome.failure === undefined
    ? { ok: true, value: outcome.value, usage, ports: portNames }
    : { ok: false, failure: outcome.failure, usage, ports: portNames };
}

function toFailure(error: unknown, timedOut: boolean): DynamicHarnessFailure {
  if (error instanceof DynamicEvaluationError) {
    // The timeout path aborts the controller, so a cancellation that lands first is still a timeout.
    if (timedOut && error.code === "DYNAMIC_CANCELLED") return { code: "DYNAMIC_TIMEOUT", message: error.message };
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "DYNAMIC_EVALUATION", message };
}
