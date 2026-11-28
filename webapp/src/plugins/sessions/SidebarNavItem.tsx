import React from "react";
import { IconLoader, IconPencil, IconPin, IconTrash, IconX } from "../../ui/icons";
import { MoreHorizontal } from 'lucide-react';
import { t as tr, tf, useLocale } from "../../i18n";
import { normalizeChangeSummary, normalizePendingInteraction, normalizeRemoteSummary, remoteSummaryLabel } from './sessionsIndex';
import type { SessionRemoteSummary } from './sessionsIndex';

// Phase words stay in a separate chunk. Unknown rows do not load it.
const RemoteConnectionStateLabel = React.lazy(() =>
  import('./sessionsRemoteConnectionState').then(module => ({ default: module.RemoteConnectionStateLabel })));

/** 状态圆点：ZCode 用小彩色圆点而非字形。 */
function StatusDot({ status }: { status?: string }): React.JSX.Element | null {
  if (status === "running" || status === "stopping") {
    return (
      <span className="xn-sidebar-status xn-sidebar-status--busy" data-status={status} aria-hidden="true">
        <IconLoader size={13} className="xn-spin" />
      </span>
    );
  }
  if (status === "failed" || status === "provider_error" || status === "error") {
    return (
      <span className="xn-sidebar-status xn-sidebar-status--error" data-status={status} aria-hidden="true">
        <IconX size={12} />
      </span>
    );
  }
  if (status === "needs_review" || status === "awaiting_user" || status === "paused" || status === "stalled") {
    return <span className="xn-sidebar-status xn-sidebar-status--warn" data-status={status} aria-hidden="true" />;
  }
  return null;
}

export type SidebarNavItemData = {
  id: string;
  label: string;
  active: boolean;
  status?: string;
  pinned?: boolean;
  timeLabel?: string;
  /** sessions-index row attention sidecar. Optional fields keep legacy rows unchanged. */
  pendingInteraction?: boolean | string;
  unread?: boolean;
  changeSummary?: { added?: number; removed?: number; files?: number } | string;
  remote?: SessionRemoteSummary;
};

export type SidebarNavProps = {
  items: SidebarNavItemData[];
  onSelect?: (id: string) => void;
  onRename?: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onDelete?: (id: string) => void;
  onMenu?: (id: string, trigger: HTMLElement) => void;
  testIdPrefix?: string;
  label?: string;
  followSelection?: boolean;
  /** 侧栏宽度（px），默认 270 */
  width?: number;
};

/** 键盘光标移动（listbox 惯例：方向键夹取边界不环绕，Home/End 跳到首尾）。 */
export function nextSidebarCursorIndex(key: string, current: number, count: number): number | null {
  if (count < 1) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  if (current < 0) return key === "ArrowDown" ? 0 : count - 1;
  return key === "ArrowDown" ? Math.min(count - 1, current + 1) : Math.max(0, current - 1);
}

type SidebarNavItemProps = {
  item: SidebarNavItemData;
  /** listbox 模式下的选项 id；非 listbox 时不使用。 */
  optionId: string;
  optionPosition: number;
  optionSetSize: number;
  listbox: boolean;
  /** 键盘光标落在该行上。 */
  cursor: boolean;
  onSelect?: (id: string) => void;
  onRename?: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onDelete?: (id: string) => void;
  onMenu?: (id: string, trigger: HTMLElement) => void;
  testIdPrefix?: string;
  /** 行被点击后回调（把焦点交回列表容器，键盘导航得以继续）。 */
  onActivated?: () => void;
};

/** 行属性按值比较：外层重渲染时 items 数组与行对象总是新身份，
 * 字段未变的行必须命中 memo 才能保证「切换选中会话不重渲染整列表」。 */
