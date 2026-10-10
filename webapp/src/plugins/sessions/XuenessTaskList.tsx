import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownWideNarrow, Check, ChevronsDownUp, ChevronDown, Folder, Hash, MoreHorizontal, Plus, Pencil, Pin, Trash2 } from 'lucide-react';
import { SidebarNav } from './SidebarNav';
import { Select } from '../../ui/Select';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { t as tr, tf } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';
import '../../styles/task-list-parity.css';
export type TaskGroup = { id: string; label: string; taskIds: string[] };
export type SidebarProjectRoot = { path: string; name: string };
export type TaskProjectBucket = { id: string; label: string; items: SessionSummary[]; project: true };
export type SidebarPreferences = { view?: 'groups'|'projects'; sort?: 'recent'|'oldest'|'name'; groups?: TaskGroup[]; collapsed?: string[] };
export const TASK_GROUP_DRAG_MIME = 'application/x-xueness-session';

export function mergeProjectBuckets(sessions: SessionSummary[], projectRoots: SidebarProjectRoot[] = []): TaskProjectBucket[] {
  const buckets = new Map<string, TaskProjectBucket>();
  const labelForPath = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || tr('任务');
  for (const root of projectRoots) {
    if (!root || typeof root.path !== 'string' || !root.path) continue;
    if (!buckets.has(root.path)) {
      buckets.set(root.path, {
        id: root.path,
        label: root.name.trim() || labelForPath(root.path),
        items: [],
        project: true,
      });
    }
  }
  for (const session of sessions) {
    const id = session.root ?? '';
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { id, label: labelForPath(id), items: [], project: true };
      buckets.set(id, bucket);
    }
    bucket.items.push(session);
  }
  return [...buckets.values()];
}

export interface XuenessTaskListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  busy: boolean;
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
}

export function isTaskContextMenuShortcut(key:string,shiftKey=false):boolean {
  return key==='ContextMenu'||(key==='F10'&&shiftKey);
}

export function nextSidebarMenuIndex(current:number,length:number,key:string):number|null {
  if(length<1)return null;
  if(key==='Home')return 0;
  if(key==='End')return length-1;
  if(key!=='ArrowDown'&&key!=='ArrowUp')return null;
  if(current<0)return key==='ArrowDown'?0:length-1;
  return (current+(key==='ArrowDown'?1:-1)+length)%length;
}

export function dialogFocusWrapIndex(current:number,length:number,backward:boolean):number|null {
  if(length<1)return null;
  if(current<0)return backward?length-1:0;
  if(backward&&current===0)return length-1;
  if(!backward&&current===length-1)return 0;
  return null;
}

export function shouldDismissGroupEditorOnEscape(event: {
  key: string;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  isComposing?: boolean;
  compositionActive?: boolean;
}): boolean {
  return event.key === 'Escape' && !isImeComposingEvent(event);
}

export function restoreSidebarFocus(
  trigger:{isConnected:boolean;focus():void}|null,
  fallback?:{isConnected:boolean;focus():void}|null,
):void {
  if(trigger?.isConnected){trigger.focus();return;}
  if(fallback?.isConnected)fallback.focus();
}

export function moveTaskIntoGroup(groups: TaskGroup[], taskId: string, targetGroupId: string): TaskGroup[] {
  return groups.map(group => ({
    ...group,
    taskIds: [...group.taskIds.filter(id => id !== taskId), ...(group.id === targetGroupId ? [taskId] : [])],
  }));
}

export function persistTaskGroupDrop({
  event,
  targetGroupId,
  targetIsProject,
  taskIds,
  groups,
  onPersist,
}: {
  event: { preventDefault(): void; dataTransfer: { getData(type: string): string } };
  targetGroupId: string;
  targetIsProject: boolean;
  taskIds: string[];
  groups: TaskGroup[];
  onPersist(nextGroups: TaskGroup[]): void;
}): boolean {
  if (targetIsProject) return false;
  event.preventDefault();
  const taskId = event.dataTransfer.getData(TASK_GROUP_DRAG_MIME);
  if (!taskIds.includes(taskId)) return false;
  onPersist(moveTaskIntoGroup(groups, taskId, targetGroupId));
  return true;
}

