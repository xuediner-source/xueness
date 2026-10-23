import React, { useEffect, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { BrowserSessionRegistry, type BrowserTab } from './browserSessionRegistry';
import { registerBrowserLifecycle, unregisterBrowserLifecycle } from './browserLifecycle';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { createRemoteBrowserTransport } from './remoteBrowserTransport';
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
function BrowserView({ tab, registry }: { tab: BrowserTab; registry: BrowserSessionRegistry }) {
  const [url, setUrl] = useState(tab.url);
  const [selector, setSelector] = useState('');
  const [text, setText] = useState('');
  return <div>
    <form onSubmit={event => { event.preventDefault(); void registry.act(tab, { action: 'navigate', url }); }}>
      <label>HTTPS URL <input aria-label="Browser URL" type="url" maxLength={4096} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" /></label>
      <button disabled={tab.busy || !url.startsWith('https://')}>Navigate</button>
    </form>
    <div>{(['refresh', 'inspect', 'snapshot', 'screenshot'] as const).map(action => <button key={action} disabled={tab.busy || !tab.url} onClick={() => void registry.act(tab, { action })}>{action}</button>)}</div>
    <label>Element selector <input maxLength={1000} value={selector} onChange={event => setSelector(event.target.value)} placeholder="aria-ref=e1" /></label>
    <button disabled={tab.busy || !selector || !tab.url} onClick={() => void registry.act(tab, { action: 'click', selector })}>Click</button>
    <label>Fill text <input maxLength={5000} value={text} onChange={event => setText(event.target.value)} /></label>
    <button disabled={tab.busy || !selector || !tab.url} onClick={() => void registry.act(tab, { action: 'fill', selector, text })}>Fill</button>
    {tab.pending && <div role="dialog" aria-label="Approve exact browser action"><p>Approve this one browser action? This may send data to the current website.</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{tab.pending.subject}</pre><button onClick={() => void registry.act(tab, tab.pending!.action, true)}>Approve once</button><button onClick={() => void registry.cancel(tab)}>Cancel</button></div>}
    {tab.error && <p role="alert">{tab.error}</p>}
    <p role="status">{tab.busy ? 'Waiting for browser…' : tab.url || 'No page loaded'}</p>
    {tab.preview && <img src={tab.preview} alt="Authorized browser screenshot, not a live embedded page" style={{ width: '100%', maxWidth: 1280 }} />}
    {tab.text && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{tab.text}</pre>}
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
  return <section className="xn-operations" data-testid="browser-pane"><h2>Browser tabs</h2>
    <p>Screenshot-mediated browser: pages stay open when hidden. Navigation and declared controls require approval; this is not a live embedded browser. Capture a screenshot after changes.</p>
    {remote && <p role="status">{available ? "Browser runs in the connected remote workspace. Each action needs its own approval." : "Remote browser unavailable; no local browser will open."}</p>}
    <div role="tablist" aria-label="Workspace browser tabs">{tabs.map(tab => <span key={tab.pageId}><button role="tab" aria-selected={active === tab} onClick={() => registry.select(tab)}>{tab.title || 'Browser'}</button><button aria-label={`Close ${tab.title}`} onClick={() => registry.close(tab)}>×</button></span>)}</div>
    <button disabled={!available || !workspaceId || !sessionId || creating || tabs.length >= 8} onClick={() => { setCreating(true); setError(''); void registry.create(workspaceId, sessionId!, remote).catch(e => setError(String(e))).finally(() => setCreating(false)); }}>New browser tab</button>
    <button onClick={() => void registry.refresh()}>Refresh tab list</button>
    {registry.cleanupPending && <p role="alert">Browser tab closure is unconfirmed. <button onClick={() => registry.retryCleanup()}>Retry closing tabs</button> {remote ? "Reconnect the remote workspace if closing remains unavailable." : "Check the browser service if closing remains unavailable."}</p>}
    {error && <p role="alert">{error}</p>}{active && available && <BrowserView key={active.pageId} tab={active} registry={registry} />}
  </section>;
}
