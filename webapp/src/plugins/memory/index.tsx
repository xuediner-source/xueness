import React, { useEffect, useRef, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import "../../styles/memory-editor.css";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";

type MemoryDocument = { name: "memory" | "user" | "key"; content: string; digest: string };
export function XuenessMemoryEditor({ workspaceRoot, initialTrack = "memory", onSaved }: { workspaceRoot?: string; initialTrack?: MemoryDocument["name"]; onSaved?(): void } = {}): React.JSX.Element {
  const [name, setName] = useState<MemoryDocument["name"]>(initialTrack);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stale, setStale] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  useModalFocusScope({ open: confirm, dialogRef, returnFocusTo: saveButtonRef.current });
  const reload = async () => {
    setBusy(true); setError(""); setNotice(""); setStale(false);
    try { setDocument(await get<MemoryDocument>(`/api/memory/tracks/${name}${workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : ""}`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!document) return;
    setBusy(true); setError(""); setNotice(""); setConfirm(false);
    try { setDocument(await post<MemoryDocument>(`/api/memory/tracks/${document.name}${workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : ""}`, { confirmed: true, content: document.content, digest: document.digest })); setNotice(tr("记忆内容已保存。")); setStale(false); onSaved?.(); }
    catch (e) { const message = e instanceof Error ? e.message : String(e); setError(message); if (message.includes("memory changed")) setStale(true); }
    finally { setBusy(false); }
  };
  return <section className="xn-memory-editor" data-testid="memory-editor">
    <header><div><h3>{tr("编辑记忆轨道")}</h3><p>{tr("内容只会在你点击加载后读取；保存使用版本摘要检测并发更改。")}</p></div></header>
    <div className="xn-memory-editor__controls"><label>{tr("轨道")}<select value={name} onChange={e => { setName(e.target.value as MemoryDocument["name"]); setDocument(null); setStale(false); }}><option value="memory">MEMORY.md</option><option value="user">USER.md</option><option value="key">KEY.md</option></select></label><button type="button" disabled={busy} onClick={() => void reload()}>{tr("加载内容")}</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {stale && <div role="alert" className="xn-memory-editor__stale"><p>{tr("此文件已被其他操作修改。请重新加载后再编辑。")}</p><button type="button" disabled={busy} onClick={() => void reload()}>{tr("重新加载最新版本")}</button></div>}
    {document && <><textarea aria-label={tr("记忆内容")} value={document.content} disabled={busy || stale} onChange={e => setDocument({ ...document, content: e.target.value })} /><small>{tr("版本摘要：")}<code>{document.digest}</code></small><button ref={saveButtonRef} type="button" disabled={busy || stale} onClick={() => setConfirm(true)}>{tr("审阅并保存")}</button></>}
    {confirm && document && <div className="xn-memory-editor__backdrop"><section ref={dialogRef} tabIndex={-1} onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (shouldDismissModalOnEscape(event, busy)) { event.preventDefault(); setConfirm(false); }
    }} role="alertdialog" aria-modal="true" aria-labelledby="xn-memory-confirm-title" aria-describedby="xn-memory-confirm-description"><h3 id="xn-memory-confirm-title">{tr("确认保存记忆")}</h3><p id="xn-memory-confirm-description">{document.name} · {tr("将以此加载版本的摘要条件保存。若内容变更，保存会被拒绝。")}</p><div><button type="button" onClick={() => setConfirm(false)}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => void save()}>{tr("确认保存")}</button></div></section></div>}
  </section>;
}
