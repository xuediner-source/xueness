/** Native application protocol methods backed by the existing HTTP owners. */
import { isDict } from '@xueness/contracts';
import {
  AppProtocolError, protocolBoundPayload, protocolKeys, protocolScope, protocolToken,
  type AppProtocolPort, type ProtocolMethods, type ProtocolRow,
} from './app-protocol-types.ts';
import { createAppProtocolTransfers, type AppProtocolTransfers } from './app-protocol-transfers.ts';

const COMMAND_ID = /^c_[0-9]{13}_([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/;
const COMMAND_TYPES = new Set(['send', 'queue', 'edit_queue', 'cancel_queue', 'withdraw_queue', 'reorder_queue', 'stop', 'run', 'edit_message', 'fork', 'approve', 'reject', 'approval', 'create_session']);

function row(params: ProtocolRow): ProtocolRow {
  if (!isDict(params)) throw new AppProtocolError('params must be an object', -32602);
  return params;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppProtocolError(`${label} must be a non-empty string`, -32602);
  return value;
}
function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppProtocolError(`${label} must be an integer in ${min}..${max}`, -32602);
  }
  return value;
}
function queryValue(value: string | number): string[] { return [String(value)]; }
function scoped(port: AppProtocolPort, params: ProtocolRow, extra: readonly string[], nullable = false, sessionless = false): Promise<string | null> {
  protocolKeys(params, ['workspaceIdentity', ...(sessionless ? [] : ['sessionId']), ...extra]);
  return protocolScope(port, params, nullable);
}
function requireEnabled(port: AppProtocolPort, pluginId: string): void {
  if (!port.enabled(pluginId)) throw new AppProtocolError(`plugin disabled or unavailable: ${pluginId}`, -32000, { status: 403, plugin: pluginId });
}
function sidPath(sessionId: string, suffix: string): string { return `/api/sessions/${sessionId}/${suffix}`; }
function workflowPath(sessionId: string, runId?: string, operation?: string): string {
  const base = `${sidPath(sessionId, 'workflow-scripts')}${runId ? `/${runId}` : ''}`;
  return operation ? `${base}/${operation}` : base;
}
function workflowRunId(value: unknown): string { return protocolToken(value, 'workflow run id'); }
function revision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_REVISION.test(value)) throw new AppProtocolError(`invalid ${label}`, -32602);
  return value;
}
function commandId(value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) throw new AppProtocolError('invalid commandId', -32602);
  return value;
}
function withTransfer(transfers: AppProtocolTransfers, method: string, sessionId: string | null, result: unknown): unknown {
  return transfers.wrap(method, sessionId, result);
}

export interface AppProtocolCore {
  methods: ProtocolMethods;
  transfers: AppProtocolTransfers;
  close(): void;
}

