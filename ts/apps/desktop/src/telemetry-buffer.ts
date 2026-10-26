/**
 * H12.02 — Bounded harness telemetry ring buffer + JSONL export.
 */
import {
  type HarnessTelemetryEvent,
  redactHarnessTelemetryEvent,
  validateHarnessTelemetryEvent,
} from "./harness-telemetry.ts";

export interface TelemetryBufferOptions {
  readonly capacity?: number;
  readonly redact?: boolean;
}

export interface TelemetryBuffer {
  readonly capacity: number;
  readonly size: number;
  push(raw: unknown): { ok: boolean; error?: string };
  snapshot(): readonly HarnessTelemetryEvent[];
  exportJsonl(): string;
  clear(): void;
}

export function createTelemetryBuffer(options: TelemetryBufferOptions = {}): TelemetryBuffer {
  const capacity = options.capacity ?? 256;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("telemetry buffer capacity must be a positive integer");
  const redact = options.redact ?? true;
  const ring: (HarnessTelemetryEvent | undefined)[] = new Array(capacity);
  let start = 0;
  let size = 0;

  return {
    capacity,
    get size() { return size; },
    push(raw) {
      const validated = validateHarnessTelemetryEvent(raw);
      if (!validated.valid || !validated.event) {
        return { ok: false, error: validated.errors.join("; ") || "invalid event" };
      }
      const event = redact ? redactHarnessTelemetryEvent(validated.event) : validated.event;
      if (size < capacity) {
        ring[(start + size) % capacity] = event;
        size += 1;
      } else {
        ring[start] = event;
        start = (start + 1) % capacity;
      }
      return { ok: true };
    },
    snapshot() {
      const out: HarnessTelemetryEvent[] = [];
      for (let i = 0; i < size; i += 1) out.push(ring[(start + i) % capacity]!);
      return Object.freeze(out);
    },
    exportJsonl() {
      return this.snapshot().map((event) => JSON.stringify(event)).join("\n");
    },
    clear() {
      start = 0;
      size = 0;
      ring.fill(undefined);
    },
  };
}
