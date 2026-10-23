import React, { useEffect, useRef, useState } from 'react';
import { Archive, Check, ChevronRight, FolderMinus, FolderOpen, Layers3, Pencil, Pin, PinOff } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import { shouldDismissModalOnEscape, useModalFocusScope } from '../shared';
import type { SidebarProjectSection } from './projectSidebar';
import './ProjectContextMenu.css';

export type ProjectContextMenuTarget = {
  path: string;
  label: string;
  x: number;
  y: number;
  pinned: boolean;
  sectionId?: string;
  archivableSessionIds: string[];
  skippedActiveCount: number;
};

type ProjectDialog =
  | { kind: 'edit'; path: string; label: string }
  | { kind: 'section'; path: string }
  | { kind: 'archive'; path: string; label: string; sessionIds: string[]; skippedCount: number }
  | null;

export type ProjectContextMenuProps = {
  project: ProjectContextMenuTarget | null;
  sections: SidebarProjectSection[];
  focusReturnTo?: HTMLElement | null;
  onPinProject: (path: string, pinned: boolean) => void;
  onRenameProject: (path: string, label: string) => void;
  onMoveProjectToSection: (path: string, sectionId: string | null) => void;
  onCreateProjectSection: (path: string, label: string) => void;
  onOpenProjectExplorer?: (path: string) => void;
  onArchiveProjectSessions?: (path: string, sessionIds: string[]) => void;
  onRemoveProject: (path: string) => void;
  onClose: (restoreFocus?: boolean) => void;
};

function ProjectDialogView({
  dialog,
  focusReturnTo,
  onDismiss,
  onRenameProject,
  onCreateProjectSection,
  onArchiveProjectSessions,
}: {
  dialog: Exclude<ProjectDialog, null>;
  focusReturnTo?: HTMLElement | null;
  onDismiss: () => void;
  onRenameProject(path: string, label: string): void;
  onCreateProjectSection(path: string, label: string): void;
  onArchiveProjectSessions?: (path: string, sessionIds: string[]) => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [label, setLabel] = useState(dialog.kind === 'edit' ? dialog.label : '');
  useModalFocusScope({
    open: true,
    dialogRef,
    initialFocusRef: dialog.kind === 'archive' ? cancelRef : inputRef,
    returnFocusTo: focusReturnTo,
  });

  const title = dialog.kind === 'edit' ? tr('编辑项目显示名称')
    : dialog.kind === 'section' ? tr('新建分区') : tf('归档“{0}”的聊天？', [dialog.label]);
  const dismissOnEscape = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (shouldDismissModalOnEscape(event)) {
      event.preventDefault();
      onDismiss();
    }
  };

  return <div className="xn-project-dialog-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onDismiss();
  }}>
    <form ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="xn-project-dialog-title"
      className="xn-project-dialog" data-testid={`xn-project-${dialog.kind}-dialog`}
      onKeyDown={dismissOnEscape}
      onSubmit={event => {
        event.preventDefault();
        if (dialog.kind === 'edit') onRenameProject(dialog.path, label);
        else if (dialog.kind === 'section') onCreateProjectSection(dialog.path, label);
        else onArchiveProjectSessions?.(dialog.path, dialog.sessionIds);
        onDismiss();
      }}>
      <h2 id="xn-project-dialog-title">{title}</h2>
      {dialog.kind === 'edit' && <>
        <p>{tr('仅更改侧栏显示名称，不会重命名文件夹。')}</p>
        <label htmlFor="xn-project-edit-name">{tr('项目显示名称')}</label>
        <input ref={inputRef} id="xn-project-edit-name" data-testid="xn-project-edit-name" maxLength={80} value={label}
          onChange={event => setLabel(event.target.value)} />
        <footer>
          <button type="button" className="xn-project-dialog__secondary" onClick={() => { onRenameProject(dialog.path, ''); onDismiss(); }}>{tr('恢复文件夹名称')}</button>
          <button type="button" onClick={onDismiss}>{tr('取消')}</button>
          <button type="submit" className="xn-project-dialog__primary" data-testid="xn-project-edit-save">{tr('保存')}</button>
        </footer>
      </>}
      {dialog.kind === 'section' && <>
        <p>{tr('新建分区后，此项目会移入该分区。')}</p>
        <label htmlFor="xn-project-section-name">{tr('分区名称')}</label>
        <input ref={inputRef} id="xn-project-section-name" data-testid="xn-project-section-name" required maxLength={80} value={label}
          onChange={event => setLabel(event.target.value)} />
        <footer>
          <button type="button" onClick={onDismiss}>{tr('取消')}</button>
          <button type="submit" className="xn-project-dialog__primary" data-testid="xn-project-section-save" disabled={!label.trim()}>{tr('创建并移动')}</button>
        </footer>
      </>}
      {dialog.kind === 'archive' && <>
        <p>{tf('将 {0} 条未运行对话移入已归档列表，你之后可以恢复。', [dialog.sessionIds.length])}</p>
        <p className="xn-project-dialog__note">{dialog.skippedCount > 0
          ? tf('有 {0} 条正在运行、排队或停止中的对话会保留在项目中。', [dialog.skippedCount])
          : tr('正在运行、排队或停止中的对话会保留在项目中。')}</p>
        <footer>
          <button type="button" ref={cancelRef} onClick={onDismiss}>{tr('取消')}</button>
          <button type="submit" className="xn-project-dialog__danger" data-testid="xn-project-archive-confirm-yes">{tr('归档聊天')}</button>
        </footer>
      </>}
    </form>
  </div>;
}

