import React, { useEffect, useRef, useState } from "react";
import { FileText, Folder, Pencil, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { get } from "../../xuenessApi";
import { tf, t as tr } from "../../i18n";
import { Select } from "../../ui/Select";
import { XuenessMemoryEditor } from "./index";
import { kindLabel, loadOcean, type OceanView } from "./oceanApi";
import "../../styles/memory-settings.css";

type MemoryFile = { name: "memory" | "user" | "key"; fileName: string; path: string; bytes: number; updatedAt: number };
type MemoryWorkspace = { id: string; label: string; files: MemoryFile[] };
const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

export function XuenessMemorySettings({ enabled, onEnabledChange }: { enabled: boolean; onEnabledChange(enabled: boolean): void }): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<MemoryWorkspace[]>([]);
  const [ocean, setOcean] = useState<OceanView | null>(null);
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryFile | null>(null);
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const refresh = async () => {
    const request = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setError("");
    try {
      const [wsRes, oceanRes] = await Promise.allSettled([
        get<{ workspaces: MemoryWorkspace[] }>("/api/memory/workspaces"),
        loadOcean(undefined, controller.signal),
      ]);
      if (request !== generation.current) return;
      const errors: string[] = [];
      if (wsRes.status === "fulfilled") {
        setWorkspaces(wsRes.value.workspaces);
        setScope(previous => wsRes.value.workspaces.some(item => item.id === previous) ? previous : wsRes.value.workspaces[0]?.id ?? "");
      } else if (!isAbortError(wsRes.reason)) {
        errors.push(wsRes.reason instanceof Error ? wsRes.reason.message : String(wsRes.reason));
      }
      if (oceanRes.status === "fulfilled") {
        setOcean(oceanRes.value);
      } else if (!isAbortError(oceanRes.reason)) {
        errors.push(oceanRes.reason instanceof Error ? oceanRes.reason.message : String(oceanRes.reason));
      }
      if (errors.length) setError(errors.join("; "));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      ++generation.current;
      abortRef.current?.abort();
    };
  }, [enabled]);
  const workspace = workspaces.find(item => item.id === scope);
  const files = workspace?.files.filter(file => file.fileName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const oceanEntries = ocean ? ocean.nodes.filter(node => node.status === "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5) : [];
  return <div className="xn-memory-settings">
    <div className="xn-settings-group"><div className="xn-setting-row"><div className="xn-setting-copy"><h3>{tr("工作区记忆")}</h3><p>{tr("在任务中使用同一工作区的跨会话记忆。")}</p></div><div className="xn-setting-control"><input type="checkbox" role="switch" className="xn-settings-switch" aria-label={tr("工作区记忆")} checked={enabled} onChange={event => onEnabledChange(event.currentTarget.checked)} /></div></div></div>
    {enabled && <>
      {error && <p role="alert">{error}<button type="button" onClick={() => void refresh()}>{tr("重试")}</button></p>}
      {ocean && <section className="xn-memory-settings__viewer" data-testid="memory-ocean-settings-summary">
        <header className="xn-memory-settings__heading"><h3><Sparkles size={16} aria-hidden="true" /> {tr("记忆之海")}</h3><span className="xn-memory-settings__count">{tf("{0} 段有效记忆 · {1} 个星座", [ocean.stats.active, ocean.clusters.length])}</span><button type="button" aria-label={tr("刷新记忆")} title={tr("刷新记忆")} disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
        {oceanEntries.length ? <div className="xn-memory-settings__files">{oceanEntries.map((node, index) => <div className="xn-memory-settings__file" key={node.id || `${node.updatedAt}:${index}`}><span className="xn-memory-settings__icon"><Sparkles size={16} /></span><div><strong>{node.summary}</strong><small>{tr(kindLabel(node.kind))} · {node.scope === "global" ? tr("所有项目") : (node.project?.label ?? tr("当前项目"))} · {new Date(node.updatedAt).toLocaleString()}</small></div></div>)}</div> : <div className="xn-memory-settings__empty">{tr("暂无跨会话记忆，可从左侧「记忆之海」星图或对话中写入。")}</div>}
      </section>}
      {!workspace ? <div className="xn-memory-settings__empty" role="status">{busy ? tr("正在加载记忆…") : tr("暂无工作区记忆")}</div> : <section className="xn-memory-settings__viewer">
        <div className="xn-memory-settings__toolbar"><Folder size={16} aria-hidden="true" /><Select aria-label={tr("工作区记忆范围")} value={scope} onChange={event => { setScope(event.target.value); setEditing(null); }}>{workspaces.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</Select><span className="xn-memory-settings__count">{workspace.files.length} {tr("条记忆")}</span><label className="xn-memory-settings__search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={tr("搜索记忆文件")} placeholder={tr("搜索记忆文件")} value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label={tr("清除搜索")} onClick={() => setQuery("")}><X size={14} /></button>}</label></div>
        <header className="xn-memory-settings__heading"><h3>{tr("记忆文件")}</h3><button type="button" aria-label={tr("刷新记忆")} title={tr("刷新记忆")} disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
        {files.length ? <div className="xn-memory-settings__files">{files.map(file => <div className="xn-memory-settings__file" key={file.name}><span className="xn-memory-settings__icon"><FileText size={16} /></span><div><strong>{file.fileName}</strong><small>{new Date(file.updatedAt).toLocaleString()}</small></div><button type="button" aria-label={`${tr("编辑记忆")} ${file.fileName}`} title={tr("编辑记忆")} onClick={() => setEditing(file)}><Pencil size={16} /></button></div>)}</div> : <div className="xn-memory-settings__empty">{tr("未找到匹配的记忆文件")}</div>}
        {editing && <div className="xn-memory-settings__editor"><button type="button" onClick={() => setEditing(null)}>{tr("关闭编辑器")}</button><XuenessMemoryEditor key={`${scope}:${editing.name}`} workspaceRoot={scope} initialTrack={editing.name} onSaved={() => void refresh()} /></div>}
      </section>}
    </>}
  </div>;
}
