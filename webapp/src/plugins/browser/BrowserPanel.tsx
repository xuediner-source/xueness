import { useEffect, useRef, useState } from 'react';
import { AppWindow, Camera, Globe, LoaderCircle, Lock, Maximize2, Minimize2, PanelRight, Plus, RotateCw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { get, post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import { EmptyState } from '../../ui/primitives';
import { BrowserSessionRegistry, type BrowserAction, type BrowserTab } from './browserSessionRegistry';
import { registerBrowserLifecycle, unregisterBrowserLifecycle } from './browserLifecycle';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { createRemoteBrowserTransport } from './remoteBrowserTransport';
import { BrowserInspector } from './BrowserInspector';
import { PAGE_CHANGING, actionSummary, actionVerb, clockTime, describeTarget, friendlyError, hostOf, normalizeAddress, sendsToSite } from './browserPaneModel';
import './browser-pane.css';
let singleton: BrowserSessionRegistry | undefined;
export function getBrowserRegistry() {
  if (!singleton) {
    singleton = new BrowserSessionRegistry({ list: () => get('/api/browser/tabs'), open: sessionId => post('/api/browser/tabs', { sessionId }), action: (id, action) => post(`/api/browser/tabs/${encodeURIComponent(id)}/action`, action), cancel: (id, approval) => post(`/api/browser/tabs/${encodeURIComponent(id)}/cancel`, approval), close: id => post(`/api/browser/tabs/${encodeURIComponent(id)}/close`, {}) });
    registerBrowserLifecycle(singleton);
  }
  return singleton;
}
const remoteRegistries = new Map<string, { registry: BrowserSessionRegistry; adapter: RemoteSessionAdapter; unsubscribe: () => void }>();
function remoteRegistry(adapter: RemoteSessionAdapter, workspace: string) {
  const key = JSON.stringify([adapter.runtimeKey, workspace]);
  const existing = remoteRegistries.get(key);
  if (existing) { registerBrowserLifecycle(existing.registry); return existing.registry; }
  for (const [oldKey, old] of remoteRegistries) if (old.adapter.owner.connectionId === adapter.owner.connectionId) { old.unsubscribe(); unregisterBrowserLifecycle(old.registry); remoteRegistries.delete(oldKey); }
  const registry = new BrowserSessionRegistry(createRemoteBrowserTransport(adapter, workspace));
  registerBrowserLifecycle(registry);
  const unsubscribe = adapter.subscribe(() => {
    if (!adapter.isCurrent()) {
      unregisterBrowserLifecycle(registry);
    }
  });
  remoteRegistries.set(key, {registry, adapter, unsubscribe});
  return registry;
}
const unavailableRegistry = new BrowserSessionRegistry({
  list: async () => ({tabs: []}),
  open: async () => { throw new Error('Remote browser unavailable'); },
  action: async () => { throw new Error('Remote browser unavailable'); },
  cancel: async () => { throw new Error('Remote browser unavailable'); },
  close: async () => undefined,
});

/** Per-viewer convenience: after a page changes, ask (never approve) for a fresh screenshot. */
const AUTO_CAPTURE_KEY = 'xueness.browser.autoCapture';
const readAutoCapture = (): boolean => { try { return localStorage.getItem(AUTO_CAPTURE_KEY) !== 'off'; } catch { return true; } };
const tabLabel = (tab: BrowserTab): string => (tab.title && tab.title !== 'Browser' ? tab.title : '') || hostOf(tab.url) || tr('新标签页');

/** One pending action, said in words; Enter approves once, Escape cancels. */
function ApprovalBar({ tab, onApprove, onCancel }: { tab: BrowserTab; onApprove(): void; onCancel(): void }) {
  const approve = useRef<HTMLButtonElement>(null);
  const pending = tab.pending!;
  useEffect(() => { approve.current?.focus(); }, [pending.approvalId]);
  const sends = sendsToSite(pending.action);
  return <div className="xn-browser-approval" role="alertdialog" aria-label={tr('批准这次浏览器操作')} data-sends={sends || undefined}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <span className="xn-browser-approval__icon" aria-hidden="true">{sends ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}</span>
    <div className="xn-browser-approval__copy">
      <strong>{actionSummary(pending.action, describeTarget(tab.tree, pending.action.selector))}</strong>
      <span>{sends ? tr('这会向网站发出请求，可能提交数据。') : tr('只读取当前页面，不会改变它。')}</span>
      <details><summary>{tr('批准的确切内容')}</summary><code>{pending.subject}</code></details>
    </div>
    <div className="xn-browser-approval__actions">
      <button type="button" className="xn-browser-button" onClick={onCancel}>{tr('取消')}<kbd>Esc</kbd></button>
      <button ref={approve} type="button" className="xn-browser-button xn-browser-button--primary" onClick={onApprove}>{tr('允许一次')}<kbd>↵</kbd></button>
    </div>
  </div>;
}

function BrowserView({ tab, registry, remote }: { tab: BrowserTab; registry: BrowserSessionRegistry; remote: boolean }) {
  const [address, setAddress] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const [addressError, setAddressError] = useState('');
  const [inspector, setInspector] = useState(true);
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [autoCapture, setAutoCapture] = useState(readAutoCapture);
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setAddress(tab.url); }, [tab.url, editing]);
  const locked = Boolean(tab.busy || tab.pending);
  const run = async (action: BrowserAction, approved = false) => {
    await registry.act(tab, action, approved);
    // A refused or failed navigation leaves the page where it was, so the address bar says so too.
    if (action.action === 'navigate' && tab.error) setAddress(tab.url);
    if (approved && autoCapture && PAGE_CHANGING.has(action.action) && !tab.error && !tab.pending && !tab.disposed) void registry.act(tab, { action: 'screenshot' });
  };
  const cancel = async () => { await registry.cancel(tab); setAddress(tab.url); };
  const navigate = (raw: string) => {
    const next = normalizeAddress(raw);
    if ('error' in next) { setAddressError(next.error); return; }
    setAddressError(''); setAddress(next.url); addressRef.current?.blur();
    void run({ action: 'navigate', url: next.url });
  };
  const lastAction = tab.log?.at(-1)?.action.action;
  return <div className="xn-browser__view" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); addressRef.current?.focus(); }
  }}>
    <div className="xn-browser-toolbar">
      <button type="button" className="xn-browser-icon" disabled={locked || !tab.url} onClick={() => void run({ action: 'refresh' })} aria-label={tr('重新加载')} title={tr('重新加载')}><RotateCw size={15} /></button>
      <form className="xn-browser-address" data-invalid={addressError ? true : undefined} onSubmit={event => { event.preventDefault(); navigate(address); }}>
        <span className="xn-browser-address__scheme" aria-hidden="true">{tab.url ? <Lock size={13} /> : <Globe size={13} />}</span>
        <input ref={addressRef} value={address} maxLength={4096} spellCheck={false} autoComplete="off" disabled={locked} aria-label={tr('网址')}
          placeholder={tr('输入 HTTPS 网址，例如 example.com')} onChange={event => { setAddress(event.target.value); setAddressError(''); }}
          onFocus={event => { setEditing(true); event.currentTarget.select(); }} onBlur={() => setEditing(false)}
          onKeyDown={event => { if (event.key === 'Escape') { setAddress(tab.url); setAddressError(''); event.currentTarget.blur(); } }} />
        {tab.busy && <LoaderCircle size={14} className="xn-browser-spin" aria-hidden="true" />}
      </form>
      <button type="button" className="xn-browser-icon" disabled={locked || !tab.url} onClick={() => void run({ action: 'screenshot' })} aria-label={tr('截图')} title={tr('截图')}><Camera size={15} /></button>
      <button type="button" className="xn-browser-icon" aria-pressed={inspector} disabled={!tab.url} onClick={() => setInspector(value => !value)} aria-label={tr('检查器')} title={tr('检查器')}><PanelRight size={15} /></button>
    </div>
    {addressError && <p className="xn-browser-hint" role="alert">{addressError}</p>}
    {tab.pending && <ApprovalBar tab={tab} onApprove={() => void run(tab.pending!.action, true)} onCancel={() => void cancel()} />}
    {tab.error && !tab.pending && <p className="xn-browser-error" role="alert">{friendlyError(tab.error, lastAction)}</p>}
    <div className="xn-browser__body" data-inspector={inspector && tab.url ? true : undefined}>
      <div className="xn-browser-viewport" data-busy={tab.busy || undefined} data-fit={fit || undefined}>
        {tab.busy && tab.running && <div className="xn-browser-viewport__progress" role="status"><span aria-hidden="true" />{tf('正在{0}…', [actionVerb(tab.running)])}</div>}
        {tab.preview
          ? <img src={tab.preview} alt={tf('{0} 的截图', [tabLabel(tab)])} draggable={false} onClick={() => setFit(value => !value)}
              onLoad={event => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })} />
          : tab.url
            ? <div className="xn-browser-placeholder">
                <span className="xn-browser-placeholder__icon" aria-hidden="true"><AppWindow size={22} /></span>
                <strong>{tabLabel(tab)}</strong><code>{tab.url}</code>
                <p>{tab.capturedAt ? tr('页面已变化。截图后查看最新画面。') : tr('页面已在后台打开。截图后才会显示画面。')}</p>
                <button type="button" className="xn-browser-button xn-browser-button--primary" disabled={locked} onClick={() => void run({ action: 'screenshot' })}><Camera size={14} />{tr('截图查看')}</button>
              </div>
            : <EmptyState icon={<Globe size={20} />} title={tr('打开一个网页')} hint={tr('在上方输入公开的 HTTPS 网址。每个操作都会先请你批准，页面以截图显示。')} />}
      </div>
      {inspector && tab.url && <BrowserInspector tab={tab} registry={registry} locked={locked} onNavigate={url => { setAddress(url); void run({ action: 'navigate', url }); }} />}
    </div>
    <footer className="xn-browser-status">
      <span className="xn-browser-status__host">{tab.url.startsWith('https://') && <Lock size={11} aria-hidden="true" />}{hostOf(tab.url) || tr('未打开页面')}</span>
      {tab.preview && tab.capturedAt && <span>{tf('截图于 {0}', [clockTime(tab.capturedAt)])}{size ? ` · ${size.w}×${size.h}` : ''}</span>}
      {tab.preview && <button type="button" onClick={() => setFit(value => !value)}>{fit ? <Maximize2 size={12} aria-hidden="true" /> : <Minimize2 size={12} aria-hidden="true" />}{fit ? tr('实际大小') : tr('适应宽度')}</button>}
      <label className="xn-browser-status__auto"><input type="checkbox" checked={autoCapture} onChange={event => {
        const next = event.target.checked; setAutoCapture(next);
        try { localStorage.setItem(AUTO_CAPTURE_KEY, next ? 'on' : 'off'); } catch { /* per-viewer convenience only */ }
      }} />{tr('页面变化后请求截图')}</label>
      <span className="xn-browser-status__note"><ShieldCheck size={11} aria-hidden="true" />{remote ? tr('远程工作区 · 每个操作单独批准') : tr('每个操作单独批准')}</span>
    </footer>
  </div>;
}