export function sidebarNavItemPropsEqual(a: SidebarNavItemProps, b: SidebarNavItemProps): boolean {
  const leftChange = typeof a.item.changeSummary === 'string' ? a.item.changeSummary : JSON.stringify(a.item.changeSummary ?? null);
  const rightChange = typeof b.item.changeSummary === 'string' ? b.item.changeSummary : JSON.stringify(b.item.changeSummary ?? null);
  return a.item.id === b.item.id
    && a.item.label === b.item.label
    && a.item.active === b.item.active
    && a.item.status === b.item.status
    && a.item.pinned === b.item.pinned
    && a.item.timeLabel === b.item.timeLabel
    && a.item.pendingInteraction === b.item.pendingInteraction
    && a.item.unread === b.item.unread
    && a.item.remote?.connectionId === b.item.remote?.connectionId
    && a.item.remote?.configuration === b.item.remote?.configuration
    && a.item.remote?.connectionState === b.item.remote?.connectionState
    && leftChange === rightChange
    && a.optionId === b.optionId
    && a.optionPosition === b.optionPosition
    && a.optionSetSize === b.optionSetSize
    && a.listbox === b.listbox
    && a.cursor === b.cursor
    && a.onSelect === b.onSelect
    && a.onRename === b.onRename
    && a.onDelete === b.onDelete
    && a.onMenu === b.onMenu
    && a.testIdPrefix === b.testIdPrefix
    && a.onActivated === b.onActivated;
}

/** Return the mounted option nearest the viewport center. */
export function nearestVisibleOptionIndex(list: HTMLElement, scroller: HTMLElement): number | null {
  const viewport = scroller.getBoundingClientRect();
  const midpoint = viewport.top + scroller.clientHeight / 2;
  let nearest: { index: number; distance: number } | null = null;
  for (const option of list.querySelectorAll<HTMLElement>("[role='option'][data-option-index]")) {
    if (option.getClientRects().length === 0) continue;
    const rect = option.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    const index = Number(option.dataset.optionIndex);
    if (!Number.isInteger(index)) continue;
    const distance = Math.abs((rect.top + rect.bottom) / 2 - midpoint);
    if (!nearest || distance < nearest.distance) nearest = { index, distance };
  }
  return nearest?.index ?? null;
}

