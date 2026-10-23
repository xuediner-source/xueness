/** Worker thread entry for `prepareImage`: decode and re-encode off the event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { ImagePrepareError, prepareImageForModel } from "./prepare.ts";

const { data, mediaType } = workerData as { data: Uint8Array; mediaType: string };
try {
  const result = prepareImageForModel(data, mediaType);
  const bytes = result.data === data ? result.data.slice() : result.data;
  parentPort!.postMessage({ result: { ...result, data: bytes } }, [bytes.buffer as ArrayBuffer]);
} catch (error) {
  const prepare = error instanceof ImagePrepareError;
  parentPort!.postMessage({ error: { code: prepare ? error.code : "processing_failed", message: prepare ? error.message : "Unable to decode image data" } });
}