export function createAppProtocolCore(port: AppProtocolPort): AppProtocolCore {
  const transfers = createAppProtocolTransfers(port);
  const methods: ProtocolMethods = {
    'sessions/index': async (input) => {
      const params = row(input); await scoped(port, params, [], true, true); requireEnabled(port, 'sessions');
      const index = await port.ask('GET', '/api/sessions/index');
      if (!isDict(index) || !Array.isArray(index.sessions)) throw new AppProtocolError('invalid sessions index response');
      const sessions = index.sessions.filter((item: unknown) => isDict(item) && item.root === port.workspaceIdentity)
        .map((item: ProtocolRow) => ({ ...item, workspaceIdentity: port.workspaceIdentity }));
      return { ...index, workspaceIdentity: port.workspaceIdentity, sessions };
    },
    'workspace/index': async (input) => {
      const params = row(input); await scoped(port, params, [], true, true);
      return { workspaceIdentity: port.workspaceIdentity, root: port.workspaceIdentity };
    },
    'session/read': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, []); requireEnabled(port, 'sessions');
      const result = await port.ask('GET', `/api/sessions/${sessionId}`);
      return withTransfer(transfers, 'session/read', sessionId, result);
    },
    'conversation/snapshot': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, []); requireEnabled(port, 'sessions');
      const result = await port.ask('GET', sidPath(sessionId!, 'conversation-transport'));
      return withTransfer(transfers, 'conversation/snapshot', sessionId, result);
    },
    'conversation/resume': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['logEpoch', 'seq']); requireEnabled(port, 'sessions');
      const logEpoch = protocolToken(params.logEpoch, 'conversation log epoch');
      const seq = integer(params.seq, 'seq', 0);
      const result = await port.ask('GET', sidPath(sessionId!, 'conversation-transport'), undefined, { logEpoch: queryValue(logEpoch), seq: queryValue(seq) });
      return withTransfer(transfers, 'conversation/resume', sessionId, result);
    },
    'conversation/rowsRange': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['before', 'limit']); requireEnabled(port, 'sessions');
      const before = integer(params.before, 'before', 0), limit = integer(params.limit, 'limit', 1, 120);
      return port.ask('GET', sidPath(sessionId!, 'conversation'), undefined, { before: queryValue(before), limit: queryValue(limit) });
    },
    'command/execute': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['commandId', 'type', 'payload'], true); requireEnabled(port, 'sessions');
      const id = commandId(params.commandId), type = params.type;
      if (typeof type !== 'string' || !COMMAND_TYPES.has(type) || (sessionId === null) !== (type === 'create_session')) {
        throw new AppProtocolError('command type does not match its session scope', -32602);
      }
      if (!Object.hasOwn(params, 'payload') || !isDict(params.payload)) throw new AppProtocolError('payload must be an object', -32602);
      const payload = protocolBoundPayload(port, params, sessionId);
      if (Object.hasOwn(payload, 'workspaceIdentity')) {
        if (payload.workspaceIdentity !== port.workspaceIdentity) throw new AppProtocolError('payload workspace identity mismatch', -32602);
        delete payload.workspaceIdentity;
      }
      if (type === 'create_session') payload.root = port.workspaceIdentity;
      const path = sessionId === null ? '/api/sessions/commands' : sidPath(sessionId, 'commands');
      return port.ask('POST', path, { commandId: id, type, payload });
    },
    'command/query': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['commandId'], true); requireEnabled(port, 'sessions');
      const id = commandId(params.commandId), path = sessionId === null ? `/api/sessions/commands/${id}` : sidPath(sessionId, `commands/${id}`);
      return port.ask('GET', path);
    },
    'sessions/events': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['cursor', 'epoch', 'limit']); requireEnabled(port, 'sessions');
      const query: Record<string, string[]> = {};
      if (params.cursor !== undefined) query.after = queryValue(integer(params.cursor, 'cursor', 0));
      if (params.epoch !== undefined) query.epoch = queryValue(text(params.epoch, 'epoch'));
      if (params.limit !== undefined) query.limit = queryValue(integer(params.limit, 'limit', 1, 500));
      if (params.cursor !== undefined && params.cursor !== 0 && params.epoch === undefined) throw new AppProtocolError('epoch is required when cursor is nonzero', -32602);
      return port.ask('GET', sidPath(sessionId!, 'events.runtime'), undefined, query);
    },
    'history/fork-boundaries': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, []); requireEnabled(port, 'sessions');
      return withTransfer(transfers, 'history/fork-boundaries', sessionId, await port.ask('GET', sidPath(sessionId!, 'fork-boundaries')));
    },
    'history/rewind-targets': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, []); requireEnabled(port, 'sessions');
      return port.ask('GET', sidPath(sessionId!, 'rewind-targets'));
    },
    'history/rewind': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['messageId', 'revision', 'confirmed']); requireEnabled(port, 'sessions');
      const messageId = protocolToken(params.messageId, 'message id');
      const expectedRevision = revision(params.revision, 'conversation revision');
      if (params.confirmed !== true) throw new AppProtocolError('confirmed must be true', -32602);
      return port.ask('POST', sidPath(sessionId!, 'rewind'), { messageId, revision: expectedRevision, confirmed: params.confirmed });
    },
    'files/rewind-preview': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['messageId']); requireEnabled(port, 'sessions'); requireEnabled(port, 'files');
      const messageId = protocolToken(params.messageId, 'message id');
      return port.ask('GET', sidPath(sessionId!, 'file-rewind'), undefined, { messageId: queryValue(messageId) });
    },
    'files/rewind': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['messageId', 'revision', 'confirmed']); requireEnabled(port, 'sessions'); requireEnabled(port, 'files');
      const messageId = protocolToken(params.messageId, 'message id'), expectedRevision = revision(params.revision, 'file rewind revision');
      if (params.confirmed !== true) throw new AppProtocolError('confirmed must be true', -32602);
      return port.ask('POST', sidPath(sessionId!, 'file-rewind'), { messageId, revision: expectedRevision, confirmed: params.confirmed });
    },
    'response/read': async (input) => {
      const params = row(input), sessionId = await scoped(port, params, ['transferId', 'chunkIndex'], true); requireEnabled(port, 'sessions');
      const transferId = protocolToken(params.transferId, 'transfer id'), chunkIndex = integer(params.chunkIndex, 'chunkIndex', 0);
      return transfers.read(port.workspaceIdentity, sessionId!, transferId, chunkIndex);
    },
  };

  const workflow = (name: string, runId: string, operation: string, input: ProtocolRow, data?: ProtocolRow, query?: Record<string, string[]>): Promise<ProtocolRow> =>
    port.ask(name.startsWith('workflow/') && ['workflow/create', 'workflow/start', 'workflow/resume', 'workflow/cancel', 'workflow/recover', 'workflow/concurrency', 'workflow/resolve', 'workflow/amend', 'workflow/compile'].includes(name) ? 'POST' : 'GET', workflowPath(String(input.sessionId), runId || undefined, operation || undefined), data, query);
  const workflowScope = async (params: ProtocolRow, allowed: readonly string[] = []): Promise<string> => {
    const sessionId = await scoped(port, params, allowed); requireEnabled(port, 'sessions'); requireEnabled(port, 'workflows');
    return sessionId!;
  };
  methods['workflow/list'] = async (input) => {
    const params = row(input); await workflowScope(params);
    return workflow('workflow/list', '', '', params);
  };
  methods['workflow/get'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId']), runId = workflowRunId(params.runId);
    return workflow('workflow/get', runId, '', { ...params, sessionId });
  };
  methods['workflow/events'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId', 'afterSeq']), runId = workflowRunId(params.runId);
    const afterSeq = params.afterSeq === undefined ? 0 : integer(params.afterSeq, 'afterSeq', 0);
    return workflow('workflow/events', runId, 'events', { ...params, sessionId }, undefined, { afterSeq: queryValue(afterSeq) });
  };
  methods['workflow/create'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['source', 'name', 'maxConcurrency', 'writable']);
    const source = text(params.source, 'source'), data: ProtocolRow = { source };
    if (params.name !== undefined) data.name = text(params.name, 'name');
    if (params.maxConcurrency !== undefined) data.maxConcurrency = integer(params.maxConcurrency, 'maxConcurrency', 1, 8);
    if (params.writable !== undefined) { if (typeof params.writable !== 'boolean') throw new AppProtocolError('writable must be a boolean', -32602); data.writable = params.writable; }
    return workflow('workflow/create', '', '', { ...params, sessionId }, data);
  };
  methods['workflow/compile'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['source']);
    return workflow('workflow/compile', 'compile', '', { ...params, sessionId }, { source: text(params.source, 'source') });
  };
  for (const operation of ['start', 'resume'] as const) methods[`workflow/${operation}`] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId', 'digest', 'confirmed', 'allowReal']), runId = workflowRunId(params.runId);
    const digest = text(params.digest, 'digest');
    if (!/^[0-9a-f]{64}$/.test(digest) || params.confirmed !== true || params.allowReal !== undefined && typeof params.allowReal !== 'boolean') {
      throw new AppProtocolError('invalid workflow approval parameters', -32602);
    }
    const data: ProtocolRow = { digest, confirmed: params.confirmed };
    if (params.allowReal !== undefined) data.allowReal = params.allowReal;
    return workflow(`workflow/${operation}`, runId, operation, { ...params, sessionId }, data);
  };
  for (const operation of ['cancel', 'recover'] as const) methods[`workflow/${operation}`] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId']), runId = workflowRunId(params.runId);
    return workflow(`workflow/${operation}`, runId, operation, { ...params, sessionId }, {});
  };
  methods['workflow/concurrency'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId', 'maxConcurrency']), runId = workflowRunId(params.runId);
    return workflow('workflow/concurrency', runId, 'concurrency', { ...params, sessionId }, { maxConcurrency: integer(params.maxConcurrency, 'maxConcurrency', 1, 8) });
  };
  methods['workflow/resolve'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId', 'nodeId', 'answer']), runId = workflowRunId(params.runId);
    if (!Object.hasOwn(params, 'answer')) throw new AppProtocolError('answer is required', -32602);
    return workflow('workflow/resolve', runId, 'resolve', { ...params, sessionId }, { nodeId: text(params.nodeId, 'nodeId'), answer: params.answer });
  };
  methods['workflow/amend'] = async (input) => {
    const params = row(input), sessionId = await workflowScope(params, ['runId', 'source']), runId = workflowRunId(params.runId);
    return workflow('workflow/amend', runId, 'amend', { ...params, sessionId }, { source: text(params.source, 'source') });
  };

  return { methods, transfers, close: () => transfers.close() };
}
