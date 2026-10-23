/** Durable execution of an explicitly queued native dynamic workflow. */
import { PyValueError } from "@xueness/contracts";
import { DynamicWorkflowStore } from "./dynamic-store.ts";
import { compileDynamicWorkflow } from "./dynamic-compile.ts";
import { evaluateDynamicWorkflow } from "./dynamic-evaluate.ts";
import { workspaceFingerprint } from "./plan.ts";
import { DynamicEngineOperations, DynamicWorkflowHold } from "./dynamic-engine-operations.ts";
import { DynamicOperationScheduler, abortError } from "./dynamic-engine-scheduler.ts";
import type { DynamicWorkflowDriver, DynamicWorkflowRun } from "./dynamic-types.ts";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000) || error.name;
  return String(error).slice(0, 1000);
}

function jsonResult(value: unknown): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new PyValueError("dynamic workflow result must be JSON serializable"); }
  if (encoded === undefined) throw new PyValueError("dynamic workflow result must be JSON serializable");
  return JSON.parse(encoded) as unknown;
}

export { DynamicWorkflowHold };

export class DynamicWorkflowEngine {
  readonly store: DynamicWorkflowStore;
  readonly id: string;
  readonly driver: DynamicWorkflowDriver;
  #scheduler: DynamicOperationScheduler | null = null;

  constructor(store: DynamicWorkflowStore, id: string, driver: DynamicWorkflowDriver) {
    this.store = store;
    this.id = id;
    this.driver = driver;
  }

  /** Persist and immediately apply a new 1..8 operation limit. */
  setMaxConcurrency(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new PyValueError("maxConcurrency must be 1..8");
    this.store.update(this.id, (run) => {
      run.maxConcurrency = value;
      DynamicWorkflowStore.event(run, "concurrency");
    });
    this.#scheduler?.setConcurrency(value);
  }

  /** Execute only a run the service has already authorized by setting `queued`. */
  async execute(signal?: AbortSignal): Promise<DynamicWorkflowRun> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let scheduler: DynamicOperationScheduler | null = null;
    try {
      const before = this.store.load(this.id);
      if (before.status !== "queued") throw new PyValueError("dynamic workflow must be queued before execution");
      const running = this.store.update(this.id, (run) => {
        run.status = "running";
        delete run.error;
        delete run.result;
        // A queued run represents an explicit recovery/resume decision. A
        // durable `running` node may have been left by a dead process.
        for (const node of Object.values(run.nodes)) if (node.status === "running") node.status = "pending";
        for (const actor of Object.values(run.actors)) actor.asks = 0;
        DynamicWorkflowStore.event(run, "started");
      });
      scheduler = new DynamicOperationScheduler(running.maxConcurrency, controller.signal);
      this.#scheduler = scheduler;
      const operations = new DynamicEngineOperations(this.store, this.id, this.driver, scheduler, controller.signal);
      let primaryError: unknown;
      let failed = false;
      let result: unknown;
      try {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const compiled = compileDynamicWorkflow(running.source);
        if (compiled.diagnostics.length) {
          const error = new PyValueError("dynamic workflow source has diagnostics") as PyValueError & { diagnostics: typeof compiled.diagnostics };
          error.diagnostics = compiled.diagnostics;
          throw error;
        }
        result = await evaluateDynamicWorkflow(compiled, operations, { signal: controller.signal });
        await scheduler.drain();
        if (scheduler.failures.length) throw scheduler.failures[0];
        if (result !== undefined) result = jsonResult(result);
      } catch (error) {
        failed = true;
        primaryError = error;
        controller.abort(error);
        scheduler.cancelQueued(error);
      }
      await scheduler.drain();
      if (!failed && scheduler.failures.length > 0) {
        const failure = scheduler.failures.find((item) => item instanceof DynamicWorkflowHold) ?? scheduler.failures[0];
        primaryError = failure;
        failed = true;
      }
      const isCancelled = signal?.aborted === true || (primaryError instanceof Error && (primaryError.name === "AbortError" || ("code" in primaryError && primaryError.code === "DYNAMIC_CANCELLED")));
      const hold = primaryError instanceof DynamicWorkflowHold ? primaryError : null;
      const finalStatus = isCancelled ? "cancelled" : hold ? hold.status : failed ? "failed" : "completed";
      const finalError = !failed || hold || isCancelled ? undefined : errorText(primaryError);
      const fingerprint = workspaceFingerprint(running.root, this.store.stateDir);
      return this.store.update(this.id, (run) => {
        run.status = finalStatus;
        if (finalStatus === "completed" && result !== undefined) run.result = result;
        else delete run.result;
        if (finalError !== undefined) run.error = finalError;
        else delete run.error;
        run.workspaceFingerprint = fingerprint;
        DynamicWorkflowStore.event(run, finalStatus, hold ? { nodeId: hold.nodeId } : {});
      });
    } finally {
      this.#scheduler = null;
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
