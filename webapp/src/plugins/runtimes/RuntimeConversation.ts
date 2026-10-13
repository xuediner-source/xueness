import { useCallback, useEffect, useRef, useState } from 'react';
import { requestMutation } from '../../xuenessWorkbench';
import { startSessionPolling, type SessionPollingOptions } from '../sessions/SessionPolling';

export type RuntimeRow = Record<string, unknown> & { rowId: number; kind: string; turnId: string };
export type RuntimeConversationSnapshot = Record<string, unknown> & {
  protocolVersion: number;
  sessionId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  rows: { window: RuntimeRow[]; totalCount: number; firstRowId: number | null; order?: number[] };
  meta: { session: Record<string, unknown>; [key: string]: unknown };
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function row(value: unknown): RuntimeRow {
  if (!record(value) || !sequence(value.rowId) || typeof value.kind !== 'string'
    || typeof value.turnId !== 'string' || !value.turnId) throw new Error('Invalid runtime conversation row');
  return structuredClone(value) as RuntimeRow;
}
function parseSnapshot(value: unknown, sessionId: string, epoch: string, seq: number): RuntimeConversationSnapshot {
  if (!record(value) || value.protocolVersion !== 1 || value.sessionId !== sessionId
    || value.logEpoch !== epoch || value.seq !== seq || !sequence(value.revision)
    || !record(value.rows) || !Array.isArray(value.rows.window) || !sequence(value.rows.totalCount)
    || value.rows.totalCount < value.rows.window.length || !record(value.meta) || !record(value.meta.session)
    || value.meta.session.id !== sessionId || typeof value.meta.session.status !== 'string'
    || !Array.isArray(value.meta.session.pending) || !record(value.meta.session.approved)) {
    throw new Error('Invalid runtime conversation snapshot');
  }
  const rows = value.rows.window.map(row);
  if (new Set(rows.map(item => item.rowId)).size !== rows.length
    || value.rows.firstRowId !== (rows[0]?.rowId ?? null)) throw new Error('Invalid runtime row window');
  const order = value.meta.rowOrder;
  if (!Array.isArray(order) || order.length !== rows.length
    || order.some((id, index) => id !== rows[index].rowId)) throw new Error('Invalid runtime row order');
  return structuredClone({ ...value, rows: { ...value.rows, window: rows } }) as RuntimeConversationSnapshot;
}

/** The cursor moves only after the entire frame has been checked and applied. */
export function applyRuntimeConversationFrame(previous: RuntimeConversationSnapshot | undefined,
  response: unknown, sessionId: string): RuntimeConversationSnapshot {
  if (!record(response) || !record(response.ack) || !record(response.frame)) throw new Error('Invalid runtime subscription');
  const { ack, frame } = response;
  if (typeof ack.subscriptionId !== 'string' || !ack.subscriptionId || frame.subscriptionId !== ack.subscriptionId
    || typeof ack.logEpoch !== 'string' || !ack.logEpoch || frame.topic !== `conversation/${sessionId}`
    || !sequence(frame.fromSeq) || !sequence(frame.toSeq) || frame.toSeq < frame.fromSeq || !record(frame.payload)) {
    throw new Error('Invalid runtime frame');
  }
  const payload = frame.payload;
  if (ack.mode === 'snapshot' && payload.kind === 'snapshot') {
    if (frame.fromSeq !== 0) throw new Error('Invalid runtime snapshot cursor');
    const snapshot = parseSnapshot(payload.snapshot, sessionId, ack.logEpoch, frame.toSeq);
    if (previous?.logEpoch === snapshot.logEpoch && snapshot.seq < previous.seq) throw new Error('Stale runtime snapshot');
    return snapshot;
  }
  if (ack.mode !== 'resume' || payload.kind !== 'deltas' || !previous || previous.sessionId !== sessionId
    || ack.logEpoch !== previous.logEpoch || frame.fromSeq !== previous.seq || !Array.isArray(payload.deltas)
    || payload.deltas.length !== frame.toSeq - frame.fromSeq || payload.deltas.length > 100000) {
    throw new Error('Runtime conversation cursor mismatch');
  }
  if (!payload.deltas.length) return previous;
  const next = structuredClone(previous);
  const rows = new Map(next.rows.window.map(item => [item.rowId, item]));
  let order = next.rows.window.map(item => item.rowId);
  for (const delta of payload.deltas) {
    if (!record(delta)) throw new Error('Invalid runtime delta');
    if (delta.op === 'row.appended' || delta.op === 'row.upserted') {
      const incoming = row(delta.row);
      if (delta.op === 'row.appended' && rows.has(incoming.rowId)) throw new Error('Duplicate runtime row');
      if (!rows.has(incoming.rowId)) order.push(incoming.rowId);
      rows.set(incoming.rowId, incoming);
    } else if (delta.op === 'row.removed') {
      if (!sequence(delta.rowId) || !rows.has(delta.rowId)) throw new Error('Unknown runtime row');
      rows.delete(delta.rowId);
      order = order.filter(id => id !== delta.rowId);
    } else if (delta.op === 'state.updated') {
      if (!record(delta.patch)) throw new Error('Invalid runtime state patch');
      for (const [key, value] of Object.entries(delta.patch)) {
        if (['__proto__', 'constructor', 'prototype', 'protocolVersion', 'sessionId', 'logEpoch', 'seq'].includes(key)) {
          throw new Error('Invalid runtime state field');
        }
        if (!['control', 'config', 'usage', 'availability', 'inputRouting', 'meta', 'queue',
          'pendingInteractions', 'pendingCommands', 'backgroundWorks', 'subagents', 'goal', 'plan',
          'workspaceHookAdmission', 'revision'].includes(key)) throw new Error('Unsupported runtime state field');
        next[key] = structuredClone(value);
      }
    } else throw new Error('Unsupported runtime delta');
  }
  const serverOrder = next.meta.rowOrder;
  if (!Array.isArray(serverOrder) || serverOrder.length !== rows.size || new Set(serverOrder).size !== rows.size
    || serverOrder.some(id => !sequence(id) || !rows.has(id))) throw new Error('Invalid runtime row order');
  order = serverOrder as number[];
  next.rows.window = order.map(id => rows.get(id)!);
  next.rows.firstRowId = order[0] ?? null;
  if (!record(next.meta.window) || !sequence(next.meta.window.total) || next.meta.window.total < rows.size) {
    throw new Error('Invalid runtime window');
  }
  next.rows.totalCount = next.meta.window.total;
  next.seq = frame.toSeq;
  return parseSnapshot(next, sessionId, ack.logEpoch, frame.toSeq);
}

export type RuntimeConversationState = {
  sessionId: string;
  status: 'loading' | 'ready' | 'recovering' | 'unavailable';
  snapshot?: RuntimeConversationSnapshot;
  error?: string;
};
type SubscriptionOptions = Omit<SessionPollingOptions, 'refresh'> & {
  request?: (body: object, signal: AbortSignal) => Promise<unknown>;
  requestTimeoutMs?: number;
};

/** One request at a time; switches, plugin disable and unmount abort every read. */
export function startRuntimeConversation(sessionId: string, publish: (state: RuntimeConversationState) => void,
  options: SubscriptionOptions = {}): { refresh: () => Promise<void>; stop: () => void } {
  let stopped = false;
  let unavailable = false;
  let snapshot: RuntimeConversationSnapshot | undefined;
  let cursor: { logEpoch: string; seq: number } | undefined;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const request = options.request ?? ((body, signal) => requestMutation('POST', '/api/runtimes/v4', body, signal));
  const refresh = (): Promise<void> => {
    if (stopped || unavailable) return Promise.resolve();
    if (inFlight) return inFlight;
    const read = new AbortController();
    controller = read;
    const timeout = setTimeout(() => read.abort(new DOMException('Conversation update timed out', 'TimeoutError')),
      options.requestTimeoutMs ?? 35000);
    const operation = (async () => {
      try {
        const response = await request({ kind: 'subscribe', waitMs: cursor ? 25000 : 0,
          params: { topic: `conversation/${sessionId}`, ...(cursor ? { base: cursor } : {}) } }, read.signal);
        if (stopped || read.signal.aborted) return;
        try { snapshot = applyRuntimeConversationFrame(cursor ? snapshot : undefined, response, sessionId); }
        catch (error) { cursor = undefined; throw error; }
        cursor = { logEpoch: snapshot.logEpoch, seq: snapshot.seq };
        publish({ sessionId, status: 'ready', snapshot });
      } catch (reason) {
        if (stopped) return;
        const status = record(reason) ? reason.status : undefined;
        unavailable = status === 403 || status === 404 || status === 405 || status === 501;
        publish({ sessionId, status: unavailable ? 'unavailable' : 'recovering', ...(snapshot ? { snapshot } : {}),
          error: reason instanceof Error ? reason.message : String(reason) });
      } finally {
        clearTimeout(timeout);
        if (controller === read) controller = undefined;
      }
    })();
    inFlight = operation.finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const stopPolling = startSessionPolling({ ...options, refresh, visibleDelayMs: options.visibleDelayMs ?? 250 });
  publish({ sessionId, status: 'loading' });
  void refresh();
  return { refresh, stop: () => { stopped = true; stopPolling(); controller?.abort(); } };
}

export function useRuntimeConversation(sessionId: string | null, enabled: boolean) {
  const [state, setState] = useState<RuntimeConversationState | null>(null);
  const client = useRef<ReturnType<typeof startRuntimeConversation> | null>(null);
  useEffect(() => {
    setState(null);
    if (!enabled || !sessionId) return;
    const active = startRuntimeConversation(sessionId, setState);
    client.current = active;
    return () => { active.stop(); if (client.current === active) client.current = null; };
  }, [sessionId, enabled]);
  const refresh = useCallback(() => client.current?.refresh() ?? Promise.resolve(), []);
  return { state: enabled && state?.sessionId === sessionId ? state : null, refresh };
}
