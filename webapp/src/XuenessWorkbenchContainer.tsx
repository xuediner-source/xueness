/**
 * Xueness workbench container — chat-first.
 *
 * Wires the data layer (xuenessWorkbench.ts) to the views. The view owns no
 * IO; this file owns no styling beyond structural seams. Every action here is
 * a real round trip through the Python API: a button only exists if it has a
 * handler, and a failed call renders the server's error instead of silently
 * doing nothing.
 *
 * Information architecture mirrors the inherited ZCode shell: a dark sidebar
 * (new-task / search actions, task list, footer) plus a chat-first main area —
 * a centered hero composer when no task is selected, the conversation when one
 * is. Secondary views (files/diff/directory/providers/usage/memory/settings)
 * hang off the conversation header switcher and the sidebar footer, not tabs.
 *
 * The container is a composition: state, effects and actions live in hooks
 * next to the plugin that owns them (sessions, settings, files, providers),
 * and the large view bodies are plugin components. What stays here is the
 * panel / session navigation with its history, the plugin view mounting
 * table, and the shell layout.
 */
// Stylesheet order. Within a cascade layer the later sheet wins ties, so the
// sheets of the components this container mounts keep a fixed order here
// (between styles.css and styles/workbench.css in App.tsx) instead of
// following whichever module happens to import them first.
import "./plugins/sessions/ContextUsageRing.css";
import "./plugins/sessions/FullAccessConfirmationDialog.css";
import "./ui/select.css";
import "./plugins/sessions/session-header.css";
import "./plugins/sessions/context-compaction-status.css";
import "./plugins/sessions/ApprovalChoiceMenu.css";
import "./plugins/desktop/desktop-titlebar.css";
import "./plugins/sessions/sessions.css";
import "./styles/conversation-history-rail.css";
import "./ui/code-preview.css";
import "./ui/code-content.css";
import "./plugins/providers/LightweightWorkbench.css";
import "./plugins/sessions/CurrentTurnInput.css";
import "./plugins/sessions/ComposerCapabilityMenu.css";
import "./plugins/sessions/ComposerRecovery.css";
import "./styles/start-page.css";
import "./styles/usage-quick-card.css";
import "./plugins/sessions/task-list.css";
import "./plugins/sessions/ClaudexSidebar.css";
import "./plugins/sessions/sidebar-resize.css";
import "./plugins/sessions/zcode-conversation.css";
import "./plugins/tools/ToolExecutionSettings.css";
import "./styles/settings.css";
import "./styles/plugins.css";
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, UserRound } from "lucide-react";
import { t as tr, tf, useLocale, setLocale } from './i18n';
import { effectiveRuntimeProfile, runtimeProfileFromSession } from "./xuenessComposer";
import { loadMemoryTracks, loadProviders, loadUsage, type MemoryTrack, type ProviderSummary, type UsageSummary } from "./xuenessWorkspace";
import { initGitRepository, stageGitPaths, unstageGitPaths, commitGitChanges, switchGitBranch, stashGitChanges, createGitCheckpoint, restoreGitCheckpoint } from "./xuenessGit";
import { resolveHostPlatform } from './xuenessShortcutDisplay';
import { derivePluginAvailability, useCapabilitySections, workbenchPanelLabels, type WorkbenchPanel } from "./xuenessPluginRegistry";
import { FeatureUnavailable, XuenessPluginManager, usePluginCatalog } from "./XuenessPluginManager";
import type { CapabilitySectionProps } from "./XuenessCapabilitiesPanel";
import { Shell } from "./XuenessShell";
import { IconBack, IconGear } from "./ui/icons";
import { Select } from "./ui/Select";
import { RegionBoundary } from "./ui/primitives";
import { CodeDisplayProvider } from "./ui/CodeContent";
import { usePanelResource } from "./plugins/shared";
import { normalizeColorPalette } from "./plugins/settings/themeBoot";
import { useWorkbenchSettings } from "./plugins/settings/useWorkbenchSettings";
import { useWorkbenchGlobalShortcuts } from './plugins/settings/workbenchShortcutActions';
import { WorkbenchSettingsPanel } from "./plugins/settings/WorkbenchSettingsPanel";
import { CapabilitiesPanel, DesktopUpdates, ModelManager, ModelMonitorPanel, RemoteConnections, SubscriptionsPanel, WorkbuddySettingsPanel,
  XuenessAutomationsPanel, XuenessDiagnosticsPanel, XuenessMarketplace, XuenessMcpTools, XuenessUsageSettings } from "./plugins/settings/workbenchSettingsViews";
