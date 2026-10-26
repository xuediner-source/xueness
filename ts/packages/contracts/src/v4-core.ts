/**
 * ZCode protocol V4 core constants (F11.01).
 *
 * Mirrors upstream `zcode-protocol-v4/core.ts` at fixed source revision: the
 * wire protocol is named V4 but the physical wire constant is 3. Compatibility
 * targets are pinned to this schema, never to the marketing version number.
 */

/** V4 physical wire protocol version; the name says V4, the wire says 3. */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

/** V4 logical projection snapshots keep their own independent version. */
export const V4_PROJECTION_PROTOCOL_VERSION = 1 as const;

/** Clock rule: Unix ms, always the CLI/host clock; clients never diff against local time. */
export type V4Timestamp = number;

export type V4StreamablePath = 'text' | 'inputText' | 'output.text' | 'summaryText';

export interface V4DeliveryProfile {
  desktopOnlyRows: boolean;
  flushWindowMs: number;
  streamPaths: Record<V4StreamablePath, boolean>;
  streamOutputCapBytes: number;
  toolProgress: boolean;
}

export const V4_DELIVERY_PROFILES = {
  continuous: {
    desktopOnlyRows: true,
    flushWindowMs: 30,
    streamPaths: { text: true, inputText: true, 'output.text': true, summaryText: true },
    streamOutputCapBytes: 262144,
    toolProgress: false,
  },
  replayable: {
    desktopOnlyRows: false,
    flushWindowMs: 150,
    streamPaths: { text: true, inputText: false, 'output.text': false, summaryText: false },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} as const satisfies Record<string, V4DeliveryProfile>;

export type V4DeliveryProfileName = keyof typeof V4_DELIVERY_PROFILES;

/** Limits and quotas (initial values, tuned against real traffic upstream). */
export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
  transportEnvelopeIdMaxChars: 256,
  subscriberBufferMaxOps: 500,
  subscriberBufferMaxBytes: 1024 * 1024,
  eventRetentionPerSession: 2000,
  snapshotTailWindowRows: 60,
  rowsRangeMaxLimit: 200,
  toolOutputFinalHeadBytes: 32 * 1024,
  toolOutputFinalTailBytes: 32 * 1024,
  goalVerificationsRetained: 20,
  pendingCommandsDisplayMax: 32,
  commandPendingTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTablePerSession: 512,
  conversationQueryTimeoutMs: 10_000,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
  attachmentUploadMaxChunks: 64,
  attachmentUploadMaxConcurrent: 16,
  attachmentUploadMaxStagedBytes: 64 * 1024 * 1024,
  attachmentUploadTtlMs: 5 * 60_000,
} as const;