export function ProjectContextMenu({
  project,
  sections,
  focusReturnTo,
  onPinProject,
  onRenameProject,
  onMoveProjectToSection,
  onCreateProjectSection,
  onOpenProjectExplorer,
  onArchiveProjectSessions,
  onRemoveProject,
  onClose,
}: ProjectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const sectionTriggerRef = useRef<HTMLButtonElement>(null);
  const [sectionsExpanded, setSectionsExpanded] = useState(false);
  const [sectionMenuPosition, setSectionMenuPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [dialog, setDialog] = useState<ProjectDialog>(null);

  const isInMenuFamily = (target: EventTarget | null): boolean => {
    const node = target as Node | null;
    return !!node && (menuRef.current?.contains(node) === true || sectionMenuRef.current?.contains(node) === true);
  };

  useEffect(() => {
    if (!project) { setSectionsExpanded(false); return; }
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    setSectionsExpanded(false);
  }, [project?.path]);

  useEffect(() => {
    if (!project || !sectionsExpanded) { setSectionMenuPosition(null); return; }
    let frame = 0;
    const placeSectionMenu = () => {
      const trigger = sectionTriggerRef.current;
      const sectionMenu = sectionMenuRef.current;
      if (!trigger || !sectionMenu) return;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const targetWidth = Math.min(248, Math.max(1, viewportWidth - 8));
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menuRef.current?.getBoundingClientRect();
      if (!menuRect) return;
      const right = menuRect.right + 4;
      const left = menuRect.left - targetWidth - 4;
      const fitsRight = right + targetWidth <= viewportWidth - 4;
      const fitsLeft = left >= 4;
      const width = fitsRight || fitsLeft ? targetWidth : Math.max(1, viewportWidth - 8);
      const x = fitsRight ? right : fitsLeft ? left : 4;
      const measuredHeight = Math.min(sectionMenu.scrollHeight, viewportHeight - 8);
      const maxTop = Math.max(4, viewportHeight - measuredHeight - 4);
      const y = Math.max(4, Math.min(triggerRect.top - 2, maxTop));
      setSectionMenuPosition({ left: x, top: y, width, maxHeight: viewportHeight - 8 });
    };
    frame = window.requestAnimationFrame(placeSectionMenu);
    const schedulePlace = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(placeSectionMenu);
    };
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('scroll', schedulePlace, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePlace);
      window.removeEventListener('scroll', schedulePlace, true);
    };
  }, [project?.path, sectionsExpanded, sections.length]);

  const openDialog = (next: Exclude<ProjectDialog, null>) => {
    setDialog(next);
    setSectionsExpanded(false);
    onClose(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!shouldDismissModalOnEscape(event)) return;
      event.preventDefault();
      if (event.currentTarget === sectionMenuRef.current) {
        setSectionsExpanded(false);
        sectionTriggerRef.current?.focus();
        return;
      }
      onClose(true);
      return;
    }
    if (event.key === 'ArrowRight' && event.target === sectionTriggerRef.current) {
      event.preventDefault();
      setSectionsExpanded(true);
      requestAnimationFrame(() => sectionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
      return;
    }
    if (event.key === 'ArrowLeft' && sectionsExpanded && event.currentTarget === sectionMenuRef.current) {
      event.preventDefault();
      setSectionsExpanded(false);
      sectionTriggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const active = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (items.length) next = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    if (next !== null && next >= 0) { event.preventDefault(); items[next]?.focus(); }
  };

  return <>
    {project && <>
      <button className="xn-task-list__menu-backdrop" aria-label={tr('关闭')} onClick={() => onClose()} />
      <div ref={menuRef} className="xn-task-list__context xn-project-menu" role="menu" aria-label={tr('项目操作')}
        style={{ left: project.x, top: project.y }} onKeyDown={handleKeyDown}
        onBlur={event => { if (!dialog && !isInMenuFamily(event.relatedTarget)) onClose(); }}>
        <div className="xn-project-menu__title" title={project.path}>{project.label}</div>
        <button type="button" role="menuitem" data-testid="xn-project-menu-pin" aria-checked={project.pinned}
          onClick={() => { onPinProject(project.path, !project.pinned); onClose(true); }}>
          {project.pinned ? <PinOff size={14} /> : <Pin size={14} />}<span>{tr(project.pinned ? '取消置顶项目' : '置顶项目')}</span>
          {project.pinned && <Check size={14} className="xn-project-menu__check" />}
        </button>
        <button type="button" role="menuitem" data-testid="xn-project-menu-edit" onClick={() => openDialog({ kind: 'edit', path: project.path, label: project.label })}>
          <Pencil size={14} /><span>{tr('编辑项目显示名称')}</span>
        </button>
        <div className="xn-project-menu__section">
          <button ref={sectionTriggerRef} type="button" role="menuitem" data-testid="xn-project-menu-section"
            aria-haspopup="menu" aria-expanded={sectionsExpanded} aria-controls="xn-project-section-options"
            onPointerEnter={() => { setSectionsExpanded(true); }}
            onClick={() => setSectionsExpanded(true)}>
            <Layers3 size={14} /><span>{tr('分区')}</span><ChevronRight size={14} className="xn-project-menu__chevron" />
          </button>
        </div>
        <div role="separator" />
        <button type="button" role="menuitem" data-testid="xn-project-menu-reveal" disabled={!onOpenProjectExplorer}
          title={onOpenProjectExplorer ? undefined : tr('仅在桌面应用中可用')}
          onClick={() => { onOpenProjectExplorer?.(project.path); onClose(true); }}>
          <FolderOpen size={14} /><span>{tr('在资源管理器中打开')}</span>
          {!onOpenProjectExplorer && <small>{tr('仅限桌面')}</small>}
        </button>
        <div role="separator" />
        <button type="button" role="menuitem" data-testid="xn-project-menu-archive" disabled={!project.archivableSessionIds.length || !onArchiveProjectSessions}
          onClick={() => openDialog({ kind: 'archive', path: project.path, label: project.label,
            sessionIds: project.archivableSessionIds, skippedCount: project.skippedActiveCount })}>
          <Archive size={14} /><span>{tr('归档聊天')}</span><small>{project.archivableSessionIds.length}</small>
        </button>
        <button type="button" role="menuitem" data-testid="xn-project-menu-remove" aria-describedby="xn-project-remove-note"
          onClick={() => { onRemoveProject(project.path); onClose(true); }}>
          <FolderMinus size={14} /><span>{tr('从项目列表移除')}</span>
        </button>
        <div id="xn-project-remove-note" className="xn-project-menu__note">{tr('只会从侧栏隐藏。文件和会话会保留。')}</div>
      </div>
      {sectionsExpanded && <div ref={sectionMenuRef} id="xn-project-section-options"
        className="xn-project-menu__section-options" role="menu" aria-label={tr('项目分区')}
        style={sectionMenuPosition
          ? { left: sectionMenuPosition.left, top: sectionMenuPosition.top, width: sectionMenuPosition.width, maxHeight: sectionMenuPosition.maxHeight }
          : { left: 4, top: 4, visibility: 'hidden' }}
        onKeyDown={handleKeyDown}
        onBlur={event => { if (!dialog && !isInMenuFamily(event.relatedTarget)) onClose(); }}>
        <button type="button" role="menuitem" data-testid="xn-project-menu-create-section"
          onClick={() => openDialog({ kind: 'section', path: project.path })}><span>{tr('新建分区…')}</span></button>
        {sections.length > 0 && <div role="separator" />}
        {sections.map(section => <button key={section.id} type="button" role="menuitem" data-testid="xn-project-section-move"
          data-section-id={section.id} aria-checked={project.sectionId === section.id} disabled={project.sectionId === section.id}
          onClick={() => { onMoveProjectToSection(project.path, section.id); onClose(true); }}>
          <span>{section.label}</span>{project.sectionId === section.id && <Check size={14} className="xn-project-menu__check" />}
        </button>)}
        <div role="separator" />
        <button type="button" role="menuitem" data-testid="xn-project-section-clear" disabled={!project.sectionId}
          onClick={() => { onMoveProjectToSection(project.path, null); onClose(true); }}><span>{tr('取消分区')}</span></button>
      </div>}
    </>}
    {dialog && <ProjectDialogView key={`${dialog.kind}:${dialog.path}`} dialog={dialog} focusReturnTo={focusReturnTo}
      onDismiss={() => { setDialog(null); onClose(true); }} onRenameProject={onRenameProject}
      onCreateProjectSection={onCreateProjectSection} onArchiveProjectSessions={onArchiveProjectSessions} />}
  </>;
}
