import { listSessions, listSessionsIndex } from '../../xuenessWorkbench';
import type { Result, SessionSummary } from '../../xuenessWorkbench';
import { t as tr } from '../../i18n';

export type SessionChangeSummary = { added?: number; removed?: number; files?: number; fileCount?: number } | string;
export type SessionRemoteConnectionState =
  'unknown' | 'pending' | 'reconnecting' | 'connected' | 'disconnected';
export type SessionRemoteSummary = {
  connectionId: string;
  configuration: 'configured' | 'changed' | 'missing' | 'unavailable' | 'unsupported';
  /**
   * unknown unless a caller already recorded a phase for this exact saved
   * configuration. One-shot SSH does not create that record.
   */
  connectionState: SessionRemoteConnectionState;
};
export type SessionSidebarSidecar = {
  workspace?: string;
  workspaceId?: string;
  workspacePath?: string;
  workspaceName?: string;
  purpose?: string;
  pendingInteraction?: unknown;
  unread?: boolean;
  unreadAt?: string | number | null;
  changeSummary?: SessionChangeSummary | null;
  remote?: SessionRemoteSummary;
};

const MAX_ROWS = 200;
const MAX_TEXT = 120;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, limit = MAX_TEXT): string | undefined =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) || undefined : undefined;
const pathText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)
    ? value : undefined;

function pendingInteraction(value: unknown): unknown {
  if (value === true) return true;
  if (typeof value === 'string') return text(value);
  const record = object(value);
  if (!record) return undefined;
  const label = text(record.label);
  if (record.kind !== 'permission' && record.kind !== 'userInput') return label;
  return {
    kind: record.kind,
    ...(label ? { label } : {}),
    ...(text(record.interactionId, 80) ? { interactionId: text(record.interactionId, 80) } : {}),
    ...(text(record.toolName, 80) ? { toolName: text(record.toolName, 80) } : {}),
  };
}

export function normalizePendingInteraction(value: unknown): boolean | string {
  const pending = pendingInteraction(value);
  if (typeof pending === 'string') return pending;
  const record = object(pending);
  if (record?.label) return record.label as string;
  if (record?.kind === 'userInput') return tr('需要用户输入');
  if (record?.kind === 'permission') return tr('需要授权');
  return pending === true;
}

export function normalizeChangeSummary(value: unknown): SessionChangeSummary | undefined {
  if (typeof value === 'string') return text(value);
  const record = object(value);
  if (!record) return undefined;
  const count = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
      ? Math.min(1_000_000, Math.trunc(candidate)) || undefined : undefined;
  const added = count(record.added);
  const removed = count(record.removed);
  const files = count(Array.isArray(record.files) ? record.files.length : record.files ?? record.fileCount);
  return added || removed || files ? {
    ...(added ? { added } : {}), ...(removed ? { removed } : {}), ...(files ? { files } : {}),
  } : undefined;
}

const CONNECTION_STATES = ['unknown', 'pending', 'reconnecting', 'connected', 'disconnected'] as const;

function connectionState(value: unknown): SessionRemoteConnectionState | undefined {
  return typeof value === 'string' && (CONNECTION_STATES as readonly string[]).includes(value)
    ? value as SessionRemoteConnectionState : undefined;
}

export function normalizeRemoteSummary(value: unknown): SessionRemoteSummary | undefined {
  const record = object(value);
  const state = connectionState(record?.connectionState);
  if (!record || typeof record.connectionId !== 'string'
      || !record.connectionId.length || record.connectionId.length > 64 || /[^A-Za-z0-9_-]/.test(record.connectionId)
      || !state
      || typeof record.configuration !== 'string'
      || !['configured', 'changed', 'missing', 'unavailable', 'unsupported'].includes(record.configuration)) return undefined;
  return {
    connectionId: record.connectionId,
    configuration: record.configuration as SessionRemoteSummary['configuration'],
    connectionState: state,
  };
}

export function remoteSummaryLabel(remote: SessionRemoteSummary): string {
  switch (remote.configuration) {
    case 'configured': return tr('远程');
    case 'changed': return tr('远程配置已变更');
    case 'missing': return tr('远程配置已移除');
    case 'unavailable': return tr('远程配置不可用');
    case 'unsupported': return tr('远程平台不支持');
  }
}

