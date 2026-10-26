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

const CLIENT_MODES = new Set(['desktop-continuous', 'web-remote-replayable']);
const CLIENT_KINDS = new Set(['desktop', 'web', 'mobileRemote', 'mobileApp']);
const HOST_CAPABILITY_KEYS = new Set([
  'nativeDialogs', 'localTerminal', 'binaryFrames', 'compression',
  'workspaceHookReview', 'independentPlanState', 'workflowRunDeltas',
]);
const CLIENT_CAPABILITY_KEYS = new Set(['workspaceHookReviewUi', 'workflowRunDeltas']);

function parseHostCapabilities(input: unknown): V4Parsed<V4HostCapabilities> {
  if (!isPlainObject(input)) return { ok: false, issue: 'capabilities must be an object' };
  const unknown = Object.keys(input).filter((key) => !HOST_CAPABILITY_KEYS.has(key)).sort();
  if (unknown.length) return { ok: false, issue: `unknown host capabilities: ${unknown.join(', ')}` };
  for (const key of ['nativeDialogs', 'localTerminal', 'binaryFrames'] as const) {
    if (typeof input[key] !== 'boolean') return { ok: false, issue: `capability ${key} must be a boolean` };
  }
  if (input.compression !== 'none' && input.compression !== 'permessage-deflate') {
    return { ok: false, issue: 'compression must be "none" or "permessage-deflate"' };
  }
  for (const key of ['workspaceHookReview', 'independentPlanState', 'workflowRunDeltas'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      return { ok: false, issue: `capability ${key} must be a boolean when present` };
    }
  }
  return { ok: true, value: input as unknown as V4HostCapabilities };
}

/** Host hello: strict shape; clientMode and deliveryProfile are a trusted pair. */
export function parseV4HelloMessage(input: unknown): V4Parsed<V4HelloMessage> {
  if (!isPlainObject(input)) return { ok: false, issue: 'hello must be an object' };
  const unknown = Object.keys(input).filter((key) =>
    !['kind', 'protocolVersion', 'connectionId', 'clientMode', 'deliveryProfile', 'serverTime', 'capabilities', 'auth'].includes(key)).sort();
  if (unknown.length) return { ok: false, issue: `unexpected hello keys: ${unknown.join(', ')}` };
  if (input.kind !== 'hello') return { ok: false, issue: 'kind must be "hello"' };
  if (input.protocolVersion !== V4_WIRE_PROTOCOL_VERSION) {
    return { ok: false, issue: `protocolVersion must be ${V4_WIRE_PROTOCOL_VERSION}` };
  }
  if (typeof input.connectionId !== 'string' || !input.connectionId) return { ok: false, issue: 'connectionId must be a non-empty string' };
  if (typeof input.clientMode !== 'string' || !CLIENT_MODES.has(input.clientMode)) {
    return { ok: false, issue: 'clientMode must be "desktop-continuous" or "web-remote-replayable"' };
  }
  const clientMode = input.clientMode as V4ClientMode;
  if (input.deliveryProfile !== 'continuous' && input.deliveryProfile !== 'replayable') {
    return { ok: false, issue: 'deliveryProfile must be "continuous" or "replayable"' };
  }
  if (input.deliveryProfile !== (clientMode === 'desktop-continuous' ? 'continuous' : 'replayable')) {
    return { ok: false, issue: 'trusted clientMode and deliveryProfile must match' };
  }
  if (typeof input.serverTime !== 'number' || !Number.isFinite(input.serverTime)) {
    return { ok: false, issue: 'serverTime must be a finite number (host Unix ms)' };
  }
  const capabilities = parseHostCapabilities(input.capabilities);
  if (!capabilities.ok) return capabilities;
  if (!isPlainObject(input.auth)) return { ok: false, issue: 'auth must be an object' };
  if (input.auth.userId !== undefined && typeof input.auth.userId !== 'string') {
    return { ok: false, issue: 'auth.userId must be a string when present' };
  }
  return { ok: true, value: input as unknown as V4HelloMessage };
}

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

/** Capability checks are `=== true` on purpose: a missing key is wire-compatible false. */
export function hostSupportsWorkspaceHookReview(capabilities: V4HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: V4ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: V4HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: V4ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

// ── Subscription envelopes ──

export interface V4SubscribeParams {
  topic: string;
  /** Watermark invariant: only send when the client truly holds that consistent state. */
  base?: { logEpoch: string; seq: number };
  /** QoS hint; affects scheduling only, never semantics. */
  visibility?: 'foreground' | 'background';
}

export interface V4SubscribeAck {
  subscriptionId: string;
  /** resume = base was valid and deltas continue from base.seq; otherwise snapshot. */
  mode: 'snapshot' | 'resume';
  logEpoch: string;
}

export function parseV4SubscribeParams(input: unknown): V4Parsed<V4SubscribeParams> {
  if (!isPlainObject(input)) return { ok: false, issue: 'subscribe params must be an object' };
  const unknown = Object.keys(input).filter((key) => !['topic', 'base', 'visibility'].includes(key)).sort();
  if (unknown.length) return { ok: false, issue: `unexpected subscribe keys: ${unknown.join(', ')}` };
  if (typeof input.topic !== 'string' || !input.topic) return { ok: false, issue: 'topic must be a non-empty string' };
  if (input.base !== undefined) {
    if (!isPlainObject(input.base)) return { ok: false, issue: 'base must be an object' };
    const baseKeys = Object.keys(input.base).sort();
    if (baseKeys.join(',') !== 'logEpoch,seq') return { ok: false, issue: 'base must have exactly logEpoch and seq' };
    if (typeof input.base.logEpoch !== 'string' || !input.base.logEpoch) return { ok: false, issue: 'base.logEpoch must be a non-empty string' };
    if (typeof input.base.seq !== 'number' || !Number.isSafeInteger(input.base.seq) || input.base.seq < 0) {
      return { ok: false, issue: 'base.seq must be a nonnegative integer' };
    }
  }
  if (input.visibility !== undefined && input.visibility !== 'foreground' && input.visibility !== 'background') {
    return { ok: false, issue: 'visibility must be "foreground" or "background"' };
  }
  return { ok: true, value: input as unknown as V4SubscribeParams };
}

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

export const V4_NOTIFICATIONS = {
  /** Downstream frames (snapshot / deltas); params = topic wire frame payload. */
  conversationFrame: 'v4/conversation/frame',
  /** Bodyless live-ingest facts only; never enter topic snapshot/recovery. */
  conversationTelemetryFact: 'v4/telemetry/event',
  localTtftFacts: 'v4/telemetry/local-ttft',
  /** Live ToolCallResult only; history and replayable paths must not fabricate. */
  cuaPermissionObservation: 'v4/cua/permission-observation',
} as const;

export type V4Notification = (typeof V4_NOTIFICATIONS)[keyof typeof V4_NOTIFICATIONS];

export const V4_MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE = 200;

export type V4ConnectionFlowState = 'saturated' | 'drained' | 'closed';

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

export function isV4Notification(method: string): method is V4Notification {
  return Object.values(V4_NOTIFICATIONS).includes(method as V4Notification);
}

/** Every V4 route is `v4/`-prefixed and the table has no duplicates — load-bearing for routing. */
export function v4RouteTableInvariants(): { all: string[]; prefixed: boolean; unique: boolean } {
  const all = Object.values(V4_METHODS);
  return { all, prefixed: all.every((method) => method.startsWith('v4/')), unique: new Set(all).size === all.length };
}
