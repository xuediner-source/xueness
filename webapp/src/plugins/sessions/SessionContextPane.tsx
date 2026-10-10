import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Globe, Link, PanelRightClose, Plus } from 'lucide-react';
import { t as tr } from '../../i18n';
import type { TimelineRow, WorkbenchSession } from '../../xuenessWorkbench';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import './SessionContextPane.css';

export type ContextSource = { kind: 'url' | 'file'; value: string; label: string };

/** Only successful tool records supply sources. Assistant prose is not evidence.
 * Traversal is bounded because arbitrary tool outputs can be large or cyclic. */
export function sessionContextSources(rows: TimelineRow[], filesEnabled = true): ContextSource[] {
  const found = new Map<string, ContextSource>();
  const add = (kind: ContextSource['kind'], value: unknown, title?: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || found.size >= 200) return;
    if (kind === 'file' && !filesEnabled) return;
    if (kind === 'url') {
      try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return; }
      catch { return; }
    }
    const key = `${kind}:${value}`;
    if (!found.has(key)) found.set(key, { kind, value, label: typeof title === 'string' && title.trim() ? title : kind === 'file' ? value.split(/[/\\]/u).pop() || value : value });
  };
  let visited = 0;
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || visited++ > 2000 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.slice(0, 200).forEach(item => walk(item, depth + 1)); return; }
    const record = value as Record<string, unknown>;
    add('url', record.url, record.title);
    Object.values(record).slice(0, 100).forEach(item => walk(item, depth + 1));
  };
  for (const row of rows) {
    if (row.kind !== 'tool' || row.status !== 'ok') continue;
    // Paths are accepted from successful read/preview tools, never from a claim
    // in free text or a failed request. Opening still uses the workspace API.
    if (/^(read|read_file|file_read|preview_file|office_preview)$/u.test(row.name)) add('file', row.input?.path);
    if (/^(web_fetch|browser_\w+)$/u.test(row.name)) add('url', row.input?.url);
    walk(row.output, 0);
  }
  return [...found.values()];
}

export function SessionContextPane({ session, rows, filesEnabled, onOpenFile, onBrowseFiles, onClose, subagents }: {
  session: WorkbenchSession; rows: TimelineRow[]; filesEnabled: boolean;
  onOpenFile(path: string): void; onBrowseFiles?(): void; onClose(): void; subagents?: React.ReactNode;
}): React.JSX.Element {
  const [allSources, setAllSources] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus({preventScroll:true});
    };
  }, []);
  const sources = useMemo(() => sessionContextSources(rows, filesEnabled), [rows, filesEnabled]);
  const outputs = filesEnabled ? [...new Set(session.changed_files ?? [])] : [];
  return <aside ref={ref} className="xn-session-context" aria-label={tr('会话信息')} data-testid="session-context-pane" onKeyDown={event => {
    if(event.key==='Escape' && !isImeComposingEvent(event)) { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
  }}>
    <div className="xn-session-context__toolbar"><button type="button" aria-label={tr('关闭侧栏')} title={tr('关闭侧栏')} onClick={onClose}><PanelRightClose size={16} /></button></div>
    <div className="xn-session-context__card">
      <section>
        <header><h2>{tr('输出内容')}</h2>{onBrowseFiles && <button type="button" aria-label={tr('打开工作区文件')} title={tr('打开工作区文件')} onClick={onBrowseFiles}><Plus size={16} /></button>}</header>
        {outputs.length ? outputs.map(path => <button key={path} type="button" className="xn-session-context__item" title={path} onClick={() => onOpenFile(path)}><FileText size={15} /><span>{path.split(/[/\\]/u).pop() || path}</span></button>) : <p className="xn-session-context__empty">{tr('暂无输出文件')}</p>}
      </section>
      {subagents}
      <section>
        <header><h2>{tr('来源')}</h2></header>
        {(allSources ? sources : sources.slice(0, 3)).map(source => source.kind === 'url' ?
          <a key={`url:${source.value}`} className="xn-session-context__item" href={source.value} target="_blank" rel="noreferrer" title={source.value}><Globe size={15} /><span>{source.label}</span></a> :
          <button key={`file:${source.value}`} type="button" className="xn-session-context__item" onClick={() => onOpenFile(source.value)} title={source.value}><FileText size={15} /><span>{source.label}</span></button>)}
        {!sources.length && <p className="xn-session-context__empty">{tr('暂无工具来源')}</p>}
        {sources.length > 3 && <button type="button" className="xn-session-context__item xn-session-context__more" aria-expanded={allSources} onClick={() => setAllSources(value => !value)}><Link size={15} /><span>{tr(allSources ? '收起' : '查看全部')}</span></button>}
      </section>
    </div>
  </aside>;
}