function SidebarNavItemBase({
  item,
  optionId,
  optionPosition,
  optionSetSize,
  listbox,
  cursor,
  onSelect,
  onRename,
  onDelete,
  onMenu,
  testIdPrefix = 'xn-sidebar-item-',
  onActivated,
}: SidebarNavItemProps): React.JSX.Element {
  useLocale();
  const isCurrent = item.active;
  const normalizedPending = normalizePendingInteraction(item.pendingInteraction);
  const pendingInteraction = Boolean(normalizedPending);
  const unread = item.unread === true;
  const remote = normalizeRemoteSummary(item.remote);
  const remoteConfigTitle = remote
    ? `${remote.connectionId} · ${remote.configuration === 'configured' ? tr('远程配置已保存') : remoteSummaryLabel(remote)}`
    : '';
  const remoteBadge = remote && <span className="xn-sidebar-remote-summary" data-remote-summary={remote.configuration}
    data-connection-state={remote.connectionState}
    title={remote.connectionState === 'unknown' ? `${remoteConfigTitle} · ${tr('连接状态未知')}` : remoteConfigTitle}>
    {remoteSummaryLabel(remote)}
    {remote.connectionState !== 'unknown' ? <React.Suspense fallback={null}><RemoteConnectionStateLabel state={remote.connectionState} /></React.Suspense> : null}
  </span>;
  const changes = normalizeChangeSummary(item.changeSummary);
  const changeSummary = typeof changes === 'string'
    ? changes
    : changes
      ? (() => {
        const added = changes.added ?? 0;
        const removed = changes.removed ?? 0;
        const files = changes.files ?? 0;
        return added > 0 || removed > 0 || files > 0
          ? [
            added > 0 ? `+${added}` : '',
            removed > 0 ? `-${removed}` : '',
            files > 0 && added === 0 && removed === 0 ? tf('{0} 个文件', [files]) : '',
          ].filter(Boolean).join(' ')
          : '';
      })()
      : '';
  const pendingLabel = typeof normalizedPending === 'string'
    ? normalizedPending
    : tr('待处理');
  return (
    <li draggable role={listbox ? "none" : undefined} className={`xn-shell-nav__item ${isCurrent ? "xn-shell-nav__item--active" : ""}`}>
      {onSelect ? (
        <button
          type="button"
          id={listbox ? optionId : undefined}
          role={listbox ? "option" : undefined}
          aria-selected={listbox ? (isCurrent ? "true" : "false") : undefined}
          aria-posinset={listbox ? optionPosition : undefined}
          aria-setsize={listbox ? optionSetSize : undefined}
          className={`xn-shell-nav__link ${isCurrent ? "xn-shell-nav__link--active" : ""}`}
          aria-current={isCurrent ? "true" : undefined}
          aria-haspopup="menu"
          aria-keyshortcuts="Shift+F10"
          data-active={isCurrent ? "true" : undefined}
          data-cursor={listbox && cursor ? "true" : undefined}
          data-option-index={listbox ? optionPosition - 1 : undefined}
          data-testid={`${testIdPrefix}${item.id}`}
          data-session-id={item.id}
          title={item.label}
          tabIndex={listbox ? -1 : undefined}
          onClick={() => { onSelect(item.id); onActivated?.(); }}
          data-sidebar-navigate="true"
        >
          <span className="xn-shell-nav__leading" aria-hidden="true">
            {pendingInteraction ? <span data-pending-interaction="true" className="xn-sidebar-attention xn-sidebar-attention--pending">!</span> : unread ? <span data-unread-indicator="true" className="xn-sidebar-attention xn-sidebar-attention--unread" /> : item.pinned ? <IconPin size={12} /> : <StatusDot status={item.status} />}
          </span>
          <span className="xn-shell-nav__label">{item.label}</span>
          {unread && <span className="xn-sidebar-unread-label">{tr('未读')}</span>}
          {pendingInteraction && <span className="xn-sidebar-attention-label" data-pending-interaction-label="true" title={pendingLabel}>{pendingLabel}</span>}
          {changeSummary && <span className="xn-sidebar-change-summary" data-change-summary="true" title={changeSummary}>{changeSummary}</span>}
          {remoteBadge}
          {item.timeLabel && <time className="xn-shell-nav__time">{item.timeLabel}</time>}
        </button>
      ) : (
        <div
          className={`xn-shell-nav__link ${isCurrent ? "xn-shell-nav__link--active" : ""}`}
          aria-current={isCurrent ? "true" : undefined}
          aria-haspopup="menu"
          aria-keyshortcuts="Shift+F10"
          data-active={isCurrent ? "true" : undefined}
          data-testid={`${testIdPrefix}${item.id}`}
          data-session-id={item.id}
          title={item.label}
        >
          <span className="xn-shell-nav__leading" aria-hidden="true">
            {pendingInteraction ? <span data-pending-interaction="true" className="xn-sidebar-attention xn-sidebar-attention--pending">!</span> : unread ? <span data-unread-indicator="true" className="xn-sidebar-attention xn-sidebar-attention--unread" /> : item.pinned ? <IconPin size={12} /> : <StatusDot status={item.status} />}
          </span>
          <span className="xn-shell-nav__label">{item.label}</span>
          {unread && <span className="xn-sidebar-unread-label">{tr('未读')}</span>}
          {pendingInteraction && <span className="xn-sidebar-attention-label" data-pending-interaction-label="true" title={pendingLabel}>{pendingLabel}</span>}
          {changeSummary && <span className="xn-sidebar-change-summary" data-change-summary="true" title={changeSummary}>{changeSummary}</span>}
          {remoteBadge}
          {item.timeLabel && <time className="xn-shell-nav__time">{item.timeLabel}</time>}
        </div>
      )}
      {(onMenu || onRename || onDelete) && (
        <span className="xn-shell-nav__item-actions">
          {onMenu && <button type="button" className="xn-shell-nav__action" aria-label={`${tr('任务操作')}: ${item.label}`}
            title={tr('任务操作')} aria-haspopup="menu" data-testid={`${testIdPrefix.replace('item-', 'menu-')}${item.id}`}
            onClick={event => onMenu(item.id, event.currentTarget)}><MoreHorizontal size={16} /></button>}
          {!onMenu && onRename && (
            <button
              type="button"
              className="xn-shell-nav__action"
              aria-label={tr("重命名任务")}
              title={tr("重命名")}
              data-testid={`xn-sidebar-rename-${item.id}`}
              onClick={(event) => onRename(item.id, event.currentTarget)}
            >
              <IconPencil size={13} />
            </button>
          )}
          {!onMenu && onDelete && (
            <button
              type="button"
              className="xn-shell-nav__action"
              aria-label={tr("删除任务")}
              title={tr("删除")}
              data-testid={`xn-sidebar-delete-${item.id}`}
              onClick={() => onDelete(item.id)}
            >
              <IconTrash size={13} />
            </button>
          )}
        </span>
      )}
    </li>
  );
}

export const SidebarNavItem = React.memo(SidebarNavItemBase, sidebarNavItemPropsEqual);
