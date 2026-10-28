import { t as tr, tf } from '../../i18n';
import React, { useEffect, useRef, useState } from "react";
import type { PendingApproval } from "../../xuenessWorkbench";
import { Button } from "../../ui/primitives";
import { approvalImpactKind, pendingBatchApprovals } from './approvalImpact';
import { displayBinding, isModKeyPressed } from '../../xuenessShortcutDisplay';
import { formatSubject } from './diffPreview';
import { ApprovalChoiceMenu } from './ApprovalChoiceMenu';
import { ApprovalRequestPreview } from './ApprovalRequestPreview';


export type ApprovalsProps = {
  pending: PendingApproval[];
  /** Resolves false when the answer did not go through (the card then offers a retry). */
  onApprove?: (pending: PendingApproval) => void | Promise<unknown>;
  onAllowProject?: (pending: PendingApproval) => void | Promise<unknown>;
  onFullAccess?: (pending: PendingApproval) => void | Promise<unknown>;
  onApproveAll?: (items: PendingApproval[]) => void | Promise<unknown>;
  /** Deny a call that waits in the running turn; the model gets the denial and goes on. */
  /** Rejects a waiting call; `feedback` (optional) is handed to the model with the denial (ZCode permission-response). */
  onReject?: (pending: PendingApproval, feedback?: string) => void | Promise<unknown>;
  /** Allows a waiting call and identical calls for the rest of this session (ZCode "允许本会话"). */
  onAllowSession?: (pending: PendingApproval) => void | Promise<unknown>;
  /** Holds the replay path (older sessions); waiting calls stay answerable while a run is busy. */
  busy?: boolean;
};


function approvalOperationLabel(kind: ReturnType<typeof approvalImpactKind>): string {
  return tr(kind === 'read' ? '读取' : kind === 'write' ? '写入' : kind === 'edit' ? '修改'
    : kind === 'execute' ? '执行命令' : kind === 'network' ? '访问网络'
      : kind === 'external' ? '调用外部工具' : kind === 'plan' ? '批准计划' : '执行操作');
}


function approvalImpactDescription(kind: ReturnType<typeof approvalImpactKind>): string {
  return tr(kind === 'read' ? '读取所列目标，不会修改文件。'
    : kind === 'write' ? '向所列目标写入内容，可能创建或覆盖文件。'
      : kind === 'edit' ? '修改所列目标；请检查下面的变更预览。'
        : kind === 'execute' ? '运行所列命令；命令可能改变文件或系统状态。'
          : kind === 'network' ? '访问联网服务，并向所列目标发送查询或读取内容。'
            : kind === 'external' ? '调用所列外部工具；请核对工具名称与目标。'
              : '按所列操作类型处理目标；请检查目标和详细预览。');
}


function approvalTarget(pending: PendingApproval): string {
  return pending.subject ? formatSubject(pending.kind ?? pending.name, pending.subject) : tr('未提供目标');
}


export type ApprovalsKeyAction =
  | { type: "approve-item"; index: number; item: PendingApproval }
  | { type: "approve-all" }
  | { type: "approve-active"; index: number; item: PendingApproval }
  | { type: "next" }
  | { type: "prev" }
  | null;


export function evaluateApprovalsKeyDown(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    nativeEvent?: { isComposing?: boolean };
    target?: unknown;
    preventDefault?: () => void;
  },
  options: {
    pending: PendingApproval[];
    activeIndex: number;
    platform?: string;
  },
): ApprovalsKeyAction {
  if (event.nativeEvent?.isComposing) return null;
  const targetEl = event.target as { closest?: (selector: string) => unknown } | null;
  if (targetEl && typeof targetEl.closest === "function") {
    if (targetEl.closest("input, textarea, select, button, a")) {
      return null;
    }
  }

  const isPlainKey = !event.ctrlKey && !event.metaKey && !event.altKey;

  // Number keys 1..9: directly approve corresponding pending item (no modifier keys)
  if (isPlainKey && /^[1-9]$/.test(event.key)) {
    const idx = Number(event.key) - 1;
    if (idx < options.pending.length) {
      const item = options.pending[idx];
      return item ? { type: "approve-item", index: idx, item } : null;
    }
  }

  // A or Mod+Enter: batch approve
  const isBatchKey =
    (isPlainKey && (event.key === "a" || event.key === "A")) ||
    (event.key === "Enter" && isModKeyPressed(event, options.platform));
  if (isBatchKey && options.pending.length > 1) {
    return { type: "approve-all" };
  }

  // Arrow navigation
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    return { type: "next" };
  }
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    return { type: "prev" };
  }

  // Enter on active item (plain Enter only, non-button target)
  if (event.key === "Enter" && isPlainKey) {
    const item = options.pending[options.activeIndex];
    return item ? { type: "approve-active", index: options.activeIndex, item } : null;
  }

  return null;
}