export function BrowserPanel({ sessionId, workspaceId = '', remote = false, remoteAdapter }: { sessionId: string | null; workspaceId?: string; remote?: boolean; remoteAdapter?: RemoteSessionAdapter }) {
  const available = !remote || Boolean(remoteAdapter?.isCurrent() && remoteAdapter.owner.capabilities.browserTabs === true);
  const registry = remote ? available && remoteAdapter ? remoteRegistry(remoteAdapter, workspaceId) : unavailableRegistry : getBrowserRegistry();
  const [, redraw] = useState(0);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => registry.subscribe(() => redraw(n => n + 1)), [registry]);
  useEffect(() => { void registry.restore(); }, [registry]);
  const tabs = registry.tabs(workspaceId), active = registry.selected(workspaceId);
  const canCreate = available && Boolean(workspaceId && sessionId) && !creating && tabs.length < 8;
  const create = () => {
    if (!canCreate) return;
    setCreating(true); setError('');
    void registry.create(workspaceId, sessionId!, remote).catch(e => setError(String(e).replace(/^Error:\s*/, ''))).finally(() => setCreating(false));
  };
  return <section className="xn-browser" data-testid="browser-pane" aria-label={tr('浏览器')}>
    <header className="xn-browser-tabs">
      <div className="xn-browser-tabs__list" role="tablist" aria-label={tr('工作区浏览器标签页')}>
        {tabs.map(tab => <div key={tab.pageId} className="xn-browser-tab" data-active={active === tab || undefined}>
          <button type="button" role="tab" aria-selected={active === tab} title={tab.url || tabLabel(tab)} onClick={() => registry.select(tab)}>
            {tab.busy ? <LoaderCircle size={13} className="xn-browser-spin" aria-hidden="true" /> : tab.pending ? <span className="xn-browser-tab__dot" title={tr('等待批准')} /> : <Globe size={13} aria-hidden="true" />}
            <span>{tabLabel(tab)}</span>
          </button>
          <button type="button" className="xn-browser-tab__close" aria-label={tf('关闭 {0}', [tabLabel(tab)])} title={tr('关闭标签页')} onClick={() => registry.close(tab)}><X size={12} /></button>
        </div>)}
        <button type="button" className="xn-browser-tabs__new" disabled={!canCreate} onClick={create} aria-label={tr('新建标签页')} title={tabs.length >= 8 ? tr('最多同时打开 8 个标签页。') : tr('新建标签页')}><Plus size={15} /></button>
      </div>
      {remote && <span className="xn-browser-tabs__badge">{tr('远程工作区')}</span>}
      <button type="button" className="xn-browser-icon" onClick={() => void registry.refresh()} aria-label={tr('刷新标签列表')} title={tr('刷新标签列表')}><RotateCw size={13} /></button>
    </header>
    {registry.cleanupPending && <p className="xn-browser-banner" role="alert">{tr('未能确认标签页已关闭。')}<button type="button" onClick={() => registry.retryCleanup()}>{tr('重试关闭')}</button>
      <span>{remote ? tr('如果仍无法关闭，请重新连接远程工作区。') : tr('如果仍无法关闭，请检查浏览器服务。')}</span></p>}
    {error && <p className="xn-browser-banner" role="alert">{friendlyError(error)}</p>}
    {!available
      ? <EmptyState icon={<Globe size={20} />} title={tr('远程浏览器不可用')} hint={tr('连接的远程工作区没有提供浏览器；不会改为在本机打开。')} />
      : active
        ? <BrowserView key={active.pageId} tab={active} registry={registry} remote={remote} />
        : <EmptyState icon={<Globe size={20} />} title={sessionId ? tr('还没有打开的标签页') : tr('先打开一个任务')}
            hint={sessionId ? tr('标签页属于当前任务的工作区，关闭面板后仍在后台保留。') : tr('浏览器标签页绑定到任务，打开或新建一个任务后再来。')}
            action={sessionId && <button type="button" className="xn-browser-button xn-browser-button--primary" disabled={!canCreate} onClick={create}><Plus size={14} />{tr('新建标签页')}</button>} />}
  </section>;
}
