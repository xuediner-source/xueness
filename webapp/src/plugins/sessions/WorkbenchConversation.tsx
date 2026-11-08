/**
 * The primary pane's two bodies: the active conversation (plugin notices,
 * approvals, questions, timeline, queue dock, composer and context pane) and
 * the start page (greeting, start actions and the docked new-task composer).
 * The workbench container supplies the state; these views only arrange it.
 * Moved unchanged out of XuenessWorkbenchContainer.
 */
import React, { lazy, Suspense } from "react";
import { CircleHelp, Monitor } from "lucide-react";
import { t as tr, tf, type useLocale } from "../../i18n";
import type { RunChoices } from "../../xuenessBridge";
import type { ComposerCatalog, ComposerModel, RuntimeProfile } from "../../xuenessComposer";
import type { SessionSummary, WorkbenchSession } from "../../xuenessWorkbench";
import type { SettingsMap } from "../../xuenessSettings";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { RecentWorkspaceDirectory } from "../../xuenessWorkspaces";
import { IconXuenessMark } from "../../ui/icons";
import type { LocalRuntimeSession } from "../providers/LocalRuntimeMonitor";
import { LightweightStatusBar, extractReportedUsage } from "../providers/LightweightWorkbench";
import { ToolCallBudgetStatus } from "../tools/ToolExecutionSettings";
import type { RemoteSessionAdapter } from "../remote/remoteSessionAdapter";
import { PendingGuidancePanel } from './CurrentTurnInput';
import { Approvals } from "./Approvals";
import { Composer } from "./XuenessWorkbenchView";
import { heroGreeting } from "./WorkbenchHeader";
import type { ComposerProps } from "./composerTypes";
import type { ComposerModelRecovery } from "./composerInputHelpers";
import { XuenessStartPage, type StartPageAction } from "./XuenessStartPage";
import { SessionRecoveryNotice, showInterruptedRecovery } from './SessionRecoveryNotice';
import { SessionCommandNotice } from "./SessionCommandNotice";
import { ConversationTimelineViewport } from "./ConversationTimelineViewport";
import { TaskTodos } from "./XuenessTimeline";
import { ZCodeConversation } from "./ZCodeConversation";
import { ConversationSelectionActions, type ConversationTextSelection } from './ConversationSelectionActions';
import { CommandReceiptRecovery } from './CommandReceiptRecovery';
import type { useLivePermissionMode } from "./useLivePermissionMode";
import type { SessionActivity } from "./workbenchSessionState";
import type { WorkbenchSessionData } from "./useWorkbenchSessionData";
import type { SessionRunActions } from "./useSessionRunActions";
import type { SessionQueueActions } from "./useSessionQueueActions";

const CompletionChecks = lazy(() => import('../planning/CompletionChecks').then(module => ({ default: module.CompletionChecks })));
const StarterIdeas = lazy(() => import('./StarterIdeas').then(module => ({ default: module.StarterIdeas })));
const SessionGoal = lazy(() => import('../planning/SessionGoal').then(module => ({ default: module.SessionGoal })));
const LocalRuntimeMonitor = lazy(() => import('../providers/LocalRuntimeMonitor').then(module => ({ default: module.LocalRuntimeMonitor })));
const RequestTiming = lazy(() => import('../providers/LocalRuntimeMonitor').then(module => ({ default: module.RequestTiming })));
const SessionQueue = lazy(() => import('./SessionQueue').then(module => ({ default: module.SessionQueue })));
const QueueWithdrawalRecovery = lazy(() => import('./SessionQueue').then(module => ({ default: module.QueueWithdrawalRecovery })));
const SessionContextPane = lazy(() => import('./SessionContextPane').then(module => ({ default: module.SessionContextPane })));
const McpElicitation = lazy(() => import('../mcp/ElicitationForm').then(module => ({ default: module.McpElicitation })));
const McpAppsHost = lazy(() => import('../mcp/AppsUiHost').then(module => ({ default: module.McpAppsHost })));
const PendingQuestion = lazy(() => import('./PendingQuestion').then(module => ({ default: module.PendingQuestion })));
const QuestionResume = lazy(() => import('./PendingQuestion').then(module => ({ default: module.QuestionResume })));
const ModelMonitorHome = lazy(() => import('../model_monitor/ModelMonitorHome').then(module => ({ default: module.ModelMonitorHome })));
/** Also mounted as the workbench's subagents panel, so both share this one lazy wrapper. */
export const SubagentSidePane = lazy(() => import("../subagents/SubagentSidePane").then(module => ({ default: module.SubagentSidePane })));
const StartPageRemoteDialog = lazy(() => import('./StartPageRemoteDialog'));
const ConversationShareDialog = lazy(() => import('./ConversationSharing').then(module => ({ default: module.ConversationShareDialog })));
const GoalEditorDialog = lazy(() => import('../planning/GoalEditorDialog').then(module => ({ default: module.GoalEditorDialog })));

