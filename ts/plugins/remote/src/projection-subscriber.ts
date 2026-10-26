/** Client-side v2 projection driver: READY gating, cursor continuity, gap repair and resync. */
import { isDict } from '@xueness/contracts';

export type ProjectionKind = 'conversation' | 'controller' | 'workflow';
export type ProjectionRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface ProjectionFrame { subscriptionId: string; topic: string; generation: number; delivery: string; fromSeq: number; toSeq: number; envelope: unknown }
export interface ProjectionCursor { logEpoch?: string; seq?: number; afterSeq?: number }

export type SubscriptionState = {
  kind: ProjectionKind;
  sessionId: string | null;
  runId?: string;
  subscriptionId: string;
  topic: string;
  generation: number;
  ready: boolean;
  epoch?: string;
  seq: number;
  gaps: number;
  resyncs: number;
  status?: string;
};

interface Options {
  request: ProjectionRequest;
  onFrame?: (frame: ProjectionFrame) => void;
  onClose?: (subscriptionId: string, reason: string) => void;
}

const KINDS = new Set(['conversation', 'controller', 'workflow']);
const EPOCH = /^[0-9a-f]{32}$/;

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Tracks one live subscription per topic and keeps the cursor authoritative. */
export class ProjectionSubscriber {
  private readonly options: Options;
  private readonly live = new Map<string, SubscriptionState>();
  private request: ProjectionRequest;
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.request = options.request;
  }

  /** A new transport generation takes over; later frames continue from the saved cursor. */
  reattach(request: ProjectionRequest): void {
    this.request = request;
    for (const state of this.live.values()) state.ready = false;
  }

  /** `conversation|workflow|controller/subscribe` → READY reply with the reserved topic. */
  async subscribe(kind: ProjectionKind, sessionId: string | null, cursor: ProjectionCursor = {}, runId?: string): Promise<SubscriptionState> {
    if (!KINDS.has(kind)) throw new Error('invalid projection kind');
    if (this.closed) throw new Error('subscriber closed');
    if (this.live.size >= 16) throw new Error('subscription capacity reached');
    const params: Record<string, unknown> = {};
    if (sessionId != null) params.sessionId = sessionId;
    if (kind === 'workflow') {
      if (typeof runId !== 'string' || !runId) throw new Error('workflow subscriptions require runId');
      params.runId = runId;
      if (cursor.afterSeq !== undefined) params.afterSeq = intOr(cursor.afterSeq, 0);
    }
    if (kind === 'conversation' && cursor.logEpoch !== undefined && cursor.seq !== undefined) {
      if (!EPOCH.test(cursor.logEpoch)) throw new Error('invalid logEpoch cursor');
      params.logEpoch = cursor.logEpoch;
      params.seq = intOr(cursor.seq, 0);
    }
    const ready = await this.ready(kind, params, 'subscribe');
    return ready;
  }

  /** Explicit resync from a still-valid cursor; bumps the generation and refills gaps. */
  async resync(subscriptionId: string, cursor: ProjectionCursor = {}): Promise<SubscriptionState> {
    const state = this.live.get(subscriptionId);
    if (!state) throw new Error('subscription not found');
    const params: Record<string, unknown> = { subscriptionId };
    if (state.kind === 'conversation' && cursor.logEpoch !== undefined && cursor.seq !== undefined) {
      if (!EPOCH.test(cursor.logEpoch)) throw new Error('invalid logEpoch cursor');
      params.logEpoch = cursor.logEpoch;
      params.seq = intOr(cursor.seq, 0);
    }
    if (state.kind === 'workflow' && cursor.afterSeq !== undefined) params.afterSeq = intOr(cursor.afterSeq, 0);
    return await this.ready(state.kind, params, 'resync');
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const state = this.live.get(subscriptionId);
    if (!state) return;
    this.live.delete(subscriptionId);
    try { await this.request(`${state.kind}/unsubscribe`, { subscriptionId }); }
    catch { /* the local record is dropped regardless */ }
  }

  /** Server notifications land here: frames advance cursors; closes trigger recovery. */
  ingest(method: string, params: unknown): void {
    if (this.closed || !isDict(params)) return;
    if (method === 'subscription/closed') {
      const state = this.live.get(String(params.subscriptionId));
      if (!state) return;
      state.ready = false;
      const reason = typeof params.reason === 'string' ? params.reason : 'projection unavailable';
      if (params.resyncRequired === true) {
        void this.recover(state).catch(() => {
          this.live.delete(state.subscriptionId);
          this.options.onClose?.(state.subscriptionId, reason);
        });
      } else {
        this.live.delete(state.subscriptionId);
        this.options.onClose?.(state.subscriptionId, reason);
      }
      return;
    }
    const kind = method === 'controller/frame' || method === 'conversation/frame' || method === 'workflow/frame' ? method.slice(0, -'/frame'.length) as ProjectionKind : null;
    if (!kind) return;
    const state = this.live.get(String(params.subscriptionId));
    if (!state || state.kind !== kind) return;
    const generation = intOr(params.generation, -1);
    if (generation !== state.generation) return; // fenced replay from a superseded generation
    const fromSeq = intOr(params.fromSeq, state.seq), toSeq = intOr(params.toSeq, state.seq);
    const envelope = isDict(params.envelope) ? params.envelope : {};
    if (kind === 'conversation') {
      const epoch = typeof envelope.logEpoch === 'string' && EPOCH.test(envelope.logEpoch) ? envelope.logEpoch : state.epoch;
      // The epoch is authoritative for what the seq means, so it is settled
      // before any seq comparison: a frame from a new log restarts at its own
      // zero, and the previous log's committed cursor cannot call it stale.
      if (epoch !== undefined && state.epoch !== undefined && epoch !== state.epoch) {
        state.epoch = epoch;
        state.seq = 0;
        if (fromSeq !== 0) {
          state.gaps += 1;
          state.ready = false;
          void this.recover(state).catch(() => { this.live.delete(state.subscriptionId); this.options.onClose?.(state.subscriptionId, 'resync failed'); });
          return;
        }
      } else if (epoch !== undefined) state.epoch = epoch;
    }
    if (fromSeq > state.seq) {
      // A hole must never be papered over by a later frame; resync from the last valid cursor.
      state.gaps += 1;
      state.ready = false;
      void this.recover(state).catch(() => { this.live.delete(state.subscriptionId); this.options.onClose?.(state.subscriptionId, 'resync failed'); });
      return;
    }
    if (toSeq < state.seq) return; // stale replay at or before the committed cursor
    state.seq = Math.max(state.seq, toSeq);
    if (kind === 'workflow' && typeof envelope.status === 'string') state.status = envelope.status;
    this.options.onFrame?.({ subscriptionId: state.subscriptionId, topic: state.topic, generation: state.generation, delivery: typeof params.delivery === 'string' ? params.delivery : 'online', fromSeq, toSeq: state.seq, envelope: params.envelope });
  }

  states(): SubscriptionState[] { return [...this.live.values()].map((state) => ({ ...state })); }
  cursor(subscriptionId: string): ProjectionCursor | null {
    const state = this.live.get(subscriptionId);
    if (!state) return null;
    if (state.kind === 'conversation') return state.epoch !== undefined ? { logEpoch: state.epoch, seq: state.seq } : { seq: state.seq };
    if (state.kind === 'workflow') return { afterSeq: state.seq };
    return {};
  }
  close(): void {
    this.closed = true;
    for (const state of this.live.values()) void this.unsubscribe(state.subscriptionId);
    this.live.clear();
  }

  private async ready(kind: ProjectionKind, params: Record<string, unknown>, verb: string): Promise<SubscriptionState> {
    const reply = await this.request(`${kind}/${verb}`, params);
    if (!isDict(reply) || reply.accepted !== true || typeof reply.subscriptionId !== 'string' || typeof reply.topic !== 'string' || !Number.isSafeInteger(reply.generation) || Number(reply.generation) < 1) {
      throw new Error('subscription was not readied');
    }
    const prior = [...this.live.values()].find((state) => state.kind === kind && state.topic === reply.topic);
    if (prior && prior.subscriptionId !== reply.subscriptionId) this.live.delete(prior.subscriptionId);
    const replyGeneration = Number(reply.generation);
    const state: SubscriptionState = prior && prior.subscriptionId === reply.subscriptionId ? prior : {
      kind, sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
      runId: typeof params.runId === 'string' ? params.runId : undefined,
      subscriptionId: reply.subscriptionId, topic: reply.topic, generation: replyGeneration,
      ready: false, seq: kind === 'workflow' ? intOr(params.afterSeq, 0) : intOr(params.seq, 0), gaps: 0, resyncs: 0,
    };
    state.generation = replyGeneration;
    state.ready = true;
    if (kind === 'conversation' && typeof params.logEpoch === 'string') state.epoch = params.logEpoch;
    this.live.set(state.subscriptionId, state);
    return { ...state };
  }

  /** Recovery always restarts from the last cursor the client actually committed. */
  private async recover(state: SubscriptionState): Promise<void> {
    const cursor = this.cursor(state.subscriptionId);
    if (cursor == null) throw new Error('subscription lost');
    state.resyncs += 1;
    const params: Record<string, unknown> = { subscriptionId: state.subscriptionId, ...(state.sessionId != null ? { sessionId: state.sessionId } : {}), ...(state.runId !== undefined ? { runId: state.runId } : {}) };
    if (state.kind === 'conversation' && cursor.logEpoch !== undefined) { params.logEpoch = cursor.logEpoch; params.seq = cursor.seq ?? 0; }
    if (state.kind === 'workflow') params.afterSeq = cursor.afterSeq ?? 0;
    await this.ready(state.kind, params, 'resync');
  }
}

/** Structural driver contract the manager stores on a live connection. */
export interface ProjectionDriver {
  ingest(method: string, params: unknown): void;
  states(): SubscriptionState[];
}
