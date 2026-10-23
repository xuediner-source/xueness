import { useCallback, useEffect, useRef, useState } from 'react';
import { readJsonResponse } from '../../xuenessApi';
import { ConversationProjectionStore, type ConversationCursor } from './conversationProjectionStore';
import type { ConversationWatchDelivery, ConversationWatchHub } from './conversationWatch';
import { startSessionPolling, type SessionPollingOptions } from './SessionPolling';

export type ConversationTransportOptions = Pick<SessionPollingOptions,
  'schedule' | 'isVisible' | 'subscribeVisibility' | 'isOnline' | 'visibleDelayMs' | 'hiddenDelayMs'> & {
  sessionId: string;
  enabled?: boolean;
  isEnabled?: () => boolean;
  accept: (snapshot: unknown) => void;
  connected?: (value: boolean, logEpoch: string | null) => void;
  request?: (path: string, signal: AbortSignal) => Promise<unknown>;
  /** Pane identity. It never changes the conversation topic or resume query. */
  subscriberId?: string | null;
  /** Also retry before the first snapshot. Confirmed subscriptions always retry. */
  retryOnError?: boolean;
  /** Total deadline for response headers and the complete JSON body. */
  readTimeoutMs?: number;
  /** Window push hub (or its loader). Updates arrive as soon as the topic
   * changes; the first snapshot and manual refreshes stay direct GETs.
   * Without a hub, or when the host lacks the route, the subscription polls. */
  watch?: ConversationWatchHub | null | (() => Promise<ConversationWatchHub | null>);
};

export type ConversationTransport = {
  stop: () => void;
  refresh: () => Promise<void>;
  isConnected: () => boolean;
  subscriberId: string;
};

const TRANSPORT_FAILURES = 8;
const TRANSPORT_READ_TIMEOUT_MS = 15000;
let watchLoading: Promise<ConversationWatchHub | null> | undefined;

/** The window hub loads with the first conversation, outside the startup graph. */
export function loadConversationWatch(): Promise<ConversationWatchHub | null> {
  return watchLoading ??= import('./conversationWatch').then(module => module.sharedConversationWatch(),
    () => { watchLoading = undefined; return null; });
}

async function requestProjection(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  // The generic JSON reader preserves server error text, which can hide the
  // HTTP status needed to distinguish a retired topic from a transient outage.
  if (response.status === 403 || response.status === 404) throw new Error(`HTTP ${response.status}`);
  return readJsonResponse(response);
}

export function transportSubscriberId(subscriberId: string | null | undefined, sessionId: string): string {
  if (subscriberId === `sessions.pane:primary:${sessionId}` || subscriberId === `sessions.pane:secondary:${sessionId}`) return subscriberId;
  if (subscriberId && subscriberId.length <= 256 && /^sessions\.pane:v2:[a-f0-9]{32}:/u.test(subscriberId) && subscriberId.slice(50) === sessionId) return subscriberId;
  return `session:${sessionId}`;
}

function releasesTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /^HTTP 40[34]\b/u.test(message);
}

