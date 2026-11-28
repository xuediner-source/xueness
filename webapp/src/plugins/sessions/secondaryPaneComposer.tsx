// Secondary-pane composer for sessions.pane_layout.
// This module loads with the secondary conversation chunk. Drafts use
// pane-secondary: so they stay apart from the primary session: draft.
// Send, queue and stop go through command_ack, and only while sessions is effective.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t as tr } from '../../i18n';
import { getRunChoices, setRunChoices, type RunChoices } from '../../xuenessBridge';
import { prepareComposer } from '../../xuenessComposer';
import { createSessionCommandClient, type WorkbenchSession } from '../../xuenessWorkbench';
import { panePendingCommands } from './paneCommandCoordinator';
import { type SessionCommandClient } from './commandClient';
import { Composer } from './XuenessWorkbenchView';
import { readPersistedDraft, restoredDraft, persistDraft } from './composerDraftStore';
import { type ComposerDraftState } from './composerTypes';
import { paneBindingKey, paneComposerKey, paneDraftAddress, readPaneDraft, paneDraftAliasAdopted, markPaneDraftAliasAdopted, type PaneIdentity } from './paneIdentity';
import type { PaneDraftAlias } from './paneTree';
import { subscribeComposerDrafts, hasComposerDraftContent, notifyComposerDrafts } from './composerRecovery';
import { type PaneRunOptions } from './paneRunOptions';
import { isPaneSessionId } from './paneLayout';
import type { PermissionMode } from './permissionModes';
import { useRunPermissionConfirmation } from './useRunPermissionConfirmation';
import { resolveHostPlatform } from '../../xuenessShortcutDisplay';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { createLocalPaneGuidance, type PaneGuidanceTransport } from './paneWorkflowActions';
import type { QueueWithdrawal } from './queueApi';
import { validateCreateCommandResult } from './commandReceipt';
import { PaneOptionToolbar } from './PaneOptionToolbar';
import { canAdmitSessionFollowup, sessionFollowupProof } from './CommandReceiptRecovery';
import type { FollowupAdmission } from './commandLedger';
import {
  paneDraftAdmission,
  recoverPaneDraftCreation,
  remotePaneCreationReady,
  restorePaneWithdrawalDraft,
  retirePromotedDraftAdmissions,
  secondaryComposerDraftKey,
  stopSecondaryPane,
  submitPaneDraftTurn,
  submitSecondaryPaneTurn,
  subscribeDraftAdmission,
  type DraftStore,
} from './secondaryPaneComposerModel';

export {
  paneDraftAdmission,
  recoverPaneDraftCreation,
  remotePaneCreationReady,
  restorePaneWithdrawalDraft,
  secondaryComposerDraftKey,
  stopSecondaryPane,
  submitPaneDraftTurn,
  submitSecondaryPaneTurn,
  type SecondaryPaneSubmitArgs,
} from './secondaryPaneComposerModel';

const noRemoteSubscription = () => () => undefined;
const remoteUnavailable = () => false;

export type PaneComposerProps = {
  operationGate?: { acquire: (followup?: FollowupAdmission) => (() => void) | null };
  sharedCommands?: SessionCommandClient;
  effectivePluginIds?: ReadonlySet<string>;
  identity: PaneIdentity;
  choices: PaneRunOptions;
  onChoicesChange: (choices: RunChoices) => void;
  onConfigureModels?: () => void;
  draftAlias?: PaneDraftAlias;
  enabled: boolean;
  running?: boolean;
  stopping?: boolean;
  activeTurnId?: string | null;
  activeRunCommandId?: string | null;
  permissionMode?: PermissionMode;
  sendShortcut?: 'enter' | 'mod-enter';
  shortcutBindings?: Record<string, string>;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  /** Creation belongs to the host. A successful promotion retains the draft for sending. */
  attachmentsEnabled?: boolean;
  allowDraftCreation?: boolean;
  onCreateSession?: (identity: PaneIdentity, choices: RunChoices) => Promise<string | null>;
  onSessionPromoted?: (sessionId: string) => void;
  /** Compatibility wrapper only; new panes use their stable per-leaf address. */
  legacyDraftAddress?: PaneDraftAlias;
  /** A remote binding never uses the default local command or prepare routes. */
  remoteAdapter?: RemoteSessionAdapter | null;
  onRemoteReceiptChecked?: () => void;
  restoreWithdrawal?: QueueWithdrawal;
  guidanceTransport?: PaneGuidanceTransport;
  readSession?: () => Promise<WorkbenchSession | null>;
};

