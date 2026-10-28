import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpFromLine, ChevronDown, CornerDownRight, CornerUpLeft, GripVertical,
  ListOrdered, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import './SessionQueue.css';
import { t as tr, tf } from "../../i18n";
import type { QueuedMessage } from "../../xuenessWorkbench";
import { sessionStatusPresentation } from './statusPresentation';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function focusOutsideMenu(trigger: HTMLElement | null, menu: HTMLElement | null, backwards: boolean): boolean {
  if (!trigger) return false;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    'a[href], area[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex], [contenteditable="true"]',
  )).filter(element => element.tabIndex >= 0 && !menu?.contains(element)
    && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden'
    && element.getClientRects().length > 0);
  const index = candidates.indexOf(trigger);
  const next = candidates[index + (backwards ? -1 : 1)];
  if (!next) return false;
  next.focus();
  return true;
}

function statusLabel(status: QueuedMessage["status"]): string {
  return sessionStatusPresentation(status)?.label ?? tr(String(status));
}

export function SessionQueue({ items, queueRevision, cancellingId, currentId, onCancel, canContinue = false, continuing = false, onContinue, onEdit, onWithdraw, onSendNow, onReorder, disabled = false }: {
  items: QueuedMessage[];
  queueRevision?: number;
  cancellingId?: string | null;
  currentId?: string | null;
  onCancel: (id: string, expectedText: string, expectedRevision: number) => void;
  canContinue?: boolean;
  continuing?: boolean;
  onContinue?: () => void;
  onEdit?: (id: string, text: string, expectedText: string, expectedRevision: number) => Promise<void>;
  onWithdraw?: (item: QueuedMessage, expectedRevision: number) => Promise<void>;
  onSendNow?: (id: string, expectedRevision: number) => Promise<void>;
  onReorder?: (ids: string[], expectedIds: string[], expectedRevision: number) => Promise<void>;
  disabled?: boolean;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string; original: string; revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reordering, setReordering] = useState(false);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [openMoreId, setOpenMoreId] = useState<string | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [moreMenuPosition, setMoreMenuPosition] = useState<React.CSSProperties | null>(null);
  const openingKey = useRef<'first' | 'last'>('first');
  const dragRef = useRef<{ id: string; expected: string[]; revision: number } | null>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [orderStatus, setOrderStatus] = useState('');
  const mounted = useRef(true);
  const listId = `xn-queue-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  useEffect(() => setPortalReady(true), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!openMoreId) return;
    const actions = Array.from(moreMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    (openingKey.current === 'last' ? actions.at(-1) : actions[0])?.focus();
    if (!actions.length) moreMenuRef.current?.focus();
    openingKey.current = 'first';
  }, [openMoreId]);
  useIsomorphicLayoutEffect(() => {
    if (!openMoreId) {
      setMoreMenuPosition(null);
      return;
    }
    const placeMenu = () => {
      const trigger = moreButtonRefs.current.get(openMoreId);
      const menu = moreMenuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const gap = 6;
      const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
      const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight);
      const width = Math.min(menu.getBoundingClientRect().width || 240, Math.max(1, viewportWidth - margin * 2));
      const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin));
      const above = Math.max(0, rect.top - gap - margin);
      const below = Math.max(0, viewportHeight - rect.bottom - gap - margin);
      const naturalHeight = menu.scrollHeight;
      const opensUp = above >= naturalHeight || above >= below;
      const availableHeight = opensUp ? above : below;
      const height = Math.min(naturalHeight, availableHeight);
      const top = opensUp ? Math.max(margin, rect.top - gap - height)
        : Math.min(viewportHeight - margin - height, rect.bottom + gap);
      setMoreMenuPosition({ position: 'fixed', top, left, width, maxHeight: height,
        overflowY: naturalHeight > height ? 'auto' : 'visible', visibility: 'visible' });
    };
    placeMenu();
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [openMoreId, portalReady]);
  useEffect(() => {
    if (!openMoreId) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!moreButtonRefs.current.get(openMoreId)?.contains(target) && !moreMenuRef.current?.contains(target)) {
        setOpenMoreId(null);
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [openMoreId]);
  const isReserved = (item: QueuedMessage) => ['reserved', 'claimed'].includes((item as QueuedMessage & { promotion?: { state?: string } }).promotion?.state ?? '');
  const pendingIds = items.filter(item => item.id !== currentId && ['queued', 'paused'].includes(item.status)).map(item => item.id);
  const revisionAvailable = Number.isSafeInteger(queueRevision) && queueRevision! >= 0;
  const mutationDisabled = disabled || saving || reordering || Boolean(cancellingId) || continuing || Boolean(dispatchingId)
    || Boolean(editing) || items.some(isReserved);
  const dispatchItem = async (id: string, action?: (id: string) => Promise<void>) => {
    if (!action || mutationDisabled || !pendingIds.includes(id)) return;
    setDispatchingId(id); setError('');
    try { await action(id); }
    catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setDispatchingId(null); }
  };
  const closeMoreMenu = (id: string, restoreFocus = false) => {
    setOpenMoreId(null);
    if (restoreFocus) requestAnimationFrame(() => moreButtonRefs.current.get(id)?.focus());
  };
  const onMoreMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMoreMenu(id, true);
      return;
    }
    if (event.key === 'Tab') {
      closeMoreMenu(id);
      if (focusOutsideMenu(moreButtonRefs.current.get(id) ?? null, moreMenuRef.current, event.shiftKey)) event.preventDefault();
      return;
    }
    const actions = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const index = actions.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % actions.length;
    else if (event.key === 'ArrowUp') next = index < 0 ? actions.length - 1 : (index - 1 + actions.length) % actions.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = actions.length - 1;
    if (next !== undefined && actions.length) {
      event.preventDefault();
      actions[next]?.focus();
    }
  };
  const dropItem = async (target: string) => {
    const drag = dragRef.current; dragRef.current = null;
    if (!drag || !onReorder || mutationDisabled || drag.id === target || !drag.expected.includes(target) || !pendingIds.includes(target)) return;
    const ids = drag.expected.filter(id => id !== drag.id);
    ids.splice(ids.indexOf(target), 0, drag.id);
    setReordering(true); setError('');
    try { await onReorder(ids, drag.expected, drag.revision); }
    catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setReordering(false); }
  };
  const move = async (id: string, offset: number) => {
    const index = pendingIds.indexOf(id), destination = index + offset;
    if (!onReorder || !revisionAvailable || mutationDisabled || index < 0 || destination < 0 || destination >= pendingIds.length) return;
    const ids = [...pendingIds]; [ids[index], ids[destination]] = [ids[destination], ids[index]];
    setReordering(true); setError(''); setOrderStatus('');
    try {
      await onReorder(ids, pendingIds, queueRevision!);
      if (mounted.current) setOrderStatus(tf('已移至队列位置 {0}', [destination + 1]));
    } catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setReordering(false); }
  };
  const submitEdit = async () => {
    if (!editing || !onEdit || saving || disabled || !editing.draft.trim() || Array.from(editing.draft.trim()).length > 5000) return;
    setSaving(true); setError("");
    try {
      await onEdit(editing.id, editing.draft, editing.original, editing.revision);
      if (mounted.current) setEditing(null);
    } catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setSaving(false); }
  };
  if (!items.length) return null;
  return <section className="xn-session-queue" data-testid="session-queue" aria-label={tr("排队消息")}>
    <header className="xn-session-queue__header">
      <button type="button" className="xn-session-queue__toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(value => !value)}>
        <ChevronDown size={14} aria-hidden="true" /><span>{tr("排队消息")}</span><span className="xn-session-queue__count">{items.length}</span>
      </button>
      {canContinue && <button type="button" className="xn-session-queue__continue" disabled={mutationDisabled || Boolean(editing) || !onContinue}
        title={editing ? tr('请先保存或取消当前编辑。') : undefined}
        onClick={onContinue}>{tr(continuing ? "继续中…" : "继续执行队列")}</button>}
    </header>
    <ol className="xn-session-queue__items" id={listId} hidden={collapsed}>
      {items.map(item => {
        const itemId = item.id.replace(/[^a-zA-Z0-9_-]/g, '-');
        const menuId = `${listId}-more-${itemId}`;
        const hasMoreActions = Boolean(
          onWithdraw && pendingIds.includes(item.id)
          || onSendNow && pendingIds.includes(item.id)
          || onEdit && item.id !== currentId && item.editable !== false && pendingIds.includes(item.id)
          || onReorder && pendingIds.length > 1 && pendingIds.includes(item.id));
        const runMenuAction = (action: () => void) => {
          closeMoreMenu(item.id, true);
          action();
        };
        const moreMenu = <div id={menuId} ref={openMoreId === item.id ? moreMenuRef : undefined}
          className="xn-session-queue__more-menu" role="menu" aria-label={tr('排队消息操作')}
          tabIndex={-1} hidden={openMoreId !== item.id} style={moreMenuPosition ?? { visibility: 'hidden' }}
          data-testid={`session-queue-more-menu-${itemId}`}
          onKeyDown={event => onMoreMenuKeyDown(event, item.id)}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMoreMenu(item.id); }}>
          {onWithdraw && pendingIds.includes(item.id) && <button type="button" role="menuitem"
            aria-label={tr('撤回到输入框')} disabled={mutationDisabled || !revisionAvailable}
            onClick={() => runMenuAction(() => void dispatchItem(item.id, () => onWithdraw({ ...item }, queueRevision!)))}>
            <CornerUpLeft size={14} aria-hidden="true" /><span>{tr('撤回到输入框')}</span></button>}
          {onSendNow && pendingIds.includes(item.id) && <button type="button" role="menuitem"
            aria-label={tr('立即发送')} disabled={mutationDisabled || !revisionAvailable}
            onClick={() => runMenuAction(() => void dispatchItem(item.id, () => onSendNow(item.id, queueRevision!)))}>
            <ArrowUpFromLine size={14} aria-hidden="true" /><span>{tr('立即发送')}</span></button>}
          {onEdit && item.id !== currentId && item.editable !== false && pendingIds.includes(item.id) && <button type="button" role="menuitem"
            aria-label={tr('编辑排队消息')} disabled={mutationDisabled || !revisionAvailable}
            onClick={() => runMenuAction(() => { setEditing({ id: item.id, draft: item.text, original: item.text, revision: queueRevision! }); setError(''); })}>
            <Pencil size={14} aria-hidden="true" /><span>{tr('编辑排队消息')}</span></button>}
          {onReorder && pendingIds.length > 1 && pendingIds.includes(item.id) && <>
            <div className="xn-session-queue__more-separator" role="separator" />
            <button type="button" role="menuitem" aria-label={tr('上移排队消息')}
              disabled={mutationDisabled || !revisionAvailable || pendingIds[0] === item.id}
              onClick={() => runMenuAction(() => void move(item.id, -1))}>
              <ArrowUp size={14} aria-hidden="true" /><span>{tr('上移排队消息')}</span></button>
            <button type="button" role="menuitem" aria-label={tr('下移排队消息')}
              disabled={mutationDisabled || !revisionAvailable || pendingIds.at(-1) === item.id}
              onClick={() => runMenuAction(() => void move(item.id, 1))}>
              <ArrowDown size={14} aria-hidden="true" /><span>{tr('下移排队消息')}</span></button>
          </>}
        </div>;
        return <li key={item.id} className="xn-session-queue__item" data-status={item.status}
          data-testid={`session-queue-row-${itemId}`}
        onDragOver={event => { if (dragRef.current && !mutationDisabled && pendingIds.includes(item.id)) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); void dropItem(item.id); }}>
        <div className="xn-session-queue__row">
          {onReorder && pendingIds.length > 1 && pendingIds.includes(item.id) && <span className="xn-session-queue__drag"
            aria-label={tr('调整队列顺序')} title={tr('调整队列顺序')} draggable={!mutationDisabled && revisionAvailable}
            onDragStart={event => { if (mutationDisabled || !revisionAvailable) { event.preventDefault(); return; }
              dragRef.current = { id: item.id, expected: [...pendingIds], revision: queueRevision! }; event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => { dragRef.current = null; }}><GripVertical size={13} aria-hidden="true" /></span>}
          <span className="xn-session-queue__leading" aria-hidden="true"><ListOrdered size={15} /></span>
          <div className="xn-session-queue__copy">
            <div className="xn-session-queue__summary">
              {typeof item.position === "number" && <span className="xn-session-queue__position">{tf("队列位置 {0}", [item.position])}</span>}
              {item.text.length > 120 || item.text.includes('\n') ? <details className="xn-session-queue__preview">
                <summary aria-label={tr('查看完整排队消息')}><p>{item.text}</p><span>{tr('查看完整消息')}</span></summary>
                <pre tabIndex={0}>{item.text}</pre>
              </details> : <p>{item.text}</p>}
            </div>
            {item.status === "paused" && item.pause_reason && <small className="xn-session-queue__pause-reason">{tf("暂停原因：{0}", [item.pause_reason === "stopped" ? tr("任务已停止") : item.pause_reason])}</small>}
          </div>
          <span className="xn-session-queue__mode"><CornerDownRight size={13} aria-hidden="true" />{tr('排队')}</span>
          <span className="xn-session-queue__status" data-status={item.status}>{statusLabel(item.status)}</span>
          {item.id !== currentId && (item.status === "queued" || item.status === "paused") && <button type="button" className="xn-session-queue__cancel"
            aria-label={tr("取消排队")} title={tr(cancellingId === item.id ? "正在取消…" : "取消排队")}
            disabled={mutationDisabled || !revisionAvailable}
            onClick={() => onCancel(item.id, item.text, queueRevision!)}><Trash2 size={15} aria-hidden="true" /></button>}
          {hasMoreActions && <div className="xn-session-queue__more">
            <button ref={button => { if (button) moreButtonRefs.current.set(item.id, button); else moreButtonRefs.current.delete(item.id); }}
              type="button" className="xn-session-queue__more-trigger" aria-label={tr('更多排队操作')}
              title={tr('更多排队操作')} aria-haspopup="menu" aria-expanded={openMoreId === item.id}
              aria-controls={menuId} data-testid={`session-queue-more-${itemId}`}
              onClick={() => setOpenMoreId(current => current === item.id ? null : item.id)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  openingKey.current = event.key === 'ArrowDown' ? 'first' : 'last';
                  setOpenMoreId(item.id);
                }
              }}><MoreHorizontal size={16} aria-hidden="true" /></button>
            {portalReady && typeof document !== 'undefined' ? createPortal(moreMenu, document.body) : moreMenu}
          </div>}
        </div>
        {editing?.id === item.id && <div className="xn-session-queue__editor">
          <label htmlFor={`${listId}-edit`}>{tr("编辑排队消息")}</label>
          <textarea id={`${listId}-edit`} autoFocus rows={3} value={editing.draft} disabled={disabled || saving} maxLength={10000}
            onChange={event => setEditing({ ...editing, draft: event.currentTarget.value })} />
          <small>{tr("已有附件与上下文会保留。")}</small>
          <div><button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={saving} onClick={() => { setEditing(null); setError(""); }}>{tr("取消")}</button>
            <button type="button" className="xn-btn xn-btn--primary xn-btn--sm" disabled={disabled || saving || !editing.draft.trim() || Array.from(editing.draft.trim()).length > 5000 || !["queued", "paused"].includes(item.status)} onClick={() => void submitEdit()}>{tr(saving ? "正在保存…" : "保存")}</button></div>
        </div>}
      </li>;
      })}
    </ol>
    {error && <p className="xn-session-queue__notice" role="alert">{error}</p>}
    {orderStatus && <p className="xn-session-queue__notice" role="status">{orderStatus}</p>}
  </section>;
}

/** Metadata is rediscovered after reload; fetching/restoring never consumes the server escrow. */
export function QueueWithdrawalRecovery({ withdrawals, notice = '', error = '', disabled, onRefresh, onRestore, onDismiss }: {
  withdrawals: import('./queueApi').QueueWithdrawalMetadata[];
  notice?: string; error?: string; disabled: boolean;
  onRefresh: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
}): React.JSX.Element | null {
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  if (!withdrawals.length && !notice && !error) return null;
  return <section className="xn-session-queue__recovery" aria-label={tr('撤回恢复副本')}>
    <p>{tr('撤回原文在服务器保留 24 小时。恢复不会发送消息或删除副本，当前输入会保留为可恢复草稿。')}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={disabled} onClick={() => void onRefresh()}>{tr('刷新恢复副本')}</button>
    {withdrawals.map(item => <div key={item.id}>
      <p>{tr('已撤回消息')} · <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time></p>
      <p>{tr('副本到期时间')} · <time dateTime={new Date(item.expiresAt).toISOString()}>{new Date(item.expiresAt).toLocaleString()}</time></p>
      {item.hasContext && <p>{tr('原附件或上下文不会恢复，请重新添加。')}</p>}
      <button type="button" disabled={disabled} onClick={() => void onRestore(item.id)}>{tr('恢复原文到输入框')}</button>
      {confirmDismiss === item.id ? <>
        <span>{tr('删除恢复副本后将无法从此处恢复。')}</span>
        <button type="button" disabled={disabled} onClick={() => { setConfirmDismiss(null); void onDismiss(item.id); }}>{tr('确认删除副本')}</button>
        <button type="button" disabled={disabled} onClick={() => setConfirmDismiss(null)}>{tr('取消')}</button>
      </> : <button type="button" disabled={disabled} onClick={() => setConfirmDismiss(item.id)}>{tr('删除恢复副本')}</button>}
    </div>)}
  </section>;
}
