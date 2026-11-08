/**
 * Primary composer chrome: the model / permission toolbar with the usage
 * quick card, and the workspace context (workspace menu, isolated badge, Git
 * branch). Moved unchanged out of XuenessWorkbenchContainer.
 */
import React, { lazy, Suspense, useMemo } from "react";
import { t as tr } from "../../i18n";
import { switchComposerBranch } from "../../xuenessComposer";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import type { SettingsMap } from "../../xuenessSettings";
import { resolveHostPlatform } from "../../xuenessShortcutDisplay";
import { Select } from "../../ui/Select";
import { XuenessUsageQuickCard } from "../usage/XuenessUsageQuickCard";
import type { sessionContextUsage } from './sessionContextUsage';
import { XuenessComposerToolbar } from "./XuenessComposerToolbar";
import { readPersistedDraft, restoredDraft } from "./composerDraftStore";
import type { ComposerDraftState } from "./composerTypes";
import { composerModelRecoveryFor, shouldHydrateEmptyPrimaryDraftScope } from "./workbenchDrafts";
import type { WorkbenchComposerShared } from "./WorkbenchConversation";
import type { useLivePermissionMode } from "./useLivePermissionMode";
import type { ComposerCatalogState } from "./useComposerCatalog";
import type { WorkspaceSelection } from "./useWorkspaceSelection";
import type { useDefaultModelSelection } from "../providers/useDefaultModelSelection";

const StartPageWorkspaceMenu = lazy(() => import('./StartPageWorkspaceMenu'));

type WorkbenchComposerInput = {
  composer: ComposerCatalogState;
  isPluginEffective: (id: string) => boolean;
  activeId: string | null;
  setPanel: (panel: WorkbenchPanel) => void;
  setGoalEditorOpen: (open: boolean) => void;
  composerRunning: boolean;
  composerModelReady: boolean;
  composerDraftStore: React.MutableRefObject<Map<string, ComposerDraftState>>;
  heroInputRef: React.MutableRefObject<HTMLElement | null>;
  settingsValues: SettingsMap;
  shortcutBindings: Record<string, string>;
  files: { path: string }[];
  controls: React.ReactNode;
};

/** Props of the two primary composers, the model-recovery state and the startup draft binding. */
export function useWorkbenchComposerProps({ composer, isPluginEffective, activeId, setPanel, setGoalEditorOpen, composerRunning, composerModelReady, composerDraftStore,
  heroInputRef, settingsValues, shortcutBindings, files, controls }: WorkbenchComposerInput) {
  const { choices, composerCatalog, composerCatalogLoading, composerCatalogError, refreshComposerCatalog, draftRoot, commandRoot, commandItems } = composer;
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
  const composerModelRecovery = composerModelRecoveryFor({
    loading: composerCatalogLoading,
    error: composerCatalogError,
    modelReady: composerModelReady,
    allowReal: composerCatalog.allowReal,
    hasConfiguredModel: composerCatalog.models.some(model => model.configured),
    onRetry: () => { void refreshComposerCatalog(); },
    onConfigure: composerStartActions.onModels,
  });
  const persistedDraftsForPrimaryHydration = useMemo(() => {
    if (activeId !== null || draftRoot !== undefined || choices.remote || !composerCatalog.root) return [];
    const workspaces = new Set(['default', commandRoot || 'default']);
    return [...workspaces]
      .map(workspaceKey => readPersistedDraft(workspaceKey, 'new-task'))
      .filter(draft => draft !== null)
      .map(restoredDraft);
  }, [activeId, draftRoot, choices.remote, composerCatalog.root, commandRoot]);
  const hydrateEmptyPrimaryDraftScope = shouldHydrateEmptyPrimaryDraftScope({
    activeId, draftRoot, remote: Boolean(choices.remote), catalogRoot: composerCatalog.root, commandRoot,
    draftStore: composerDraftStore.current, persistedDrafts: persistedDraftsForPrimaryHydration,
  });
  const composerMentions = [
    ...composerCatalog.files.map(item => ({ ...item, kind: "file" as const })),
    ...composerCatalog.sessions.map(item => ({ ...item, kind: "session" as const })),
    ...composerCatalog.skills.map(item => ({ ...item, kind: "skill" as const })),
    ...composerCatalog.plugins.map(item => ({ ...item, kind: "plugin" as const })),
  ];
  const composerShared: WorkbenchComposerShared = {
    draftStore: composerDraftStore,
    richComposer: isPluginEffective("sessions"),
    attachmentRoot: draftRoot ?? composerCatalog.root ?? undefined,
    inputRef: heroInputRef,
    platform: resolveHostPlatform(),
    sendShortcut: settingsValues.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
    shortcutBindings,
    sendDisabledReason: composerSendDisabledReason,
    running: composerRunning,
    controls,
    startActions: composerStartActions,
    capabilities: (composerCatalog.capabilities ?? []).map(item => ({ ...item, available: item.available !== false && isPluginEffective(item.pluginId) })),
    mentions: composerMentions,
    commands: isPluginEffective("commands") ? commandItems : [],
    files: files.map((f) => f.path),
  };
  return { composerShared, composerStartActions, composerModelRecovery, hydrateEmptyPrimaryDraftScope };
}

