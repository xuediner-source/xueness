import React, { useEffect, useRef, useState } from "react";
import { FileText, Folder, Pencil, RefreshCw, Search, X } from "lucide-react";
import { get } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { Select } from "../../ui/Select";
import { XuenessMemoryEditor } from "./index";
import "../../styles/memory-settings.css";

type MemoryFile = { name: "memory" | "user" | "key"; fileName: string; path: string; bytes: number; updatedAt: number };
type MemoryWorkspace = { id: string; label: string; files: MemoryFile[] };
export function XuenessMemorySettings({ enabled, onEnabledChange }: { enabled: boolean; onEnabledChange(enabled: boolean): void }): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<MemoryWorkspace[]>([]);
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryFile | null>(null);
  const generation = useRef(0);
  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await get<{workspaces: MemoryWorkspace[]}>("/api/memory/workspaces");
      if (request !== generation.current) return;
      setWorkspaces(result.workspaces);
      setScope(previous => result.workspaces.some(item => item.id === previous) ? previous : result.workspaces[0]?.id ?? "");
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => { if (enabled) void refresh(); return () => { ++generation.current; }; }, [enabled]);
  const workspace = workspaces.find(item => item.id === scope);
  const files = workspace?.files.filter(file => file.fileName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <div className="xn-memory-settings">
    <div className="xn-settings-group"><div className="xn-setting-row"><div className="xn-setting-copy"><h3>{tr("工作区记忆")}</h3><p>{tr("在任务中使用同一工作区的跨会话记忆。")}</p></div><div className="xn-setting-control"><input type="checkbox" role="switch" className="xn-settings-switch" aria-label={tr("工作区记忆")} checked={enabled} onChange={event => onEnabledChange(event.currentTarget.checked)} /></div></div></div>
    {enabled && <>
      {error && <p role="alert">{error}<button type="button" onClick={() => void refresh()}>{tr("重试")}</button></p>}
      {!workspace ? <div className="xn-memory-settings__empty" role="status">{busy ? tr("正在加载记忆…") : tr("暂无工作区记忆")}</div> : <section className="xn-memory-settings__viewer">
        <div className="xn-memory-settings__toolbar"><Folder size={16} aria-hidden="true" /><Select aria-label={tr("工作区记忆范围")} value={scope} onChange={event => { setScope(event.target.value); setEditing(null); }}>{workspaces.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</Select><span className="xn-memory-settings__count">{workspace.files.length} {tr("条记忆")}</span><label className="xn-memory-settings__search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={tr("搜索记忆文件")} placeholder={tr("搜索记忆文件")} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label={tr("清除搜索")} onClick={() => setQuery("")}><X size={14} /></button>}</label></div>
        <header className="xn-memory-settings__heading"><h3>{tr("记忆文件")}</h3><button type="button" aria-label={tr("刷新记忆")} title={tr("刷新记忆")} disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
        {files.length ? <div className="xn-memory-settings__files">{files.map(file => <div className="xn-memory-settings__file" key={file.name}><span className="xn-memory-settings__icon"><FileText size={16} /></span><div><strong>{file.fileName}</strong><small>{new Date(file.updatedAt).toLocaleString()}</small></div><button type="button" aria-label={`${tr("编辑记忆")} ${file.fileName}`} title={tr("编辑记忆")} onClick={() => setEditing(file)}><Pencil size={16} /></button></div>)}</div> : <div className="xn-memory-settings__empty">{tr("未找到匹配的记忆文件")}</div>}
        {editing && <div className="xn-memory-settings__editor"><button type="button" onClick={() => setEditing(null)}>{tr("关闭编辑器")}</button><XuenessMemoryEditor key={`${scope}:${editing.name}`} workspaceRoot={scope} initialTrack={editing.name} onSaved={() => void refresh()} /></div>}
      </section>}
    </>}
  </div>;
}
