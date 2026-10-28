import { DisconnectedRemoteStop } from './DisconnectedRemoteStop';
import { usePaneForkActions } from './paneForkActions';
import type { AttachmentPreviewTransport } from './composerAttachmentPreviewModel';
import { createRemoteMessageEditAttachmentTransport } from '../remote/remoteWorkflowTransport';
import { usePaneHistoryActions } from './paneHistoryActions';
import React, { useCallback, useMemo, useState, useSyncExternalStore, useRef, useEffect } from 'react';
import { t as tr } from '../../i18n';
import { parseConversationSnapshot, loadSession, createSessionCommandClient, type WorkbenchSession, type ConversationSnapshot } from '../../xuenessWorkbench';
import { conversationCompactionBoundary } from './conversationCompaction';
import { useConversationTransport } from './conversationTransport';
import { ConversationTimelineViewport } from './ConversationTimelineViewport';
import { projectSnapshotTimelineRows } from './paneConversation';
import { SecondaryPaneComposer, PaneComposer, type PaneComposerProps } from './secondaryPaneComposer';
import { paneBindingKey, paneSubscriberId, type PaneIdentity } from './paneIdentity';
import type { PaneRunOptions } from './paneRunOptions';
import { getRunChoices, setRunChoices, type RunChoices } from '../../xuenessBridge';
import { ZCodeConversation } from './ZCodeConversation';
import { createRemoteWorkflowTransport } from '../remote/remoteWorkflowTransport';
import { RequestTiming } from '../providers/LocalRuntimeMonitor';
import { createPaneCommandCoordinator, createPaneFollowupOperationGate } from './paneCommandCoordinator';
import { PaneSessionControls } from './PaneSessionControls';
import type { QueueWithdrawal } from './queueApi';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';

const noRemoteSubscription = () => () => undefined;
const remoteUnavailable = () => false;

