import { listPlugins, listResources, setPluginEnabled, post, type XuenessPlugin } from "./xuenessApi";
import { t as tr, tf, useLocale, setLocale } from './i18n';
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
import React, { useCallback, useEffect, useRef, useState } from "react";
import "./styles/command.css";
import "./styles/batch10.css";
import {
  approvePending,
  createSession,
  deleteSession,
  renameSession,
  pinSession,
  listArchivedSessions,
  restoreSession,
  deriveFileChanges,
  listSessions,
  loadFilePreview,
  loadFiles,
  loadJournal,
  loadSession,
  runSession,
  sendTurn,
  toTimelineRows,
  hydrateTimelineTools,
  hydrateTimelineJournalRows,
  withInitialUserMessage,
  loadCompleteTimeline,
  withAssistantStream,
  type ArchivedSummary,
  type ForkSessionResponse,
  type FileChangeSet,
  type FilePreview,
  type PendingApproval,
  type Result,
  type SessionSummary,
  type TimelineRow,
  type WorkbenchSession,
} from "./xuenessWorkbench";
import {
  capabilityPatch,
  loadWorkbenchSettings,
  readAgentCapabilities,
  saveWorkbenchSettings,
  type AgentCapabilities,
  type SettingsMap,
} from "./xuenessSettings";
import { FileBrowser } from "./plugins/files/FileBrowser";
import { DiffView } from "./plugins/files/DiffView";
import { DirectoryBrowser } from "./plugins/files/DirectoryBrowser";
import { MemoryPanel } from "./plugins/memory/MemoryPanel";
import { ProvidersPanel } from "./plugins/providers/ProvidersPanel";
import { SettingsSections } from "./plugins/settings/SettingsSections";
import { UsagePanel } from "./plugins/usage/UsagePanel";
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
import { effectiveRuntimeProfile, emptyComposerCatalog, prepareComposer, runtimeProfileFromSession, switchComposerBranch, type ComposerCatalog, type ComposerInput } from "./xuenessComposer";
import { createComposerCatalogLoader, clearWorkspaceComposerCatalog } from './plugins/sessions/composerCatalogLifecycle';
import { ComposerWorkspaceSelect } from './plugins/sessions/ComposerWorkspaceSelect';
import { XuenessComposerToolbar } from "./plugins/sessions/XuenessComposerToolbar";
import { DesktopSettings } from "./plugins/desktop/DesktopSettings";
import { DesktopTitlebar } from "./plugins/desktop/DesktopTitlebar";
import { DesktopTrayBridge } from './plugins/desktop/DesktopTrayBridge';
import { XuenessSettingsView } from "./plugins/settings/XuenessSettingsView";
import { settingsNavigation } from "./xuenessSettingsNavigation";
import { CompletionChecks } from './plugins/planning/CompletionChecks';
import { NetworkSettings } from './plugins/network/NetworkSettings';
import { DesktopUpdates } from './plugins/updates/DesktopUpdates';
import { XuenessWorkspaceSettings } from "./plugins/settings/XuenessWorkspaceSettings";
import { WorkflowPanel } from "./plugins/workflows";
import { ModelManager } from "./plugins/providers";
import { LocalRuntimeMonitor, RequestTiming, type LocalRuntimeSession } from "./plugins/providers/LocalRuntimeMonitor";
import { ForkSessionDialog } from "./plugins/sessions";
import { TerminalPanel } from "./plugins/terminal";
import { RemoteConnections } from "./plugins/remote";
import { Approvals, Composer, WorkbenchHeader, heroGreeting } from "./plugins/sessions/XuenessWorkbenchView";
import { IconBack, IconGear, IconNewTask, IconSearch, IconWorkflow, IconModel, IconXuenessMark } from "./ui/icons";
import { CalendarClock, Archive, ArrowDownWideNarrow, ChevronsDownUp, Folder, Hash, MessageCirclePlus, UserRound, CircleHelp, ChevronDown, Blocks, GitBranch } from "lucide-react";
import { Select } from "./ui/Select";
import { XuenessTaskList, type SidebarPreferences } from "./plugins/sessions/XuenessTaskList";
import { XuenessWorkspacePickerDialog } from "./plugins/settings/XuenessWorkspacePickerDialog";
import { CodeDisplayProvider } from "./ui/CodeContent";
import { SHORTCUT_COMMANDS, resolveShortcutBinding } from "./xuenessShortcutCommands";
import { Shell, SidebarActions, SidebarNav } from "./XuenessShell";
import { TimelineStream, TaskTodos } from "./plugins/sessions/XuenessTimeline";
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
import { fuzzyFilter } from "./xuenessFuzzy";
import { XuenessGitView } from "./plugins/git/XuenessGitView";
import { XuenessMarketplace } from "./plugins/extensions";
import { XuenessAutomationsPanel } from "./plugins/automation";
import { XuenessMcpTools } from "./plugins/mcp";
import { XuenessDiagnosticsPanel } from "./plugins/diagnostics";
import { shouldDismissModalOnEscape, useModalFocusScope } from "./plugins/shared";
import { XuenessMemoryEditor } from "./plugins/memory";
import { XuenessMemorySettings } from "./plugins/memory/MemorySettings";
import { XuenessUsageSettings } from "./plugins/usage/XuenessUsageSettings";
import { BrowserSettings } from "./plugins/browser/BrowserSettings";
import { XuenessSubagentSettings } from "./plugins/subagents/SubagentSettings";
import { FeatureUnavailable, XuenessPluginManager, XuenessPluginSettingsPanel } from "./XuenessPluginManager";
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

/** Palette commands with honest descriptions; ids double as fuzzy keys. */
const PALETTE_COMMANDS = (): { id: string; label: string; description: string }[] => ([
  { id: "new-task", label: tr("新建任务"), description: tr("回到空态输入卡开始新任务") },
  { id: "open-settings", label: tr("打开设置"), description: tr("运行参数与 Agent 能力开关") },
  { id: "refresh", label: tr("刷新历史"), description: tr("重新加载任务列表与当前会话") },
]);