/** Composer props both primary composers (conversation and start page) share. */
export type WorkbenchComposerShared = Pick<ComposerProps, 'draftStore' | 'richComposer' | 'attachmentRoot' | 'inputRef' | 'platform' | 'sendShortcut'
  | 'shortcutBindings' | 'sendDisabledReason' | 'running' | 'controls' | 'startActions' | 'capabilities' | 'mentions' | 'commands' | 'files'>;

type WorkbenchConversationProps = {
  session: WorkbenchSession;
  activeId: string | null;
  isPluginEffective: (id: string) => boolean;
  effectivePluginIds: Set<string>;
  isSessionsEffective: () => boolean;
  settingsValues: SettingsMap;
  lightweightLayout: boolean;
  activeRuntimeProfile: RuntimeProfile | undefined;
  runtimeMonitorSession: LocalRuntimeSession | null;
  choices: RunChoices;
  selectedComposerModel: ComposerModel | undefined;
  activeSessionRunning: boolean;
  activity: SessionActivity;
  data: WorkbenchSessionData;
  runActions: SessionRunActions;
  queue: SessionQueueActions;
  livePermissions: ReturnType<typeof useLivePermissionMode>;
  setPanel: (panel: WorkbenchPanel) => void;
  selectSession: (id: string) => void;
  handleRefreshAll: () => Promise<void>;
  handleSelectFile: (path: string) => Promise<void>;
  beginFork: (turn?: number) => void;
  onAddSelection: (selection: ConversationTextSelection) => void;
  onAskSelection: (selection: ConversationTextSelection) => void;
  appendTextToComposer: (targetSessionId: string | null, text: string, workspaceRoot?: string) => void;
  shareDialogOpen: boolean;
  setShareDialogOpen: (open: boolean) => void;
  goalEditorOpen: boolean;
  setGoalEditorOpen: (open: boolean) => void;
  deliveryEditorRequest: { id: string; version: number } | null;
  contextSidepaneOpen: boolean;
  setContextSidepaneOpen: (open: boolean) => void;
  commandRoot: string;
  workspaceRoot: string | null | undefined;
  composer: WorkbenchComposerShared;
  composerDisabled: boolean;
  sendDisabled: boolean;
  modelRecovery: ComposerModelRecovery | undefined;
  onSend: NonNullable<ComposerProps['onSend']>;
};

