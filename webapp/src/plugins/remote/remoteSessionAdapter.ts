import { createRemoteHistoryMediaTransport, createRemoteMediaTransport, validateRemoteMediaRefs } from './remoteMediaTransport';
import { get, post, readJsonResponse } from '../../xuenessApi';
import type { prepareComposer, loadComposerCatalog } from '../../xuenessComposer';
import { SessionCommandClient, CommandDeliveryUnconfirmedError, validateCreateCommandResult, validateEditCommandResult, validateSendCommandResult } from '../sessions/commandClient';
import { remoteConnections, remoteWorkspaceKey, type RemoteOwner, type RemoteSessionRow } from './remoteConnectionStore';
export type RemoteOperation = { requestId: string; connectionId: string; generation: string;
  status: 'pending' | 'connected' | 'failed' | 'cancelled'; error?: string };
const notSent = (message: string) => Object.assign(new Error(message), { requestNotSent: true });
// Keep status information: a lost command response must enter receipt recovery,
// while an explicit remote refusal must not be treated as a successful send.
async function remoteRequestPost(path: string, body: object, signal?: AbortSignal, enabled: () => boolean = () => true): Promise<unknown> {
  const token = await get<{ csrfToken: string }>('/api/csrf', signal);
  signal?.throwIfAborted();
  if (!enabled()) throw notSent('Remote request owner changed before dispatch');
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token.csrfToken }, body: JSON.stringify(body) });
  try { return await readJsonResponse(response); }
  catch (error) { if (error instanceof Error && !response.ok) Object.assign(error, { status: response.status }); throw error; }
}
export type RemotePendingCommand = { commandId: string; sessionId: string | null; type: string; scopeKey: string; withdrawalIntent?: { queueId: unknown; expectedText: unknown; expectedRevision: unknown } };
const pendingCommands = new Map<string, RemotePendingCommand & { validateResult: (value: unknown) => void }>();
const receiptScope = (owner: RemoteOwner) => JSON.stringify([remoteWorkspaceKey(owner), owner.digest]);
const receiptKey = (scope: string, id: string) => JSON.stringify([scope, id]);
function settledReceipt(value: unknown, commandId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const ack = value as Record<string, unknown>;
  // A failed writer can have partially committed. Keep its original identity
  // guarded, matching SessionCommandClient's uncertain-outcome semantics.
  const statuses = ['accepted','rejected','stale','noop'];
  return ack.commandId === commandId && (statuses.includes(String(ack.status))
    || (ack.status === 'duplicate' && statuses.includes(String(ack.originalStatus))));
}
/** Keep the cross-generation guard until the same proof required by the caller validates. */
function resultValidator(type: string, sid: string | null, payload: Record<string, unknown>, commandId: string): (value: unknown) => void {
  const intent = structuredClone(payload);
  return value => {
    const fail = () => { throw new CommandDeliveryUnconfirmedError(commandId); };
    const object = (raw: unknown): Record<string, unknown> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
      return raw as Record<string, unknown>;
    };
    if (type === 'create_session') { validateCreateCommandResult(value, commandId); return; }
    if (type === 'send' || type === 'run') { if (!sid) return fail(); validateSendCommandResult(sid, value, commandId); return; }
    if (type === 'edit_message') { if (!sid || !Number.isSafeInteger(intent.messageIndex)) return fail(); validateEditCommandResult(sid, intent.messageIndex as number, value, commandId); return; }
    const result = object(value);
    switch (type) {
      case 'stop': if (typeof result.stopping !== 'boolean' || (result.id !== undefined && result.id !== sid)) fail(); return;
      case 'queue': {
        const item = object(result.item);
        if (typeof result.id !== 'string' || !result.id || item.id !== result.id || typeof item.text !== 'string'
          || !['queued', 'paused'].includes(String(item.status)) || !Number.isInteger(item.position) || Number(item.position) < 0
          || (item.created_at !== undefined && typeof item.created_at !== 'string')
          || (item.updated_at !== undefined && typeof item.updated_at !== 'string')) fail();
        return;
      }
      case 'edit_queue': {
        const item = object(result.item);
        if (result.id !== intent.queueId || item.id !== intent.queueId || typeof intent.text !== 'string' || item.text !== intent.text.trim()) fail();
        return;
      }
      case 'cancel_queue': case 'withdraw_queue':
        if (result.id !== intent.queueId || result.removed !== true || (type === 'withdraw_queue' && result.recoveryId !== commandId)) fail();
        return;
      case 'reorder_queue':
        if (!Array.isArray(intent.ids) || !Array.isArray(result.ids) || result.ids.length !== intent.ids.length
          || result.ids.some((id, index) => id !== (intent.ids as unknown[])[index])) fail();
        return;
      case 'approve': case 'approval': case 'reject': {
        const field = intent.decision === 'reject' ? 'rejected' : 'approved';
        const inner = object(result[field]);
        if (result[field === 'approved' ? 'rejected' : 'approved'] !== undefined || inner.tool_call_id !== intent.tool_call_id
          || inner.kind !== intent.kind || typeof intent.kind !== 'string' || !intent.kind) fail();
        return;
      }
      case 'fork': {
        const session = object(result.session), boundary = object(result.boundary);
        if (result.sourceId !== sid || typeof session.id !== 'string' || !/^[0-9a-f]{32}$/u.test(session.id) || session.id === sid
          || !Number.isInteger(boundary.turn) || typeof boundary.preview !== 'string' || typeof result.historyTruncated !== 'boolean'
          || !(result.truncationReason === null || typeof result.truncationReason === 'string')) fail();
        return;
      }
      default: fail();
    }
  };
}
function settlePending(scopeKey: string, commandId: string, result: unknown): void {
  if (!settledReceipt(result, commandId)) return;
  const key = receiptKey(scopeKey, commandId), command = pendingCommands.get(key);
  const ack = result as {status: string; originalStatus?: string; result?: unknown};
  const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
  if (command && (status === 'accepted' || status === 'noop')) {
    command.validateResult(ack.result);
  }
  pendingCommands.delete(key);
}
export class RemoteSessionAdapter {
  readonly runtimeKey: string;
  readonly sessions: readonly RemoteSessionRow[];
  constructor(readonly owner: RemoteOwner, private readonly effective: () => boolean = () => true, readonly indexTruncated = false) {
    this.sessions = remoteConnections.sessions().filter(row => remoteWorkspaceKey(row.owner) === remoteWorkspaceKey(owner)).map(row => row.session);
    this.runtimeKey = JSON.stringify([remoteWorkspaceKey(owner), owner.digest, owner.generation]);
  }
  get mediaOwner() { return { connectionId: this.owner.connectionId, digest: this.owner.digest, workspaceIdentity: this.owner.workspaceIdentity ?? '' }; }
  get mediaReady(): boolean { return this.isCurrent() && !!this.owner.workspaceIdentity && this.owner.capabilities.stagedMedia === true && this.owner.capabilities.preparedMedia === true && ["maxChunkBytes", "maxMediaFiles", "maxMediaFileBytes", "maxMediaSelectionBytes"].every(key => Number.isSafeInteger(this.owner.limits?.[key]) && Number(this.owner.limits?.[key]) > 0); }
  private _mediaTransport?: ReturnType<typeof createRemoteMediaTransport>;
  get mediaTransport() { return this._mediaTransport ??= createRemoteMediaTransport(this.mediaOwner, async (method, params, signal) => {
    // A retained draft may reconnect only to the identical saved configuration/workspace.
    if (!this.mediaReady && remoteConnections.current(this.owner)) throw notSent('Remote media limits are unavailable');
    const current = remoteConnections.owner(this.owner.connectionId);
    if (!current || !this.effective() || current.digest !== this.owner.digest || current.workspaceIdentity !== this.owner.workspaceIdentity) throw notSent('Remote attachment owner changed');
    const adapter = new RemoteSessionAdapter(current, this.effective);
    if (!adapter.mediaReady) throw notSent("Remote media limits are unavailable");
    return adapter.request(method, params, signal);
  }, this.owner.limits); }
  loadOptionCatalog: typeof loadComposerCatalog = async (root, sessionId, signal) => {
    if (root && root !== this.owner.workspaceIdentity) throw notSent('Remote catalog scope mismatch');
    const result = await this.request('composer/catalog', { sessionId: sessionId ?? null }, signal) as Awaited<ReturnType<typeof loadComposerCatalog>>;
    if (!result || result.root !== this.owner.workspaceIdentity || !Array.isArray(result.models)
      || result.models.some(model => !model || typeof model.id !== 'string' || typeof model.model !== 'string'
        || typeof model.name !== 'string' || typeof model.configured !== 'boolean' || !Array.isArray(model.reasoningLevels))) throw new Error('Invalid remote model catalog');
    return result;
  };
  get historyMedia() { return createRemoteHistoryMediaTransport(this.mediaOwner, (method, params, signal) => this.request(method, params, signal)); }
  subscribe = remoteConnections.subscribe;
  isCurrent = (): boolean => this.effective() && remoteConnections.current(this.owner);
  isSafetyStopAvailable = (): boolean => {
    const current = remoteConnections.owner(this.owner.connectionId);
    return this.effective() && this.owner.capabilities.durableCommands === true
      && !!current && ['connected', 'disconnected'].includes(current.state)
      && current.generation === this.owner.generation && current.digest === this.owner.digest
      && current.workspaceIdentity === this.owner.workspaceIdentity;
  };
  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, enabled: () => boolean = () => true, onDiscardedMediaResult?: (value: unknown) => void): Promise<unknown> {
    // A remote application 503 can retire the UI while its SSH owner remains
    // alive. Permit only exact-owner disposal/receipt discovery and an explicit
    // observed-turn safety Stop; general reads and new work stay disabled.
    const closeTarget = method === 'terminal/close' ? 'terminalId' : method === 'browser/close' ? 'pageId' : null;
    const cleanup = (closeTarget !== null && typeof params[closeTarget] === 'string'
      && /^[a-f0-9]{32}$/u.test(params[closeTarget] as string)
      && typeof params.sessionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(params.sessionId)
      && Object.keys(params).every(key => key === closeTarget || key === 'sessionId')) || (method === 'terminal/list'
      && typeof params.cleanupOpenId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(params.cleanupOpenId)
      && Object.keys(params).every(key => key === 'cleanupOpenId')) || (method === 'terminal/cancel-open'
      && typeof params.openId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(params.openId)
      && typeof params.sessionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(params.sessionId)
      && Object.keys(params).every(key => key === 'openId' || key === 'sessionId')) || (method === 'browser/cancel-open'
      && typeof params.openId === 'string' && /^[a-f0-9]{32}$/u.test(params.openId)
      && typeof params.sessionId === 'string' && /^[a-f0-9]{32}$/u.test(params.sessionId)
      && Object.keys(params).every(key => key === 'openId' || key === 'sessionId'));
    const stopPayload = params.payload;
    const safetyStop = method === 'command/execute' && params.type === 'stop'
      && typeof params.sessionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(params.sessionId)
      && typeof params.commandId === 'string' && params.commandId.length > 0 && params.commandId.length <= 128
      && !!stopPayload && typeof stopPayload === 'object' && !Array.isArray(stopPayload)
      && Object.keys(stopPayload).length === 1
      && typeof (stopPayload as Record<string, unknown>).expected_turn_id === 'string'
      && !!((stopPayload as Record<string, unknown>).expected_turn_id as string).trim()
      && ((stopPayload as Record<string, unknown>).expected_turn_id as string).length <= 128
      && Object.keys(params).every(key => ['sessionId', 'commandId', 'type', 'payload'].includes(key));
    const available = () => {
      if (this.isCurrent() || (safetyStop && this.isSafetyStopAvailable())) return true;
      const current = remoteConnections.owner(this.owner.connectionId);
      return cleanup && this.effective() && current?.state === 'disconnected'
        && current.generation === this.owner.generation && current.digest === this.owner.digest
        && current.workspaceIdentity === this.owner.workspaceIdentity;
    };
    if (!available() || !enabled()) throw notSent('Remote connection is unavailable');
    const capability = method.startsWith('browser/') ? 'browserTabs' : method.startsWith('terminal/') ? 'interactiveTerminals' : method.startsWith('command/') ? 'durableCommands' : method.startsWith('conversation/') ? 'conversationResume'
      : method === 'history/fork-boundaries' ? 'historyFork' : method === 'composer/catalog' ? 'modelCatalog' : method.startsWith('question/') ? 'questionControls' : method.startsWith('withdrawal/') ? 'withdrawalRecovery'
      : method.startsWith('guidance/') ? 'guidanceControls' : ['media/restore', 'media/preview', 'media/restore-status', 'media/restore-abort'].includes(method) ? 'historyMedia'
      : method.startsWith('media/') ? 'stagedMedia' : method === 'composer/prepare' ? 'preparedMedia' : null;
    if (capability && this.owner.capabilities[capability] !== true) throw notSent('Remote capability is unavailable');
    let result: unknown;
    try { result = await remoteRequestPost(`/api/remote/${encodeURIComponent(this.owner.connectionId)}/request`, {
      expectedGeneration: this.owner.generation, expectedDigest: this.owner.digest, method,
      params: { ...params, workspaceIdentity: this.owner.workspaceIdentity },
    }, signal, () => available() && enabled()); } catch (error) {
      if (this.isCurrent() && error instanceof Error && 'status' in error && Number(error.status) === 503) remoteConnections.disconnect(this.owner.connectionId);
      throw error;
    }
    if (!available() || !enabled()) {
      // A restore may have minted refs before pane retirement. Preserve only
      // disposal intent; never return this late result to the new pane.
      if (['media/restore', 'media/begin', 'media/commit'].includes(method)) onDiscardedMediaResult?.(result);
      throw Object.assign(new Error('Remote connection changed while the request was pending'), { status: 503 });
    }
    return result;
  }
  conversationRequest = async (path: string, signal: AbortSignal): Promise<unknown> => {
    const url = new URL(path, 'http://remote.invalid');
    const match = /^\/api\/sessions\/([^/]+)\/conversation-transport$/u.exec(url.pathname);
    if (!match) throw notSent('Unsupported remote conversation request');
    return this.request(url.searchParams.has('logEpoch') ? 'conversation/resume' : 'conversation/snapshot', {
      sessionId: decodeURIComponent(match[1]), ...(url.searchParams.has('logEpoch') ? {
        logEpoch: url.searchParams.get('logEpoch'), seq: Number(url.searchParams.get('seq')),
      } : {}),
    }, signal);
  };
  pendingCommands(): readonly RemotePendingCommand[] {
    return [...pendingCommands.values()].filter(row => row.scopeKey === receiptScope(this.owner));
  }
  confirmWithdrawalProof(sessionId: string, proof: import('../sessions/queueApi').QueueWithdrawal): boolean {
    if (!this.isCurrent() || proof.sessionId !== sessionId || proof.root !== this.owner.workspaceIdentity
      || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= Date.now()) return false;
    const scopeKey = receiptScope(this.owner), key = receiptKey(scopeKey, proof.id);
    const pending = pendingCommands.get(key);
    if (!pending) return true;
    const intent = pending.withdrawalIntent;
    if (pending.scopeKey !== scopeKey || pending.sessionId !== sessionId || pending.type !== 'withdraw_queue' || !intent
      || intent.queueId !== proof.queueId || intent.expectedText !== proof.text || intent.expectedRevision !== proof.expectedRevision) return false;
    pendingCommands.delete(key);
    return true;
  }
  async queryReceipt(command: RemotePendingCommand): Promise<unknown> {
    if (command.scopeKey !== receiptScope(this.owner)) throw notSent('Receipt belongs to another remote workspace');
    const response = await this.request('command/query', { sessionId: command.sessionId, commandId: command.commandId });
    const result = response && typeof response === 'object' ? (response as {result?: unknown}).result : undefined;
    settlePending(command.scopeKey, command.commandId, result);
    return response;
  }
  createCommands(isEffective: () => boolean, isSafetyStopEffective: () => boolean = isEffective): SessionCommandClient {
    const route = (path: string): { sessionId: string | null; commandId?: string } => {
      const match = /^\/api\/sessions(?:\/([^/]+))?\/commands(?:\/([^/]+))?$/u.exec(path);
      if (!match) throw notSent('Unsupported remote command request');
      return { sessionId: match[1] ? decodeURIComponent(match[1]) : null, ...(match[2] ? { commandId: decodeURIComponent(match[2]) } : {}) };
    };
    return new SessionCommandClient({ receiptScope: typeof window === 'undefined' ? undefined : JSON.stringify(['remote', this.owner.connectionId, this.owner.digest, this.owner.workspaceIdentity]), allowDirectFallback: false, isEffective: () => this.isCurrent() && isEffective(),
      isSafetyStopEffective: () => this.isSafetyStopAvailable() && isSafetyStopEffective(),
      post: async (path, body, signal, beforeSend) => {
        if (beforeSend && !beforeSend()) throw notSent('Remote command is no longer current');
        const target = route(path), command = body as { commandId: string; type: string; payload: Record<string, unknown> };
        const scopeKey = receiptScope(this.owner);
        const previous = this.pendingCommands().find(row => row.sessionId === target.sessionId);
        const safeStop = command.type === 'stop' && target.sessionId !== null
          && typeof command.payload.expected_turn_id === 'string' && !!command.payload.expected_turn_id.trim()
          && command.payload.expected_turn_id.length <= 128;
        if (command.type === 'stop' && !safeStop) throw notSent('Remote stop requires the observed active turn identity');
        // Stop is a safety action, fenced to the observed turn by the server.
        // It receives its own receipt and cannot retire or replace another write.
        if (previous && !safeStop) throw new CommandDeliveryUnconfirmedError(previous.commandId);
        if (pendingCommands.has(receiptKey(scopeKey, command.commandId))) throw notSent('Remote command identity is already pending');
        if (safeStop ? !this.isSafetyStopAvailable() || !isSafetyStopEffective() : !this.isCurrent() || !isEffective()) throw notSent('Remote connection is unavailable');
        const payload = { ...command.payload };
        // Routing is already bound to the initialized workspace and session.
        // Never allow an embedded session field to retarget that scope.
        for (const field of ['session_id', 'sessionId']) {
          if (payload[field] !== undefined && payload[field] !== target.sessionId) throw notSent('Remote command scope mismatch');
          delete payload[field];
        }
        delete payload.root;
        if (payload.remote !== undefined && payload.remote !== this.owner.connectionId) throw notSent('Remote command connection mismatch');
        delete payload.remote;
        const key = receiptKey(scopeKey, command.commandId);
        pendingCommands.set(key, { commandId: command.commandId, sessionId: target.sessionId, type: command.type, scopeKey, validateResult: resultValidator(command.type, target.sessionId, payload, command.commandId), ...(command.type === 'withdraw_queue' ? { withdrawalIntent: { queueId: payload.queueId, expectedText: payload.expectedText, expectedRevision: payload.expectedRevision } } : {}) });
        try {
          const response = await this.request('command/execute', { ...target, ...command, payload }, signal,
            () => (safeStop ? isSafetyStopEffective() : isEffective()) && (!beforeSend || beforeSend()));
          settlePending(scopeKey, command.commandId, response);
          return response;
        } catch (error) {
          if (error instanceof Error && (('requestNotSent' in error && error.requestNotSent === true)
            || ('status' in error && Number(error.status) >= 400 && Number(error.status) < 500 && Number(error.status) !== 408))) pendingCommands.delete(key);
          throw error;
        }
      },
      get: async (path, signal) => {
        const target = route(path);
        const response = await this.request('command/query', target, signal, isEffective);
        const result = response && typeof response === 'object' ? (response as {result?: unknown}).result : undefined;
        if (target.commandId) settlePending(receiptScope(this.owner), target.commandId, result);
        return response;
      },
    });
  }
  prepare: typeof prepareComposer = async (text, input, selection) => {
    // Inline bytes and local workspace contexts never cross this remote boundary.
    // Only scoped references issued through remote staged uploads are admitted.
    if (input && (input.attachments.length || input.files.length || input.sessions.length)) {
      throw notSent('Remote attachments require remote staged uploads');
    }
    const { root: _root, session_id, ...options } = selection;
    const refs = input?.attachmentRefs ?? [];
    if (refs.length && !this.mediaReady) throw notSent('Remote media is unavailable');
    if (refs.length > (this.owner.limits?.maxMediaFiles ?? 0)) throw notSent("Remote attachment selection limit exceeded");
    const attachmentRefs = validateRemoteMediaRefs(refs, this.mediaOwner, this.owner.workspaceIdentity ?? '', selection.session_id);
    const cleanInput = input ? { ...input, remote: undefined, attachmentRefs } : undefined;
    return await this.request('composer/prepare', { sessionId: session_id ?? null,
      payload: { text, ...options, ...(cleanInput ? { input: cleanInput } : {}) },
    }) as Awaited<ReturnType<typeof prepareComposer>>;
  };
}

