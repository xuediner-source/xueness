import React from "react";
import { AlertTriangle, GitBranch, LoaderCircle, RefreshCw, X } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { forkSession, loadForkBoundaries } from "../../xuenessWorkbench";
import type { ForkBoundary, ForkSessionResponse } from "../../xuenessWorkbench";
import "./sessions.css";

export type ForkSessionDialogProps = {
  open: boolean;
  sourceId: string;
  sourceTitle: string;
  initialTurn?: number;
  onCancel: () => void;
  onFork: (result: ForkSessionResponse) => void;
};

function historyNote(reason: string | null): string {
  return reason
    ? tf("部分较早历史不可用（{0}）；压缩归档与摘要不会继承，仅保留当前可定位历史。", [reason])
    : tr("较早的压缩归档与摘要不会继承，仅保留当前可定位历史；分叉位置只包含服务端确认完整的用户轮次。");
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function shouldDismissForkDialogOnEscape(
  event: { key: string; isComposing?: boolean; keyCode?: number },
  busy = false,
): boolean {
  if (event.key !== "Escape" || busy) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}

export function trapForkDialogTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  activeElement: unknown,
  items: { focus: () => void }[],
  fallbackTarget?: { focus?: () => void } | null,
): boolean {
  if (event.key !== "Tab") return false;
  if (!items.length) {
    event.preventDefault();
    fallbackTarget?.focus?.();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const activeIndex = items.indexOf(activeElement as { focus: () => void });
  if (activeIndex < 0) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  } else if (event.shiftKey && activeIndex === 0) {
    event.preventDefault();
    last.focus();
    return true;
  } else if (!event.shiftKey && activeIndex === items.length - 1) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function ForkBoundaryChoices({ boundaries, selectedToken, busy = false, onSelect }: {
  boundaries: ForkBoundary[];
  selectedToken: string;
  busy?: boolean;
  onSelect: (token: string) => void;
}): React.JSX.Element {
  return <div className="xn-session-fork__options" role="radiogroup" aria-label={tr("分叉位置")}>
    {boundaries.map(boundary => <button key={boundary.token} type="button" role="radio" aria-checked={selectedToken === boundary.token} className="xn-session-fork__boundary" data-selected={selectedToken === boundary.token} disabled={busy} onClick={() => onSelect(boundary.token)}>
      <span className="xn-session-fork__radio" aria-hidden="true" />
      <span className="xn-session-fork__boundary-copy"><strong>{tf("第 {0} 轮结束", [boundary.turn])}</strong><span>{boundary.preview}</span></span>
    </button>)}
  </div>;
}

/** Fork choices are opaque server-issued selectors. The dialog never derives an index from rendered timeline rows. */
export function ForkSessionDialog({ open, sourceId, sourceTitle, initialTurn, onCancel, onFork }: ForkSessionDialogProps): React.JSX.Element | null {
  const [boundaries, setBoundaries] = React.useState<ForkBoundary[]>([]);
  const [revision, setRevision] = React.useState("");
  const [historyTruncated, setHistoryTruncated] = React.useState(false);
  const [truncationReason, setTruncationReason] = React.useState<string | null>(null);
  const [hasUnclosedTurn, setHasUnclosedTurn] = React.useState(false);
  const [selectedToken, setSelectedToken] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [requestMessage, setRequestMessage] = React.useState("");
  const requestNumber = React.useRef(0);
  const dialogRef = React.useRef<HTMLElement | null>(null);
  const selected = boundaries.find(boundary => boundary.token === selectedToken) ?? null;
  const titleValue = title.trim();
  const titleValid = Array.from(titleValue).length <= 120 && !/[\x00-\x1f\x7f]/u.test(titleValue);
  const canFork = Boolean(selected && revision && !loading && !busy && titleValid);

  const refresh = React.useCallback(async () => {
    const current = ++requestNumber.current;
    setLoading(true);
    setError("");
    setRequestMessage("");
    setSelectedToken("");
    const result = await loadForkBoundaries(sourceId);
    if (requestNumber.current !== current) return;
    if (result.ok) {
      setBoundaries(result.value.boundaries);
      setRevision(result.value.revision);
      setHistoryTruncated(result.value.historyTruncated);
      setTruncationReason(result.value.truncationReason);
      setHasUnclosedTurn(result.value.hasUnclosedTurn);
      if (initialTurn !== undefined) setSelectedToken(result.value.boundaries.find(boundary => boundary.turn === initialTurn)?.token ?? '');
    } else {
      setBoundaries([]);
      setRevision("");
      setHistoryTruncated(false);
      setTruncationReason(null);
      setHasUnclosedTurn(false);
      setError(result.error);
    }
    setLoading(false);
  }, [sourceId, initialTurn]);

  React.useEffect(() => {
    if (!open) return;
    setTitle(`Fork: ${sourceTitle}`.slice(0, 120));
    void refresh();
    return () => { requestNumber.current += 1; };
  }, [open, sourceTitle, refresh]);

  React.useEffect(() => {
    if (!open || busy) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissForkDialogOnEscape(event, busy)) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, onCancel]);

  React.useEffect(() => {
    if (!open) return;
    const keepFocusInside = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        const target = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
        target?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const allItems = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => item.getAttribute("aria-hidden") !== "true");
    const visibleItems = allItems.filter((item) => item.getClientRects().length > 0);
    const items = visibleItems.length > 0 ? visibleItems : allItems;
    trapForkDialogTab(event, document.activeElement, items, dialog);
  };

  const submit = async () => {
    if (!selected || !revision || !titleValid || busy) return;
    const sourceAtSubmit = sourceId;
    setBusy(true);
    setError("");
    setRequestMessage("");
    const result = await forkSession(sourceAtSubmit, selected.token, revision, titleValue || undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.value.sourceId !== sourceAtSubmit) {
      setError(tr("服务端返回的源会话与当前选择不一致，请重新加载边界。"));
      return;
    }
    setRequestMessage(tf("已从第 {0} 轮创建分叉会话。", [result.value.boundary.turn]));
    onFork(result.value);
  };

  return <div className="xn-session-fork__backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section ref={dialogRef} tabIndex={-1} onKeyDown={handleKeyDown} className="xn-session-fork" role="dialog" aria-modal="true" aria-labelledby="xn-session-fork-title" data-testid="fork-session-dialog">
      <header className="xn-session-fork__header">
        <div className="xn-session-fork__heading-icon"><GitBranch size={18} aria-hidden="true" /></div>
        <div><h2 id="xn-session-fork-title">{tr("分叉会话")}</h2><p>{tf("从“{0}”的完整历史轮次创建新会话", [sourceTitle])}</p></div>
        <button type="button" className="xn-session-fork__close" aria-label={tr("关闭")} disabled={busy} onClick={onCancel}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="xn-session-fork__body">
        {historyTruncated && <div className="xn-session-fork__warning" role="status"><AlertTriangle size={16} aria-hidden="true" /><span>{historyNote(truncationReason)}</span></div>}
        {hasUnclosedTurn && <div className="xn-session-fork__warning" role="status"><AlertTriangle size={16} aria-hidden="true" /><span>{tr("源会话末尾有未完成轮次；分叉列表只包含闭合轮次。")}</span></div>}
        <p className="xn-session-fork__source">{tf("源会话 ID：{0}", [sourceId])}</p>
        <div className="xn-session-fork__boundaries">
          <div className="xn-session-fork__list-heading"><h3>{tr("分叉位置")}</h3><button type="button" disabled={loading || busy} onClick={() => void refresh()} aria-label={tr("重新加载分叉边界")} title={tr("重新加载分叉边界")}><RefreshCw size={14} className={loading ? "xn-session-fork__spin" : undefined} aria-hidden="true" /></button></div>
          {loading && <p role="status" className="xn-session-fork__state"><LoaderCircle size={15} className="xn-session-fork__spin" aria-hidden="true" />{tr("正在读取服务端安全边界…")}</p>}
          {error && <p role="alert" className="xn-session-fork__error">{error}</p>}
          {!loading && !error && boundaries.length === 0 && <p className="xn-session-fork__state" role="status">{tr("没有可用的完整轮次边界。")}</p>}
          {!loading && boundaries.length > 0 && <ForkBoundaryChoices boundaries={boundaries} selectedToken={selectedToken} busy={busy} onSelect={setSelectedToken} />}
        </div>
        <label className="xn-session-fork__title-field"><span>{tr("新会话标题（可选）")}</span><input maxLength={120} value={title} disabled={busy} onChange={event => setTitle(event.currentTarget.value)} aria-label={tr("新会话标题（可选）")} />{!titleValid && <small role="alert">{tr("标题最多 120 个可见字符，不能包含控制字符。")}</small>}</label>
        <p className="xn-session-fork__note">{tr("新会话会保留所选轮次之前的对话历史；待审批操作与旧会话的审批状态不会复制。创建分叉不会自动调用模型或工具。")}</p>
      </div>
      <footer className="xn-session-fork__footer">
        <button type="button" className="xn-session-fork__button" disabled={busy} onClick={onCancel}>{tr("取消")}</button>
        <button type="button" className="xn-session-fork__button xn-session-fork__button--primary" disabled={!canFork} onClick={() => void submit()}>{busy ? <><LoaderCircle size={14} className="xn-session-fork__spin" aria-hidden="true" />{tr("正在创建分叉")}</> : <><GitBranch size={14} aria-hidden="true" />{tr("创建分叉会话")}</>}</button>
      </footer>
      {requestMessage && <p role="status" className="xn-session-fork__sr-status">{requestMessage}</p>}
    </section>
  </div>;
}