export function taskRelativeTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const minutes = Math.max(0, Math.floor((Date.now()-Date.parse(value))/60000));
  return minutes < 1 ? tr('刚刚') : minutes < 60 ? tf('{0} 分钟前',[minutes]) : minutes < 1440 ? tf('{0} 小时前',[Math.floor(minutes/60)]) : tf('{0} 天前',[Math.floor(minutes/1440)]);
}
export function XuenessTaskList({
  sessions,
  activeId,
  busy,
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
}: XuenessTaskListProps) {
  const [menu,setMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const [editor,setEditor]=useState<{id?:string;label:string}|null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const optionsMenuId = React.useId();
  const menuRef=useRef<HTMLDivElement|null>(null);
  const menuReturnFocusRef=useRef<HTMLElement|null>(null);
  const dialogRef=useRef<HTMLFormElement|null>(null);
  const editorReturnFocusRef=useRef<HTMLElement|null>(null);
  const groups = Array.isArray(preferences.groups) ? preferences.groups.filter(g=>g&&typeof g.id==='string'&&typeof g.label==='string'&&Array.isArray(g.taskIds)) : [];
  const collapsed = Array.isArray(preferences.collapsed) ? preferences.collapsed : [];
  const view=preferences.view??'projects';
  const sorted=[...sessions].sort((a,b)=> preferences.sort==='name' ? (a.title||a.task).localeCompare(b.title||b.task) : ((Date.parse(b.updatedAt??'')||0)-(Date.parse(a.updatedAt??'')||0))*(preferences.sort==='oldest'?-1:1));
  const save=(patch:Partial<SidebarPreferences>)=>onPreferences({...preferences,...patch});
  const rowItems=(items:SessionSummary[])=>items.map(s=>({id:s.id,label:s.title||s.task||tr('未命名任务'),active:s.id===activeId,status:s.status,pinned:s.pinned,timeLabel:compact ? undefined : taskRelativeTime(s.updatedAt)}));
  const openTaskMenu=(id:string,x:number,y:number,returnFocus:HTMLElement|null)=>{
    menuReturnFocusRef.current=returnFocus;
    setMenu({id,x:Math.max(4,Math.min(x,window.innerWidth-220)),y:Math.max(4,Math.min(y,window.innerHeight-190))});
  };
  const closeTaskMenu=(restoreFocus=false)=>{
    setMenu(null);
    if(restoreFocus) requestAnimationFrame(()=>restoreSidebarFocus(menuReturnFocusRef.current));
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
      const el=(e.target as HTMLElement).closest<HTMLElement>('[data-session-id]');
      if(el)e.dataTransfer.setData(TASK_GROUP_DRAG_MIME,el.dataset.sessionId!);
    }}
  ><SidebarNav items={rowItems(items)} onSelect={onSelect} onRename={compact ? undefined : onRename} onDelete={compact ? undefined : onArchive}
    followSelection={!recent} testIdPrefix={recent ? 'xn-sidebar-recent-item-' : undefined} label={recent ? tr('最近会话') : undefined}
    onMenu={compact ? (id, trigger) => { const bounds=trigger.getBoundingClientRect(); openTaskMenu(id,bounds.left,bounds.bottom,trigger); } : undefined}/></div>;
  const unpinned=sorted.filter(s=>!s.pinned);
  const buckets=view==='projects' ? mergeProjectBuckets(unpinned, projectRoots) : [
    ...groups.map(g=>({...g,items:unpinned.filter(s=>g.taskIds.includes(s.id)),project:false})),
    {id:'__ungrouped__',label:tr('未分组'),items:unpinned.filter(s=>!groups.some(g=>g.taskIds.includes(s.id))),project:false}
  ];
  const toggle=(id:string)=>save({collapsed:collapsed.includes(id)?collapsed.filter(v=>v!==id):[...collapsed,id]});
  const current=sessions.find(s=>s.id===menu?.id);
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
  return <div className="xn-task-list">
    {compact && renderRows(sorted.filter(s=>s.pinned))}
    {compact ? <div className="xn-task-list__toolbar xn-task-list__toolbar--compact">
      <span className="xn-task-list__toolbar-label">{tr(view === 'projects' ? '项目' : '分组')}</span>
      {view === 'projects' && onAddProject && <button type="button" className="xn-task-list__toolbar-add-project"
        data-testid="xn-task-add-project" title={tr('添加项目')} aria-label={tr('添加项目')} disabled={busy}
        onClick={event => onAddProject(event.currentTarget)}><Plus size={14} /></button>}
      {view === 'groups' && <button type="button" title={tr('新建分组')} aria-label={tr('新建分组')}
        onClick={event => beginGroupEditor({ label: '' }, event.currentTarget)}><Plus size={14} /></button>}
      <div className="xn-task-list__options" ref={optionsRef} onBlur={event => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) closeOptions();
      }}>
        <button type="button" ref={optionsTriggerRef} className="xn-task-list__options-trigger"
          aria-label={tr('任务操作')} title={tr('任务操作')} aria-haspopup="menu" aria-expanded={optionsOpen}
          aria-controls={optionsOpen ? optionsMenuId : undefined} onClick={() => setOptionsOpen(open => !open)}
          onKeyDown={event => {
            if (isImeComposingEvent(event)) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); setOptionsOpen(true); }
            else if (event.key === 'Escape' && optionsOpen) { event.preventDefault(); event.stopPropagation(); closeOptions(true); }
          }}>
          <MoreHorizontal size={16} />
        </button>
        {optionsOpen && <div id={optionsMenuId} className="xn-task-list__options-menu" role="menu" aria-label={tr('任务操作')}
          onKeyDown={handleOptionsKeyDown}>
          <div className="xn-task-list__options-menu-label">{tr('列表分组方式')}</div>
          {(['groups', 'projects'] as const).map(value => <button key={value} type="button" role="menuitemradio"
            aria-checked={view === value} onClick={() => { save({ view: value }); closeOptions(true); }}>
            {value === 'groups' ? <Hash size={14} /> : <Folder size={14} />}<span>{tr(value === 'groups' ? '分组' : '项目')}</span>
            {view === value && <Check size={14} />}
          </button>)}
          <div role="separator" />
          <div className="xn-task-list__options-menu-label">{tr('排序')}</div>
          {(['recent', 'oldest', 'name'] as const).map(value => <button key={value} type="button" role="menuitemradio"
            aria-checked={(preferences.sort ?? 'recent') === value} onClick={() => { save({ sort: value }); closeOptions(true); }}>
            <span>{tr(value === 'recent' ? '最新' : value === 'oldest' ? '最早' : '名称')}</span>
            {(preferences.sort ?? 'recent') === value && <Check size={14} />}
          </button>)}
          <div role="separator" />
          <button type="button" role="menuitem" onClick={() => { save({ collapsed: collapsed.length ? [] : buckets.map(group => group.id) }); closeOptions(true); }}>
            <ChevronsDownUp size={14} /><span>{tr(collapsed.length ? '展开全部' : '折叠全部')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { onOpenArchived(); closeOptions(true); }}><Archive size={14} /><span>{tr('已归档')}</span></button>
        </div>}
      </div>
    </div> : <div className="xn-task-list__toolbar" data-section-label={tr('任务')}>
      <div className="xn-task-list__segments" role="group" aria-label={tr('列表分组方式')}>
        <button aria-pressed={view==='groups'} onClick={()=>save({view:'groups'})}><Hash size={12}/>{tr('分组')}</button>
        <button aria-pressed={view==='projects'} onClick={()=>save({view:'projects'})}><Folder size={12}/>{tr('项目')}</button>
      </div>
      {view==='projects'&&onAddProject&&<button type="button" className="xn-task-list__toolbar-add-project" data-testid="xn-task-add-project" title={tr('添加项目')} aria-label={tr('添加项目')} disabled={busy} onClick={e=>onAddProject(e.currentTarget)}><Plus size={14}/></button>}
      <button title={tr(collapsed.length?'展开全部':'折叠全部')} aria-label={tr(collapsed.length?'展开全部':'折叠全部')} onClick={()=>save({collapsed:collapsed.length?[]:buckets.map(g=>g.id)})}><ChevronsDownUp size={14}/></button>
      <details className="xn-task-list__sort"><summary aria-label={tr('排序')}><ArrowDownWideNarrow size={14}/></summary><div>{(['recent','oldest','name'] as const).map(v=><button key={v} aria-pressed={(preferences.sort??'recent')===v} onClick={e=>{save({sort:v});e.currentTarget.closest('details')!.open=false;}}>{tr(v==='recent'?'最新':v==='oldest'?'最早':'名称')}</button>)}</div></details>
      <button title={tr('已归档')} aria-label={tr('已归档')} onClick={onOpenArchived}><Archive size={14}/></button>
    </div>}
    {!compact && renderRows(sorted.filter(s=>s.pinned))}
    {buckets.map(group=>{
      const isCollapsed=collapsed.includes(group.id);
      const canStartProject=group.project&&group.id!==''&&onStartProject!==undefined;
      return <section key={group.id} className="xn-task-list__group" data-project-root={group.project?group.id:undefined} onDragOver={e=>{if(!group.project)e.preventDefault();}} onDrop={e=>{persistTaskGroupDrop({event:e,targetGroupId:group.id,targetIsProject:group.project,taskIds:sessions.map(s=>s.id),groups,onPersist:nextGroups=>save({groups:nextGroups})});}}>
        <header>
          <button className="xn-task-list__group-name" aria-expanded={!isCollapsed} title={group.id} onClick={()=>toggle(group.id)}>{group.project?<Folder size={14}/>:<ChevronDown size={14} className={isCollapsed?'is-collapsed':''}/>}<span>{group.label}</span></button>
          {canStartProject&&<button type="button" className="xn-task-list__project-new-task" data-testid="xn-task-project-new-task" title={tr('新建任务')} aria-label={`${tr('新建任务')}: ${group.label}`} disabled={busy} onClick={()=>onStartProject(group.id)}><Plus size={14}/></button>}
          {!group.project&&group.id!=='__ungrouped__'&&<button title={tr('重命名')} aria-label={tr('重命名')} onClick={e=>beginGroupEditor({id:group.id,label:group.label},e.currentTarget)}><Pencil size={12}/></button>}
        </header>
        {!isCollapsed&&group.project&&group.items.length===0&&canStartProject&&<button type="button" className="xn-task-list__empty-project-new-task" data-testid="xn-task-empty-project-new-task" disabled={busy} onClick={()=>onStartProject(group.id)}><Plus size={14}/>{tr('新建任务')}</button>}
        {!isCollapsed&&group.items.length>0&&renderRows(group.items)}
      </section>;
    })}
    {compact && unpinned.length > 0 && <section className="xn-task-list__recent" aria-label={tr('最近会话')}>
      <h2 className="xn-task-list__section-label">{tr('最近')}</h2>
      {renderRows([...unpinned].sort((a,b)=>(Date.parse(b.updatedAt??'')||0)-(Date.parse(a.updatedAt??'')||0)).slice(0,8),true)}
    </section>}
    {view==='groups'&&<button className="xn-task-list__new-group" onClick={e=>beginGroupEditor({label:''},e.currentTarget)}><Plus size={14}/>{tr('新建分组')}</button>}
    {menu&&current&&<><button className="xn-task-list__menu-backdrop" aria-label={tr('关闭')} onClick={()=>closeTaskMenu()}/><div ref={menuRef} className="xn-task-list__context" role="menu" aria-label={tr('任务操作')} style={{left:menu.x,top:menu.y}} onKeyDown={handleTaskMenuKeyDown} onBlur={e=>{const target=e.relatedTarget as HTMLElement|null;if(target?.closest('.xn-select-menu'))return;if(!e.currentTarget.contains(target))closeTaskMenu();}}>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onPin(current.id,!current.pinned);closeTaskMenu(true);}}><Pin size={14}/>{tr(current.pinned?'取消置顶':'置顶')}</button>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onRename(current.id,menuReturnFocusRef.current);closeTaskMenu();}}><Pencil size={14}/>{tr('重命名')}</button>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>{onArchive(current.id);closeTaskMenu();}}><Archive size={14}/>{tr('归档')}</button>
      {groups.length>0&&<Select aria-label={tr('移动到分组')} value="" onChange={e=>{move(current.id,e.target.value);closeTaskMenu(true);}}><option value="">{tr('移动到分组')}</option><option value="__ungrouped__">{tr('未分组')}</option>{groups.map(g=><option key={g.id} value={g.id}>{g.label}</option>)}</Select>}
    </div></>}
    {editor&&<div className="xn-task-list__dialog-backdrop" onClick={closeGroupEditor}><form ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tr(editor.id?'重命名分组':'新建分组')} onKeyDown={handleGroupEditorKeyDown} onClick={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();const label=editor.label.trim();if(!label)return;save({groups:editor.id?groups.map(g=>g.id===editor.id?{...g,label}:g):[...groups,{id:crypto.randomUUID(),label,taskIds:[]}]});closeGroupEditor();}}><h3>{tr(editor.id?'重命名分组':'新建分组')}</h3><input required maxLength={80} aria-label={tr('分组名称')} value={editor.label} onChange={e=>setEditor({...editor,label:e.target.value})}/><footer>{editor.id&&<button type="button" onClick={()=>{save({groups:groups.filter(g=>g.id!==editor.id)});closeGroupEditor();}}><Trash2 size={14}/>{tr('删除')}</button>}<button type="button" onClick={closeGroupEditor}>{tr('取消')}</button><button type="submit">{tr('保存')}</button></footer></form></div>}
  </div>;
}