function sidecarFields(record: Record<string, unknown>): SessionSidebarSidecar {
  const fields: SessionSidebarSidecar = {};
  for (const key of ['workspace', 'workspaceId', 'workspacePath', 'workspaceName', 'purpose'] as const) {
    const raw = record[key] ?? record[key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)];
    const value = key === 'purpose' || key === 'workspaceName'
      ? text(raw, key === 'purpose' ? 32 : MAX_TEXT) : pathText(raw);
    if (value) fields[key] = value;
  }
  if (typeof record.unread === 'boolean') fields.unread = record.unread;
  if (record.unreadAt === null || typeof record.unreadAt === 'number' && Number.isFinite(record.unreadAt) && record.unreadAt > 0) fields.unreadAt = record.unreadAt;
  else if (typeof record.unreadAt === 'string' && record.unreadAt.length <= 64 && Number.isFinite(Date.parse(record.unreadAt))) fields.unreadAt = record.unreadAt;
  const pending = pendingInteraction(record.pendingInteraction);
  if (pending !== undefined) fields.pendingInteraction = pending;
  const changes = normalizeChangeSummary(record.changeSummary);
  if (changes !== undefined) fields.changeSummary = changes;
  const remote = normalizeRemoteSummary(record.remote);
  if (remote !== undefined) fields.remote = remote;
  return fields;
}

/** Only bounded display metadata enters the sidebar; prompts and tool bodies
 * stay in the conversation endpoint. Accept the legacy envelope alias too. */
export function parseSessionsIndex(payload: unknown): SessionSummary[] {
  const envelope = object(payload);
  const entries = envelope?.sessions ?? envelope?.items;
  if (!Array.isArray(entries)) throw new Error('Invalid sessions-index snapshot');
  const rows: SessionSummary[] = [];
  const ids = new Set<string>();
  for (const entry of entries.slice(0, MAX_ROWS * 2)) {
    const record = object(entry);
    const id = text(record?.id, 80);
    if (!record || !id || ids.has(id)) continue;
    ids.add(id);
    const title = text(record.title);
    const nested = object(record.sidecar);
    rows.push({
      id, task: text(record.task) ?? title ?? id, status: text(record.status, 40) ?? 'unknown',
      ...(title ? { title } : {}),
      ...(typeof record.pinned === 'boolean' ? { pinned: record.pinned } : {}),
      ...(pathText(record.root) ? { root: pathText(record.root) } : {}),
      ...(text(record.updatedAt ?? record.updated_at, 64) ? { updatedAt: text(record.updatedAt ?? record.updated_at, 64) } : {}),
      ...sidecarFields({ ...nested, ...record }),
      ...(nested ? { sidecar: sidecarFields(nested) } : {}),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

/** The full legacy list confirms membership; a bounded index enriches it.
 * During a legacy outage retain previous rows outside the snapshot window. */
export function mergeSessionsIndex(previous: SessionSummary[], legacy: Result<SessionSummary[]>, index: Result<SessionSummary[]>): Result<SessionSummary[]> {
  if (!index.ok) return legacy;
  const baseline = legacy.ok ? legacy.value : previous;
  const byId = new Map(baseline.map(row => [row.id, row]));
  // A concurrently fetched index can predate an archive/delete operation.
  const indexed = legacy.ok ? index.value.filter(row => byId.has(row.id)) : index.value;
  const indexedIds = new Set(indexed.map(row => row.id));
  return { ok: true, value: [
    ...indexed.map(row => ({
      ...byId.get(row.id),
      // Omitted attention in a fresh snapshot clears an older projection.
      pendingInteraction: undefined, unread: undefined, unreadAt: undefined, changeSummary: undefined, remote: undefined, sidecar: undefined,
      ...row,
    })),
    ...baseline.filter(row => !indexedIds.has(row.id)),
  ] };
}

export async function loadSidebarSessions(previous: SessionSummary[], signal?: AbortSignal,
  loaders = { legacy: listSessions, index: listSessionsIndex }): Promise<Result<SessionSummary[]>> {
  const [legacy, index] = await Promise.all([loaders.legacy(signal), loaders.index(signal)]);
  return mergeSessionsIndex(previous, legacy, index);
}
