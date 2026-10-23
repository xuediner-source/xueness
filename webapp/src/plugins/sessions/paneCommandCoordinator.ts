// sessions.pane_layout: stable workspace/session command admission across surfaces and remounts.
import { CommandDeliveryUnconfirmedError, createSessionCommandId, validateCreateCommandResult, validateEditCommandResult,
  validateSendCommandResult, type SessionCommandAck, type SessionCommandClient } from './commandClient';
import { matchesFollowupPending, type FollowupAdmission } from './commandLedger';

const commandBarriers = new WeakMap<SessionCommandClient, () => boolean>();
export type PanePendingCommand = { sessionId: string | null; commandId: string; type: string };
const commandPending = new WeakMap<SessionCommandClient, () => PanePendingCommand[]>();
export function panePendingCommands(client: SessionCommandClient): PanePendingCommand[] { return commandPending.get(client)?.() ?? client.pendingCommands(); }
export function paneCommandsBlocked(client: SessionCommandClient): boolean { return commandBarriers.get(client)?.() ?? (client.pendingCommands().length > 0 || !!client.recoveryStorageError()); }

type Validator = (value: unknown, commandId: string) => void;
type UnknownWrite = { sessionId: string | null; validate: Validator; type: string; payload: Record<string, unknown> };
type SharedState = { pending: Map<object, PanePendingCommand>; unknown: Map<string, UnknownWrite> };
const retainedScopes = new Map<string, SharedState>();
const blocked = () => Object.assign(new Error('Another pane command is pending or unconfirmed; check its original result first'), { requestNotSent: true });
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function validator(type: string, sessionId: string | null, payload: Record<string, unknown>): Validator {
  return (value, commandId) => {
    if (type === 'create_session') { validateCreateCommandResult(value, commandId); return; }
    if (type === 'send' || type === 'run') { validateSendCommandResult(sessionId!, value, commandId); return; }
    if (type === 'edit_message') { validateEditCommandResult(sessionId!, Number(payload.messageIndex), value, commandId); return; }
    const r = object(value);
    if (type === 'fork') {
      const child = object(r?.session), boundary = object(r?.boundary);
      if (r?.sourceId === sessionId && typeof child?.id === 'string' && /^[0-9a-f]{32}$/u.test(child.id)
        && child.id !== sessionId && Number.isInteger(boundary?.turn) && typeof boundary?.preview === 'string'
        && typeof r.historyTruncated === 'boolean' && (r.truncationReason === null || typeof r.truncationReason === 'string')) return;
    } else if (type === 'queue') {
      const item = object(r?.item);
      if (typeof r?.id === 'string' && !!r.id && item?.id === r.id && item.text === payload.text
        && ['queued', 'paused'].includes(String(item.status)) && Number.isInteger(item.position) && Number(item.position) >= 0) return;
    } else if (type === 'stop') {
      if (typeof r?.stopping === 'boolean' && (r.id === undefined || r.id === sessionId)) return;
    } else if (['approve', 'approval', 'reject'].includes(type)) {
      const field = type === 'reject' || payload.decision === 'reject' ? 'rejected' : 'approved';
      const inner = object(r?.[field]);
      if (inner?.tool_call_id === payload.tool_call_id && inner?.kind === payload.kind
        && typeof payload.kind === 'string' && !!payload.kind && r?.[field === 'approved' ? 'rejected' : 'approved'] === undefined) return;
    }
    throw new CommandDeliveryUnconfirmedError(commandId);
  };
}

/** Keep this proxy for the binding lifetime. Consumers must not dispose it individually.
 * Queries settle only the exact original receipt, never a different/new mutation.
 */
