import React from 'react';
import { Archive, Pencil, Pin } from 'lucide-react';
import { Select } from '../../ui/Select';
import { t as tr } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';
import {
  createSidebarProjectSection,
  moveSidebarProjectToSection,
  setSidebarProjectLabel,
  toggleHiddenProjectRoot,
  type SidebarProjectSection,
} from './projectSidebar';
import type { ProjectContextMenuTarget } from './ProjectContextMenu';
import type { SidebarPreferences, TaskGroup } from './taskListModel';

const LazyProjectContextMenu = React.lazy(async () => {
  const module = await import('./ProjectContextMenu');
  return { default: module.ProjectContextMenu };
});

export function XuenessTaskContextMenu({ menu, current, menuRef, menuReturnFocusRef, busy, groups, onPin, onRename, onArchive, closeTaskMenu, handleTaskMenuKeyDown, move }: {
  menu: { id: string; x: number; y: number } | null;
  current: SessionSummary | undefined;
  menuRef: React.Ref<HTMLDivElement>;
  menuReturnFocusRef: { current: HTMLElement | null };
  busy: boolean;
  groups: TaskGroup[];
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onArchive: (id: string) => void;
  closeTaskMenu: (restoreFocus?: boolean) => void;
  handleTaskMenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  move: (id: string, groupId: string) => void;
}) {
  return <>
    {menu&&current&&<><button className="xn-task-list__menu-backdrop" aria-label={tr('关闭')} onClick={()=>closeTaskMenu()}/><div ref={menuRef} className="xn-task-list__context" role="menu" aria-label={tr('任务操作')} style={{left:menu.x,top:menu.y}} onKeyDown={handleTaskMenuKeyDown} onBlur={e=>{const target=e.relatedTarget as HTMLElement|null;if(target?.closest('.xn-select-menu'))return;if(!e.currentTarget.contains(target))closeTaskMenu();}}>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onPin(current.id,!current.pinned);closeTaskMenu(true);}}><Pin size={14}/>{tr(current.pinned?'取消置顶':'置顶')}</button>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onRename(current.id,menuReturnFocusRef.current);closeTaskMenu();}}><Pencil size={14}/>{tr('重命名')}</button>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onArchive(current.id);closeTaskMenu();}}><Archive size={14}/>{tr('归档')}</button>
      {groups.length>0&&<Select aria-label={tr('移动到分组')} value="" onChange={e=>{move(current.id,e.target.value);closeTaskMenu(true);}}><option value="">{tr('移动到分组')}</option><option value="__ungrouped__">{tr('未分组')}</option>{groups.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}</Select>}
    </div></>}
  </>;
}

export function XuenessProjectMenuHost({ projectMenuOpenedOnce, projectMenuTarget, projectSections, projectMenuReturnFocusRef, preferences, save, setProjectPin, onOpenProjectExplorer, onArchiveProjectSessions, closeProjectMenu }: {
  projectMenuOpenedOnce: boolean;
  projectMenuTarget: ProjectContextMenuTarget | null;
  projectSections: SidebarProjectSection[];
  projectMenuReturnFocusRef: { current: HTMLElement | null };
  preferences: SidebarPreferences;
  save: (patch: Partial<SidebarPreferences>) => void;
  setProjectPin: (path: string, pinned: boolean) => void;
  onOpenProjectExplorer?: (root: string) => void;
  onArchiveProjectSessions?: (root: string, sessionIds: string[]) => void;
  closeProjectMenu: (restoreFocus?: boolean) => void;
}) {
  return <>
    {projectMenuOpenedOnce&&<React.Suspense fallback={null}><LazyProjectContextMenu project={projectMenuTarget} sections={projectSections} focusReturnTo={projectMenuReturnFocusRef.current}
      onPinProject={setProjectPin}
      onRenameProject={(path,label)=>save({projectLabels:setSidebarProjectLabel(preferences.projectLabels,path,label)})}
      onMoveProjectToSection={(path,sectionId)=>save({projectSections:moveSidebarProjectToSection(preferences.projectSections,path,sectionId)})}
      onCreateProjectSection={(path,label)=>save({projectSections:createSidebarProjectSection(preferences.projectSections,path,label,crypto.randomUUID())})}
      onOpenProjectExplorer={onOpenProjectExplorer}
      onArchiveProjectSessions={onArchiveProjectSessions}
      onRemoveProject={path=>save({hiddenProjectRoots:toggleHiddenProjectRoot(preferences.hiddenProjectRoots,path)})}
      onClose={closeProjectMenu}/></React.Suspense>}
  </>;
}
