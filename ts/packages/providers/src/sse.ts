/**
 * Bounded body readers: `_read_sse`, `cancel_watch.read` with the response
 * size cap, and strict UTF-8 decoding with Python's error family.
 */
import { PyValueError, pyDecodeUtf8, pyJsonLoadsBytes, pyLstrip } from "@xueness/contracts";
import type { HttpResponse } from "./http.ts";
import { readNextWithStreamIdleTimeout } from "./stream-idle-timeout.ts";

export const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_LINE = 262_144;
const MAX_STREAM = 8_000_000;

/** `bytes.decode("utf-8", "strict")` (a failure is `UnicodeDecodeError`). */
export function decodeUtf8(raw: Uint8Array): string {
  return pyDecodeUtf8(raw);
}

/** `json.loads(raw)` for a response body (duplicates keep the last; NaN allowed). */
export function loadsBody(raw: Uint8Array): unknown {
  return pyJsonLoadsBytes(raw);
}

/** `read(max + 1)` and refuse anything larger than `max` bytes. */
export async function readBody(response: HttpResponse, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<Buffer> {
  const raw = await response.read(maxBytes + 1);
  if (raw.length > maxBytes) throw new PyValueError("provider response too large");
  return raw;
}

export interface ReadSseOptions {
  idleTimeoutMs?: number;
  signal?: AbortSignal | null;
}

/** Parse complete SSE data payloads; comments and other fields do not yield. */
async function* readSsePayloads(response: HttpResponse): AsyncGenerator<string, void, undefined> {
  let data: string[] = [];
  let total = 0;
  for (;;) {
    const line = await response.readline(MAX_LINE + 1);
    if (line.length > MAX_LINE) throw new PyValueError("provider stream line too large");
    if (line.length === 0) {
      if (data.length) yield data.join("\n");
      return;
    }
    total += line.length;
    if (total > MAX_STREAM) throw new PyValueError("provider stream too large");
    const text = decodeUtf8(line).replace(/[\r\n]+$/u, "");
    if (text === "") {
      if (data.length) {
        yield data.join("\n");
        data = [];
      }
      continue;
    }
    if (text.startsWith("data:")) data.push(pyLstrip(text.slice(5)));
  }
}

/** `_read_sse`: an idle period spans comments and refreshes only after a payload. */
export async function* readSse(response: HttpResponse, options: ReadSseOptions = {}): AsyncGenerator<string, void, undefined> {
  const payloads = readSsePayloads(response)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const item = await readNextWithStreamIdleTimeout(payloads, {
        timeoutMs: options.idleTimeoutMs ?? 0,
        signal: options.signal,
        onTimeout: () => response.close(),
      });
      if (item.done) return;
      yield item.value;
    }
  } finally {
    // A timed-out `next()` may still be settling as closing the response wakes it.
    void Promise.resolve(payloads.return?.()).catch(() => undefined);
  }
}