/** Body of `.xn-conversation-container` for the active session. */
export function WorkbenchConversation({ session, activeId, isPluginEffective, effectivePluginIds, isSessionsEffective, settingsValues, lightweightLayout, activeRuntimeProfile,
  runtimeMonitorSession, choices, selectedComposerModel, activeSessionRunning, activity, data, runActions, queue, livePermissions, setPanel, selectSession,
  handleRefreshAll, handleSelectFile, beginFork, onAddSelection, onAskSelection, appendTextToComposer, shareDialogOpen, setShareDialogOpen, goalEditorOpen,
  setGoalEditorOpen, deliveryEditorRequest, contextSidepaneOpen, setContextSidepaneOpen, commandRoot, workspaceRoot, composer, composerDisabled, sendDisabled,
  modelRecovery, onSend }: WorkbenchConversationProps) {
  const { busy, runError, runRequestSessions, stoppingSessions, queueError, queueCancelling, queueSubmittingSessions, queueContinuingSessions } = activity;
  const { rows, olderTranscript, loadOlderTranscript, displayTimelineRows, compactionMarker, conversationFindRequest, loadActive, sessionCommands, primaryQuestionTransport } = data;
  const { handleApprove, handleApproveAll, handleReject, handleAllowProject, handleQuestionSubmitted, handleRetryTool, handleMessageEdit, handleMessageFeedback, handleRetryRun, handleStop } = runActions;
  const { queueWithdrawals, handleWithdrawGuidance, handleCancelQueuedTurn, handleWithdrawQueuedTurn, handleSendNowQueuedTurn, handleEditQueuedMessage, handleReorderQueuedMessages, handleContinueQueuedMessages } = queue;
  return <>
          <div className="xn-conversation">
          {shareDialogOpen && <Suspense fallback={null}><ConversationShareDialog key={session.id} open session={session}
            onClose={() => setShareDialogOpen(false)} /></Suspense>}
          {isPluginEffective('model_monitor') && <Suspense fallback={null}><ModelMonitorHome key={session.id} sessionId={session.id}
            providerId={choices.provider_id} requestedModel={choices.model ?? selectedComposerModel?.model} providerName={selectedComposerModel?.supplierName ?? selectedComposerModel?.name}
            running={activeSessionRunning} onOpenHistory={() => setPanel('model-monitor')} /></Suspense>}
          {goalEditorOpen && activeId && session?.id === activeId && isPluginEffective('planning') &&
            <Suspense fallback={null}><GoalEditorDialog key={`goal-editor:${activeId}`} sessionId={activeId} goal={session.goal}
              onClose={() => setGoalEditorOpen(false)} onSaved={() => void loadActive(activeId)} /></Suspense>}
          {isPluginEffective('planning') && !lightweightLayout && <Suspense fallback={null}><SessionGoal sessionId={session.id} goal={session.goal}
            disabled={busy} running={session.status === 'running'} onChanged={() => void handleRefreshAll()} /></Suspense>}
          {session.forkParent && <p className="xn-session-fork-provenance" data-testid="fork-session-provenance" role="note">
            {tf("从会话 {0} 的第 {1} 轮分叉", [session.forkParent.sourceId, session.forkParent.turn])}
            {session.forkParent.historyTruncated && <span>{tr(" · 较早的压缩归档未继承，仅保留当前可定位历史")}</span>}
            <button type="button" className="xn-session-fork-provenance__open" data-testid="fork-open-parent" disabled={busy} onClick={() => selectSession(session.forkParent!.sourceId)}>{tr("打开原会话")}</button>
          </p>}
          {session.pause_reason && ["paused", "needs_review"].includes(session.status) && <p role="status" className="xn-run-recovery">{tf("暂停原因：{0}", [session.pause_reason])}</p>}
          {isPluginEffective('planning') && <Suspense fallback={null}><CompletionChecks compact openEditorRequest={deliveryEditorRequest?.id === session.id ? deliveryEditorRequest.version : 0}
            sessionId={session.id} completion={session.completion} items={session.delivery_requirements ?? []} disabled={busy || session.status === 'running'} onSaved={() => void handleRefreshAll()}
            onOpenFile={isPluginEffective('files') ? path => { void handleSelectFile(path); setPanel('files'); } : undefined} /></Suspense>}
          {isPluginEffective('providers') && <Suspense fallback={<div className="xn-request-telemetry-placeholder" aria-hidden="true" />}><RequestTiming session={session} /></Suspense>}
          {activeRuntimeProfile === "lightweight" && isPluginEffective("providers") && isPluginEffective("diagnostics") &&
            <Suspense fallback={<p role="status">{tr("正在加载界面…")}</p>}><LocalRuntimeMonitor lightweight session={runtimeMonitorSession} /></Suspense>}
          {session.pending && session.pending.length > 0 && (
            <div className="xn-conversation__approvals">
              <Approvals pending={session.pending} onApprove={handleApprove} onApproveAll={handleApproveAll} onReject={handleReject} onAllowProject={handleAllowProject} onFullAccess={async p => { if (!await livePermissions.change("yolo", true)) return false; return p.waiting ? true : handleApprove(p); }}
                busy={busy || runRequestSessions.has(session.id)} />
            </div>
          )}
          {isPluginEffective("mcp") && <Suspense fallback={null}><McpElicitation sessionId={session.id} /></Suspense>}
          {isPluginEffective("mcp") && <Suspense fallback={null}><McpAppsHost sessionId={session.id} /></Suspense>}
          <Suspense fallback={null}><PendingQuestion transport={primaryQuestionTransport} sessionId={session.id} pendingQuestion={session.status === "awaiting_user" ? session.pending_question : null}
            enabled={isPluginEffective("sessions")}
            disabled={busy || runRequestSessions.has(session.id)} onSubmitted={handleQuestionSubmitted} /></Suspense>
          <ToolCallBudgetStatus sessionId={session.id} enabled={isPluginEffective("tools") && settingsValues.toolsCallBudgetEnabled === true} revision={session} />
          <ConversationTimelineViewport
            key={session.id}
            sessionId={session.id}
            autoScroll={settingsValues.autoScroll !== false}
            rowsVersion={rows}
            streamingText={session.streaming?.text}
            queuedMessages={session.queued_messages}
          >
            {settingsValues.showTodos !== false && !lightweightLayout && <TaskTodos todos={session.todos ?? []} />}
            {olderTranscript.sessionId === session.id && (olderTranscript.hasOlder || olderTranscript.loading || olderTranscript.error) &&
              <div className="xn-session-history-older" data-testid="conversation-load-older">
                {olderTranscript.hasOlder && <button type="button" className="xn-zc-retry-btn"
                  disabled={olderTranscript.loading} aria-busy={olderTranscript.loading}
                  onClick={() => void loadOlderTranscript()}>
                  {tr(olderTranscript.loading ? '正在加载更早的消息…' : '加载更早的消息')}
                </button>}
                {olderTranscript.error && <p role="alert">{olderTranscript.error}</p>}
              </div>}
            <ZCodeConversation sessionId={session.id} rows={displayTimelineRows} workActivity={session.work_segments}
              toolActivity={session.tool_activity} currentTurnId={session.active_turn_id ?? undefined} currentStreamId={session.streaming?.id}
              compactionMarker={compactionMarker}
              timelineMarkers={session?.id === activeId ? session.timeline_markers : undefined}
              findRequest={conversationFindRequest?.sessionId === session.id ? conversationFindRequest : undefined}
              collapseTools={settingsValues.collapseTools !== false}
              showReasoning={settingsValues.messageStreamShowReasoning !== false}
              autoScroll={settingsValues.autoScroll !== false}
              jsonToolProtocol={session.model_selection?.tool_calling === "json" && activeRuntimeProfile === "lightweight" && session.streaming?.text_format !== "markdown"}
              streamingPending={activeSessionRunning || session.compacting} activityPhase={session.compacting ? 'compacting' : session.runtime_activity?.phase}
              pendingToolIds={new Set((session.pending ?? []).map(item => item.tool_call_id))}
              effectivePluginIds={effectivePluginIds}
              isSessionsEffective={isSessionsEffective}
              onRetry={!busy && !activeSessionRunning ? handleRetryTool : undefined}
              onEdit={!busy && !activeSessionRunning ? handleMessageEdit : undefined}
              onFeedback={!busy && !activeSessionRunning ? handleMessageFeedback : undefined}
              onFork={!busy && !activeSessionRunning ? row => beginFork(/^turn-[1-9][0-9]*$/u.test(row.turnId) ? Number(row.turnId.slice(5)) : undefined) : undefined}
              renderSelectionAction={selection => <ConversationSelectionActions key={`${selection.rowKey}:${selection.text}`} selection={selection}
                sideActionDisabled={busy || activeSessionRunning} onAdd={onAddSelection} onAsk={onAskSelection} />} />
            {showInterruptedRecovery(session.status, session.streaming?.status, runError) && <SessionRecoveryNotice kind="interrupted"
              reason={tr('这次回复已中断，收到的内容已保留。')} actionLabel={tr('接着做')}
              onAction={!busy && !activeSessionRunning ? () => appendTextToComposer(session.id, tr('请接着完成刚才未完成的部分，已完成的内容无需重复。')) : undefined} />}
          </ConversationTimelineViewport>
          <Suspense fallback={null}><QuestionResume enabled={isPluginEffective("sessions")}
            resumeBudgetEnabled={isPluginEffective("sessions")} pauseCode={session.pause_code}
            status={session.status} pendingQuestion={session.pending_question} disabled={busy || runRequestSessions.has(session.id)} onResume={handleRetryRun} /></Suspense>
          {(runError || session.status === "provider_error" || (!busy && !runRequestSessions.has(session.id) && session.status === "pending" && session.streaming?.status !== 'interrupted')) && (
            <SessionRecoveryNotice kind={runError || session.status === 'provider_error' ? 'failed' : 'interrupted'}
              reason={runError || tr(session.status === 'provider_error' ? '模型连接失败，可以重试。' : '任务还没有完成，可以继续运行。')}
              actionLabel={tr('重试运行')} onAction={!busy && !runRequestSessions.has(session.id) ? () => { void handleRetryRun(); } : undefined} />
          )}
          {/* 队列 bottom dock：贴在 composer 上方，与输入框融合成底 dock（对标 ZCode -mb-7 pb-7 磨砂贴合）。 */}
          {((session.queued_messages?.length ?? 0) > 0 || (session.pending_guidance?.length ?? 0) > 0 || queueError?.sessionId === session.id || queueWithdrawals.rows.length > 0 || queueWithdrawals.unknown || Boolean(queueWithdrawals.error)) && (
            <div className="xn-queue-dock" data-testid="session-queue-dock">
              <PendingGuidancePanel items={session.pending_guidance ?? []}
                onWithdraw={handleWithdrawGuidance} busyId={queueCancelling?.sessionId === session.id ? queueCancelling.queueId : null}
                disabled={busy || queueSubmittingSessions.has(session.id) || !isPluginEffective('sessions')} />
              <Suspense fallback={null}><SessionQueue key={session.id} queueRevision={session.queue_revision} items={session.queued_messages ?? []} cancellingId={queueCancelling?.sessionId === session.id ? queueCancelling.queueId : null} onCancel={handleCancelQueuedTurn}
                onWithdraw={handleWithdrawQueuedTurn}
                onSendNow={activeSessionRunning && session.active_turn_id ? handleSendNowQueuedTurn : undefined}
                onEdit={handleEditQueuedMessage} onReorder={handleReorderQueuedMessages} currentId={session.current_queue_item_id} disabled={busy || queueWithdrawals.busy || queueWithdrawals.unknown || queueSubmittingSessions.has(session.id) || !isPluginEffective("sessions")}
                canContinue={session.status !== "running" && session.streaming?.status !== "streaming" && (session.queued_messages ?? []).some(item => item.status === "paused")}
                continuing={queueContinuingSessions.has(session.id)} onContinue={handleContinueQueuedMessages} />
              <QueueWithdrawalRecovery key={`${session.id}:${commandRoot || 'default'}`}
                withdrawals={queueWithdrawals.rows} notice={queueWithdrawals.notice} error={queueWithdrawals.error}
                disabled={!isPluginEffective('sessions') || queueWithdrawals.busy} onRefresh={queueWithdrawals.refresh}
                onRestore={queueWithdrawals.restore} onDismiss={queueWithdrawals.dismiss} /></Suspense>
              {queueError?.sessionId === session.id && <SessionCommandNotice notice={queueError} compacting={session.compacting} />}
            </div>
          )}
            <CommandReceiptRecovery commands={sessionCommands} enabled={isPluginEffective('sessions')} sessionId={session.id}
              autoCheck={!activeSessionRunning} onRefresh={handleRefreshAll} onOpenSession={selectSession} />
            <Composer
              {...composer}
              draftKey={`session:${session.id}`}
              workspaceKey={commandRoot || "default"}
              attachmentSessionId={session.id}
              onSend={onSend}
              disabled={composerDisabled}
              sendDisabled={sendDisabled}
              modelRecovery={modelRecovery}
              queueWhenRunning
              guideWhenRunning={Boolean(session.active_turn_id)}
              queueBusy={queueSubmittingSessions.has(session.id) || queueContinuingSessions.has(session.id)}
              stopping={stoppingSessions.has(session.id)}
              onStop={handleStop}
              placeholder={tr("继续描述任务（/ 命令，@ 上下文，$ 技能）")}
            />
            {lightweightLayout && <LightweightStatusBar workspaceRoot={workspaceRoot}
              reportedUsage={extractReportedUsage(session.provider_usage)}
              status={composer.running ? "running" : (runError || session.status === "provider_error") ? "error" : session.status}
              stopping={stoppingSessions.has(session.id)} interrupted={session.streaming?.status === "interrupted"}
              queueCount={(session.queued_messages ?? []).length} />}
          </div>
          {contextSidepaneOpen && <Suspense fallback={null}><SessionContextPane key={session.id} session={session} rows={displayTimelineRows}
            filesEnabled={isPluginEffective('files')} onOpenFile={path => { void handleSelectFile(path); setPanel('files'); }}
            onBrowseFiles={isPluginEffective('files') ? () => setPanel('files') : undefined} onClose={() => setContextSidepaneOpen(false)}
            subagents={isPluginEffective('subagents') && !lightweightLayout ? <Suspense fallback={null}><SubagentSidePane
              sessionId={session.id} mode="summary" activeRuntimeProfile={activeRuntimeProfile} subagentsEnabled={isPluginEffective('subagents')}
              onOpenTasks={() => setPanel('subagents')} /></Suspense> : undefined} /></Suspense>}
  </>;
}

