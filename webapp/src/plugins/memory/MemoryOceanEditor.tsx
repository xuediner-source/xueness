import React, { useId, useRef, useState } from "react";
import { Star } from "lucide-react";
import { t as tr } from "../../i18n";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import { addMemory, kindLabel, OCEAN_KINDS, updateMemory, type OceanKind, type OceanNode } from "./oceanApi";
import { kindColor, type OceanMood } from "./oceanPalette";

/** Add a memory by hand, or edit one; the store merges a near-duplicate instead of adding it twice. */
export function MemoryOceanEditor({ node, mood, workspaceRoot, returnFocusTo, onClose, onSaved }: {
  node: OceanNode | null; mood: OceanMood; workspaceRoot?: string; returnFocusTo?: HTMLElement | null;
  onClose(): void; onSaved(id: string, created: boolean): void;
}): React.JSX.Element {
  const ids = { text: useId(), summary: useId(), tags: useId(), title: useId() };
  const dialogRef = useRef<HTMLElement>(null);
  const [text, setText] = useState(node?.text ?? "");
  const [summary, setSummary] = useState(node?.summary ?? "");
  const [kind, setKind] = useState<OceanKind>(node?.kind ?? "preference");
  const [tags, setTags] = useState((node?.tags ?? []).join(", "));
  const [importance, setImportance] = useState(node?.importance ?? 3);
  const [scope, setScope] = useState<"project" | "global">(node?.scope ?? (workspaceRoot ? "project" : "global"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalFocusScope({ open: true, dialogRef, returnFocusTo: returnFocusTo ?? null });
  const save = async (): Promise<void> => {
    if (!text.trim()) { setError(tr("请写下要记住的内容。")); return; }
    setBusy(true); setError("");
    const draft = { text, summary: summary.trim() || undefined, kind, importance, tags: tags.split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean) };
    try {
      if (node) { const saved = await updateMemory(node.id, { ...draft, version: node.version }); onSaved(saved.memory.id, false); }
      else { const saved = await addMemory({ ...draft, scope, ...workspaceRoot ? { root: workspaceRoot } : {} }); onSaved(saved.memory.id, !saved.merged); }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message.includes("memory changed") ? tr("这段记忆刚被修改过，请关闭后重新打开再编辑。") : message);
      setBusy(false);
    }
  };
  return <div className="xn-ocean-dialog__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="xn-ocean-dialog" role="dialog" aria-modal="true" aria-labelledby={ids.title} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape" && shouldDismissModalOnEscape(event, busy)) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <h3 id={ids.title}>{node ? tr("编辑记忆") : tr("记住一件事")}</h3>
      <p className="xn-ocean-dialog__hint">{tr("写下以后的对话值得知道的事：偏好、决定、项目事实或踩过的坑。不要写入密钥或密码。")}</p>
      <label htmlFor={ids.text}>{tr("内容")}</label>
      <textarea id={ids.text} value={text} maxLength={2000} rows={5} disabled={busy} onChange={(event) => setText(event.target.value)}
        placeholder={tr("例如：这个项目用 pnpm，不要用 npm。")} />
      <label htmlFor={ids.summary}>{tr("一句话摘要（可选）")}</label>
      <input id={ids.summary} value={summary} maxLength={140} disabled={busy} onChange={(event) => setSummary(event.target.value)} placeholder={tr("默认取内容的第一行")} />
      <fieldset className="xn-ocean-dialog__kinds" disabled={busy}>
        <legend>{tr("类型")}</legend>
        {OCEAN_KINDS.map((item) => <button key={item} type="button" aria-pressed={kind === item} onClick={() => setKind(item)}>
          <span className="xn-ocean-dot" style={{ background: kindColor(mood, item) }} aria-hidden="true" />{kindLabel(item)}
        </button>)}
      </fieldset>
      <div className="xn-ocean-dialog__row">
        <fieldset className="xn-ocean-dialog__importance" disabled={busy}>
          <legend>{tr("重要程度")}</legend>
          {[1, 2, 3, 4, 5].map((level) => <button key={level} type="button" aria-pressed={importance >= level} aria-label={`${level}`} onClick={() => setImportance(level)}>
            <Star size={16} fill={importance >= level ? "currentColor" : "none"} aria-hidden="true" />
          </button>)}
        </fieldset>
        {!node && <fieldset className="xn-ocean-dialog__scope" disabled={busy}>
          <legend>{tr("范围")}</legend>
          <button type="button" aria-pressed={scope === "project"} disabled={!workspaceRoot} onClick={() => setScope("project")}>{tr("此项目")}</button>
          <button type="button" aria-pressed={scope === "global"} onClick={() => setScope("global")}>{tr("所有项目")}</button>
        </fieldset>}
      </div>
      <label htmlFor={ids.tags}>{tr("标签（用逗号分隔）")}</label>
      <input id={ids.tags} value={tags} disabled={busy} onChange={(event) => setTags(event.target.value)} placeholder={tr("例如：构建, 依赖")} />
      {error && <p className="xn-ocean-dialog__error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="xn-ocean-button" disabled={busy} onClick={onClose}>{tr("取消")}</button>
        <button type="button" className="xn-ocean-button xn-ocean-button--primary" disabled={busy} onClick={() => void save()}>{node ? tr("保存") : tr("记住")}</button>
      </footer>
    </section>
  </div>;
}
