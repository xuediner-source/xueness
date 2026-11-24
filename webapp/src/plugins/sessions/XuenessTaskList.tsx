import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { SidebarNav } from './SidebarNav';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { t as tr, useLocale } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';
import { normalizeChangeSummary, normalizePendingInteraction } from './sessionsIndex';
import { PANE_SESSION_DRAG_MIME, paneDragPayload } from './paneLayout';
import { timelineBuckets } from './sessionsSidebarTimeline';
import type { ProjectContextMenuTarget } from './ProjectContextMenu';
import {
  isSidebarProjectPinned,
  normalizeHiddenProjectRoots,
  normalizeSidebarProjectRoots,
  normalizeSidebarProjectSections,
  sameSidebarProjectPath,
  sidebarProjectSectionId,
  togglePinnedProjectRoot,
} from './projectSidebar';
import {
  TASK_GROUP_DRAG_MIME,
  mergePurposeBuckets,
  mergeProjectBuckets,
  mergeWorkspaceBuckets,
  projectArchivePlan,
  sessionSidebarFields,
  type SidebarBucket,
  type SidebarPreferences,
  type SidebarProjectRoot,
  type SidebarView,
} from './taskListModel';
import {
  dialogFocusWrapIndex,
  isTaskContextMenuShortcut,
  moveTaskIntoGroup,
  nextSidebarMenuIndex,
  persistTaskGroupDrop,
  resolveSidebarDragSession,
  restoreSidebarFocus,
  shouldDismissGroupEditorOnEscape,
  taskRelativeTime,
  toggleSidebarBuckets,
} from './taskListHelpers';
import { XuenessTaskListToolbar } from './XuenessTaskListToolbar';
import { XuenessTaskContextMenu, XuenessProjectMenuHost } from './XuenessTaskListMenus';
import './task-list.css';
export type { TaskGroup, SidebarProjectRoot, TaskProjectBucket, SidebarBucket, SidebarView, SidebarPreferences, ProjectArchivePlan } from './taskListModel';
export { TASK_GROUP_DRAG_MIME, mergeWorkspaceBuckets, mergePurposeBuckets, mergeProjectBuckets, projectArchivePlan } from './taskListModel';
export { normalizeHiddenProjectRoots, sameSidebarProjectPath, toggleHiddenProjectRoot } from './projectSidebar';
export {
  resolveSidebarDragSession, isTaskContextMenuShortcut, nextSidebarMenuIndex, dialogFocusWrapIndex,
  shouldDismissGroupEditorOnEscape, restoreSidebarFocus, moveTaskIntoGroup, toggleSidebarBuckets,
  persistTaskGroupDrop, taskRelativeTime,
} from './taskListHelpers';

/** Optional sessions-index fields. The REST list remains backwards compatible, so
 * rows may carry these either at the top level or inside `sidecar`. */
export type { SessionSidebarSidecar } from './sessionsIndex';

export interface XuenessTaskListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
  /** Files owns change metadata; hide cached summaries as soon as it stops. */
  changesEnabled?: boolean;
  /** Hide cached remote contributions immediately when its plugin stops. */
  remoteEnabled?: boolean;
  /** Compact presentation keeps all list operations in a single options menu. */
  compact?: boolean;
  preferences?: SidebarPreferences;
  onPreferences: (value: SidebarPreferences) => void;
  onSelect: (id: string) => void;
  onRename: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onArchive: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onOpenArchived: () => void;
  projectRoots?: SidebarProjectRoot[];
  onAddProject?: (trigger: HTMLElement) => void;
  onStartProject?: (root: string) => void;
  onOpenProjectExplorer?: (root: string) => void;
  onArchiveProjectSessions?: (root: string, sessionIds: string[]) => void;
}

