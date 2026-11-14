import React, { useState } from "react";
import { Pencil, RotateCcw, Star, Trash2, X } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { ago, kindLabel, type OceanEdge, type OceanNode, type OceanView } from "./oceanApi";
import { kindColor, type OceanMood } from "./oceanPalette";

const RELATION: Record<OceanEdge["kind"], string> = { related: "关联", supersedes: "取代", tags: "同标签", similar: "内容相近" };

/** The card for one selected memory: what it says, where it came from, what it connects to. */
export function MemoryOceanDetail({ node, view, mood, busy, onClose, onEdit, onForget, onRestore, onSelect }: {
  node: OceanNode; view: OceanView; mood: OceanMood; busy: boolean;
  onClose(): void; onEdit(): void; onForget(): void; onRestore(): void; onSelect(id: string): void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const byId = new Map(view.nodes.map((item) => [item.id, item]));
  const links = view.edges.filter((edge) => edge.a === node.id || edge.b === node.id)
    .map((edge) => ({ edge, other: byId.get(edge.a === node.id ? edge.b : edge.a) }))
    .filter((item): item is { edge: OceanEdge; other: OceanNode } => !!item.other)
    .sort((a, b) => b.edge.weight - a.edge.weight).slice(0, 8);
  const curated = node.origin === "curated";
  const where = node.scope === "global" ? tr("所有项目") : tf("项目 · {0}", [node.project?.label ?? ""]);
  const source = curated ? tf("来自 {0}", [node.tags[0] ?? ""])
    : node.source.by === "agent" ? (node.source.title ? tf("智能体在「{0}」中记住", [node.source.title]) : tr("智能体记住"))
    : tr("你添加的");
  return <aside className="xn-ocean-detail" aria-label={tr("记忆详情")}>
    <header>
      <span className="xn-ocean-chip"><span className="xn-ocean-dot" style={{ background: kindColor(mood, curated ? "curated" : node.kind) }} aria-hidden="true" />{kindLabel(node.kind)}</span>
      {node.status === "archived" && <span className="xn-ocean-chip xn-ocean-chip--muted">{tr("已被取代")}</span>}
      <span className="xn-ocean-detail__stars" aria-label={tf("重要程度 {0}/5", [node.importance])}>
        {Array.from({ length: node.importance }, (_, index) => <Star key={index} size={12} fill="currentColor" aria-hidden="true" />)}
      </span>
      <button type="button" className="xn-ocean-icon" aria-label={tr("关闭")} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <h3>{node.summary}</h3>
    {node.text.trim() !== node.summary && <p className="xn-ocean-detail__text">{node.text}</p>}
    {node.tags.length > 0 && !curated && <p className="xn-ocean-detail__tags">{node.tags.map((tag) => <span key={tag}>#{tag}</span>)}</p>}
    <dl>
      <dt>{tr("范围")}</dt><dd>{where}</dd>
      <dt>{tr("来源")}</dt><dd>{source}</dd>
      {!curated && <><dt>{tr("更新")}</dt><dd title={node.updatedAt}>{ago(node.updatedAt)}</dd></>}
      {!curated && <><dt>{tr("召回")}</dt><dd>{node.recalls ? tf("{0} 次 · 最近 {1}", [node.recalls, ago(node.lastRecalledAt)]) : tr("还没有被召回")}</dd></>}
    </dl>
    {links.length > 0 && <section className="xn-ocean-detail__links">
      <h4>{tr("相连的记忆")}</h4>
      <ul>{links.map(({ edge, other }) => <li key={other.id}>
        <button type="button" onClick={() => onSelect(other.id)}>
          <span className="xn-ocean-dot" style={{ background: kindColor(mood, other.origin === "curated" ? "curated" : other.kind) }} aria-hidden="true" />
          <span className="xn-ocean-detail__link-text">{other.summary}</span>
          <small>{tr(RELATION[edge.kind])}</small>
        </button>
      </li>)}</ul>
    </section>}
    {curated ? <p className="xn-ocean-detail__note">{tr("这条来自记忆轨道文件，请在「记忆轨道」中编辑。")}</p>
      : confirming ? <div className="xn-ocean-detail__confirm" role="alert">
        <p>{tr("确定遗忘这段记忆？它会从记忆之海中删除，无法撤销。")}</p>
        <div><button type="button" className="xn-ocean-button" disabled={busy} onClick={() => setConfirming(false)}>{tr("取消")}</button>
          <button type="button" className="xn-ocean-button xn-ocean-button--danger" disabled={busy} onClick={onForget}>{tr("遗忘")}</button></div>
      </div>
      : <footer>
        {node.status === "archived" && <button type="button" className="xn-ocean-button" disabled={busy} onClick={onRestore}><RotateCcw size={14} aria-hidden="true" />{tr("恢复")}</button>}
        <button type="button" className="xn-ocean-button" disabled={busy} onClick={onEdit}><Pencil size={14} aria-hidden="true" />{tr("编辑")}</button>
        <button type="button" className="xn-ocean-button xn-ocean-button--quiet" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={14} aria-hidden="true" />{tr("遗忘")}</button>
      </footer>}
  </aside>;
}
