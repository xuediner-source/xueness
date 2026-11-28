import { t as tr } from '../../i18n';
import type { RunChoices } from '../../xuenessBridge';
import { prepareComposer, type ComposerInput } from '../../xuenessComposer';
import { createSession, queueTurn, sendTurn, stopSession, type WorkbenchSession } from '../../xuenessWorkbench';
import { CommandDeliveryUnconfirmedError, type SessionCommandClient } from './commandClient';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { type ComposerDraftState } from './composerTypes';
import { paneBindingKey, paneComposerKey, type PaneIdentity } from './paneIdentity';
import { hasComposerDraftContent, composerDraftContent } from './composerRecovery';
import { copyPaneRunOptions } from './paneRunOptions';
import { isPaneSessionId } from './paneLayout';
import type { PermissionMode } from './permissionModes';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteWorkspaceKey } from '../remote/remoteConnectionStore';
import { replacementComposerDraftIdentity } from './composerAttachmentDraft';
import { editorStateForPlainText } from './composerEditorState';
import { promotePaneQueuedMessage, type PaneGuidanceTransport } from './paneWorkflowActions';
import type { InputDelivery } from './CurrentTurnInput';
import type { QueueWithdrawal } from './queueApi';
import { validateCreateCommandResult } from './commandReceipt';
import { canAdmitSessionFollowup } from './CommandReceiptRecovery';
import type { FollowupProof } from './commandLedger';

export function secondaryComposerDraftKey(sessionId: string): string {
  return `pane-secondary:${sessionId}`;
}

export type SecondaryPaneSubmitArgs = {
  sessionId: string;
  text: string;
  enabled: boolean;
  running: boolean;
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  input?: ComposerInput;
  choices: RunChoices;
  commands: SessionCommandClient;
  prepare: typeof prepareComposer;
  ensurePermission: (choices: RunChoices, savedMode?: PermissionMode) => Promise<RunChoices | null>;
  onAccepted?: () => void;
  isCurrent?: () => boolean;
  onChoicesChange?: (choices: RunChoices) => void;
  remoteAdapter?: RemoteSessionAdapter | null;
  delivery?: InputDelivery; activeTurnId?: string | null; guidance?: PaneGuidanceTransport;
  readSession?: () => Promise<WorkbenchSession | null>;
  followupProof?: FollowupProof;
  followupCurrent?: () => boolean;
  onPostAdmissionError?: (error: string) => void;
};