type WorkbenchStartViewProps = {
  isPluginEffective: (id: string) => boolean;
  lightweightLayout: boolean;
  claudexAppearance: boolean;
  locale: ReturnType<typeof useLocale>;
  viewSwitcher: React.ReactNode;
  workspaceContext: React.ReactNode;
  composerCatalog: ComposerCatalog;
  draftRoot: string | undefined;
  choices: RunChoices;
  selectedComposerModel: ComposerModel | undefined;
  startPageActions: StartPageAction[];
  recentProjects: RecentWorkspaceDirectory[] | null;
  liveSessions: SessionSummary[];
  selectSession: (id: string) => void;
  chooseWorkspace: (root: string, isolated?: boolean, forceNew?: boolean) => void;
  remoteDialogOpen: boolean;
  setRemoteDialogOpen: (open: boolean) => void;
  setRemoteAdapter: (adapter: RemoteSessionAdapter | null) => void;
  updateChoices: (patch: Partial<RunChoices>) => void;
  setPanel: (panel: WorkbenchPanel) => void;
  busy: boolean;
  runError: string;
  creatingSession: boolean;
  activeId: string | null;
  stoppingSessions: Set<string>;
  handleStop: () => Promise<void>;
  sessionCommands: WorkbenchSessionData['sessionCommands'];
  handleRefreshAll: () => Promise<void>;
  composer: WorkbenchComposerShared;
  workspaceKey: string;
  commandRoot: string;
  starterWorkspaceKey: string;
  composerModelReady: boolean;
  composerCatalogLoading: boolean;
  composerCatalogError: string;
  refreshComposerCatalog: () => Promise<void>;
  onSend: NonNullable<ComposerProps['onSend']>;
  appendTextToComposer: (targetSessionId: string | null, text: string, workspaceRoot?: string) => void;
};

