import { post } from "../../xuenessApi";
import { attachmentBaseName, attachmentMime, parseAttachmentRef, type AttachmentOrigin, type AttachmentRef, type RemoteAttachmentEndpoint } from "./composerAttachmentRef";

export const ATTACHMENT_CHUNK_BYTES = 384 * 1024;
export const ATTACHMENT_REQUEST_TIMEOUT_MS = 30_000;
export type UploadOwner = { root: string; sessionId?: string; draftKey: string; remote?: RemoteAttachmentEndpoint };
export type UploadTransport = (<T>(path: string, body: object, signal?: AbortSignal) => Promise<T>) & { chunkBytes?: number; attachmentLimits?: { count: number; imageBytes: number; totalBytes: number } };
export type UploadProgress = { ref: AttachmentRef; status: "pending" | "committed"; nextChunkIndex: number; uploadedBytes: number };
export type UploadInput = {
  owner: UploadOwner; file: File; origin: Exclude<AttachmentOrigin, "workspace">; uploadId: string;
  signal: AbortSignal; isCurrent: () => boolean;
  onProgress?: (progress: UploadProgress) => void;
  transport?: UploadTransport;
  /** May shorten, never extend the full-response deadline. */
  requestTimeoutMs?: number;
};
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function uploadScope(owner: UploadOwner): { root: string; session_id?: string } {
  return { root: owner.root, ...(owner.sessionId ? { session_id: owner.sessionId } : {}) };
}
export function canonicalUploadOwner(owner: UploadOwner): string {
  return JSON.stringify(owner.remote ? [owner.root, owner.sessionId ?? null, owner.draftKey, owner.remote] : [owner.root, owner.sessionId ?? null, owner.draftKey]);
}
export async function attachmentSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function check(input: UploadInput): void {
  input.signal.throwIfAborted();
  if (!input.isCurrent()) throw new DOMException("Upload owner changed", "AbortError");
}
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
/** Settle independently of fetch cooperation, including CSRF acquisition and body decoding. */
export function boundedRequest(transport: UploadTransport, path: string, body: object, signal?: AbortSignal,
  timeoutMs = ATTACHMENT_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, ATTACHMENT_REQUEST_TIMEOUT_MS) : ATTACHMENT_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error); else resolve(value);
    };
    const aborted = () => {
      const error = signal?.reason ?? new DOMException("Attachment upload aborted", "AbortError");
      finish(error);
      controller.abort(error);
    };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => {
      const error = new DOMException("Attachment upload request timed out", "TimeoutError");
      finish(error);
      controller.abort(error);
    }, deadline);
    // Attach both handlers even after a timeout: late fulfillment or rejection cannot publish state.
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return transport(path, body, controller.signal);
    }).then(value => finish(undefined, value), error => finish(error));
  });
}
/** Retransmit only the identical idempotent operation; never allocate a new identity after uncertainty. */
async function request(input: UploadInput, operation: string, body: object): Promise<unknown> {
  if (input.owner.remote && !input.transport) throw new Error("Remote attachment transport unavailable");
  const transport = input.transport ?? post;
  for (let attempt = 0; ; attempt++) {
    check(input);
    try {
      const value = await boundedRequest(transport, `/api/composer/attachments/${operation}`, body,
        input.signal, input.requestTimeoutMs);
      check(input);
      return value;
    } catch (error) {
      check(input);
      const transient = error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
      if (attempt >= 1 || !transient) throw error;
    }
  }
}
function validateRef(value: unknown, input: UploadInput, id?: string): AttachmentRef {
  const ref = parseAttachmentRef(value);
  const mime = attachmentMime(input.file.name, input.file.type);
  if (!ref || (id !== undefined && ref.id !== id) || ref.name !== attachmentBaseName(input.file.name)
      || ref.size !== input.file.size || ref.mimeType !== mime || ref.origin !== input.origin || ref.source !== "upload") {
    throw new Error("Invalid attachment upload identity");
  }
  return input.owner.remote ? { ...ref, remoteOwner: { ...input.owner.remote, root: input.owner.root, sessionId: input.owner.sessionId, draftKey: input.owner.draftKey } } : ref;
}
function chunkBytes(input: UploadInput): number { return input.owner.remote ? Math.min(input.transport?.chunkBytes ?? 256 * 1024, 256 * 1024) : ATTACHMENT_CHUNK_BYTES; }
function progressResponse(value: unknown, input: UploadInput, total: number, id?: string): UploadProgress {
  if (!value || typeof value !== "object") throw new Error("Invalid attachment progress");
  const data = value as Record<string, unknown>;
  const ref = validateRef(data.ref, input, id);
  const index = data.nextChunkIndex;
  if ((data.status !== "pending" && data.status !== "committed") || typeof index !== "number"
      || !Number.isInteger(index) || index < 0 || index > total
      || data.uploadedBytes !== Math.min(index * chunkBytes(input), input.file.size)
      || (data.status === "committed" && index !== total)) throw new Error("Invalid attachment progress");
  return { ref, status: data.status, nextChunkIndex: index, uploadedBytes: data.uploadedBytes as number };
}

