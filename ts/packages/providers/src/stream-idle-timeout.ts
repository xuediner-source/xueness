/** Model stream idle limits and the typed timeout raised while reading SSE. */
import { ProviderCancelled, ProviderRequestError } from "./errors.ts";

export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;
export const MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS = 30_000;

export interface ModelStreamIdleTimeoutOptions {
  baseTimeoutMs?: number;
  retryNumber?: number;
}

/** Resolve the per-attempt timeout; non-positive bases explicitly disable it. */
export function resolveModelStreamIdleTimeoutMs({
  baseTimeoutMs = DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  retryNumber = 0,
}: ModelStreamIdleTimeoutOptions = {}): number {
  const base = Number.isFinite(baseTimeoutMs) ? baseTimeoutMs : DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
  if (base <= 0) return 0;
  const retries = Number.isFinite(retryNumber) && retryNumber > 0 ? Math.floor(retryNumber) : 0;
  const effective = base + retries * MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS;
  return Number.isFinite(effective) ? effective : Number.MAX_SAFE_INTEGER;
}

/** A provider stream stopped producing complete SSE data payloads. */
export class ModelStreamIdleTimeoutError extends ProviderRequestError {
  override name = "ModelStreamIdleTimeoutError";
  readonly code = "MODEL_STREAM_IDLE_TIMEOUT";

  constructor() {
    super({ category: "timeout", stage: "read", exceptionType: "ModelStreamIdleTimeoutError" });
  }
}

export function isModelStreamIdleTimeoutError(error: unknown): error is ModelStreamIdleTimeoutError {
  return error instanceof ModelStreamIdleTimeoutError;
}

export interface ReadNextWithStreamIdleTimeoutOptions {
  timeoutMs: number;
  signal?: AbortSignal | null;
  onTimeout: () => void;
}

/** Read one iterator item with a fresh idle period and cooperative cancellation. */
export async function readNextWithStreamIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  options: ReadNextWithStreamIdleTimeoutOptions,
): Promise<IteratorResult<T>> {
  const { timeoutMs, signal, onTimeout } = options;
  if (signal?.aborted) throw new ProviderCancelled();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new ModelStreamIdleTimeoutError();
        try {
          onTimeout();
        } catch {
          // A transport close failure must not replace the idle timeout.
        }
        reject(error);
      }, timeoutMs);
    }
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(new ProviderCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    const read = Promise.resolve().then(() => {
      if (signal?.aborted) throw new ProviderCancelled();
      return iterator.next();
    });
    return await Promise.race([read, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
