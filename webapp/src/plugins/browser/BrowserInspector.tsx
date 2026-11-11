/**
 * The browser pane's inspector: the page's elements (from the approved
 * snapshot) as pickable targets, the page's text and links, and this tab's
 * activity. Picking an element only fills the target field; clicking or
 * filling still goes through the tab's one-time approval.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FileText, History, ListTree, MousePointerClick, Search, TextCursorInput } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import { EmptyState } from '../../ui/primitives';
import type { BrowserAction, BrowserSessionRegistry, BrowserTab } from './browserSessionRegistry';
import { actionSummary, actionVerb, clockTime, describeTarget, friendlyError, parseSnapshot } from './browserPaneModel';

type View = 'elements' | 'text' | 'log';
const STATUS_LABEL = { awaiting: '等待批准', done: '完成', failed: '失败', cancelled: '已取消' } as const;

export function BrowserInspector({ tab, registry, locked, onNavigate }: { tab: BrowserTab; registry: BrowserSessionRegistry; locked: boolean; onNavigate(url: string): void }) {
  const [view, setView] = useState<View>('elements');
  const [selector, setSelector] = useState('');
  const [fillText, setFillText] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyTargets, setOnlyTargets] = useState(false);
  const act = (action: BrowserAction) => { void registry.act(tab, action); };
  // A fresh result of one kind opens the view that shows it.
  useEffect(() => { if (tab.tree) setView('elements'); }, [tab.tree]);
  useEffect(() => { if (tab.textKind === 'text' && tab.pageText !== undefined) setView('text'); }, [tab.pageText, tab.textKind]);
  const snapshot = useMemo(() => tab.tree ? parseSnapshot(tab.tree) : null, [tab.tree]);
  const needle = filter.trim().toLocaleLowerCase();
  const rows = (snapshot?.rows ?? []).filter(row => (!onlyTargets || row.ref) && (!needle || `${row.role} ${row.name} ${row.ref ?? ''}`.toLocaleLowerCase().includes(needle)));
  const disabled = locked || !tab.url;
  const tabs: [View, string, React.ReactNode, number | undefined][] = [
    ['elements', tr('元素'), <ListTree size={14} aria-hidden="true" />, snapshot?.rows.filter(row => row.ref).length],
    ['text', tr('文字'), <FileText size={14} aria-hidden="true" />, undefined],
    ['log', tr('记录'), <History size={14} aria-hidden="true" />, tab.log?.length || undefined],
  ];
  return <aside className="xn-browser-inspector" aria-label={tr('页面检查器')}>
    <div className="xn-browser-inspector__tabs" role="tablist" aria-label={tr('检查器视图')}>
      {tabs.map(([id, label, icon, count]) => <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
        {icon}<span>{label}</span>{count !== undefined && <span className="xn-browser-inspector__count">{count}</span>}
      </button>)}
    </div>
    {view === 'elements' && (snapshot ? <>
      {tab.treeStale && <p className="xn-browser-inspector__stale">{tr('页面已变化，这些元素可能已失效。')}<button type="button" disabled={disabled} onClick={() => act({ action: 'snapshot' })}>{tr('重新读取')}</button></p>}
      <div className="xn-browser-inspector__filter">
        <label><Search size={13} aria-hidden="true" /><input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={tr('筛选元素')} aria-label={tr('筛选元素')} /></label>
        <button type="button" aria-pressed={onlyTargets} onClick={() => setOnlyTargets(value => !value)}>{tr('仅可操作')}</button>
      </div>
      <ul className="xn-browser-tree" aria-label={tr('页面元素')}>
        {rows.map((row, index) => <li key={`${index}-${row.ref ?? ''}`} style={{ '--depth': Math.min(row.depth, 12) } as React.CSSProperties}>
          {row.ref
            ? <button type="button" className="xn-browser-tree__row" aria-pressed={selector === `aria-ref=${row.ref}`} onClick={() => setSelector(`aria-ref=${row.ref}`)} title={tr('选为目标')}>
                <span className="xn-browser-tree__role">{row.role}</span><span className="xn-browser-tree__name">{row.name}</span>
                {row.flags.map(flag => <span key={flag} className="xn-browser-tree__flag">{flag}</span>)}<code>{row.ref}</code>
              </button>
            : <div className="xn-browser-tree__row" data-static><span className="xn-browser-tree__role">{row.role}</span><span className="xn-browser-tree__name">{row.name}</span></div>}
        </li>)}
        {!rows.length && <li className="xn-browser-inspector__none">{tr('没有匹配的元素')}</li>}
      </ul>
      {snapshot.note && <p className="xn-browser-inspector__note">{tr('结构已截断，只显示前一部分元素。')}</p>}
      <form className="xn-browser-actions" onSubmit={event => { event.preventDefault(); if (selector) act({ action: 'click', selector }); }}>
        <label className="xn-browser-actions__target"><span>{tr('目标')}</span><input value={selector} maxLength={1000} onChange={event => setSelector(event.target.value)} placeholder={tr('点选上方元素，或输入定位器')} aria-label={tr('目标元素定位器')} /></label>
        <div className="xn-browser-actions__row">
          <button type="submit" disabled={disabled || !selector}><MousePointerClick size={14} aria-hidden="true" />{tr('点击')}</button>
          <input value={fillText} maxLength={5000} onChange={event => setFillText(event.target.value)} placeholder={tr('要填写的文字')} aria-label={tr('要填写的文字')} />
          <button type="button" disabled={disabled || !selector} onClick={() => act({ action: 'fill', selector, text: fillText })}><TextCursorInput size={14} aria-hidden="true" />{tr('填写')}</button>
        </div>
      </form>
    </> : <EmptyState compact icon={<ListTree size={17} />} title={tr('还没有读取元素')} hint={tr('读取页面结构后，可以点选按钮、链接或输入框，再点击或填写。')}
      action={<button type="button" className="xn-browser-button" disabled={disabled} onClick={() => act({ action: 'snapshot' })}>{tr('读取元素')}</button>} />)}
    {view === 'text' && (tab.pageText !== undefined ? <div className="xn-browser-text">
      <pre>{tab.pageText || tr('页面没有可读文字。')}</pre>
      {!!tab.links?.length && <section aria-label={tr('页面链接')}>
        <h3>{tf('链接 {0}', [tab.links.length])}</h3>
        <ul>{tab.links.map((link, index) => {
          let target = ''; try { const url = new URL(link.href, tab.url); if (url.protocol === 'https:') target = url.toString(); } catch { /* not a usable link */ }
          return <li key={index}><span>{link.text.trim() || link.href}</span>
            {target ? <button type="button" disabled={locked} onClick={() => onNavigate(target)} title={target}>{tr('打开')}</button> : <small>{tr('非 HTTPS')}</small>}</li>;
        })}</ul>
      </section>}
    </div> : <EmptyState compact icon={<FileText size={17} />} title={tr('还没有读取文字')} hint={tr('读取后可以查看页面文字和其中的链接。')}
      action={<button type="button" className="xn-browser-button" disabled={disabled} onClick={() => act({ action: 'inspect' })}>{tr('读取文字')}</button>} />)}
    {view === 'log' && (tab.log?.length ? <ol className="xn-browser-log">
      {[...tab.log].reverse().map((entry, index) => <li key={`${entry.at}-${index}`} data-status={entry.status}>
        <time>{clockTime(entry.at)}</time>
        <div><strong>{actionVerb(entry.action.action)}</strong><span>{actionSummary(entry.action, describeTarget(tab.tree, entry.action.selector))}</span>
          {entry.detail && <small>{friendlyError(entry.detail, entry.action.action)}</small>}</div>
        <span className="xn-browser-log__status">{tr(STATUS_LABEL[entry.status])}</span>
      </li>)}
    </ol> : <EmptyState compact icon={<History size={17} />} title={tr('还没有操作')} hint={tr('这个标签页里请求、批准和完成的操作会记在这里。')} />)}
  </aside>;
}