export function Approvals({ pending, onApprove, onApproveAll, onReject, onAllowSession, onAllowProject, onFullAccess, busy = false }: ApprovalsProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // ZCode PermissionDialog: an answer in flight disables that card; a failed one says so.
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const blocked = (p: PendingApproval) => responding.has(p.tool_call_id) || (!p.waiting && busy);
  const respond = async (items: PendingApproval[], action: () => void | Promise<unknown>) => {
    const ids = items.map(p => p.tool_call_id);
    setResponding(previous => new Set([...previous, ...ids]));
    setFailed(previous => new Set([...previous].filter(id => !ids.includes(id))));
    let outcome: unknown;
    try { outcome = await action(); } catch { outcome = false; }
    finally { setResponding(previous => new Set([...previous].filter(id => !ids.includes(id)))); }
    if (outcome === false) setFailed(previous => new Set([...previous, ...ids]));
  };
  const approveOne = (p: PendingApproval) => { if (onApprove && !blocked(p)) void respond([p], () => onApprove(p)); };
  const rejectOne = (p: PendingApproval, note = "") => {
    if (!onReject || blocked(p)) return;
    void respond([p], () => note ? onReject(p, note) : onReject(p));
  };
  const allowSessionOne = (p: PendingApproval) => { if (onAllowSession && p.waiting && !p.oneShot && !blocked(p)) void respond([p], () => onAllowSession(p)); };

  useEffect(() => {
    if (focusedIndex >= 0 && containerRef.current) {
      const el = containerRef.current.querySelector<HTMLElement>('[data-focused="true"]');
      el?.scrollIntoView?.({ block: "nearest" });
    }
  }, [focusedIndex]);

  if (!pending || pending.length === 0) {
    return (
      <div data-testid="approvals-empty" className="xn-empty-state-note">{tr("无待审批")}</div>
    );
  }

  const activeIndex = Math.min(Math.max(0, focusedIndex), pending.length - 1);
  const allGranted = pending.every(p => p.granted);
  const ungranted = pendingBatchApprovals(pending);

  const liveBatch = ungranted.length > 0 && ungranted.every(p => p.waiting);
  const batchBlocked = allGranted || (liveBatch ? ungranted.some(p => responding.has(p.tool_call_id)) : busy);
  const handleBatchApprove = async () => {
    if (batchBlocked) return;
    // Keep the callback's actual scope identical to the visible ungranted list.
    const remaining = pendingBatchApprovals(pending);
    await respond(remaining, async () => {
      if (onApproveAll) return onApproveAll(remaining);
      let outcome: unknown = true;
      if (onApprove) for (const p of remaining) if (await onApprove(p) === false) outcome = false;
      return outcome;
    });
  };


  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); containerRef.current?.querySelector<HTMLButtonElement>('[role="radio"]:not(:disabled)')?.focus(); }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={tr("待审批操作")}
      onKeyDown={handleKeyDown}
      className="xn-approvals"
    >
      <div className="xn-approvals__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="xn-approvals__title" style={{ fontWeight: 600, fontSize: 13, color: "var(--fg-muted)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>{pending.length === 1 ? tr("需要权限") : `${tr("需要审批的操作 (")}${pending.length})`}</span>
        </div>
        {pending.length > 1 && (onApproveAll || onApprove) && (
          <div className="xn-approvals__batch-actions" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={batchBlocked}
              onClick={() => void handleBatchApprove()}
              data-testid="approvals-batch-button"
            >
              {allGranted ? tr("全部已批准") : liveBatch ? tf("全部允许 ({0})", [ungranted.length]) : busy ? tr("正在继续…") : tf("全部批准 ({0})", [ungranted.length])}
            </Button>
          </div>
        )}
      </div>

      {pending.length > 1 && !allGranted && (
        <div className="xn-approvals__scope" role="note" aria-label={tr('本次批量批准范围')} data-testid="approvals-batch-scope"
          style={{ padding: '8px 10px', border: '1px solid var(--warn-border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{tf('全部批准将批准以下 {0} 项：', [ungranted.length])}</p>
          <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 5 }}>
            {ungranted.map(item => {
              const kind = approvalImpactKind(item.kind, item.name);
              return <li key={item.tool_call_id}>
                <span>{approvalOperationLabel(kind)} · {approvalTarget(item)}</span>
                {kind === 'external' && item.name !== (item.kind ?? item.name) && <small> · {tf('工具：{0}', [item.name])}</small>}
                <small style={{ display: 'block', color: 'var(--fg-muted)' }}>{approvalImpactDescription(kind)}</small>
              </li>;
            })}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pending.map((p, index) => {
          const impactKind = approvalImpactKind(p.kind, p.name);
          const readableSubject = approvalTarget(p);
          const isFocused = index === activeIndex;
          return (
            <div
              key={p.tool_call_id}
              data-testid={`approval-item-${p.tool_call_id}`}
              data-focused={isFocused ? "true" : undefined}
              className="xn-approval-item"
              onClick={() => setFocusedIndex(index)}

            >
              <ApprovalRequestPreview pending={p} operation={approvalOperationLabel(impactKind)}
                impact={approvalImpactDescription(impactKind) + (impactKind === 'external' && p.name !== (p.kind ?? p.name) ? ` ${tf('工具：{0}', [p.name])}` : '')} />
              {failed.has(p.tool_call_id) && <p role="alert" className="xn-approval-error" style={{ margin: 0, color: "var(--danger-fg, var(--warn-fg))" }}>{tr("审批未完成，请重试。")}</p>}
              {onApprove && (p.granted ? <div className="xn-approval-replay"><span role="status">{tr("已批准，等待执行")}</span><Button disabled={blocked(p)} onClick={() => approveOne(p)}>{tr(busy ? "正在继续…" : "继续执行")}</Button></div> : <>
                {p.waiting && <span className="xn-approval-waiting" role="status" data-testid={`approval-waiting-${p.tool_call_id}`}>{tr("等待确认")}</span>}
                <ApprovalChoiceMenu disabled={blocked(p)} canRemember={!!p.projectRules?.length} oneShot={p.oneShot}
                  onAllow={() => approveOne(p)} onProject={onAllowProject ? () => { void respond([p], () => onAllowProject(p)); } : undefined}
                  onFullAccess={onFullAccess ? () => { void respond([p], () => onFullAccess(p)); } : undefined}
                  onReject={onReject ? note => rejectOne(p, note) : undefined} onSession={onAllowSession && p.waiting && !p.oneShot ? () => allowSessionOne(p) : undefined} />
              </>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
