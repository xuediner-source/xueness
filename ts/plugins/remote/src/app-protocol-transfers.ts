/** Bounded, session-owned response fragments for the native stdio protocol. */
import { createHash, randomUUID } from 'node:crypto';
import { pyJsonDumps } from '@xueness/contracts';
import { AppProtocolError, type AppProtocolPort, type ProtocolRow } from './app-protocol-types.ts';

const CHUNK_BYTES = 256 * 1024;
const FRAGMENT_AFTER = 768 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFERS = 8;
const TTL_MS = 60_000;
const FRAGMENT_METHODS = new Set(['browser/action', 'conversation/snapshot', 'conversation/resume', 'conversation/rowsRange', 'controller/frame', 'workflow/get', 'workflow/events', 'session/read', 'history/fork-boundaries', 'composer/catalog', 'question/read', 'withdrawal/list', 'withdrawal/get', 'guidance/read', 'guidance/send', 'guidance/promote', 'media/restore', 'media/preview', 'media/restore-status']);

interface Transfer {
  id: string;
  workspaceIdentity: string;
  sessionId: string | null;
  bytes: Buffer;
  chunkBytes: number;
  totalChunks: number;
  sha256: string;
  createdAt: number;
}

export interface AppProtocolTransfers {
  wrap(method: string, sessionId: string | null, result: unknown): unknown;
  read(workspaceIdentity: string, sessionId: string | null, transferId: string, chunkIndex: number): ProtocolRow;
  close(): void;
}

function tooLarge(): never {
  throw new AppProtocolError('response exceeds transfer size limit', -32000, { status: 413 });
}

/** Keep a bounded byte store so stdio frame-size handling stays deterministic. */
export function createAppProtocolTransfers(port: Pick<AppProtocolPort, 'workspaceIdentity'>): AppProtocolTransfers {
  const transfers = new Map<string, Transfer>();
  let totalBytes = 0;

  const remove = (id: string): void => {
    const transfer = transfers.get(id);
    if (!transfer) return;
    transfers.delete(id);
    totalBytes -= transfer.bytes.length;
  };
  const expire = (now = Date.now()): void => {
    for (const [id, transfer] of transfers) if (now - transfer.createdAt >= TTL_MS) remove(id);
  };

  return {
    wrap(method, sessionId, result) {
      if (!FRAGMENT_METHODS.has(method) || sessionId === null && method !== 'controller/frame' || result === null || typeof result !== 'object') return result;
      let bytes: Buffer;
      try { bytes = Buffer.from(pyJsonDumps(result, { ensureAscii: false, separators: [',', ':'] }), 'utf8'); }
      catch { return result; }
      if (bytes.length <= FRAGMENT_AFTER) return result;
      if (bytes.length > MAX_RESPONSE_BYTES) return tooLarge();
      expire();
      if (transfers.size >= MAX_TRANSFERS || totalBytes + bytes.length > MAX_TOTAL_BYTES) {
        throw new AppProtocolError('response transfer capacity is full', -32000, { status: 503 });
      }
      const transferId = randomUUID().replace(/-/g, '');
      const chunkBytes = CHUNK_BYTES;
      const totalChunks = Math.ceil(bytes.length / chunkBytes);
      if (totalChunks < 1 || totalChunks > 128) return tooLarge();
      const transfer: Transfer = {
        id: transferId,
        workspaceIdentity: port.workspaceIdentity,
        sessionId,
        bytes,
        chunkBytes,
        totalChunks,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt: Date.now(),
      };
      transfers.set(transferId, transfer);
      totalBytes += bytes.length;
      return { schema: 'xueness.remote-fragment.v1', transferId, byteLength: bytes.length, chunkBytes, totalChunks, sha256: transfer.sha256 };
    },
    read(workspaceIdentity, sessionId, transferId, chunkIndex) {
      expire();
      const transfer = transfers.get(transferId);
      if (!transfer || transfer.workspaceIdentity !== workspaceIdentity || transfer.sessionId !== sessionId) {
        throw new AppProtocolError('response transfer not found', -32000, { status: 404 });
      }
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
        throw new AppProtocolError('invalid response chunk index', -32602);
      }
      const start = chunkIndex * transfer.chunkBytes;
      return { transferId, chunkIndex, data: transfer.bytes.subarray(start, start + transfer.chunkBytes).toString('base64') };
    },
    close() { transfers.clear(); totalBytes = 0; },
  };
}
