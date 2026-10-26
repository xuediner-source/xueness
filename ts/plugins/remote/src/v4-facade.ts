/**
 * V4 compatibility facade (F11.01): negotiates the upstream ZCode V4 contract
 * on top of the native xueness app-protocol without renaming v2 fields.
 *
 * The facade owns three invariants from the C-RMT-01 contract row:
 * 1. The first `initialize` fixes the connection's protocol family; V4 rides
 *    `protocolVersion: 3` (the upstream wire constant). After V4 negotiation,
 *    legacy method names are refused as a family mismatch — and vice versa.
 * 2. Capability negotiation happens in the hello exchange, not by method
 *    probing: the host declares capabilities, the client may only echo
 *    capability keys the host hello validated (one-directional rule).
 * 3. Only the curated `v4/*` → native route map is dispatchable; every other
 *    upstream V4 route answers with a typed refusal, never a silent rename.
 */
import {
  V4_JSONRPC_ERROR_CODES,
  V4_METHODS,
  V4_REFUSAL_REASONS,
  V4_WIRE_PROTOCOL_VERSION,
  encodeV4TopicWireFrames,
  hostSupportsWorkflowRunDeltas,
  isV4Method,
  parseV4ClientHello,
  utf8JsonByteLength,
  v4RouteTableInvariants,
  type V4ClientHello,
  type V4HelloMessage,
  type V4HostCapabilities,
  type V4TopicWireFrame,
} from '@xueness/contracts';
import { AppProtocolError, type AppProtocolPort, type ProtocolMethods, type ProtocolRow } from './app-protocol-types.ts';

export const V4_PROTOCOL_NAME = 'zcode.protocol.v4';

/** Host capability catalog for this facade; `undefined`-able keys stay absent, never false. */
const HOST_CAPABILITIES: V4HostCapabilities = {
  nativeDialogs: false,
  localTerminal: false,
  binaryFrames: false,
  compression: 'none',
};

export function v4HostCapabilities(): ProtocolRow {
  return { ...HOST_CAPABILITIES };
}

/** v4 routes that have a semantically equivalent native handler today. */
export const V4_TO_NATIVE_ROUTES: Partial<Record<string, string>> = {
  [V4_METHODS.connectionFlow]: 'connection/flow',
  [V4_METHODS.controllerSubscribe]: 'controller/subscribe',
  [V4_METHODS.controllerResync]: 'controller/resync',
  [V4_METHODS.controllerUnsubscribe]: 'controller/unsubscribe',
  [V4_METHODS.conversationSubscribe]: 'conversation/subscribe',
  [V4_METHODS.conversationResync]: 'conversation/resync',
  [V4_METHODS.conversationUnsubscribe]: 'conversation/unsubscribe',
  [V4_METHODS.conversationRowsRange]: 'conversation/rowsRange',
  [V4_METHODS.commandsQuery]: 'command/query',
  [V4_METHODS.command]: 'command/execute',
};

export interface V4FacadeOptions {
  port: Pick<AppProtocolPort, 'workspaceIdentity'>;
  connectionId: string;
  xuenessVersion: string;
  nativeMethods: () => ProtocolMethods;
}

export interface V4Facade {
  /** Handles the connection-level clientHello registration; returns the host hello. */
  acceptClientHello(input: unknown): V4HelloMessage;
  /** Handles `initialize` with `protocolVersion: 3`; returns the V4 negotiation result. */
  initialize(input: ProtocolRow): ProtocolRow;
  /**
   * Family guard plus v4 route dispatch. `legacyFamily` tells whether this
   * connection already negotiated v1/v2; it is only read, never mutated here.
   */
  dispatch(method: string, params: ProtocolRow, legacyFamily: boolean): Promise<unknown>;
  /** Encodes a logical topic frame into physical wire frames and emits each one. */
  notifyWireFrames(params: { method: string; topic: string; subscriptionId: string; logicalFrameId: string; logicalFrameOrdinal: number; frame: unknown; deliveryKind?: 'initial' | 'online' | 'recovery'; maxPhysicalFrameBytes?: number }): Promise<V4TopicWireFrame<unknown>[]>;
  state(): { negotiated: boolean; clientHello: V4ClientHello | null };
}

