import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpFromLine, ChevronDown, CornerUpLeft, GripVertical, Pencil } from "lucide-react";
import './CurrentTurnInput';
import { t as tr, tf } from "../../i18n";
import type { QueuedMessage } from "../../xuenessWorkbench";

function statusLabel(status: QueuedMessage["status"]): string {
  switch (status) {
    case "queued": return tr("已排队");
    case "running": return tr("运行中");
    case "paused": return tr("已暂停");
    case "completed": return tr("已完成");
    case "needs_review": return tr("未通过验证");
    case "failed": return tr("失败");
    case "cancelled": return tr("已取消");
  }
}

export function SessionQueue({ items, cancellingId, currentId, onCancel, canContinue = false, continuing = false, onContinue, onEdit, onWithdraw, onSendNow, onReorder, disabled = false }: {
  items: QueuedMessage[];
  cancellingId?: string | null;
  currentId?: string | null;
  onCancel: (id: string) => void;
  canContinue?: boolean;
  continuing?: boolean;
  onContinue?: () => void;
  onEdit?: (id: string, text: string, expectedText: string) => Promise<void>;
  onWithdraw?: (id: string) => Promise<void>;
  onSendNow?: (id: string) => Promise<void>;
  onReorder?: (ids: string[], expectedIds: string[]) => Promise<void>;
  disabled?: boolean;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string; original: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reordering, setReordering] = useState(false);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; expected: string[] } | null>(null);
  const [orderStatus, setOrderStatus] = useState('');
  const mounted = useRef(true);
  const listId = `xn-queue-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isReserved = (item: QueuedMessage) => ['reserved', 'claimed'].includes((item as QueuedMessage & { promotion?: { state?: string } }).promotion?.state ?? '');
  const pendingIds = items.filter(item => item.id !== currentId && ['queued', 'paused'].includes(item.status)).map(item => item.id);
  const mutationDisabled = disabled || saving || reordering || Boolean(cancellingId) || continuing || Boolean(dispatchingId)
    || Boolean(editing) || items.some(isReserved);
  const dispatchItem = async (id: string, action?: (id: string) => Promise<void>) => {
    if (!action || mutationDisabled || !pendingIds.includes(id)) return;
    setDispatchingId(id); setError('');
    try { await action(id); }
    catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setDispatchingId(null); }
  };
  const dropItem = async (target: string) => {
    const drag = dragRef.current; dragRef.current = null;
    if (!drag || !onReorder || mutationDisabled || drag.id === target || !pendingIds.includes(target)) return;
    const ids = drag.expected.filter(id => id !== drag.id);
    ids.splice(ids.indexOf(target), 0, drag.id);
    setReordering(true); setError('');
    try { await onReorder(ids, drag.expected); }
    catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setReordering(false); }
  };
  const move = async (id: string, offset: number) => {
    const index = pendingIds.indexOf(id), destination = index + offset;
    if (!onReorder || mutationDisabled || index < 0 || destination < 0 || destination >= pendingIds.length) return;
    const ids = [...pendingIds]; [ids[index], ids[destination]] = [ids[destination], ids[index]];
    setReordering(true); setError(''); setOrderStatus('');
    try {
      await onReorder(ids, pendingIds);
      if (mounted.current) setOrderStatus(tf('已移至队列位置 {0}', [destination + 1]));
    } catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (mounted.current) setReordering(false); }
  };
  const submitEdit = async () => {
    if (!editing || !onEdit || saving || disabled || !editing.draft.trim() || Array.from(editing.draft.trim()).length > 5000) return;
    setSaving(true); setError("");
    try {
      await onEdit(editing.id, editing.draft, editing.original);
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
      {items.map(item => <li key={item.id} className="xn-session-queue__item" data-status={item.status}
        onDragOver={event => { if (dragRef.current && !mutationDisabled && pendingIds.includes(item.id)) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); void dropItem(item.id); }}>
        {onReorder && pendingIds.length > 1 && pendingIds.includes(item.id) && <span className="xn-session-queue__drag"
          aria-label={tr('调整队列顺序')} title={tr('调整队列顺序')} draggable={!mutationDisabled}
          onDragStart={event => { if (mutationDisabled) { event.preventDefault(); return; }
            dragRef.current = { id: item.id, expected: [...pendingIds] }; event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => { dragRef.current = null; }}><GripVertical size={13} aria-hidden="true" /></span>}
        <div className="xn-session-queue__copy">
          {typeof item.position === "number" && <span className="xn-session-queue__position">{tf("队列位置 {0}", [item.position])}</span>}
          {item.text.length > 120 || item.text.includes('\n') ? <details className="xn-session-queue__preview">
            <summary aria-label={tr('查看完整排队消息')}><p>{item.text}</p><span>{tr('查看完整消息')}</span></summary>
            <pre tabIndex={0}>{item.text}</pre>
          </details> : <p>{item.text}</p>}
          {item.status === "paused" && item.pause_reason && <small className="xn-session-queue__pause-reason">{tf("暂停原因：{0}", [item.pause_reason])}</small>}
        </div>
        <span className="xn-session-queue__status" data-status={item.status}>{statusLabel(item.status)}</span>
        {onReorder && pendingIds.length > 1 && pendingIds.includes(item.id) && <span className="xn-session-queue__reorder" aria-label={tr('调整队列顺序')}>
          <button type="button" aria-label={tr('上移排队消息')} title={tr('上移排队消息')} disabled={mutationDisabled || pendingIds[0] === item.id}
            onClick={() => void move(item.id, -1)}><ArrowUp size={13} aria-hidden="true" /></button>
          <button type="button" aria-label={tr('下移排队消息')} title={tr('下移排队消息')} disabled={mutationDisabled || pendingIds.at(-1) === item.id}
            onClick={() => void move(item.id, 1)}><ArrowDown size={13} aria-hidden="true" /></button>
        </span>}
        {onSendNow && pendingIds.includes(item.id) && <button type="button" className="xn-session-queue__send-now"
          aria-label={tr('立即发送')} title={tr('立即发送')} disabled={mutationDisabled}
          onClick={() => void dispatchItem(item.id, onSendNow)}><ArrowUpFromLine size={13} aria-hidden="true" /></button>}
        {onEdit && item.id !== currentId && item.editable !== false && pendingIds.includes(item.id) && <button type="button" className="xn-session-queue__edit"
          aria-label={tr("编辑排队消息")} title={tr("编辑排队消息")} disabled={mutationDisabled}
          onClick={() => { setEditing({ id: item.id, draft: item.text, original: item.text }); setError(""); }}><Pencil size={13} aria-hidden="true" /></button>}
        {onWithdraw && pendingIds.includes(item.id) && <button type="button" className="xn-session-queue__edit"
          aria-label={tr('撤回到输入框')} title={tr('撤回到输入框')} disabled={mutationDisabled}
          onClick={() => void dispatchItem(item.id, onWithdraw)}><CornerUpLeft size={13} aria-hidden="true" /></button>}
        {item.id !== currentId && (item.status === "queued" || item.status === "paused") && <button type="button" className="xn-session-queue__cancel"
          aria-label={tr("取消排队")} title={tr("取消排队")} disabled={mutationDisabled}
          onClick={() => onCancel(item.id)}>{tr(cancellingId === item.id ? "正在取消…" : "取消排队")}</button>}
        {editing?.id === item.id && <div className="xn-session-queue__editor">
          <label htmlFor={`${listId}-edit`}>{tr("编辑排队消息")}</label>
          <textarea id={`${listId}-edit`} autoFocus rows={3} value={editing.draft} disabled={disabled || saving} maxLength={10000}
            onChange={event => setEditing({ ...editing, draft: event.currentTarget.value })} />
          <small>{tr("已有附件与上下文会保留。")}</small>
          <div><button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={saving} onClick={() => { setEditing(null); setError(""); }}>{tr("取消")}</button>
            <button type="button" className="xn-btn xn-btn--primary xn-btn--sm" disabled={disabled || saving || !editing.draft.trim() || Array.from(editing.draft.trim()).length > 5000 || !["queued", "paused"].includes(item.status)} onClick={() => void submitEdit()}>{tr(saving ? "正在保存…" : "保存")}</button></div>
        </div>}
      </li>)}
    </ol>
    {error && <p className="xn-session-queue__notice" role="alert">{error}</p>}
    {orderStatus && <p className="xn-session-queue__notice" role="status">{orderStatus}</p>}
  </section>;
}
