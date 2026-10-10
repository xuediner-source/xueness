import React, { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
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

export function SessionQueue({ items, cancellingId, onCancel, canContinue = false, continuing = false, onContinue, onEdit, disabled = false }: {
  items: QueuedMessage[];
  cancellingId?: string | null;
  onCancel: (id: string) => void;
  canContinue?: boolean;
  continuing?: boolean;
  onContinue?: () => void;
  onEdit?: (id: string, text: string, expectedText: string) => Promise<void>;
  disabled?: boolean;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string; original: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const listId = `xn-queue-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
      {canContinue && <button type="button" className="xn-session-queue__continue" disabled={continuing || !onContinue}
        onClick={onContinue}>{tr(continuing ? "继续中…" : "继续执行队列")}</button>}
    </header>
    <ol className="xn-session-queue__items" id={listId} hidden={collapsed}>
      {items.map(item => <li key={item.id} className="xn-session-queue__item" data-status={item.status}>
        <div className="xn-session-queue__copy">
          {typeof item.position === "number" && <span className="xn-session-queue__position">{tf("队列位置 {0}", [item.position])}</span>}
          <p>{item.text}</p>
          {item.status === "paused" && item.pause_reason && <small className="xn-session-queue__pause-reason">{tf("暂停原因：{0}", [item.pause_reason])}</small>}
        </div>
        <span className="xn-session-queue__status" data-status={item.status}>{statusLabel(item.status)}</span>
        {onEdit && item.editable !== false && (item.status === "queued" || item.status === "paused") && <button type="button" className="xn-session-queue__edit"
          aria-label={tr("编辑排队消息")} title={tr("编辑排队消息")} disabled={disabled || saving || cancellingId === item.id}
          onClick={() => { setEditing({ id: item.id, draft: item.text, original: item.text }); setError(""); }}><Pencil size={13} aria-hidden="true" /></button>}
        {(item.status === "queued" || item.status === "paused") && <button type="button" className="xn-session-queue__cancel"
          aria-label={tr("取消排队")} title={tr("取消排队")} disabled={disabled || saving || cancellingId === item.id}
          onClick={() => onCancel(item.id)}>{tr(cancellingId === item.id ? "正在取消…" : "取消排队")}</button>}
        {editing?.id === item.id && <div className="xn-session-queue__editor">
          <label htmlFor={`${listId}-edit`}>{tr("编辑排队消息")}</label>
          <textarea id={`${listId}-edit`} autoFocus rows={3} value={editing.draft} disabled={disabled || saving} maxLength={10000}
            onChange={event => setEditing({ ...editing, draft: event.currentTarget.value })} />
          <small>{tr("已有附件与上下文会保留。")}</small>
          {error && <p role="alert">{error}</p>}
          <div><button type="button" className="xn-btn xn-btn--secondary xn-btn--sm" disabled={saving} onClick={() => { setEditing(null); setError(""); }}>{tr("取消")}</button>
            <button type="button" className="xn-btn xn-btn--primary xn-btn--sm" disabled={disabled || saving || !editing.draft.trim() || Array.from(editing.draft.trim()).length > 5000 || !["queued", "paused"].includes(item.status)} onClick={() => void submitEdit()}>{tr(saving ? "正在保存…" : "保存")}</button></div>
        </div>}
      </li>)}
    </ol>
  </section>;
}
