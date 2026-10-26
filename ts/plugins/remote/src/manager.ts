/** Live connection owner, fenced by saved configuration and generation. In-process only. */
import { randomUUID } from "node:crypto";
import { pyLen } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { SessionClient, TransportError } from "./client.ts";
import { forget_dir, observe, pluginEnabled, reset } from "./connection-state.ts";
import { acceptHello, acceptIndex, performRequest, requirePosix, validatedLimits, type LiveClient, type LiveItem, type RequestHost } from "./manager-ops.ts";
import { DEFAULT_REPLAY_DEADLINE_SECONDS, replayCommand } from "./command-replay.ts";
import { ProjectionSubscriber, type ProjectionCursor, type ProjectionFrame, type ProjectionKind, type SubscriptionState } from "./projection-subscriber.ts";
import { digest, loadConnections, type RemoteConnection } from "./store.ts";

const MAX_CONNECTIONS = 32;
const MAX_OPERATIONS = 128;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIVE = new Set(["pending", "reconnecting", "connected"]);
const managers = new Set<ConnectionManager>();
const nap = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteKeyError extends Error {
  override name = "RemoteKeyError";
  constructor(message: string) { super(message); }
}
export class RemoteValueError extends Error {
  override name = "RemoteValueError";
  constructor(message: string) { super(message); }
}

export interface RemoteManager {
  active(): unknown;
  operation(id: string): unknown;
  cancel(id: string): unknown;
  request(cid: string, method: string, params: Record<string, unknown>, opts: { expectedGeneration: string; expectedDigest: string; requestId?: unknown }): unknown;
  connect(cid: string, expectedDigest: string, requestId: unknown, opts: { reconnect: boolean; expectedGeneration?: unknown }): unknown;
  disconnect(cid: string, expectedDigest: string): unknown;
  invalidate(id: string): void;
  projection(cid: string, expectedGeneration: string): unknown;
  subscribeProjection(cid: string, expectedGeneration: string, kind: ProjectionKind, sessionId: string | null, cursor?: ProjectionCursor, runId?: string): unknown;
  executeCommand(cid: string, expectedGeneration: string, expectedDigest: string, command: { commandId: string; type: string; payload: Record<string, unknown>; sessionId?: string | null }, opts?: { timeout?: number; deadline?: number }): Promise<Record<string, unknown>>;
}

export interface ManagerOptions {
  clientFactory?: (row: RemoteConnection, root: string, onClose: (reason: string) => void) => LiveClient;
  /** v2 projection frames as the manager delivers them, per connection. */
  onFrame?: (connectionId: string, frame: ProjectionFrame) => void;
}

class CancelFlag {
  private flagged = false;
  isSet(): boolean { return this.flagged; }
  set(): void { this.flagged = true; }
}

interface Signature { connectionId: string; digest: string; reconnect: boolean; generation: unknown }
interface Operation {
  requestId: string; connectionId: string; generation: string; status: string; error?: string;
  _cancel: CancelFlag; _signature: Signature;
}

function loadError(error: unknown): boolean {
  if (isPyValueError(error) || isPyOSError(error) || error instanceof RemoteValueError) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "JSONDecodeError" || name === "UnicodeError" || name === "UnicodeDecodeError" || name === "PermissionError";
}

function sameSignature(left: Signature, right: Signature): boolean {
  return left.connectionId === right.connectionId && left.digest === right.digest && left.reconnect === right.reconnect && Object.is(left.generation, right.generation);
}

function defaultFactory(row: RemoteConnection, root: string, onClose: (reason: string) => void): LiveClient {
  return new SessionClient({ row, root, onClose }) as unknown as LiveClient;
}

/** Manager-owned spawn: the transport's notifications feed the live v2 subscriber. */
function managerFactory(manager: ConnectionManager): (row: RemoteConnection, root: string, onClose: (reason: string) => void) => LiveClient {
  return (row, root, onClose) => {
    let client: SessionClient | null = null;
    client = new SessionClient({ row, root, onClose, onNotification: (frame) => manager.routeNotification(row.id, client!, frame) });
    return client as unknown as LiveClient;
  };
}