export function PaneComposer({ operationGate, sharedCommands, identity, choices, onChoicesChange, onConfigureModels, effectivePluginIds, draftAlias, enabled, running = false, stopping = false,
  activeTurnId = null, activeRunCommandId = null, permissionMode, sendShortcut = 'enter', shortcutBindings = {}, sendDisabled = false,
  sendDisabledReason, attachmentsEnabled = true, allowDraftCreation = true, onCreateSession, onSessionPromoted, legacyDraftAddress, remoteAdapter, onRemoteReceiptChecked, restoreWithdrawal, guidanceTransport, readSession }: PaneComposerProps) {
  const { sessionId, scope: { workspaceRoot } } = identity;
  const remote = !!identity.scope.remoteConnectionId;
  const adapter = remote ? remoteAdapter : undefined;
  const remoteCurrent = useSyncExternalStore(adapter?.subscribe ?? noRemoteSubscription, adapter?.isCurrent ?? remoteUnavailable, adapter?.isCurrent ?? remoteUnavailable);
  enabled = enabled && (!remote || remoteCurrent);
  const bindingKey = paneBindingKey(identity);
  const runtimeBindingKey = JSON.stringify([bindingKey, adapter?.runtimeKey ?? null]);
  const live = useRef({ bindingKey: runtimeBindingKey, enabled, generation: 0 });
  const generation = live.current.generation + (live.current.bindingKey !== runtimeBindingKey || live.current.enabled !== enabled ? 1 : 0);
  live.current = { bindingKey: runtimeBindingKey, enabled, generation };
  const isCurrent = () => live.current.enabled && live.current.generation === generation && live.current.bindingKey === runtimeBindingKey && (!remote || !!adapter?.isCurrent());
  const runningSnapshot = {id:sessionId??'',status:running?'running':'idle',active_turn_id:activeTurnId,active_run_command_id:activeRunCommandId};
  const latestRunning = useRef(runningSnapshot); latestRunning.current=runningSnapshot;
  const followupProof = sessionFollowupProof(runningSnapshot);
  const followupCurrent = () => isCurrent() && latestRunning.current.status==='running'
    && latestRunning.current.id===sessionId && !!activeTurnId && latestRunning.current.active_turn_id===activeTurnId
    && (!followupProof||latestRunning.current.active_run_command_id===followupProof.runCommandId);
  const clientRef = useRef<SessionCommandClient | null>(null);
  const [stopError, setStopError] = useState('');
  const [runError, setRunError] = useState<{ sessionId: string; message: string } | null>(null);
  const [receiptStatus, setReceiptStatus] = useState('');
  const [checkingReceipt, setCheckingReceipt] = useState(false);
  const [, updateAdmission] = useState(0);
  const guidance = remote ? guidanceTransport : createLocalPaneGuidance(()=>isCurrent()
    && (!running || (!!sessionId && canAdmitSessionFollowup(sharedCommands??clientRef.current!,sessionId,followupProof,followupCurrent))));
  const admission = sessionId === null ? paneDraftAdmission(identity) : undefined;
  const pendingRemote = adapter?.pendingCommands().filter(command => command.sessionId === sessionId) ?? [];
  const receiptClient = sharedCommands ?? clientRef.current;
  const pendingLocal = receiptClient ? panePendingCommands(receiptClient).filter(command => command.sessionId === sessionId) : [];
  const pendingReceipts = [...new Map([...pendingRemote, ...pendingLocal].map(command => [command.commandId, command])).values()];
  const draftCreationAllowed = allowDraftCreation && (!remote || remotePaneCreationReady(identity, adapter));
  useEffect(() => {
    const update = () => {
      if (sessionId !== null) {
        // A persisted promoted binding owns this session now. Only then can its creation lock retire.
        const promotedError = retirePromotedDraftAdmissions(sessionId, paneComposerKey(identity));
        if (promotedError) setRunError({ sessionId, message: promotedError });
      }
      updateAdmission(value => value + 1);
      const settled = paneDraftAdmission(identity);
      if (sessionId === null && isCurrent() && settled?.phase === 'created' && settled.sessionId) {
        if (settled.error) setRunError({ sessionId: settled.sessionId, message: settled.error });
        onSessionPromoted?.(settled.sessionId);
      }
    };
    update();
    return subscribeDraftAdmission(bindingKey, update);
  }, [bindingKey, enabled, onSessionPromoted]);
  const permission = useRunPermissionConfirmation(runtimeBindingKey, enabled);
  // A remount during creation shares the original pending draft and its ACK release notifications.
  const retainedDraftStore = useRef<DraftStore>(paneDraftAdmission(identity)?.draftStore ?? { current: new Map<string, ComposerDraftState>() });
  const draftStore = retainedDraftStore.current;
  const address = legacyDraftAddress ?? paneDraftAddress(identity);
  const scopedDraftKey = `${address.workspaceKey}:${address.draftKey}`;
  if (!draftStore.current.has(scopedDraftKey)) {
    const persisted = legacyDraftAddress ? readPersistedDraft(address.workspaceKey, address.draftKey)
      : readPaneDraft(identity, readPersistedDraft, draftAlias, paneDraftAliasAdopted(identity));
    if (persisted) draftStore.current.set(scopedDraftKey, restoredDraft(persisted));
  }
  const restoredWithdrawalIds = useRef(new Set<string>());
  useEffect(() => {
    if (!restoreWithdrawal || !isCurrent() || restoreWithdrawal.sessionId !== sessionId
      || restoredWithdrawalIds.current.has(restoreWithdrawal.id)) return;
    const existing = draftStore.current.get(scopedDraftKey) ?? { text: '', attachments: [], goal: false, selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 0 };
    const next = restorePaneWithdrawalDraft(existing, restoreWithdrawal);
    draftStore.current.set(scopedDraftKey, next);
    persistDraft(address.workspaceKey, address.draftKey, next);
    restoredWithdrawalIds.current.add(restoreWithdrawal.id);
    notifyComposerDrafts(draftStore);
  }, [restoreWithdrawal, runtimeBindingKey, scopedDraftKey]);
  useEffect(() => subscribeComposerDrafts(draftStore, () => {
    if (!draftAlias || legacyDraftAddress) return;
    const currentDraft = draftStore.current.get(scopedDraftKey);
    // The composer persists before notifying. Do not retire the alias on a failed nonempty write.
    if (currentDraft && ((!hasComposerDraftContent(currentDraft) && !currentDraft.pendingSubmission && !currentDraft.recoverableDrafts?.length && !currentDraft.deliveryUnconfirmed) || readPersistedDraft(address.workspaceKey, address.draftKey))) {
      markPaneDraftAliasAdopted(identity);
    }
  }), [scopedDraftKey, draftAlias, legacyDraftAddress, bindingKey]);
  useEffect(() => {
    setStopError('');
    setCheckingReceipt(false); setReceiptStatus('');
    if (!enabled) return;
    const client = sharedCommands ?? (remote ? adapter!.createCommands(isCurrent) : createSessionCommandClient(isCurrent));
    clientRef.current = client;
    return () => {
      if (!sharedCommands) client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [enabled, runtimeBindingKey, generation, adapter, sharedCommands]);
  useEffect(() => { live.current.enabled = enabled; return () => { if (live.current.generation === generation) live.current.enabled = false; }; }, [enabled, generation]);
  if (!enabled || (sessionId !== null && !isPaneSessionId(sessionId))) return null;
  return <div className="xn-pane-secondary-composer" data-testid="xn-pane-secondary-composer" data-session={sessionId ?? ''}
    data-pane-id={identity.paneId} data-draft-key={address.draftKey} role="region" aria-label={tr('分屏输入')}>
    {permission.dialog}
    {receiptClient?.recoveryStorageError() && <p role="alert">{receiptClient.recoveryStorageError()}</p>}
    {receiptClient?.recoveryStorageWarning() && <p role="status">{receiptClient.recoveryStorageWarning()}</p>}
    <PaneOptionToolbar key={runtimeBindingKey} enabled={enabled} effectivePluginIds={effectivePluginIds}
      remote={remote} remoteCommands={adapter?.owner.capabilities.durableCommands === true}
      remoteLoad={remote && adapter?.owner.capabilities.modelCatalog === true ? adapter.loadOptionCatalog : undefined} root={workspaceRoot} sessionId={sessionId}
      choices={choices} onChange={onChoicesChange} onConfigureModels={onConfigureModels} isCurrent={isCurrent} ensurePermission={permission.ensure} />
    {runError?.sessionId === sessionId && <p className="xn-pane-secondary-composer__error" role="alert">{runError.message}</p>}
    {stopError && <p className="xn-pane-secondary-composer__error" role="alert">{stopError}</p>}
    {(admission?.commandId || pendingReceipts.length > 0) && <button type="button" disabled={checkingReceipt || !isCurrent()}
      onClick={() => {
        const commands = clientRef.current;
        if (!commands || !isCurrent() || checkingReceipt) return;
        setCheckingReceipt(true); setReceiptStatus('');
        void (async () => {
          let confirmed = false;
          if (sessionId === null && admission?.commandId && onSessionPromoted) {
            confirmed = await recoverPaneDraftCreation(identity, adapter, commands, onSessionPromoted, isCurrent);
          } else {
            for (const command of pendingReceipts) {
              if (!isCurrent()) return;
              if (command.sessionId === null) {
                const ack = await commands.queryCreate(command.commandId);
                if (isCurrent() && sessionId === null && onSessionPromoted && ack !== 'unknown') {
                  const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
                  if (status === 'accepted' || status === 'noop') onSessionPromoted(validateCreateCommandResult(ack.result, command.commandId));
                }
              } else await commands.query(command.sessionId, command.commandId);
            }
            confirmed = !panePendingCommands(commands).some(command => command.sessionId === sessionId)
              && !(adapter?.pendingCommands().some(command => command.sessionId === sessionId));
          }
          if (isCurrent()) {
            setReceiptStatus(tr(confirmed ? '命令结果已确认，请检查最新会话状态。' : '命令结果仍未确认，草稿已保留。'));
            onRemoteReceiptChecked?.();
          }
        })().catch(error => { if (isCurrent()) setReceiptStatus(error instanceof Error ? error.message : String(error)); })
          .finally(() => { if (isCurrent()) { setCheckingReceipt(false); updateAdmission(value => value + 1); } });
      }}>{tr('检查命令结果')}</button>}
    {sessionId && guidance?.reconcile && <button type="button" disabled={checkingReceipt} onClick={() => {
      if (!isCurrent() || checkingReceipt) return;
      setCheckingReceipt(true);
      void guidance.reconcile!(sessionId).then(result => {
        if (!isCurrent()) return;
        setReceiptStatus(tr(result.result === 'none' ? '没有待确认的后续输入。' : result.result === 'unknown' ? '命令结果仍未确认，草稿已保留。' : '命令结果已确认，请检查最新会话状态。'));
        onRemoteReceiptChecked?.();
      }).catch(error => { if (isCurrent()) setReceiptStatus(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (isCurrent()) setCheckingReceipt(false); });
    }}>{tr('检查后续输入结果')}</button>}
    {receiptStatus && <p role="status">{receiptStatus}</p>}
    <Composer
      key={paneComposerKey(identity)}
      draftKey={address.draftKey}
      workspaceKey={address.workspaceKey}
      draftStore={draftStore}
      richComposer
      attachmentGeneration={runtimeBindingKey}
      attachmentsEnabled={enabled && attachmentsEnabled && (!remote || !!adapter?.mediaReady)}
      attachmentSessionId={sessionId ?? undefined}
      attachmentRoot={remote ? adapter?.owner.workspaceIdentity ?? undefined : workspaceRoot || undefined}
      attachmentRemoteOwner={remote ? adapter?.mediaOwner : undefined}
      attachmentTransport={remote ? adapter?.mediaTransport : undefined}
      variant="docked"
      platform={resolveHostPlatform()}
      sendShortcut={sendShortcut}
      shortcutBindings={shortcutBindings}
      running={running}
      queueWhenRunning
      guideWhenRunning={!!activeTurnId && (!remote || !!guidanceTransport)}
      stopping={stopping}
      sendDisabled={sendDisabled || (pendingReceipts.length > 0 && !(sessionId && running && receiptClient
        && canAdmitSessionFollowup(receiptClient,sessionId,followupProof,followupCurrent))) || admission?.phase === 'pending' || admission?.phase === 'unconfirmed'
        || (sessionId === null && (remote ? !(draftCreationAllowed && onSessionPromoted) : !onCreateSession && !(draftCreationAllowed && onSessionPromoted)))}
      sendDisabledReason={remote && sessionId === null && !draftCreationAllowed ? tr('此远程连接尚不支持创建会话。') : sendDisabledReason}
      placeholder={tr('在分屏会话中继续')}
      onStop={() => {
        const commands = clientRef.current;
        if (!commands || !sessionId || !isCurrent()) return;
        setStopError('');
        void stopSecondaryPane(sessionId, activeTurnId, true, commands).then(result => {
          if (isCurrent() && !result.ok && result.error) setStopError(result.error);
        }).finally(() => { if (isCurrent()) updateAdmission(value => value + 1); });
      }}
      onSend={async (text, input, onAccepted, delivery) => {
        const commands = clientRef.current;
        if (!isCurrent() || !commands || !commands.isEffective() || sendDisabled) return false;
        const release = operationGate?.acquire(running&&followupProof ? {proof:followupProof,current:followupCurrent} : undefined);
        if (operationGate && !release) return false;
        try {
          // Persisted local attachment refs are not portable to another backend.
          if (remote && (input?.attachments.length || (input?.attachmentRefs?.length && !adapter?.mediaReady))) return false;
          if (sessionId === null) {
            if (draftCreationAllowed && onSessionPromoted) return await submitPaneDraftTurn({
              identity, text, input, enabled: true, workspaceRoot, permissionMode, choices: { ...choices, acknowledge_yolo: false },
              commands, prepare: prepareComposer, remoteAdapter: adapter, ensurePermission: permission.ensure, isCurrent, onAccepted, draftStore,
              onChoicesChange: value => { if (isCurrent()) onChoicesChange(value); }, onSessionPromoted,
              onRunError: message => { const created = paneDraftAdmission(identity)?.sessionId; if (isCurrent() && created) setRunError({ sessionId: created, message }); },
            });
            if (remote) return false;
            if (!onCreateSession) return false;
            const confirmed = await permission.ensure({ ...choices, acknowledge_yolo: false }, permissionMode);
            if (!confirmed || !isCurrent()) return false;
            const created = await onCreateSession(identity, confirmed);
            if (created && isCurrent() && isPaneSessionId(created)) onSessionPromoted?.(created);
            return false;
          }
          return await submitSecondaryPaneTurn({
            sessionId, text, input, enabled: true, running, workspaceRoot, permissionMode,
            delivery, activeTurnId, guidance, readSession, followupProof, followupCurrent,
            onPostAdmissionError: message => { if (isCurrent()) setRunError({ sessionId, message }); },
            choices: { ...choices, acknowledge_yolo: false }, commands, prepare: remote ? adapter!.prepare : prepareComposer, ensurePermission: permission.ensure, onAccepted,
            isCurrent, onChoicesChange: value => { if (isCurrent()) onChoicesChange(value); },
          });
        } finally { release?.(); if (isCurrent()) updateAdmission(value => value + 1); }
      }}
    />
  </div>;
}

/** Legacy two-pane callers retain their old address and bridge choices. */
export function SecondaryPaneComposer(props: Omit<PaneComposerProps, 'identity' | 'choices' | 'onChoicesChange'> & {
  sessionId: string; workspaceRoot: string;
}) {
  return <PaneComposer {...props}
    identity={{ groupId: 'legacy', paneId: 'secondary', bindingRevision: 0, scope: { workspaceRoot: props.workspaceRoot }, sessionId: props.sessionId }}
    choices={getRunChoices()} onChoicesChange={setRunChoices}
    legacyDraftAddress={{ workspaceKey: props.workspaceRoot || 'secondary', draftKey: secondaryComposerDraftKey(props.sessionId) }} />;
}
