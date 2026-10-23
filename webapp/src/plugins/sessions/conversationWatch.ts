import type { ConversationCursor } from './conversationProjectionStore';
import { browserNetworkAvailable, browserVisibility, subscribeBrowserVisibility, type SessionPollSchedule } from './SessionPolling';

export const CONVERSATION_WATCH_SCHEMA = 'xueness.conversation-watch.v1' as const;
export const CONVERSATION_WATCH_PATH = '/api/sessions/conversation-transport/watch';
// Mirrors conversation_transport.WATCH_*: topics per request, the longest
// server wait and the push spacing the server holds for this window.
const MAX_TOPICS = 16;
const WAIT_MS = 20000;
const MAX_WAIT_MS = 25000;
const VISIBLE_PACE_MS = 33;
const HIDDEN_PACE_MS = 1000;
const READ_MARGIN_MS = 10000;
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
const TOPIC_RETRY_MS = 500;
const BUSY_LIMIT = 3;
const HEX32 = /^[0-9a-f]{32}$/u;
const CURSOR = /^[0-9a-f]{16}\.(?:0|[1-9][0-9]{0,15})$/u;

export type ConversationWatchDelivery =
  | { kind: 'envelope'; envelope: unknown }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'failure'; error: Error };

export type ConversationWatchSubscriber = {
  sessionId: string;
  /** The applied resume base, read whenever a request is built. */
  base: () => ConversationCursor | null;
  /** Envelopes are the unchanged conversation-transport.v1 responses. */
  deliver: (delivery: ConversationWatchDelivery) => void;
  /** This window cannot use the watch route (older host, refused): poll instead. */
  fallback: () => void;
};

export type ConversationWatchHub = {
  /** Returns the unsubscribe function, or null when the subscriber must poll. */
  subscribe: (subscriber: ConversationWatchSubscriber) => (() => void) | null;
  isSupported: () => boolean;
  /** Watch requests sent so far (diagnostics and tests). */
  requests: () => number;
};

export type ConversationWatchResponse = { status: number; body: unknown };

export type ConversationWatchOptions = {
  request?: (path: string, signal: AbortSignal) => Promise<ConversationWatchResponse>;
  schedule?: SessionPollSchedule;
  isVisible?: () => boolean;
  subscribeVisibility?: (listener: () => void) => () => void;
  isOnline?: () => boolean;
  now?: () => number;
  clientId?: string;
  waitMs?: number;
  /** Deadline beyond the server wait for headers and the complete body. */
  readMarginMs?: number;
};

