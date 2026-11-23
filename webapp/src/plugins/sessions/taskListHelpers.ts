import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { t as tr, tf } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';
import { TASK_GROUP_DRAG_MIME, type TaskGroup } from './taskListModel';

/** Native dragstart targets SidebarNav's draggable li, not its nested button. */
export function resolveSidebarDragSession(target: Pick<Element, 'closest'> | null, sessions: readonly SessionSummary[]): SessionSummary | null {
  const item = target?.closest<HTMLElement>('[data-session-id]')
    ?? target?.closest<HTMLElement>('li.xn-shell-nav__item[draggable="true"]')
      ?.querySelector<HTMLElement>('[data-sidebar-navigate="true"][data-session-id]');
  return sessions.find(session => session.id === item?.dataset.sessionId) ?? null;
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

/** Expand/collapse the visible sections without erasing another view's folds. */
export function toggleSidebarBuckets(collapsed: string[], bucketIds: string[]): string[] {
  const visible = new Set(bucketIds);
  return collapsed.some(id => visible.has(id))
    ? collapsed.filter(id => !visible.has(id))
    : [...collapsed, ...bucketIds];
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