/** Settings defaults. Capabilities default OFF and are read fail-closed. */
const SETTINGS_DEFAULTS: SettingsMap = {
  allowMcp: false,
  allowSubagents: false,
  allowHooks: false,
  theme: "system",
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

function matchesShortcut(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.at(-1);
  if (!key || (event.key === " " ? "space" : event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase()) !== key) return false;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const expectsCtrl = parts.includes("ctrl") || (parts.includes("mod") && !isMac);
  const expectsMeta = parts.includes("meta") || (parts.includes("mod") && isMac);
  return expectsCtrl === event.ctrlKey && expectsMeta === event.metaKey && parts.includes("shift") === event.shiftKey && parts.includes("alt") === event.altKey;
}

type Panel =
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
  | "plugins";

const PANEL_LABELS = (): Record<Panel, string> => ({
  ...Object.fromEntries(Object.entries(PLUGIN_PANEL_LABELS).map(([id, label]) => [id, tr(label)])) as Record<PluginPanel, string>,
  plugins: tr("插件管理"),
});

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
  const refreshPluginCatalog = useCallback(async () => {
    setPluginCatalogLoading(true);
    try {
      const result = await listPlugins();
      setPluginCatalog(result.plugins);
      setPluginCatalogError("");
    } catch (reason) {
      setPluginCatalog([]);
      setPluginCatalogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPluginCatalogReady(true);
      setPluginCatalogLoading(false);
    }
  }, []);
  const togglePlugin = useCallback(async (id: string, enabled: boolean) => {
    try {
      const result = await setPluginEnabled(id, enabled);
      setPluginCatalog(result.plugins);
      setPluginCatalogError("");
      setPluginCatalogReady(true);
    } catch (reason) {
      await refreshPluginCatalog();
      throw reason;
    }
  }, [refreshPluginCatalog]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  const [session, setSession] = useState<WorkbenchSession | null>(null);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [forkSource, setForkSource] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState("");
  const [dataErrors, setDataErrors] = useState({ list: "", active: "" });
  const [runError, setRunError] = useState("");
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [stopping, setStopping] = useState(false);
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
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<RunChoices>(getRunChoices);
  const [composerCatalog, setComposerCatalog] = useState<ComposerCatalog>(emptyComposerCatalog);
  const [composerCatalogLoading, setComposerCatalogLoading] = useState(false);
  const [composerCatalogError, setComposerCatalogError] = useState("");
  const [draftRoot, setDraftRoot] = useState<string | undefined>();
  const [isolatedWorkspace, setIsolatedWorkspace] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspacePickerMode, setWorkspacePickerMode] = useState<"workspace" | "project">("workspace");
  const workspacePickerOpener = useRef<HTMLElement | null>(null);
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
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineFollowTailRef = useRef(true);

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
  useModalFocusScope({
    open: commandOpen,
    dialogRef: commandDialogRef,
    initialFocusRef: commandRef,
    returnFocusTo: commandOpenerRef.current,
  });

  const openCommandPalette = useCallback((returnFocusTo?: HTMLElement | null) => {
    if (commandOpen) return;
    commandOpenerRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCommandOpen(true);
  }, [commandOpen]);

  const refreshList = useCallback(async () => {
    if (!isPluginEffective("sessions")) {
      setSessions([]);
      return;
    }
    const res = await listSessions();
    if (res.ok) setSessions(res.value);
    setDataErrors(previous => ({ ...previous, list: res.ok ? "" : res.error }));
  }, [isPluginEffective]);

  const beginFork = useCallback(() => {
    const isRunning = session?.status === "running" || session?.streaming?.status === "streaming";
    if (!activeId || session?.id !== activeId || busy || isRunning || !isPluginEffective("sessions")) return;
    setForkSource({ id: activeId, title: session.title || session.task || tr("未命名任务") });
  }, [activeId, session, busy, isPluginEffective]);

  const selectSession = useCallback((id: string) => {
    if (busy) return;
    setPanel("chat");
    setActiveId(id);
  }, [busy]);

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
    setSessions(previous => [{ id: child.id, task: title, title, status: child.status, root: child.root }, ...previous.filter(item => item.id !== child.id)]);
    void refreshList();
    // The modal is bound to its opening session. A slow fork must not steal focus
    // if the user has navigated to a different conversation in the meantime.
    if (activeIdRef.current !== source.id) return;
    loadedSessionChoices.current = null;
    setRunError("");
    setStopping(false);
    setPanel("chat");
    setActiveId(child.id);
  }, [forkSource, refreshList]);

  const loadActive = useCallback(async (id: string, includeFiles = true) => {
    if (!isPluginEffective("sessions")) return;
    // Detail carries pending/approved/changed_files; the timeline carries the
    // real tool_call/tool_result sequence. Both come from the server; neither is
    // reconstructed client-side.
    const [detail, timeline, journal] = await Promise.all([
      loadSession(id),
      loadCompleteTimeline(id),
      loadJournal(id),
    ]);
    if (activeIdRef.current !== id) return;
    if (detail.ok) setSession(detail.value);
    if (timeline.ok) setRows(withInitialUserMessage(hydrateTimelineJournalRows(hydrateTimelineTools(toTimelineRows(timeline.value.events), journal.ok ? journal.value : null), journal.ok ? journal.value : null, detail.ok ? detail.value.reasoning_history : []), journal.ok ? journal.value : null, detail.ok ? detail.value.task : undefined));
    setDataErrors(previous => ({ ...previous, active: !detail.ok ? detail.error : !timeline.ok ? timeline.error : "" }));
    // @ 文件提及候选：会话工作区文件列表（失败静默，composer 不出建议）。
    if (includeFiles && isPluginEffective("files")) {
      const listing = await loadFiles(id);
      if (activeIdRef.current !== id) return;
      if (listing.ok) {
        setFiles(listing.value.files);
        setFilesTruncated(listing.value.truncated);
      }
    }
  }, [isPluginEffective]);

  useEffect(() => {
    if (!activeId || !(busy || stopping || session?.status === "running" || session?.streaming?.status === "streaming")) return;
    const id = activeId;
    const timer = window.setInterval(() => { void loadActive(id, false); }, 1000);
    return () => window.clearInterval(timer);
  }, [activeId, busy, stopping, session?.status, session?.streaming?.status, loadActive]);
  useEffect(() => {
    if (session?.id === activeId && session?.status !== "running" && session?.streaming?.status !== "streaming") setStopping(false);
  }, [activeId, session?.id, session?.status, session?.streaming?.status]);

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
    if (isPluginEffective("commands")) {
      void (async () => {
        const res = await loadCapabilitySection("commands");
        if (res.ok) setCommandItems(res.value.items.map((item) => ({ id: item.id, description: item.description })));
        else setCommandItems([]);
      })();
    } else setCommandItems([]);
  }, [pluginCatalogReady, pluginCatalog, isPluginEffective, refreshList]);

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
  useEffect(() => {
    if (!session || session.id !== activeId || executing || loadedSessionChoices.current === session.id) return;
    loadedSessionChoices.current = session.id;
    updateChoices({
      remote: session.remote_connection?.id,
      browser: session.browser_enabled === true && isPluginEffective("browser"),
      ...(session.model_selection ? {
        provider_id: session.model_selection.provider_id || undefined,
        model: session.model_selection.model || undefined,
        reasoning_effort: session.model_selection.reasoning_effort || undefined,
      } : {}),
      runtime_profile: runtimeProfileFromSession(session.runtime_profile),
      ...(session.permission_mode ? { permission_mode: session.permission_mode } : {}),
      mode: session.mode === "plan" ? "plan" : "build",
    });
  }, [session, activeId, executing, updateChoices, isPluginEffective]);

  const startNewTask = useCallback(() => {
    if (busy) return;
    setCommandOpen(false);
    setStopping(false);
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
  }, [busy, settingsValues.browserControlEnabled, isPluginEffective, updateChoices, composerRequests]);

  useEffect(() => {
    if (!commandOpen) return;
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
  }, [commandOpen]);
  useEffect(() => {
    if (!activeId && !session) heroInputRef.current?.focus();
  }, [heroFocusTick, activeId, session]);


  useEffect(() => {
    if (settingsValues.language === "zh" || settingsValues.language === "en") setLocale(settingsValues.language);
  }, [settingsValues.language]);
  useEffect(() => { timelineFollowTailRef.current = true; }, [activeId]);
  useEffect(() => {
    if (panel === "chat" && settingsValues.autoScroll !== false && timelineFollowTailRef.current && timelineScrollRef.current)
      timelineScrollRef.current.scrollTop = timelineScrollRef.current.scrollHeight;
  }, [rows, session?.streaming?.text, panel, settingsValues.autoScroll]);

  useEffect(() => {
    const theme = String(settingsValues.theme ?? "system");
    const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", Boolean(isDark));
    document.documentElement.style.setProperty("--xn-ui-font-size", `${Math.min(24, Math.max(12, Number(settingsValues.fontSize) || 14))}px`);
    document.documentElement.dataset.xnTabSize = String([2, 4, 8].includes(Number(settingsValues.tabSize)) ? Number(settingsValues.tabSize) : 2);
    document.documentElement.dataset.xnWordWrap = settingsValues.wordWrap === false ? "off" : "on";
  }, [settingsValues.theme, settingsValues.fontSize, settingsValues.tabSize, settingsValues.wordWrap]);

  useEffect(() => {
    if (settingsValues.theme !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (event: MediaQueryListEvent | MediaQueryList) => {
      document.documentElement.classList.toggle("dark", event.matches);
      setSystemDark(event.matches);
    };
    apply(query);
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, [settingsValues.theme]);

  useEffect(() => {
    setSession(null);
    setRows([]);
    setDataErrors(previous => ({ ...previous, active: "" }));
  }, [activeId]);
  useEffect(() => {
    if (activeId) void loadActive(activeId);
  }, [activeId, loadActive]);

  const handleApprove = useCallback(
    async (pending: PendingApproval) => {
      if (!activeId || !isPluginEffective("sessions")) return;
      // Approving only records the grant; the denied call is replayed on the
      // next run. The button says "approve and retry", so actually retry here —
      // otherwise the pending item never clears and the promise is hollow.
      const granted = await run(() => approvePending(activeId, pending));
      if (!granted) return;
      setExecuting(true);
      try { await run(() => runSession(activeId, getRunChoices())); }
      finally { setExecuting(false); setStopping(false); }
      await loadActive(activeId);
      await refreshList();
    },
    [activeId, isPluginEffective, run, loadActive, refreshList],
  );

  const handleSend = useCallback(
    async (text: string, input?: ComposerInput) => {
      if (!activeId || session?.id !== activeId || busy || !isPluginEffective("sessions")) return false;
      const value = text.trim() || tr("附件与上下文");
      let accepted = false;
      setExecuting(true);
      const ok = await run(async () => {
        const selected = getRunChoices();
        try {
          const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { session_id: activeId, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
          const result = await sendTurn(activeId, value, { ...selected, goal: prepared.goal }, prepared.token);
          accepted = result.ok || result.accepted === true;
          return result;
        } catch (reason) { return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }; }
      });
      setExecuting(false);
      setStopping(false);
      if (ok || accepted) {
        await loadActive(activeId);
        await refreshList();
      }
      return ok || accepted;
    },
    [activeId, session?.id, busy, isPluginEffective, run, loadActive, refreshList],
  );

  /** Hero composer: create the task and run it in one round trip pair. */
  const handleCreate = useCallback(
    async (text: string, input?: ComposerInput) => {
      const value = text.trim() || tr("附件与上下文");
      if (!isPluginEffective("sessions")) return false;
      let createdId = "";
      setExecuting(true);
      const ok = await run(async () => {
        try {
          const selected = getRunChoices();
          const prepared = await prepareComposer(text, input && { ...input, remote: selected.remote }, { root: draftRoot ?? composerCatalog.root ?? undefined, provider_id: selected.provider_id, model: selected.model, reasoning_effort: selected.reasoning_effort });
          const res = await createSession(value, { ...selected, goal: prepared.goal }, { ...(isolatedWorkspace ? {} : { root: prepared.root }), prepared_token: prepared.token }, id => {
            loadedSessionChoices.current = id;
            setActiveId(id);
          });
          if (res.ok) createdId = res.value;
          else if (res.accepted && res.id) createdId = res.id;
          return res;
        } catch (reason) { return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }; }
      });
      setExecuting(false);
      setStopping(false);
      if (createdId) {
        setActiveId(createdId);
        await refreshList();
        await loadActive(createdId);
        return true;
      }
      return false;
    },
    [isPluginEffective, run, refreshList, loadActive, draftRoot, composerCatalog.root, isolatedWorkspace],
  );

  const handleStop = useCallback(async () => {
    if (!activeId || stopping) return;
    setStopping(true);
    try {
      const result = await post<{ stopping: boolean }>(`/api/sessions/${encodeURIComponent(activeId)}/stop`, {});
      if (!result.stopping) { setStopping(false); await loadActive(activeId, false); }
    }
    catch (reason) { setRunError(reason instanceof Error ? reason.message : String(reason)); setStopping(false); }
  }, [activeId, stopping, loadActive]);

  const handleRetryRun = useCallback(async () => {
    if (!activeId || session?.id !== activeId || busy) return;
    setExecuting(true);
    try { await run(() => runSession(activeId, getRunChoices())); }
    finally { setExecuting(false); setStopping(false); }
    await loadActive(activeId);
    await refreshList();
  }, [activeId, session?.id, busy, run, loadActive, refreshList]);

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
  const [archived, setArchived] = useState<ArchivedSummary[]>([]);
  const [archivedError, setArchivedError] = useState("");

  const loadArchived = useCallback(async () => {
    const res = await listArchivedSessions();
    if (res.ok) {
      setArchived(res.value);
      setArchivedError("");
    } else {
      setArchivedError(res.error);
    }
  }, []);

  useEffect(() => {
    if (archivedOpen) void loadArchived();
  }, [archivedOpen, loadArchived]);

  const restoreById = useCallback(
    async (id: string) => {
      if (await run(() => restoreSession(id))) {
        await refreshList();
        await loadArchived();
      }
    },
    [run, refreshList, loadArchived],
  );

  const deleteById = useCallback(
    async (id: string) => {
      if (busy || !window.confirm(tr("从列表移除该任务？会话记录会归档，工作区文件不会删除。"))) return;
      if (await run(() => deleteSession(id))) {
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

  const composerDisabled = busy || !activeId || session?.id !== activeId || !isPluginEffective("sessions");

  const handleRefreshAll = useCallback(async () => {
    if (!isPluginEffective("sessions")) return;
    await refreshList();
    if (activeId) await loadActive(activeId);
  }, [isPluginEffective, refreshList, activeId, loadActive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
      const bindings = (settingsValues.bindings && typeof settingsValues.bindings === "object" ? settingsValues.bindings : {}) as Record<string, string>;
      const command = SHORTCUT_COMMANDS.find(item => { const binding = resolveShortcutBinding(item.id, bindings); return binding && matchesShortcut(event, binding); });
      if (!command) return;
      if ((command.id === "new-session" || command.id === "command-palette") && !isPluginEffective("sessions")) return;
      if (command.id === "open-settings" && !isPluginEffective("settings")) return;
      if (command.id === "toggle-sidebar" && panel === "settings") return;
      event.preventDefault();
      if (command.id === "new-session") startNewTask();
      else if (command.id === "command-palette") openCommandPalette();
      else if (command.id === "open-settings") setPanel("settings");
      else if (command.id === "toggle-sidebar") setSidebarToggleToken(value => value + 1);
      else if (command.id === "refresh-session" && !busy) void handleRefreshAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNewTask, isPluginEffective, settingsValues.bindings, handleRefreshAll, panel, busy, openCommandPalette]);

  // -- files panel ---------------------------------------------------------
  const handleLoadFiles = useCallback(async () => {
    if (!activeId || !isPluginEffective("files")) return;
    const res = await loadFiles(activeId);
    if (res.ok) {
      setFiles(res.value.files);
      setFilesTruncated(res.value.truncated);
    } else {
      setPreviewError(res.error);
    }
  }, [activeId, isPluginEffective]);

  const handleSelectFile = useCallback(
    async (path: string) => {
      if (!activeId || !isPluginEffective("files")) return;
      setSelectedPath(path);
      setPreview(null);
      setPreviewError("");
      const res = await loadFilePreview(activeId, path);
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
    if (!activeId || !isPluginEffective("files")) return;
    setChangesError("");
    const res = await loadJournal(activeId);
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
      if (result.ok) {
        for (const [key, value] of Object.entries(patch)) {
          if (JSON.stringify(pendingSettings.current[key]) === JSON.stringify(value)) delete pendingSettings.current[key];
        }
        if (Object.keys(pendingSettings.current).length === 0) setSettingsError("");
      } else setSettingsError(result.error);
    }).finally(() => {
      settingsWriteCount.current -= 1;
      setSettingsSaving(settingsWriteCount.current > 0);
      setSettingsDirty(Object.keys(pendingSettings.current).length > 0);
    });
    settingsWriteQueue.current = operation.catch(reason => { setSettingsError(String(reason)); });
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
    if (!activeId) return;
    setGitLoading(true);
    setGitStatusError("");
    setGitDiffError("");
    setGitLogError("");
    const [status, diff, log, checkpoints] = await Promise.all([
      loadGitStatus(activeId),
      loadGitDiff(activeId),
      loadGitLog(activeId),
      loadGitCheckpoints(activeId),
    ]);
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
      if (!result.ok) setGitCheckpointError(result.error);
      else setGitCheckpointError("");
      await loadGitPanel();
    } finally { setGitActionBusy(false); }
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
      if (res.ok) setDirListing(res.value);
      else setDirError(res.error);
    } finally {
      setDirLoading(false);
    }
  }, [isPluginEffective]);

  useEffect(() => {
    if (panel !== "directory" || !isPluginEffective("files") || dirListing) return;
    setDirLoading(true);
    void (async () => {
      const home = await loadHome();
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
    ?? effectiveRuntimeProfile(selectedComposerModel, choices.runtime_profile);
  const runtimeMonitorSession: LocalRuntimeSession | null = activeMonitorSource ? {
    runtime_profile: activeRuntimeProfile,
    runtime_budget: activeMonitorSource.runtime_budget,
    runtime_activity: activeMonitorSource.runtime_activity,
    runtime_activity_history: activeMonitorSource.runtime_activity_history,
  } : null;
  const composerRunning = session?.id === activeId && (session?.status === "running" || session?.streaming?.status === "streaming");
  const composerMentions = [
    ...composerCatalog.files.map(item => ({ ...item, kind: "file" as const })),
    ...composerCatalog.sessions.map(item => ({ ...item, kind: "session" as const })),
    ...composerCatalog.skills.map(item => ({ ...item, kind: "skill" as const })),
    ...composerCatalog.plugins.map(item => ({ ...item, kind: "plugin" as const })),
  ];
  const composerControls = <XuenessComposerToolbar
    choices={choices} onChange={updateChoices} models={composerCatalog.models}
    loading={composerCatalogLoading} error={composerCatalogError}
    onReload={() => void refreshComposerCatalog()}
    onManageModels={() => setPanel(isPluginEffective("providers") ? "providers" : "plugins")}
    onBackground={isPluginEffective("workflows") ? () => setPanel("workflows") : undefined}
    backgroundCount={composerCatalog.backgroundCount ?? 0}
    onBrowser={isPluginEffective("browser") && isPluginEffective("settings") ? () => { setSettingsSection("browser"); setPanel("settings"); } : undefined}
    browserEnabled={choices.browser === true}
    onToggleBrowser={isPluginEffective("browser") ? enabled => updateChoices({ browser: enabled }) : undefined}
    disabled={busy || branchBusy || composerRunning}
    onOpenUsage={isPluginEffective("usage") ? () => setPanel("usage") : undefined}
    runtimeBudget={session?.id === activeId ? session.runtime_budget : undefined}
    pauseReason={session?.id === activeId ? session.pause_reason : undefined}
  />;
  const composerStartActions = {
    canGoal: !activeId, canWorkflow: isPluginEffective("workflows"),
    onWorkflow: () => setPanel("workflows"), onPlugins: () => setPanel("plugins"),
  };
  const chooseWorkspace = (root: string, isolated = false, forceNew = false) => {
    if (busy || branchBusy) return;
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
  useEffect(() => {
    if (!settingsSections.some(section => section.id === settingsSection)) setSettingsSection(settingsSections[0]?.id ?? "general");
  }, [settingsSectionIds, settingsSection]);
  const inlineSettings = ["general", "appearance", "shortcuts", "agent"].includes(settingsSection);
  const settingsContent = () => {
    if (settingsSection === "desktop" && isPluginEffective("desktop")) return <DesktopSettings />;
    if (settingsSection === "network") return <NetworkSettings enabled={isPluginEffective('network')} disabled={busy || settingsSaving || pluginCatalogLoading} />;
    if (settingsSection === 'updates') return <DesktopUpdates enabled={isPluginEffective('updates') && isPluginEffective('desktop')} />;
    if (settingsSection === "browser") return <BrowserSettings enabled={isPluginEffective("browser")} disabled={busy || settingsSaving || pluginCatalogLoading}
      onEnabledChange={async enabled => {
        await togglePlugin("browser", enabled);
        if (!activeIdRef.current) updateChoices({ browser: enabled });
        await handleUpdateSetting("browserControlEnabled", enabled);
      }} />;
    const pluginId = ({providers:"providers",browser:"browser",memory:"memory",subagents:"subagents",mcp:"mcp",skills:"skills",commands:"commands",hooks:"hooks",usage:"usage"} as Record<string,string>)[settingsSection];
    if (pluginId && !isPluginEffective(pluginId)) return <FeatureUnavailable feature={settingsSections.find(section => section.id === settingsSection)?.label ?? settingsSection} onManage={() => setSettingsSection("modules")} />;
    if (inlineSettings) return <SettingsSections embedded sections={[]} activeSection={settingsSection}
      values={{...settingsValues, language: settingsValues.language ?? locale}} capabilities={capabilities}
      onToggleCapability={handleToggleCapability} onUpdateSetting={handleUpdateSetting} saving={settingsSaving} />;
    if (settingsSection === "workspace") return <><XuenessWorkspaceSettings currentRoot={session?.root ?? draftRoot ?? composerCatalog.root}
      onDefaultChanged={() => { if (!activeId) { setDraftRoot(undefined); setIsolatedWorkspace(false); updateChoices({remote:undefined}); } void refreshComposerCatalog(); }} /><SettingsSections embedded sections={[]} activeSection="workspace-display" values={settingsValues} capabilities={capabilities} onUpdateSetting={handleUpdateSetting} saving={settingsSaving} /></>;
    if (settingsSection === "providers") return <ModelManager runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { updateChoices({ provider: "real", provider_id: id || undefined, model: undefined, reasoning_effort: undefined }); void refreshComposerCatalog(); }} />;
    if (settingsSection === "mcp") return <><CapabilitiesPanel sections={capSections.filter(section => section.kind === "mcp")} /><XuenessMcpTools /></>;
    if (settingsSection === "plugins") return <XuenessPluginSettingsPanel
      plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError}
      onRefresh={refreshPluginCatalog} onToggle={togglePlugin}
      onBrowse={isPluginEffective("extensions") ? () => setSettingsSection("marketplace") : undefined}
      resourceContent={isPluginEffective("extensions") ? <CapabilitiesPanel sections={capSections.filter(section => section.kind === "plugins")}
        onImportPlugin={async ({id,fields}) => { const result = await createCapabilityItem("plugins", {id,...fields,createOnly:true}); if(result.ok) await loadCapSlot("plugins"); return result; }}
        onRefreshPlugins={() => void loadCapSlot("plugins")} onBrowsePlugins={() => setSettingsSection("marketplace")} /> : undefined} />;
    if (settingsSection === "subagents") return <XuenessSubagentSettings />;
    if (pluginAvailability.capabilityKinds.includes(settingsSection as CapabilityKind)) return <CapabilitiesPanel sections={capSections.filter(section => section.kind === settingsSection)} />;
    if (settingsSection === "modules") return <XuenessPluginManager plugins={pluginCatalog} loading={pluginCatalogLoading} error={pluginCatalogError} onRefresh={refreshPluginCatalog} onToggle={togglePlugin} />;
    if (settingsSection === "marketplace") return <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} />;
    if (settingsSection === "memory") return <XuenessMemorySettings enabled={settingsValues.memoryEnabled !== false} onEnabledChange={value => void handleUpdateSetting("memoryEnabled", value)} />;
    if (settingsSection === "usage") return <XuenessUsageSettings />;
    if (settingsSection === "automations") return <XuenessAutomationsPanel />;
    if (settingsSection === "diagnostics") return <XuenessDiagnosticsPanel />;
    if (settingsSection === "remote") return <RemoteConnections onUse={id => { chooseWorkspace(composerCatalog.isolatedRoot, true); updateChoices({remote:id}); }} />;
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
      {allowedPanels.map((id) => (
        <option key={id} value={id}>
          {PANEL_LABELS()[id]}
        </option>
      ))}
    </Select>
  );

  const secondaryPanels: Record<Exclude<Panel, "chat">, React.ReactNode> = {
    remote: <RemoteConnections onUse={id => { chooseWorkspace(composerCatalog.isolatedRoot, true); updateChoices({ remote: id }); }} />,
    plugins: (
      <XuenessPluginManager
        plugins={pluginCatalog}
        loading={pluginCatalogLoading}
        error={pluginCatalogError}
        onRefresh={refreshPluginCatalog}
        onToggle={togglePlugin}
      />
    ),
    workflows: <WorkflowPanel sessionId={activeId} />,
    terminal: <TerminalPanel sessionId={activeId} fontSize={Number(settingsValues.terminalFontSize ?? 13)} fontFamily={String(settingsValues.terminalFontFamily ?? "system")} />,
    automations: <XuenessAutomationsPanel />,
    marketplace: <XuenessMarketplace onInstalled={() => void refreshPluginCatalog()} />,
    diagnostics: <XuenessDiagnosticsPanel />,
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
      <ModelManager runtimeMonitorEnabled={isPluginEffective("providers") && isPluginEffective("diagnostics")} onSelect={id => { updateChoices({ provider: "real", provider_id: id || undefined, model: undefined, reasoning_effort: undefined }); setPanel("chat"); }} />
    ),
    usage: <XuenessUsageSettings />,
    memory: <><MemoryPanel tracks={tracks} error={tracksError} loading={tracksLoading} /><XuenessMemoryEditor /></>,
    capabilities: <><CapabilitiesPanel sections={capSections} />{isPluginEffective("mcp") && <XuenessMcpTools />}</>,
    settings: <XuenessSettingsView sections={settingsSections} activeSection={settingsSection} onSelect={setSettingsSection}
      dirty={settingsDirty} saving={settingsSaving} loading={settingsLoading} error={settingsError}
      onBack={() => setPanel("chat")} onRetry={() => settingsDirty ? handleSaveSettings() : handleLoadAllSettings()}>
      {settingsContent()}
    </XuenessSettingsView>,
  };

  const runPaletteCommand = useCallback((id: string) => {
    setCommandOpen(false);
    if (id === "new-task") startNewTask();
    else if (id === "open-settings" && isPluginEffective("settings")) setPanel("settings");
    else if (id === "refresh") void handleRefreshAll();
  }, [startNewTask, handleRefreshAll, isPluginEffective]);

  return (
    <CodeDisplayProvider settings={settingsValues.codePreviewSettings} dark={String(settingsValues.theme) === "dark" || (settingsValues.theme === "system" && systemDark)}>
    <DesktopTrayBridge enabled={isPluginEffective('desktop')} sessionsEnabled={isPluginEffective('sessions')} busy={busy}
      activeId={activeId} locale={locale} dark={String(settingsValues.theme) === 'dark' || (settingsValues.theme === 'system' && systemDark)}
      onNew={startNewTask} onSession={selectTraySession} />
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
      canGoBack={!busy && historyPosition.cursor > 0}
      canGoForward={!busy && historyPosition.cursor < historyPosition.length - 1}
      onGoBack={() => navigateHistory(-1)} onGoForward={() => navigateHistory(1)}
      sidebar={panel === "settings" ? null : (
        <>
          <SidebarActions
            actions={[
              ...(isPluginEffective("sessions") ? [
                { id: "new-task", icon: <MessageCirclePlus size={16} />, label: tr("新建任务"), shortcut: "Mod+N", onClick: startNewTask },
                { id: "search", icon: <IconSearch size={15} />, label: tr("搜索"), shortcut: "Mod+K", onClick: (event: React.MouseEvent<HTMLButtonElement>) => openCommandPalette(event.currentTarget) },
              ] : []),
              ...(isPluginEffective("automation") ? [{ id: "automations", icon: <CalendarClock size={16} />, label: tr("自动化"), onClick: () => setPanel("automations") }] : []),
              ...(isPluginEffective("extensions") ? [{ id: "marketplace", icon: <Blocks size={16} />, label: tr("插件市场"), onClick: () => setPanel("marketplace") }] : []),
            ]}
          />
          {isPluginEffective("sessions") && <>
          <XuenessTaskList sessions={sessions} activeId={activeId} busy={busy}
            projectRoots={composerCatalog.roots.filter(root => root.path !== composerCatalog.isolatedRoot)}
            onAddProject={isPluginEffective("files") && isPluginEffective("settings") ? trigger => {
              if (busy) return;
              workspacePickerOpener.current = trigger;
              setWorkspacePickerMode("project");
              setWorkspacePicking(true);
            } : undefined}
            onStartProject={root => { if (busy) return; chooseWorkspace(root, false, true); }}
            preferences={settingsValues.sidebarPreferences as SidebarPreferences | undefined}
            onPreferences={value => { void handleUpdateSetting("sidebarPreferences", value); }}
            onSelect={selectSession}
            onRename={requestRename} onArchive={id => { void deleteById(id); }}
            onPin={(id, pinned) => { void togglePin(id, pinned); }}
            onOpenArchived={() => setArchivedOpen(previous => !previous)} />
          <div className="xn-sidebar-archived" data-testid="xn-sidebar-archived" hidden={!archivedOpen}>
            <button
              type="button"
              className="xn-sidebar-archived__toggle"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((prev) => !prev)}
            >{tr("已归档")}{archivedOpen && archived.length > 0 ? ` (${archived.length})` : ""}
            </button>
            {archivedOpen && (
              <div className="xn-sidebar-archived__body">
                {archivedError && <p role="alert" className="xn-sidebar-archived__error">{archivedError}</p>}
                {!archivedError && archived.length === 0 && (
                  <p className="xn-sidebar-archived__empty">{tr("没有归档任务")}</p>
                )}
                {archived.map((entry) => (
                  <div key={entry.id} className="xn-sidebar-archived__item">
                    <span className="xn-sidebar-archived__title" title={entry.title || entry.task}>
                      {entry.title || entry.task || tr("未命名任务")}
                    </span>
                    <button
                      type="button"
                      className="xn-sidebar-archived__restore"
                      aria-label={tf("恢复任务 {0}", [entry.title || entry.task])}
                      data-testid={`xn-archived-restore-${entry.id}`}
                      onClick={() => void restoreById(entry.id)}
                    >{tr("↩ 恢复")}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          </>}
        </>
      )}
      sidebarFooter={
        <>
          <DesktopUpdates compact enabled={isPluginEffective('updates') && isPluginEffective('desktop')} onManage={() => { setSettingsSection('updates'); setPanel('settings'); }} />
          <details className="xn-sidebar-account">
            <summary><span className="xn-sidebar-account__avatar"><UserRound size={16} /></span><span>Xueness</span><ChevronDown size={12} /></summary>
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
      {commandOpen && (
        <div ref={commandDialogRef} role="dialog" aria-modal="true" aria-label={tr("命令面板")} tabIndex={-1} className="xn-command-overlay" onClick={() => setCommandOpen(false)}>
          <div className="xn-command-panel" onClick={(event) => event.stopPropagation()}>
            <input
              ref={commandRef}
              aria-label={tr("搜索任务或命令")}
              placeholder={tr("搜索任务或命令…")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {(() => {
              const needle = search.trim();
              const visiblePaletteCommands = PALETTE_COMMANDS().filter((command) =>
                (command.id !== "new-task" && command.id !== "refresh" || isPluginEffective("sessions")) &&
                (command.id !== "open-settings" || isPluginEffective("settings")),
              );
              const commandHits = fuzzyFilter(visiblePaletteCommands, (c) => c.label, needle).map((h) => h.item);
              const sessionHits = fuzzyFilter(
                sessions,
                (s) => `${s.title || ""} ${s.task || ""}`,
                needle,
              ).map((h) => h.item);
              const empty = commandHits.length === 0 && sessionHits.length === 0;
              return (
                <>
                  {commandHits.length > 0 && (
                    <div className="xn-command-group" data-testid="palette-group-commands">
                      <div className="xn-command-group__title">{tr("命令")}</div>
                      {commandHits.map((command) => (
                        <button type="button" key={command.id} data-testid={`palette-command-${command.id}`} onClick={() => runPaletteCommand(command.id)}>
                          <span>{command.label}</span>
                          <span className="xn-command-group__desc">{command.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {sessionHits.length > 0 && (
                    <div className="xn-command-group" data-testid="palette-group-tasks">
                      <div className="xn-command-group__title">{tr("任务")}</div>
                      {sessionHits.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          disabled={busy}
                          onClick={() => { setActiveId(item.id); setPanel("chat"); setCommandOpen(false); }}
                        >
                          <span>{item.title || item.task || tr("未命名任务")}</span>
                          <span className="xn-command-group__desc">{item.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {empty && <div className="xn-command-empty">{tr("无匹配结果")}</div>}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {(error || dataErrors.active || dataErrors.list) && (
        <div role="alert" className="xn-error-banner">
          <span>{error || dataErrors.active || dataErrors.list}</span>
          <button type="button" disabled={busy} onClick={() => { setError(""); void handleRefreshAll(); }}>{tr("重新加载")}</button>
        </div>
      )}

      {panel === "settings" ? secondaryPanels.settings : panel !== "chat" ? (
        <div className="xn-secondary-view">
          <div className="xn-secondary-view__bar">
            <button type="button" className="xn-secondary-view__back" onClick={() => setPanel("chat")}>
              <IconBack size={14} />{tr("返回会话")}</button>
            <span className="xn-secondary-view__title">{PANEL_LABELS()[panel]}</span>
            <div className="xn-secondary-view__switcher">{viewSwitcher}</div>
          </div>
          <div className="xn-secondary-view__body">
            {canShowPanel(panel)
              ? secondaryPanels[panel]
              : <FeatureUnavailable feature={PANEL_LABELS()[panel]} onManage={() => setPanel("plugins")} />}
          </div>
        </div>
      ) : !isPluginEffective("sessions") ? (
        <FeatureUnavailable feature={tr("会话")} onManage={() => setPanel("plugins")} />
      ) : activeId && session?.id !== activeId ? (
        <div role="status" className="xn-hero"><p>{tr("正在加载任务…")}</p></div>
      ) : session ? (
        <div className="xn-conversation">
          <WorkbenchHeader
            session={session}
            actions={<>{viewSwitcher}<button type="button" className="xn-conv-header__action xn-conv-header__fork" aria-label={tr("分叉会话")} title={tr("分叉会话")} disabled={busy || session.status === "running" || session.streaming?.status === "streaming"} onClick={beginFork}><GitBranch size={14} aria-hidden="true" /><span>{tr("分叉会话")}</span></button></>}
            pinned={session.pinned === true}
            onTogglePin={() => activeId && void togglePin(activeId, session.pinned !== true)}
            onRefresh={() => void handleRefreshAll()}
            onRename={() => activeId && requestRename(activeId)}
            onDelete={() => activeId && void deleteById(activeId)}
          />
          {session.forkParent && <p className="xn-session-fork-provenance" data-testid="fork-session-provenance" role="note">
            {tf("从会话 {0} 的第 {1} 轮分叉", [session.forkParent.sourceId, session.forkParent.turn])}
            {session.forkParent.historyTruncated && <span>{tr(" · 较早的压缩归档未继承，仅保留当前可定位历史")}</span>}
            <button type="button" className="xn-session-fork-provenance__open" data-testid="fork-open-parent" disabled={busy} onClick={() => selectSession(session.forkParent!.sourceId)}>{tr("打开原会话")}</button>
          </p>}
          {session.pause_reason && ["paused", "needs_review"].includes(session.status) && <p role="status" className="xn-run-error">{tf("暂停原因：{0}", [session.pause_reason])}</p>}
          {isPluginEffective('planning') && <CompletionChecks sessionId={session.id} completion={session.completion} items={session.delivery_requirements ?? []} disabled={busy || session.status === 'running'} onSaved={() => void handleRefreshAll()} />}
          {isPluginEffective('providers') && <RequestTiming session={session} />}
          {activeRuntimeProfile === "lightweight" && isPluginEffective("providers") && isPluginEffective("diagnostics") &&
            <LocalRuntimeMonitor lightweight session={runtimeMonitorSession} />}
          {session.pending && session.pending.length > 0 && (
            <div className="xn-conversation__approvals">
              <Approvals pending={session.pending} onApprove={handleApprove} />
            </div>
          )}
          <div ref={timelineScrollRef} className="xn-conversation__stream" onScroll={event => {
            const scroller = event.currentTarget;
            timelineFollowTailRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
          }}>
            {settingsValues.showTodos !== false && <TaskTodos todos={session.todos ?? []} />}
            <TimelineStream rows={withAssistantStream(rows, session.streaming)} collapseTools={settingsValues.collapseTools !== false} messageStreamShowReasoning={settingsValues.messageStreamShowReasoning !== false} grouping={{ explore: settingsValues.toolGroupingExploreEnabled !== false, terminal: settingsValues.toolGroupingTerminalEnabled !== false, changes: settingsValues.toolGroupingChangesEnabled === true }} />
            {session.streaming?.status === "interrupted" && session.streaming.text && <p role="status" className="xn-run-error">{tr("输出已中断，已保留收到的内容。")}</p>}
          </div>
          {(runError || session.status === "provider_error" || (!busy && session.status === "pending")) && (
            <div className="xn-run-error">
              {runError && <p role="alert">{runError}</p>}
              <button type="button" disabled={busy} onClick={() => void handleRetryRun()}>{tr("重试运行")}</button>
            </div>
          )}
          <Composer
              sendShortcut={settingsValues.sendShortcut === "mod-enter" ? "mod-enter" : "enter"}
            onSend={handleSend}
            disabled={composerDisabled}
            sendDisabled={!composerModelReady || composerCatalogLoading}
            running={composerRunning}
            stopping={stopping}
            onStop={handleStop}
            placeholder={tr("继续描述任务（/ 命令，@ 上下文，$ 技能）")}
            controls={composerControls}
            startActions={composerStartActions}
            mentions={composerMentions}
            commands={isPluginEffective("commands") ? commandItems : []}
            files={files.map((f) => f.path)}
          />
        </div>
      ) : (
        <div className="xn-hero" data-testid="xn-hero">
          <div className="xn-hero__bar"><details className="xn-workbench-menu"><summary aria-label={tr("工作台")}><CircleHelp size={16} /></summary><div>{viewSwitcher}</div></details></div>
          <div className="xn-hero__brand" aria-hidden="true">
            <IconXuenessMark size={34} className="xn-hero__brand-mark" />
          </div>
          <h1 className="xn-hero__greeting">{heroGreeting(new Date())}</h1>
          <p className="xn-hero__hint">{tr("描述你想完成的事，Xueness 会在你的工作区里执行。")}</p>

          <div className="xn-hero__composer">
            {runError && (
              <p role="alert" className="xn-run-error">{runError}</p>
            )}
            <Composer
              sendShortcut={settingsValues.sendShortcut === "mod-enter" ? "mod-enter" : "enter"}
              variant="hero"
              topContent={workspaceContext}
              inputRef={heroInputRef}
              onSend={handleCreate}
              disabled={busy || !isPluginEffective("sessions")}
              sendDisabled={!composerModelReady || composerCatalogLoading}
              running={composerRunning}
              stopping={stopping}
              onStop={activeId ? handleStop : undefined}
              placeholder={tr("向 Xueness 提问，使用 @ 添加上下文，使用 / 选择命令或能力")}
              controls={composerControls}
              startActions={composerStartActions}
              mentions={composerMentions}
              commands={isPluginEffective("commands") ? commandItems : []}
            />
            {!composerCatalogLoading && !composerModelReady && (composerCatalogError || composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal) && <div className="xn-composer-model-setup" role="status">
              <span>{tr(composerCatalogError ? "模型列表加载失败，请重试。" : composerCatalog.models.some(model => model.configured) && !composerCatalog.allowReal ? "服务端已关闭模型请求。" : "配置一个模型即可开始对话。")}</span>
              <button type="button" onClick={() => composerCatalogError ? void refreshComposerCatalog() : setPanel(isPluginEffective("providers") ? "providers" : "plugins")}>{tr(composerCatalogError ? "重试" : "配置模型")}</button>
            </div>}
          </div>
        </div>
      )}

      <XuenessWorkspacePickerDialog open={workspacePicking} currentRoot={draftRoot ?? composerCatalog.root} returnFocusTo={workspacePickerOpener.current}
        mode={workspacePickerMode}
        onChoose={chooseWorkspace} onCancel={() => setWorkspacePicking(false)} />

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
      <ForkSessionDialog
        open={forkSource !== null}
        sourceId={forkSource?.id ?? ""}
        sourceTitle={forkSource?.title ?? ""}
        onCancel={() => setForkSource(null)}
        onFork={completeFork}
      />
    </Shell>
    </CodeDisplayProvider>
  );
}