export function createPaneCommandCoordinator(client: SessionCommandClient, scopeKey?: string, scopeSessionId?: string | null): SessionCommandClient {
  const state: SharedState = (scopeKey ? retainedScopes.get(scopeKey) : undefined) ?? { pending: new Map(), unknown: new Map() };
  if (scopeKey) retainedScopes.set(scopeKey, state);
  const unknown = state.unknown;
  const settle = (sessionId: string | null, id: string, ack: SessionCommandAck | 'unknown') => {
    const entry = unknown.get(id);
    if (!entry || entry.sessionId !== sessionId || ack === 'unknown' || ack.commandId !== id) return;
    const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
    if (status === 'rejected' || status === 'stale') { unknown.delete(id); return; }
    if (status !== 'accepted' && status !== 'noop') return;
    try { entry.validate(ack.result, id); unknown.delete(id); } catch { /* Malformed receipt stays unknown. */ }
  };
  const proxy = new Proxy(client, { get(target, property) {
    if (property === 'pendingCommands') return pendingReferences;
    if (property === 'query' || property === 'queryCreate') return async (...args: unknown[]) => {
      const isCreate = property === 'queryCreate';
      const sessionId = isCreate ? null : String(args[0]), id = String(args[isCreate ? 0 : 1]);
      const ack = isCreate ? await target.queryCreate(id) : await target.query(sessionId!, id);
      settle(sessionId, id, ack); return ack;
    };
    if (property === 'confirmQueueWithdrawalAsync') return async (...args: Parameters<SessionCommandClient['confirmQueueWithdrawalAsync']>) => {
      const [sid, root, withdrawal] = args;
      const entry = unknown.get(withdrawal.id);
      const confirmed = await target.confirmQueueWithdrawalAsync(sid, root, withdrawal);
      if (confirmed && entry?.sessionId === sid && entry.type === 'withdraw_queue'
        && entry.payload.queueId === withdrawal.queueId && entry.payload.expectedText === withdrawal.text
        && entry.payload.expectedRevision === withdrawal.expectedRevision) {
        try {
          entry.validate({ id: withdrawal.queueId, removed: true, recoveryId: withdrawal.id }, withdrawal.id);
          unknown.delete(withdrawal.id);
        } catch { return false; }
      }
      return confirmed;
    };
    if (['submit', 'submitCreate', 'submitEdit', 'submitQueue', 'submitApproval'].includes(String(property))) return async (...args: unknown[]) => {
      const create = property === 'submitCreate';
      const sessionId = create ? null : String(args[0]);
      const type = create ? 'create_session' : property === 'submitEdit' ? 'edit_message' : String(args[1]);
      // Retain an immutable snapshot of the original intent, not a caller-owned object.
      const payload = structuredClone(args[create ? 0 : property === 'submitEdit' ? 1 : 2] as Record<string, unknown>);
      const safeStop = type === 'stop' && sessionId !== null && typeof payload.expected_turn_id === 'string'
        && payload.expected_turn_id.trim().length > 0 && payload.expected_turn_id.length <= 128;
      const followup = property === 'submit' && type === 'queue' ? args[5] as FollowupAdmission | undefined : undefined;
      const certifiedQueue = followup?.proof.sessionId === sessionId && payload.expected_turn_id === followup.proof.expectedTurnId
        && followup.current() && matchesFollowupPending(pendingReferences(), followup.proof);
      if (!safeStop && !certifiedQueue && (state.pending.size || unknown.size)) throw blocked();
      const validate = property === 'submitQueue' ? args[4] as Validator : validator(type, sessionId, payload);
      // Generate basic-command IDs here so malformed success receipts remain queryable.
      const idIndex = property === 'submit' ? 4 : create ? 2 : -1;
      if (idIndex >= 0 && args[idIndex] === undefined) args[idIndex] = createSessionCommandId();
      let id = idIndex >= 0 ? String(args[idIndex]) : '';
      const admission = {};
      state.pending.set(admission,{sessionId,commandId:id || createSessionCommandId(),type});
      try {
        const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>;
        const result = await method.apply(target, args);
        if (property === 'submitEdit' || property === 'submitApproval') {
          const receipt = result as { commandId: string; result: unknown }; id = receipt.commandId;
          validate(receipt.result, id);
        } else if (property !== 'submitQueue') validate(result, id);
        return result;
      } catch (error) {
        if (error instanceof CommandDeliveryUnconfirmedError) {
          id = error.commandId;
          unknown.set(id, { sessionId, validate, type, payload: { ...payload } });
        }
        throw error;
      } finally { state.pending.delete(admission); }
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pendingReferences = () => [...new Map([
    ...state.pending.values(),
    ...[...unknown].map(([commandId, entry]) => ({ commandId, sessionId: entry.sessionId, type: entry.type })),
    ...client.pendingCommands().filter(entry => scopeSessionId === undefined || entry.sessionId === scopeSessionId),
  ].map(entry => [JSON.stringify([entry.sessionId, entry.commandId]), entry])).values()];
  commandBarriers.set(proxy, () => state.pending.size > 0 || pendingReferences().length > 0 || !!client.recoveryStorageError());
  commandPending.set(proxy, pendingReferences);
  return proxy;
}

export type PaneMutationLease = { current(): boolean; release(): void };
export type PaneMutationCoordinator = { acquire(): PaneMutationLease | null; isBusy(): boolean };
/** Optional operation fence includes confirmation/preparation/direct guidance, beyond command admission. */
export function createPaneMutationCoordinator(isCurrent: () => boolean = () => true): PaneMutationCoordinator {
  let active: object | null = null;
  return {
    isBusy: () => active !== null,
    acquire: () => {
      if (active || !isCurrent()) return null;
      const token = {}; active = token;
      return {
        current: () => active === token && isCurrent(),
        release: () => { if (active === token) active = null; },
      };
    },
  };
}

/** A long normal-turn request retains its lease; certified follow-ups have one separate lease. */
export function createPaneFollowupOperationGate(commands: SessionCommandClient, isCurrent: () => boolean) {
  const normal=createPaneMutationCoordinator(isCurrent), followups=createPaneMutationCoordinator(isCurrent);
  return {acquire:(followup?:FollowupAdmission):(()=>void)|null=>{
    if(followup) {
      if(!isCurrent()||!commands.isEffective()||commands.recoveryStorageError()||!followup.current()
        ||!matchesFollowupPending(commands.pendingCommands(),followup.proof))return null;
      const lease=followups.acquire();return lease?()=>lease.release():null;
    }
    if(paneCommandsBlocked(commands))return null;
    const lease=normal.acquire();return lease?()=>lease.release():null;
  }};
}