function validOperation(value: unknown, requestId: string, connectionId: string): value is RemoteOperation {
  if (!value || typeof value !== 'object') return false;
  const row = value as RemoteOperation;
  return row.requestId === requestId && row.connectionId === connectionId && typeof row.generation === 'string'
    && ['pending', 'connected', 'failed', 'cancelled'].includes(row.status);
}
function validOwner(value: unknown): value is RemoteOwner {
  if (!value || typeof value !== 'object') return false;
  const row = value as RemoteOwner;
  return typeof row.connectionId === 'string' && typeof row.digest === 'string' && typeof row.generation === 'string'
    && typeof row.workspaceIdentity === 'string' && !!row.workspaceIdentity && !!row.capabilities && typeof row.capabilities === 'object';
}

/** Selection is committed only after the owner's handshake and initial index succeed. */
export async function connectRemote(id: string, digest: string, signal: AbortSignal,
  progress: (operation: RemoteOperation) => void, requestId: string = crypto.randomUUID()): Promise<RemoteSessionAdapter> {
  const path = `/api/remote/${encodeURIComponent(id)}`;
  const cancel = () => { void post(`/api/remote/operations/${encodeURIComponent(requestId)}/cancel`, {}).catch(() => undefined); };
  const deadline = AbortSignal.timeout(45000);
  const callerSignal = signal;
  signal = AbortSignal.any([callerSignal, deadline]);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw notSent('Remote connection cancelled');
    const observed = await get<{ connections: RemoteOwner[] }>('/api/remote/active', signal);
    const prior = (Array.isArray(observed.connections) ? observed.connections : []).find(row => validOwner(row) && row.connectionId === id);
    if (prior) remoteConnections.disconnect(id);
    let operation = await post<RemoteOperation>(`${path}/${prior ? 'reconnect' : 'connect'}`, {
      requestId, expectedDigest: digest, ...(prior ? { expectedGeneration: prior.generation } : {}),
    }, signal);
    if (!validOperation(operation, requestId, id)) throw new Error('Invalid remote operation');
    if (signal.aborted) { cancel(); throw notSent('Remote connection cancelled'); }
    progress(operation);
    while (operation.status === 'pending') {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(notSent('Remote connection cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      operation = await get<RemoteOperation>(`/api/remote/operations/${encodeURIComponent(requestId)}`, signal);
      if (!validOperation(operation, requestId, id)) throw new Error('Invalid remote operation');
      progress(operation);
    }
    if (operation.status !== 'connected') throw new Error(operation.error || `Remote connection ${operation.status}`);
    const active = await get<{ connections: RemoteOwner[] }>('/api/remote/active', signal);
    const owner = (Array.isArray(active.connections) ? active.connections : []).find(row => validOwner(row) && row.connectionId === id && row.generation === operation.generation && row.digest === digest && row.state === 'connected' && !!row.workspaceIdentity);
    if (!owner) throw new Error('Remote connection could not be verified');
    const rows = new Map<string, RemoteSessionRow>();
    let offset = 0;
    let indexTruncated = false;
    // Bounded windows retain every historical row; absence never means deletion.
    for (let page = 0; page < 10; page++) {
      const index = await get<{ workspaceIdentity: string; sessions: RemoteSessionRow[]; nextOffset?: number | null }>(`${path}/sessions?${new URLSearchParams({ expectedGeneration: owner.generation, expectedDigest: digest, offset: String(offset), limit: '100' })}`, signal);
      if (signal.aborted || index.workspaceIdentity !== owner.workspaceIdentity || !Array.isArray(index.sessions)
        || index.sessions.some(row => !row || typeof row.id !== 'string')) throw new Error('Remote workspace index could not be verified');
      for (const row of index.sessions) rows.set(row.id, row);
      if (index.nextOffset === null || index.nextOffset === undefined) break;
      if (!Number.isSafeInteger(index.nextOffset) || index.nextOffset <= offset) throw new Error('Invalid remote index cursor');
      offset = index.nextOffset;
      indexTruncated = page === 9;
    }
    remoteConnections.publish(owner, [...rows.values()]);
    return new RemoteSessionAdapter(owner, undefined, indexTruncated);
  } catch (error) { cancel(); throw error; } finally { signal.removeEventListener('abort', cancel); }
}