export function XuenessTaskList({
  sessions,
  activeId,
  busy,
  changesEnabled = false,
  remoteEnabled = false,
  compact = false,
  preferences = {},
  onPreferences,
  onSelect,
  onRename,
  onArchive,
  onPin,
  onOpenArchived,
  projectRoots = [],
  onAddProject,
  onStartProject,
  onOpenProjectExplorer,
  onArchiveProjectSessions,
}: XuenessTaskListProps) {
  useLocale();
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const [projectMenu,setProjectMenu]=useState<{path:string;label:string;x:number;y:number}|null>(null);
  const [projectMenuOpenedOnce,setProjectMenuOpenedOnce]=useState(false);
  const [editor,setEditor]=useState<{id?:string;label:string}|null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const rootRef=useRef<HTMLDivElement|null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const optionsMenuId = React.useId();
  const menuRef=useRef<HTMLDivElement|null>(null);
  const menuReturnFocusRef=useRef<HTMLElement|null>(null);
  const projectMenuReturnFocusRef=useRef<HTMLElement|null>(null);
  const dialogRef=useRef<HTMLFormElement|null>(null);
  const editorReturnFocusRef=useRef<HTMLElement|null>(null);
  const groups = Array.isArray(preferences.groups) ? preferences.groups.filter(g=>g&&typeof g.id==='string'&&typeof g.label==='string'&&Array.isArray(g.taskIds)) : [];
  const collapsed = Array.isArray(preferences.collapsed) ? preferences.collapsed : [];
  const projectSections = normalizeSidebarProjectSections(preferences.projectSections);
  const pinnedProjectRoots = normalizeSidebarProjectRoots(preferences.pinnedProjectRoots);
  const view: SidebarView=preferences.view??'projects';
  const timeline=view==='timeline' ? timelineBuckets(sessions) : [];
  const sorted=view==='timeline' ? timeline.flatMap(bucket=>bucket.items)
    : [...sessions].sort((a,b)=> preferences.sort==='name' ? (a.title||a.task).localeCompare(b.title||b.task) : ((Date.parse(b.updatedAt??'')||0)-(Date.parse(a.updatedAt??'')||0))*(preferences.sort==='oldest'?-1:1));
  const save=(patch:Partial<SidebarPreferences>)=>onPreferences({...preferences,...patch});
  const rowItems=(items:SessionSummary[])=>items.map(s=>{
    const row = sessionSidebarFields(s);
    return {
      id:s.id,
      label:s.title||s.task||tr('未命名任务'),
      active:s.id===activeId,
      status:s.status,
      pinned:s.pinned,
      timeLabel:compact && view!=='timeline' ? undefined : taskRelativeTime(s.updatedAt),
      pendingInteraction: normalizePendingInteraction(row.pendingInteraction),
      unread: row.unread === true,
      changeSummary: changesEnabled ? normalizeChangeSummary(row.changeSummary) : undefined,
      remote: remoteEnabled ? row.remote : undefined,
    };
  });
  const openTaskMenu=(id:string,x:number,y:number,returnFocus:HTMLElement|null)=>{
    setProjectMenu(null);
    menuReturnFocusRef.current=returnFocus;
    setMenu({id,x:Math.max(4,Math.min(x,window.innerWidth-220)),y:Math.max(4,Math.min(y,window.innerHeight-190))});
  };
  const openProjectMenu=(path:string,label:string,x:number,y:number,returnFocus:HTMLElement|null)=>{
    setMenu(null);
    setProjectMenuOpenedOnce(true);
    projectMenuReturnFocusRef.current=returnFocus;
    setProjectMenu({path,label,x:Math.max(4,Math.min(x,window.innerWidth-264)),y:Math.max(4,Math.min(y,window.innerHeight-390))});
  };
  const closeTaskMenu=(restoreFocus=false)=>{
    setMenu(null);
    if(restoreFocus) requestAnimationFrame(()=>restoreSidebarFocus(menuReturnFocusRef.current));
  };
  const closeProjectMenu=(restoreFocus=false)=>{
    setProjectMenu(null);
    if(restoreFocus) requestAnimationFrame(()=>{
      restoreSidebarFocus(projectMenuReturnFocusRef.current,
        rootRef.current?.querySelector<HTMLButtonElement>('.xn-task-list__toolbar-add-project, .xn-task-list__options-trigger, .xn-task-list__segments button[aria-pressed="true"]'));
    });
  };
  const renderRows=(items:SessionSummary[], recent=false)=> <div
    onContextMenu={e=>{
      const el=(e.target as HTMLElement).closest<HTMLElement>('[data-session-id]');
      if(!el)return;
      e.preventDefault();
      openTaskMenu(el.dataset.sessionId!,e.clientX,e.clientY,el);
    }}
    onKeyDown={e=>{
      if(!isTaskContextMenuShortcut(e.key,e.shiftKey))return;
      const target=e.target as HTMLElement;
      // 焦点在 listbox 容器上时（键盘导航），经 aria-activedescendant 找到光标行。
      let el=target.closest<HTMLElement>('[data-session-id]');
      if(!el&&target.getAttribute){
        const cursorId=target.getAttribute('aria-activedescendant');
        if(cursorId)el=document.getElementById(cursorId)?.closest<HTMLElement>('[data-session-id]')??null;
      }
      if(!el)return;
      e.preventDefault();
      const bounds=el.getBoundingClientRect();
      openTaskMenu(el.dataset.sessionId!,bounds.left,bounds.bottom,el);
    }}
    onDragStart={e=>{
      const session=resolveSidebarDragSession(e.target as HTMLElement,sessions);
      if(!session)return;
      e.dataTransfer.setData(TASK_GROUP_DRAG_MIME,session.id);
      const payload=paneDragPayload(session);
      if(payload)e.dataTransfer.setData(PANE_SESSION_DRAG_MIME,payload);
    }}
  ><SidebarNav items={rowItems(items)} onSelect={onSelect} onRename={compact ? undefined : onRename} onDelete={compact ? undefined : onArchive}
    followSelection={!recent} testIdPrefix={recent ? 'xn-sidebar-recent-item-' : undefined} label={recent ? tr('最近会话') : undefined}
    onMenu={compact ? (id, trigger) => { const bounds=trigger.getBoundingClientRect(); openTaskMenu(id,bounds.left,bounds.bottom,trigger); } : undefined}/></div>;
  const unpinned=sorted.filter(s=>!s.pinned);
  const projectBuckets = view==='projects'
    ? mergeProjectBuckets(unpinned, projectRoots, preferences.hiddenProjectRoots, preferences.projectLabels, pinnedProjectRoots, projectSections)
    : [];
  const buckets: SidebarBucket[] = view==='timeline'
    ? timeline.map(bucket=>({...bucket,items:bucket.items.filter(s=>!s.pinned)})).filter(bucket=>bucket.items.length>0)
    : view==='projects'
    ? projectBuckets
    : view==='workspace'
      ? mergeWorkspaceBuckets(unpinned)
      : view==='purpose'
        ? mergePurposeBuckets(unpinned)
        : [
          ...groups.map(g=>({...g,items:unpinned.filter(s=>g.taskIds.includes(s.id)),project:false})),
          {id:'__ungrouped__',label:tr('未分组'),items:unpinned.filter(s=>!groups.some(g=>g.taskIds.includes(s.id))),project:false}
        ];
  const viewCollapsed=collapsed.filter(id=>buckets.some(bucket=>bucket.id===id));
  const toggleAll=()=>save({collapsed:toggleSidebarBuckets(collapsed,buckets.map(bucket=>bucket.id))});
  const toggle=(id:string)=>save({collapsed:collapsed.includes(id)?collapsed.filter(v=>v!==id):[...collapsed,id]});
  const current=sessions.find(s=>s.id===menu?.id);
  const projectMenuTarget: ProjectContextMenuTarget | null = projectMenu ? (() => {
    const bucket = projectBuckets.find(item => sameSidebarProjectPath(item.id, projectMenu.path));
    const archivePlan = projectArchivePlan(sessions, projectMenu.path);
    return {
      ...projectMenu,
      label: bucket?.label ?? projectMenu.label,
      pinned: isSidebarProjectPinned(pinnedProjectRoots, projectMenu.path),
      sectionId: sidebarProjectSectionId(projectSections, projectMenu.path),
      archivableSessionIds: archivePlan.sessionIds,
      skippedActiveCount: archivePlan.skippedActiveCount,
    };
  })() : null;
  const move=(id:string,groupId:string)=>save({groups:moveTaskIntoGroup(groups,id,groupId)});
  const beginGroupEditor=(next:{id?:string;label:string},trigger:HTMLElement)=>{
    editorReturnFocusRef.current=trigger;
    setEditor(next);
  };
  const closeGroupEditor=()=>{
    setEditor(null);
    requestAnimationFrame(()=>{
      restoreSidebarFocus(editorReturnFocusRef.current,document.querySelector<HTMLButtonElement>('.xn-task-list__new-group'));
    });
  };
  const editorOpen=editor!==null;

  const projectPartitions = view === 'projects'
    ? [
      ...(projectBuckets.some(bucket => bucket.pinned)
        ? [{ id: '__project_pinned__', label: tr('已置顶项目'), items: projectBuckets.filter(bucket => bucket.pinned) }]
        : []),
      ...(projectSections.length > 0
        ? [
          ...(projectBuckets.some(bucket => !bucket.pinned && !bucket.sectionId)
            ? [{ id: '__project_unsectioned__', label: tr('未分区'), items: projectBuckets.filter(bucket => !bucket.pinned && !bucket.sectionId) }]
            : []),
          ...projectSections.map(section => ({ id: section.id, label: section.label, items: projectBuckets.filter(bucket => !bucket.pinned && bucket.sectionId === section.id) })),
        ]
        : [{ id: '__project_all__', label: '', items: projectBuckets.filter(bucket => !bucket.pinned) }]),
    ]
    : [{ id: '__project_all__', label: '', items: buckets }];

  const setProjectPin = (path: string, pinned: boolean) => {
    const current = isSidebarProjectPinned(preferences.pinnedProjectRoots, path);
    save({ pinnedProjectRoots: current === pinned ? pinnedProjectRoots : togglePinnedProjectRoot(pinnedProjectRoots, path) });
  };

  const closeOptions = (returnFocus = false) => {
    setOptionsOpen(false);
    if (returnFocus) optionsTriggerRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!optionsOpen) return;
    if (!compact) { setOptionsOpen(false); return; }
    optionsRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [optionsOpen, compact]);
  const handleOptionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOptions(true); return; }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)'));
    const next = nextSidebarMenuIndex(buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, event.key);
    if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
  };

  useEffect(()=>{
    if(!menu)return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointerDown=(event:PointerEvent)=>{
      const target=event.target as HTMLElement;
      if(menuRef.current?.contains(target)||target.closest('.xn-select-menu'))return;
      closeTaskMenu();
    };
    document.addEventListener('pointerdown',onPointerDown);
    return()=>document.removeEventListener('pointerdown',onPointerDown);
  },[menu?.id]);

  useEffect(()=>{
    if(!editorOpen)return;
    const focusable=()=>Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),[role="combobox"]:not([aria-disabled="true"])')??[]).filter(element=>element.getClientRects().length>0);
    const frame=requestAnimationFrame(()=>{(focusable()[0]??dialogRef.current)?.focus();});
    const onDialogKeyDown=(event:KeyboardEvent)=>{
      if(event.key!=='Tab')return;
      const items=focusable();
      const first=items[0],last=items[items.length-1];
      if(!first||!last){event.preventDefault();dialogRef.current?.focus();return;}
      const active=items.indexOf(document.activeElement as HTMLElement);
      const wrapped=dialogFocusWrapIndex(active,items.length,event.shiftKey);
      if(wrapped!==null){event.preventDefault();items[wrapped]?.focus();}
    };
    const keepFocusInside=(event:FocusEvent)=>{
      if(dialogRef.current?.contains(event.target as Node))return;
      (focusable()[0]??dialogRef.current)?.focus();
    };
    document.addEventListener('keydown',onDialogKeyDown);
    document.addEventListener('focusin',keepFocusInside,true);
    return()=>{
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown',onDialogKeyDown);
      document.removeEventListener('focusin',keepFocusInside,true);
    };
  },[editorOpen]);

  const handleGroupEditorKeyDown=(event:React.KeyboardEvent<HTMLFormElement>)=>{
    if(event.key!=='Escape')return;
    if(!shouldDismissGroupEditorOnEscape(event)){
      // Keep a composing Escape from bubbling to the mobile drawer handler.
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeGroupEditor();
  };

  const handleTaskMenuKeyDown=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){
      if(isImeComposingEvent(event))return;
      event.preventDefault();
      closeTaskMenu(true);
      return;
    }
    if(event.target instanceof HTMLElement&&event.target.closest('.xn-select'))return;
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled),[role="combobox"]:not([aria-disabled="true"])'));
    if(!items.length)return;
    event.preventDefault();
    const current=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=nextSidebarMenuIndex(current,items.length,event.key);
    if(next!==null)items[next]?.focus();
  };
  return <div ref={rootRef} className="xn-task-list">
    {compact && renderRows(sorted.filter(s=>s.pinned))}
    <XuenessTaskListToolbar compact={compact} view={view} busy={busy} preferences={preferences} viewCollapsedCount={viewCollapsed.length}
      optionsOpen={optionsOpen} optionsMenuId={optionsMenuId} optionsRef={optionsRef} optionsTriggerRef={optionsTriggerRef}
      setOptionsOpen={setOptionsOpen} closeOptions={closeOptions} handleOptionsKeyDown={handleOptionsKeyDown} save={save}
      toggleAll={toggleAll} beginGroupEditor={beginGroupEditor} onAddProject={onAddProject} onOpenArchived={onOpenArchived} />
    {!compact && renderRows(sorted.filter(s=>s.pinned))}
    {projectPartitions.map(partition=><React.Fragment key={partition.id}>
      {partition.label&&<div className="xn-task-list__project-partition-heading" data-testid="xn-project-section-heading" data-section-id={partition.id}>{partition.label}</div>}
      {partition.items.map(group=>{
        const isCollapsed=collapsed.includes(group.id);
        const canStartProject=group.project&&group.id!==''&&onStartProject!==undefined;
        return <section key={group.id} className="xn-task-list__group" data-timeline-bucket={view==='timeline'&&'kind' in group?group.kind:undefined}
          data-project-root={group.project?group.id:undefined} data-project-pinned={group.project&&'pinned' in group&&group.pinned?"true":undefined}
          data-project-display-name={view==='projects'&&'customLabel' in group&&group.customLabel?group.label:undefined}
          data-project-section-id={view==='projects'&&'sectionId' in group?group.sectionId:undefined}
          onDragOver={view==='groups'?e=>e.preventDefault():undefined} onDrop={view==='groups'?e=>{persistTaskGroupDrop({event:e,targetGroupId:group.id,targetIsProject:group.project,taskIds:sessions.map(s=>s.id),groups,onPersist:nextGroups=>save({groups:nextGroups})});}:undefined}>
          <header
            onContextMenu={event=>{
              if(view!=='projects'||!group.project||!group.id)return;
              event.preventDefault();
              event.stopPropagation();
              const trigger=event.currentTarget.querySelector<HTMLElement>('.xn-task-list__group-name');
              openProjectMenu(group.id,group.label,event.clientX,event.clientY,trigger);
            }}
            onKeyDown={event=>{
              if(view!=='projects'||!group.project||!group.id||!isTaskContextMenuShortcut(event.key,event.shiftKey))return;
              event.preventDefault();
              event.stopPropagation();
              const trigger=(event.target as HTMLElement).closest<HTMLElement>('button')
                ??event.currentTarget.querySelector<HTMLElement>('.xn-task-list__group-name');
              const bounds=trigger?.getBoundingClientRect();
              openProjectMenu(group.id,group.label,bounds?.left??event.currentTarget.getBoundingClientRect().left,
                bounds?.bottom??event.currentTarget.getBoundingClientRect().bottom,trigger);
            }}
          >
            <button className="xn-task-list__group-name" aria-expanded={!isCollapsed} title={group.id} onClick={()=>toggle(group.id)}>
              {group.project?<Folder size={14}/>:<ChevronDown size={14} className={isCollapsed?'is-collapsed':''}/>}<span>{group.label}</span>
              {group.project&&'pinned' in group&&group.pinned&&<span className="xn-task-list__project-pinned" title={tr('已置顶')} aria-label={tr('已置顶')}><Pin size={11}/></span>}
            </button>
            {canStartProject&&<button type="button" className="xn-task-list__project-new-task" data-testid="xn-task-project-new-task" title={tr('新建任务')} aria-label={`${tr('新建任务')}: ${group.label}`} disabled={busy} onClick={()=>onStartProject(group.id)}><Plus size={14}/></button>}
            {view==='groups'&&group.id!=='__ungrouped__'&&<button title={tr('重命名')} aria-label={tr('重命名')} onClick={e=>beginGroupEditor({id:group.id,label:group.label},e.currentTarget)}><Pencil size={12}/></button>}
          </header>
          {!isCollapsed&&group.project&&group.items.length===0&&canStartProject&&<button type="button" className="xn-task-list__empty-project-new-task" data-testid="xn-task-empty-project-new-task" disabled={busy} onClick={()=>onStartProject(group.id)}><Plus size={14}/>{tr('新建任务')}</button>}
          {!isCollapsed&&group.items.length>0&&renderRows(group.items)}
        </section>;
      })}
    </React.Fragment>)}
    {compact && view!=='timeline' && unpinned.length > 0 && <section className="xn-task-list__recent" aria-label={tr('最近会话')}>
      <h2 className="xn-task-list__section-label">{tr('最近')}</h2>
      {renderRows([...unpinned].sort((a,b)=>(Date.parse(b.updatedAt??'')||0)-(Date.parse(a.updatedAt??'')||0)).slice(0,8),true)}
    </section>}
    {view==='groups'&&<button className="xn-task-list__new-group" onClick={e=>beginGroupEditor({label:''},e.currentTarget)}><Plus size={14}/>{tr('新建分组')}</button>}
    <XuenessTaskContextMenu menu={menu} current={current} menuRef={menuRef} menuReturnFocusRef={menuReturnFocusRef} busy={busy} groups={groups}
      onPin={onPin} onRename={onRename} onArchive={onArchive} closeTaskMenu={closeTaskMenu} handleTaskMenuKeyDown={handleTaskMenuKeyDown} move={move} />
    <XuenessProjectMenuHost projectMenuOpenedOnce={projectMenuOpenedOnce} projectMenuTarget={projectMenuTarget} projectSections={projectSections}
      projectMenuReturnFocusRef={projectMenuReturnFocusRef} preferences={preferences} save={save} setProjectPin={setProjectPin}
      onOpenProjectExplorer={onOpenProjectExplorer} onArchiveProjectSessions={onArchiveProjectSessions} closeProjectMenu={closeProjectMenu} />
    {editor&&<div className="xn-task-list__dialog-backdrop" onClick={closeGroupEditor}><form ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tr(editor.id?'重命名分组':'新建分组')} onKeyDown={handleGroupEditorKeyDown} onClick={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();const label=editor.label.trim();if(!label)return;save({groups:editor.id?groups.map(g=>g.id===editor.id?{...g,label}:g):[...groups,{id:crypto.randomUUID(),label,taskIds:[]}]});closeGroupEditor();}}><h3>{tr(editor.id?'重命名分组':'新建分组')}</h3><input required maxLength={80} aria-label={tr('分组名称')} value={editor.label} onChange={e=>setEditor({...editor,label:e.target.value})}/><footer>{editor.id&&<button type="button" onClick={()=>{save({groups:groups.filter(g=>g.id!==editor.id)});closeGroupEditor();}}><Trash2 size={14}/>{tr('删除')}</button>}<button type="button" onClick={closeGroupEditor}>{tr('取消')}</button><button type="submit">{tr('保存')}</button></footer></form></div>}
  </div>;
}
