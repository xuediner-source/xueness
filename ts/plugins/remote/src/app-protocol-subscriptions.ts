/** Projection subscriptions with response-before-frame ordering and explicit resync. */
import { createHash, randomBytes } from 'node:crypto';
import { AppProtocolError, protocolKeys, protocolScope, protocolToken, type AppProtocolPort, type ProtocolMethods, type ProtocolRow } from './app-protocol-types.ts';

export class AppProtocolDeferredReply {
  result: ProtocolRow;
  afterResponse: () => Promise<void>;
  constructor(result: ProtocolRow, afterResponse: () => Promise<void>) { this.result = result; this.afterResponse = afterResponse; }
}
interface Subscription {
  id: string; kind: 'conversation' | 'controller' | 'workflow'; sessionId: string | null;
  runId?: string; generation: number; ready: boolean; epoch?: string; seq: number;
  hash?: string; status?: string;
  pendingDelivery?: string;
}
export interface AppSubscriptionOptions {
  port: AppProtocolPort;
  version(): number;
  notify(method: string, params: ProtocolRow): Promise<void>;
  wrap(method: string, sessionId: string | null, result: ProtocolRow): ProtocolRow;
}
const token = () => randomBytes(16).toString('hex');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const base = (p: ProtocolRow): { epoch?: string; seq: number } => {
  if (p.logEpoch === undefined && p.seq === undefined) return { seq: 0 };
  if (typeof p.logEpoch !== 'string' || !/^[0-9a-f]{32}$/.test(p.logEpoch) || !Number.isSafeInteger(p.seq) || p.seq < 0) throw new AppProtocolError('invalid projection base', -32602);
  return { epoch: p.logEpoch, seq: p.seq };
};