/** Streaming-sized HTTP transactions. Only the final committed reference is publishable. */
export async function uploadComposerAttachment(input: UploadInput): Promise<AttachmentRef> {
  check(input);
  if (!OPAQUE_ID.test(input.uploadId)) throw new Error("Invalid upload identity");
  if (!attachmentMime(input.file.name, input.file.type)) throw new Error("Unsupported attachment type");
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  check(input);
  if (bytes.length !== input.file.size) throw new Error("Attachment size changed");
  const [checksum, draftId] = await Promise.all([
    attachmentSha256(bytes), attachmentSha256(new TextEncoder().encode(canonicalUploadOwner(input.owner))),
  ]);
  check(input);
  const total = Math.ceil(bytes.length / chunkBytes(input));
  const scope = uploadScope(input.owner);
  let progress = progressResponse(await request(input, "begin", {
    ...scope, version: 1, uploadId: input.uploadId, draftId, totalChunks: total,
    chunkBytes: chunkBytes(input), checksum: `sha256:${checksum}`,
    name: attachmentBaseName(input.file.name), mimeType: attachmentMime(input.file.name, input.file.type),
    size: bytes.length, origin: input.origin,
  }), input, total);
  check(input);
  input.onProgress?.(progress);
  if (progress.status === "committed") return progress.ref;
  while (progress.nextChunkIndex < total) {
    const index = progress.nextChunkIndex;
    const next = progressResponse(await request(input, "chunk", {
      ...scope, id: progress.ref.id, chunkIndex: index,
      data: encode(bytes.subarray(index * chunkBytes(input), (index + 1) * chunkBytes(input))),
    }), input, total, progress.ref.id);
    if (next.status !== "pending" || next.nextChunkIndex !== index + 1) throw new Error("Invalid attachment chunk acknowledgement");
    check(input);
    progress = next;
    input.onProgress?.(progress);
  }
  const response = await request(input, "commit", { ...scope, id: progress.ref.id });
  if (!response || typeof response !== "object" || (response as { status?: unknown }).status !== "committed") {
    throw new Error("Attachment was not committed");
  }
  const ref = validateRef((response as { ref?: unknown }).ref, input, progress.ref.id);
  check(input);
  return ref;
}

export async function abortComposerAttachment(owner: UploadOwner, id: string, signal?: AbortSignal, transport: UploadTransport = post): Promise<AttachmentRef | undefined> {
  if (!OPAQUE_ID.test(id)) throw new Error("Invalid attachment identity");
  const response = await boundedRequest(transport, "/api/composer/attachments/abort", { ...uploadScope(owner), id }, signal) as { status?: string; ref?: unknown };
  if (response?.status === 'committed') {
    const ref = parseAttachmentRef(response.ref);
    if (!ref || ref.id !== id) throw new Error('Invalid canceled attachment identity');
    return ref;
  }
  if (response?.status !== 'aborted') throw new Error('Attachment cancellation is unconfirmed');
}
