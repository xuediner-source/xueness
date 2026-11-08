/**
 * Where the next task runs: the folder picker, clone and SSH entry points on
 * the start page, recent projects, and `chooseWorkspace`, which rebinds the
 * new-task composer (and its saved draft) to the chosen root. Moved unchanged
 * out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, GitBranch, Server } from "lucide-react";
import { t as tr } from "../../i18n";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { loadWorkspaceCatalog, type RecentWorkspaceDirectory } from "../../xuenessWorkspaces";
import type { RemoteSessionAdapter } from "../remote/remoteSessionAdapter";
import type { WorkbenchSettings } from "../settings/useWorkbenchSettings";
import { clearWorkspaceComposerCatalog } from './composerCatalogLifecycle';
import { relocateEmptyComposerDraft } from './composerRecovery';
import type { ComposerDraftState } from "./composerTypes";
import type { StartPageAction } from "./XuenessStartPage";
import type { StartPageWorkspace } from "./StartPageWorkspaceMenu";
import { normalizeHiddenProjectRoots, sameSidebarProjectPath, type SidebarPreferences } from "./XuenessTaskList";
import type { ComposerCatalogState } from "./useComposerCatalog";

type WorkspaceSelectionInput = {
  panel: WorkbenchPanel;
  setPanel: (panel: WorkbenchPanel) => void;
  lightweightLayout: boolean;
  activeId: string | null;
  session: WorkbenchSession | null;
  busy: boolean;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  settings: WorkbenchSettings;
  composer: ComposerCatalogState;
  composerDraftStore: React.MutableRefObject<Map<string, ComposerDraftState>>;
  startNewTask: () => void;
  setHeroFocusTick: (update: (tick: number) => number) => void;
};

export function useWorkspaceSelection({ panel, setPanel, lightweightLayout, activeId, session, busy, isPluginEffective, pluginEffectiveRef, settings, composer, composerDraftStore, startNewTask, setHeroFocusTick }: WorkspaceSelectionInput) {
  const { settingsValues, setSettingsValues, handleUpdateSetting } = settings;
  const { draftRoot, setDraftRoot, composerCatalog, setComposerCatalog, setComposerCatalogLoading, isolatedWorkspace, setIsolatedWorkspace,
    preserveDefaultDraftScope, setPreserveDefaultDraftScope, choices, updateChoices, composerRequests, commandRoot } = composer;
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [remoteAdapter, setRemoteAdapter] = useState<RemoteSessionAdapter | null>(null);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [workspacePickerMode, setWorkspacePickerMode] = useState<"workspace" | "project">("workspace");
  const workspacePickerOpener = useRef<HTMLElement | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const cloneOpener = useRef<HTMLElement | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentWorkspaceDirectory[] | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);

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
      onSelect: () => setRemoteDialogOpen(true),
    }] : []),
  ];
  const chooseWorkspace = (root: string, isolated = false, forceNew = false) => {
    if (branchBusy) return;
    const sidebarPreferences = settingsValues.sidebarPreferences as SidebarPreferences | undefined;
    const hiddenRoots = normalizeHiddenProjectRoots(sidebarPreferences?.hiddenProjectRoots);
    if (pluginEffectiveRef.current('sessions') && hiddenRoots.some(path => sameSidebarProjectPath(path, root))) {
      const next = { ...sidebarPreferences, hiddenProjectRoots: hiddenRoots.filter(path => !sameSidebarProjectPath(path, root)) };
      if (pluginEffectiveRef.current('settings')) void handleUpdateSetting('sidebarPreferences', next);
      else setSettingsValues(previous => ({ ...previous, sidebarPreferences: next }));
    }
    if (root === (draftRoot ?? composerCatalog.root) && isolated === isolatedWorkspace && !choices.remote && !forceNew && !(workspacePicking && workspacePickerMode === 'project')) {
      setWorkspacePicking(false);
      return;
    }
    composerRequests.cancel();
    setComposerCatalog(clearWorkspaceComposerCatalog);
    if (forceNew || workspacePicking && workspacePickerMode === "project" || activeId && (isolated || root !== session?.root)) startNewTask();
    updateChoices({ remote: undefined });
    setDraftRoot(root);
    setPreserveDefaultDraftScope(false);
    setIsolatedWorkspace(isolated);
    setWorkspacePicking(false);
    if (!activeId) relocateEmptyComposerDraft(composerDraftStore.current,
      `${preserveDefaultDraftScope ? 'default' : commandRoot || 'default'}:new-task`, `${root || 'default'}:new-task`);
    setComposerCatalogLoading(true);
    setPanel("chat");
    setHeroFocusTick(tick => tick + 1);
  };
  const emptyStateWorkspaces = useMemo<StartPageWorkspace[]>(() => {
    const local = new Map<string, StartPageWorkspace>();
    for (const item of [
      ...(composerCatalog.root ? [{ path: composerCatalog.root, label: composerCatalog.roots.find(root => root.path === composerCatalog.root)?.name ?? composerCatalog.root }] : []),
      ...(draftRoot ? [{ path: draftRoot, label: composerCatalog.roots.find(root => root.path === draftRoot)?.name ?? draftRoot }] : []),
      ...composerCatalog.roots.map(item => ({ path: item.path, label: item.name })),
      ...(recentProjects ?? []),
    ]) {
      if (item.path && !local.has(item.path)) local.set(item.path, { path: item.path, label: item.label ?? item.path });
    }
    const remotes = isPluginEffective("remote")
      ? (composerCatalog.remoteConnections ?? []).map(item => ({
          path: `remote:${item.id}`,
          label: item.label,
          kind: "remote" as const,
          remoteId: item.id,
          connected: item.connected,
          connectionState: item.connectionState,
        }))
      : [];
    return [...local.values(), ...remotes];
  }, [composerCatalog.root, composerCatalog.roots, composerCatalog.remoteConnections, draftRoot, isPluginEffective, recentProjects]);

  return {
    remoteDialogOpen, setRemoteDialogOpen, remoteAdapter, setRemoteAdapter,
    workspacePicking, setWorkspacePicking, workspacePickerMode, setWorkspacePickerMode, workspacePickerOpener,
    cloneOpen, setCloneOpen, cloneOpener, recentProjects, refreshRecentProjects, branchBusy, setBranchBusy,
    startPageActions, chooseWorkspace, emptyStateWorkspaces,
  };
}

export type WorkspaceSelection = ReturnType<typeof useWorkspaceSelection>;
