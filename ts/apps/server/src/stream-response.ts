/** Stream feature-owned bytes with bounded transport buffering and cancellation. */
import type { ServerResponse } from "node:http";
import { SERVER_HEADER, type SendOptions } from "./respond.ts";
export function isAsyncBody(value: unknown): value is AsyncIterable<Uint8Array> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function";
}
export async function sendStream(res: ServerResponse, status: number, body: AsyncIterable<Uint8Array>, type: string, signal: AbortSignal, options: SendOptions = {}): Promise<void> {
  if (res.destroyed || signal.aborted) return;
  res.statusCode = status;
  res.setHeader("Server", SERVER_HEADER); res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.removeHeader("Content-Length");
  if (options.close) { res.setHeader("Connection", "close"); res.shouldKeepAlive = false; }
  else res.removeHeader("connection");
  res.flushHeaders();
  const iterator = body[Symbol.asyncIterator](); let complete = false;
  let onAbort: () => void = () => {};
  const stopped = new Promise<null>((resolve) => { onAbort = () => resolve(null); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) resolve(null); });
  try {
    while (!signal.aborted && !res.destroyed) {
      const chunk = await Promise.race([iterator.next(), stopped]);
      if (!chunk) break;
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new TypeError("stream body must contain bytes");
      if (!res.write(chunk.value)) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { res.off("drain", drained); res.off("close", drained); res.off("error", failed); signal.removeEventListener("abort", drained); };
        const drained = () => { cleanup(); resolve(); }, failed = (error: Error) => { cleanup(); reject(error); };
        res.once("drain", drained); res.once("close", drained); res.once("error", failed); signal.addEventListener("abort", drained, { once: true });
        if (signal.aborted || res.destroyed) drained();
      });
    }
    if (!res.destroyed) res.end();
  } finally {
    signal.removeEventListener("abort", onAbort);
    // The shared signal interrupts the feature's waits, allowing its finally cleanup.
    if (!complete && iterator.return) await iterator.return();
  }
}
