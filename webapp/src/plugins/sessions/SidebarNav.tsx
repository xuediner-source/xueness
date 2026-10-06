import React, { useCallback, useEffect, useId, useRef, useState } from "react";
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

export type SidebarNavItemData = {
  id: string;
  label: string;
  active: boolean;
  status?: string;
  pinned?: boolean;
  timeLabel?: string;
};

export type SidebarNavProps = {
  items: SidebarNavItemData[];
  onSelect?: (id: string) => void;
  onRename?: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onDelete?: (id: string) => void;
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
  listbox: boolean;
  /** 键盘光标落在该行上。 */
  cursor: boolean;
  onSelect?: (id: string) => void;
  onRename?: (id: string, returnFocusTo?: HTMLElement | null) => void;
  onDelete?: (id: string) => void;
  /** 行被点击后回调（把焦点交回列表容器，键盘导航得以继续）。 */
  onActivated?: () => void;
};

/** 行属性按值比较：外层重渲染时 items 数组与行对象总是新身份，
 * 字段未变的行必须命中 memo 才能保证「切换选中会话不重渲染整列表」。 */
export function sidebarNavItemPropsEqual(a: SidebarNavItemProps, b: SidebarNavItemProps): boolean {
  return a.item.id === b.item.id
    && a.item.label === b.item.label
    && a.item.active === b.item.active
    && a.item.status === b.item.status
    && a.item.pinned === b.item.pinned
    && a.item.timeLabel === b.item.timeLabel
    && a.optionId === b.optionId
    && a.listbox === b.listbox
    && a.cursor === b.cursor
    && a.onSelect === b.onSelect
    && a.onRename === b.onRename
    && a.onDelete === b.onDelete
    && a.onActivated === b.onActivated;
}