export class AppProtocolSubscriptions {
  readonly methods: ProtocolMethods;
  readonly subscriptions = new Map<string, Subscription>();
  private readonly options: AppSubscriptionOptions;
  private readonly timer: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly emissions = new Map<string, Promise<void>>();
  private paused = false;
  private closed = false;
  constructor(options: AppSubscriptionOptions) {
    this.options = options;
    this.methods = { 'connection/flow': async (p) => {
      protocolKeys(p, ['workspaceIdentity', 'paused']); await this.scope(p, true);
      if (typeof p.paused !== 'boolean') throw new AppProtocolError('paused must be a boolean', -32602);
      this.paused = p.paused; return { paused: this.paused };
    } };
    for (const kind of ['conversation', 'controller', 'workflow'] as const) {
      this.methods[`${kind}/subscribe`] = (p) => this.subscribe(kind, p);
      this.methods[`${kind}/resync`] = (p) => this.resync(kind, p);
      this.methods[`${kind}/unsubscribe`] = (p) => this.unsubscribe(kind, p);
    }
    this.timer = setInterval(() => { void this.poll().catch(() => this.close()); }, 200); this.timer.unref();
  }
  private async scope(p: ProtocolRow, nullable = false): Promise<string | null> {
    if (this.options.version() !== 2) throw new AppProtocolError('projection subscriptions require protocolVersion 2', -32602);
    if (this.closed) throw new AppProtocolError('connection is closing');
    return protocolScope(this.options.port, p, nullable);
  }
  private async subscribe(kind: Subscription['kind'], p: ProtocolRow): Promise<AppProtocolDeferredReply> {
    protocolKeys(p, ['workspaceIdentity', 'sessionId', ...(kind === 'workflow' ? ['runId', 'afterSeq'] : kind === 'conversation' ? ['logEpoch', 'seq'] : [])]);
    const sessionId = await this.scope(p, kind === 'controller');
    if (this.subscriptions.size >= 16) throw new AppProtocolError('subscription capacity reached', -32001, { reasonCode: 'subscription_capacity' });
    const selected = kind === 'conversation' ? base(p) : { seq: 0 };
    const sub: Subscription = { id: token(), kind, sessionId, generation: 1, ready: false, ...selected };
    if (kind === 'controller') sub.epoch = token();
    if (kind === 'workflow') {
      sub.runId = protocolToken(p.runId, 'runId');
      if (p.afterSeq !== undefined && (!Number.isSafeInteger(p.afterSeq) || p.afterSeq < 0)) throw new AppProtocolError('invalid afterSeq', -32602);
      sub.seq = p.afterSeq ?? 0;
      await this.options.port.ask('GET', `/api/sessions/${sessionId}/workflow-scripts/${sub.runId}`);
    }
    this.subscriptions.set(sub.id, sub);
    return this.deferred(sub, 'initial');
  }
  private async selected(kind: Subscription['kind'], p: ProtocolRow): Promise<Subscription> {
    await this.scope({ workspaceIdentity: p.workspaceIdentity }, true);
    const sub = this.subscriptions.get(protocolToken(p.subscriptionId, 'subscriptionId'));
    if (!sub || sub.kind !== kind) throw new AppProtocolError('subscription not found', -32000, { status: 404 });
    if (sub.sessionId) await this.options.port.authorize(sub.sessionId);
    return sub;
  }
  private async resync(kind: Subscription['kind'], p: ProtocolRow): Promise<AppProtocolDeferredReply> {
    protocolKeys(p, ['workspaceIdentity', 'subscriptionId', ...(kind === 'conversation' ? ['logEpoch', 'seq'] : kind === 'workflow' ? ['afterSeq'] : [])]);
    const sub = await this.selected(kind, p);
    const selected = kind === 'conversation' ? base(p) : undefined;
    if (kind === 'workflow' && p.afterSeq !== undefined && (!Number.isSafeInteger(p.afterSeq) || p.afterSeq < 0)) throw new AppProtocolError('invalid afterSeq', -32602);
    sub.ready = false; sub.generation++; sub.hash = undefined; sub.status = undefined;
    if (selected) Object.assign(sub, { epoch: undefined }, selected);
    if (kind === 'workflow') {
      sub.seq = p.afterSeq ?? 0;
    }
    return this.deferred(sub, 'recovery');
  }
  private async unsubscribe(kind: Subscription['kind'], p: ProtocolRow): Promise<ProtocolRow> {
    protocolKeys(p, ['workspaceIdentity', 'subscriptionId']); const sub = await this.selected(kind, p);
    this.subscriptions.delete(sub.id); return { subscriptionId: sub.id, unsubscribed: true };
  }
  private deferred(sub: Subscription, delivery: string): AppProtocolDeferredReply {
    const generation = sub.generation;
    sub.pendingDelivery = delivery;
    return new AppProtocolDeferredReply({ subscriptionId: sub.id, topic: this.topic(sub), generation, accepted: true }, async () => {
      if (!this.current(sub, generation)) return;
      sub.ready = true;
      const previous = this.emissions.get(sub.id); if (previous) await previous;
      if (!this.paused && this.current(sub, generation)) await this.emit(sub, delivery);
    });
  }
  private current(sub: Subscription, generation: number): boolean { return !this.closed && this.subscriptions.get(sub.id) === sub && sub.generation === generation; }
  private topic(sub: Subscription): string { return sub.kind === 'controller' ? 'controller' : sub.kind === 'workflow' ? `workflow/${sub.sessionId}/${sub.runId}` : `conversation/${sub.sessionId}`; }
  private async emit(sub: Subscription, delivery: string): Promise<void> {
    const work = this.publish(sub, delivery); this.emissions.set(sub.id, work);
    try { await work; } finally { if (this.emissions.get(sub.id) === work) this.emissions.delete(sub.id); }
  }
  private async publish(sub: Subscription, delivery: string): Promise<void> {
    const { port } = this.options, generation = sub.generation;
    delivery = sub.pendingDelivery ?? delivery;
    try {
      if (!port.enabled('remote')) throw new AppProtocolError('remote plugin unavailable', -32000, { status: 403 });
      if (sub.sessionId) await port.authorize(sub.sessionId);
      let envelope: ProtocolRow, fromSeq = sub.seq, toSeq: number, observedHash: string | undefined;
      if (sub.kind === 'conversation') {
        envelope = await port.ask('GET', `/api/sessions/${sub.sessionId}/conversation-transport`, {}, sub.epoch ? { logEpoch: [sub.epoch], seq: [String(sub.seq)] } : {});
        if (delivery === 'online' && envelope.mode === 'resume' && !envelope.frames.length) return;
        toSeq = envelope.seq;
      } else if (sub.kind === 'controller') {
        const raw = await port.ask('GET', '/api/sessions/index');
        const sessions = (raw.sessions ?? []).filter((row: ProtocolRow) => row.root === port.workspaceIdentity);
        const snapshot = { ...raw, workspaceIdentity: port.workspaceIdentity, sessions }, digest = hash(snapshot);
        if (delivery === 'online' && sub.hash === digest) return;
        toSeq = sub.seq + 1; envelope = { kind: 'snapshot', logEpoch: sub.epoch, fromSeq, toSeq, snapshot }; observedHash = digest;
      } else {
        envelope = await port.ask('GET', `/api/sessions/${sub.sessionId}/workflow-scripts/${sub.runId}/events`, {}, { afterSeq: [String(sub.seq)] });
        if (delivery === 'online' && !envelope.events.length && sub.status === envelope.status) return;
        toSeq = envelope.events.at(-1)?.seq ?? sub.seq;
      }
      if (!this.current(sub, generation) || !sub.ready || this.paused) return;
      const content = this.options.wrap(sub.kind === 'conversation' ? 'conversation/snapshot' : sub.kind === 'workflow' ? 'workflow/events' : 'controller/frame', sub.sessionId, envelope);
      await this.options.notify(`${sub.kind}/frame`, { subscriptionId: sub.id, topic: this.topic(sub), generation, delivery, fromSeq, toSeq, envelope: content });
      if (!this.current(sub, generation)) return;
      sub.pendingDelivery = undefined;
      if (observedHash) sub.hash = observedHash;
      sub.seq = toSeq;
      if (sub.kind === 'conversation') sub.epoch = envelope.logEpoch;
      if (sub.kind === 'workflow') sub.status = envelope.status;
    } catch (error) {
      if (!this.current(sub, generation)) return;
      this.subscriptions.delete(sub.id);
      await this.options.notify('subscription/closed', { subscriptionId: sub.id, topic: this.topic(sub), reason: error instanceof Error ? error.message : 'projection unavailable', resyncRequired: true });
    }
  }
  private async poll(): Promise<void> {
    if (this.closed || this.busy || this.paused) return;
    this.busy = true;
    try { for (const sub of this.subscriptions.values()) if (sub.ready && !this.emissions.has(sub.id) && !this.closed && !this.paused) await this.emit(sub, 'online'); }
    finally { this.busy = false; }
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.subscriptions.clear(); }
}
