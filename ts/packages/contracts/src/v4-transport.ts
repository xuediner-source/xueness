/**
 * ZCode protocol V4 transport contract (F11.01).
 *
 * Mirrors upstream `zcode-protocol-v4/transport.ts` at the pinned revision:
 * connection handshake, capability negotiation, subscription envelopes, the
 * `v4/*` route table and the JSON-RPC error-code vocabulary. The compatibility
 * rule is fixed here once: V4 rides the existing JSON-RPC carrier (stdio
 * NDJSON / socket) with `v4/`-prefixed method names alongside the legacy
 * protocol — but a connection negotiates one family; once V4 is chosen,
 * legacy methods are refused, and vice versa.
 */
import { V4_WIRE_PROTOCOL_VERSION } from './v4-core.ts';
import type { V4Parsed } from './v4-wire.ts';

// ── Connection handshake ──

export interface V4HostCapabilities {
  nativeDialogs: boolean;
  localTerminal: boolean;
  binaryFrames: boolean;
  compression: 'none' | 'permessage-deflate';
  /** Wire-compatible: an old host omitting the key means false; test with `=== true`. */
  workspaceHookReview?: boolean;
  independentPlanState?: boolean;
  /** Host emits `workflowRun.*` key-level deltas, raising actor/node caps to 1024. */
  workflowRunDeltas?: boolean;
}

export type V4ClientMode = 'desktop-continuous' | 'web-remote-replayable';
export type V4DeliveryProfileSelection = 'continuous' | 'replayable';

export interface V4HelloMessage {
  kind: 'hello';
  protocolVersion: typeof V4_WIRE_PROTOCOL_VERSION;
  connectionId: string;
  clientMode: V4ClientMode;
  deliveryProfile: V4DeliveryProfileSelection;
  serverTime: number;
  capabilities: V4HostCapabilities;
  auth: { userId?: string };
}