import { useGitPanel } from './plugins/git/useGitPanel';
import { useWorkbenchFiles } from "./plugins/files/useWorkbenchFiles";
import { useDefaultModelSelection } from "./plugins/providers/useDefaultModelSelection";
import { useLightweightWorkbench } from "./plugins/providers/useLightweightWorkbench";
import { lightweightLayoutActive } from "./plugins/providers/LightweightWorkbench";
import type { LocalRuntimeSession } from "./plugins/providers/LocalRuntimeMonitor";
import { DesktopTitlebar } from "./plugins/desktop/DesktopTitlebar";
import { DesktopTrayBridge } from './plugins/desktop/DesktopTrayBridge';
import { DesktopNotificationsBridge } from './plugins/desktop/DesktopNotificationsBridge';
import { useTerminalLifecycle } from './plugins/terminal/terminalLifecycle';
import { useBrowserLifecycle } from './plugins/browser/browserLifecycle';
import { useComposerAttachmentLifecycle } from './plugins/sessions/composerAttachmentLifecycle';
import { clearWorkspaceComposerCatalog } from './plugins/sessions/composerCatalogLifecycle';
import { readPersistedDraft } from "./plugins/sessions/composerDraftStore";
import type { ComposerDraftState } from "./plugins/sessions/composerTypes";
import { CommandPalette, useCommandPaletteState } from "./plugins/sessions/CommandPalette";
import { ClaudexSidebarHeader, ClaudexSidebarRail } from "./plugins/sessions/ClaudexSidebar";
import { SidebarResizeHandle, useSessionSidebarWidth } from './plugins/sessions/SidebarResizeHandle';
import { WorkbenchViewSwitcher } from "./plugins/sessions/WorkbenchViewSwitcher";
import { useLivePermissionMode } from "./plugins/sessions/useLivePermissionMode";
import { sessionContextUsage } from './plugins/sessions/sessionContextUsage';
import { usePrimarySidePanelBinding } from './plugins/sessions/paneSidePanelBinding';
import { usePrimaryFork } from './plugins/sessions/primaryForkCommand';
import { useSessionActivity } from "./plugins/sessions/workbenchSessionState";
import { shouldPreservePersistedDefaultDraftScope, useComposerDraftWriters } from "./plugins/sessions/workbenchDrafts";
import { useWorkbenchSessionData } from "./plugins/sessions/useWorkbenchSessionData";
import { useComposerCatalog } from "./plugins/sessions/useComposerCatalog";
import { usePrimaryPaneSelection } from "./plugins/sessions/usePrimaryPaneSelection";
import { useSessionRunActions } from "./plugins/sessions/useSessionRunActions";
import { useSessionSend } from "./plugins/sessions/useSessionSend";
import { useSessionQueueActions } from "./plugins/sessions/useSessionQueueActions";
import { useSessionListActions } from "./plugins/sessions/useSessionListActions";
import { useWorkspaceSelection } from "./plugins/sessions/useWorkspaceSelection";
import { WorkbenchComposerControls, WorkbenchWorkspaceContext, useWorkbenchComposerProps } from "./plugins/sessions/WorkbenchComposerControls";
import { SubagentSidePane, WorkbenchConversation, WorkbenchStartView } from "./plugins/sessions/WorkbenchConversation";
import { WorkbenchSessionHeader } from "./plugins/sessions/WorkbenchSessionHeader";
import { WorkbenchSidebar, buildSidebarActions } from "./plugins/sessions/WorkbenchSidebar";
export { evaluateWorkbenchGlobalKey, type WorkbenchGlobalKeyAction } from './plugins/settings/workbenchShortcutActions';
export { shouldIgnoreSessionResponse, createCleanSessionTransientState } from './plugins/sessions/workbenchSessionState';
export { composerModelRecoveryFor, shouldPreservePersistedDefaultDraftScope, shouldHydrateEmptyPrimaryDraftScope } from './plugins/sessions/workbenchDrafts';

// Static plugin imports load only when their permitted view mounts.
const FileBrowser = lazy(() => import("./plugins/files/FileBrowser").then(module => ({ default: module.FileBrowser })));
const DiffView = lazy(() => import("./plugins/files/DiffView").then(module => ({ default: module.DiffView })));
const DirectoryBrowser = lazy(() => import("./plugins/files/DirectoryBrowser").then(module => ({ default: module.DirectoryBrowser })));
const MemoryPanel = lazy(() => import("./plugins/memory/MemoryPanel").then(module => ({ default: module.MemoryPanel })));
const DesktopPermissionOnboarding = lazy(() => import("./plugins/onboarding/DesktopPermissionOnboarding").then(module => ({ default: module.DesktopPermissionOnboarding })));
const WorkflowPanel = lazy(() => import("./plugins/workflows").then(module => ({ default: module.WorkflowPanel })));
const TerminalPanel = lazy(() => import("./plugins/terminal").then(module => ({ default: module.TerminalPanel })));
const XuenessGitView = lazy(() => import("./plugins/git/XuenessGitView").then(module => ({ default: module.XuenessGitView })));
const XuenessMemoryEditor = lazy(() => import("./plugins/memory").then(module => ({ default: module.XuenessMemoryEditor })));
const ContextLensPanel = lazy(() => import("./plugins/context_lens/ContextLensPanel").then(module => ({ default: module.ContextLensPanel })));
const BrowserPanel = lazy(() => import("./plugins/browser/BrowserPanel").then(module => ({ default: module.BrowserPanel })));
const SkillsSection = lazy(() => import('./plugins/skills/SkillsSection').then(module => ({ default: module.SkillsSection })));
const SessionPaneWorkbench = lazy(() => import('./plugins/sessions/SessionPaneWorkbench').then(module => ({ default: module.SessionPaneWorkbench })));
const ForkSessionDialog = lazy(() => import('./plugins/sessions/ForkSessionDialog').then(module => ({ default: module.ForkSessionDialog })));
const XuenessRenameDialog = lazy(() => import('./plugins/sessions/XuenessRenameDialog').then(module => ({ default: module.XuenessRenameDialog })));
const XuenessCloneDialog = lazy(() => import('./plugins/git/XuenessCloneDialog').then(module => ({ default: module.XuenessCloneDialog })));
const XuenessWorkspacePickerDialog = lazy(() => import('./plugins/settings/XuenessWorkspacePickerDialog').then(module => ({ default: module.XuenessWorkspacePickerDialog })));
const XuenessCapabilityDialog = lazy(() => import('./XuenessCapabilityDialog').then(module => ({ default: module.XuenessCapabilityDialog })));