/** Secondary conversation plus its own composer. The transport subscriber is independent of the primary pane. */
export function SecondaryConversationPane({ sessionId, subscriberId, enabled, filesEffective, effectivePluginIds, workspaceRoot = '', sendShortcut = 'enter', shortcutBindings = {}, identity, choices, onChoicesChange, onConfigureModels, draftAlias, onCreateSession, onSessionPromoted, allowDraftCreation, remoteAdapter, safetyStopEnabled = false, onForkSession }: {
  sessionId: string;
  subscriberId: string;
  enabled: boolean;
  filesEffective: boolean;
  effectivePluginIds?: ReadonlySet<string>;
  workspaceRoot?: string;
  sendShortcut?: 'enter' | 'mod-enter';
  shortcutBindings?: Record<string, string>;
  identity?: PaneIdentity;
  choices?: PaneRunOptions;
  onChoicesChange?: (choices: RunChoices) => void;
  onConfigureModels?: () => void;
  draftAlias?: PaneComposerProps['draftAlias'];
  allowDraftCreation?: boolean;
  onCreateSession?: PaneComposerProps['onCreateSession'];
  onSessionPromoted?: PaneComposerProps['onSessionPromoted'];
  remoteAdapter?: RemoteSessionAdapter | null;
  safetyStopEnabled?: boolean;
  onForkSession?: (id: string) => void;
}) {
  const controlIdentity: PaneIdentity = identity ?? { groupId: 'legacy', paneId: 'secondary', bindingRevision: 0, scope: { workspaceRoot }, sessionId };
  const remote = !!identity?.scope.remoteConnectionId;
  const adapter = remote ? remoteAdapter : undefined;
  const remoteCurrent = useSyncExternalStore(adapter?.subscribe ?? noRemoteSubscription, adapter?.isCurrent ?? remoteUnavailable, adapter?.isCurrent ?? remoteUnavailable);
  const unsupportedRemote = remote && !remoteCurrent;
  enabled = enabled && !unsupportedRemote;
  const bindingKey = JSON.stringify([identity ? paneBindingKey(identity) : [sessionId, subscriberId, workspaceRoot], adapter?.runtimeKey ?? null]);
  const liveBinding = useRef({ key: bindingKey, enabled, generation: 0 });
  if (liveBinding.current.key !== bindingKey || liveBinding.current.enabled !== enabled) liveBinding.current = {
    key: bindingKey, enabled, generation: liveBinding.current.generation + 1 };
  const bindingGeneration = liveBinding.current.generation;
  const isCurrent = useCallback(() => liveBinding.current.key === bindingKey && liveBinding.current.generation === bindingGeneration && liveBinding.current.enabled && (!remote || !!adapter?.isCurrent()), [bindingKey, bindingGeneration, remote, adapter]);
  const commandOwner = useMemo(() => ({ generation: 0, client: createPaneCommandCoordinator(remote
    ? adapter?.createCommands(isCurrent) ?? createSessionCommandClient(() => false)
    : createSessionCommandClient(isCurrent), JSON.stringify([
      remote ? ['remote', adapter?.owner.connectionId, adapter?.owner.digest, adapter?.owner.workspaceIdentity] : ['local', workspaceRoot],
      identity?.sessionId ?? (identity ? ['draft', identity.groupId, identity.paneId] : sessionId),
    ]), identity ? identity.sessionId : sessionId) }), [remote, adapter, isCurrent, workspaceRoot, identity?.sessionId, identity?.groupId, identity?.paneId, sessionId]);
  const sharedCommands = commandOwner.client;
  const operationGate = useMemo(()=>createPaneFollowupOperationGate(sharedCommands,isCurrent),[isCurrent,sharedCommands]);
  useEffect(() => { const generation = ++commandOwner.generation; return () => {
    queueMicrotask(() => { if (commandOwner.generation === generation) sharedCommands.dispose(); });
  }; }, [commandOwner, sharedCommands]);
  useEffect(() => { liveBinding.current = { key: bindingKey, enabled, generation: bindingGeneration }; return () => {
    if (liveBinding.current.key === bindingKey) liveBinding.current.enabled = false;
  }; }, [bindingKey, bindingGeneration, enabled]);
  const workflow = useMemo(() => adapter ? createRemoteWorkflowTransport(adapter, isCurrent) : undefined, [adapter, isCurrent]);
  const latestSnapshot = useRef<{ key: string; snapshot: ConversationSnapshot } | null>(null);
  const [restoredWithdrawal, setRestoredWithdrawal] = useState<{ key: string; value: QueueWithdrawal } | null>(null);
  const [projection, setProjection] = useState<{ key: string; snapshot: ConversationSnapshot | null; invalid: boolean } | null>(null);
  const snapshot = projection?.key === bindingKey ? projection.snapshot : null;
  const invalid = projection?.key === bindingKey && projection.invalid;
  const runtimeSessionId = identity ? identity.sessionId : sessionId;
  const runtimeSubscriber = identity ? paneSubscriberId(identity) : subscriberId;
  const accept = useCallback((raw: unknown) => {
    if (!isCurrent()) return;
    try {
      const snapshot = parseConversationSnapshot(sessionId, raw);
      latestSnapshot.current = { key: bindingKey, snapshot };
      setProjection({ key: bindingKey, snapshot, invalid: false });
    } catch { setProjection({ key: bindingKey, snapshot: null, invalid: true }); }
  }, [sessionId, bindingKey, isCurrent]);
  const transport = useConversationTransport(runtimeSessionId, enabled, accept, { subscriberId: runtimeSubscriber, retryOnError: true,
    request: adapter?.conversationRequest, runtimeKey: adapter?.runtimeKey, isEnabled: adapter?.isCurrent });
  const readSession = useCallback(async (): Promise<WorkbenchSession | null> => {
    const current = () => liveBinding.current.key === bindingKey && liveBinding.current.generation === bindingGeneration && liveBinding.current.enabled && (!remote || !!adapter?.isCurrent());
    if (!current() || !runtimeSessionId) return null;
    // A swallowed stream-refresh failure must never certify that the old worker stopped.
    if (remote) {
      const value = await adapter!.request('session/read', { sessionId: runtimeSessionId }, undefined, current);
      if (!current() || !value || typeof value !== 'object') return null;
      const record = value as WorkbenchSession;
      return record.id === runtimeSessionId && typeof record.status === 'string' ? record : null;
    }
    const result = await loadSession(runtimeSessionId);
    return current() && result.ok && result.value.id === runtimeSessionId ? result.value : null;
  }, [remote, adapter, bindingKey, bindingGeneration, runtimeSessionId]);
  const paneFilesEffective = filesEffective && !remote;
  const rows = useMemo(() => snapshot ? projectSnapshotTimelineRows(snapshot, paneFilesEffective) : [], [snapshot, paneFilesEffective]);
  const marker = useMemo(() => snapshot ? conversationCompactionBoundary(rows, snapshot.session.compactions) : null, [rows, snapshot]);
  // Those cards still own local endpoint loaders; never give them a remote session ID.
  const plugins = remote ? new Set([...(effectivePluginIds ?? ['sessions'])].filter(id => id !== 'files' && id !== 'subagents'))
    : effectivePluginIds ?? new Set(filesEffective ? ['files', 'sessions'] : ['sessions']);
  const session = snapshot?.session;
  const editTransport = useMemo(() => adapter ? createRemoteMessageEditAttachmentTransport(adapter, isCurrent) : undefined, [adapter, isCurrent]);
  const editPreviewTransport = useMemo<AttachmentPreviewTransport | undefined>(() => adapter ? (ref, signal, chunkIndex) => adapter.historyMedia.preview(sessionId, ref, signal, chunkIndex) : undefined, [adapter, sessionId]);
  const history = usePaneHistoryActions({ commands: sharedCommands, operationGate, bindingKey, session, enabled, remote, remoteAdapter: adapter, choices, onChoicesChange, onRefresh: transport.refresh });
  const fork = usePaneForkActions({ commands: sharedCommands, operationGate, bindingKey, session, enabled, remote, remoteAdapter: adapter, onForkSession });
  const running = session?.status === 'running' || session?.streaming?.status === 'streaming';
  return <div className="xn-pane-conversation" data-testid="xn-pane-secondary-conversation" data-subscriber={runtimeSubscriber} data-connected={transport.connected ? 'true' : 'false'}>
    {unsupportedRemote && <p role="status">{tr('远程分屏连接尚未就绪')}</p>}
    {unsupportedRemote && adapter && identity && session && <DisconnectedRemoteStop identity={identity} adapter={adapter} session={session}
      enabled={safetyStopEnabled && !!effectivePluginIds?.has('sessions') && !!effectivePluginIds?.has('remote')} />}
    {invalid && <p role="alert">{tr('分屏会话投影无效')}</p>}
    {enabled && runtimeSessionId && !transport.connected && <p role="status" className="xn-pane-secondary-status" data-testid="xn-pane-secondary-connection">{tr('正在连接分屏会话…')}</p>}
    <ConversationTimelineViewport sessionId={sessionId} autoScroll rowsVersion={rows} streamingText={session?.streaming?.text}>
      {snapshot && <ZCodeConversation sessionId={remote ? undefined : sessionId} rows={rows} compactionMarker={marker} timelineMarkers={session?.timeline_markers} collapseTools showReasoning
        messageEditTransport={editTransport} messageEditSessionId={remote ? sessionId : undefined}
        messageEditPreviewTransport={editPreviewTransport}
        autoScroll streamingPending={running || session?.compacting} onFork={fork.onFork} onEdit={history.onEdit} onRetry={history.onRetry} isSessionsEffective={history.isEffective}
        workActivity={session?.work_segments} toolActivity={session?.tool_activity} currentStreamId={session?.streaming?.id}
        currentTurnId={typeof session?.active_turn_id === 'string' ? session.active_turn_id : undefined}
        activityPhase={session?.compacting ? 'compacting' : session?.runtime_activity?.phase} effectivePluginIds={plugins} />}
    </ConversationTimelineViewport>
    {history.controls}
    {fork.dialog}
    {session && !remote && effectivePluginIds?.has('providers') && <RequestTiming session={session} />}
    {session && <PaneSessionControls operationGate={operationGate} sharedCommands={sharedCommands} key={bindingKey} identity={controlIdentity} session={session}
      enabled={enabled} choices={choices ?? getRunChoices()} onChoicesChange={onChoicesChange ?? setRunChoices} remoteAdapter={adapter}
      questionTransport={workflow?.question} withdrawalTransport={workflow?.withdrawal} guidanceTransport={workflow?.guidance}
      onRefresh={transport.refresh} readSession={readSession} onRestoreWithdrawal={value => setRestoredWithdrawal({ key: bindingKey, value })} />}
    {identity && choices && onChoicesChange ? <PaneComposer operationGate={operationGate} sharedCommands={sharedCommands} identity={identity} choices={choices} onChoicesChange={onChoicesChange} onConfigureModels={onConfigureModels}
      restoreWithdrawal={restoredWithdrawal?.key === bindingKey ? restoredWithdrawal.value : undefined}
      draftAlias={draftAlias} allowDraftCreation={allowDraftCreation} onCreateSession={onCreateSession} onSessionPromoted={onSessionPromoted}
      enabled={enabled} guidanceTransport={workflow?.guidance} readSession={readSession} remoteAdapter={adapter} onRemoteReceiptChecked={() => { void transport.refresh(); }} attachmentsEnabled={filesEffective} effectivePluginIds={effectivePluginIds} running={running} stopping={session?.status === 'stopping'}
      activeTurnId={typeof session?.active_turn_id === 'string' ? session.active_turn_id : null}
      activeRunCommandId={session?.active_run_command_id}
      permissionMode={session?.permission_mode} sendShortcut={sendShortcut} shortcutBindings={shortcutBindings}
      sendDisabled={runtimeSessionId !== null && !session} sendDisabledReason={session ? undefined : tr('正在连接分屏会话…')} />
      : <SecondaryPaneComposer onConfigureModels={onConfigureModels} restoreWithdrawal={restoredWithdrawal?.key === bindingKey ? restoredWithdrawal.value : undefined}
      guidanceTransport={workflow?.guidance} readSession={readSession} operationGate={operationGate} sharedCommands={sharedCommands} sessionId={sessionId} workspaceRoot={workspaceRoot} enabled={enabled} attachmentsEnabled={filesEffective} effectivePluginIds={effectivePluginIds}
      running={running} stopping={session?.status === 'stopping'}
      activeTurnId={typeof session?.active_turn_id === 'string' ? session.active_turn_id : null}
      activeRunCommandId={session?.active_run_command_id}
      permissionMode={session?.permission_mode} sendShortcut={sendShortcut} shortcutBindings={shortcutBindings}
      sendDisabled={!session} sendDisabledReason={session ? undefined : tr('正在连接分屏会话…')} />}
  </div>;
}

export function ConversationPane(props: Omit<React.ComponentProps<typeof SecondaryConversationPane>, 'sessionId' | 'subscriberId' | 'workspaceRoot' | 'identity' | 'choices' | 'onChoicesChange'> & {
  identity: PaneIdentity; choices: PaneRunOptions; onChoicesChange: (choices: RunChoices) => void;
}) {
  return <SecondaryConversationPane {...props} sessionId={props.identity.sessionId ?? ''}
    subscriberId={paneSubscriberId(props.identity)} workspaceRoot={props.identity.scope.workspaceRoot} />;
}
