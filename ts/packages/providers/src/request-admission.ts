import { performance } from "node:perf_hooks";
import { ProviderCancelled } from "./errors.ts";

export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

/**
 * Who is asking for a slot. `foreground` marks main-task traffic: it is
 * admitted without queueing but still counts in flight and feeds feedback.
 * `run` keys cross-run round-robin fairness; omitted scopes share one queue.
 */
export interface ModelRequestAdmissionScope {
  foreground?: boolean;
  run?: string;
}

export interface ModelRequestAdmissionTicket {
  publish?(info: Record<string, unknown>): void | Promise<void>;
  release(): void;
}

export interface ModelRequestAdmission {
  tryAcquire?(input: { model: ModelRequestTarget; scope?: ModelRequestAdmissionScope }): ModelRequestAdmissionTicket | undefined;
  acquire(input: { model: ModelRequestTarget; signal?: AbortSignal; scope?: ModelRequestAdmissionScope }): Promise<ModelRequestAdmissionTicket>;
}

export interface AttemptAdmission {
  ticket?: ModelRequestAdmissionTicket;
  release(): void;
}

export interface AdmitAttemptInput {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  scope?: ModelRequestAdmissionScope;
  onQueued?(): Promise<void>;
  onAdmitted?(queuedMs: number): Promise<void>;
}

const emptyAdmission: AttemptAdmission = { release() {} };

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderCancelled();
}

function withTicket(ticket: ModelRequestAdmissionTicket): AttemptAdmission {
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}

function cancelledOrOriginal(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw new ProviderCancelled();
  throw error;
}

async function acquireTicket(
  admission: ModelRequestAdmission,
  model: ModelRequestTarget,
  signal?: AbortSignal,
  scope?: ModelRequestAdmissionScope,
): Promise<ModelRequestAdmissionTicket> {
  try {
    return await admission.acquire({ model, signal, scope });
  } catch (error) {
    return cancelledOrOriginal(error, signal);
  }
}

/** Acquire a request-scoped ticket, invoking queue observers only on a slow path. */
export async function admitAttempt(input: AdmitAttemptInput): Promise<AttemptAdmission> {
  const { admission, model, signal, scope, onQueued, onAdmitted } = input;
  if (!admission) {
    assertNotAborted(signal);
    return emptyAdmission;
  }

  assertNotAborted(signal);
  if (admission.tryAcquire) {
    let fastTicket: ModelRequestAdmissionTicket | undefined;
    try {
      fastTicket = admission.tryAcquire({ model, scope });
    } catch (error) {
      return cancelledOrOriginal(error, signal);
    }
    if (fastTicket) {
      const result = withTicket(fastTicket);
      if (signal?.aborted) {
        result.release();
        throw new ProviderCancelled();
      }
      return result;
    }

    assertNotAborted(signal);
    const queuedAt = performance.now();
    await onQueued?.();
    assertNotAborted(signal);
    const ticket = await acquireTicket(admission, model, signal, scope);
    const result = withTicket(ticket);
    try {
      assertNotAborted(signal);
      await onAdmitted?.(Math.max(0, performance.now() - queuedAt));
      assertNotAborted(signal);
      return result;
    } catch (error) {
      result.release();
      return cancelledOrOriginal(error, signal);
    }
  }

  assertNotAborted(signal);
  const ticket = await acquireTicket(admission, model, signal, scope);
  const result = withTicket(ticket);
  if (signal?.aborted) {
    result.release();
    throw new ProviderCancelled();
  }
  return result;
}