/** Prepare and admit one secondary-pane turn. A disabled plugin never prepares or writes. */
export async function submitSecondaryPaneTurn({
  sessionId, text, enabled, running, workspaceRoot, permissionMode, input, choices, commands, prepare, ensurePermission, onAccepted, isCurrent = () => true, onChoicesChange, delivery, activeTurnId, guidance, readSession, onPostAdmissionError, followupProof, followupCurrent = isCurrent,
}: SecondaryPaneSubmitArgs): Promise<boolean> {
  if (!enabled || !isCurrent() || !commands.isEffective() || !isPaneSessionId(sessionId)) return false;
  const canFollowup = () => isCurrent() && followupCurrent() && canAdmitSessionFollowup(commands,sessionId,followupProof,followupCurrent);
  if (running && !canFollowup()) throw Object.assign(new Error('The observed follow-up turn is no longer current'),{requestNotSent:true});
  const confirmed = await ensurePermission({ ...choices }, permissionMode);
  if (!confirmed || !isCurrent()) return false;
  if (running && !canFollowup()) throw Object.assign(new Error('The observed follow-up turn is no longer current'),{requestNotSent:true});
  if (!commands.isEffective()) throw new Error(tr('分屏会话命令已关闭'));
  onChoicesChange?.({ ...confirmed, acknowledge_yolo: false });
  const prepared = await prepare(text, input && { ...input, remote: confirmed.remote }, {
    session_id: sessionId,
    ...(workspaceRoot ? { root: workspaceRoot } : {}),
    ...(confirmed.provider_id ? { provider_id: confirmed.provider_id } : {}),
    ...(confirmed.model ? { model: confirmed.model } : {}),
    ...(confirmed.reasoning_effort ? { reasoning_effort: confirmed.reasoning_effort } : {}),
  });
  if (!commands.isEffective()) throw new Error(tr('分屏会话命令已关闭'));
  if (!isCurrent()) return false;
  if (running && !canFollowup()) throw Object.assign(new Error('The observed follow-up turn is no longer current'),{requestNotSent:true});
  const accepted = () => { if (isCurrent() && commands.isEffective()) onAccepted?.(); };
  // A rebind after the send ACK must not launch a run through the old client.
  const guardedCommands = new Proxy(commands, { get(target, property) {
    if (property === 'isEffective') return () => isCurrent() && target.isEffective();
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const value = text.trim() || tr('附件与上下文');
  if (running) {
    if (delivery === 'guide') {
      if (!guidance || !activeTurnId) throw new Error('Current-turn guidance is unavailable');
      const guided = await guidance.send(sessionId, activeTurnId, value, prepared.token);
      if (!guided.ok) throw guided.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(guided.error);
      accepted(); return true;
    }
    const queued = await queueTurn(sessionId, value, prepared.token, guardedCommands,
      followupProof ? {proof:followupProof,current:()=>isCurrent()&&followupCurrent()} : undefined);
    if (!queued.ok) throw queued.outcomeUnknown ? (queued.commandId ? new CommandDeliveryUnconfirmedError(queued.commandId) : new DeliveryUnconfirmedError()) : new Error(queued.error);
    accepted();
    if (delivery === 'startNow' && guidance && activeTurnId && readSession && isCurrent()) {
      try { await promotePaneQueuedMessage({ sessionId, queueId: queued.value.id, expectedTurnId: activeTurnId,
        choices: confirmed, commands: guardedCommands, guidance, current: isCurrent, readSession }); }
      catch (error) { if (isCurrent()) onPostAdmissionError?.(error instanceof Error ? error.message : String(error)); }
    }
    return true;
  }
  const sent = await sendTurn(sessionId, value, { ...confirmed, goal: prepared.goal }, prepared.token, accepted, guardedCommands);
  if (!sent.ok && !sent.accepted) throw sent.outcomeUnknown ? (sent.commandId ? new CommandDeliveryUnconfirmedError(sent.commandId) : new DeliveryUnconfirmedError()) : new Error(sent.error || tr('发送失败，草稿已保留。'));
  if (!sent.ok && sent.accepted && isCurrent()) onPostAdmissionError?.(sent.error);
  return true;
}

export type DraftStore = { current: Map<string, ComposerDraftState> };
type DraftAdmission = { composerKey: string; draftStore?: DraftStore; phase: 'pending' | 'created' | 'unconfirmed'; sessionId?: string; error?: string;
  commandId?: string; remoteScope?: string; recovering?: boolean };
// Module-owned admissions survive a leaf unmount/remount. Never evict an unresolved creation.
const draftAdmissions = new Map<string, DraftAdmission>();
const draftAdmissionListeners = new Map<string, Set<() => void>>();
function publishDraftAdmission(key: string): void { draftAdmissionListeners.get(key)?.forEach(listener => listener()); }
export function subscribeDraftAdmission(key: string, listener: () => void): () => void {
  const listeners = draftAdmissionListeners.get(key) ?? new Set();
  listeners.add(listener); draftAdmissionListeners.set(key, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) draftAdmissionListeners.delete(key); };
}
export function paneDraftAdmission(identity: PaneIdentity): Readonly<DraftAdmission> | undefined {
  return draftAdmissions.get(paneBindingKey(identity));
}

export function retirePromotedDraftAdmissions(sessionId: string, composerKey: string): string | null {
  let error: string | null = null;
  for (const [key, value] of draftAdmissions) {
    if (value.phase === 'created' && value.sessionId === sessionId && value.composerKey === composerKey) {
      if (value.error && error === null) error = value.error;
      draftAdmissions.delete(key);
    }
  }
  return error;
}

function remoteReceiptScope(adapter: RemoteSessionAdapter): string {
  return JSON.stringify([remoteWorkspaceKey(adapter.owner), adapter.owner.digest]);
}
export function remotePaneCreationReady(identity: PaneIdentity, adapter?: RemoteSessionAdapter | null): boolean {
  return !!adapter?.isCurrent() && identity.scope.remoteConnectionId === adapter.owner.connectionId
    && identity.scope.workspaceIdentity === remoteWorkspaceKey(adapter.owner)
    && adapter.owner.capabilities.durableCommands === true && adapter.owner.capabilities.preparedMedia === true;
}

/** Receipt recovery is read-only: it promotes a confirmed create without starting another run. */
export async function recoverPaneDraftCreation(identity: PaneIdentity, adapter: RemoteSessionAdapter | null | undefined, commands: SessionCommandClient,
  onSessionPromoted: (sessionId: string) => void, isCurrent: () => boolean = () => true): Promise<boolean> {
  const key = paneBindingKey(identity), admission = draftAdmissions.get(key);
  const remote = !!identity.scope.remoteConnectionId;
  const current = () => isCurrent() && (!remote || remotePaneCreationReady(identity, adapter)) && commands.isEffective();
  if (!current() || !admission || admission.phase !== 'unconfirmed' || !admission.commandId
    || (remote && (!adapter || admission.remoteScope !== remoteReceiptScope(adapter))) || admission.recovering) return false;
  admission.recovering = true; publishDraftAdmission(key);
  try {
    const ack = await commands.queryCreate(admission.commandId);
    if (!current() || ack === 'unknown') return false;
    const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
    if (status === 'rejected' || status === 'stale') {
      // These are pre-admission refusals. Never release an uncertain/failed create,
      // or a contradictory refusal containing an already-created identity.
      if (ack.result && typeof ack.result === 'object' && 'id' in ack.result) return false;
      draftAdmissions.delete(key);
      return true; // Retained composer store/draft is untouched; retry is explicit.
    }
    if (status !== 'accepted' && status !== 'noop') return false;
    const id = validateCreateCommandResult(ack.result, admission.commandId);
    admission.phase = 'created'; admission.sessionId = id;
    admission.error = tr('远程会话已创建，请检查会话状态后继续。');
    onSessionPromoted(id);
    return true;
  } finally { admission.recovering = false; publishDraftAdmission(key); }
}

/** A new session already contains its first turn. Prepare, create and run once, never placeholder+send. */
export async function submitPaneDraftTurn(args: Omit<SecondaryPaneSubmitArgs, 'sessionId' | 'running'> & {
  identity: PaneIdentity;
  onSessionPromoted: (sessionId: string) => void;
  onRunError?: (message: string) => void;
  draftStore?: DraftStore;
}): Promise<boolean> {
  const { identity, commands, choices, ensurePermission, onChoicesChange, onAccepted, onSessionPromoted } = args;
  const remote = !!identity.scope.remoteConnectionId;
  const prepare = remote ? args.remoteAdapter?.prepare : args.prepare;
  const current = () => args.enabled && (args.isCurrent?.() ?? true) && commands.isEffective()
    && (!remote || remotePaneCreationReady(identity, args.remoteAdapter));
  if (identity.sessionId !== null || !prepare || !current()) return false;
  const key = paneBindingKey(identity);
  const previous = draftAdmissions.get(key);
  if (previous) {
    if (previous.phase === 'created' && previous.sessionId) onSessionPromoted(previous.sessionId);
    if (previous.phase === 'unconfirmed') throw new DeliveryUnconfirmedError();
    return false;
  }
  if (draftAdmissions.size >= 128) throw new Error(tr('仍有待确认的分屏会话，请先检查会话列表。'));
  const admission: DraftAdmission = { phase: 'pending', composerKey: paneComposerKey(identity), draftStore: args.draftStore,
    ...(remote ? { remoteScope: remoteReceiptScope(args.remoteAdapter!) } : {}) };
  draftAdmissions.set(key, admission); publishDraftAdmission(key);
  try {
    const confirmed = await ensurePermission(copyPaneRunOptions(choices), args.permissionMode);
    if (!confirmed || !current()) return false;
    onChoicesChange?.({ ...confirmed, acknowledge_yolo: false });
    const prepared = await prepare(args.text, args.input && { ...args.input, remote: confirmed.remote }, {
      ...(!remote && identity.scope.workspaceRoot ? { root: identity.scope.workspaceRoot } : {}),
      ...(confirmed.provider_id ? { provider_id: confirmed.provider_id } : {}),
      ...(confirmed.model ? { model: confirmed.model } : {}),
      ...(confirmed.reasoning_effort ? { reasoning_effort: confirmed.reasoning_effort } : {}),
    });
    if (!current()) return false;
    const gated = new Proxy(commands, { get(target, property) {
      if (property === 'isEffective') return current;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await createSession(args.text.trim() || tr('附件与上下文'), { ...confirmed, goal: prepared.goal },
      { ...(!remote && identity.scope.workspaceRoot ? { root: identity.scope.workspaceRoot } : {}), prepared_token: prepared.token }, id => {
        // Keep the composer pending until run admission settles; a second Enter cannot create again.
        admission.sessionId = id;
      }, gated);
    if (admission.sessionId) {
      admission.phase = 'created';
      if (!result.ok) admission.error = result.error;
      if (current()) {
        onAccepted?.();
        if (admission.error) args.onRunError?.(admission.error);
        onSessionPromoted(admission.sessionId);
      }
      return true;
    }
    if (!result.ok) {
      if (result.outcomeUnknown) { admission.phase = 'unconfirmed'; admission.commandId = result.commandId; throw new DeliveryUnconfirmedError(); }
      throw new Error(result.error);
    }
    throw new DeliveryUnconfirmedError();
  } catch (error) {
    if (error instanceof DeliveryUnconfirmedError && !admission.sessionId) admission.phase = 'unconfirmed';
    throw error;
  } finally {
    if (admission.phase === 'pending' && !admission.sessionId) draftAdmissions.delete(key);
    publishDraftAdmission(key);
  }
}

export async function stopSecondaryPane(sessionId: string, activeTurnId: string | null, enabled: boolean, commands: SessionCommandClient): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!enabled || !commands.isEffective() || !isPaneSessionId(sessionId)) return { ok: false, error: '' };
  const turnId = activeTurnId && activeTurnId.trim() ? activeTurnId : null;
  const result = await stopSession(sessionId, turnId, commands);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export function restorePaneWithdrawalDraft(existing: ComposerDraftState, withdrawal: QueueWithdrawal): ComposerDraftState {
  const recoverableDrafts = [...(existing.recoverableDrafts ?? [])];
  const previous = composerDraftContent(existing);
  if (hasComposerDraftContent(previous)) recoverableDrafts.push(previous);
  return { ...existing, ...replacementComposerDraftIdentity(withdrawal.hasContext),
    text: withdrawal.text, editorState: editorStateForPlainText(withdrawal.text) ?? undefined,
    attachments: [], selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, selectedCapabilities: [], goal: false,
    recoverableDrafts, revision: existing.revision + 1, submissionError: '',
    attachmentError: withdrawal.hasContext ? tr('原附件或上下文不会恢复，请重新添加。') : '' };
}
