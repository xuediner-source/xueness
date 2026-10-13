import { GoalEditorDialog } from './plugins/planning/GoalEditorDialog';
import { sessionContextUsage } from './plugins/sessions/sessionContextUsage';
import { listPlugins, listResources, listCommandCatalog, setPluginEnabled, post, saveDefaultModelSelection, type XuenessPlugin } from "./xuenessApi";
import { t as tr, tf, useLocale, setLocale } from './i18n';
import { isImeComposingEvent, resolveHostPlatform } from './xuenessShortcutDisplay';
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
 */
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/batch10.css";
import {
  approvePending,
  createSession,
  deleteSession,
  renameSession,
  pinSession,
  deriveFileChanges,
  listSessions,
  loadFilePreview,
  loadFiles,
  loadJournal,
  loadSession,
  runSession,
  sendTurn,
  queueTurn,
  cancelQueuedTurn,
  toTimelineRows,
  hydrateTimelineTools,
  hydrateTimelineJournalRows,
  withInitialUserMessage,
  loadCompleteTimeline,
  withAssistantStream,
  loadConversationSnapshot,
  loadOlderConversationPage,
  mergeTimelineRowsByIdentity,
  stabilizeSession,
  stabilizeSessionList,
  stabilizeTimelineRows,
  type ForkSessionResponse,
  type FileChangeSet,
  type FilePreview,
  type PendingApproval,
  type Result,
  type SessionSummary,
  type TimelineRow,
  type WorkbenchSession,
  type ConversationSnapshot,
} from "./xuenessWorkbench";
import { ArchivedSessions } from './plugins/sessions/ArchivedSessions';
import {
  capabilityPatch,
  loadWorkbenchSettings,
  readAgentCapabilities,
  saveWorkbenchSettings,
  type AgentCapabilities,
  type SettingsMap,
} from "./xuenessSettings";
import {
  createFolder,
  loadDirectory,
  loadHome,
  loadMemoryTracks,
  loadProviders,
  loadUsage,
  type MemoryTrack,
  type ProviderSummary,
  type UsageSummary,
  type XuenessDirectoryListing,
} from "./xuenessWorkspace";
import { getRunChoices, mergeRunChoices, setRunChoices, type RunChoices } from "./xuenessBridge";
import { useRunPermissionConfirmation } from "./plugins/sessions/useRunPermissionConfirmation";
import { effectiveRuntimeProfile, emptyComposerCatalog, prepareComposer, runtimeProfileFromSession, switchComposerBranch, type ComposerCatalog, type ComposerInput, type ComposerModel } from "./xuenessComposer";
import { createComposerCatalogLoader, clearWorkspaceComposerCatalog } from './plugins/sessions/composerCatalogLifecycle';
import { ComposerWorkspaceSelect } from './plugins/sessions/ComposerWorkspaceSelect';
import { XuenessComposerToolbar } from "./plugins/sessions/XuenessComposerToolbar";
import { DesktopTitlebar } from "./plugins/desktop/DesktopTitlebar";
import { DesktopTrayBridge } from './plugins/desktop/DesktopTrayBridge';
import { DesktopNotificationsBridge } from './plugins/desktop/DesktopNotificationsBridge';
import { DesktopNotificationSettings } from './plugins/desktop/DesktopNotificationSettings';
import { settingsNavigation } from "./xuenessSettingsNavigation";
import { CompletionChecks } from './plugins/planning/CompletionChecks';
import { SessionGoal } from './plugins/planning/SessionGoal';
import { LocalRuntimeMonitor, RequestTiming, type LocalRuntimeSession } from "./plugins/providers/LocalRuntimeMonitor";
import {
  LightweightStatusBar,
  evaluateLightweightGlobalKey,
  extractReportedUsage,
  lightweightGlobalKeyContextFromEvent,
  lightweightLayoutActive,
  scrollToTimelineBottom,
} from "./plugins/providers/LightweightWorkbench";
import { ForkSessionDialog } from "./plugins/sessions";
import { SessionQueue } from "./plugins/sessions/SessionQueue";
import { editQueuedMessage, reorderQueuedMessages } from "./plugins/sessions/queueApi";
import { DeliveryUnconfirmedError } from './plugins/sessions/submissionTransport';
import { guideCurrentTurn, reserveQueuedMessageNow, withdrawGuidance } from './plugins/sessions/steeringApi';
import { PendingGuidancePanel, type InputDelivery } from './plugins/sessions/CurrentTurnInput';
import { composerDraftContent, hasComposerDraftContent, notifyComposerDrafts } from './plugins/sessions/composerRecovery';
import { Approvals, Composer, WorkbenchHeader, heroGreeting, persistDraft, type ComposerDraftState } from "./plugins/sessions/XuenessWorkbenchView";
import { XuenessStartPage, type StartPageAction } from "./plugins/sessions/XuenessStartPage";
import { XuenessCloneDialog } from "./plugins/git/XuenessCloneDialog";
import { loadWorkspaceCatalog, type RecentWorkspaceDirectory } from "./xuenessWorkspaces";
import { XuenessUsageQuickCard } from "./plugins/usage/XuenessUsageQuickCard";
import { IconBack, IconGear, IconNewTask, IconSearch, IconWorkflow, IconModel, IconXuenessMark } from "./ui/icons";
import { CalendarClock, Archive, ArrowDownWideNarrow, ChevronsDownUp, Folder, FolderOpen, Hash, MessageCirclePlus, UserRound, CircleHelp, ChevronDown, Blocks, GitBranch, Bot, Server, House, MessagesSquare, Library, Brain, Monitor, SquarePen, PanelRight, Share2 } from "lucide-react";
import { Select } from "./ui/Select";
import { RegionBoundary } from "./ui/primitives";
import { XuenessWorkspaceSettings } from "./plugins/settings/XuenessWorkspaceSettings";
import { XuenessTaskList, type SidebarPreferences } from "./plugins/sessions/XuenessTaskList";
import { CommandPalette } from "./plugins/sessions/CommandPalette";
import { ConversationTimelineViewport, isAwayFromTimelineTail } from "./plugins/sessions/ConversationTimelineViewport";
import { buildSessionScrollMemoryKey, saveSessionScrollMemoryState } from "./plugins/sessions/sessionScrollMemory";
import { useConversationUpdates } from './plugins/sessions/LiveConversation';
import { useRuntimeConversation } from './plugins/runtimes/RuntimeConversation';
import { loadOlderRuntimeConversationPage, runtimeConversationHistory, runtimeConversationSession, runtimeConversationWindow } from './plugins/sessions/runtimeConversationProjection';
import { createSingleFlightRefresh, useSessionPolling } from "./plugins/sessions/SessionPolling";
import { XuenessWorkspacePickerDialog } from "./plugins/settings/XuenessWorkspacePickerDialog";
import { CodeDisplayProvider } from "./ui/CodeContent";
import { SHORTCUT_COMMANDS, resolveShortcutBinding, matchesShortcut, hasGlobalShortcutConflict, type ShortcutEventLike } from "./xuenessShortcutCommands";
import { Shell, SidebarActions, type SidebarAction } from "./XuenessShell";
import { ClaudexSidebarHeader, ClaudexSidebarRail } from "./plugins/sessions/ClaudexSidebar";
import { SidebarResizeHandle, useSessionSidebarWidth } from './plugins/sessions/SidebarResizeHandle';
import { SessionContextPane } from './plugins/sessions/SessionContextPane';
import { TaskTodos } from "./plugins/sessions/XuenessTimeline";
import { ZCodeConversation } from "./plugins/sessions/ZCodeConversation";
import { conversationCompactionBoundary, markArchivedToolRows } from './plugins/sessions/conversationCompaction';
import { ConversationSelectionActions, type ConversationTextSelection } from './plugins/sessions/ConversationSelectionActions';
import { buildConversationFindMatches } from './plugins/sessions/ConversationFind';
import { ConversationShareDialog } from './plugins/sessions/ConversationSharing';
import { updateConversationMessage, parseConversationSnapshot } from './xuenessWorkbench';
import { McpElicitation } from "./plugins/mcp/ElicitationForm";
import { PendingQuestion, QuestionResume } from "./plugins/sessions/PendingQuestion";
import { SessionExperimentSettings } from "./plugins/sessions/SessionExperimentSettings";
import { ToolExecutionSettings, ToolCallBudgetStatus } from "./plugins/tools/ToolExecutionSettings";
import { XuenessRenameDialog } from "./plugins/sessions/XuenessRenameDialog";
import {
  CAPABILITY_KINDS,
  CAPABILITY_LABELS,
  loadCapabilitySection,
  toggleCapabilityItem,
  createCapabilityItem,
  updateCapabilityFields,
  deleteCapabilityItem,
  type CapabilityItem,
  type CapabilityKind,
} from "./xuenessCapabilities";
import { CapabilitiesPanel, type CapabilitySectionProps } from "./XuenessCapabilitiesPanel";
import { XuenessCapabilityDialog } from "./XuenessCapabilityDialog";
import { shouldDismissModalOnEscape, useModalFocusScope } from "./plugins/shared";
import { applyDocumentTheme, applyDocumentColorPalette, normalizeColorPalette } from "./plugins/settings/themeBoot";
import { FeatureUnavailable, PluginHomeEntry, XuenessPluginManager, XuenessPluginSettingsPanel } from "./XuenessPluginManager";
import {
  CAPABILITY_PLUGIN_BY_KIND,
  PLUGIN_PANEL_LABELS,
  derivePluginAvailability,
  type PluginPanel,
} from "./xuenessPluginRegistry";
import {
  loadGitStatus,
  loadGitDiff,
  loadGitLog,
  loadGitCheckpoints,
  initGitRepository,
  stageGitPaths,
  unstageGitPaths,
  commitGitChanges,
  switchGitBranch,
  stashGitChanges,
  createGitCheckpoint,
  restoreGitCheckpoint,
  type GitStatus,
  type GitDiff,
  type GitCommit,
  type GitCheckpoint,
} from "./xuenessGit";

// Static plugin imports load only when their permitted view mounts.
const FileBrowser = lazy(() => import("./plugins/files/FileBrowser").then(module => ({ default: module.FileBrowser })));
const DiffView = lazy(() => import("./plugins/files/DiffView").then(module => ({ default: module.DiffView })));
const DirectoryBrowser = lazy(() => import("./plugins/files/DirectoryBrowser").then(module => ({ default: module.DirectoryBrowser })));
const MemoryPanel = lazy(() => import("./plugins/memory/MemoryPanel").then(module => ({ default: module.MemoryPanel })));
const SettingsSections = lazy(() => import("./plugins/settings/SettingsSections").then(module => ({ default: module.SettingsSections })));
const DesktopAbout = lazy(() => import("./plugins/desktop/DesktopAbout").then(module => ({ default: module.DesktopAbout })));
const DesktopPermissionOnboarding = lazy(() => import("./plugins/onboarding/DesktopPermissionOnboarding").then(module => ({ default: module.DesktopPermissionOnboarding })));
const XuenessSettingsView = lazy(() => import("./plugins/settings/XuenessSettingsView").then(module => ({ default: module.XuenessSettingsView })));
const NetworkSettings = lazy(() => import("./plugins/network/NetworkSettings").then(module => ({ default: module.NetworkSettings })));
const DesktopUpdates = lazy(() => import("./plugins/updates/DesktopUpdates").then(module => ({ default: module.DesktopUpdates })));
const WorkflowPanel = lazy(() => import("./plugins/workflows").then(module => ({ default: module.WorkflowPanel })));
const ModelManager = lazy(() => import("./plugins/providers").then(module => ({ default: module.ModelManager })));
const SubscriptionsPanel = lazy(() => import('./plugins/subscriptions').then(module => ({ default: module.SubscriptionsPanel })));
const ModelMonitorPanel = lazy(() => import('./plugins/model_monitor').then(module => ({ default: module.ModelMonitorPanel })));
const ModelMonitorHome = lazy(() => import('./plugins/model_monitor/ModelMonitorHome').then(module => ({ default: module.ModelMonitorHome })));
const PluginProfilePicker = lazy(() => import("./plugins/extensions/PluginProfilePicker")
  .then(module => ({ default: module.PluginProfilePicker })));
const TerminalPanel = lazy(() => import("./plugins/terminal").then(module => ({ default: module.TerminalPanel })));
const RemoteConnections = lazy(() => import("./plugins/remote").then(module => ({ default: module.RemoteConnections })));
const RuntimeSettingsPanel = lazy(() => import("./plugins/runtimes").then(module => ({ default: module.RuntimeSettingsPanel })));
const XuenessGitView = lazy(() => import("./plugins/git/XuenessGitView").then(module => ({ default: module.XuenessGitView })));
const XuenessMarketplace = lazy(() => import("./plugins/extensions").then(module => ({ default: module.XuenessMarketplace })));
const XuenessAutomationsPanel = lazy(() => import("./plugins/automation").then(module => ({ default: module.XuenessAutomationsPanel })));
const XuenessMcpTools = lazy(() => import("./plugins/mcp").then(module => ({ default: module.XuenessMcpTools })));
const XuenessDiagnosticsPanel = lazy(() => import("./plugins/diagnostics").then(module => ({ default: module.XuenessDiagnosticsPanel })));
const XuenessMemoryEditor = lazy(() => import("./plugins/memory").then(module => ({ default: module.XuenessMemoryEditor })));
const XuenessMemorySettings = lazy(() => import("./plugins/memory/MemorySettings").then(module => ({ default: module.XuenessMemorySettings })));
const XuenessUsageSettings = lazy(() => import("./plugins/usage/XuenessUsageSettings").then(module => ({ default: module.XuenessUsageSettings })));
const BrowserSettings = lazy(() => import("./plugins/browser/BrowserSettings").then(module => ({ default: module.BrowserSettings })));
const XuenessSubagentSettings = lazy(() => import("./plugins/subagents/SubagentSettings").then(module => ({ default: module.XuenessSubagentSettings })));
const SubagentSidePane = lazy(() => import("./plugins/subagents/SubagentSidePane").then(module => ({ default: module.SubagentSidePane })));

/** Settings defaults. Capabilities default OFF and are read fail-closed. */
const SETTINGS_DEFAULTS: SettingsMap = {
  allowMcp: false,
  allowSubagents: false,
  allowHooks: false,
  subagentCancelOneEnabled: false,
  theme: "system",
  colorPalette: "xueness",
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  autoScroll: true,
  showTodos: true,
  collapseTools: true,
  browserControlEnabled: false,
  sendShortcut: "enter",
  terminalFontSize: 13,
  toolGroupingExploreEnabled: true,
  toolGroupingTerminalEnabled: true,
  toolGroupingChangesEnabled: false,
  taskAutoArchiveEnabled: false,
  taskAutoArchiveOlderThanDays: 7,
  bindings: {},
};

export type WorkbenchGlobalKeyAction =
  | { type: "new-session" }
  | { type: "command-palette" }
  | { type: "open-settings" }
  | { type: "toggle-sidebar" }
  | { type: "refresh-session" }
  | null;

export function evaluateWorkbenchGlobalKey(
  event: ShortcutEventLike & { target?: unknown; defaultPrevented?: boolean },
  context: {
    bindings?: Record<string, string>;
    isPluginEffective: (id: string) => boolean;
    panel?: string;
    busy?: boolean;
    platform?: string;
  },
): WorkbenchGlobalKeyAction {
  if (event.defaultPrevented || isImeComposingEvent(event) || event.repeat) return null;
  const bindings = (context.bindings && typeof context.bindings === "object" ? context.bindings : {}) as Record<string, string>;
  const command = SHORTCUT_COMMANDS.find((item) => {
    const binding = resolveShortcutBinding(item.id, bindings);
    return Boolean(binding && matchesShortcut(event, binding, context.platform));
  });
  if (!command) return null;
  if (hasGlobalShortcutConflict(event, command.id, event.target, context.platform)) return null;
  if ((command.id === "new-session" || command.id === "command-palette") && !context.isPluginEffective("sessions")) return null;
  if (command.id === "open-settings" && !context.isPluginEffective("settings")) return null;
  if (command.id === "toggle-sidebar" && context.panel === "settings") return null;
  if (command.id === "refresh-session" && context.busy) return null;
  return { type: command.id };
}

type Panel =
  | 'subscriptions'
  | 'model-monitor'
  | "chat"
  | "files"
  | "changes"
  | "git"
  | "directory"
  | "providers"
  | "remote"
  | "usage"
  | "memory"
  | "capabilities"
  | "settings"
  | "workflows"
  | "terminal"
  | "automations"
  | "marketplace"
  | "diagnostics"
  | "subagents"
  | "plugins"
  | "runtimes";

const PANEL_LABELS = (): Record<Panel, string> => ({
  ...Object.fromEntries(Object.entries(PLUGIN_PANEL_LABELS).map(([id, label]) => [id, tr(label)])) as Record<PluginPanel, string>,
  plugins: tr("插件管理"),
});

function trackSessionId(
  ref: React.MutableRefObject<Set<string>>,
  setValue: (value: Set<string>) => void,
  id: string,
  present: boolean,
): void {
  if (!id || ref.current.has(id) === present) return;
  const next = new Set(ref.current);
  if (present) next.add(id);
  else next.delete(id);
  ref.current = next;
  setValue(next);
}

export function shouldIgnoreSessionResponse(
  requestSessionId: string | null,
  activeSessionId: string | null,
  isMounted = true,
  signal?: AbortSignal,
): boolean {
  if (!isMounted) return true;
  if (signal?.aborted) return true;
  return requestSessionId !== activeSessionId;
}

export function createCleanSessionTransientState() {
  return {
    files: [] as { path: string; size: number }[],
    filesTruncated: false,
    selectedPath: null as string | null,
    preview: null as FilePreview | null,
    previewError: "",
    changeSet: null as FileChangeSet | null,
    changesError: "",
    gitStatus: null as GitStatus | null,
    gitStatusError: "",
    gitDiff: null as GitDiff | null,
    gitDiffError: "",
    gitLog: null as GitCommit[] | null,
    gitLogError: "",
    gitCheckpoints: [] as GitCheckpoint[],
    gitCheckpointError: "",
    runError: "",
  };
}