export function createV4Facade(options: V4FacadeOptions & { notify(method: string, params: ProtocolRow): Promise<void>; serverTime?: () => number }): V4Facade {
  let clientHello: V4ClientHello | null = null;
  let negotiated = false;
  const serverTime = options.serverTime ?? (() => Date.now());

  const refuse = (reasonCode: string, message: string, code = -32000, data: ProtocolRow = {}): never => {
    throw new AppProtocolError(message, code, { reasonCode, ...data });
  };

  return {
    acceptClientHello(input) {
      const parsed = parseV4ClientHello(input);
      if (!parsed.ok) throw new AppProtocolError(parsed.issue, V4_JSONRPC_ERROR_CODES.invalidParams);
      if (clientHello) refuse(V4_REFUSAL_REASONS.alreadyInitialized, 'clientHello is a connection-level one-time registration');
      if (parsed.value.capabilities?.workflowRunDeltas === true && !hostSupportsWorkflowRunDeltas(HOST_CAPABILITIES)) {
        // One-directional declaration rule: the key is only sendable when the
        // host hello offered it. Violations must fail the handshake, because a
        // strict host parsing unknown/unearned keys drops the whole message.
        refuse(V4_REFUSAL_REASONS.wrongProtocolFamily, 'client capability workflowRunDeltas was not offered by the host', V4_JSONRPC_ERROR_CODES.invalidParams);
      }
      clientHello = parsed.value;
      const clientMode = clientHello.clientKind === 'web' ? 'web-remote-replayable' : 'desktop-continuous';
      const hello: V4HelloMessage = {
        kind: 'hello',
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: options.connectionId,
        clientMode,
        deliveryProfile: clientMode === 'desktop-continuous' ? 'continuous' : 'replayable',
        serverTime: serverTime(),
        capabilities: { ...HOST_CAPABILITIES },
        auth: {},
      };
      return hello;
    },

    initialize(input) {
      if (input.protocolVersion !== V4_WIRE_PROTOCOL_VERSION) {
        refuse(V4_REFUSAL_REASONS.unsupportedProtocolVersion, `V4 negotiation requires protocolVersion ${V4_WIRE_PROTOCOL_VERSION}`, V4_JSONRPC_ERROR_CODES.invalidParams);
      }
      if (negotiated) refuse(V4_REFUSAL_REASONS.alreadyInitialized, 'connection already initialized as V4');
      negotiated = true;
      const invariants = v4RouteTableInvariants();
      const native = options.nativeMethods();
      const routable = Object.entries(V4_TO_NATIVE_ROUTES)
        .filter((entry): entry is [string, string] => entry[1] !== undefined && Object.hasOwn(native, entry[1]))
        .map(([v4Name]) => v4Name)
        .sort();
      return {
        protocolName: V4_PROTOCOL_NAME,
        protocol: V4_PROTOCOL_NAME,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: options.connectionId,
        workspaceIdentity: options.port.workspaceIdentity,
        xuenessVersion: options.xuenessVersion,
        clientHelloAccepted: clientHello !== null,
        capabilities: v4HostCapabilities(),
        methods: ['initialize', 'shutdown', 'exit', ...invariants.all].sort(),
        routableMethods: routable,
        deferredMethods: invariants.all.filter((method) => !routable.includes(method)).sort(),
      };
    },

    async dispatch(method, params, legacyFamily) {
      if (!isV4Method(method)) {
        if (method.startsWith('v4/')) {
          // v4-shaped but unknown: answer with the real route table so a
          // contract client can enumerate, exactly like the native host.
          throw new AppProtocolError(`${method} is not a V4 route`, V4_JSONRPC_ERROR_CODES.methodNotFound, { method, known: v4RouteTableInvariants().all.sort() });
        }
        // A V4-negotiated connection must not accept mixed-family methods.
        refuse(V4_REFUSAL_REASONS.wrongProtocolFamily, `${method} is not a V4 route; this connection speaks ${V4_PROTOCOL_NAME}`);
      }
      if (legacyFamily) {
        refuse(V4_REFUSAL_REASONS.wrongProtocolFamily, 'connection already negotiated the legacy protocol family');
      }
      if (!negotiated) {
        refuse(V4_REFUSAL_REASONS.notInitialized, 'V4 methods require initialize with protocolVersion 3 first', V4_JSONRPC_ERROR_CODES.invalidParams);
      }
      const nativeName = V4_TO_NATIVE_ROUTES[method];
      const native = options.nativeMethods();
      if (nativeName === undefined || !Object.hasOwn(native, nativeName)) {
        // A known upstream V4 route without a native equivalent is a typed
        // refusal — renaming a nearby v2 method would fake compatibility.
        refuse(V4_REFUSAL_REASONS.unknownTopic, `${method} is a recognized V4 route but is not available on this host yet`, -32001, { method, routable: Object.keys(V4_TO_NATIVE_ROUTES).filter((name) => { const mapped = V4_TO_NATIVE_ROUTES[name]; return mapped !== undefined && Object.hasOwn(native, mapped); }).sort() });
      }
      return native[nativeName!]!(params);
    },

    async notifyWireFrames(params) {
      const frames = encodeV4TopicWireFrames(params.frame, {
        deliveryKind: params.deliveryKind ?? 'online',
        topic: params.topic,
        subscriptionId: params.subscriptionId,
        logicalFrameId: params.logicalFrameId,
        logicalFrameOrdinal: params.logicalFrameOrdinal,
        ...(params.maxPhysicalFrameBytes !== undefined ? { maxPhysicalFrameBytes: params.maxPhysicalFrameBytes } : {}),
        measurePhysicalFrameBytes: (wire) => utf8JsonByteLength({ jsonrpc: '2.0', method: params.method, params: wire }) + 1,
      });
      for (const frame of frames) await options.notify(params.method, frame as ProtocolRow);
      return frames;
    },

    state() { return { negotiated, clientHello }; },
  };
}
