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
    while (!signal.aborted && !res.destroyed && !res.socket?.destroyed) {
      const chunk = await Promise.race([iterator.next(), stopped]);
      if (!chunk) break;
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new TypeError("stream body must contain bytes");
      // A false write needs an actual drain even if the socket currently
      // reports no pressure. Response and socket buffers must both clear.
      const sink = res.socket ?? res;
      const accepted = res.write(chunk.value);
      if (!accepted || res.writableNeedDrain || sink.writableNeedDrain) await new Promise<void>((resolve, reject) => {
        let drained = accepted;
        const targets = new Set([res, sink]);
        const cleanup = () => {
          for (const target of targets) { target.off("drain", onDrain); target.off("close", closed); target.off("error", failed); }
          signal.removeEventListener("abort", closed);
        };
        const closed = () => { cleanup(); resolve(); };
        const ready = () => {
          if (signal.aborted || res.destroyed || sink.destroyed) closed();
          else if (drained && !res.writableNeedDrain && !sink.writableNeedDrain) closed();
        };
        const onDrain = () => { drained = true; ready(); };
        const failed = (error: Error) => {
          if (signal.aborted || res.destroyed || sink.destroyed) closed();
          else { cleanup(); reject(error); }
        };
        for (const target of targets) { target.on("drain", onDrain); target.on("close", closed); target.on("error", failed); }
        signal.addEventListener("abort", closed, { once: true });
        ready();
      });
    }
    if (!res.destroyed) res.end();
  } finally {
    signal.removeEventListener("abort", onAbort);
    // The shared signal interrupts the feature's waits, allowing its finally cleanup.
    if (!complete && iterator.return) await iterator.return();
  }
}