export class ConnectionManager implements RemoteManager, RequestHost {
  readonly connections = new Map<string, LiveItem>();
  private readonly operations = new Map<string, Operation>();
  private readonly cancelled = new Map<string, { at: number; generation: string }>();
  /** v2 subscription cursors saved across reconnect generations (F11.03). */
  private readonly resumable = new Map<string, SubscriptionState[]>();
  private readonly clientFactory: NonNullable<ManagerOptions["clientFactory"]>;
  private readonly onFrame: ManagerOptions["onFrame"];
  closed = false;
  private stop = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly stateDir: string;
  readonly root: string;
  constructor(stateDir: string, root = process.cwd(), options: ManagerOptions = {}) {
    this.stateDir = stateDir; this.root = root;
    this.onFrame = options.onFrame;
    this.clientFactory = options.clientFactory ?? managerFactory(this);
    this.timer = setInterval(() => this.watch(), 500);
    this.timer.unref?.();
    managers.add(this);
  }

  enabled(pluginId: string): boolean { return pluginEnabled(this.stateDir, pluginId); }

  async call(client: LiveClient, method: string, params: Record<string, unknown>, opts: { requestId?: unknown; timeout: number; cancel?: { isSet(): boolean } | null }): Promise<unknown> {
    return await client.request(method, params, { requestId: opts.requestId, timeout: opts.timeout, cancel: opts.cancel });
  }

  row(connectionId: string, expectedDigest: string): RemoteConnection {
    if (this.closed || !pluginEnabled(this.stateDir, "remote")) { this.close(); throw new TransportError("remote plugin unavailable"); }
    let rows: RemoteConnection[];
    try { rows = loadConnections(this.stateDir); } catch (error) {
      if (!loadError(error)) throw error;
      this.invalidate(connectionId);
      throw new RemoteValueError("remote configuration unavailable");
    }
    const row = rows.find((item) => item.id === connectionId) ?? null;
    if (row == null || digest(row) !== expectedDigest) { this.invalidate(connectionId); throw new RemoteValueError("connection changed; inspect configuration again"); }
    requirePosix(row);
    return row;
  }

