import type { AttachmentPreview } from './composerAttachmentPreviewModel';

const SCHEMA = 'xueness.image-preview-chunk.v1';
const CHUNK_BYTES = 256 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const KEYS = new Set(['schema', 'id', 'name', 'mimeType', 'size', 'kind', 'truncated', 'sha256', 'chunkIndex', 'chunkBytes', 'totalChunks', 'data']);
type Chunk = { schema: string; id: string; name: string; mimeType: string; size: number; kind: 'image'; truncated: false;
  sha256: string; chunkIndex: number; chunkBytes: number; totalChunks: number; data: string };

export function isImagePreviewFragment(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).schema === SCHEMA);
}

function parseChunk(value: unknown, index: number): Chunk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid image preview chunk');
  const v = value as Chunk;
  if (Object.keys(v).some(key => !KEYS.has(key)) || v.schema !== SCHEMA || v.kind !== 'image' || v.truncated !== false ||
      typeof v.id !== 'string' || !/^[0-9a-f]{32}$/.test(v.id) || typeof v.name !== 'string' || !v.name || v.name.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(v.name) || ['.', '..'].includes(v.name) || !MIMES.has(v.mimeType) ||
      !Number.isInteger(v.size) || v.size <= 0 || v.size > MAX_BYTES || v.chunkBytes !== CHUNK_BYTES ||
      v.totalChunks !== Math.ceil(v.size / CHUNK_BYTES) || v.chunkIndex !== index || index >= v.totalChunks ||
      typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256) || typeof v.data !== 'string') {
    throw new Error('Invalid image preview chunk');
  }
  const bytes = Math.min(CHUNK_BYTES, v.size - index * CHUNK_BYTES);
  if (v.data.length !== 4 * Math.ceil(bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)) throw new Error('Invalid image preview data');
  return v;
}

/** Covers headers, body decoding and noncooperative injected transports alike. */
export async function withPreviewDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
  timeoutMs = 120_000): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Image preview timed out')), timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error('Image preview aborted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** Sequential, abortable, in-memory only. Each read reauthorizes the original reference. */
export async function collectImagePreview(first: unknown, read: (index: number, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal): Promise<AttachmentPreview> {
  return withPreviewDeadline(inner => collect(first, read, inner), signal);
}

async function collect(first: unknown, read: (index: number, signal?: AbortSignal) => Promise<unknown>,
  signal: AbortSignal): Promise<AttachmentPreview> {
  const initial = parseChunk(first, 0);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < initial.totalChunks; index++) {
    signal?.throwIfAborted();
    const part = index === 0 ? initial : parseChunk(await withPreviewDeadline(inner => read(index, inner), signal, 15_000), index);
    signal?.throwIfAborted();
    for (const key of ['id', 'name', 'mimeType', 'size', 'sha256', 'totalChunks'] as const) {
      if (part[key] !== initial[key]) throw new Error('Image preview changed during transfer');
    }
    const decoded = atob(part.data);
    if (decoded.length !== Math.min(CHUNK_BYTES, initial.size - index * CHUNK_BYTES)) throw new Error('Invalid image preview length');
    parts.push(Uint8Array.from(decoded, char => char.charCodeAt(0)));
  }
  const blob = new Blob(parts, { type: initial.mimeType });
  const bytes = await blob.arrayBuffer();
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== initial.sha256) throw new Error('Image preview checksum mismatch');
  return { id: initial.id, name: initial.name, mimeType: initial.mimeType, size: initial.size, kind: 'image', truncated: false, blob };
}
