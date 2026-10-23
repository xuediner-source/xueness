/**
 * `prepareImageForModel` on a worker thread, so decoding a 20MB photo does not
 * stall the server; falls back to the calling thread when no worker can start.
 * Aborting terminates the worker (ZCode: "Image resize was cancelled").
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ImagePrepareError, prepareImageForModel, type ImagePrepareErrorCode, type PreparedImage } from "./prepare.ts";

const here = fileURLToPath(import.meta.url);
export const IMAGE_WORKER_SCRIPT = join(dirname(here), "worker" + (here.endsWith(".js") ? ".js" : ".ts"));

function cancelled(): Error {
  return Object.assign(new Error("Image resize was cancelled"), { name: "AbortError" });
}

export function prepareImage(data: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<PreparedImage> {
  if (signal?.aborted) return Promise.reject(cancelled());
  let worker: Worker;
  try {
    if (!existsSync(IMAGE_WORKER_SCRIPT)) throw new Error("no image worker");
    worker = new Worker(IMAGE_WORKER_SCRIPT, { workerData: { data, mediaType } });
  } catch {
    return Promise.resolve().then(() => prepareImageForModel(data, mediaType));
  }
  return new Promise<PreparedImage>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
      void worker.terminate();
    };
    const onAbort = (): void => settle(() => reject(cancelled()));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: { result?: PreparedImage; error?: { code: ImagePrepareErrorCode; message: string } }) => {
      settle(() => message.result ? resolve(message.result) : reject(new ImagePrepareError(message.error!.code, message.error!.message)));
    });
    worker.once("error", () => settle(() => reject(new ImagePrepareError("processing_failed", "Unable to decode image data"))));
    worker.once("exit", () => settle(() => reject(new ImagePrepareError("processing_failed", "Unable to decode image data"))));
  });
}