function SidebarNavItemBase({
  item,
  optionId,
  listbox,
  cursor,
  onSelect,
  onRename,
  onDelete,
  onActivated,
}: SidebarNavItemProps): React.JSX.Element {
  const isCurrent = item.active;
  return (
    <li draggable role={listbox ? "none" : undefined} className={`xn-shell-nav__item ${isCurrent ? "xn-shell-nav__item--active" : ""}`}>
      {onSelect ? (
        <button
          type="button"
          id={listbox ? optionId : undefined}
          role={listbox ? "option" : undefined}
          aria-selected={listbox ? (isCurrent ? "true" : "false") : undefined}
          className={`xn-shell-nav__link ${isCurrent ? "xn-shell-nav__link--active" : ""}`}
          aria-current={isCurrent ? "true" : undefined}
          aria-haspopup="menu"
          aria-keyshortcuts="Shift+F10"
          data-active={isCurrent ? "true" : undefined}
          data-cursor={listbox && cursor ? "true" : undefined}
          data-testid={`xn-sidebar-item-${item.id}`}
          tabIndex={listbox ? -1 : undefined}
          onClick={() => { onSelect(item.id); onActivated?.(); }}
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
}

const SidebarNavItem = React.memo(SidebarNavItemBase, sidebarNavItemPropsEqual);

/** 会话列表窗口化参数：行高约 33px（32px 行 + 1px 间隔），滚动后自动实测。 */
const SIDEBAR_WINDOW_PAGE_SIZE = 48;
const SIDEBAR_WINDOW_OVERSCAN_PX = 600;
const SIDEBAR_STRIDE_ESTIMATE_PX = 33;

/** 会话列表。悬停时仅在每个条目上显示重命名/删除操作（存在对应处理器时）。
 * 有 onSelect 时渲染为 listbox：↑/↓/Home/End 移动键盘光标（aria-activedescendant），
 * Enter 打开光标条目；焦点留在列表容器上，未挂载的光标行先扩大窗口再滚动。 */
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
  const listbox = Boolean(onSelect);
  const navId = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const listRef = useRef<HTMLUListElement>(null);
  const activeIndex = orderedItems.findIndex((item) => item.active);
  // 键盘光标初始停在当前选中会话上（首页内）；没有选中项时等待首次聚焦再定位。
  const [cursor, setCursor] = useState<number | null>(() =>
    activeIndex >= 0 && activeIndex < SIDEBAR_WINDOW_PAGE_SIZE ? activeIndex : null);
  const activeId = activeIndex >= 0 ? orderedItems[activeIndex]!.id : null;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  // 选中会话变化（命令面板、托盘等入口）后光标跟随到新选中行。
  // 初始光标已由 useState 定位；挂载后首次运行可能被动延迟（flush 时机），
  // 跳过它，避免把用户已经移动过的光标拉回初始选中行。
  const followReadyRef = useRef(false);
  useEffect(() => {
    if (!followReadyRef.current) {
      followReadyRef.current = true;
      return;
    }
    if (activeId === null) return;
    setCursor(activeIndexRef.current >= 0 ? activeIndexRef.current : null);
  }, [activeId]);

  // 上千条会话时只挂载滚动可视区附近的行；垫片精确补齐，列表滚动总高不变。
  // 键盘光标是虚拟的（焦点留在容器上）：移动时经 ensureIndex 同步挂载目标行
  // 并滚动到可见，不把窗口从用户的滚动位置拽走。
  const { snapshot, ensureIndex } = useUniformListWindow({
    count: orderedItems.length,
    listRef,
    findScroller: (list) => list.closest<HTMLElement>(".xn-shell-sidebar__body"),
    pageSize: SIDEBAR_WINDOW_PAGE_SIZE,
    overscanPx: SIDEBAR_WINDOW_OVERSCAN_PX,
    estimateStridePx: SIDEBAR_STRIDE_ESTIMATE_PX,
  });

  // 行处理器经 latest-ref 保持身份稳定，行 memo 不因外层重渲染而失效。
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onRenameRef = useRef(onRename);
  onRenameRef.current = onRename;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const handleSelect = useCallback((id: string) => onSelectRef.current?.(id), []);
  const handleRename = useCallback((id: string, returnFocusTo?: HTMLElement | null) => onRenameRef.current?.(id, returnFocusTo), []);
  const handleDelete = useCallback((id: string) => onDeleteRef.current?.(id), []);
  const handleActivated = useCallback(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  const optionIdAt = useCallback((index: number) => `${navId}-${orderedItems[index]?.id ?? ""}`, [navId, orderedItems]);

  const moveCursor = useCallback((index: number) => {
    setCursor(index);
    // 目标行可能尚未挂载（窗口化）：先同步扩大窗口，再滚动到可见。
    ensureIndex(index);
    document.getElementById(optionIdAt(index))?.scrollIntoView?.({ block: "nearest" });
  }, [ensureIndex, optionIdAt]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (!listbox) return;
    // Shift+F10 / ContextMenu 交给外层的条目上下文菜单处理。
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) return;
    if (event.key === "Enter") {
      if (event.target !== event.currentTarget || cursor === null) return;
      const item = orderedItems[cursor];
      if (!item) return;
      event.preventDefault();
      handleSelect(item.id);
      return;
    }
    const next = nextSidebarCursorIndex(event.key, cursor ?? -1, orderedItems.length);
    if (next === null) return;
    event.preventDefault();
    moveCursor(next);
  };

  const onFocus = () => {
    setCursor((current) => current ?? (orderedItems.length > 0 ? Math.max(0, activeIndex) : null));
  };

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
        role={listbox ? "listbox" : undefined}
        aria-label={listbox ? tr("任务列表") : undefined}
        tabIndex={listbox ? 0 : undefined}
        aria-activedescendant={listbox && cursor !== null ? optionIdAt(cursor) : undefined}
        onKeyDown={listbox ? onKeyDown : undefined}
        onFocus={listbox ? onFocus : undefined}
        style={snapshot.windowed ? { paddingTop: `${snapshot.topPad}px`, paddingBottom: `${snapshot.bottomPad}px` } : undefined}
      >
        {visibleItems.map((item, offset) => (
          <SidebarNavItem
            key={item.id}
            item={item}
            optionId={optionIdAt(snapshot.start + offset)}
            listbox={listbox}
            cursor={listbox && snapshot.start + offset === cursor}
            onSelect={listbox ? handleSelect : undefined}
            onRename={onRename ? handleRename : undefined}
            onDelete={onDelete ? handleDelete : undefined}
            onActivated={handleActivated}
          />
        ))}
      </ul>
    </nav>
  );
}
