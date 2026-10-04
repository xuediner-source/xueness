import React from "react";
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

export function SessionQueue({ items, cancellingId, onCancel, canContinue = false, continuing = false, onContinue }: {
  items: QueuedMessage[];
  cancellingId?: string | null;
  onCancel: (id: string) => void;
  canContinue?: boolean;
  continuing?: boolean;
  onContinue?: () => void;
}): React.JSX.Element | null {
  if (!items.length) return null;
  return <section className="xn-session-queue" data-testid="session-queue" aria-label={tr("排队消息")}>
    <header className="xn-session-queue__header">
      <h3>{tr("排队消息")}</h3>
      <span>{items.length}</span>
      {canContinue && <button type="button" className="xn-session-queue__continue" disabled={continuing || !onContinue}
        onClick={onContinue}>{tr(continuing ? "继续中…" : "继续执行队列")}</button>}
    </header>
    <ol className="xn-session-queue__items">
      {items.map(item => <li key={item.id} className="xn-session-queue__item" data-status={item.status}>
        <div className="xn-session-queue__copy">
          {typeof item.position === "number" && <span className="xn-session-queue__position">{tf("队列位置 {0}", [item.position])}</span>}
          <p>{item.text}</p>
          {item.status === "paused" && item.pause_reason && <small className="xn-session-queue__pause-reason">{tf("暂停原因：{0}", [item.pause_reason])}</small>}
        </div>
        <span className="xn-session-queue__status" data-status={item.status}>{statusLabel(item.status)}</span>
        {(item.status === "queued" || item.status === "paused") && <button type="button" className="xn-session-queue__cancel"
          aria-label={tr("取消排队")} title={tr("取消排队")} disabled={cancellingId === item.id}
          onClick={() => onCancel(item.id)}>{tr(cancellingId === item.id ? "正在取消…" : "取消排队")}</button>}
      </li>)}
    </ol>
  </section>;
}