export interface V4ClientHello {
  kind: 'clientHello';
  protocolVersion: typeof V4_WIRE_PROTOCOL_VERSION;
  clientId: string;
  clientKind?: 'desktop' | 'web' | 'mobileRemote' | 'mobileApp';
  appVersion: string;
  /** Absent means an old client without the settings-centered review UI. */
  capabilities?: {
    workspaceHookReviewUi?: boolean;
    /** Single-direction rule: only sendable when the host hello set `workflowRunDeltas === true`. */
    workflowRunDeltas?: boolean;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CLIENT_KINDS = new Set(['desktop', 'web', 'mobileRemote', 'mobileApp']);
const CLIENT_CAPABILITY_KEYS = new Set(['workspaceHookReviewUi', 'workflowRunDeltas']);

/**
 * Client hello: `.strict()` semantics matter more here than anywhere else.
 * The capability declaration rule is one-directional: a client may only carry
 * `workflowRunDeltas` after seeing the host hello set it to true. An old host
 * that meets an unknown capability key fails the whole clientHello parse and
 * the connection never handshakes — that is the designed outcome, so the
 * parser must reject unknown keys exactly like upstream zod `.strict()`.
 */
export function parseV4ClientHello(input: unknown): V4Parsed<V4ClientHello> {
  if (!isPlainObject(input)) return { ok: false, issue: 'clientHello must be an object' };
  const unknown = Object.keys(input).filter((key) =>
    !['kind', 'protocolVersion', 'clientId', 'clientKind', 'appVersion', 'capabilities'].includes(key)).sort();
  if (unknown.length) return { ok: false, issue: `unexpected clientHello keys: ${unknown.join(', ')}` };
  if (input.kind !== 'clientHello') return { ok: false, issue: 'kind must be "clientHello"' };
  if (input.protocolVersion !== V4_WIRE_PROTOCOL_VERSION) {
    return { ok: false, issue: `protocolVersion must be ${V4_WIRE_PROTOCOL_VERSION}` };
  }
  if (typeof input.clientId !== 'string' || !input.clientId) return { ok: false, issue: 'clientId must be a non-empty string' };
  if (input.clientKind !== undefined && (typeof input.clientKind !== 'string' || !CLIENT_KINDS.has(input.clientKind))) {
    return { ok: false, issue: 'clientKind must be desktop, web, mobileRemote or mobileApp' };
  }
  if (typeof input.appVersion !== 'string' || !input.appVersion) return { ok: false, issue: 'appVersion must be a non-empty string' };
  if (input.capabilities !== undefined) {
    if (!isPlainObject(input.capabilities)) return { ok: false, issue: 'capabilities must be an object' };
    const unknownCaps = Object.keys(input.capabilities).filter((key) => !CLIENT_CAPABILITY_KEYS.has(key)).sort();
    if (unknownCaps.length) return { ok: false, issue: `unknown client capabilities: ${unknownCaps.join(', ')}` };
    for (const [key, value] of Object.entries(input.capabilities)) {
      if (typeof value !== 'boolean') return { ok: false, issue: `capability ${key} must be a boolean` };
    }
  }
  return { ok: true, value: input as unknown as V4ClientHello };
}

export function hostSupportsWorkflowRunDeltas(capabilities: V4HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

// ── Subscription envelopes ──

// ── v4 RPC surface (host channel layer) ──

/** v4 route names ride the existing JSON-RPC carrier beside legacy methods. */
export const V4_METHODS = {
  connectionFlow: 'v4/connection/flow',
  controllerSubscribe: 'v4/controller/subscribe',
  controllerResync: 'v4/controller/resync',
  controllerUnsubscribe: 'v4/controller/unsubscribe',
  conversationSubscribe: 'v4/conversation/subscribe',
  conversationResync: 'v4/conversation/resync',
  conversationUnsubscribe: 'v4/conversation/unsubscribe',
  conversationRowsRange: 'v4/conversation/rowsRange',
  conversationPlans: 'v4/conversation/plans',
  conversationFileChanges: 'v4/conversation/fileChanges',
  backgroundBashOutput: 'v4/conversation/backgroundBashOutput',
  conversationFileRewindPreview: 'v4/conversation/fileRewindPreview',
  conversationWorkflowRunEvents: 'v4/conversation/workflowRunEvents',
  conversationWorkflowRuns: 'v4/conversation/workflowRuns',
  conversationWorkflowRunArtifacts: 'v4/conversation/workflowRunArtifacts',
  conversationWorkflowRunArtifactData: 'v4/conversation/workflowRunArtifactData',
  conversationWorkflowRunArtifactRead: 'v4/conversation/workflowRunArtifactRead',
  conversationWorkflowRunWorkspace: 'v4/conversation/workflowRunWorkspace',
  conversationWorkflowRunNodeResult: 'v4/conversation/workflowRunNodeResult',
  usageStats: 'v4/usage/stats',
  conversationUsage: 'v4/conversation/usage',
  attachmentBegin: 'v4/attachment/begin',
  attachmentChunk: 'v4/attachment/chunk',
  attachmentCommit: 'v4/attachment/commit',
  attachmentAbort: 'v4/attachment/abort',
  attachmentRead: 'v4/attachment/read',
  conversationAttachmentRead: 'v4/conversation/attachmentRead',
  conversationAttachmentStat: 'v4/conversation/attachmentStat',
  attachmentPreviewSource: 'v4/attachment/previewSource',
  commandsQuery: 'v4/commands/query',
  command: 'v4/command',
} as const;

export type V4Method = (typeof V4_METHODS)[keyof typeof V4_METHODS];

// ── Error vocabulary ──

/** JSON-RPC 2.0 base codes, shared with the legacy carrier. */
export const V4_JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** V4 refusal codes ride `data.reasonCode` inside JSON-RPC application errors. */
export const V4_REFUSAL_REASONS = {
  unsupportedProtocolVersion: 'fault.protocol.unsupportedVersion',
  alreadyInitialized: 'fault.protocol.alreadyInitialized',
  wrongProtocolFamily: 'fault.protocol.wrongFamily',
  notInitialized: 'fault.protocol.notInitialized',
  unknownTopic: 'fault.subscription.unknownTopic',
  resyncRequired: 'fault.subscription.resyncRequired',
  recoveryFailed: 'fault.subscription.recoveryFailed',
  contentRejected: 'fault.subscription.contentRejected',
} as const;

export function isV4Method(method: string): method is V4Method {
  return Object.values(V4_METHODS).includes(method as V4Method);
}

/** Every V4 route is `v4/`-prefixed and the table has no duplicates — load-bearing for routing. */
export function v4RouteTableInvariants(): { all: string[]; prefixed: boolean; unique: boolean } {
  const all = Object.values(V4_METHODS);
  return { all, prefixed: all.every((method) => method.startsWith('v4/')), unique: new Set(all).size === all.length };
}