function selectedTextPrompt(sourceTitle: string, turnId: string, text: string, sideChat = false): string {
  const turnNumber = /^turn-([1-9][0-9]*)$/u.exec(turnId)?.[1] ?? turnId;
  const quote = text.split(/\r?\n/u).map(line => `> ${line}`).join('\n');
  const heading = sideChat
    ? tf('请围绕“{0}”第 {1} 轮中的选段提问：', [sourceTitle, turnNumber])
    : tf('引用自“{0}”第 {1} 轮：', [sourceTitle, turnNumber]);
  return `${heading}\n\n${quote}`;
}

function rowsFromConversationSnapshot(snapshot: ConversationSnapshot): TimelineRow[] {
  const journal = snapshot.journal;
  const history = Array.isArray(journal.reasoning_history)
    ? journal.reasoning_history as {message_index: number; text: string}[]
    : snapshot.session.reasoning_history ?? [];
  const rows = withInitialUserMessage(
    hydrateTimelineJournalRows(
      hydrateTimelineTools(toTimelineRows(snapshot.timeline.events), journal),
      journal,
      history,
    ),
    journal,
    snapshot.session.task,
  );
  return markArchivedToolRows(rows, journal);
}

export function XuenessWorkbenchContainer() {
  const locale = useLocale();
  useEffect(() => { document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"; }, [locale]);
  const [pluginCatalog, setPluginCatalog] = useState<XuenessPlugin[]>([]);
  const [pluginCatalogLoading, setPluginCatalogLoading] = useState(true);
  const [pluginCatalogReady, setPluginCatalogReady] = useState(false);
  const [pluginCatalogError, setPluginCatalogError] = useState("");
  const isPluginEffective = useCallback(
    (id: string) => pluginCatalogReady && pluginCatalog.some((plugin) => plugin.id === id && plugin.effective),
    [pluginCatalog, pluginCatalogReady],
  );
  // In-flight and queued reads must consult the current catalog, not an old closure.
  const pluginEffectiveRef = useRef(isPluginEffective);
  pluginEffectiveRef.current = isPluginEffective;

  const mountedRef = useRef(true);
  const activeAbortRef = useRef<AbortController | null>(null);
  const filesAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const changesAbortRef = useRef<AbortController | null>(null);
  const gitAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      activeAbortRef.current?.abort();
      filesAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      changesAbortRef.current?.abort();
      gitAbortRef.current?.abort();
      listAbortRef.current?.abort();
    };
  }, []);

  const refreshPluginCatalog = useCallback(async () => {
    setPluginCatalogLoading(true);
    try {
      const result = await listPlugins();
      if (!mountedRef.current) return;
      setPluginCatalog(result.plugins);
      setPluginCatalogError("");
    } catch (reason) {
      if (!mountedRef.current) return;
      setPluginCatalog([]);
      setPluginCatalogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current) {
        setPluginCatalogReady(true);
        setPluginCatalogLoading(false);
      }
    }
  }, []);
  const togglePlugin = useCallback(async (id: string, enabled: boolean) => {
    try {
      const result = await setPluginEnabled(id, enabled);
      if (!mountedRef.current) return;
      setPluginCatalog(result.plugins);
      setPluginCatalogError("");
      setPluginCatalogReady(true);
    } catch (reason) {
      if (mountedRef.current) {
        await refreshPluginCatalog();
      }
      throw reason;
    }
  }, [refreshPluginCatalog]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('session')?.trim() || null;
  });
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const composerDraftStore = useRef(new Map<string, ComposerDraftState>());
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const sessionSnapshotRef = useRef(session);
  sessionSnapshotRef.current = session;
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [conversationFindRequest, setConversationFindRequest] = useState<{sessionId: string; id: string; query: string} | null>(null);
  const [olderTranscript, setOlderTranscript] = useState<{sessionId: string; hasOlder: boolean; loading: boolean; error: string}>({
    sessionId: '', hasOlder: false, loading: false, error: '',
  });
  const olderRowsRef = useRef<{sessionId: string; rows: TimelineRow[]; before: number} | null>(null);
  const transcriptWindowRef = useRef<{sessionId: string; start: number; total: number; revision: string} | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  const [forkSource, setForkSource] = useState<{ id: string; title: string; turn?: number; root?: string; selectedText?: string; selectedTurnId?: string } | null>(null);
  const [error, setError] = useState("");
  const [dataErrors, setDataErrors] = useState({ list: "", active: "" });
  const [runError, setRunError] = useState("");
  const [busy, setBusy] = useState(false);
  const [executingSessions, setExecutingSessions] = useState<Set<string>>(() => new Set());
  const executingSessionsRef = useRef(new Set<string>());
  const [runRequestSessions, setRunRequestSessions] = useState<Set<string>>(() => new Set());
  const runRequestSessionsRef = useRef(new Set<string>());
  const [creatingSession, setCreatingSession] = useState(false);
  const createGenerationRef = useRef(0);
  const activeCreateRef = useRef<number | null>(null);
  const [stoppingSessions, setStoppingSessions] = useState<Set<string>>(() => new Set());
  const stoppingSessionsRef = useRef(new Set<string>());
  const [queueSubmittingSessions, setQueueSubmittingSessions] = useState<Set<string>>(() => new Set());
  const queueSubmittingSessionsRef = useRef(new Set<string>());
  const [queueContinuingSessions, setQueueContinuingSessions] = useState<Set<string>>(() => new Set());
  const queueContinuingSessionsRef = useRef(new Set<string>());
  const [queueCancelling, setQueueCancelling] = useState<{ sessionId: string; queueId: string } | null>(null);
  const [queueError, setQueueError] = useState<{ sessionId: string; message: string } | null>(null);
  const [panel, setPanel] = useState<Panel>("chat");
  const history = useRef<{ panel: Panel; activeId: string | null }[]>([{ panel: "chat", activeId: null }]);
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarToggleToken, setSidebarToggleToken] = useState(0);
  const [choices, setChoices] = useState<RunChoices>(getRunChoices);
  const [composerCatalog, setComposerCatalog] = useState<ComposerCatalog>(emptyComposerCatalog);
  const [composerCatalogLoading, setComposerCatalogLoading] = useState(false);
  const [composerCatalogError, setComposerCatalogError] = useState("");
  const [draftRoot, setDraftRoot] = useState<string | undefined>();
  const [isolatedWorkspace, setIsolatedWorkspace] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspacePickerMode, setWorkspacePickerMode] = useState<"workspace" | "project">("workspace");
  const workspacePickerOpener = useRef<HTMLElement | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const cloneOpener = useRef<HTMLElement | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentWorkspaceDirectory[] | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [composerRequests] = useState(() => createComposerCatalogLoader());
  const [composerRefreshTick, setComposerRefreshTick] = useState(0);
  const defaultModelChosen = useRef(false);
  const initialBrowserPreferenceLoaded = useRef(false);
  const settingsHaveLoaded = useRef(false);
  const loadedSessionChoices = useRef<string | null>(null);
  const [heroFocusTick, setHeroFocusTick] = useState(0);
  const [taskSearch, setTaskSearch] = useState("");
  const [grouped, setGrouped] = useState(false);
  // 斜杠命令候选：与能力面板同源的 commands 资源。
  const [commandItems, setCommandItems] = useState<{ id: string; description?: string }[]>([]);
  const [contextSidepaneOpen, setContextSidepaneOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  useEffect(() => { setShareDialogOpen(false); }, [activeId]);

  const pluginAvailability = derivePluginAvailability(pluginCatalog, pluginCatalogReady);
  const allowedPanels: Panel[] = ["plugins", ...pluginAvailability.panels];
  const canShowPanel = (target: Panel) => target === "plugins" || allowedPanels.includes(target);

  // Capabilities panel: one slot per resource kind, loaded on panel open.
  type CapSlot = {
    items: CapabilityItem[];
    loading: boolean;
    error: string;
    userScopeAvailable: boolean;
    userScopeReason: string;
  };
  const emptyCapSlot: CapSlot = {
    items: [],
    loading: false,
    error: "",
    userScopeAvailable: true,
    userScopeReason: "",
  };
  const [capSlots, setCapSlots] = useState<Record<CapabilityKind, CapSlot>>(
    () => Object.fromEntries(CAPABILITY_KINDS.map((k) => [k, { ...emptyCapSlot }])) as Record<CapabilityKind, CapSlot>,
  );
  const [capBusyId, setCapBusyId] = useState<string | null>(null);

  // Files panel
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  selectedPathRef.current = selectedPath;
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState("");

  // Changes panel (journal-derived, not a disk diff)
  const [changeSet, setChangeSet] = useState<FileChangeSet | null>(null);
  const [changesError, setChangesError] = useState("");

  // Git panel status, history, checkpoints, and explicitly confirmed local actions.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitStatusError, setGitStatusError] = useState("");
  const [gitDiff, setGitDiff] = useState<GitDiff | null>(null);
  const [gitDiffError, setGitDiffError] = useState("");
  const [gitLog, setGitLog] = useState<GitCommit[] | null>(null);
  const [gitLogError, setGitLogError] = useState("");
  const [gitCheckpoints, setGitCheckpoints] = useState<GitCheckpoint[]>([]);
  const [gitCheckpointError, setGitCheckpointError] = useState("");
  const [gitLoading, setGitLoading] = useState(false);
  const [gitActionBusy, setGitActionBusy] = useState(false);

  // Settings panel
  const [settingsValues, setSettingsValues] = useState<SettingsMap>(SETTINGS_DEFAULTS);
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches));
  const [capabilities, setCapabilities] = useState<AgentCapabilities>({
    allowMcp: false,
    allowSubagents: false,
    allowHooks: false,
  });
  const [settingsError, setSettingsError] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSection, setSettingsSection] = useState("general");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Directory panel (host-side browse; the browser shell has no native folder dialog)
  const [dirListing, setDirListing] = useState<XuenessDirectoryListing | null>(null);
  const [dirError, setDirError] = useState("");
  const [dirLoading, setDirLoading] = useState(false);

  // Providers / usage / memory panels
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providersError, setProvidersError] = useState("");
  const [providersLoading, setProvidersLoading] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const [tracks, setTracks] = useState<MemoryTrack[]>([]);
  const [tracksError, setTracksError] = useState("");
  const [tracksLoading, setTracksLoading] = useState(false);

  const heroInputRef = useRef<HTMLTextAreaElement | null>(null);
  const commandRef = useRef<HTMLInputElement | null>(null);
  const commandDialogRef = useRef<HTMLDivElement | null>(null);
  const commandOpenerRef = useRef<HTMLElement | null>(null);
  const commandPaletteEnabled = commandOpen && isPluginEffective("sessions");
  useModalFocusScope({
    open: commandPaletteEnabled,
    dialogRef: commandDialogRef,
    initialFocusRef: commandRef,
    returnFocusTo: commandOpenerRef.current,
  });

  const openCommandPalette = useCallback((returnFocusTo?: HTMLElement | null) => {
    if (!isPluginEffective("sessions") || commandOpen) return;
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Search closes the narrow sidebar. Return focus to its visible toggle.
    commandOpenerRef.current = opener?.closest('#xn-shell-sidebar') && window.matchMedia('(max-width: 900px)').matches
      ? document.querySelector<HTMLButtonElement>('[data-testid="xn-desktop-titlebar-sidebar"], [data-testid="xn-shell-sidebar-toggle"]')
      : opener;
    setCommandOpen(true);
  }, [commandOpen, isPluginEffective]);

  const refreshListSnapshot = useCallback(async () => {
    if (!pluginEffectiveRef.current("sessions")) {
      setSessions([]);
      return;
    }
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const res = await listSessions(controller.signal);
    if (!mountedRef.current || !pluginEffectiveRef.current("sessions") || controller.signal.aborted) return;
    if (res.ok) {
      setSessions(prev => stabilizeSessionList(prev, res.value));
      if (stoppingSessionsRef.current.size > 0) {
        const runningIds = new Set(res.value.filter(s => s.status === "running").map(s => s.id));
        for (const id of Array.from(stoppingSessionsRef.current)) {
          if (!runningIds.has(id)) {
            trackSessionId(stoppingSessionsRef, setStoppingSessions, id, false);
          }
        }
      }
    }
    setDataErrors(previous => {
      const nextList = res.ok ? "" : res.error;
      return previous.list === nextList ? previous : { ...previous, list: nextList };
    });
  }, [isPluginEffective]);
  const listLoaderRef = useRef(refreshListSnapshot);
  listLoaderRef.current = refreshListSnapshot;
  const refreshList = useMemo(() => createSingleFlightRefresh(() => listLoaderRef.current()), []);

  const appendTextToComposer = useCallback((targetSessionId: string, text: string, workspaceRoot?: string) => {
    const root = workspaceRoot ?? (sessionSnapshotRef.current?.id === targetSessionId
      ? sessionSnapshotRef.current.root ?? draftRoot ?? composerCatalog.root
      : draftRoot ?? composerCatalog.root);
    const workspaceKey = root || 'default';
    const draftKey = `session:${targetSessionId}`;
    const scopedKey = `${workspaceKey}:${draftKey}`;
    const current = composerDraftStore.current.get(scopedKey) ?? {
      text: '', attachments: [], goal: false,
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 0,
    };
    const previousText = current.text.trimEnd();
    const next: ComposerDraftState = {
      ...current,
      text: previousText ? `${previousText}\n\n${text}` : text,
      submissionError: '',
      revision: current.revision + 1,
    };
    composerDraftStore.current.set(scopedKey, next);
    persistDraft(workspaceKey, draftKey, next);
    notifyComposerDrafts(composerDraftStore);
    if (activeIdRef.current === targetSessionId) {
      window.requestAnimationFrame(() => {
        const input = heroInputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }, [draftRoot, composerCatalog.root]);

  const handleAddSelectionToCurrentTask = useCallback((selection: ConversationTextSelection) => {
    const targetSessionId = activeId;
    const current = sessionSnapshotRef.current;
    if (!targetSessionId || !current || current.id !== targetSessionId || !isPluginEffective('sessions')) return;
    appendTextToComposer(targetSessionId, selectedTextPrompt(current.title || current.task, selection.turnId, selection.text));
  }, [activeId, appendTextToComposer, isPluginEffective]);

  const handleAskSelectionInSideChat = useCallback((selection: ConversationTextSelection) => {
    const targetSessionId = activeId;
    const current = sessionSnapshotRef.current;
    if (!targetSessionId || !current || current.id !== targetSessionId || !isPluginEffective('sessions')
      || current.status === 'running' || current.streaming?.status === 'streaming' || busy) return;
    const turn = /^turn-([1-9][0-9]*)$/u.exec(selection.turnId);
    setForkSource({ id: targetSessionId, title: current.title || current.task || tr('未命名任务'),
      ...(current.root ? { root: current.root } : {}), ...(turn ? { turn: Number(turn[1]) } : {}),
      selectedText: selection.text, selectedTurnId: selection.turnId });
  }, [activeId, busy, isPluginEffective]);

  const beginFork = useCallback((turn?: number) => {
    const isRunning = session?.status === "running" || session?.streaming?.status === "streaming";
    if (!activeId || session?.id !== activeId || busy || isRunning || !isPluginEffective("sessions")) return;
    setForkSource({ id: activeId, title: session.title || session.task || tr("未命名任务"), turn });
  }, [activeId, session, busy, isPluginEffective]);

  const selectSession = useCallback((id: string) => {
    // 切换前保存当前会话的滚动记忆：视口在用户滚动时已持续保存，这里补一次，
    // 确保程序化滚动（如流式贴底）后的位置也不丢失。恢复由视口在挂载时按
    // sessionId 自行完成（见 sessionScrollMemory）。
    const scroller = document.querySelector<HTMLElement>('[data-testid="session-timeline-scroller"]');
    const memoryKey = buildSessionScrollMemoryKey({ sessionId: activeIdRef.current });
    if (scroller && memoryKey) {
      saveSessionScrollMemoryState(memoryKey, {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        wasPinnedToBottom: !isAwayFromTimelineTail(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight),
        updatedAt: Date.now(),
      });
    }
    setRunError("");
    setPanel("chat");
    setActiveId(id);
  }, []);

  const selectTraySession = useCallback((id: string) => {
    if (id === activeId) setPanel('chat');
    else selectSession(id);
  }, [activeId, selectSession]);

  const completeFork = useCallback((result: ForkSessionResponse) => {
    const source = forkSource;
    setForkSource(null);
    if (!source || result.sourceId !== source.id) return;
    const child = result.session;
    const title = child.title || tr("未命名任务");
    if (source.selectedText) {
      appendTextToComposer(child.id, selectedTextPrompt(source.title, source.selectedTurnId ?? `turn-${source.turn ?? 1}`, source.selectedText, true), child.root ?? source.root);
    }
    setSessions(previous => [{ id: child.id, task: title, title, status: child.status, root: child.root }, ...previous.filter(item => item.id !== child.id)]);
    void refreshList();
    // The modal is bound to its opening session. A slow fork must not steal focus
    // if the user has navigated to a different conversation in the meantime.
    if (activeIdRef.current !== source.id) return;
    loadedSessionChoices.current = null;
    setRunError("");
    setPanel("chat");
    setActiveId(child.id);
  }, [forkSource, refreshList, appendTextToComposer]);

  const runtimeConversation = useRuntimeConversation(activeId, isPluginEffective('sessions') && isPluginEffective('runtimes'));
  const usesRuntimeProjection = isPluginEffective('sessions') && isPluginEffective('runtimes')
    && runtimeConversation.state?.status !== 'unavailable';
  const runtimeConversationRef = useRef({enabled: usesRuntimeProjection, refresh: runtimeConversation.refresh});
  runtimeConversationRef.current = {enabled: usesRuntimeProjection, refresh: runtimeConversation.refresh};
  const acceptedRuntimeEpoch = useRef<{id: string; epoch: string; prefixRevision: string} | null>(null);
  const acceptedSnapshotRevision = useRef<{id: string; revision: number} | null>(null);
  const loadActiveSnapshot = useCallback(async (id: string, includeFiles = true, pushedSnapshot?: unknown) => {
    if (!pluginEffectiveRef.current("sessions") || id !== activeIdRef.current) return;
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    if (runtimeConversationRef.current.enabled) {
      await runtimeConversationRef.current.refresh();
      if (includeFiles && pluginEffectiveRef.current('files')) {
        const listing = await loadFiles(id, controller.signal);
        if (!shouldIgnoreSessionResponse(id, activeIdRef.current, mountedRef.current, controller.signal)
            && pluginEffectiveRef.current('files') && listing.ok) {
          setFiles(listing.value.files);
          setFilesTruncated(listing.value.truncated);
        }
      }
      return;
    }
    // Detail carries pending/approved/changed_files; the timeline carries the
    // real tool_call/tool_result sequence. Both come from the server; neither is
    // reconstructed client-side.
    const snapshot = pushedSnapshot === undefined ? await loadConversationSnapshot(id, controller.signal, {tail: 80})
      : {ok: true as const, value: parseConversationSnapshot(id, pushedSnapshot)};
    const detail = snapshot.ok ? {ok: true as const, value: snapshot.value.session} : snapshot;
    const timeline = snapshot.ok ? {ok: true as const, value: snapshot.value.timeline} : snapshot;
    const journal = snapshot.ok ? {ok: true as const, value: snapshot.value.journal} : snapshot;
    if (shouldIgnoreSessionResponse(id, activeIdRef.current, mountedRef.current, controller.signal) || !pluginEffectiveRef.current("sessions")) return;
    if (snapshot.ok) {
      const revision = snapshot.value.window?.historyRevision ?? snapshot.value.journal.history_revision;
      if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
        const accepted = acceptedSnapshotRevision.current;
        if (accepted?.id === id && accepted.revision > revision) return;
        acceptedSnapshotRevision.current = {id, revision};
      }
      const window = snapshot.value.window;
      if (window) {
        if (olderRowsRef.current?.sessionId !== id) {
          olderAbortRef.current?.abort();
          olderRowsRef.current = {sessionId: id, rows: [], before: window.start};
        }
        transcriptWindowRef.current = {sessionId: id, start: window.start, total: window.total,
          revision: window.messageRevision};
      } else {
        olderRowsRef.current = {sessionId: id, rows: [], before: 0};
        transcriptWindowRef.current = null;
      }
    }
    if (detail.ok) {
      setSession(prev => stabilizeSession(prev, detail.value));
      if (detail.value.status !== "running" && detail.value.streaming?.status !== "streaming") {
        trackSessionId(stoppingSessionsRef, setStoppingSessions, id, false);
      }
    }
    if (snapshot.ok && timeline.ok) {
      const nextRows = rowsFromConversationSnapshot(snapshot.value);
      const prefix = olderRowsRef.current?.sessionId === id ? olderRowsRef.current : null;
      const mergedRows = mergeTimelineRowsByIdentity(prefix?.rows ?? [], nextRows);
      setRows(prevRows => stabilizeTimelineRows(prevRows, mergedRows));
      const hasOlder = prefix ? prefix.before > 0 : Boolean(snapshot.value.window?.hasOlder);
      setOlderTranscript(previous => ({sessionId: id, hasOlder,
        loading: previous.sessionId === id && previous.loading, error: previous.sessionId === id ? previous.error : ''}));
    }
    setDataErrors(previous => {
      const nextActive = !detail.ok ? detail.error : !timeline.ok ? timeline.error : "";
      return previous.active === nextActive ? previous : { ...previous, active: nextActive };
    });
    // @ 文件提及候选：会话工作区文件列表（失败静默，composer 不出建议）。
    if (includeFiles && pluginEffectiveRef.current("files")) {
      const listing = await loadFiles(id, controller.signal);
      if (shouldIgnoreSessionResponse(id, activeIdRef.current, mountedRef.current, controller.signal) || !pluginEffectiveRef.current("files")) return;
      if (listing.ok) {
        setFiles(listing.value.files);
        setFilesTruncated(listing.value.truncated);
      }
    }
  }, [isPluginEffective]);
  const loadOlderTranscript = useCallback(async () => {
    const id = activeIdRef.current;
    const latest = transcriptWindowRef.current;
    if (!id || !latest || latest.sessionId !== id || !isPluginEffective('sessions')) return;
    const prefix = olderRowsRef.current?.sessionId === id ? olderRowsRef.current : null;
    const before = prefix ? prefix.before : latest.start;
    if (before <= 0 || olderTranscript.loading) return;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: true, error: ''}));
    const legacyPage = async () => {
      const result = await loadOlderConversationPage(id, before, latest.revision, controller.signal);
      return result.ok && result.value.window ? {ok: true as const,
        value: {window: result.value.window, rows: rowsFromConversationSnapshot(result.value)}}
        : {ok: false as const, error: result.ok ? tr('无法读取更早的会话记录，请刷新后重试。') : result.error};
    };
    const result = runtimeConversationRef.current.enabled
      ? await loadOlderRuntimeConversationPage(id, before, latest.revision, controller.signal) : await legacyPage();
    if (controller.signal.aborted || activeIdRef.current !== id || !mountedRef.current) return;
    if (!result.ok || !result.value.window) {
      setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: false,
        error: result.ok ? tr('无法读取更早的会话记录，请刷新后重试。') : result.error}));
      return;
    }
    const current = transcriptWindowRef.current;
    if (current?.sessionId !== id || current.revision !== result.value.window.messageRevision) {
      setOlderTranscript(previous => ({sessionId: id, hasOlder: true, loading: false,
        error: tr('会话内容已变化，请重试加载。')}));
      return;
    }
    const pageRows = result.value.rows;
    const nextPrefix = mergeTimelineRowsByIdentity(pageRows, prefix?.rows ?? []);
    olderRowsRef.current = {sessionId: id, rows: nextPrefix, before: result.value.window.start};
    setRows(previous => stabilizeTimelineRows(previous,
      mergeTimelineRowsByIdentity(nextPrefix, previous)));
    setOlderTranscript({sessionId: id, hasOlder: result.value.window.hasOlder,
      loading: false, error: ''});
  }, [isPluginEffective, olderTranscript.loading]);
  const activeLoaderRef = useRef(loadActiveSnapshot);
  activeLoaderRef.current = loadActiveSnapshot;
  const loadActive = useMemo(() => {
    const refresh = createSingleFlightRefresh((id: string, includeFiles?: boolean) => activeLoaderRef.current(id, includeFiles));
    return (id: string, includeFiles?: boolean) => id === activeIdRef.current ? refresh(id, includeFiles) : Promise.resolve();
  }, []);

  const pollActiveSession = useCallback(() => activeId ? loadActive(activeId, false) : Promise.resolve(), [activeId, loadActive]);
  useEffect(() => {
    if (conversationFindRequest?.sessionId !== activeId || session?.id !== activeId
        || !conversationFindRequest.query || olderTranscript.sessionId !== activeId
        || !olderTranscript.hasOlder || olderTranscript.loading || olderTranscript.error
        || buildConversationFindMatches(rows, conversationFindRequest.query).length) return;
    void loadOlderTranscript();
  }, [conversationFindRequest, activeId, session?.id, olderTranscript, rows, loadOlderTranscript]);
  const activeSessionNeedsPolling = Boolean(activeId && (
    busy || stoppingSessions.has(activeId) || runRequestSessions.has(activeId)
    || session?.status === "running" || session?.streaming?.status === "streaming"
  ));
  const acceptPushedSnapshot = useCallback((value: unknown) => {
    const id = activeIdRef.current;
    if (id) {
      parseConversationSnapshot(id, value);
      void activeLoaderRef.current(id, false, value).catch(() => {
        if (activeIdRef.current === id) setDataErrors(previous => ({...previous, active: tr('会话更新失败，请刷新后重试。')}));
      });
    }
  }, []);
  useEffect(() => {
    const snapshot = runtimeConversation.state?.snapshot;
    if (!usesRuntimeProjection || !snapshot || snapshot.sessionId !== activeIdRef.current || !mountedRef.current) return;
    try {
      const detail = runtimeConversationSession(snapshot);
      const window = runtimeConversationWindow(snapshot);
      if (acceptedRuntimeEpoch.current?.id !== snapshot.sessionId || acceptedRuntimeEpoch.current.epoch !== snapshot.logEpoch
        || acceptedRuntimeEpoch.current.prefixRevision !== window.prefixRevision) {
        olderAbortRef.current?.abort();
        olderRowsRef.current = {sessionId: snapshot.sessionId, rows: [], before: window.start};
      }
      acceptedRuntimeEpoch.current = {id: snapshot.sessionId, epoch: snapshot.logEpoch, prefixRevision: window.prefixRevision};
      transcriptWindowRef.current = {sessionId: snapshot.sessionId, start: window.start, total: window.total, revision: window.messageRevision};
      setSession(previous => stabilizeSession(previous, detail));
      const prefix = olderRowsRef.current?.sessionId === snapshot.sessionId ? olderRowsRef.current : null;
      setRows(previous => stabilizeTimelineRows(previous, runtimeConversationHistory(snapshot, prefix?.rows ?? [])));
      setOlderTranscript(previous => ({sessionId: snapshot.sessionId, hasOlder: prefix ? prefix.before > 0 : window.hasOlder,
        loading: previous.sessionId === snapshot.sessionId && previous.loading,
        error: previous.sessionId === snapshot.sessionId ? previous.error : ''}));
      setDataErrors(previous => ({...previous, active: runtimeConversation.state?.status === 'recovering'
        ? tr('会话更新失败，请刷新后重试。') : ''}));
    } catch (error) {
      setDataErrors(previous => ({...previous, active: error instanceof Error ? error.message : String(error)}));
    }
  }, [runtimeConversation.state, usesRuntimeProjection]);
  const liveConversationConnected = useConversationUpdates(activeId, isPluginEffective("sessions") && !usesRuntimeProjection, acceptPushedSnapshot);
  useSessionPolling(isPluginEffective("sessions") && Boolean(activeId) && !usesRuntimeProjection && !liveConversationConnected, pollActiveSession,
    activeSessionNeedsPolling || !session || Boolean(dataErrors.active) ? 1000 : 15000);
  useEffect(() => {
    if (session?.id === activeId && session?.status !== "running" && session?.streaming?.status !== "streaming") {
      trackSessionId(stoppingSessionsRef, setStoppingSessions, activeId, false);
    }
  }, [activeId, session?.id, session?.status, session?.streaming?.status]);

  const anySessionRunning = sessions.some(s => s.status === "running");
  useSessionPolling(isPluginEffective("sessions"), refreshList,
    executingSessions.size > 0 || runRequestSessions.size > 0 || stoppingSessions.size > 0 || anySessionRunning || dataErrors.list ? 2000 : 15000);

  useEffect(() => {
    void refreshPluginCatalog();
  }, [refreshPluginCatalog]);

  useEffect(() => {
    if (!pluginCatalogReady) return;
    if (isPluginEffective("sessions")) void refreshList();
    else {
      setSessions([]);
      setActiveId(null);
      setSession(null);
      setRows([]);
      setDataErrors({ list: "", active: "" });
    }
  }, [pluginCatalogReady, pluginCatalog, isPluginEffective, refreshList]);

  // 斜杠命令候选取自 `xueness commands list` 的同一份合并清单：内建提示命令、文件命令与
  // 资源条目在后端一次汇合，被遮蔽或已停用的行不列出，所以界面不需要维护第二份命令名单。
  // 工作区决定内建命令能否出现（它们必须有写入目标），界面语言决定其描述文案。
  const commandRoot = session?.root ?? draftRoot ?? composerCatalog.root ?? "";
  useEffect(() => {
    if (!pluginCatalogReady || !isPluginEffective("commands")) {
      setCommandItems([]);
      return;
    }
    let settled = false;
    void (async () => {
      try {
        const rows = await listCommandCatalog(commandRoot || undefined, locale);
        if (settled) return;
        setCommandItems(rows.filter(row => !row.shadowed && row.enabled !== false)
          .map(row => ({ id: row.id, description: row.description })));
      } catch {
        if (!settled) setCommandItems([]);
      }
    })();
    return () => { settled = true; };
  }, [pluginCatalogReady, pluginCatalog, isPluginEffective, commandRoot, locale]);

  /** Run an action, surface its error on failure, and report whether to reload. */
  const run = useCallback(async (action: () => Promise<Result<unknown>>) => {
    setBusy(true);
    setError("");
    try {
      const res = await action();
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Session runs are long-lived and must not lock navigation for other chats. */
  const runPermission = useRunPermissionConfirmation(`${activeId ?? 'draft'}:${draftRoot ?? composerCatalog.root ?? ''}`, isPluginEffective('sessions'));
  const runSessionRequest = useCallback(async (id: string, action: (selected: RunChoices) => Promise<Result<unknown>>, selectedChoices?: RunChoices) => {
    const snapshot = sessionSnapshotRef.current;
    const selected = await runPermission.ensure(selectedChoices ?? getRunChoices(), snapshot?.id === id ? snapshot.permission_mode : undefined);
    if (!selected || activeIdRef.current !== id || !pluginEffectiveRef.current('sessions')) return { ok: false };
    setRunChoices(selected);
    setChoices(selected);
    trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, true);
    trackSessionId(executingSessionsRef, setExecutingSessions, id, true);
    if (activeIdRef.current === id) setRunError("");
    try {
      const result = await action(selected);
      if (!result.ok) {
        if (activeIdRef.current === id) setRunError(result.error);
        const accepted = Boolean((result as Result<unknown> & { accepted?: boolean }).accepted);
        return { ok: accepted, accepted, error: result.error, outcomeUnknown: Boolean((result as { outcomeUnknown?: boolean }).outcomeUnknown) };
      }
      return { ok: true };
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      if (activeIdRef.current === id) setRunError(error);
      return { ok: false, error };
    } finally {
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, false);
      trackSessionId(executingSessionsRef, setExecutingSessions, id, false);
    }
  }, [runPermission.ensure]);

  // Run-choice failures surface through this event (bridge dispatches it);
  // Native run choices are supplied by the composer toolbar.
  useEffect(() => {
    const onError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setRunError(message || tr("运行失败，请检查服务器配置与任务状态"));
    };
    window.addEventListener("xueness-run-error", onError);
    return () => window.removeEventListener("xueness-run-error", onError);
  }, []);

  const updateChoices = useCallback((patch: Partial<RunChoices>) => {
    const next = mergeRunChoices(getRunChoices(), patch);
    setRunChoices(next);
    setChoices(next);
    setRunError("");
  }, []);

  useEffect(() => {
    if (!isPluginEffective("skills") && choices.skill_catalog) updateChoices({ skill_catalog: false });
    if (!isPluginEffective("browser") && choices.browser) updateChoices({ browser: false });
  }, [choices.browser, choices.skill_catalog, isPluginEffective, updateChoices]);

  const refreshComposerCatalog = useCallback(async () => {
    if (!isPluginEffective("sessions")) {
      composerRequests.cancel();
      setComposerCatalog(emptyComposerCatalog);
      setComposerCatalogLoading(false);
      return;
    }
    setComposerCatalogError("");
    await composerRequests.load({ root: draftRoot, sessionId: activeId ?? undefined,
      onLoading: setComposerCatalogLoading,
      onCatalog: next => {
        setComposerCatalog(next);
        const current = getRunChoices();
        if (!defaultModelChosen.current && !current.provider_id && !next.models.some(model => model.id === "" && model.configured)) {
          const first = next.models.find(model => model.configured);
          if (first) updateChoices({ provider_id: first.id || undefined, model: undefined, reasoning_effort: undefined });
        }
        defaultModelChosen.current = true;
      },
      onError: reason => {
        setComposerCatalog(clearWorkspaceComposerCatalog);
        setComposerCatalogError(reason instanceof Error ? reason.message : String(reason));
      },
    });
  }, [activeId, draftRoot, isPluginEffective, updateChoices, composerRequests]);
  useEffect(() => { void refreshComposerCatalog(); return () => composerRequests.cancel(); }, [refreshComposerCatalog, composerRequests, composerRefreshTick]);
  // 「设为默认」属于 providers.default_selection：容器只在插件生效时把菜单里的
  // 当前选择转发到既有后端接口，校验与存储都在服务端完成。
  const [defaultSaved, setDefaultSaved] = useState(false);
  // Edit on a model row opens provider settings focused on that saved profile.
  const [providerFocusId, setProviderFocusId] = useState<string | undefined>(undefined);
  const openModelSettings = useCallback((model?: ComposerModel) => {
    setProviderFocusId(model?.id || undefined);
    setPanel(isPluginEffective("providers") ? "providers" : "plugins");
  }, [isPluginEffective]);
  const saveDefaultModel = useCallback(async (model: ComposerModel) => {
    if (!isPluginEffective("providers")) return;
    try {
      const saved = await saveDefaultModelSelection({
        providerId: model.id || null,
        model: choices.model || model.model || null,
        reasoningEffort: choices.reasoning_effort ?? null,
      });
      setDefaultSaved(saved !== null);
    } catch (reason) {
      setDefaultSaved(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [choices.model, choices.reasoning_effort, isPluginEffective]);
  useEffect(() => setDefaultSaved(false), [choices.provider_id, choices.model, choices.reasoning_effort]);
  useEffect(() => {
    if (!session || session.id !== activeId || executingSessions.has(session.id) || loadedSessionChoices.current === session.id) return;
    loadedSessionChoices.current = session.id;
    updateChoices({
      remote: session.remote_connection?.id,
      browser: session.browser_enabled === true && isPluginEffective("browser"),
      ...(session.model_selection ? {
        provider_id: session.model_selection.provider_id || undefined,
        model: session.model_selection.model || undefined,
        reasoning_effort: session.model_selection.reasoning_effort || undefined,
      } : {}),
      runtime_profile: runtimeProfileFromSession(session.runtime_profile)
        ?? (session.runtime_mode === "pi-lite" ? "lightweight" : undefined),
      ...(session.permission_mode ? { permission_mode: session.permission_mode } : {}),
      mode: session.mode === "plan" ? "plan" : "build",
    });
  }, [session, activeId, executingSessions, updateChoices, isPluginEffective]);

  const startNewTask = useCallback(() => {
    setCommandOpen(false);
    setRunError("");
    setActiveId(null);
    setSession(null);
    setDraftRoot(undefined);
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
    if (!commandPaletteEnabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = commandDialogRef.current;
      if (!dialog || Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).at(-1) !== dialog) return;
      // Leave composing Escape to the IME. Other shell listeners have the
      // same guard, so candidate selection cannot dismiss the palette.
      if (!shouldDismissModalOnEscape(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setCommandOpen(false);
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [commandPaletteEnabled]);
  useEffect(() => {
    if (commandOpen && !isPluginEffective("sessions")) setCommandOpen(false);
  }, [commandOpen, isPluginEffective]);
  useEffect(() => {
    if (!activeId && !session) heroInputRef.current?.focus();
  }, [heroFocusTick, activeId, session]);


  useEffect(() => {
    if (settingsValues.language === "zh" || settingsValues.language === "en") setLocale(settingsValues.language);
  }, [settingsValues.language]);

  useEffect(() => {
    document.documentElement.style.setProperty("--xn-ui-font-size", `${Math.min(24, Math.max(12, Number(settingsValues.fontSize) || 14))}px`);
    document.documentElement.dataset.xnTabSize = String([2, 4, 8].includes(Number(settingsValues.tabSize)) ? Number(settingsValues.tabSize) : 2);
    document.documentElement.dataset.xnWordWrap = settingsValues.wordWrap === false ? "off" : "on";
  }, [settingsValues.fontSize, settingsValues.tabSize, settingsValues.wordWrap]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading) return;
    applyDocumentTheme(settingsValues.theme);
  }, [settingsValues.theme, settingsLoading]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading || settingsValues.theme !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (event: MediaQueryListEvent | MediaQueryList) => {
      applyDocumentTheme(settingsValues.theme);
      setSystemDark(event.matches);
    };
    apply(query);
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, [settingsValues.theme, settingsLoading]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading) return;
    applyDocumentColorPalette(settingsValues.colorPalette);
  }, [settingsValues.colorPalette, settingsLoading]);

  useEffect(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    filesAbortRef.current?.abort();
    filesAbortRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    changesAbortRef.current?.abort();
    changesAbortRef.current = null;
    gitAbortRef.current?.abort();
    gitAbortRef.current = null;

    setSession(null);
    setRows([]);
    setDataErrors(previous => ({ ...previous, active: "" }));
    setQueueError(null);
    setQueueCancelling(null);

    const clean = createCleanSessionTransientState();
    setFiles(clean.files);
    setFilesTruncated(clean.filesTruncated);
    setSelectedPath(clean.selectedPath);
    setPreview(clean.preview);
    setPreviewError(clean.previewError);
    setChangeSet(clean.changeSet);
    setChangesError(clean.changesError);
    setGitStatus(clean.gitStatus);
    setGitStatusError(clean.gitStatusError);
    setGitDiff(clean.gitDiff);
    setGitDiffError(clean.gitDiffError);
    setGitLog(clean.gitLog);
    setGitLogError(clean.gitLogError);
    setGitCheckpoints(clean.gitCheckpoints);
    setGitCheckpointError(clean.gitCheckpointError);
    setRunError(clean.runError);
  }, [activeId]);
  useEffect(() => {
    if (activeId) void loadActive(activeId);
  }, [activeId, loadActive, usesRuntimeProjection]);

  const handleApprove = useCallback(
    async (pending: PendingApproval) => {
      const targetSessionId = activeId;
      if (!targetSessionId || runRequestSessionsRef.current.has(targetSessionId) || !isPluginEffective("sessions")) return;
      // Approving only records the grant; the denied call is replayed on the
      // next run. The button says "approve and retry", so actually retry here —
      // otherwise the pending item never clears and the promise is hollow.
      const granted = pending.granted === true || await run(() => approvePending(targetSessionId, pending));
      if (!granted) return;
      await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected));
      await loadActive(targetSessionId);
      await refreshList();
    },
    [activeId, isPluginEffective, run, runSessionRequest, loadActive, refreshList],
  );

  const handleApproveAll = useCallback(
    async (items?: PendingApproval[]) => {
      const targetSessionId = activeId;
      if (!targetSessionId || runRequestSessionsRef.current.has(targetSessionId) || !isPluginEffective("sessions")) return;
      const list = items ?? session?.pending ?? [];
      if (list.length === 0) return;
      const ungranted = list.filter(p => !p.granted);
      setBusy(true);
      setError("");
      let allSucceeded = true;
      try {
        for (const p of ungranted) {
          const res = await approvePending(targetSessionId, p);
          if (!res.ok) {
            setError(res.error);
            allSucceeded = false;
            break;
          }
        }
      } finally {
        setBusy(false);
      }
      await loadActive(targetSessionId);
      await refreshList();
      if (!allSucceeded) return;
      await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected));
      await loadActive(targetSessionId);
      await refreshList();
    },
    [activeId, isPluginEffective, runSessionRequest, loadActive, refreshList, session?.pending],
  );

  const handleSend = useCallback(
    async (text: string, input?: ComposerInput, onAccepted?: () => void, delivery?: InputDelivery) => {
      const targetSessionId = activeId;
      const running = Boolean(targetSessionId && session?.id === targetSessionId && (
        session.status === "running" || session.streaming?.status === "streaming" || runRequestSessions.has(targetSessionId)
      ));
      if (!targetSessionId || session?.id !== targetSessionId || (busy && !running) || !isPluginEffective("sessions")) return false;
      const value = text.trim() || tr("附件与上下文");
      if (running) {
        const selectedDelivery = delivery ?? 'guide';
        if (queueSubmittingSessionsRef.current.has(targetSessionId)) return false;
        queueSubmittingSessionsRef.current.add(targetSessionId);
        setQueueSubmittingSessions(new Set(queueSubmittingSessionsRef.current));
        setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
        try {
          const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
          const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, {
            session_id: targetSessionId,
            provider_id: selected.provider_id,
            model: selected.model,
            reasoning_effort: selected.reasoning_effort,
          });
          if (selectedDelivery === 'guide' && session?.active_turn_id) {
            const guided = await guideCurrentTurn(targetSessionId, session.active_turn_id, value, prepared.token);
            if (!guided.ok) {
              await loadActive(targetSessionId, false);
              throw guided.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(guided.error);
            }
            onAccepted?.();
            await loadActive(targetSessionId, false);
            await refreshList();
            return true;
          }
          const queued = await queueTurn(targetSessionId, value, prepared.token);
          if (!queued.ok) {
            await loadActive(targetSessionId, false);
            throw queued.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(queued.error);
          }
          onAccepted?.();
          if (selectedDelivery === 'startNow') {
            const turnId = session?.active_turn_id;
            if (!turnId) {
              setQueueError({ sessionId: targetSessionId, message: tr('无法立即发送：当前轮次已结束。消息已保留在队列中。') });
            } else {
              const reserved = await reserveQueuedMessageNow(targetSessionId, queued.value.id, turnId);
              if (!reserved.ok) {
                setQueueError({ sessionId: targetSessionId, message: reserved.error });
              } else {
                setQueueError({ sessionId: targetSessionId, message: tr('消息已排到最前，并将在当前轮停止后启动。') });
              }
            }
          }
          await loadActive(targetSessionId, false);
          await refreshList();
          return true;
        } finally {
          queueSubmittingSessionsRef.current.delete(targetSessionId);
          setQueueSubmittingSessions(new Set(queueSubmittingSessionsRef.current));
        }
      }
      if (busy) return false;
      const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
      let accepted = false;
      const requestResult = await runSessionRequest(targetSessionId, async confirmed => {
        const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { session_id: targetSessionId, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
        return sendTurn(targetSessionId, value, { ...confirmed, goal: prepared.goal }, prepared.token, () => { accepted = true; onAccepted?.(); });
      }, selected);
      if (requestResult.ok) {
        await loadActive(targetSessionId);
        await refreshList();
      }
      if (!requestResult.ok && !accepted && requestResult.error) {
        await loadActive(targetSessionId, false);
        throw requestResult.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(requestResult.error);
      }
      return requestResult.ok || accepted;
    },
    [activeId, session, busy, runRequestSessions, isPluginEffective, run, runSessionRequest, loadActive, refreshList],
  );

  const moveTextIntoComposer = useCallback((targetSessionId: string, text: string, hasContext = false) => {
    const workspaceKey = commandRoot || 'default';
    const draftKey = `session:${targetSessionId}`;
    const scopedKey = `${workspaceKey}:${draftKey}`;
    const current = composerDraftStore.current.get(scopedKey) ?? {
      text: '', attachments: [], goal: false,
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      selectedCapabilities: [], submissionError: '', attachmentError: '', revision: 0,
    };
    const recoverableDrafts = [...(current.recoverableDrafts ?? [])];
    const currentContent = composerDraftContent(current);
    if (hasComposerDraftContent(currentContent)) recoverableDrafts.push(currentContent);
    const next: ComposerDraftState = {
      ...current, text, attachments: [], goal: false, selectedCapabilities: [],
      selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
      submissionError: '', attachmentError: hasContext ? tr('原附件或上下文不会恢复，请重新添加。') : '',
      hadAttachments: Boolean(current.hadAttachments || hasContext), recoverableDrafts,
      revision: current.revision + 1,
    };
    composerDraftStore.current.set(scopedKey, next);
    persistDraft(workspaceKey, draftKey, next);
    notifyComposerDrafts(composerDraftStore);
  }, [commandRoot]);

  const handleCancelQueuedTurn = useCallback(async (queueId: string) => {
    const targetSessionId = activeId;
    if (!targetSessionId || queueCancelling?.sessionId === targetSessionId) return;
    setQueueCancelling({ sessionId: targetSessionId, queueId });
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    const result = await cancelQueuedTurn(targetSessionId, queueId);
    // Reload even on 409: the queue item may already have been claimed, and the
    // timeline detail is the authoritative state shown after that race.
    await loadActive(targetSessionId, false);
    if (!result.ok && activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: result.error });
    await refreshList();
    setQueueCancelling(current => current?.sessionId === targetSessionId && current.queueId === queueId ? null : current);
  }, [activeId, queueCancelling, loadActive, refreshList]);

  const handleWithdrawQueuedTurn = useCallback(async (queueId: string) => {
    const targetSessionId = activeId;
    const item = sessionSnapshotRef.current?.queued_messages?.find(row => row.id === queueId);
    if (!targetSessionId || !item || queueCancelling?.sessionId === targetSessionId) return;
    moveTextIntoComposer(targetSessionId, item.text, item.has_context === true || item.has_attachments === true);
    setQueueCancelling({ sessionId: targetSessionId, queueId });
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      const result = await cancelQueuedTurn(targetSessionId, queueId);
      await loadActive(targetSessionId, false);
      if (!result.ok && activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: result.error });
      await refreshList();
    } finally {
      setQueueCancelling(current => current?.sessionId === targetSessionId && current.queueId === queueId ? null : current);
    }
  }, [activeId, queueCancelling, moveTextIntoComposer, loadActive, refreshList]);

  const handleWithdrawGuidance = useCallback(async (inputId: string) => {
    const targetSessionId = activeId;
    const item = sessionSnapshotRef.current?.pending_guidance?.find(row => row.id === inputId);
    if (!targetSessionId || !item || queueCancelling?.sessionId === targetSessionId) return;
    moveTextIntoComposer(targetSessionId, item.text, item.has_context === true || item.has_attachments === true);
    setQueueCancelling({ sessionId: targetSessionId, queueId: inputId });
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      await withdrawGuidance(targetSessionId, inputId);
      await loadActive(targetSessionId, false);
      await refreshList();
    } catch (reason) {
      if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId,
        message: reason instanceof Error ? reason.message : String(reason) });
      await loadActive(targetSessionId, false);
    } finally {
      setQueueCancelling(current => current?.sessionId === targetSessionId && current.queueId === inputId ? null : current);
    }
  }, [activeId, queueCancelling, moveTextIntoComposer, loadActive, refreshList]);

  const handleSendNowQueuedTurn = useCallback(async (queueId: string) => {
    const targetSessionId = activeId;
    const snapshot = sessionSnapshotRef.current;
    const turnId = snapshot?.id === targetSessionId ? snapshot.active_turn_id : undefined;
    if (!targetSessionId || !turnId || !snapshot || snapshot.id !== targetSessionId
      || !isPluginEffective('sessions') || queueContinuingSessionsRef.current.has(targetSessionId)) return;
    queueContinuingSessionsRef.current.add(targetSessionId);
    setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      // Confirm the settings for the new human turn before requesting a stop.
      const selected = await runPermission.ensure(getRunChoices(), snapshot.permission_mode);
      if (!selected || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current('sessions')) return;
      setRunChoices(selected);
      setChoices(selected);
      const reservation = await reserveQueuedMessageNow(targetSessionId, queueId, turnId);
      if (!reservation.ok) throw new Error(reservation.error);
      await loadActive(targetSessionId, false);

      const deadline = Date.now() + 180_000;
      let idle = false;
      while (Date.now() < deadline) {
        const latest = await loadSession(targetSessionId);
        if (!latest.ok) throw new Error(latest.error);
        if (latest.value.status !== 'running' && !latest.value.active_turn_id
          && latest.value.streaming?.status !== 'streaming') {
          idle = true;
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
      if (!idle) throw new Error(tr('正在等待当前轮停止。保留的立即发送消息可在队列中查看。'));

      // A completed core turn can be visible before the route releases its
      // lease. Retry only that boundary conflict; the durable receipt makes
      // each retry refer to the same reserved user message.
      let started = false;
      let lastError = '';
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, targetSessionId, true);
      trackSessionId(executingSessionsRef, setExecutingSessions, targetSessionId, true);
      for (let attempt = 0; attempt < 12 && !started; attempt++) {
        const result = await runSession(targetSessionId, selected,
          { continueQueue: true, promotionRequestId: reservation.value.request_id });
        if (result.ok) { started = true; break; }
        lastError = result.error;
        const latest = await loadSession(targetSessionId);
        if (latest.ok && (latest.value.current_queue_item_id === queueId
          || latest.value.queued_messages?.some(item => item.id === queueId
            && ['claimed', 'settled'].includes(item.promotion?.state ?? '')))) { started = true; break; }
        if (!/already in progress|in use by another process/iu.test(result.error)) break;
        await new Promise(resolve => window.setTimeout(resolve, 300));
      }
      if (!started) throw new Error(lastError || tr('立即发送未能启动，请刷新队列后重试。'));
      await loadActive(targetSessionId, false);
      await refreshList();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message });
    } finally {
      trackSessionId(runRequestSessionsRef, setRunRequestSessions, targetSessionId, false);
      trackSessionId(executingSessionsRef, setExecutingSessions, targetSessionId, false);
      queueContinuingSessionsRef.current.delete(targetSessionId);
      setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
      await loadActive(targetSessionId, false);
    }
  }, [activeId, isPluginEffective, runPermission.ensure, loadActive, refreshList]);

  const handleContinueQueuedMessages = useCallback(async () => {
    const targetSessionId = activeId;
    if (!targetSessionId || session?.id !== targetSessionId || session.status === "running" || session.streaming?.status === "streaming"
      || !(session.queued_messages ?? []).some(item => item.status === "paused")
      || !isPluginEffective("sessions") || queueContinuingSessionsRef.current.has(targetSessionId)) return;
    queueContinuingSessionsRef.current.add(targetSessionId);
    setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    setQueueError(previous => previous?.sessionId === targetSessionId ? null : previous);
    try {
      const continued = await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected, { continueQueue: true }));
      if (!continued.ok) {
        if (activeIdRef.current === targetSessionId) setQueueError({ sessionId: targetSessionId, message: continued.error ?? tr("运行失败，请检查服务器配置与任务状态") });
      } else {
        await refreshList();
      }
      await loadActive(targetSessionId, false);
    } finally {
      queueContinuingSessionsRef.current.delete(targetSessionId);
      setQueueContinuingSessions(new Set(queueContinuingSessionsRef.current));
    }
  }, [activeId, session, isPluginEffective, runSessionRequest, refreshList, loadActive]);

  const handleEditQueuedMessage = useCallback(async (queueId: string, text: string, expectedText: string) => {
    const target = activeId;
    if (!target || !isPluginEffective("sessions")) throw new Error(tr("会话不可用"));
    try { await editQueuedMessage(target, queueId, text, expectedText); }
    finally { await loadActive(target, false); }
  }, [activeId, isPluginEffective, loadActive]);

  const handleReorderQueuedMessages = useCallback(async (ids: string[], expectedIds: string[]) => {
    const target = activeId;
    if (!target || !isPluginEffective('sessions')) throw new Error(tr('会话不可用'));
    try { await reorderQueuedMessages(target, ids, expectedIds); }
    finally { await loadActive(target, false); }
  }, [activeId, isPluginEffective, loadActive]);

  /** Hero composer: create the task and run it in one round trip pair. */
  const handleCreate = useCallback(
    async (text: string, input?: ComposerInput, onAccepted?: () => void) => {
      const value = text.trim() || tr("附件与上下文");
      if (!isPluginEffective("sessions")) return false;
      if (activeCreateRef.current !== null) return false;
      const createTicket = ++createGenerationRef.current;
      activeCreateRef.current = createTicket;
      setCreatingSession(true);
      const releaseCreateLock = () => {
        if (activeCreateRef.current !== createTicket) return;
        activeCreateRef.current = null;
        setCreatingSession(false);
      };
      let createdId = "";
      const originSessionId = activeIdRef.current;
      const selected = getRunChoices();
      if (input?.capabilities?.includes("browser.composer_operation") && isPluginEffective("browser")) selected.browser = true;
      try {
        const confirmed = await runPermission.ensure(selected);
        if (!confirmed || activeIdRef.current !== originSessionId || !pluginEffectiveRef.current('sessions')) return false;
        Object.assign(selected, confirmed);
        setRunChoices(confirmed);
        setChoices(confirmed);
        const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { root: draftRoot ?? composerCatalog.root ?? undefined, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
        const result = await createSession(value, { ...selected, goal: prepared.goal }, { ...(isolatedWorkspace ? {} : { root: prepared.root }), prepared_token: prepared.token }, id => {
          createdId = id;
          onAccepted?.();
          releaseCreateLock();
          trackSessionId(runRequestSessionsRef, setRunRequestSessions, id, true);
          trackSessionId(executingSessionsRef, setExecutingSessions, id, true);
          loadedSessionChoices.current = id;
          if (activeIdRef.current === originSessionId) {
            setRunError("");
            setActiveId(id);
          }
        });
        if (result.ok) createdId = result.value;
        else if (result.accepted && result.id) createdId = result.id;
        const createError = result.ok ? "" : result.error;
        if (createdId) {
          await refreshList();
          await loadActive(createdId);
          if (createError && activeIdRef.current === createdId) setRunError(createError);
          return true;
        }
        if (createError && activeIdRef.current === originSessionId) setRunError(createError);
        if (!result.ok && result.outcomeUnknown) { await refreshList(); throw new DeliveryUnconfirmedError(); }
        if (createError) throw new Error(createError);
        return false;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (activeIdRef.current === createdId && createdId) setRunError(message);
        else if (activeIdRef.current === originSessionId) setRunError(message);
        if (!createdId) throw reason;
        return true;
      } finally {
        releaseCreateLock();
        if (createdId) {
          trackSessionId(runRequestSessionsRef, setRunRequestSessions, createdId, false);
          trackSessionId(executingSessionsRef, setExecutingSessions, createdId, false);
        }
      }
    },
    [isPluginEffective, refreshList, loadActive, draftRoot, composerCatalog.root, isolatedWorkspace, runPermission.ensure],
  );

  const handleStop = useCallback(async () => {
    const targetSessionId = activeId;
    if (!targetSessionId || stoppingSessionsRef.current.has(targetSessionId)) return;
    trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, true);
    try {
      const result = await post<{ stopping: boolean }>(`/api/sessions/${encodeURIComponent(targetSessionId)}/stop`, {});
      if (!result.stopping) { trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, false); await loadActive(targetSessionId, false); }
    }
    catch (reason) {
      if (activeIdRef.current === targetSessionId) setRunError(reason instanceof Error ? reason.message : String(reason));
      trackSessionId(stoppingSessionsRef, setStoppingSessions, targetSessionId, false);
    }
  }, [activeId, loadActive]);

  const handleRetryRun = useCallback(async () => {
    if (!activeId || session?.id !== activeId || busy || runRequestSessionsRef.current.has(activeId)) return;
    const targetSessionId = activeId;
    await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected));
    await loadActive(targetSessionId);
    await refreshList();
  }, [activeId, session?.id, busy, runSessionRequest, loadActive, refreshList]);

  const handleRetryTool = useCallback(async (row?: { toolCallId?: string }) => {
    if (!activeId || session?.id !== activeId || busy || runRequestSessionsRef.current.has(activeId) || !isPluginEffective("sessions")) return;
    const targetSessionId = activeId;
    if (row?.toolCallId && session?.pending) {
      const match = session.pending.find(p => p.tool_call_id === row.toolCallId);
      if (match && !match.granted) {
        const granted = await run(() => approvePending(targetSessionId, match));
        if (!granted) return;
      }
    }
    await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected));
    await loadActive(targetSessionId);
    await refreshList();
  }, [activeId, session?.id, session?.pending, busy, isPluginEffective, run, runSessionRequest, loadActive, refreshList]);

  const handleQuestionSubmitted = useCallback(async (targetSessionId: string, continueRun: boolean, isCurrent: () => boolean) => {
    if (!isCurrent() || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current("sessions")) return;
    await loadActive(targetSessionId);
    await refreshList();
    if (!continueRun || !isCurrent() || activeIdRef.current !== targetSessionId || !pluginEffectiveRef.current("sessions")
      || runRequestSessionsRef.current.has(targetSessionId)) return;
    const continued = await runSessionRequest(targetSessionId, selected => runSession(targetSessionId, selected));
    await loadActive(targetSessionId);
    await refreshList();
    if (!continued.ok) throw new Error(continued.error || tr("运行失败，请检查服务器配置与任务状态"));
  }, [loadActive, refreshList, runSessionRequest]);

  const handleMessageFeedback = useCallback(async (row: Extract<TimelineRow, {kind: 'assistant'}>, feedback: 'like' | 'dislike' | null) => {
    const id = activeIdRef.current;
    if (!id || !pluginEffectiveRef.current('sessions')) throw new Error(tr('会话已关闭'));
    const result = await updateConversationMessage(id, row, {action: 'feedback', feedback});
    await loadActive(id, false);
    if (!result.ok) throw new Error(result.error);
  }, [loadActive]);

  const handleMessageEdit = useCallback(async (row: Extract<TimelineRow, {kind: 'user'}>, text: string, onAccepted: () => void) => {
    const id = activeIdRef.current;
    if (!id || !pluginEffectiveRef.current('sessions')) return false;
    let accepted = false;
    const result = await runSessionRequest(id, async selected => {
      const updated = await updateConversationMessage(id, row, {action: 'edit', text});
      if (!updated.ok) return updated;
      accepted = true; onAccepted();
      await loadActive(id, false);
      const started = await runSession(id, selected);
      return started.ok ? started : {...started, accepted: true};
    });
    await loadActive(id, false); await refreshList();
    if (!result.ok && result.error) throw new Error(result.error);
    return result.ok || accepted;
  }, [runSessionRequest, loadActive, refreshList]);

  const renameById = useCallback(
    async (id: string, value: string) => {
      const target = sessions.find((s) => s.id === id);
      const current = target?.title || target?.task || "";
      const clean = value.trim();
      if (!clean || clean === current) return;
      if (await run(() => renameSession(id, clean))) {
        await refreshList();
        if (id === activeId) await loadActive(id);
      }
    },
    [sessions, activeId, run, refreshList, loadActive],
  );

  const [renameRequest, setRenameRequest] = useState<{ id: string; initialValue: string } | null>(null);
  const renameOpenerRef = useRef<HTMLElement | null>(null);
  const requestRename = useCallback(
    (id: string, returnFocusTo?: HTMLElement | null) => {
      const target = sessions.find((s) => s.id === id);
      renameOpenerRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setRenameRequest({ id, initialValue: target?.title || target?.task || "" });
    },
    [sessions],
  );

  // -- pin / archived --------------------------------------------------------
  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      if (await run(() => pinSession(id, pinned))) {
        await refreshList();
        if (id === activeId) await loadActive(id);
      }
    },
    [activeId, run, refreshList, loadActive],
  );

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedRevision, setArchivedRevision] = useState(0);

  const deleteById = useCallback(
    async (id: string) => {
      if (busy || !window.confirm(tr("从列表移除该任务？会话记录会归档，工作区文件不会删除。"))) return;
      if (await run(() => deleteSession(id))) {
        setArchivedRevision(previous => previous + 1);
        if (id === activeId) {
          setActiveId(null);
          setSession(null);
          setRows([]);
        }
        await refreshList();
      }
    },
    [activeId, busy, run, refreshList],
  );

  const activeSessionRunning = activeId !== null && session?.id === activeId && (
    session.status === "running" || session.streaming?.status === "streaming" || runRequestSessions.has(activeId)
  );
  const composerDisabled = (session?.status === "awaiting_user" && settingsValues.sessionsAnswerQuestionEnabled === true) || (busy && !activeSessionRunning) || !activeId || session?.id !== activeId || !isPluginEffective("sessions");

  const handleRefreshAll = useCallback(async () => {
    if (!isPluginEffective("sessions")) return;
    await refreshList();
    if (activeId) await loadActive(activeId);
  }, [isPluginEffective, refreshList, activeId, loadActive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = evaluateWorkbenchGlobalKey(event, {
        bindings: (settingsValues.bindings && typeof settingsValues.bindings === "object" ? settingsValues.bindings : {}) as Record<string, string>,
        isPluginEffective,
        panel,
        busy,
        platform: resolveHostPlatform(),
      });
      if (!action) return;
      event.preventDefault();
      if (action.type === "new-session") startNewTask();
      else if (action.type === "command-palette") openCommandPalette();
      else if (action.type === "open-settings") setPanel("settings");
      else if (action.type === "toggle-sidebar") setSidebarToggleToken(value => value + 1);
      else if (action.type === "refresh-session") void handleRefreshAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNewTask, isPluginEffective, settingsValues.bindings, handleRefreshAll, panel, busy, openCommandPalette]);

  // -- files panel ---------------------------------------------------------
  const handleLoadFiles = useCallback(async () => {
    const currentId = activeId;
    if (!currentId || !isPluginEffective("files")) return;
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    const res = await loadFiles(currentId, controller.signal);
    if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || !isPluginEffective("files")) return;
    if (res.ok) {
      setFiles(res.value.files);
      setFilesTruncated(res.value.truncated);
    } else {
      setPreviewError(res.error);
    }
  }, [activeId, isPluginEffective]);

  const handleSelectFile = useCallback(
    async (path: string) => {
      const currentId = activeId;
      if (!currentId || !isPluginEffective("files")) return;
      selectedPathRef.current = path;
      setSelectedPath(path);
      setPreview(null);
      setPreviewError("");
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      const res = await loadFilePreview(currentId, path, controller.signal);
      if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || selectedPathRef.current !== path) return;
      if (res.ok)
        setPreview({
          ...res.value,
        });
      else setPreviewError(res.error);
    },
    [activeId, isPluginEffective],
  );

  // -- changes panel -------------------------------------------------------
  const handleLoadChanges = useCallback(async () => {
    const currentId = activeId;
    if (!currentId || !isPluginEffective("files")) return;
    setChangesError("");
    changesAbortRef.current?.abort();
    const controller = new AbortController();
    changesAbortRef.current = controller;
    const res = await loadJournal(currentId, controller.signal);
    if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || !isPluginEffective("files")) return;
    if (res.ok) setChangeSet(deriveFileChanges(res.value));
    else {
      setChangeSet(null);
      setChangesError(res.error);
    }
  }, [activeId, isPluginEffective]);

  // -- settings panel ------------------------------------------------------
  const pendingSettings = useRef<SettingsMap>({});
  const settingsWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsWriteCount = useRef(0);
  const persistSettings = useCallback((patch: SettingsMap): Promise<void> => {
    Object.assign(pendingSettings.current, patch);
    settingsWriteCount.current += 1;
    setSettingsSaving(true);
    setSettingsDirty(true);
    const operation = settingsWriteQueue.current.then(async () => {
      const result = await saveWorkbenchSettings(SETTINGS_DEFAULTS, patch);
      if (!mountedRef.current) return;
      if (result.ok) {
        for (const [key, value] of Object.entries(patch)) {
          if (JSON.stringify(pendingSettings.current[key]) === JSON.stringify(value)) delete pendingSettings.current[key];
        }
        if (Object.keys(pendingSettings.current).length === 0) setSettingsError("");
      } else setSettingsError(result.error);
    }).finally(() => {
      if (!mountedRef.current) return;
      settingsWriteCount.current -= 1;
      setSettingsSaving(settingsWriteCount.current > 0);
      setSettingsDirty(Object.keys(pendingSettings.current).length > 0);
    });
    settingsWriteQueue.current = operation.catch(reason => {
      if (mountedRef.current) setSettingsError(String(reason));
    });
    return settingsWriteQueue.current;
  }, []);

  const handleToggleCapability = useCallback((key: keyof AgentCapabilities, value: boolean) => {
    setCapabilities(prev => ({ ...prev, [key]: value }));
    setSettingsValues(prev => ({ ...prev, [key]: value }));
    void persistSettings({ [key]: value });
  }, [persistSettings]);

  const handleUpdateSetting = useCallback((key: string, value: unknown) => {
    setSettingsValues(prev => ({ ...prev, [key]: value }));
    return persistSettings({ [key]: value });
  }, [persistSettings]);

  const handleSaveSettings = useCallback(() => persistSettings({ ...pendingSettings.current }), [persistSettings]);

  // Load panel data when the panel opens, so each view has a real round trip.
  useEffect(() => {
    if (panel === "files" && isPluginEffective("files")) void handleLoadFiles();
    else if (panel === "changes" && isPluginEffective("files")) void handleLoadChanges();
  }, [panel, activeId, isPluginEffective, handleLoadFiles, handleLoadChanges]);

  // -- git panel --------------------------------------------------------------
  // Read-only round trips; a non-repo workspace surfaces its honest empty state.
  const loadGitPanel = useCallback(async () => {
    const currentId = activeId;
    if (!currentId) return;
    gitAbortRef.current?.abort();
    const controller = new AbortController();
    gitAbortRef.current = controller;
    setGitLoading(true);
    setGitStatusError("");
    setGitDiffError("");
    setGitLogError("");
    const [status, diff, log, checkpoints] = await Promise.all([
      loadGitStatus(currentId, controller.signal),
      loadGitDiff(currentId, controller.signal),
      loadGitLog(currentId, controller.signal),
      loadGitCheckpoints(currentId, controller.signal),
    ]);
    if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal)) return;
    setGitStatus(status.ok ? status.value : null);
    setGitStatusError(status.ok ? "" : status.error);
    setGitDiff(diff.ok ? diff.value : null);
    setGitDiffError(diff.ok ? "" : diff.error);
    setGitLog(log.ok ? log.value : null);
    setGitLogError(log.ok ? "" : log.error);
    setGitCheckpoints(checkpoints.ok ? checkpoints.value : []);
    setGitCheckpointError(checkpoints.ok ? "" : checkpoints.error);
    setGitLoading(false);
  }, [activeId]);

  const runGitAction = useCallback(async (action: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>) => {
    if (!activeId || gitActionBusy || !isPluginEffective("git")) return;
    setGitActionBusy(true);
    try {
      const result = await action();
      if (!mountedRef.current) return;
      if (!result.ok) setGitCheckpointError(result.error);
      else setGitCheckpointError("");
      await loadGitPanel();
    } finally {
      if (mountedRef.current) setGitActionBusy(false);
    }
  }, [activeId, gitActionBusy, isPluginEffective, loadGitPanel]);

  useEffect(() => {
    if (panel === "git" && isPluginEffective("git")) void loadGitPanel();
  }, [panel, isPluginEffective, loadGitPanel]);

  // -- directory panel -----------------------------------------------------
  // The browser shell has no native folder dialog, so browsing goes through the
  // host-side directory API. Errors are shown, never swallowed into an empty tree.
  const browseDirectory = useCallback(async (path: string) => {
    if (!isPluginEffective("files")) return;
    setDirLoading(true);
    setDirError("");
    try {
      const res = await loadDirectory(path);
      if (!mountedRef.current) return;
      if (res.ok) setDirListing(res.value);
      else setDirError(res.error);
    } finally {
      if (mountedRef.current) setDirLoading(false);
    }
  }, [isPluginEffective]);

  useEffect(() => {
    if (panel !== "directory" || !isPluginEffective("files") || dirListing) return;
    setDirLoading(true);
    void (async () => {
      const home = await loadHome();
      if (!mountedRef.current) return;
      setDirLoading(false);
      if (home.ok) await browseDirectory(home.value);
      else setDirError(home.error);
    })();
  }, [panel, dirListing, isPluginEffective, browseDirectory]);

  const handleCreateDir = useCallback(
    async (name: string) => {
      if (!dirListing || !isPluginEffective("files")) return;
      const res = await createFolder(dirListing.path, name);
      if (res.ok) await browseDirectory(dirListing.path);
      else setDirError(res.error);
    },
    [dirListing, isPluginEffective, browseDirectory],
  );

  // -- providers / usage / memory panels -----------------------------------
  useEffect(() => {
    if (panel !== "providers" || !isPluginEffective("providers")) return;
    setProvidersLoading(true);
    void (async () => {
      const res = await loadProviders();
      if (!mountedRef.current) return;
      setProvidersLoading(false);
      if (res.ok) {
        setProviders(res.value);
        setProvidersError("");
      } else setProvidersError(res.error);
    })();
  }, [panel, settingsSection, isPluginEffective]);

  useEffect(() => {
    if ((panel !== "usage" && !(panel === "settings" && settingsSection === "usage")) || !isPluginEffective("usage")) return;
    setUsageLoading(true);
    void (async () => {
      const res = await loadUsage();
      if (!mountedRef.current) return;
      setUsageLoading(false);
      if (res.ok) {
        setUsage(res.value);
        setUsageError("");
      } else setUsageError(res.error);
    })();
  }, [panel, settingsSection, isPluginEffective]);

  useEffect(() => {
    if ((panel !== "memory" && !(panel === "settings" && settingsSection === "memory")) || !isPluginEffective("memory")) return;
    setTracksLoading(true);
    void (async () => {
      const res = await loadMemoryTracks();
      if (!mountedRef.current) return;
      setTracksLoading(false);
      if (res.ok) {
        setTracks(res.value);
        setTracksError("");
      } else setTracksError(res.error);
    })();
  }, [panel, settingsSection, isPluginEffective]);

  // -- settings view --------------------------------------------------------
  // The whole settings map is loaded (all five sections), not just capabilities:
  // the settings view renders sections the agent-only read never returned.
  const handleLoadAllSettings = useCallback(async () => {
    setSettingsLoading(true);
    const res = await loadWorkbenchSettings(SETTINGS_DEFAULTS);
    if (!mountedRef.current) return;
    setSettingsLoading(false);
    if (res.ok) {
      setSettingsValues(res.value);
      setCapabilities(readAgentCapabilities(res.value));
      setSettingsError("");
      settingsHaveLoaded.current = true;
    } else {
      setSettingsError(res.error);
    }
  }, []);

  const settingsAvailable = isPluginEffective("settings");
  useEffect(() => {
    if (!settingsHaveLoaded.current || !settingsAvailable || settingsLoading || settingsError || initialBrowserPreferenceLoaded.current) return;
    initialBrowserPreferenceLoaded.current = true;
    if (!activeIdRef.current) updateChoices({ browser: settingsValues.browserControlEnabled === true && isPluginEffective("browser") });
  }, [settingsAvailable, settingsLoading, settingsError, settingsValues.browserControlEnabled, isPluginEffective, updateChoices]);
  useEffect(() => {
    // Appearance and shortcuts affect the whole workbench, so load them as soon
    // as the settings plugin is available rather than waiting for its panel to
    // open. The catalog gate keeps disabled settings endpoints untouched.
    if (settingsAvailable) void handleLoadAllSettings();
  }, [settingsAvailable, handleLoadAllSettings]);

  const selectedComposerModel = composerCatalog.models.find(model => model.id === (choices.provider_id ?? ""));
  const composerModelReady = selectedComposerModel?.configured === true && composerCatalog.allowReal && isPluginEffective("providers");
  const activeMonitorSource = session?.id === activeId ? session : null;
  const activeRuntimeProfile = runtimeProfileFromSession(activeMonitorSource?.runtime_profile)
    ?? (activeMonitorSource?.runtime_mode === "pi-lite" ? "lightweight" : undefined)
    ?? effectiveRuntimeProfile(selectedComposerModel, choices.runtime_profile);
  const runtimeMonitorSession: LocalRuntimeSession | null = activeMonitorSource ? {
    status: activeMonitorSource.status,
    runtime_profile: activeRuntimeProfile,
    runtime_budget: activeMonitorSource.runtime_budget,
    runtime_activity: activeMonitorSource.runtime_activity,
    runtime_activity_history: activeMonitorSource.runtime_activity_history,
    tool_timings: activeMonitorSource.tool_timings,
  } : null;
  const composerRunning = activeId !== null && session?.id === activeId && (
    session.status === "running" || session.streaming?.status === "streaming" || runRequestSessions.has(activeId)
  );
  // 轻量档极简布局由 providers 插件拥有：档位生效且插件可用才切换挂载。
  const lightweightLayout = lightweightLayoutActive(activeRuntimeProfile, isPluginEffective("providers"));
  useEffect(() => {
    if (lightweightLayout && panel === "subagents") {
      setPanel(isPluginEffective("sessions") ? "chat" : "plugins");
    }
  }, [lightweightLayout, panel, isPluginEffective]);
  useEffect(() => {
    if (!lightweightLayout) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = evaluateLightweightGlobalKey(e, lightweightGlobalKeyContextFromEvent(e, {
        panelOpen: panel !== "chat",
        running: composerRunning,
        stopping: activeId !== null && stoppingSessions.has(activeId),
        platform: resolveHostPlatform(),
      }));
      if (action === "clear-screen") {
        e.preventDefault();
        scrollToTimelineBottom();
        return;
      }
      if (action === "close-panel") {
        e.preventDefault();
        setPanel("chat");
        return;
      }
      if (action === "stop") {
        e.preventDefault();
        void handleStop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightweightLayout, panel, composerRunning, activeId, stoppingSessions, handleStop]);
  // 轻量档补齐焦点：导航换了区域而焦点被丢到 body 时，把它落到新区域的合理落点。
  useEffect(() => {
    if (!lightweightLayout) return;
    const target = panel === "chat"
      ? heroInputRef.current
      : document.querySelector<HTMLElement>(".xn-secondary-view__back");
    if (!target) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    target.focus();
  }, [lightweightLayout, panel]);
  const sessionUserMessages = useMemo(() => {
    const list: string[] = [];
    if (session?.task && typeof session.task === "string" && session.task.trim().length > 0) {
      list.push(session.task.trim());
    }
    for (const r of rows ?? []) {
      if (r.kind === "user" && typeof r.text === "string" && r.text.trim().length > 0) {
        const trimmed = r.text.trim();
        if (!list.includes(trimmed)) {
          list.push(trimmed);
        }
      }
    }
    return list;
  }, [rows, session?.task]);
  const composerMentions = [
    ...composerCatalog.files.map(item => ({ ...item, kind: "file" as const })),
    ...composerCatalog.sessions.map(item => ({ ...item, kind: "session" as const })),
    ...composerCatalog.skills.map(item => ({ ...item, kind: "skill" as const })),
    ...composerCatalog.plugins.map(item => ({ ...item, kind: "plugin" as const })),
  ];
  // 用量速览属于 usage 插件：插件生效才挂载入口，会话数据由容器透传。
  const usageQuickCard = <XuenessUsageQuickCard
    enabled={isPluginEffective("usage")}
    sessionProviderUsage={session?.id === activeId ? session.provider_usage : undefined}
    onOpenPanel={isPluginEffective("usage") ? () => setPanel("usage") : undefined}
  />;
  const contextReading = sessionContextUsage(session?.id === activeId ? session : null,
    composerCatalog.models.find(model => model.id === (choices.provider_id ?? "")), choices);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [deliveryEditorRequest, setDeliveryEditorRequest] = useState<{id: string; version: number} | null>(null);
  useEffect(() => setGoalEditorOpen(false), [activeId]);
  const composerControls = <>
    <XuenessComposerToolbar
      choices={choices} onChange={updateChoices} models={composerCatalog.models}
      loading={composerCatalogLoading} error={composerCatalogError}
      onReload={() => void refreshComposerCatalog()}
      onManageModels={openModelSettings}
      onSaveDefault={isPluginEffective("providers") ? model => void saveDefaultModel(model) : undefined}
      defaultSaved={defaultSaved}
      onBackground={isPluginEffective("workflows") ? () => setPanel("workflows") : undefined}
      backgroundCount={composerCatalog.backgroundCount ?? 0}
      browserEnabled={choices.browser === true}
      onToggleBrowser={activeId !== null && isPluginEffective("browser") ? enabled => updateChoices({ browser: enabled }) : undefined}
      disabled={busy || branchBusy || composerRunning}
      onOpenUsage={isPluginEffective("usage") ? () => setPanel("usage") : undefined}
      runtimeBudget={session?.id === activeId ? session.runtime_budget : undefined}
      contextReading={contextReading}
      pauseReason={session?.id === activeId ? session.pause_reason : undefined}
    />
    {usageQuickCard}
  </>;
  // 起始页右侧「最近项目」来自 settings 已登记的工作区（带 lastUsed）。插件未生效
  // 或起始页不可见时既不请求也不保留数据，禁用后不会再发起轮询。
  const startPageVisible = panel === "chat" && !lightweightLayout && !activeId && !session;
  const refreshRecentProjects = useCallback(async () => {
    if (!pluginEffectiveRef.current("settings") || !pluginEffectiveRef.current("sessions")) {
      setRecentProjects(null);
      return;
    }
    try {
      setRecentProjects((await loadWorkspaceCatalog()).recentDirectories ?? []);
    } catch {
      setRecentProjects(null);
    }
  }, []);
  useEffect(() => {
    if (!startPageVisible || !isPluginEffective("settings") || !isPluginEffective("sessions")) {
      setRecentProjects(null);
      return;
    }
    void refreshRecentProjects();
  }, [startPageVisible, isPluginEffective, refreshRecentProjects]);
  // 起始页三个动作块只接已有能力：工作区选择（sessions/settings）、克隆仓库（git）
  // 与 SSH 连接（remote）；插件未生效时对应的块不出现。
  const startPageActions: StartPageAction[] = [
    ...(isPluginEffective("settings") && isPluginEffective("sessions") ? [{
      id: "open-project",
      label: tr("打开项目"),
      description: tr("选择一个文件夹，在其中执行任务。"),
      Icon: FolderOpen,
      onSelect: (trigger: HTMLElement) => {
        if (busy || branchBusy || !isPluginEffective("settings") || !isPluginEffective("sessions")) return;
        workspacePickerOpener.current = trigger;
        setWorkspacePickerMode("workspace");
        setWorkspacePicking(true);
      },
    }] : []),
    ...(isPluginEffective("git") ? [{
      id: "clone-repository",
      label: tr("克隆仓库"),
      description: tr("把远程仓库下载到已授权目录，并登记为项目。"),
      Icon: GitBranch,
      onSelect: (trigger: HTMLElement) => {
        if (busy || branchBusy) return;
        cloneOpener.current = trigger;
        setCloneOpen(true);
      },
    }] : []),
    ...(isPluginEffective("remote") ? [{
      id: "connect-ssh",
      label: tr("通过 SSH 连接"),
      description: tr("使用已配置的主机连接远程工作区。"),
      Icon: Server,
      onSelect: () => setPanel("remote"),
    }] : []),
  ];
  const composerStartActions = {
    canGoal: isPluginEffective('planning') && !composerRunning, canWorkflow: isPluginEffective("workflows"),
    canCompact: isPluginEffective('sessions'),
    ...(activeId ? { onGoal: () => setGoalEditorOpen(true) } : {}),
    onWorkflow: () => setPanel("workflows"), onPlugins: () => setPanel("plugins"),
    onModels: () => setPanel(isPluginEffective('providers') ? 'providers' : 'plugins'),
  };
  const composerSendDisabledReason = composerCatalogLoading ? tr('正在加载模型…')
    : composerCatalogError ? tr('模型列表加载失败，请重试。')
    : !composerCatalog.allowReal && composerCatalog.models.some(model => model.configured) ? tr('服务端已关闭模型请求。')
    : tr('选择或配置模型后即可发送。');
  const chooseWorkspace = (root: string, isolated = false, forceNew = false) => {
    if (branchBusy) return;
    if (root === (draftRoot ?? composerCatalog.root) && isolated === isolatedWorkspace && !choices.remote && !forceNew && !(workspacePicking && workspacePickerMode === 'project')) {
      setWorkspacePicking(false);
      return;
    }
    composerRequests.cancel();
    setComposerCatalog(clearWorkspaceComposerCatalog);
    if (forceNew || workspacePicking && workspacePickerMode === "project" || activeId && (isolated || root !== session?.root)) startNewTask();
    updateChoices({ remote: undefined });
    setDraftRoot(root);
    setIsolatedWorkspace(isolated);
    setWorkspacePicking(false);
    setComposerCatalogLoading(true);
    setPanel("chat");
    setHeroFocusTick(tick => tick + 1);
  };
  const workspaceContext = <div className="xn-composer-workspace" aria-label={tr("任务工作区")}>
    <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
    <ComposerWorkspaceSelect busy={busy || branchBusy} loading={composerCatalogLoading} value={choices.remote ? `remote:${choices.remote}` : isolatedWorkspace ? "__isolated__" : (draftRoot ?? composerCatalog.root ?? "")} onChange={event => {
      if (event.target.value === "__browse__") {
        workspacePickerOpener.current = document.querySelector<HTMLElement>('.xn-composer-workspace [role="combobox"]');
        setWorkspacePickerMode("workspace");
        setWorkspacePicking(true);

      } else if (event.target.value === "__isolated__") chooseWorkspace(composerCatalog.isolatedRoot, true);
      else if (event.target.value === "__remote__") setPanel("remote");
      else if (event.target.value.startsWith("remote:")) {
        chooseWorkspace(composerCatalog.isolatedRoot, true);
        updateChoices({ remote: event.target.value.slice(7) });
      }
      else chooseWorkspace(event.target.value);
    }}>
      {!composerCatalog.root && <option value="">{tr("选择工作区")}</option>}
      {[...new Set([composerCatalog.root, draftRoot, ...composerCatalog.roots.map(item => item.path)].filter((path): path is string => Boolean(path)))].map(path => <option key={path} value={path}>{composerCatalog.roots.find(item => item.path === path)?.name ?? path}</option>)}
      {composerCatalog.isolatedRoot && <option value="__isolated__">{tr("独立工作区")}</option>}
      {isPluginEffective("files") && isPluginEffective("settings") && <option value="__browse__">{tr("打开文件夹…")}</option>}
      {(composerCatalog.remoteConnections ?? []).map(item => <option value={`remote:${item.id}`} key={`remote:${item.id}`}>{item.label}</option>)}
      {isPluginEffective("remote") && <option value="__remote__">{tr("连接 SSH…")}</option>}
    </ComposerWorkspaceSelect>
    {composerCatalog.git && <Select aria-label={tr("Git 分支")} disabled={busy || branchBusy} value={composerCatalog.git.branch} onChange={event => {
      const root = draftRoot ?? composerCatalog.root;
      if (!root) return;
      setBranchBusy(true); setRunError("");
      void switchComposerBranch(root, event.target.value).then(refreshComposerCatalog).catch(reason => setRunError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBranchBusy(false));
    }}>
      {!composerCatalog.git.branches.includes(composerCatalog.git.branch) && <option>{composerCatalog.git.branch}</option>}
      {composerCatalog.git.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
    </Select>}
  </div>;

  // -- capabilities panel ----------------------------------------------------
  // Loaded per kind when the panel opens. A toggle failure surfaces on that
  // kind's section; the switch never lies about a write that did not land.
  const loadCapSlot = useCallback(async (kind: CapabilityKind) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], loading: true, error: "" } }));
    const res = await loadCapabilitySection(kind);
    if (!isPluginEffective(pluginId)) return;
    setCapSlots((prev) => ({
      ...prev,
      [kind]: res.ok
        ? {
            items: res.value.items,
            loading: false,
            error: "",
            userScopeAvailable: res.value.userScopeAvailable,
            userScopeReason: res.value.userScopeReason,
          }
        : { ...prev[kind], loading: false, error: res.error },
    }));
  }, [isPluginEffective]);

  useEffect(() => {
    const kinds = panel === "capabilities" ? pluginAvailability.capabilityKinds :
      panel === "settings" ? pluginAvailability.capabilityKinds.filter(kind => kind === settingsSection) : [];
    for (const kind of kinds) void loadCapSlot(kind);
  }, [panel, settingsSection, pluginAvailability.capabilityKinds.join(","), loadCapSlot]);

  const handleToggleCapabilityItem = useCallback(
    async (kind: CapabilityKind, item: CapabilityItem, next: boolean) => {
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      setCapBusyId(item.id);
      const res = await toggleCapabilityItem(kind, item.id, next);
      setCapBusyId(null);
      if (!res.ok) {
        setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], error: res.error } }));
        return;
      }
      await loadCapSlot(kind);
    },
    [isPluginEffective, loadCapSlot],
  );

  // -- capability create / edit / delete --------------------------------------
  const [capDialog, setCapDialog] = useState<
    { mode: "create" | "edit"; kind: CapabilityKind; initial: CapabilityItem | null } | null
  >(null);
  const [capDialogError, setCapDialogError] = useState("");
  const [capDialogBusy, setCapDialogBusy] = useState(false);

  useEffect(() => {
    if (!capDialog) return;
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[capDialog.kind];
    if (!pluginId || !isPluginEffective(pluginId)) setCapDialog(null);
  }, [capDialog, isPluginEffective]);

  const openCapCreate = useCallback((kind: CapabilityKind) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapDialogError("");
    setCapDialog({ mode: "create", kind, initial: null });
  }, [isPluginEffective]);

  const openCapEdit = useCallback((kind: CapabilityKind, item: CapabilityItem) => {
    const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
    if (!pluginId || !isPluginEffective(pluginId)) return;
    setCapDialogError("");
    // The list summary deliberately omits skill/command bodies. Fetch the
    // current record before opening an editor so saving never blanks a body.
    void listResources(kind).then(result => {
      if (!isPluginEffective(pluginId)) return;
      const raw = result.items.find(row => row.id === item.id);
      if (!raw) throw new Error("Resource no longer exists");
      setCapDialog({ mode: "edit", kind, initial: { ...item, extra: { ...item.extra, ...raw } } });
    }).catch(error => setCapSlots(prev => ({ ...prev, [kind]: { ...prev[kind], error: String(error) } })));
  }, [isPluginEffective]);

  const handleCapDelete = useCallback(
    async (kind: CapabilityKind, item: CapabilityItem) => {
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      if (!window.confirm(tf("删除{0}「{1}」？配置文件会从资源目录移除。", [tr(CAPABILITY_LABELS[kind]), item.id]))) return;
      setCapBusyId(item.id);
      const res = await deleteCapabilityItem(kind, item.id);
      setCapBusyId(null);
      if (!res.ok) {
        setCapSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], error: res.error } }));
        return;
      }
      await loadCapSlot(kind);
    },
    [isPluginEffective, loadCapSlot],
  );

  const handleCapSubmit = useCallback(
    async (payload: { id: string; fields: Record<string, unknown> }) => {
      if (!capDialog) return;
      const pluginId = CAPABILITY_PLUGIN_BY_KIND[capDialog.kind];
      if (!pluginId || !isPluginEffective(pluginId)) return;
      setCapDialogBusy(true);
      setCapDialogError("");
      const res =
        capDialog.mode === "create"
          ? await createCapabilityItem(capDialog.kind, { id: payload.id, ...payload.fields, createOnly: true })
          : await updateCapabilityFields(capDialog.kind, capDialog.initial?.id ?? payload.id, payload.fields);
      setCapDialogBusy(false);
      if (!res.ok) {
        setCapDialogError(res.error);
        return;
      }
      setCapDialog(null);
      await loadCapSlot(capDialog.kind);
    },
    [capDialog, isPluginEffective, loadCapSlot],
  );

  const capSections: CapabilitySectionProps[] = CAPABILITY_KINDS.filter((kind) =>
    pluginAvailability.capabilityKinds.includes(kind),
  ).map((kind) => ({
    kind,
    label: tr(CAPABILITY_LABELS[kind]),
    items: capSlots[kind].items,
    loading: capSlots[kind].loading,
    error: capSlots[kind].error || undefined,
    userScopeAvailable: capSlots[kind].userScopeAvailable,
    userScopeReason: capSlots[kind].userScopeReason || undefined,
    busyId: capBusyId,
    onToggle: (k, item, next) => void handleToggleCapabilityItem(k, item, next),
    onCreate: openCapCreate,
    onEdit: openCapEdit,
    onDelete: (k, item) => void handleCapDelete(k, item),
  }));

  const settingsSections = settingsNavigation(pluginAvailability.effectiveIds, new Set(pluginCatalog.map(plugin => plugin.id)));
  const settingsSectionIds = settingsSections.map(section => section.id).join(",");
  // The settings sidebar card reuses data the workbench already loads; no extra request.
  const settingsRoot = session?.root ?? draftRoot ?? composerCatalog.root ?? undefined;
  const settingsPluginVersion = pluginCatalog.find(plugin => plugin.id === "settings")?.version;
  const settingsAccount = {
    name: settingsRoot
      ? composerCatalog.roots.find(item => item.path === settingsRoot)?.name
        ?? settingsRoot.split(/[/\\]+/u).filter(Boolean).pop()
        ?? settingsRoot
      : tr("未选择工作区"),
    path: settingsRoot,
    subtitle: settingsRoot ? undefined : tr("选择项目目录后显示在这里"),
    badges: [
      composerCatalog.git?.branch ? { label: composerCatalog.git.branch, title: tr("当前 Git 分支") } : null,
      settingsPluginVersion ? { label: `v${settingsPluginVersion}`, title: tr("配置设置插件版本") } : null,
    ].filter((badge): badge is { label: string; title: string } => badge !== null),
  };
  useEffect(() => {
    if (!settingsSections.some(section => section.id === settingsSection)) setSettingsSection(settingsSections[0]?.id ?? "general");
  }, [settingsSectionIds, settingsSection]);
  const inlineSettings = ["general", "appearance", "shortcuts", "agent"].includes(settingsSection);
  const settingsContent = () => {
    if (settingsSection === "about") return <DesktopAbout enabled={isPluginEffective("desktop")} onboardingEnabled={isPluginEffective("onboarding")} />;
    if (settingsSection === "network") return <NetworkSettings enabled={isPluginEffective('network')} disabled={busy || settingsSaving || pluginCatalogLoading} />;
    if (settingsSection === 'updates') return <DesktopUpdates enabled={isPluginEffective('updates') && isPluginEffective('desktop')} />;
    if (settingsSection === "browser") return <BrowserSettings enabled={isPluginEffective("browser")} disabled={busy || settingsSaving || pluginCatalogLoading}
      onEnabledChange={async enabled => {
        await togglePlugin("browser", enabled);
        if (!activeIdRef.current) updateChoices({ browser: enabled });
        await handleUpdateSetting("browserControlEnabled", enabled);
      }} />;
    const pluginId = ({providers:"providers",subscriptions:'subscriptions','model-monitor':'model_monitor',browser:"browser",memory:"memory",subagents:"subagents",mcp:"mcp",skills:"skills",commands:"commands",hooks:"hooks",usage:"usage",runtimes:"runtimes"} as Record<string,string>)[settingsSection];
    if (pluginId && !isPluginEffective(pluginId)) return <FeatureUnavailable feature={settingsSections.find(section => section.id === settingsSection)?.label ?? settingsSection} onManage={() => setSettingsSection("modules")} />;
    if (inlineSettings) return <SettingsSections embedded sections={[]} activeSection={settingsSection}
      values={{...settingsValues, language: settingsValues.language ?? locale}} capabilities={capabilities}
      onToggleCapability={handleToggleCapability} onUpdateSetting={handleUpdateSetting} saving={settingsSaving}
      pluginSettings={settingsSection === "general" ? <>
        {isPluginEffective("sessions") && <SessionExperimentSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
        {isPluginEffective("tools") && <ToolExecutionSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
        {isPluginEffective("desktop") && <DesktopNotificationSettings values={settingsValues} disabled={settingsSaving} onUpdate={handleUpdateSetting} />}
      </> : undefined} />;
    if (settingsSection === "workspace") return <><XuenessWorkspaceSettings currentRoot={session?.root ?? draftRoot ?? composerCatalog.root}
      onDefaultChanged={() => { if (!activeId) { setDraftRoot(undefined); setIsolatedWorkspace(false); updateChoices({remote:undefined}); } void refreshComposerCatalog(); }} /><SettingsSections embedded sections={[]} activeSection="workspace-display" values={settingsValues} capabilities={capabilities} onUpdateSetting={handleUpdateSetting} saving={settingsSaving} /></>;
    if (settingsSection === "providers") return <>
      <PluginProfilePicker enabled={isPluginEffective("extensions")} onCatalogChanged={() => void refreshPluginCatalog()} />
      <ModelManager focusProviderId={providerFocusId} runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { updateChoices({ provider: "real", provider_id: id || undefined, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); }} />
    </>;
    if (settingsSection === "mcp") return <><CapabilitiesPanel sections={capSections.filter(section => section.kind === "mcp")} /><XuenessMcpTools /></>;
    if (settingsSection === "plugins") return <XuenessPluginSettingsPanel
      plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError}
      onRefresh={refreshPluginCatalog} onToggle={togglePlugin}
      onBrowse={isPluginEffective("extensions") ? () => setSettingsSection("marketplace") : undefined}
      resourceContent={isPluginEffective("extensions") ? <CapabilitiesPanel sections={capSections.filter(section => section.kind === "plugins")}
        onImportPlugin={async ({id,fields}) => { const result = await createCapabilityItem("plugins", {id,...fields,createOnly:true}); if(result.ok) await loadCapSlot("plugins"); return result; }}
        onRefreshPlugins={() => void loadCapSlot("plugins")} onBrowsePlugins={() => setSettingsSection("marketplace")} /> : undefined} />;
    if (settingsSection === "subagents") return <XuenessSubagentSettings
      providersEnabled={isPluginEffective("providers")}
      cancelOneEnabled={settingsValues.subagentCancelOneEnabled === true}
      settingsSaving={settingsSaving}
      onCancelOneEnabledChange={value => void handleUpdateSetting("subagentCancelOneEnabled", value)}
    />;
    if (pluginAvailability.capabilityKinds.includes(settingsSection as CapabilityKind)) return <CapabilitiesPanel sections={capSections.filter(section => section.kind === settingsSection)} />;
    if (settingsSection === "modules") return <XuenessPluginManager plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError} onRefresh={refreshPluginCatalog} onToggle={togglePlugin} />;
    if (settingsSection === 'subscriptions') return <SubscriptionsPanel embedded onChanged={() => void refreshComposerCatalog()} onSelectModel={id => { updateChoices({ provider: 'real', provider_id: id, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); setPanel('chat'); }} />;
    if (settingsSection === 'model-monitor') return <ModelMonitorPanel embedded />;
    if (settingsSection === "marketplace") return <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} onOpenOptional={async id => { await togglePlugin(id, true); setSettingsSection(id === 'model_monitor' ? 'model-monitor' : 'subscriptions'); }} />;
    if (settingsSection === "memory") return <XuenessMemorySettings enabled={settingsValues.memoryEnabled !== false} onEnabledChange={value => void handleUpdateSetting("memoryEnabled", value)} />;
    if (settingsSection === "usage") return <XuenessUsageSettings />;
    if (settingsSection === "automations") return <XuenessAutomationsPanel offPeakEnabled={isPluginEffective("automation")} />;
    if (settingsSection === "diagnostics") return <XuenessDiagnosticsPanel />;
    if (settingsSection === "remote") return <RemoteConnections onUse={id => { chooseWorkspace(composerCatalog.isolatedRoot, true); updateChoices({remote:id}); }} />;
    if (settingsSection === "runtimes") return <RuntimeSettingsPanel />;
    return null;
  };

  // -- view switcher (conversation header) ----------------------------------
  const viewSwitcher = (
    <Select
      className="xn-view-switcher"
      aria-label={tr("切换视图")}
      value={panel === "chat" ? "chat" : panel}
      onChange={(e) => setPanel(e.target.value as Panel)}
    >
      {allowedPanels.filter(id => !lightweightLayout || id !== "subagents").map((id) => (
        <option key={id} value={id}>
          {PANEL_LABELS()[id]}
        </option>
      ))}
    </Select>
  );

  const secondaryPanels: Record<Exclude<Panel, "chat">, React.ReactNode> = {
    remote: <RemoteConnections onUse={id => { chooseWorkspace(composerCatalog.isolatedRoot, true); updateChoices({ remote: id }); }} />,
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
    terminal: <TerminalPanel sessionId={activeId} fontSize={Number(settingsValues.terminalFontSize ?? 13)} fontFamily={String(settingsValues.terminalFontFamily ?? "system")} />,
    automations: <XuenessAutomationsPanel offPeakEnabled={isPluginEffective("automation")} />,
    marketplace: <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} onOpenOptional={async id => { await togglePlugin(id, true); setPanel(id === 'model_monitor' ? 'chat' : 'subscriptions'); }} />,
    subscriptions: <SubscriptionsPanel onChanged={() => void refreshComposerCatalog()} onSelectModel={id => { updateChoices({ provider: 'real', provider_id: id, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); setPanel('chat'); }} />,
    'model-monitor': <ModelMonitorPanel />,
    diagnostics: <XuenessDiagnosticsPanel />,
    runtimes: <RuntimeSettingsPanel />,
    files: (
      <FileBrowser
        files={files}
        truncated={filesTruncated}
        selectedPath={selectedPath}
        preview={preview}
        previewError={previewError}
        officePreviewEnabled={isPluginEffective("office")}
        onSelect={handleSelectFile}
      />
    ),
    changes: <DiffView changeSet={changeSet} error={changesError} />,
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
    directory: <DirectoryBrowser currentPath={dirListing?.path ?? null} entries={dirListing?.entries ?? []}
        error={dirError} truncated={dirListing?.truncated ?? false} loading={dirLoading}
        onNavigate={browseDirectory} onOpenFile={handleSelectFile} onCreateDir={handleCreateDir} />,
    providers: (
      <ModelManager focusProviderId={providerFocusId} runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { updateChoices({ provider: "real", provider_id: id || undefined, model: undefined, reasoning_effort: undefined }); setPanel("chat"); }} />
    ),
    usage: <XuenessUsageSettings />,
    memory: <><MemoryPanel tracks={tracks} error={tracksError} loading={tracksLoading} /><XuenessMemoryEditor /></>,
    capabilities: <><CapabilitiesPanel sections={capSections} />{isPluginEffective("mcp") && <XuenessMcpTools />}</>,
    settings: <XuenessSettingsView sections={settingsSections} activeSection={settingsSection} onSelect={setSettingsSection}
      dirty={settingsDirty} saving={settingsSaving} loading={settingsLoading} error={settingsError} account={settingsAccount}
      onBack={() => setPanel("chat")} onRetry={() => settingsDirty ? handleSaveSettings() : handleLoadAllSettings()}>
      <RegionBoundary resetKey={settingsSection} onReload={() => window.location.reload()} onRecover={() => setPanel("plugins")}><Suspense fallback={<p role="status" className="xn-view-loading">{tr("正在加载界面…")}</p>}>{settingsContent()}</Suspense></RegionBoundary>
    </XuenessSettingsView>,
  };

  const runPaletteCommand = useCallback((id: string) => {
    setCommandOpen(false);
    if (id === "new-task") startNewTask();
    else if (id === "open-settings" && isPluginEffective("settings")) setPanel("settings");
    else if (id === "refresh") void handleRefreshAll();
  }, [startNewTask, handleRefreshAll, isPluginEffective]);

  const liveSessions = useMemo(() => {
    return sessions.map(item => {
      let status = item.status;
      if (stoppingSessions.has(item.id)) status = "stopping";
      else if (runRequestSessions.has(item.id)) status = "running";
      else if (activeId === item.id && session?.id === item.id) {
        if (session.status === "running" || session.streaming?.status === "streaming") status = "running";
      }
      return status === item.status ? item : { ...item, status };
    });
  }, [sessions, stoppingSessions, runRequestSessions, activeId, session?.id, session?.status, session?.streaming?.status]);

  const displayTimelineRows = useMemo(() => usesRuntimeProjection ? rows : withAssistantStream(rows, session?.streaming), [rows, session?.streaming, usesRuntimeProjection]);
  // 上下文压缩边界：由 sessions 插件从合并后的行与 compactions 记录推导；
  // 行集合随轮询、更早分页与推送快照更新时自动重算。
  const compactionMarker = useMemo(() => session && session.id === activeId
    ? conversationCompactionBoundary(displayTimelineRows, session.compactions)
    : null, [displayTimelineRows, session, activeId]);
  const claudexAppearance = normalizeColorPalette(settingsLoading && typeof document !== 'undefined'
    ? document.documentElement.dataset.xnPalette : settingsValues.colorPalette) === 'claudex';
  const sidebarAppearance = claudexAppearance ? 'claudex' : 'xueness';
  const sidebarSizing = useSessionSidebarWidth(sidebarAppearance, isPluginEffective('sessions'));
  const sidebarActions: SidebarAction[] = [
    ...(isPluginEffective("sessions") ? [
      { id: "new-task", icon: claudexAppearance ? <SquarePen size={16} /> : <IconNewTask size={16} />, label: tr(claudexAppearance ? "新聊天" : "新建任务"), shortcut: resolveShortcutBinding("new-session", (settingsValues.bindings && typeof settingsValues.bindings === "object" ? settingsValues.bindings : {}) as Record<string, string>), onClick: startNewTask },
      { id: "search", icon: <IconSearch size={15} />, label: tr("搜索"), shortcut: resolveShortcutBinding("command-palette", (settingsValues.bindings && typeof settingsValues.bindings === "object" ? settingsValues.bindings : {}) as Record<string, string>), onClick: (event: React.MouseEvent<HTMLButtonElement>) => openCommandPalette(event.currentTarget) },
    ] : []),
    ...(isPluginEffective("automation") ? [{ id: "automations", icon: <CalendarClock size={16} />, label: tr("自动化"), onClick: () => setPanel("automations") }] : []),
    ...(isPluginEffective("extensions") ? [{ id: "marketplace", icon: <Blocks size={16} />, label: tr("插件市场"), onClick: () => setPanel("marketplace") }] : []),
  ];


  const railActions: SidebarAction[] = [
    { id: 'home', icon: <House size={18} />, label: tr('首页'), onClick: startNewTask },
    ...(isPluginEffective('sessions') ? [{ id: 'chat', icon: <MessagesSquare size={18} />, label: tr('搜索会话'), onClick: (event: React.MouseEvent<HTMLButtonElement>) => openCommandPalette(event.currentTarget) }] : []),
    ...sidebarActions.filter(action => action.id === 'automations'),
    ...(canShowPanel('capabilities') ? [{ id: 'capabilities', icon: <Library size={18} />, label: tr('能力'), onClick: () => setPanel('capabilities') }] : []),
    ...(isPluginEffective('memory') ? [{ id: 'memory', icon: <Brain size={18} />, label: tr('记忆'), onClick: () => setPanel('memory') }] : []),
  ];
  const railSecondaryActions: SidebarAction[] = [
    ...(isPluginEffective('git') ? [{ id: 'git', icon: <GitBranch size={18} />, label: tr('Git'), onClick: () => setPanel('git') }] : []),
    ...sidebarActions.filter(action => action.id === 'marketplace'),
  ];
  const railMoreActions: SidebarAction[] = allowedPanels.filter(id => !['chat','capabilities','memory','git','automations','marketplace','settings'].includes(id)).map(id => ({
    id, icon: id === 'files' || id === 'directory' ? <Folder size={16} /> : id === 'subagents' ? <Bot size={16} /> : <CircleHelp size={16} />,
    label: PANEL_LABELS()[id], onClick: () => setPanel(id),
  }));
  const sidebarMenuActions: SidebarAction[] = [...sidebarActions.filter(action => action.id !== 'search'),
    ...(isPluginEffective('settings') ? [{ id: 'settings', icon: <IconGear size={16} />, label: tr('设置'), onClick: () => setPanel('settings') }] : []),
    { id: 'plugins', icon: <Blocks size={16} />, label: tr('插件管理'), onClick: () => setPanel('plugins') },
  ];

  return (
    <CodeDisplayProvider settings={settingsValues.codePreviewSettings} dark={String(settingsValues.theme) === "dark" || (settingsValues.theme === "system" && systemDark)}>
    {isPluginEffective('onboarding') && isPluginEffective('desktop') && <Suspense fallback={null}>
      <DesktopPermissionOnboarding enabled={isPluginEffective('onboarding')} desktopEnabled={isPluginEffective('desktop')} />
    </Suspense>}
    <DesktopTrayBridge enabled={isPluginEffective('desktop')} sessionsEnabled={isPluginEffective('sessions')} busy={busy}
      activeId={activeId} locale={locale} dark={String(settingsValues.theme) === 'dark' || (settingsValues.theme === 'system' && systemDark)}
      onNew={startNewTask} onSession={selectTraySession} />
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
      navigationKey={`${panel}:${activeId ?? ""}:${commandOpen}:${workspacePicking}:${heroFocusTick}`}
      sidebarToggleToken={sidebarToggleToken}
      initialSidebarCollapsed={lightweightLayout}
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
        <>
          <SidebarActions
            actions={claudexAppearance ? sidebarActions.filter(action => action.id === 'new-task') : sidebarActions}
          />
          {isPluginEffective("sessions") && <>
          <XuenessTaskList sessions={liveSessions} activeId={activeId} busy={busy} compact={claudexAppearance}
            projectRoots={composerCatalog.roots.filter(root => root.path !== composerCatalog.isolatedRoot)}
            onAddProject={isPluginEffective("files") && isPluginEffective("settings") ? trigger => {
              if (busy) return;
              workspacePickerOpener.current = trigger;
              setWorkspacePickerMode("project");
              setWorkspacePicking(true);
            } : undefined}
            onStartProject={root => { chooseWorkspace(root, false, true); }}
            preferences={settingsValues.sidebarPreferences as SidebarPreferences | undefined}
            onPreferences={value => { void handleUpdateSetting("sidebarPreferences", value); }}
            onSelect={selectSession}
            onRename={requestRename} onArchive={id => { void deleteById(id); }}
            onPin={(id, pinned) => { void togglePin(id, pinned); }}
            onOpenArchived={() => setArchivedOpen(previous => !previous)} />
          <ArchivedSessions open={archivedOpen} disabled={busy} reloadKey={archivedRevision}
            onClose={() => setArchivedOpen(false)} onRestored={refreshList} />
          </>}
        </>
      )}
      sidebarFooter={
        <>
          <DesktopUpdates compact enabled={isPluginEffective('updates') && isPluginEffective('desktop')} onManage={() => { setSettingsSection('updates'); setPanel('settings'); }} />
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
      {commandPaletteEnabled && <CommandPalette
        dialogRef={commandDialogRef}
        inputRef={commandRef}
        sessions={sessions}
        busy={busy}
        sessionsEnabled={isPluginEffective("sessions")}
        settingsEnabled={isPluginEffective("settings")}
        onClose={() => setCommandOpen(false)}
        onRunCommand={runPaletteCommand}
        onSelectSession={(id, query) => {
          selectSession(id);
          setConversationFindRequest(query ? {sessionId: id, id: crypto.randomUUID(), query} : null);
        }}
      />}

      {(error || dataErrors.active || dataErrors.list) && (
        <div role="alert" className="xn-error-banner">
          <span>{error || dataErrors.active || dataErrors.list}</span>
          <button type="button" disabled={busy} onClick={() => { setError(""); void handleRefreshAll(); }}>{tr("重新加载")}</button>
        </div>
      )}

      <RegionBoundary resetKey={`${panel}:${activeId ?? "hero"}`} onReload={() => window.location.reload()} onRecover={() => setPanel("plugins")}><Suspense fallback={<p role="status" className="xn-view-loading">{tr("正在加载界面…")}</p>}>
      {panel === "settings" ? secondaryPanels.settings : panel !== "chat" ? (
        <div className="xn-secondary-view">
          <div className="xn-secondary-view__bar">
            <button type="button" className="xn-secondary-view__back" onClick={() => setPanel("chat")}>
              <IconBack size={14} />{tr("返回会话")}</button>
            <span className="xn-secondary-view__title">{PANEL_LABELS()[panel]}</span>
            <div className="xn-secondary-view__switcher">{viewSwitcher}</div>
          </div>
          <div className="xn-secondary-view__body">
            {canShowPanel(panel) && (!lightweightLayout || panel !== "subagents")
              ? secondaryPanels[panel]
              : <FeatureUnavailable feature={PANEL_LABELS()[panel]} onManage={() => setPanel("plugins")} />}
          </div>
        </div>
      ) : !isPluginEffective("sessions") ? (
        <FeatureUnavailable feature={tr("会话")} onManage={() => setPanel("plugins")} />
      ) : activeId && session?.id !== activeId ? (
        <div role="status" className="xn-hero"><p>{tr("正在加载任务…")}</p></div>
      ) : session ? (
        <div className="xn-conversation-container">
          <div className="xn-conversation">
            <WorkbenchHeader
              session={session}
              actions={<>
                {!lightweightLayout && <>{viewSwitcher}<button type="button" className="xn-conv-header__action xn-conv-header__fork" aria-label={tr("分叉会话")} title={tr("分叉会话")} disabled={busy || session.status === "running" || session.streaming?.status === "streaming"} onClick={() => beginFork()}><GitBranch size={14} aria-hidden="true" /><span>{tr("分叉会话")}</span></button></>}
                <button type="button" className="xn-conv-header__action" aria-label={tr("会话信息")} title={tr("会话信息")}
                  aria-pressed={contextSidepaneOpen} onClick={() => { setContextSidepaneOpen(value => !value); }}><PanelRight size={16} aria-hidden="true" /></button>
              </>}
            pinned={session.pinned === true}
            onTogglePin={() => activeId && void togglePin(activeId, session.pinned !== true)}
            onRefresh={() => void handleRefreshAll()}
            onRename={() => activeId && requestRename(activeId)}
            onDelete={() => activeId && void deleteById(activeId)}
            menuItems={<>
              {isPluginEffective('planning') && <button type="button" className="xn-conv-header__action"
                disabled={busy || activeSessionRunning}
                onClick={() => setDeliveryEditorRequest(previous => ({id: session.id, version: (previous?.version ?? 0) + 1}))}>
                {tr('编辑交付清单')}</button>}
              {isPluginEffective('sessions') && <button type="button" className="xn-conv-header__action"
                disabled={busy || activeSessionRunning}
                onClick={() => setShareDialogOpen(true)}>
                <Share2 size={14} aria-hidden="true" /><span>{tr('分享会话')}</span></button>}
            </>}
          />
          <ConversationShareDialog key={session.id} open={shareDialogOpen} session={session}
            onClose={() => setShareDialogOpen(false)} />
          {isPluginEffective('model_monitor') && <Suspense fallback={null}><ModelMonitorHome key={session.id} sessionId={session.id}
            providerId={choices.provider_id} requestedModel={choices.model ?? selectedComposerModel?.model} providerName={selectedComposerModel?.supplierName ?? selectedComposerModel?.name}
            running={activeSessionRunning} onOpenHistory={() => setPanel('model-monitor')} /></Suspense>}
          {!isPluginEffective('model_monitor') && <PluginHomeEntry plugin={pluginCatalog.find(plugin => plugin.id === 'model_monitor')}
            onManage={() => setPanel(pluginCatalog.find(plugin => plugin.id === 'model_monitor')?.installed === false && isPluginEffective('extensions') ? 'marketplace' : 'plugins')} />}
          {goalEditorOpen && activeId && session?.id === activeId && isPluginEffective('planning') &&
            <GoalEditorDialog key={`goal-editor:${activeId}`} sessionId={activeId} goal={session.goal}
              onClose={() => setGoalEditorOpen(false)} onSaved={() => void loadActive(activeId)} />}
          {isPluginEffective('planning') && !lightweightLayout && <SessionGoal sessionId={session.id} goal={session.goal}
            disabled={busy || session.status === 'running'} onChanged={() => void handleRefreshAll()} />}
          {session.forkParent && <p className="xn-session-fork-provenance" data-testid="fork-session-provenance" role="note">
            {tf("从会话 {0} 的第 {1} 轮分叉", [session.forkParent.sourceId, session.forkParent.turn])}
            {session.forkParent.historyTruncated && <span>{tr(" · 较早的压缩归档未继承，仅保留当前可定位历史")}</span>}
            <button type="button" className="xn-session-fork-provenance__open" data-testid="fork-open-parent" disabled={busy} onClick={() => selectSession(session.forkParent!.sourceId)}>{tr("打开原会话")}</button>
          </p>}
          {session.pause_reason && ["paused", "needs_review"].includes(session.status) && <p role="status" className="xn-run-error">{tf("暂停原因：{0}", [session.pause_reason])}</p>}
          {isPluginEffective('planning') && <CompletionChecks compact openEditorRequest={deliveryEditorRequest?.id === session.id ? deliveryEditorRequest.version : 0}
            sessionId={session.id} completion={session.completion} items={session.delivery_requirements ?? []} disabled={busy || session.status === 'running'} onSaved={() => void handleRefreshAll()} />}
          {isPluginEffective('providers') && <RequestTiming session={session} />}
          {activeRuntimeProfile === "lightweight" && isPluginEffective("providers") && isPluginEffective("diagnostics") &&
            <LocalRuntimeMonitor lightweight session={runtimeMonitorSession} />}
          {session.pending && session.pending.length > 0 && (
            <div className="xn-conversation__approvals">
              <Approvals pending={session.pending} onApprove={handleApprove} onApproveAll={handleApproveAll} busy={busy || runRequestSessions.has(session.id)} />
            </div>
          )}
          {isPluginEffective("mcp") && <McpElicitation sessionId={session.id} />}
          <PendingQuestion sessionId={session.id} pendingQuestion={session.status === "awaiting_user" ? session.pending_question : null}
            enabled={isPluginEffective("sessions")}
            disabled={busy || runRequestSessions.has(session.id)} onSubmitted={handleQuestionSubmitted} />
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
            <ZCodeConversation sessionId={session.id} rows={displayTimelineRows}
              compactionMarker={compactionMarker}
              findRequest={conversationFindRequest?.sessionId === session.id ? conversationFindRequest : undefined}
              collapseTools={settingsValues.collapseTools !== false}
              showReasoning={settingsValues.messageStreamShowReasoning !== false}
              autoScroll={settingsValues.autoScroll !== false}
              jsonToolProtocol={session.model_selection?.tool_calling === "json" && activeRuntimeProfile === "lightweight" && session.streaming?.text_format !== "markdown"}
              streamingPending={activeSessionRunning} activityPhase={session.runtime_activity?.phase}
              pendingToolIds={new Set((session.pending ?? []).map(item => item.tool_call_id))}
              onRetry={!busy && !activeSessionRunning ? handleRetryTool : undefined}
              onEdit={!busy && !activeSessionRunning ? handleMessageEdit : undefined}
              onFeedback={!busy && !activeSessionRunning ? handleMessageFeedback : undefined}
              onFork={!busy && !activeSessionRunning ? row => beginFork(/^turn-[1-9][0-9]*$/u.test(row.turnId) ? Number(row.turnId.slice(5)) : undefined) : undefined}
              renderSelectionAction={selection => <ConversationSelectionActions key={`${selection.rowKey}:${selection.text}`} selection={selection}
                sideActionDisabled={busy || activeSessionRunning} onAdd={handleAddSelectionToCurrentTask} onAsk={handleAskSelectionInSideChat} />} />
            {session.streaming?.status === "interrupted" && session.streaming.text && <p role="status" className="xn-run-error">{tr("输出已中断，已保留收到的内容。")}</p>}
          </ConversationTimelineViewport>
          <QuestionResume enabled={isPluginEffective("sessions")}
            resumeBudgetEnabled={isPluginEffective("sessions")} pauseCode={session.pause_code}
            status={session.status} pendingQuestion={session.pending_question} disabled={busy || runRequestSessions.has(session.id)} onResume={handleRetryRun} />
          {(runError || session.status === "provider_error" || (!busy && !runRequestSessions.has(session.id) && session.status === "pending")) && (
            <div className={runError || session.status === "provider_error" ? "xn-run-error" : "xn-run-recovery"}>
              {runError && <p role="alert">{runError}</p>}
              <button className="xn-zc-retry" type="button" disabled={busy || runRequestSessions.has(session.id)} onClick={() => void handleRetryRun()}>{tr("重试运行")}</button>
            </div>
          )}
          {/* 队列 bottom dock：贴在 composer 上方，与输入框融合成底 dock（对标 ZCode -mb-7 pb-7 磨砂贴合）。 */}
          {((session.queued_messages?.length ?? 0) > 0 || (session.pending_guidance?.length ?? 0) > 0 || queueError?.sessionId === session.id) && (
            <div className="xn-queue-dock" data-testid="session-queue-dock">
              <PendingGuidancePanel items={session.pending_guidance ?? []}
                onWithdraw={handleWithdrawGuidance} busyId={queueCancelling?.sessionId === session.id ? queueCancelling.queueId : null}
                disabled={busy || queueSubmittingSessions.has(session.id) || !isPluginEffective('sessions')} />
              <SessionQueue key={session.id} items={session.queued_messages ?? []} cancellingId={queueCancelling?.sessionId === session.id ? queueCancelling.queueId : null} onCancel={handleCancelQueuedTurn}
                onWithdraw={handleWithdrawQueuedTurn}
                onSendNow={activeSessionRunning && session.active_turn_id ? handleSendNowQueuedTurn : undefined}
                onEdit={handleEditQueuedMessage} onReorder={handleReorderQueuedMessages} currentId={session.current_queue_item_id} disabled={busy || queueSubmittingSessions.has(session.id) || !isPluginEffective("sessions")}
                canContinue={session.status !== "running" && session.streaming?.status !== "streaming" && (session.queued_messages ?? []).some(item => item.status === "paused")}
                continuing={queueContinuingSessions.has(session.id)} onContinue={handleContinueQueuedMessages} />
              {queueError?.sessionId === session.id && <p className="xn-session-queue__error" role="alert">{queueError.message}</p>}
            </div>
          )}
            <Composer
              draftKey={`session:${session.id}`}
              draftStore={composerDraftStore}
              workspaceKey={commandRoot || "default"}
              inputRef={heroInputRef}
              platform={resolveHostPlatform()}
              sendShortcut={settingsValues.sendShortcut === "mod-enter" ? "mod-enter" : "enter"}
              onSend={handleSend}
              disabled={composerDisabled}
              sendDisabled={!composerModelReady || composerCatalogLoading}
              sendDisabledReason={composerSendDisabledReason}
              running={composerRunning}
              queueWhenRunning
              guideWhenRunning={Boolean(session.active_turn_id)}
              queueBusy={queueSubmittingSessions.has(session.id) || queueContinuingSessions.has(session.id)}
              stopping={stoppingSessions.has(session.id)}
              onStop={handleStop}
              placeholder={tr("继续描述任务（/ 命令，@ 上下文，$ 技能）")}
              controls={composerControls}
              startActions={composerStartActions}
          capabilities={(composerCatalog.capabilities ?? []).map(item => ({ ...item, available: item.available !== false && isPluginEffective(item.pluginId) }))}
              mentions={composerMentions}
              commands={isPluginEffective("commands") ? commandItems : []}
              files={files.map((f) => f.path)}
            />
            {lightweightLayout && <LightweightStatusBar workspaceRoot={draftRoot ?? composerCatalog.root}
              reportedUsage={extractReportedUsage(session.provider_usage)}
              status={composerRunning ? "running" : (runError || session.status === "provider_error") ? "error" : session.status}
              stopping={stoppingSessions.has(session.id)} interrupted={session.streaming?.status === "interrupted"}
              queueCount={(session.queued_messages ?? []).length} />}
          </div>
          {contextSidepaneOpen && <SessionContextPane key={session.id} session={session} rows={displayTimelineRows}
            filesEnabled={isPluginEffective('files')} onOpenFile={path => { void handleSelectFile(path); setPanel('files'); }}
            onBrowseFiles={isPluginEffective('files') ? () => setPanel('files') : undefined} onClose={() => setContextSidepaneOpen(false)}
            subagents={isPluginEffective('subagents') && !lightweightLayout ? <Suspense fallback={null}><SubagentSidePane
              sessionId={session.id} mode="summary" activeRuntimeProfile={activeRuntimeProfile} subagentsEnabled={isPluginEffective('subagents')}
              onOpenTasks={() => setPanel('subagents')} /></Suspense> : undefined} />}
        </div>
      ) : (
        <div className="xn-hero" data-testid="xn-hero">
          {!lightweightLayout && <div className="xn-hero__bar"><details className="xn-workbench-menu"><summary aria-label={tr("工作台")}><CircleHelp size={16} /></summary><div>{viewSwitcher}</div></details></div>}
          <div className="xn-hero__intro">
            <div className="xn-hero__brand" aria-hidden="true">
              <IconXuenessMark size={34} className="xn-hero__brand-mark" />
            </div>
            <h1 className="xn-hero__greeting">{claudexAppearance ? tf("我们应该在 {0} 中做些什么？", [composerCatalog.roots.find(item => item.path === (draftRoot ?? composerCatalog.root))?.name ?? (draftRoot ?? composerCatalog.root)?.split(/[/\\]/u).filter(Boolean).pop() ?? "Xueness"]) : heroGreeting(new Date())}</h1>
            <p className="xn-hero__hint">{tr("描述你想完成的事，Xueness 会在你的工作区里执行。")}</p>
          </div>

          <div className="xn-hero__composer">
            {isPluginEffective('model_monitor') ? <Suspense fallback={null}><ModelMonitorHome key="new-chat"
              providerId={choices.provider_id} requestedModel={choices.model ?? selectedComposerModel?.model} providerName={selectedComposerModel?.supplierName ?? selectedComposerModel?.name}
              onOpenHistory={() => setPanel('model-monitor')} /></Suspense> : <PluginHomeEntry plugin={pluginCatalog.find(plugin => plugin.id === 'model_monitor')}
              onManage={() => setPanel(pluginCatalog.find(plugin => plugin.id === 'model_monitor')?.installed === false && isPluginEffective('extensions') ? 'marketplace' : 'plugins')} />}
            {claudexAppearance && <div className="xn-hero__workspace">{workspaceContext}<span className="xn-composer-workspace__host"><Monitor size={15} aria-hidden="true" />{choices.remote ? tr("SSH 工作区") : tr("此计算机")}</span></div>}
            {runError && (
              <p role="alert" className="xn-run-error">{runError}</p>
            )}
              <Composer
                draftKey="new-task"
                draftStore={composerDraftStore}
                workspaceKey={commandRoot || "default"}
                platform={resolveHostPlatform()}
                sendShortcut={settingsValues.sendShortcut === "mod-enter" ? "mod-enter" : "enter"}
                variant="hero"
                topContent={claudexAppearance ? undefined : workspaceContext}
                inputRef={heroInputRef}
                onSend={handleCreate}
                disabled={busy || !commandRoot || !isPluginEffective("sessions")}
                sendDisabled={creatingSession || !composerModelReady || composerCatalogLoading}
                sendDisabledReason={composerSendDisabledReason}
                running={composerRunning}
                stopping={activeId ? stoppingSessions.has(activeId) : false}
                onStop={activeId ? handleStop : undefined}
                placeholder={tr("向 Xueness 提问，使用 @ 添加上下文，使用 / 选择命令或能力")}
                controls={composerControls}
                startActions={composerStartActions}
          capabilities={(composerCatalog.capabilities ?? []).map(item => ({ ...item, available: item.available !== false && isPluginEffective(item.pluginId) }))}
                mentions={composerMentions}
                commands={isPluginEffective("commands") ? commandItems : []}
                files={files.map((f) => f.path)}
              />
            {!composerCatalogLoading && !composerModelReady && (composerCatalogError || composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal) && <div className="xn-composer-model-setup" role="status">
              <span>{tr(composerCatalogError ? "模型列表加载失败，请重试。" : composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal ? "服务端已关闭模型请求。" : "配置一个模型即可开始对话。")}</span>
              <button type="button" onClick={() => composerCatalogError ? void refreshComposerCatalog() : setPanel(isPluginEffective("providers") ? "providers" : "plugins")}>{tr(composerCatalogError ? "重试" : "配置模型")}</button>
            </div>}
          </div>
          {!lightweightLayout && <XuenessStartPage
            actions={startPageActions}
            projects={recentProjects}
            sessions={liveSessions}
            locale={locale}
            onSelectSession={selectSession}
            onSelectProject={root => chooseWorkspace(root)}
          />}
        </div>
      )}

      </Suspense></RegionBoundary>

      <XuenessWorkspacePickerDialog open={workspacePicking} currentRoot={draftRoot ?? composerCatalog.root} returnFocusTo={workspacePickerOpener.current}
        mode={workspacePickerMode}
        onChoose={chooseWorkspace} onCancel={() => setWorkspacePicking(false)} />

      <XuenessCloneDialog open={cloneOpen && isPluginEffective("git")}
        defaultParent={(draftRoot ?? composerCatalog.root) ?? null}
        returnFocusTo={cloneOpener.current}
        onCancel={() => setCloneOpen(false)}
        onCloned={(root) => { setCloneOpen(false); void refreshRecentProjects(); chooseWorkspace(root); }} />

      <XuenessRenameDialog
        open={renameRequest !== null}
        initialValue={renameRequest?.initialValue ?? ""}
        returnFocusTo={renameOpenerRef.current}
        onCancel={() => setRenameRequest(null)}
        onConfirm={(value) => {
          const request = renameRequest;
          setRenameRequest(null);
          if (request) void renameById(request.id, value);
        }}
      />

      <XuenessCapabilityDialog
        open={capDialog !== null}
        mode={capDialog?.mode ?? "create"}
        kind={capDialog?.kind ?? "skills"}
        initial={capDialog?.initial ?? null}
        busy={capDialogBusy}
        error={capDialogError || undefined}
        onCancel={() => setCapDialog(null)}
        onSubmit={(payload) => void handleCapSubmit(payload)}
      />
      {runPermission.dialog}
      <ForkSessionDialog
        open={forkSource !== null}
        sourceId={forkSource?.id ?? ""}
        sourceTitle={forkSource?.title ?? ""}
        initialTurn={forkSource?.turn}
        onCancel={() => setForkSource(null)}
        onFork={completeFork}
      />
    </Shell>
    </CodeDisplayProvider>
  );
}
