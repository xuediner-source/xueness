import React, { useRef } from "react";
import { IconLoader, IconPencil, IconPin, IconTrash, IconX } from "../../ui/icons";
import { t as tr } from "../../i18n";
import { useUniformListWindow } from "./ListVirtualWindow";

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

export type SidebarNavProps = {
  items: { id: string; label: string; active: boolean; status?: string; pinned?: boolean; timeLabel?: string }[];
  onSelect?: (id: string) => void;
  onRename?: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onDelete?: (id: string) => void;
  /** 侧栏宽度（px），默认 270 */
  width?: number;
};

/** 会话列表窗口化参数：行高约 33px（32px 行 + 1px 间隔），滚动后自动实测。 */
const SIDEBAR_WINDOW_PAGE_SIZE = 48;
const SIDEBAR_WINDOW_OVERSCAN_PX = 600;
const SIDEBAR_STRIDE_ESTIMATE_PX = 33;

/** 会话列表。悬停时仅在每个条目上显示重命名/删除操作（存在对应处理器时）。 */
export function SidebarNav({
  items,
  onSelect,
  onRename,
  onDelete,
  width = 270,
}: SidebarNavProps): React.JSX.Element {
  // Pinned sessions lead the list under their own group label; with nothing
  // pinned the header is omitted and the list order is exactly as given.
  const pinnedItems = items.filter((item) => item.pinned);
  const orderedItems = [...pinnedItems, ...items.filter((item) => !item.pinned)];
  const listRef = useRef<HTMLUListElement>(null);
  // 上千条会话时只挂载滚动可视区附近的行；垫片精确补齐，列表滚动总高不变。
  const { snapshot } = useUniformListWindow({
    count: orderedItems.length,
    listRef,
    findScroller: (list) => list.closest<HTMLElement>(".xn-shell-sidebar__body"),
    pageSize: SIDEBAR_WINDOW_PAGE_SIZE,
    overscanPx: SIDEBAR_WINDOW_OVERSCAN_PX,
    estimateStridePx: SIDEBAR_STRIDE_ESTIMATE_PX,
  });
  const visibleItems = snapshot.windowed ? orderedItems.slice(snapshot.start, snapshot.end) : orderedItems;
  return (
    <nav
      className="xn-shell-nav"
      style={{ width: `${width}px` }}
      data-testid="xn-sidebar-nav"
      aria-label={tr("任务导航")}
    >
      {pinnedItems.length > 0 && <div className="xn-shell-nav__group">{tr("已置顶")}</div>}
      <ul
        ref={listRef}
        className="xn-shell-nav__list"
        style={snapshot.windowed ? { paddingTop: `${snapshot.topPad}px`, paddingBottom: `${snapshot.bottomPad}px` } : undefined}
      >
        {visibleItems.map((item) => {
          const isCurrent = item.active;
          return (
            <li key={item.id} draggable className={`xn-shell-nav__item ${isCurrent ? "xn-shell-nav__item--active" : ""}`}>
              {onSelect ? (
                <button
                  type="button"
                  className={`xn-shell-nav__link ${isCurrent ? "xn-shell-nav__link--active" : ""}`}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10"
                  data-active={isCurrent ? "true" : undefined}
                  data-testid={`xn-sidebar-item-${item.id}`}
                  onClick={() => onSelect(item.id)}
                  data-sidebar-navigate="true"
                >
                  <span className="xn-shell-nav__leading" aria-hidden="true">
                    {item.pinned ? <IconPin size={12} /> : <StatusDot status={item.status} />}
                  </span>
                  <span className="xn-shell-nav__label">{item.label}</span>
                  {item.timeLabel && <time className="xn-shell-nav__time">{item.timeLabel}</time>}
                </button>
              ) : (
                <div
                  className={`xn-shell-nav__link ${isCurrent ? "xn-shell-nav__link--active" : ""}`}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10"
                  data-active={isCurrent ? "true" : undefined}
                  data-testid={`xn-sidebar-item-${item.id}`}
                >
                  <span className="xn-shell-nav__leading" aria-hidden="true">
                    {item.pinned ? <IconPin size={12} /> : <StatusDot status={item.status} />}
                  </span>
                  <span className="xn-shell-nav__label">{item.label}</span>
                  {item.timeLabel && <time className="xn-shell-nav__time">{item.timeLabel}</time>}
                </div>
              )}
              {(onRename || onDelete) && (
                <span className="xn-shell-nav__item-actions">
                  {onRename && (
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
                  {onDelete && (
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
        })}
      </ul>
    </nav>
  );
}
