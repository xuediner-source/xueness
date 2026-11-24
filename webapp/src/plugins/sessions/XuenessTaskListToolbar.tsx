import React from 'react';
import { Archive, ArrowDownWideNarrow, BriefcaseBusiness, Check, ChevronsDownUp, Clock, Folder, Hash, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { t as tr } from '../../i18n';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import type { SidebarPreferences, SidebarView } from './taskListModel';

export interface XuenessTaskListToolbarProps {
  compact: boolean;
  view: SidebarView;
  busy: boolean;
  preferences: SidebarPreferences;
  viewCollapsedCount: number;
  optionsOpen: boolean;
  optionsMenuId: string;
  optionsRef: React.Ref<HTMLDivElement>;
  optionsTriggerRef: React.Ref<HTMLButtonElement>;
  setOptionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeOptions: (returnFocus?: boolean) => void;
  handleOptionsKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  save: (patch: Partial<SidebarPreferences>) => void;
  toggleAll: () => void;
  beginGroupEditor: (next: { id?: string; label: string }, trigger: HTMLElement) => void;
  onAddProject?: (trigger: HTMLElement) => void;
  onOpenArchived: () => void;
}

export function XuenessTaskListToolbar({
  compact, view, busy, preferences, viewCollapsedCount, optionsOpen, optionsMenuId, optionsRef, optionsTriggerRef,
  setOptionsOpen, closeOptions, handleOptionsKeyDown, save, toggleAll, beginGroupEditor, onAddProject, onOpenArchived,
}: XuenessTaskListToolbarProps) {
  return <>
    {compact ? <div className="xn-task-list__toolbar xn-task-list__toolbar--compact">
      <span className="xn-task-list__toolbar-label">{tr(view === 'projects' ? '项目' : view === 'workspace' ? '工作区' : view === 'purpose' ? '用途' : view === 'timeline' ? '时间线' : '分组')}</span>
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
          {(['groups', 'projects', 'workspace', 'purpose', 'timeline'] as const).map(value => <button key={value} type="button" role="menuitemradio"
            aria-checked={view === value} onClick={() => { save({ view: value }); closeOptions(true); }}>
            {value === 'groups' ? <Hash size={14} /> : value === 'projects' ? <Folder size={14} /> : value === 'workspace' ? <BriefcaseBusiness size={14} /> : value === 'timeline' ? <Clock size={14} /> : <Sparkles size={14} />}<span>{tr(value === 'groups' ? '分组' : value === 'projects' ? '项目' : value === 'workspace' ? '工作区' : value === 'timeline' ? '时间线' : '用途')}</span>
            {view === value && <Check size={14} />}
          </button>)}
          {view !== 'timeline' && <>
          <div role="separator" />
          <div className="xn-task-list__options-menu-label">{tr('排序')}</div>
          {(['recent', 'oldest', 'name'] as const).map(value => <button key={value} type="button" role="menuitemradio"
            aria-checked={(preferences.sort ?? 'recent') === value} onClick={() => { save({ sort: value }); closeOptions(true); }}>
            <span>{tr(value === 'recent' ? '最新' : value === 'oldest' ? '最早' : '名称')}</span>
            {(preferences.sort ?? 'recent') === value && <Check size={14} />}
          </button>)}
          </>}
          <div role="separator" />
          <button type="button" role="menuitem" onClick={() => { toggleAll(); closeOptions(true); }}>
            <ChevronsDownUp size={14} /><span>{tr(viewCollapsedCount ? '展开全部' : '折叠全部')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { onOpenArchived(); closeOptions(true); }}><Archive size={14} /><span>{tr('已归档')}</span></button>
        </div>}
      </div>
    </div> : <div className="xn-task-list__toolbar" data-section-label={tr('任务')}>
      <div className="xn-task-list__segments" role="group" aria-label={tr('列表分组方式')}>
        <button aria-pressed={view==='groups'} onClick={()=>save({view:'groups'})}><Hash size={12}/>{tr('分组')}</button>
        <button aria-pressed={view==='projects'} onClick={()=>save({view:'projects'})}><Folder size={12}/>{tr('项目')}</button>
        <button aria-pressed={view==='workspace'} onClick={()=>save({view:'workspace'})}><BriefcaseBusiness size={12}/>{tr('工作区')}</button>
        <button aria-pressed={view==='purpose'} onClick={()=>save({view:'purpose'})}><Sparkles size={12}/>{tr('用途')}</button>
        <button aria-pressed={view==='timeline'} onClick={()=>save({view:'timeline'})}><Clock size={12}/>{tr('时间线')}</button>
      </div>
      {view==='projects'&&onAddProject&&<button type="button" className="xn-task-list__toolbar-add-project" data-testid="xn-task-add-project" title={tr('添加项目')} aria-label={tr('添加项目')} disabled={busy} onClick={e=>onAddProject(e.currentTarget)}><Plus size={14}/></button>}
      <button title={tr(viewCollapsedCount?'展开全部':'折叠全部')} aria-label={tr(viewCollapsedCount?'展开全部':'折叠全部')} onClick={toggleAll}><ChevronsDownUp size={14}/></button>
      {view!=='timeline'&&<details className="xn-task-list__sort"><summary aria-label={tr('排序')}><ArrowDownWideNarrow size={14}/></summary><div>{(['recent','oldest','name'] as const).map(v=><button key={v} aria-pressed={(preferences.sort??'recent')===v} onClick={e=>{save({sort:v});e.currentTarget.closest('details')!.open=false;}}>{tr(v==='recent'?'最新':v==='oldest'?'最早':'名称')}</button>)}</div></details>}
      <button title={tr('已归档')} aria-label={tr('已归档')} onClick={onOpenArchived}><Archive size={14}/></button>
    </div>}
  </>;
}
