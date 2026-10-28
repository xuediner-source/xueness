import { t as tr } from '../../i18n';
import React from "react";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import { IconPencil, IconPin, IconRefresh, IconTrash } from "../../ui/icons";
import { Folder, Users, ListOrdered } from 'lucide-react';
import { permissionChoices } from './permissionChoices';
import './session-header.css';



/** 时段问候（ZCode 式）：按本地时间分五档。 */
export function heroGreeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 9) return tr("早上好呀，新的一天开始啦");
  if (h >= 9 && h < 12) return tr("上午好呀，有什么想让我帮忙的吗");
  if (h >= 12 && h < 14) return tr("中午好呀，要不要先休息一下");
  if (h >= 14 && h < 18) return tr("下午好呀，接下来交给我吧");
  if (h >= 18 && h < 23) return tr("晚上好呀，今天辛苦啦");
  return tr("夜深啦，别忘了照顾好自己哦");
}


export type WorkbenchHeaderProps = {
  session?: WorkbenchSession | null;
  fallbackTitle?: string;
  groupSwitcher?: React.ReactNode;
  /** Right side: view switcher and other real controls. */
  actions?: React.ReactNode;
  navigation?: React.ReactNode;
  onOpenAgents?: () => void;
  menuItems?: React.ReactNode;
  pinned?: boolean;
  onTogglePin?: () => void;
  onRefresh?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
};


/** Conversation header. Renders nothing without a session — the hero owns that state. */
export function WorkbenchHeader({
  session,
  fallbackTitle,
  groupSwitcher,
  actions,
  navigation,
  onOpenAgents,
  menuItems,
  pinned = false,
  onTogglePin,
  onRefresh,
  onRename,
  onDelete,
}: WorkbenchHeaderProps) {
  if (!session && !fallbackTitle) {
    return null;
  }

  const title = session?.title || session?.task || fallbackTitle || tr("未命名任务");
  // Project folder name for the Codex 风格 header mark; no visual change in the default palette.
  const project = session?.root?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined;
  const hasMenuActions = Boolean(onRefresh || onTogglePin || onRename || onDelete || menuItems);

  return (
    <header
      aria-label={title}
      className={`xn-conv-header${navigation ? ' xn-session-header' : ''}`}
    >
      <h2 className="xn-conv-header__title" data-project={project}>
        {project && <Folder size={16} className="xn-conv-header__project-icon" aria-hidden="true" />}
        <span>{title}</span>
      </h2>
      {groupSwitcher}
      {navigation && session && <div className="xn-session-header__facts">
        {onOpenAgents && <button type="button" onClick={onOpenAgents}><Users size={14} aria-hidden="true" />{tr('智能体团队')}</button>}
        {permissionChoices.filter(choice => choice.value === (session.permission_mode ?? 'build')).map(({ Icon, label, value }) => <span key={value} className="xn-session-header__mode" data-permission={value}><Icon size={14} />{tr(label)}</span>)}
        <span title={tr('待处理消息')}><ListOrdered size={14} aria-hidden="true" />{session.queued_messages?.length ?? 0} {tr('队列')}</span>
      </div>}
      <div className="xn-conv-header__main">
        <div className="xn-conv-header__spacer" />
        <div className="xn-conv-header__tools">
          {actions}
          {hasMenuActions && (
            <details
              className="xn-conv-header__more"
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  event.currentTarget.removeAttribute("open");
                }
              }}
              onKeyDown={event => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.removeAttribute("open");
                event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
              }}
            >
              <summary aria-label={tr("更多操作")} title={tr("更多操作")}>⋯</summary>
              <div
                className="xn-conv-header__menu"
                onClick={event => {
                  if (!(event.target as HTMLElement).closest("button")) return;
                  const details = event.currentTarget.closest("details");
                  details?.removeAttribute("open");
                  details?.querySelector<HTMLElement>("summary")?.focus();
                }}
              >
                {onRefresh && (
                  <button type="button" className="xn-conv-header__action" aria-label={tr("刷新历史")} title={tr("刷新")} onClick={onRefresh}>
                    <IconRefresh size={14} />
                    <span>{tr("刷新历史")}</span>
                  </button>
                )}
                {onTogglePin && (
                  <button
                    type="button"
                    className={`xn-conv-header__action ${pinned ? "xn-conv-header__action--pinned" : ""}`}
                    aria-label={pinned ? tr("取消置顶") : tr("置顶任务")}
                    aria-pressed={pinned}
                    title={pinned ? tr("取消置顶") : tr("置顶")}
                    data-testid="xn-conv-pin"
                    onClick={onTogglePin}
                  >
                    <IconPin size={14} />
                    <span>{pinned ? tr("取消置顶") : tr("置顶任务")}</span>
                  </button>
                )}
                {onRename && (
                  <button type="button" className="xn-conv-header__action" aria-label={tr("重命名任务")} title={tr("重命名")} onClick={onRename}>
                    <IconPencil size={14} />
                    <span>{tr("重命名任务")}</span>
                  </button>
                )}
                {menuItems}
                {onDelete && (
                  <button type="button" className="xn-conv-header__action xn-conv-header__action--danger" aria-label={tr("删除任务")} title={tr("删除")} onClick={onDelete}>
                    <IconTrash size={14} />
                    <span>{tr("删除任务")}</span>
                  </button>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
      {navigation && <div className="xn-session-header__navigation">{navigation}</div>}
    </header>
  );
}