/** Body of `.xn-empty-state-shell`: the start page with the docked new-task composer. */
export function WorkbenchStartView({ isPluginEffective, lightweightLayout, claudexAppearance, locale, viewSwitcher, workspaceContext, composerCatalog, draftRoot,
  choices, selectedComposerModel, startPageActions, recentProjects, liveSessions, selectSession, chooseWorkspace, remoteDialogOpen, setRemoteDialogOpen,
  setRemoteAdapter, updateChoices, setPanel, busy, runError, creatingSession, activeId, stoppingSessions, handleStop, sessionCommands, handleRefreshAll,
  composer, workspaceKey, commandRoot, starterWorkspaceKey, composerModelReady, composerCatalogLoading, composerCatalogError, refreshComposerCatalog, onSend,
  appendTextToComposer }: WorkbenchStartViewProps) {
  return <ConversationTimelineViewport
            autoScroll={false}
            rowsVersion={[]}
            centerEmptyStateWithDock
            emptyState={<div className="xn-empty-state-content">
              {!lightweightLayout && <div className="xn-hero__bar"><details className="xn-workbench-menu"><summary aria-label={tr("工作台")}><CircleHelp size={16} /></summary><div>{viewSwitcher}</div></details></div>}
              <div className="xn-hero__intro">
                <div className="xn-hero__brand" aria-hidden="true"><IconXuenessMark size={34} className="xn-hero__brand-mark" /></div>
                <h1 className="xn-hero__greeting">{claudexAppearance ? tf("我们应该在 {0} 中做些什么？", [composerCatalog.roots.find(item => item.path === (draftRoot ?? composerCatalog.root))?.name ?? (draftRoot ?? composerCatalog.root)?.split(/[/\\]/u).filter(Boolean).pop() ?? "Xueness"]) : heroGreeting(new Date())}</h1>
                <p className="xn-hero__hint">{tr("描述你想完成的事，Xueness 会在你的工作区里执行。")}</p>
              </div>
              {!lightweightLayout && <XuenessStartPage
                actions={startPageActions}
                projects={recentProjects}
                sessions={liveSessions}
                locale={locale}
                onSelectSession={selectSession}
                onSelectProject={root => chooseWorkspace(root)}
                remoteDialog={remoteDialogOpen && isPluginEffective("remote") ? <Suspense fallback={null}><StartPageRemoteDialog
                  open={remoteDialogOpen}
                  allowRemote={isPluginEffective("remote")}
                  onClose={() => setRemoteDialogOpen(false)}
                  onSelectRemote={(id, adapter) => {
                    chooseWorkspace(composerCatalog.isolatedRoot, true);
                    setRemoteAdapter(adapter);
                    updateChoices({ remote: id });
                    setRemoteDialogOpen(false);
                  }}
                  currentRemoteId={choices.remote}
                  connections={composerCatalog.remoteConnections}
                  onManageRemote={() => {
                    setRemoteDialogOpen(false);
                    setPanel("remote");
                  }}
                /></Suspense> : null}
              />}
            </div>}
            bottomDock={<div className="xn-hero__composer">
              {isPluginEffective('model_monitor') && <Suspense fallback={null}><ModelMonitorHome key="new-chat"
                providerId={choices.provider_id} requestedModel={choices.model ?? selectedComposerModel?.model} providerName={selectedComposerModel?.supplierName ?? selectedComposerModel?.name}
                onOpenHistory={() => setPanel('model-monitor')} /></Suspense>}
              {claudexAppearance && <div className="xn-hero__workspace">{workspaceContext}<span className="xn-composer-workspace__host"><Monitor size={15} aria-hidden="true" />{choices.remote ? tr("SSH 工作区") : tr("此计算机")}</span></div>}
              {runError && <p role="alert" className="xn-run-error">{runError}</p>}
              <CommandReceiptRecovery commands={sessionCommands} enabled={isPluginEffective('sessions')}
                onRefresh={handleRefreshAll} onOpenSession={selectSession} />
              <Composer
                {...composer}
                draftKey="new-task"
                workspaceKey={workspaceKey}
                variant="docked"
                topContent={claudexAppearance ? undefined : workspaceContext}
                onSend={onSend}
                disabled={busy || !commandRoot || !isPluginEffective("sessions")}
                sendDisabled={creatingSession || !composerModelReady || composerCatalogLoading}
                stopping={activeId ? stoppingSessions.has(activeId) : false}
                onStop={activeId ? handleStop : undefined}
                placeholder={tr("向 Xueness 提问，使用 @ 添加上下文，使用 / 选择命令或能力")}
              />
              {!composerCatalogLoading && !composerModelReady && (composerCatalogError || composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal) && <div className="xn-composer-model-setup" role="status">
                <span>{tr(composerCatalogError ? "模型列表加载失败，请重试。" : composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal ? "服务端已关闭模型请求。" : "配置一个模型即可开始对话。")}</span>
                <button type="button" onClick={() => composerCatalogError ? void refreshComposerCatalog() : setPanel(isPluginEffective("providers") ? "providers" : "plugins")}>{tr(composerCatalogError ? "重试" : "配置模型")}</button>
              </div>}
              {isPluginEffective('sessions') && <Suspense fallback={null}><StarterIdeas disabled={busy || creatingSession}
                onSelect={prompt => appendTextToComposer(null, prompt, starterWorkspaceKey)} /></Suspense>}
            </div>}
          />;
}