export function XuenessWorkbenchContainer() {
  const locale = useLocale();
  useEffect(() => { document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"; }, [locale]);
  const { pluginCatalog, pluginCatalogLoading, pluginCatalogReady, pluginCatalogError, isPluginEffective, pluginEffectiveRef, isSessionsEffective,
    refreshPluginCatalog, togglePlugin } = usePluginCatalog();
  useComposerAttachmentLifecycle(isPluginEffective('sessions'));
  useTerminalLifecycle(isPluginEffective('terminal'), isPluginEffective('remote'));
  useBrowserLifecycle(isPluginEffective('browser'));
  const activity = useSessionActivity();
  const { error, setError, runError, setRunError, busy, runRequestSessions, stoppingSessions } = activity;

  // -- navigation: the visible panel and the primary session, with back / forward history
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('session')?.trim() || null;
  });
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const composerDraftStore = useRef(new Map<string, ComposerDraftState>());
  const [panel, setPanel] = useState<WorkbenchPanel>("chat");
  const history = useRef<{ panel: WorkbenchPanel; activeId: string | null }[]>([{ panel: "chat", activeId: null }]);
  const historyCursor = useRef(0);
  const historyTarget = useRef<string | null>(null);
  const [historyPosition, setHistoryPosition] = useState({ cursor: 0, length: 1 });
  useEffect(() => {
    const key = `${panel}:${activeId ?? ""}`;
    if (historyTarget.current === key) { historyTarget.current = null; return; }
    const current = history.current[historyCursor.current];
    if (current.panel === panel && current.activeId === activeId) return;
    history.current = [...history.current.slice(0, historyCursor.current + 1), { panel, activeId }];
    historyCursor.current = history.current.length - 1;
    setHistoryPosition({ cursor: historyCursor.current, length: history.current.length });
  }, [panel, activeId]);
  const navigateHistory = (direction: number) => {
    const cursor = historyCursor.current + direction;
    const target = history.current[cursor];
    if (!target || busy) return;
    historyCursor.current = cursor;
    historyTarget.current = `${target.panel}:${target.activeId ?? ""}`;
    setPanel(target.panel); setActiveId(target.activeId);
    setHistoryPosition({ cursor, length: history.current.length });
  };
  useEffect(() => {
    if (!pluginCatalogReady || canShowPanel(panel)) return;
    setPanel(isPluginEffective("sessions") ? "chat" : "plugins");
  }, [panel, pluginCatalogReady, pluginCatalog, isPluginEffective]);
  const [sidebarToggleToken, setSidebarToggleToken] = useState(0);
  const [heroFocusTick, setHeroFocusTick] = useState(0);
  const [contextSidepaneOpen, setContextSidepaneOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  useEffect(() => { setShareDialogOpen(false); }, [activeId]);

  const pluginAvailability = derivePluginAvailability(pluginCatalog, pluginCatalogReady);
  const allowedPanels: WorkbenchPanel[] = ["plugins", ...pluginAvailability.panels];
  const canShowPanel = (target: WorkbenchPanel) => target === "plugins" || allowedPanels.includes(target);
  const panelLabels = workbenchPanelLabels();

  // -- plugin state, each in its owner's hook -------------------------------
  // Git panel status, history, checkpoints, and explicitly confirmed local actions.
  const { gitStatus, gitStatusError, gitDiff, gitDiffError, gitLog, gitLogError, gitCheckpoints, gitCheckpointError, gitLoading, gitActionBusy, loadGitPanel, runGitAction } = useGitPanel(activeId, panel === 'git', isPluginEffective('git'));
  const settings = useWorkbenchSettings({ isPluginEffective, pluginEffectiveRef, pluginCatalog, effectiveIds: pluginAvailability.effectiveIds });
  const { settingsValues, settingsSection, settingsLoading, shortcutBindings, handleUpdateSetting } = settings;
  const heroInputRef = useRef<HTMLElement | null>(null);
  const palette = useCommandPaletteState(isPluginEffective);
  const { setCommandOpen, openCommandPalette } = palette;
  const filesPanel = useWorkbenchFiles({ activeId, activeIdRef, panel, isPluginEffective, pluginEffectiveRef });
  const data = useWorkbenchSessionData({ activeId, activeIdRef, setActiveId, isPluginEffective, pluginEffectiveRef, pluginCatalogReady, pluginCatalog, activity,
    loadFileCandidates: filesPanel.loadFileCandidates });
  const { session, setSession, setRows, setDataErrors, dataErrors, sessions, liveSessions, sessionCommands, loadActive, refreshList } = data;
  const composer = useComposerCatalog({ activeId, activeIdRef, session, executingSessions: activity.executingSessions, isPluginEffective, pluginCatalogReady, pluginCatalog,
    locale, setRunError, settings });
  const { choices, setChoices, updateChoices, composerCatalog, composerCatalogLoading, composerCatalogError, refreshComposerCatalog, draftRoot, preserveDefaultDraftScope,
    commandRoot, composerRequests, setDraftRoot, setPreserveDefaultDraftScope, setIsolatedWorkspace, setComposerRefreshTick, setComposerCatalog, setComposerCatalogLoading,
    loadedSessionChoices } = composer;
  const defaultModel = useDefaultModelSelection({ choices, isPluginEffective, setPanel, setError });
  const { appendTextToComposer, moveTextIntoComposer } = useComposerDraftWriters({ draftStore: composerDraftStore, sessionSnapshotRef: data.sessionSnapshotRef, activeIdRef,
    heroInputRef, draftRoot, catalogRoot: composerCatalog.root, commandRoot });
  const fork = usePrimaryFork({ activeId, activeIdRef, setActiveId, setPanel, isPluginEffective, busy, setRunError, data, appendTextToComposer, loadedSessionChoices });
  const panes = usePrimaryPaneSelection({ activeId, activeIdRef, setActiveId, setPanel, setRunError });
  const { paneSelectionIntent, selectSession } = panes;
  const runActions = useSessionRunActions({ activeId, activeIdRef, isPluginEffective, pluginEffectiveRef, activity, data,
    draftScopeRoot: draftRoot ?? composerCatalog.root ?? '', setChoices });
  const { handleStop, runPermission } = runActions;
  const { handleSend, handleCreate } = useSessionSend({ activeId, activeIdRef, setActiveId, setPanel, isPluginEffective, pluginEffectiveRef, activity, data, runActions,
    draftRoot, catalogRoot: composerCatalog.root, isolatedWorkspace: composer.isolatedWorkspace, setChoices, loadedSessionChoices, paneCreationRef: panes.paneCreationRef });
  const queue = useSessionQueueActions({ activeId, activeIdRef, isPluginEffective, pluginEffectiveRef, activity, data, runActions, commandRoot, setChoices, moveTextIntoComposer });
  const listActions = useSessionListActions({ activeId, setActiveId, isPluginEffective, pluginEffectiveRef, activity, data });
  const { handleRefreshAll } = listActions;
  const activeSessionRunning = activeId !== null && session?.id === activeId && (
    session.status === "running" || session.streaming?.status === "streaming" || runRequestSessions.has(activeId)
  );
  const composerDisabled = (session?.status === "awaiting_user" && settingsValues.sessionsAnswerQuestionEnabled === true) || (busy && !activeSessionRunning) || !activeId || session?.id !== activeId || !isPluginEffective("sessions");

  const startNewTask = useCallback(() => {
    paneSelectionIntent.current = true;
    setCommandOpen(false);
    setRunError("");
    setActiveId(null);
    setSession(null);
    setDraftRoot(undefined);
    setPreserveDefaultDraftScope(shouldPreservePersistedDefaultDraftScope(readPersistedDraft('default', 'new-task')));
    setIsolatedWorkspace(false);
    composerRequests.cancel();
    setComposerRefreshTick(tick => tick + 1);
    setComposerCatalog(clearWorkspaceComposerCatalog);
    setComposerCatalogLoading(true);
    loadedSessionChoices.current = null;
    updateChoices({ remote: undefined, browser: settingsValues.browserControlEnabled === true && isPluginEffective("browser") });
    setRows([]);
    setDataErrors(previous => ({ ...previous, active: "" }));
    setPanel("chat");
    setHeroFocusTick((tick) => tick + 1);
  }, [settingsValues.browserControlEnabled, isPluginEffective, updateChoices, composerRequests]);
  useEffect(() => {
    if (!activeId && !session) heroInputRef.current?.focus();
  }, [heroFocusTick, activeId, session]);
  useWorkbenchGlobalShortcuts({ settingsValues, isPluginEffective, panel, busy, setPanel, startNewTask, openCommandPalette, setSidebarToggleToken, handleRefreshAll, handleUpdateSetting });

  // Panel summaries load each time their panel (or settings section) opens. The provider and
  // usage summaries are still requested as before, although no current view reads them.
  usePanelResource<ProviderSummary[]>(panel === "providers" && isPluginEffective("providers"), loadProviders, [], [panel, settingsSection, isPluginEffective]);
  usePanelResource<UsageSummary | null>((panel === "usage" || (panel === "settings" && settingsSection === "usage")) && isPluginEffective("usage"), loadUsage, null, [panel, settingsSection, isPluginEffective]);
  const memoryTracks = usePanelResource<MemoryTrack[]>((panel === "memory" || (panel === "settings" && settingsSection === "memory")) && isPluginEffective("memory"), loadMemoryTracks, [], [panel, settingsSection, isPluginEffective]);

  const selectedComposerModel = composerCatalog.models.find(model => model.id === (choices.provider_id ?? ""));
  const composerModelReady = selectedComposerModel?.configured === true && composerCatalog.allowReal && isPluginEffective("providers");
  const activeMonitorSource = session?.id === activeId ? session : null;
  const activeRuntimeProfile = runtimeProfileFromSession(activeMonitorSource?.runtime_profile)
    ?? effectiveRuntimeProfile(selectedComposerModel, choices.runtime_profile);
  const runtimeMonitorSession: LocalRuntimeSession | null = activeMonitorSource ? {
    status: activeMonitorSource.status,
    runtime_profile: activeRuntimeProfile,
    runtime_budget: activeMonitorSource.runtime_budget,
    runtime_activity: activeMonitorSource.runtime_activity,
    runtime_activity_history: activeMonitorSource.runtime_activity_history,
    tool_timings: activeMonitorSource.tool_timings,
  } : null;
  const composerRunning = activeSessionRunning;
  // 轻量档极简布局由 providers 插件拥有：档位生效且插件可用才切换挂载。
  const lightweightLayout = lightweightLayoutActive(activeRuntimeProfile, isPluginEffective("providers"));
  useLightweightWorkbench({ lightweightLayout, panel, setPanel, isPluginEffective, composerRunning, activeId, stoppingSessions, handleStop, heroInputRef });
  const contextReading = sessionContextUsage(session?.id === activeId ? session : null,
    composerCatalog.models.find(model => model.id === (choices.provider_id ?? "")), choices);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [deliveryEditorRequest, setDeliveryEditorRequest] = useState<{id: string; version: number} | null>(null);
  useEffect(() => setGoalEditorOpen(false), [activeId]);
  const livePermissions = useLivePermissionMode(activeId, session?.active_turn_id ?? null, isPluginEffective("sessions"), async (id, permission_mode) => {
    if (activeIdRef.current !== id) return; updateChoices({ permission_mode, acknowledge_yolo: false }); await loadActive(id);
  });
  const workspace = useWorkspaceSelection({ panel, setPanel, lightweightLayout, activeId, session, busy, isPluginEffective, pluginEffectiveRef, settings, composer,
    composerDraftStore, startNewTask, setHeroFocusTick });
  const { remoteAdapter, setRemoteDialogOpen, chooseWorkspace } = workspace;
  const { receiveFocusedIdentity, scopedSidePanel } = usePrimarySidePanelBinding({ activeId, remoteChoice: choices.remote, session, remoteAdapter, isPluginEffective });

  // -- primary composers ------------------------------------------------------
  const { composerShared, composerStartActions, composerModelRecovery, hydrateEmptyPrimaryDraftScope } = useWorkbenchComposerProps({ composer, isPluginEffective, activeId,
    setPanel, setGoalEditorOpen, composerRunning, composerModelReady, composerDraftStore, heroInputRef, settingsValues, shortcutBindings, files: filesPanel.files,
    controls: <WorkbenchComposerControls composer={composer} defaultModel={defaultModel} isPluginEffective={isPluginEffective} setPanel={setPanel} activeId={activeId}
      session={session} busy={busy} branchBusy={workspace.branchBusy} composerRunning={composerRunning} livePermissions={livePermissions} contextReading={contextReading} /> });
  const workspaceContext = <WorkbenchWorkspaceContext composer={composer} workspace={workspace} isPluginEffective={isPluginEffective} busy={busy} setRunError={setRunError} />;

  const { capSections, loadCapSlot, capDialog, setCapDialog, capDialogError, capDialogBusy, handleCapSubmit } = useCapabilitySections({
    isPluginEffective, capabilityKinds: pluginAvailability.capabilityKinds, panel, settingsSection,
    renderers: { skills: (props: CapabilitySectionProps) => <Suspense fallback={null}><SkillsSection {...props} /></Suspense> },
  });

  // -- view switcher (conversation header) ----------------------------------
  const viewSwitcher = <WorkbenchViewSwitcher<WorkbenchPanel> value={panel} onChange={setPanel}
    options={allowedPanels.filter(id => !lightweightLayout || id !== "subagents").map(id => ({ id, label: panelLabels[id] }))} />;

  const sessionHeader = (splitControls?: React.ReactNode, groupSwitcher?: React.ReactNode) => <WorkbenchSessionHeader splitControls={splitControls} groupSwitcher={groupSwitcher}
    session={session} activeId={activeId} panel={panel} panelLabel={panelLabels[panel]} viewSwitcher={viewSwitcher} agentsAvailable={canShowPanel("subagents")}
    lightweightLayout={lightweightLayout} busy={busy} activeSessionRunning={activeSessionRunning} isPluginEffective={isPluginEffective} setPanel={setPanel}
    beginFork={fork.beginFork} contextSidepaneOpen={contextSidepaneOpen} setContextSidepaneOpen={setContextSidepaneOpen}
    setDeliveryEditorRequest={setDeliveryEditorRequest} setShareDialogOpen={setShareDialogOpen} listActions={listActions} />;

  // -- plugin views, mounted only while their plugin is effective ------------
  const secondaryPanels: Record<Exclude<WorkbenchPanel, "chat">, React.ReactNode> = {
    remote: <RemoteConnections onUse={() => { startNewTask(); setRemoteDialogOpen(true); }} />,
    subagents: (
      <Suspense fallback={<div className="p-4 text-xs text-[var(--fg-muted)]">{tr("正在加载…")}</div>}>
        <SubagentSidePane
          sessionId={activeId}
          isOpen={true}
          onClose={() => setPanel("chat")}
          activeRuntimeProfile={activeRuntimeProfile}
          subagentsEnabled={isPluginEffective("subagents")}
          cancelOneEnabled={settingsValues.subagentCancelOneEnabled === true}
          lightweight={lightweightLayout}
          mode="panel"
          onStopSession={handleStop}
          onRequestResumeChild={taskId => {
            if (!activeId || !isPluginEffective('sessions') || !isPluginEffective('subagents')) return;
            appendTextToComposer(activeId, tf('请恢复已保留的子任务 {0}，沿用它的历史与只读权限，继续处理并收集结果。', [taskId]));
            setPanel('chat');
          }}
        />
      </Suspense>
    ),
    plugins: (
      <XuenessPluginManager
        plugins={pluginCatalog}
        loading={pluginCatalogLoading}
        error={pluginCatalogError}
        onRefresh={refreshPluginCatalog}
        onToggle={togglePlugin}
      />
    ),
    workflows: <WorkflowPanel sessionId={activeId} subagentsEnabled={isPluginEffective("subagents")} />,
    terminal: <TerminalPanel {...scopedSidePanel} fontSize={Number(settingsValues.terminalFontSize ?? 13)} fontFamily={String(settingsValues.terminalFontFamily ?? "system")} />,
    browser: <BrowserPanel {...scopedSidePanel} />,
    automations: <XuenessAutomationsPanel offPeakEnabled={isPluginEffective("automation")} />,
    marketplace: <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} onManagePlugins={() => setPanel('plugins')} />,
    subscriptions: <SubscriptionsPanel onChanged={() => void refreshComposerCatalog()} onSelectModel={id => { updateChoices({ provider: 'real', provider_id: id, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); setPanel('chat'); }} />,
    workbuddy: <WorkbuddySettingsPanel />,
    'model-monitor': <ModelMonitorPanel />,
    diagnostics: <XuenessDiagnosticsPanel />,
    files: (
      <FileBrowser
        files={filesPanel.files}
        truncated={filesPanel.filesTruncated}
        selectedPath={filesPanel.selectedPath}
        preview={filesPanel.preview}
        previewError={filesPanel.previewError}
        officePreviewEnabled={isPluginEffective("office")}
        onSelect={filesPanel.handleSelectFile}
      />
    ),
    changes: <DiffView changeSet={filesPanel.changeSet} error={filesPanel.changesError} />,
    git: (
      <XuenessGitView
        status={gitStatus}
        statusError={gitStatusError || undefined}
        statusLoading={gitLoading}
        diff={gitDiff}
        diffError={gitDiffError || undefined}
        diffLoading={gitLoading}
        log={gitLog}
        logError={gitLogError || undefined}
        logLoading={gitLoading}
        checkpoints={gitCheckpoints}
        actionError={gitCheckpointError}
        actionBusy={gitActionBusy}
        onRefresh={() => void loadGitPanel()}
        onInit={() => void runGitAction(() => initGitRepository(activeId!))}
        onStage={paths => void runGitAction(() => stageGitPaths(activeId!, paths))}
        onUnstage={paths => void runGitAction(() => unstageGitPaths(activeId!, paths))}
        onCommit={message => void runGitAction(() => commitGitChanges(activeId!, message))}
        onBranch={(name, create) => void runGitAction(() => switchGitBranch(activeId!, name, create))}
        onStash={() => void runGitAction(() => stashGitChanges(activeId!))}
        onCheckpoint={message => void runGitAction(() => createGitCheckpoint(activeId!, message))}
        onRestore={checkpointId => void runGitAction(() => restoreGitCheckpoint(activeId!, checkpointId))}
      />
    ),
    directory: <DirectoryBrowser currentPath={filesPanel.dirListing?.path ?? null} entries={filesPanel.dirListing?.entries ?? []}
        error={filesPanel.dirError} truncated={filesPanel.dirListing?.truncated ?? false} loading={filesPanel.dirLoading}
        onNavigate={filesPanel.browseDirectory} onOpenFile={filesPanel.handleSelectFile} onCreateDir={filesPanel.handleCreateDir} />,
    providers: (
      <ModelManager focusProviderId={defaultModel.providerFocusId} runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { composer.selectProviderForCurrentRun(id); setPanel("chat"); }} />
    ),
    "context-lens": <ContextLensPanel enabled={isPluginEffective("context_lens")} settingsEnabled={isPluginEffective("settings")} sessionId={activeId} onOpenSession={selectSession} onSelectSession={id => { selectSession(id); setPanel("context-lens"); }} />,
    usage: <XuenessUsageSettings />,
    memory: <><MemoryPanel tracks={memoryTracks.value} error={memoryTracks.error} loading={memoryTracks.loading} /><XuenessMemoryEditor /></>,
    capabilities: <><CapabilitiesPanel sections={capSections} />{isPluginEffective("mcp") && <XuenessMcpTools />}</>,
    settings: <WorkbenchSettingsPanel settings={settings} isPluginEffective={isPluginEffective} capabilityKinds={pluginAvailability.capabilityKinds} capSections={capSections}
      loadCapSlot={loadCapSlot} pluginCatalog={pluginCatalog} pluginCatalogLoading={pluginCatalogLoading} pluginCatalogError={pluginCatalogError}
      refreshPluginCatalog={refreshPluginCatalog} togglePlugin={togglePlugin} locale={locale} busy={busy} session={session} activeId={activeId} activeIdRef={activeIdRef}
      composer={composer} providerFocusId={defaultModel.providerFocusId} setPanel={setPanel} startNewTask={startNewTask} setRemoteDialogOpen={setRemoteDialogOpen} />,
  };

  const secondaryContent = panel !== 'chat' && panel !== 'settings' ? canShowPanel(panel) && (!lightweightLayout || panel !== 'subagents')
    ? secondaryPanels[panel] : <FeatureUnavailable feature={panelLabels[panel]} onManage={() => setPanel('plugins')} /> : null;
  const runPaletteCommand = useCallback((id: string) => {
    setCommandOpen(false);
    if (id === "new-task") startNewTask();
    else if (id === "open-settings" && isPluginEffective("settings")) setPanel("settings");
    else if (id === "refresh") void handleRefreshAll();
  }, [startNewTask, handleRefreshAll, isPluginEffective]);

  const claudexAppearance = normalizeColorPalette(settingsLoading && typeof document !== 'undefined'
    ? document.documentElement.dataset.xnPalette : settingsValues.colorPalette) === 'claudex';
  const sidebarAppearance = claudexAppearance ? 'claudex' : 'xueness';
  const sidebarSizing = useSessionSidebarWidth(sidebarAppearance, isPluginEffective('sessions'));
  const { sidebarActions, railActions, railSecondaryActions, railMoreActions, sidebarMenuActions } = buildSidebarActions({ isPluginEffective, claudexAppearance,
    shortcutBindings, allowedPanels, canShowPanel, panelLabels, setPanel, startNewTask, openCommandPalette });

  return (
    <CodeDisplayProvider settings={settingsValues.codePreviewSettings} dark={settings.darkTheme}>
    {isPluginEffective('onboarding') && isPluginEffective('desktop') && <Suspense fallback={null}>
      <DesktopPermissionOnboarding enabled={isPluginEffective('onboarding')} desktopEnabled={isPluginEffective('desktop')} />
    </Suspense>}
    <DesktopTrayBridge enabled={isPluginEffective('desktop')} sessionsEnabled={isPluginEffective('sessions')} busy={busy}
      activeId={activeId} locale={locale} dark={settings.darkTheme}
      onNew={startNewTask} onSession={panes.selectTraySession} />
    <DesktopNotificationsBridge enabled={isPluginEffective('desktop')} sessions={liveSessions} activeId={activeId} locale={locale} />
    <Shell
      titlebar={typeof window !== "undefined" && new URLSearchParams(window.location.search).get("xuenessDesktop") === "1" ? <DesktopTitlebar
        desktopEnabled={isPluginEffective('desktop')}
        canGoBack={isPluginEffective("sessions") && !busy && historyPosition.cursor > 0}
        canGoForward={isPluginEffective("sessions") && !busy && historyPosition.cursor < historyPosition.length - 1}
        onGoBack={() => navigateHistory(-1)}
        onGoForward={() => navigateHistory(1)}
        hasSidebar={panel !== "settings" && isPluginEffective("sessions")}
        onToggleSidebar={() => setSidebarToggleToken(value => value + 1)}
        terminalEnabled={isPluginEffective("terminal")}
        onOpenTerminal={() => { if (isPluginEffective("terminal")) setPanel("terminal"); }}
        helpContent={viewSwitcher}
      /> : undefined}
      navigationKey={`${panel}:${activeId ?? ""}:${palette.commandOpen}:${workspace.workspacePicking}:${heroFocusTick}`}
      sidebarToggleToken={sidebarToggleToken}
      initialSidebarCollapsed={lightweightLayout}
      sidebarPersistenceEnabled={isPluginEffective('sessions')}
      sidebarWidth={sidebarSizing.width}
      sidebarResize={isPluginEffective('sessions') && sidebarSizing.width !== undefined ? <SidebarResizeHandle
        appearance={sidebarAppearance} width={sidebarSizing.width} min={sidebarSizing.limits.min} max={sidebarSizing.limits.max} onChange={sidebarSizing.onChange} /> : undefined}
      canGoBack={!busy && historyPosition.cursor > 0}
      canGoForward={!busy && historyPosition.cursor < historyPosition.length - 1}
      onGoBack={() => navigateHistory(-1)} onGoForward={() => navigateHistory(1)}
      sidebarRail={claudexAppearance && panel !== 'settings' ? <ClaudexSidebarRail
        actions={railActions}
        secondaryActions={railSecondaryActions} moreActions={railMoreActions}
        activeId={panel === 'chat' && !activeId ? 'home' : panel}
        platform={resolveHostPlatform()} /> : undefined}
      sidebarHeader={claudexAppearance && panel !== "settings" ? <ClaudexSidebarHeader
        search={sidebarActions.find(action => action.id === 'search')} platform={resolveHostPlatform()}
        menuActions={sidebarMenuActions} activity={liveSessions.filter(item => ['running','stopping','awaiting_user','needs_review','failed','provider_error'].includes(item.status)).slice(0,12)} onSelectSession={selectSession} /> : undefined}
      sidebar={panel === "settings" ? null : (
        <WorkbenchSidebar sidebarActions={sidebarActions} claudexAppearance={claudexAppearance} isPluginEffective={isPluginEffective} pluginEffectiveRef={pluginEffectiveRef}
          liveSessions={liveSessions} activeId={activeId} busy={busy} composerCatalog={composerCatalog} workspace={workspace} settings={settings} listActions={listActions}
          selectSession={selectSession} setError={setError} refreshList={refreshList} />
      )}
      sidebarFooter={
        <>
          <DesktopUpdates compact enabled={isPluginEffective('updates') && isPluginEffective('desktop')} onManage={() => { settings.setSettingsSection('updates'); setPanel('settings'); }} />
          <details className="xn-sidebar-account">
            <summary aria-label={tr("账户菜单")} title={tr("账户菜单")}><span className="xn-sidebar-account__avatar" aria-hidden="true"><UserRound size={16} /></span><span>Xueness</span><ChevronDown size={12} /></summary>
            <div className="xn-sidebar-account__menu">
              <Select aria-label="Language / 语言" value={locale} onChange={e => { setLocale(e.target.value as "zh" | "en"); void handleUpdateSetting("language",e.target.value); }}><option value="zh">中文简体</option><option value="en">English</option></Select>
              <button type="button" onClick={() => setPanel("plugins")}>{tr("插件管理")}</button>
              {isPluginEffective("workflows") && <button type="button" onClick={() => setPanel("workflows")}>{tr("工作流与后台任务")}</button>}
            </div>
          </details>
          {isPluginEffective("settings") && <button type="button" className="xn-sidebar-footer__action" aria-label={tr("打开设置")} title={tr("设置")} data-sidebar-navigate="true" onClick={() => setPanel("settings")}><IconGear size={16} /></button>}
        </>
      }
    >
      {palette.commandPaletteEnabled && <CommandPalette
        dialogRef={palette.commandDialogRef}
        inputRef={palette.commandRef}
        sessions={sessions}
        busy={busy}
        sessionsEnabled={isPluginEffective("sessions")}
        settingsEnabled={isPluginEffective("settings")}
        onClose={() => setCommandOpen(false)}
        onRunCommand={runPaletteCommand}
        onSelectSession={(id, query) => {
          selectSession(id);
          data.setConversationFindRequest(query ? {sessionId: id, id: crypto.randomUUID(), query} : null);
        }}
      />}

      {(error || dataErrors.active || dataErrors.list) && (
        <div role="alert" className="xn-error-banner">
          <span>{error || dataErrors.active || dataErrors.list}</span>
          <button type="button" disabled={busy} onClick={() => { setError(""); void handleRefreshAll(); }}>{tr("重新加载")}</button>
        </div>
      )}

      <RegionBoundary resetKey={`${panel}:${activeId ?? "hero"}`} onReload={() => window.location.reload()} onRecover={() => setPanel("plugins")}><Suspense fallback={<p role="status" className="xn-view-loading">{tr("正在加载界面…")}</p>}>
      {panel === "settings" ? secondaryPanels.settings : !isPluginEffective("sessions") ? panel === 'chat' ? (
        <FeatureUnavailable feature={tr("会话")} onManage={() => setPanel("plugins")} />
      ) : <div className="xn-secondary-view"><div className="xn-secondary-view__bar">
            <button type="button" className="xn-secondary-view__back" onClick={() => setPanel("chat")}>
              <IconBack size={14} />{tr("返回会话")}</button>
            <span className="xn-secondary-view__title">{panelLabels[panel]}</span>
            <div className="xn-secondary-view__switcher">{viewSwitcher}</div>
          </div><div className="xn-secondary-view__body">{secondaryContent}</div></div>
      : <SessionPaneWorkbench renderHeader={sessionHeader} auxiliaryView={secondaryContent} enabled={isPluginEffective('sessions')} onFocusedIdentity={receiveFocusedIdentity} onConfigureModels={composerStartActions.onModels}
        hydrateEmptyPrimaryDraftScope={hydrateEmptyPrimaryDraftScope}
        remoteSessions={remoteAdapter?.sessions}
        resolveRemoteAdapter={scope => isPluginEffective('remote') && remoteAdapter?.isCurrent() && scope.remoteConnectionId === remoteAdapter.owner.connectionId && scope.workspaceIdentity === JSON.stringify(['remote', remoteAdapter.owner.connectionId, remoteAdapter.owner.workspaceIdentity]) ? remoteAdapter : undefined}
        resolveRemoteSafetyStopAdapter={scope => isPluginEffective('remote') && remoteAdapter?.isSafetyStopAvailable() && scope.remoteConnectionId === remoteAdapter.owner.connectionId && scope.workspaceIdentity === JSON.stringify(['remote', remoteAdapter.owner.connectionId, remoteAdapter.owner.workspaceIdentity]) ? remoteAdapter : undefined}
        primaryBinding={{ sessionId: activeId, scope: { ...(choices.remote ? { remoteConnectionId: choices.remote, workspaceIdentity: remoteAdapter?.owner.connectionId === choices.remote ? JSON.stringify(['remote', remoteAdapter.owner.connectionId, remoteAdapter.owner.workspaceIdentity]) : `remote:unconfirmed:${choices.remote}` } : {}), workspaceRoot: (session?.id === activeId ? session.root : liveSessions.find(item => item.id === activeId)?.root) ?? composer.primaryPaneRoot } }}
        initialRunOptions={choices} filesEffective={isPluginEffective('files')} settingsEffective={isPluginEffective('settings')}
        effectivePluginIds={pluginAvailability.effectiveIds} sendShortcut={settingsValues.sendShortcut === 'mod-enter' ? 'mod-enter' : 'enter'}
        shortcutBindings={shortcutBindings} sessions={liveSessions} onSelectPrimary={panes.selectPrimaryPaneSession} registerSelection={panes.registerPaneSelection} registerCreation={panes.registerPaneCreation} consumeSelectionIntent={panes.consumePaneSelectionIntent}>
      {activeId && session?.id !== activeId ? (
        <div role="status" className="xn-hero"><p>{tr("正在加载任务…")}</p></div>
      ) : session ? (
        <div className="xn-conversation-container">
          <WorkbenchConversation session={session} activeId={activeId} isPluginEffective={isPluginEffective} effectivePluginIds={pluginAvailability.effectiveIds}
            isSessionsEffective={isSessionsEffective} settingsValues={settingsValues} lightweightLayout={lightweightLayout} activeRuntimeProfile={activeRuntimeProfile}
            runtimeMonitorSession={runtimeMonitorSession} choices={choices} selectedComposerModel={selectedComposerModel} activeSessionRunning={activeSessionRunning}
            activity={activity} data={data} runActions={runActions} queue={queue} livePermissions={livePermissions} setPanel={setPanel} selectSession={selectSession}
            handleRefreshAll={handleRefreshAll} handleSelectFile={filesPanel.handleSelectFile} beginFork={fork.beginFork}
            onAddSelection={fork.handleAddSelectionToCurrentTask} onAskSelection={fork.handleAskSelectionInSideChat} appendTextToComposer={appendTextToComposer}
            shareDialogOpen={shareDialogOpen} setShareDialogOpen={setShareDialogOpen} goalEditorOpen={goalEditorOpen} setGoalEditorOpen={setGoalEditorOpen}
            deliveryEditorRequest={deliveryEditorRequest} contextSidepaneOpen={contextSidepaneOpen} setContextSidepaneOpen={setContextSidepaneOpen}
            commandRoot={commandRoot} workspaceRoot={draftRoot ?? composerCatalog.root} composer={composerShared} composerDisabled={composerDisabled}
            sendDisabled={!composerModelReady || composerCatalogLoading} modelRecovery={composerModelRecovery} onSend={handleSend} />
        </div>
      ) : (
        <div className="xn-empty-state-shell" data-testid="xn-hero">
          <WorkbenchStartView isPluginEffective={isPluginEffective} lightweightLayout={lightweightLayout} claudexAppearance={claudexAppearance} locale={locale}
            viewSwitcher={viewSwitcher} workspaceContext={workspaceContext} composerCatalog={composerCatalog} draftRoot={draftRoot} choices={choices}
            selectedComposerModel={selectedComposerModel} startPageActions={workspace.startPageActions} recentProjects={workspace.recentProjects} liveSessions={liveSessions}
            selectSession={selectSession} chooseWorkspace={chooseWorkspace} remoteDialogOpen={workspace.remoteDialogOpen} setRemoteDialogOpen={setRemoteDialogOpen}
            setRemoteAdapter={workspace.setRemoteAdapter} updateChoices={updateChoices} setPanel={setPanel} busy={busy} runError={runError}
            creatingSession={activity.creatingSession} activeId={activeId} stoppingSessions={stoppingSessions} handleStop={handleStop} sessionCommands={sessionCommands}
            handleRefreshAll={handleRefreshAll} composer={composerShared} workspaceKey={!activeId && preserveDefaultDraftScope ? 'default' : commandRoot || 'default'}
            commandRoot={commandRoot} starterWorkspaceKey={preserveDefaultDraftScope ? 'default' : commandRoot || 'default'} composerModelReady={composerModelReady}
            composerCatalogLoading={composerCatalogLoading} composerCatalogError={composerCatalogError} refreshComposerCatalog={refreshComposerCatalog}
            onSend={handleCreate} appendTextToComposer={appendTextToComposer} />
        </div>
      )}
      </SessionPaneWorkbench>}

      </Suspense></RegionBoundary>

      {workspace.workspacePicking && <Suspense fallback={null}><XuenessWorkspacePickerDialog open currentRoot={draftRoot ?? composerCatalog.root} returnFocusTo={workspace.workspacePickerOpener.current}
        mode={workspace.workspacePickerMode}
        onChoose={chooseWorkspace} onCancel={() => workspace.setWorkspacePicking(false)} /></Suspense>}

      {workspace.cloneOpen && isPluginEffective("git") && <Suspense fallback={null}><XuenessCloneDialog open
        defaultParent={(draftRoot ?? composerCatalog.root) ?? null}
        returnFocusTo={workspace.cloneOpener.current}
        onCancel={() => workspace.setCloneOpen(false)}
        onCloned={(root) => { workspace.setCloneOpen(false); void workspace.refreshRecentProjects(); chooseWorkspace(root); }} /></Suspense>}

      {listActions.renameRequest !== null && <Suspense fallback={null}><XuenessRenameDialog
        open
        initialValue={listActions.renameRequest.initialValue}
        returnFocusTo={listActions.renameOpenerRef.current}
        onCancel={() => listActions.setRenameRequest(null)}
        onConfirm={(value) => {
          const request = listActions.renameRequest;
          listActions.setRenameRequest(null);
          if (request) void listActions.renameById(request.id, value);
        }}
      /></Suspense>}

      {capDialog !== null && <Suspense fallback={null}><XuenessCapabilityDialog
        open
        mode={capDialog.mode}
        kind={capDialog.kind}
        initial={capDialog.initial ?? null}
        busy={capDialogBusy}
        error={capDialogError || undefined}
        onCancel={() => setCapDialog(null)}
        onSubmit={(payload) => void handleCapSubmit(payload)}
      /></Suspense>}
      {runPermission.dialog}
      {fork.forkSource !== null && <Suspense fallback={null}><ForkSessionDialog
        open
        sourceId={fork.forkSource.id}
        sourceTitle={fork.forkSource.title}
        initialTurn={fork.forkSource.turn}
        createFork={fork.createPrimaryFork}
        onCancel={() => fork.setForkSource(null)}
        onFork={fork.completeFork}
      /></Suspense>}
    </Shell>
    </CodeDisplayProvider>
  );
}
