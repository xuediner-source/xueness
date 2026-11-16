import React, { useCallback, useEffect, useRef, useState } from "react";
import { Moon, X } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { ago, applyDream, discardDream, kindLabel, listDreams, loadDream, startDream, type OceanDream, type OceanDreamOp } from "./oceanApi";

const POLL_MS = 2000;
const message = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);
const opLabel = (op: OceanDreamOp["op"]): string => op === "merge" ? tr("合并") : op === "update" ? tr("更新") : op === "archive" ? tr("归档") : tr("新增");

/**
 * Memory dreaming: the model rereads this workspace's recent conversations
 * next to the saved memories and proposes merges, corrections, archives and
 * additions. The drawer starts a dream, waits for it, and shows the proposal
 * for review; only the operations left ticked are applied.
 */
export function MemoryOceanDreamDrawer({ workspaceRoot, onClose, onApplied }: { workspaceRoot?: string; onClose(): void; onApplied(): void }): React.JSX.Element {
  const [dream, setDream] = useState<OceanDream | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownFor = useRef("");

  const show = useCallback((next: OceanDream | null): void => {
    setDream(next);
    // A proposal starts with everything ticked, once; later refreshes keep the reviewer's choices.
    if (next?.status === "ready" && shownFor.current !== next.id) { shownFor.current = next.id; setAccepted(new Set(next.operations.map((_, index) => index))); }
  }, []);

  useEffect(() => {
    if (!workspaceRoot) { setLoaded(true); return; }
    const controller = new AbortController();
    listDreams(workspaceRoot, controller.signal).then((reply) => { show(reply.dreams.find((item) => item.status === "running" || item.status === "ready") ?? reply.dreams[0] ?? null); setLoaded(true); })
      .catch((failure) => { if (!controller.signal.aborted) { setError(message(failure)); setLoaded(true); } });
    return () => controller.abort();
  }, [workspaceRoot, show]);

  const running = dream?.status === "running", dreamId = dream?.id;
  useEffect(() => {
    if (!running || !dreamId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { loadDream(dreamId, controller.signal).then((reply) => show(reply.dream)).catch(() => undefined); }, POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [running, dreamId, show]);

  const act = async (work: () => Promise<{ dream: OceanDream }>, after?: () => void): Promise<void> => {
    setBusy(true); setError("");
    try { show((await work()).dream); after?.(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const toggle = (index: number): void => setAccepted((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  const ready = dream?.status === "ready", settled = dream && !running && !ready;

  return <aside className="xn-ocean-drawer xn-ocean-drawer--tracks xn-ocean-dream" aria-label={tr("记忆整理")}>
    <header><Moon size={15} aria-hidden="true" /><h3>{tr("记忆整理")}</h3><button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={onClose}><X size={16} aria-hidden="true" /></button></header>
    <p className="xn-ocean-dream__lead">{tr("让模型重读这个项目最近的几次对话和已有记忆，提出合并、更正、归档和补充的建议。建议要经你确认才会生效。")}</p>
    {error && <p className="xn-ocean-dialog__error" role="alert">{error}</p>}
    {!workspaceRoot && <p className="xn-ocean-detail__note">{tr("先打开一个项目，再整理它的记忆。")}</p>}

    {running && <p className="xn-ocean-dream__status" role="status">{tf("正在重读 {0} 次对话和 {1} 段记忆……", [dream.sourceSessionIds.length, dream.memoriesRead])}</p>}

    {ready && dream.operations.length === 0 && <p className="xn-ocean-dream__status">{tr("这次没有需要调整的地方。")}</p>}
    {ready && dream.operations.length > 0 && <ul className="xn-ocean-dream__ops">
      {dream.operations.map((operation, index) => <DreamOperation key={index} operation={operation} checked={accepted.has(index)} disabled={busy} onToggle={() => toggle(index)} />)}
    </ul>}

    {settled && dream.status === "applied" && <ul className="xn-ocean-dream__ops">
      {dream.operations.map((operation, index) => <DreamOperation key={index} operation={operation} />)}
    </ul>}
    {settled && dream.status === "failed" && <p className="xn-ocean-dialog__error">{tf("上次整理没有完成：{0}", [dream.error ?? ""])}</p>}

    <footer className="xn-ocean-dream__actions">
      {running && <button type="button" className="xn-ocean-button" disabled={busy} onClick={() => void act(() => discardDream(dream.id))}>{tr("取消")}</button>}
      {ready && <>
        <span className="xn-ocean-drawer__count">{tf("已选 {0} / {1}", [accepted.size, dream.operations.length])}</span>
        <button type="button" className="xn-ocean-button" disabled={busy} onClick={() => void act(() => discardDream(dream.id))}>{tr("放弃这次建议")}</button>
        <button type="button" className="xn-ocean-button xn-ocean-button--primary" disabled={busy || accepted.size === 0}
          onClick={() => void act(() => applyDream(dream.id, [...accepted].sort((a, b) => a - b)), onApplied)}>{tr("应用所选")}</button>
      </>}
      {loaded && !running && !ready && <>
        {dream && <span className="xn-ocean-drawer__count">{tf("上次整理：{0}", [ago(dream.createdAt)])}</span>}
        <button type="button" className="xn-ocean-button xn-ocean-button--primary" disabled={busy || !workspaceRoot}
          title={tr("会把最近对话的文字和已有记忆发给当前模型")} onClick={() => workspaceRoot && void act(() => startDream(workspaceRoot))}><Moon size={14} aria-hidden="true" />{tr("开始整理")}</button>
      </>}
    </footer>
  </aside>;
}

function DreamOperation({ operation, checked, disabled, onToggle }: { operation: OceanDreamOp; checked?: boolean; disabled?: boolean; onToggle?: () => void }): React.JSX.Element {
  return <li data-op={operation.op} data-outcome={operation.outcome}>
    <label className="xn-ocean-dream__head">
      {onToggle && <input type="checkbox" checked={!!checked} disabled={disabled} onChange={onToggle} />}
      <span className="xn-ocean-chip">{opLabel(operation.op)}</span>
      {operation.draft && <span className="xn-ocean-chip xn-ocean-chip--muted">{kindLabel(operation.draft.kind)}</span>}
      {operation.outcome && <span className="xn-ocean-dream__outcome">{operation.outcome === "applied" ? tr("已应用") : tr("已跳过")}</span>}
    </label>
    {operation.before.map((memory) => <p key={memory.id} className="xn-ocean-dream__before">{memory.text}</p>)}
    {operation.draft && <p className="xn-ocean-dream__after">{operation.draft.text}</p>}
    <small>{operation.note ?? operation.reason}</small>
  </li>;
}
