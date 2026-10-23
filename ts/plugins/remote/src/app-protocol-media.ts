/** Staged and history media methods delegated to the composer attachment owner. */
import { protocolBoundPayload, protocolKeys, protocolScope, type AppProtocolPort, type ProtocolMethods, type ProtocolRow } from './app-protocol-types.ts';

const OUTER_KEYS = ['workspaceIdentity', 'sessionId', 'payload'] as const;
const PAYLOAD_KEYS: Record<string, readonly string[]> = {
  begin: ['version', 'uploadId', 'draftId', 'totalChunks', 'checksum', 'chunkBytes', 'name', 'mimeType', 'size', 'origin', 'path'],
  chunk: ['id', 'chunkIndex', 'data'],
  commit: ['id', 'data'],
  abort: ['id'],
  status: ['id'],
  release: ['id'],
  restore: ['messageIndex', 'revision', 'restoreId', 'restoreEpoch'],
  preview: ['id', 'chunkIndex'],
  'restore-status': ['restoreId', 'messageIndex', 'revision', 'restoreEpoch'],
  'restore-abort': ['restoreId', 'messageIndex', 'revision', 'restoreEpoch'],
  'restore-epoch': [],
};
const SESSION_REQUIRED = new Set(['restore', 'restore-status', 'restore-abort', 'restore-epoch']);

/** Every action owns only its documented attachment body fields. */
export function createAppProtocolMedia(port: AppProtocolPort): ProtocolMethods {
  const methods: ProtocolMethods = {};
  for (const [action, allowed] of Object.entries(PAYLOAD_KEYS)) {
    methods[`media/${action}`] = async (params: ProtocolRow) => {
      protocolKeys(params, OUTER_KEYS);
      const sessionId = await protocolScope(port, params, !SESSION_REQUIRED.has(action));
      const payload = protocolBoundPayload(port, params, sessionId);
      protocolKeys(payload, allowed);
      const body = { root: port.workspaceIdentity, session_id: sessionId, ...payload };
      return port.ask('POST', `/api/composer/attachments/${action}`, body);
    };
  }
  return methods;
}
