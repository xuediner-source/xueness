/**
 * Workbench sidebar: the action lists (sidebar, Claudex rail and its menus)
 * and the session list with its archive. Each entry appears only while the
 * plugin behind it is effective. Moved unchanged out of
 * XuenessWorkbenchContainer.
 */
import React, { lazy, Suspense } from "react";
import { Blocks, Bot, Brain, CalendarClock, CircleHelp, Folder, GitBranch, House, Library, MessagesSquare, SquarePen } from "lucide-react";
import { t as tr } from "../../i18n";
import type { ComposerCatalog } from "../../xuenessComposer";
import type { SessionSummary } from "../../xuenessWorkbench";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";
import { resolveShortcutBinding } from "../../xuenessShortcutCommands";
import { SidebarActions, type SidebarAction } from "../../XuenessShell";
import { IconGear, IconNewTask, IconSearch } from "../../ui/icons";
import { hasProjectExplorer, openProjectExplorer } from '../desktop/projectExplorer';
import type { WorkbenchSettings } from "../settings/useWorkbenchSettings";
import { XuenessTaskList, type SidebarPreferences } from "./XuenessTaskList";
import type { SessionListActions } from "./useSessionListActions";
import type { WorkspaceSelection } from "./useWorkspaceSelection";

const ArchivedSessions = lazy(() => import('./ArchivedSessions').then(module => ({ default: module.ArchivedSessions })));

type SidebarActionInput = {
  isPluginEffective: (id: string) => boolean;
  claudexAppearance: boolean;
  shortcutBindings: Record<string, string>;
  allowedPanels: WorkbenchPanel[];
  canShowPanel: (panel: WorkbenchPanel) => boolean;
  panelLabels: Record<WorkbenchPanel, string>;
  setPanel: (panel: WorkbenchPanel) => void;
  startNewTask: () => void;
  openCommandPalette: (returnFocusTo?: HTMLElement | null) => void;
};

export function buildSidebarActions({ isPluginEffective, claudexAppearance, shortcutBindings, allowedPanels, canShowPanel, panelLabels, setPanel, startNewTask, openCommandPalette }: SidebarActionInput) {
  const sidebarActions: SidebarAction[] = [
    ...(isPluginEffective("sessions") ? [
      { id: "new-task", icon: claudexAppearance ? <SquarePen size={16} /> : <IconNewTask size={16} />, label: tr(claudexAppearance ? "新聊天" : "新建任务"), shortcut: resolveShortcutBinding("new-session", shortcutBindings), onClick: startNewTask },
      { id: "search", icon: <IconSearch size={15} />, label: tr("搜索"), shortcut: resolveShortcutBinding("command-palette", shortcutBindings), onClick: (event: React.MouseEvent<HTMLButtonElement>) => openCommandPalette(event.currentTarget) },
    ] : []),
    ...(isPluginEffective("context_lens") ? [{ id: "context-lens", icon: <IconSearch size={16} />, label: tr("上下文透镜"), onClick: () => setPanel("context-lens") }] : []),
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
    label: panelLabels[id], onClick: () => setPanel(id),
  }));
  const sidebarMenuActions: SidebarAction[] = [...sidebarActions.filter(action => action.id !== 'search'),
    ...(isPluginEffective('settings') ? [{ id: 'settings', icon: <IconGear size={16} />, label: tr('设置'), onClick: () => setPanel('settings') }] : []),
    { id: 'plugins', icon: <Blocks size={16} />, label: tr('插件管理'), onClick: () => setPanel('plugins') },
  ];
  return { sidebarActions, railActions, railSecondaryActions, railMoreActions, sidebarMenuActions };
}

type WorkbenchSidebarProps = {
  sidebarActions: SidebarAction[];
  claudexAppearance: boolean;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  liveSessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
  composerCatalog: ComposerCatalog;
  workspace: WorkspaceSelection;
  settings: WorkbenchSettings;
  listActions: SessionListActions;
  selectSession: (id: string) => void;
  setError: (message: string) => void;
  refreshList: () => Promise<void>;
};

/** Sidebar body outside settings: actions, the session list and the archive. */
export function WorkbenchSidebar({ sidebarActions, claudexAppearance, isPluginEffective, pluginEffectiveRef, liveSessions, activeId, busy, composerCatalog,
  workspace, settings, listActions, selectSession, setError, refreshList }: WorkbenchSidebarProps) {
  const { workspacePickerOpener, setWorkspacePickerMode, setWorkspacePicking, chooseWorkspace } = workspace;
  const { settingsValues, setSettingsValues, handleUpdateSetting } = settings;
  const { archiveProject, requestRename, deleteById, togglePin, archivedOpen, setArchivedOpen, archivedRevision } = listActions;
  return (
        <>
          <SidebarActions
            actions={claudexAppearance ? sidebarActions.filter(action => action.id === 'new-task') : sidebarActions}
          />
          {isPluginEffective("sessions") && <>
          <XuenessTaskList sessions={liveSessions} activeId={activeId} busy={busy} compact={claudexAppearance}
            changesEnabled={isPluginEffective('files')}
            remoteEnabled={isPluginEffective('remote')}
            projectRoots={composerCatalog.roots.filter(root => root.path !== composerCatalog.isolatedRoot)}
            onAddProject={isPluginEffective("files") && isPluginEffective("settings") ? trigger => {
              if (busy) return;
              workspacePickerOpener.current = trigger;
              setWorkspacePickerMode("project");
              setWorkspacePicking(true);
            } : undefined}
            onStartProject={root => { chooseWorkspace(root, false, true); }}
            onOpenProjectExplorer={isPluginEffective('desktop') && isPluginEffective('files') && isPluginEffective('settings') && hasProjectExplorer()
              ? root => { void openProjectExplorer(root).catch(error => setError(error.message)); } : undefined}
            onArchiveProjectSessions={(root, ids) => { void archiveProject(root, ids); }}
            preferences={settingsValues.sidebarPreferences as SidebarPreferences | undefined}
            onPreferences={value => {
              if (!pluginEffectiveRef.current('sessions')) return;
              if (pluginEffectiveRef.current('settings')) void handleUpdateSetting('sidebarPreferences', value);
              else setSettingsValues(previous => ({ ...previous, sidebarPreferences: value }));
            }}
            onSelect={selectSession}
            onRename={requestRename} onArchive={id => { void deleteById(id); }}
            onPin={(id, pinned) => { void togglePin(id, pinned); }}
            onOpenArchived={() => setArchivedOpen(previous => !previous)} />
          {archivedOpen && <Suspense fallback={null}><ArchivedSessions open disabled={busy} reloadKey={archivedRevision}
            onClose={() => setArchivedOpen(false)} onRestored={refreshList} /></Suspense>}
          </>}
        </>
  );
}