export function conversationTransportPath(sessionId: string, base: ConversationCursor | null): string {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/conversation-transport`;
  return base ? `${path}?${new URLSearchParams({ logEpoch: base.logEpoch, seq: String(base.seq) })}` : path;
}

/** One HTTP subscription owns snapshot/resume for the selected conversation.
 * With a window hub, changes are pushed over its shared long poll; otherwise
 * the subscription polls. A transient disconnect retains the confirmed
 * projection and its cursor until recovery or bounded failure releases
 * ownership to the legacy source. */
export function startConversationTransport({ sessionId, enabled = true, isEnabled = () => true, accept,
  connected = () => undefined, request = requestProjection,
  subscriberId = null, retryOnError = false, readTimeoutMs = TRANSPORT_READ_TIMEOUT_MS,
  visibleDelayMs = 250, hiddenDelayMs = 5000, watch = null, ...polling }: ConversationTransportOptions): ConversationTransport {
  const identity = transportSubscriberId(subscriberId, sessionId);
  const deadlineSchedule = polling.schedule ?? {
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const timeoutMs = Number.isFinite(readTimeoutMs) && readTimeoutMs > 0
    ? readTimeoutMs : TRANSPORT_READ_TIMEOUT_MS;
  const store = new ConversationProjectionStore(sessionId);
  let stopped = !enabled;
  let online = false;
  let failures = 0;
  let abort: AbortController | null = null;
  let flight: Promise<void> | null = null;
  let refreshAgain = false;
  let stopPolling: () => void = () => undefined;
  let stopWatching: () => void = () => undefined;
  let resyncs = 0;
  const active = () => !stopped && isEnabled();
  const setConnected = (value: boolean, logEpoch: string | null = null) => {
    online = value;
    connected(value, logEpoch);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    refreshAgain = false;
    stopPolling();
    stopWatching();
    abort?.abort();
    abort = null;
    store.invalidate();
    setConnected(false);
  };
  const readPayload = async (controller: AbortController): Promise<unknown> => {
    let timer: unknown;
    let onAbort: () => void = () => undefined;
    try {
      // Race the entire request, not just fetch headers. Abort alone cannot
      // settle a custom/non-cooperative fetch or a stalled response body.
      return await new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(new Error('Conversation read aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = deadlineSchedule.setTimeout(() => {
          reject(new Error('Conversation read timed out'));
          controller.abort();
        }, timeoutMs);
        Promise.resolve(request(conversationTransportPath(sessionId, store.getBase()), controller.signal))
          .then(resolve, reject);
      });
    } finally {
      if (timer !== undefined) deadlineSchedule.clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (abort === controller) abort = null;
    }
  };
  const read = async () => {
    // One immediate force-snapshot recovery avoids a malformed resume loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!active()) { stop(); return; }
      const controller = new AbortController();
      abort = controller;
      const payload = await readPayload(controller);
      if (!active() || controller.signal.aborted) { controller.abort(); stop(); return; }
      const result = store.apply(payload, projection => {
        setConnected(true, projection.logEpoch);
        accept(projection.snapshot);
      });
      if (!active()) { stop(); return; }
      if (result.kind !== 'resync') {
        setConnected(true, result.projection.logEpoch);
        return;
      }
      // Keep the last confirmed owner through recovery, so a gap cannot open
      // a competing legacy stream between this read and the fresh snapshot.
      const previous = store.getProjection();
      setConnected(previous !== null, previous?.logEpoch ?? null);
    }
    throw new Error('Conversation resync failed');
  };
  /** A failed read keeps the confirmed owner while it may still resume. */
  const failed = (error: unknown) => {
    failures += 1;
    if ((retryOnError || store.getBase()) && active() && !releasesTransport(error) && failures < TRANSPORT_FAILURES) {
      // A lost response never advanced the applied cursor. Keep its owner
      // to prevent a competing legacy stream while the next read resumes.
      // Protocol faults already invalidated the base inside store.apply.
      const previous = store.getProjection();
      setConnected(previous !== null, previous?.logEpoch ?? null);
    } else stop();
  };
  const refresh = (): Promise<void> => {
    if (!active()) { if (!stopped) stop(); return Promise.resolve(); }
    if (flight) { refreshAgain = true; return flight; }
    const operation = (async () => {
      do {
        refreshAgain = false;
        try {
          await read();
          failures = 0;
          resyncs = 0;
        } catch (error) {
          if (stopped) return;
          failed(error);
          return;
        }
      } while (refreshAgain && active());
    })();
    flight = operation.finally(() => { flight = null; });
    return flight;
  };
  const poll = () => {
    stopPolling = startSessionPolling({ ...polling, refresh, visibleDelayMs, hiddenDelayMs });
  };
  /** Pushed envelopes take the same validated, atomic path as read(). */
  const deliver = (delivery: ConversationWatchDelivery) => {
    if (!active()) { stop(); return; }
    if (delivery.kind === 'failure') { failed(delivery.error); return; }
    if (delivery.kind === 'error') { failed(new Error(`HTTP ${delivery.status}`)); return; }
    const result = store.apply(delivery.envelope, projection => {
      setConnected(true, projection.logEpoch);
      accept(projection.snapshot);
    });
    if (!active()) { stop(); return; }
    if (result.kind !== 'resync') {
      failures = 0;
      resyncs = 0;
      setConnected(true, result.projection.logEpoch);
      return;
    }
    // The next watch request carries no base and receives a snapshot; a
    // second consecutive fault counts as one failed read, as in read().
    if (++resyncs < 2) {
      const previous = store.getProjection();
      setConnected(previous !== null, previous?.logEpoch ?? null);
      return;
    }
    resyncs = 0;
    failed(new Error('Conversation resync failed'));
  };
  const subscribe = (hub: ConversationWatchHub | null) => {
    if (!active()) return;
    const unsubscribe = hub?.subscribe({ sessionId, base: () => store.getBase(), deliver,
      fallback: () => {
        stopWatching = () => undefined;
        if (active()) { poll(); void refresh(); }
      } }) ?? null;
    if (unsubscribe) stopWatching = unsubscribe;
    else poll();
  };
  setConnected(false);
  if (active()) {
    if (watch) {
      // The first snapshot is a direct read, then the window watch pushes.
      const hub = typeof watch === 'function' ? watch().catch(() => null) : Promise.resolve(watch);
      void Promise.all([refresh(), hub]).then(([, loaded]) => subscribe(loaded));
    } else {
      poll();
      void refresh();
    }
  }
  return { stop, refresh, isConnected: () => online && active(), subscriberId: identity };
}

/** Ownership refs change before publishing, so late legacy reads can be
 * ignored synchronously while React renders the new connection state. */
export function useConversationTransport(sessionId: string | null, enabled: boolean, accept: (snapshot: unknown) => void,
  options?: { subscriberId?: string | null; retryOnError?: boolean; request?: ConversationTransportOptions['request'];
    /** Connection generation. It must never become part of a persisted draft address. */
    runtimeKey?: string; isEnabled?: () => boolean;
    /** Defaults to the window hub for same-origin reads; custom requests poll. */
    watch?: ConversationTransportOptions['watch'] }) {
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const subscriberId = options?.subscriberId ?? null;
  const retryOnError = options?.retryOnError === true;
  const request = options?.request;
  const watch = options?.watch !== undefined ? options.watch : request ? null : loadConversationWatch;
  const runtimeKey = options?.runtimeKey;
  const isEnabledRef = useRef(options?.isEnabled);
  isEnabledRef.current = options?.isEnabled;
  const bindingKey = JSON.stringify([sessionId, subscriberId, runtimeKey ?? null]);
  const bindingRef = useRef(bindingKey);
  bindingRef.current = bindingKey;
  const transportRef = useRef<ConversationTransport | null>(null);
  const ownerRef = useRef<string | null>(null);
  const authoritativeRef = useRef(false);
  const epochRef = useRef<string | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  if (!enabled || ownerRef.current !== bindingKey) { authoritativeRef.current = false; epochRef.current = null; }
  useEffect(() => {
    setConnection(null);
    if (!sessionId || !enabled) return;
    const id = sessionId;
    const owner = bindingKey;
    let current = true;
    ownerRef.current = owner;
    const isCurrent = () => current && enabledRef.current && sessionRef.current === id && bindingRef.current === owner
      && isEnabledRef.current?.() !== false;
    const transport = startConversationTransport({ sessionId: id, subscriberId, retryOnError, request, watch,
      isEnabled: isCurrent,
      accept: snapshot => { if (isCurrent()) acceptRef.current(snapshot); },
      connected: (value, logEpoch) => {
        if (!isCurrent()) return;
        authoritativeRef.current = value;
        epochRef.current = logEpoch;
        setConnection(value ? owner : null);
      },
    });
    transportRef.current = transport;
    return () => {
      current = false;
      transport.stop();
      if (transportRef.current === transport) transportRef.current = null;
      ownerRef.current = null;
    };
  }, [sessionId, enabled, subscriberId, retryOnError, request, runtimeKey, watch]);
  const refresh = useCallback(() => enabled && sessionId && ownerRef.current === bindingKey
    ? transportRef.current?.refresh() ?? Promise.resolve() : Promise.resolve(), [sessionId, enabled, bindingKey]);
  return { connected: enabled && connection === bindingKey && sessionId !== null, authoritativeRef, epochRef, refresh };
}