type Entry = { subscriber: ConversationWatchSubscriber; retryAt: number; errors: number };
type Flight = { controller: AbortController; version: number; pace: number; restarted: boolean };
type WatchBody = {
  cursor: string | null; superseded: boolean;
  updates: { index: number; envelope: unknown }[];
  errors: { index: number; status: number; error: string }[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function watchBody(value: unknown): WatchBody | null {
  const body = record(value);
  if (!body || body.schema !== CONVERSATION_WATCH_SCHEMA || typeof body.superseded !== 'boolean'
    || !Array.isArray(body.updates) || !Array.isArray(body.errors)
    || body.cursor !== null && (typeof body.cursor !== 'string' || !CURSOR.test(body.cursor))) return null;
  const updates: WatchBody['updates'] = [];
  for (const item of body.updates) {
    const update = record(item);
    if (!update || !index(update.index) || !record(update.envelope)) return null;
    updates.push({ index: update.index, envelope: update.envelope });
  }
  const errors: WatchBody['errors'] = [];
  for (const item of body.errors) {
    const error = record(item);
    if (!error || !index(error.index) || !index(error.status)) return null;
    errors.push({ index: error.index, status: error.status, error: typeof error.error === 'string' ? error.error : '' });
  }
  return { cursor: body.cursor as string | null, superseded: body.superseded, updates, errors };
}

async function requestWatch(path: string, signal: AbortSignal): Promise<ConversationWatchResponse> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  let body: unknown = null;
  try { body = await response.json(); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; }
  return { status: response.status, body };
}

function newClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return 'w' + random.replace(/-/gu, '');
  return 'w' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** Only local journal ids fit the watch topic grammar; anything else polls. */
export function conversationWatchable(sessionId: string): boolean {
  return HEX32.test(sessionId);
}

export function conversationWatchTopic(sessionId: string, base: ConversationCursor | null): string {
  return base && HEX32.test(base.logEpoch) && Number.isSafeInteger(base.seq) && base.seq >= 0
    ? `${sessionId}.${base.logEpoch}.${base.seq}` : sessionId;
}

/** One long poll per window carries every local conversation topic.
 *
 * The server answers as soon as a topic advances past its base, with the
 * unchanged per-topic envelopes; the next request starts at once with the new
 * bases. Subscription and visibility changes abort and restart the request.
 * A lost response never advanced any base, so the restart resumes it. */
export function createConversationWatch(options: ConversationWatchOptions = {}): ConversationWatchHub {
  const request = options.request ?? requestWatch;
  const schedule = options.schedule ?? {
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const isVisible = options.isVisible ?? browserVisibility;
  const subscribeVisibility = options.subscribeVisibility ?? subscribeBrowserVisibility;
  const isOnline = options.isOnline ?? browserNetworkAvailable;
  const now = options.now ?? (() => Date.now());
  const client = options.clientId ?? newClientId();
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(options.waitMs ?? WAIT_MS)));
  const readMarginMs = Math.max(1, options.readMarginMs ?? READ_MARGIN_MS);
  const entries = new Set<Entry>();
  let supported = true;
  let cursor: string | null = null;
  let running = false;
  let flight: Flight | null = null;
  let version = 0;
  let timer: unknown;
  let failures = 0;
  let busy = 0;
  let sent = 0;
  let restartQueued = false;
  let releaseVisibility: (() => void) | null = null;
  const pace = () => isVisible() ? VISIBLE_PACE_MS : HIDDEN_PACE_MS;
  const clearTimer = () => {
    if (timer === undefined) return;
    schedule.clearTimeout(timer);
    timer = undefined;
  };
  const start = () => { if (!running) void loop(); };
  const later = (delay: number) => {
    clearTimer();
    timer = schedule.setTimeout(() => { timer = undefined; start(); }, Math.max(0, delay));
  };
  const abortFlight = () => {
    if (!flight) return;
    flight.restarted = true;
    flight.controller.abort();
  };
  const restart = () => {
    if (restartQueued) return;
    restartQueued = true;
    queueMicrotask(() => {
      restartQueued = false;
      if (flight) { if (flight.version !== version || flight.pace !== pace()) abortFlight(); }
      else if (!running && failures === 0 && busy === 0) { clearTimer(); start(); }
    });
  };
  const detach = () => {
    releaseVisibility?.();
    releaseVisibility = null;
    clearTimer();
    abortFlight();
  };
  const onVisibility = () => {
    if (!entries.size) return;
    if (!isOnline()) { abortFlight(); clearTimer(); return; }
    if (flight) { if (flight.pace !== pace()) abortFlight(); return; }
    if (!running) { clearTimer(); start(); }
  };
  const fail = (error: Error, delay: number) => {
    for (const entry of [...entries]) if (entries.has(entry)) entry.subscriber.deliver({ kind: 'failure', error });
    if (entries.size) later(delay);
  };
  const unsupported = () => {
    supported = false;
    const waiting = [...entries];
    entries.clear();
    detach();
    for (const entry of waiting) entry.subscriber.fallback();
  };
  const read = (path: string, current: Flight, deadline: number) => {
    let deadlineTimer: unknown;
    let onAbort: () => void = () => undefined;
    // Race the whole read: abort alone cannot settle a stalled body.
    return new Promise<ConversationWatchResponse>((resolve, reject) => {
      onAbort = () => reject(new Error('Conversation watch aborted'));
      current.controller.signal.addEventListener('abort', onAbort, { once: true });
      deadlineTimer = schedule.setTimeout(() => {
        reject(new Error('Conversation watch timed out'));
        current.controller.abort();
      }, deadline);
      Promise.resolve(request(path, current.controller.signal)).then(resolve, reject);
    }).finally(() => {
      schedule.clearTimeout(deadlineTimer);
      current.controller.signal.removeEventListener('abort', onAbort);
    });
  };
  const loop = async () => {
    running = true;
    try {
      while (supported && entries.size && isOnline()) {
        const at = now();
        const topics: string[] = [];
        const targets: Entry[][] = [];
        const slots = new Map<string, number>();
        let retryAt = Infinity;
        for (const entry of [...entries]) {
          if (entry.retryAt > at) { retryAt = Math.min(retryAt, entry.retryAt); continue; }
          const topic = conversationWatchTopic(entry.subscriber.sessionId, entry.subscriber.base());
          let slot = slots.get(topic);
          if (slot === undefined) {
            if (topics.length >= MAX_TOPICS) { entries.delete(entry); entry.subscriber.fallback(); continue; }
            slot = topics.length;
            slots.set(topic, slot);
            topics.push(topic);
            targets.push([]);
          }
          targets[slot].push(entry);
        }
        if (!topics.length) {
          if (retryAt < Infinity) later(retryAt - at);
          return;
        }
        // A cooling topic rejoins when the server returns at its retry time.
        const wait = Math.max(0, Math.min(waitMs, Math.ceil(retryAt - at)));
        const current: Flight = { controller: new AbortController(), version, pace: pace(), restarted: false };
        const query = new URLSearchParams({ client, wait: String(wait), pace: String(current.pace) });
        if (cursor) query.set('since', cursor);
        for (const topic of topics) query.append('topic', topic);
        flight = current;
        sent += 1;
        let response: ConversationWatchResponse;
        try {
          response = await read(`${CONVERSATION_WATCH_PATH}?${query}`, current, wait + readMarginMs);
        } catch (error) {
          if (current.restarted) continue;
          failures += 1;
          fail(error instanceof Error ? error : new Error(String(error)),
            RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1]);
          return;
        } finally {
          if (flight === current) flight = null;
        }
        // A reply that raced a restart is dropped: no base moved, so the
        // next request receives the same frames again.
        if (current.restarted) continue;
        const body = response.status === 200 ? watchBody(response.body) : null;
        if (body) {
          failures = 0;
          busy = 0;
          cursor = body.cursor;
          if (body.superseded) continue;
          for (const update of body.updates) {
            let first = true;
            for (const entry of targets[update.index] ?? []) {
              if (!entries.has(entry)) continue;
              entry.errors = 0;
              entry.subscriber.deliver({ kind: 'envelope', envelope: first ? update.envelope : structuredClone(update.envelope) });
              first = false;
            }
          }
          for (const error of body.errors) {
            for (const entry of targets[error.index] ?? []) {
              if (!entries.has(entry)) continue;
              entry.errors += 1;
              entry.retryAt = now() + TOPIC_RETRY_MS;
              entry.subscriber.deliver({ kind: 'error', status: error.status, message: error.error });
            }
          }
          continue;
        }
        if (response.status === 403) {
          for (const entry of [...entries]) {
            if (entries.has(entry)) entry.subscriber.deliver({ kind: 'error', status: 403, message: 'sessions disabled' });
          }
          if (entries.size) later(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
          return;
        }
        if (response.status === 503 && ++busy < BUSY_LIMIT) {
          later(RETRY_DELAYS_MS[Math.min(busy, RETRY_DELAYS_MS.length) - 1]);
          return;
        }
        if ([400, 404, 405, 501, 503].includes(response.status)) { unsupported(); return; }
        failures += 1;
        fail(new Error(`HTTP ${response.status}`), RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1]);
        return;
      }
    } finally {
      running = false;
    }
  };
  return {
    subscribe(subscriber) {
      if (!supported || !conversationWatchable(subscriber.sessionId)) return null;
      const entry: Entry = { subscriber, retryAt: 0, errors: 0 };
      entries.add(entry);
      version += 1;
      releaseVisibility ??= subscribeVisibility(onVisibility);
      restart();
      return () => {
        if (!entries.delete(entry)) return;
        version += 1;
        if (entries.size) restart();
        else detach();
      };
    },
    isSupported: () => supported,
    requests: () => sent,
  };
}

let shared: ConversationWatchHub | null = null;

/** The window's hub; null where no same-origin fetch exists (SSR, tests). */
export function sharedConversationWatch(): ConversationWatchHub | null {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return null;
  shared ??= createConversationWatch();
  return shared;
}