  connect(connectionId: string, expectedDigest: string, requestId: unknown, opts: { reconnect: boolean; expectedGeneration?: unknown }): Record<string, unknown> {
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) throw new RemoteValueError("invalid connection id");
    if (typeof expectedDigest !== "string" || !DIGEST.test(expectedDigest)) throw new RemoteValueError("invalid configuration digest");
    const expectedGeneration = opts.expectedGeneration ?? null;
    if (opts.reconnect && (typeof expectedGeneration !== "string" || pyLen(expectedGeneration) === 0)) throw new RemoteValueError("expectedGeneration required");
    const row = this.row(connectionId, expectedDigest);
    if (typeof requestId !== "string" || pyLen(requestId) < 1 || pyLen(requestId) > 128) throw new RemoteValueError("invalid requestId");
    const stamp = performance.now() / 1000;
    this.prune(stamp);
    const prior = this.cancelled.get(requestId);
    if (prior) return { requestId, connectionId, generation: prior.generation, status: "cancelled" };
    const signature = { connectionId, digest: expectedDigest, reconnect: opts.reconnect, generation: expectedGeneration };
    const oldOp = this.operations.get(requestId);
    if (oldOp) { if (!sameSignature(oldOp._signature, signature)) throw new RemoteValueError("requestId conflict"); return this.publishOp(oldOp); }
    const old = this.connections.get(connectionId);
    if (expectedGeneration != null && (old == null || old.generation !== expectedGeneration)) throw new RemoteValueError("stale connection generation");
    if (old && ACTIVE.has(old.state) && !opts.reconnect) throw new RemoteValueError("connection already active");
    if (this.connections.size >= MAX_CONNECTIONS && old == null) throw new RemoteValueError("connection limit reached");
    while (this.operations.size >= MAX_OPERATIONS) {
      const completed = [...this.operations].find(([, op]) => op.status !== "pending");
      if (!completed) throw new RemoteValueError("operation limit reached");
      this.operations.delete(completed[0]);
    }
    try { old?.client?.close(); } catch { /* The replacement must not keep the previous transport. */ }
    if (old?.subscriber) this.captureResumable(connectionId, old.subscriber as ProjectionSubscriber);
    const item: LiveItem = { connectionId, digest: expectedDigest, generation: randomUUID().replace(/-/g, ""), state: opts.reconnect ? "reconnecting" : "pending", workspaceIdentity: null, capabilities: {}, limits: {}, index: null, methods: [], client: null, protocolVersion: 1, maxSubscriptions: 0, subscriber: null };
    this.connections.set(connectionId, item);
    const op: Operation = { requestId, connectionId, generation: item.generation, status: "pending", _cancel: new CancelFlag(), _signature: signature };
    this.operations.set(requestId, op);
    this.phase(connectionId, item, item.state);
    void this.establish(row, item, op);
    return this.publishOp(op);
  }

  operation(requestId: string): Record<string, unknown> {
    const op = this.operations.get(requestId);
    if (op == null) throw new RemoteKeyError("operation unavailable");
    return this.publishOp(op);
  }

  cancel(requestId: string): Record<string, unknown> {
    const op = this.operations.get(requestId);
    if (op == null) {
      if (typeof requestId !== "string" || pyLen(requestId) < 1 || pyLen(requestId) > 128) throw new RemoteValueError("invalid requestId");
      const stamp = performance.now() / 1000;
      this.prune(stamp);
      if (!this.cancelled.has(requestId)) {
        if (this.cancelled.size >= MAX_OPERATIONS) throw new RemoteValueError("cancellation capacity reached");
        this.cancelled.set(requestId, { at: stamp, generation: randomUUID().replace(/-/g, "") });
      }
      return { requestId, status: "cancelled" };
    }
    if (op.status === "pending" || op.status === "connected") {
      op._cancel.set();
      const item = this.connections.get(op.connectionId);
      if (item && item.generation === op.generation) { this.phase(op.connectionId, item, "disconnected"); try { item.client?.close(); } catch { /* close is best-effort */ } }
      op.status = "cancelled";
    }
    return this.publishOp(op);
  }

  disconnect(connectionId: string, expectedGeneration: string): Record<string, unknown> {
    const item = this.connections.get(connectionId);
    if (item == null || item.generation !== expectedGeneration) throw new RemoteValueError("stale connection generation");
    for (const op of this.operations.values()) if (op.generation === expectedGeneration && op.status === "pending") { op._cancel.set(); op.status = "cancelled"; }
    item.subscriber = null;
    this.resumable.delete(connectionId);
    this.phase(connectionId, item, "disconnected");
    try { item.client?.close(); } catch { /* close is best-effort */ }
    return this.publicView(item);
  }

  invalidate(connectionId: string): void {
    const item = this.connections.get(connectionId);
    if (item) this.disconnect(connectionId, item.generation);
  }

  active(): Record<string, unknown>[] {
    for (const item of [...this.connections.values()]) {
      try { this.row(item.connectionId, item.digest); } catch (error) {
        if (!(error instanceof RemoteValueError) && !(error instanceof TransportError)) throw error;
      }
      if (item.state === "connected" && item.client && !item.client.alive) this.phase(item.connectionId, item, "disconnected");
    }
    return [...this.connections.values()].map((item) => this.publicView(item));
  }

  request(connectionId: string, method: string, params: Record<string, unknown>, opts: { expectedGeneration: string; expectedDigest: string; requestId?: unknown; timeout?: unknown; cancel?: { isSet(): boolean } | null }): Promise<unknown> {
    return performRequest(this, connectionId, method, params, opts);
  }

  /** v2 projection states; a v1 connection reports an empty set, never an error state. */
  projection(connectionId: string, expectedGeneration: string): Record<string, unknown>[] {
    const item = this.connections.get(connectionId);
    if (item == null || item.generation !== expectedGeneration) throw new RemoteValueError("stale connection generation");
    if (item.state !== "connected") throw new TransportError("remote connection unavailable");
    return item.subscriber?.states() ?? [];
  }

  async subscribeProjection(connectionId: string, expectedGeneration: string, kind: ProjectionKind, sessionId: string | null, cursor: ProjectionCursor = {}, runId?: string): Promise<Record<string, unknown>> {
    const item = this.connections.get(connectionId);
    if (item == null || item.generation !== expectedGeneration) throw new RemoteValueError("stale connection generation");
    if (item.state !== "connected" || item.protocolVersion !== 2 || item.subscriber == null) throw new TransportError("projection subscriptions unavailable");
    return await (item.subscriber as ProjectionSubscriber).subscribe(kind, sessionId, cursor, runId);
  }

  /** F11.04 canonical replay: the same commandId is resent only after a receipt probe. */
  async executeCommand(connectionId: string, expectedGeneration: string, expectedDigest: string, command: { commandId: string; type: string; payload: Record<string, unknown>; sessionId?: string | null }, opts: { timeout?: number; deadline?: number } = {}): Promise<Record<string, unknown>> {
    if (typeof command.commandId !== "string" || pyLen(command.commandId) < 1 || pyLen(command.commandId) > 128) throw new RemoteValueError("invalid commandId");
    if (typeof command.type !== "string" || !command.type) throw new RemoteValueError("invalid command type");
    if (command.payload == null || typeof command.payload !== "object" || Array.isArray(command.payload)) throw new RemoteValueError("invalid command payload");
    const deadlineSeconds = typeof opts.deadline === "number" && opts.deadline > 0 ? opts.deadline : DEFAULT_REPLAY_DEADLINE_SECONDS;
    const timeout = typeof opts.timeout === "number" && opts.timeout > 0 ? opts.timeout : 30;
    const bound = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      await this.ensureChannel(connectionId, expectedDigest, expectedGeneration, deadlineSeconds);
      const item = this.connections.get(connectionId);
      if (item == null) throw new TransportError("remote connection unavailable");
      return await performRequest(this, connectionId, method, params, { expectedGeneration: item.generation, expectedDigest, timeout });
    };
    const scope = command.sessionId != null ? { sessionId: command.sessionId } : {};
    return await replayCommand({
      commandId: command.commandId,
      deadlineSeconds,
      execute: () => bound("command/execute", { commandId: command.commandId, type: command.type, payload: command.payload, ...scope }),
      query: () => bound("command/query", { commandId: command.commandId, ...scope }),
    }) as Record<string, unknown>;
  }

  /** A live command channel; a dead transport is reconnected at most every 250ms until the deadline. */
  private async ensureChannel(connectionId: string, expectedDigest: string, knownGeneration: string, deadlineSeconds: number): Promise<void> {
    const until = Date.now() + Math.min(deadlineSeconds, 120) * 1000;
    let lastAttempt = 0;
    while (Date.now() < until && !this.closed) {
      const item = this.connections.get(connectionId);
      if (item && item.state === "connected" && item.client?.alive && Array.isArray(item.methods) && item.methods.includes("command/execute")) return;
      if (Date.now() - lastAttempt < 250) { await nap(50); continue; }
      lastAttempt = Date.now();
      const requestId = "replay-" + randomUUID();
      try { this.connect(connectionId, expectedDigest, requestId, { reconnect: true, expectedGeneration: item?.generation ?? knownGeneration }); }
      catch (error) { if (error instanceof RemoteValueError) throw error; }
      while (Date.now() < until) {
        const current = this.operations.get(requestId);
        if (current == null || current.status !== "pending") break;
        await nap(25);
      }
    }
    throw new TransportError("remote connection unavailable");
  }

  private captureResumable(connectionId: string, subscriber: ProjectionSubscriber): void {
    const states = subscriber.states();
    if (states.length) this.resumable.set(connectionId, states);
    else this.resumable.delete(connectionId);
  }

  /** Saved v2 subscriptions continue from their committed cursors on the new generation (F11.03). */
  private async resumeProjections(connectionId: string, item: LiveItem, saved: SubscriptionState[]): Promise<void> {
    for (const state of saved) {
      if (this.closed || this.connections.get(connectionId) !== item || item.state !== "connected" || !item.subscriber) return;
      const cursor: ProjectionCursor = state.kind === "conversation"
        ? (state.epoch !== undefined ? { logEpoch: state.epoch, seq: state.seq } : { seq: state.seq })
        : state.kind === "workflow" ? { afterSeq: state.seq } : {};
      try { await (item.subscriber as ProjectionSubscriber).subscribe(state.kind, state.sessionId, cursor, state.runId); }
      catch { /* one lost topic must not drop the others */ }
    }
    const current = this.connections.get(connectionId);
    if (current === item && item.subscriber) this.captureResumable(connectionId, item.subscriber as ProjectionSubscriber);
    else this.resumable.delete(connectionId);
  }

  /** Transport notifications reach the subscriber of the connection that owns the client. */
  routeNotification(connectionId: string, client: unknown, frame: { method?: unknown; params?: unknown }): void {
    if (typeof frame.method !== "string") return;
    const item = this.connections.get(connectionId);
    if (item != null && item.client === (client as LiveClient) && item.subscriber != null) item.subscriber.ingest(frame.method, frame.params);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop = true;
    if (this.timer) clearInterval(this.timer);
    for (const op of this.operations.values()) if (op.status === "pending") { op._cancel.set(); op.status = "cancelled"; }
    for (const [cid, item] of this.connections) { this.phase(cid, item, "disconnected"); try { item.client?.close(); } catch { /* close is best-effort */ } }
    forget_dir(this.stateDir);
  }

  private async establish(row: RemoteConnection, item: LiveItem, op: Operation): Promise<void> {
    const cid = item.connectionId;
    let client: LiveClient | null = null;
    try {
      client = this.clientFactory(row, this.root, () => { if (this.connections.get(cid) === item) this.phase(cid, item, "disconnected"); });
      if (this.closed || this.connections.get(cid) !== item || op._cancel.isSet()) throw new TransportError("connection cancelled");
      item.client = client;
      // Prefer the v2 projection path; an older app-server may only speak v1.
      let hello = await this.call(client, "initialize", { protocolVersion: 2 }, { timeout: 20, cancel: op._cancel });
      if (!acceptHello(hello)) {
        if (!client.alive) throw new TransportError("remote protocol capabilities unavailable");
        hello = await this.call(client, "initialize", { protocolVersion: 1 }, { timeout: 20, cancel: op._cancel });
      }
      if (!acceptHello(hello)) throw new TransportError("remote protocol capabilities unavailable");
      const index = await this.call(client, "sessions/index", { workspaceIdentity: hello.workspaceIdentity }, { timeout: 20, cancel: op._cancel });
      if (!acceptIndex(index, hello.workspaceIdentity)) throw new TransportError("invalid authoritative session index");
      this.row(cid, item.digest);
      if (this.closed || this.connections.get(cid) !== item || op._cancel.isSet() || !client.alive) throw new TransportError("connection superseded");
      item.workspaceIdentity = hello.workspaceIdentity;
      item.capabilities = hello.capabilities;
      item.limits = validatedLimits(hello.limits);
      item.index = index;
      item.methods = [...hello.methods];
      item.protocolVersion = hello.protocolVersion;
      item.maxSubscriptions = hello.maxSubscriptions;
      if (hello.protocolVersion === 2) {
        // The manager drives the v2 projection path: READY replies, cursor continuity and resync.
        item.subscriber = new ProjectionSubscriber({
          request: (method, params) => performRequest(this, cid, method, params, { expectedGeneration: item.generation, expectedDigest: item.digest, timeout: 30 }),
          onFrame: (frame) => this.onFrame?.(cid, frame),
        });
      }
      this.phase(cid, item, "connected");
      op.status = "connected";
      const saved = this.resumable.get(cid);
      if (saved?.length && item.subscriber) void this.resumeProjections(cid, item, saved);
    } catch {
      try { client?.close(); } catch { /* close is best-effort */ }
      if (this.connections.get(cid) === item) { item.subscriber = null; this.phase(cid, item, "disconnected"); }
      op.status = op._cancel.isSet() ? "cancelled" : "failed";
      op.error = "connection unavailable; check saved configuration, trusted host key and remote app-server";
    }
  }

  private phase(cid: string, item: LiveItem, phase: string): void {
    item.state = phase;
    observe(this.stateDir, cid, item.digest, phase);
  }

  private publicView(item: LiveItem): Record<string, unknown> {
    return { connectionId: item.connectionId, digest: item.digest, generation: item.generation, state: item.state, workspaceIdentity: item.workspaceIdentity, capabilities: item.capabilities, limits: item.limits, protocolVersion: item.protocolVersion, maxSubscriptions: item.maxSubscriptions };
  }

  private publishOp(op: Operation): Record<string, unknown> {
    const view: Record<string, unknown> = { requestId: op.requestId, connectionId: op.connectionId, generation: op.generation, status: op.status };
    if (op.error != null) view.error = op.error;
    return view;
  }

  private prune(stamp: number): void {
    for (const [key, value] of this.cancelled) if (stamp - value.at >= 300) this.cancelled.delete(key);
  }

  private watch(): void {
    if (this.stop) return;
    try {
      if (!pluginEnabled(this.stateDir, "remote")) { this.close(); return; }
      this.active();
    } catch (error) {
      if (error instanceof RemoteValueError || loadError(error)) { for (const cid of [...this.connections.keys()]) this.invalidate(cid); return; }
      throw error;
    }
  }
}

export function getManager(ctx: { stateDir: string; remote_connections?: RemoteManager; projectDir?: string; project_dir?: string }): RemoteManager {
  const manager = ctx.remote_connections;
  if (!pluginEnabled(ctx.stateDir, "remote")) {
    const closer = manager as { close?: () => void } | undefined;
    if (closer && typeof closer.close === "function") closer.close();
    throw new TransportError("remote plugin unavailable");
  }
  if (manager == null || (manager as { closed?: boolean }).closed === true) {
    const root = ctx.projectDir ?? ctx.project_dir;
    const created = new ConnectionManager(ctx.stateDir, typeof root === "string" && root ? root : process.cwd());
    ctx.remote_connections = created;
    return created;
  }
  return manager;
}

/** Drop process-local managers and recorded phases. */
export function resetManagerForTests(): void {
  for (const manager of managers) manager.close();
  managers.clear();
  reset();
}