type ComposerControlsProps = {
  composer: ComposerCatalogState;
  defaultModel: ReturnType<typeof useDefaultModelSelection>;
  isPluginEffective: (id: string) => boolean;
  setPanel: (panel: WorkbenchPanel) => void;
  activeId: string | null;
  session: WorkbenchSession | null;
  busy: boolean;
  branchBusy: boolean;
  composerRunning: boolean;
  livePermissions: ReturnType<typeof useLivePermissionMode>;
  contextReading: ReturnType<typeof sessionContextUsage>;
};

/** `controls` of both primary composers. */
export function WorkbenchComposerControls({ composer, defaultModel, isPluginEffective, setPanel, activeId, session, busy, branchBusy, composerRunning, livePermissions, contextReading }: ComposerControlsProps) {
  const { choices, updateChoices, composerCatalog, composerCatalogLoading, composerCatalogError, refreshComposerCatalog } = composer;
  const { openModelSettings, saveDefaultModel, defaultSaved } = defaultModel;
  // 用量速览属于 usage 插件：插件生效才挂载入口，会话数据由容器透传。
  const usageQuickCard = <XuenessUsageQuickCard
    enabled={isPluginEffective("usage")}
    sessionProviderUsage={session?.id === activeId ? session.provider_usage : undefined}
    onOpenPanel={isPluginEffective("usage") ? () => setPanel("usage") : undefined}
  />;
  return <>
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
      permissionDisabled={busy || branchBusy || livePermissions.saving}
      onPermissionChange={activeId ? (mode, acknowledged) => livePermissions.change(mode, acknowledged) : undefined}
      disabled={busy || branchBusy || composerRunning}
      onOpenUsage={isPluginEffective("usage") ? () => setPanel("usage") : undefined}
      runtimeBudget={session?.id === activeId ? session.runtime_budget : undefined}
      contextReading={contextReading}
      pauseReason={session?.id === activeId ? session.pause_reason : undefined}
    />
    {livePermissions.error && <p role="alert">{livePermissions.error}</p>}
    {usageQuickCard}
  </>;
}

type WorkspaceContextProps = {
  composer: ComposerCatalogState;
  workspace: WorkspaceSelection;
  isPluginEffective: (id: string) => boolean;
  busy: boolean;
  setRunError: (message: string) => void;
};

/** Workspace menu, isolated-workspace badge and Git branch switcher above the new-task composer. */
export function WorkbenchWorkspaceContext({ composer, workspace, isPluginEffective, busy, setRunError }: WorkspaceContextProps) {
  const { choices, composerCatalog, draftRoot, isolatedWorkspace, refreshComposerCatalog } = composer;
  const { emptyStateWorkspaces, chooseWorkspace, setRemoteDialogOpen, setWorkspacePickerMode, setWorkspacePicking, branchBusy, setBranchBusy } = workspace;
  const startPageWorkspaceMenu = (
    <Suspense fallback={null}><StartPageWorkspaceMenu
      workspaces={emptyStateWorkspaces}
      currentPath={choices.remote ? `remote:${choices.remote}` : (draftRoot ?? composerCatalog.root)}
      allowOpenFolder={isPluginEffective("files") && isPluginEffective("settings")}
      allowRemote={isPluginEffective("remote")}
      onSelectWorkspace={(path, remoteId) => {
        if (remoteId) {
          setRemoteDialogOpen(true);
        } else {
          chooseWorkspace(path);
        }
      }}
      onOpenFolder={() => {
        if (!isPluginEffective("files") || !isPluginEffective("settings") || busy || branchBusy) return;
        setWorkspacePickerMode("workspace");
        setWorkspacePicking(true);
      }}
      onConnectRemote={() => { if (isPluginEffective("remote")) setRemoteDialogOpen(true); }}
      onDetachProject={() => {
        if (composerCatalog.isolatedRoot) chooseWorkspace(composerCatalog.isolatedRoot, true);
      }}
    /></Suspense>
  );
  return <div className="xn-composer-workspace" aria-label={tr("任务工作区")}>
    {startPageWorkspaceMenu}
    {isolatedWorkspace && <span>{tr("独立工作区")}</span>}
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
}
