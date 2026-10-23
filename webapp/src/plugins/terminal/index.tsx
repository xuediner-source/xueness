import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { IconTerminal } from '../../ui/icons';
import { t as tr } from '../../i18n';
import { OperationHeader, OperationStatus } from '../shared';
import '../../styles/operations.css';
import { terminalFontStack } from './XuenessTerminalPreferences';
import { TerminalSessionRegistry, type TerminalResource, type TerminalApi } from './terminalSessionRegistry';
import { registerTerminalLifecycle } from './terminalLifecycle';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
export { nextTerminalBackoff, terminalResizePayload, decodeTerminalData } from './terminalSessionRegistry';

import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { createRemoteTerminalTransport } from './remoteTerminalTransport';
let singleton: TerminalSessionRegistry | undefined;
const remoteRegistries = new Map<string, TerminalSessionRegistry>();
let terminalEnabled = false;
let remoteEnabled = false;
const lifecycle = {
  setEnabled(value: boolean) { terminalEnabled = value; singleton?.setEnabled(value); for (const registry of remoteRegistries.values()) registry.setEnabled(value && remoteEnabled); },
  setRemoteEnabled(value: boolean) { remoteEnabled = value; for (const registry of remoteRegistries.values()) registry.setEnabled(value && terminalEnabled); },
  removeWorkspace(id: string) { singleton?.removeWorkspace(id); for (const registry of remoteRegistries.values()) registry.removeWorkspace(id); },
};
function getRemoteTerminalRegistry(adapter: RemoteSessionAdapter) {
  const found = remoteRegistries.get(adapter.runtimeKey);
  if (found) return found;
  let storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  let cleanupStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  try {
    const key = 'xueness.terminal.remote.v1:' + adapter.runtimeKey;
    const local = window.localStorage;
    storage = { getItem: () => local.getItem(key), setItem: (_key, value) => local.setItem(key, value) };
    cleanupStorage = { getItem: () => local.getItem(key + ':cleanup'), setItem: (_key, value) => local.setItem(key + ':cleanup', value) };
  } catch { /* Live ownership works without persisted descriptors. */ }
  const registry = createTerminalRegistry(createRemoteTerminalTransport(adapter, () => terminalEnabled && remoteEnabled, cleanupStorage), storage);
  remoteRegistries.set(adapter.runtimeKey, registry);
  registry.setEnabled(terminalEnabled && remoteEnabled && adapter.isCurrent());
  const unsubscribe = adapter.subscribe(() => {
    if (!adapter.isCurrent()) { registry.setEnabled(false); if (!registry.hasPendingCleanup()) { remoteRegistries.delete(adapter.runtimeKey); unsubscribe(); } }
  });
  return registry;
}
export function getTerminalRegistry() {
  if (singleton) return singleton;
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* Private browsing. */ }
  singleton = createTerminalRegistry({
    list: () => get('/api/terminals'),
    open: sessionId => post('/api/terminals', { session_id: sessionId, open: true }),
    poll: (id, cursor, signal) => get(`/api/terminals/${encodeURIComponent(id)}?cursor=${cursor}`, signal),
    input: (id, text) => post(`/api/terminals/${encodeURIComponent(id)}/input`, { text }),
    resize: (id, cols, rows) => post(`/api/terminals/${encodeURIComponent(id)}/resize`, { cols, rows }),
    close: id => post(`/api/terminals/${encodeURIComponent(id)}/close`, {}),
  }, storage);
  registerTerminalLifecycle(lifecycle);
  return singleton;
}
function createTerminalRegistry(api: TerminalApi, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  return new TerminalSessionRegistry(api, async (_entry, input, resize) => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    const element = document.createElement('div'); element.className = 'xn-terminal-host';
    const terminal = new Terminal({ cursorBlink: true, convertEol: false, scrollback: 5000, fontSize: 13, fontFamily: terminalFontStack('system'), theme: { background: '#161616', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#ffffff25' } });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    let opened = false;
    const fitVisible = () => {
      if (!opened || !element.isConnected || !element.clientWidth || !element.clientHeight) return;
      fit.fit(); resize(terminal.cols, terminal.rows);
    };
    const observer = new ResizeObserver(fitVisible);
    const subscription = terminal.onData(input);
    return {
      write: data => terminal.write(data),
      attach(host) { observer.disconnect(); host.appendChild(element); if (!opened) { terminal.open(element); opened = true; } observer.observe(host); fitVisible(); terminal.focus(); },
      detach() { observer.disconnect(); element.remove(); },
      configure(size, family) { terminal.options.fontSize = Number.isFinite(size) ? Math.max(10, Math.min(24, Math.round(size))) : 13; terminal.options.fontFamily = terminalFontStack(family); fitVisible(); },
      dispose() { observer.disconnect(); subscription.dispose(); terminal.dispose(); element.remove(); },
    };
  }, storage);
}

function TerminalView({ entry, registry, fontSize, fontFamily }: { entry: TerminalResource; registry: TerminalSessionRegistry; fontSize: number; fontFamily: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    registry.attach(entry, element, fontSize, fontFamily);
    return () => registry.detach(entry, element);
  }, [entry, registry, fontSize, fontFamily]);
  return <div className="xn-terminal-host" ref={host} />;
}

/** sessionId authorizes explicit shell creation; workspaceId owns the independent tabs. */
export function TerminalPanel({ sessionId, workspaceId, remote = false, remoteAdapter, fontSize = 13, fontFamily = 'system' }: { sessionId: string | null; workspaceId?: string; remote?: boolean; remoteAdapter?: RemoteSessionAdapter; fontSize?: number; fontFamily?: string }) {
  const localRegistry = getTerminalRegistry();
  const remoteReady = remote && remoteAdapter?.isCurrent() && remoteAdapter.owner.capabilities.interactiveTerminals === true;
  const registry = remoteReady && remoteAdapter ? getRemoteTerminalRegistry(remoteAdapter) : localRegistry;
  const unavailable = remote && !remoteReady;
  const workspace = workspaceId || '';
  const [, redraw] = useState(0);
  const [creating, setCreating] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const cleanupRegistries = [...remoteRegistries.values()].filter(value => value.hasPendingCleanup());
  const cleanup = async () => { setCleaning(true); try { for (const value of cleanupRegistries) await value.retryCleanup(); } finally { setCleaning(false); } };
  useEffect(() => registry.subscribe(() => redraw(n => n + 1)), [registry]);
  useEffect(() => { void registry.restore(); }, [registry]);
  const tabs = unavailable ? [] : registry.tabs(workspace);
  const active = unavailable ? undefined : registry.selected(workspace);
  const select = (tab: TerminalResource) => registry.select(tab);
  const create = () => {
    if (!sessionId || !workspace || unavailable || creating) return;
    setCreating(true);
    void registry.create(workspace, sessionId).then(tab => {
      if (tab) registry.select(tab);
    }).finally(() => setCreating(false));
  };
  return <section className="xn-operations xn-terminal-page" data-testid="terminal-pane">
    <OperationHeader icon={<IconTerminal size={22} />} title={tr('交互式终端')} description={tr('打开后直接在工作区执行命令，终端输入不会经过 Agent 的逐次审批。')} />
    {unavailable && <p role="status">{tr('远程终端尚不可用；不会启动本机 Shell。')}</p>}
    {cleanupRegistries.length > 0 && <p role="alert">{tr('远程终端打开结果尚未确认。可重试清理原请求；不会重新打开终端。')} <button type="button" disabled={cleaning} onClick={() => { void cleanup(); }}>{tr('重试终端清理')}</button></p>}
    {cleanupRegistries.filter(value => value !== registry && value.error).map((value, index) => <p role="alert" key={index}>{value.error}</p>)}
    {registry.error && <p role="alert">{registry.error}</p>}
    {active?.error && <p role="alert">{active.error}</p>}
    <div className="xn-terminal-frame"><div className="xn-terminal-toolbar">
      <div role="tablist" aria-label={tr('工作区终端')} onKeyDown={event => {
        if (isImeComposingEvent(event) || event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !tabs.length) return;
        const index = tabs.indexOf(active!);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); event.stopPropagation(); select(tabs[next]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{tabs.map(tab => <span key={tab.tabId}>
        <button type="button" role="tab" className={active === tab ? "xn-operation-primary" : undefined} aria-selected={active === tab} tabIndex={active === tab ? 0 : -1} onClick={() => select(tab)}>{tab.title}{tab.status === 'stopped' ? ` · ${tr('已停止')}` : ''}</button>
        <button type="button" aria-label={`${tr('关闭终端')} ${tab.title}`} title={tr('关闭标签并终止进程')} onClick={() => registry.close(tab)}>×</button>
      </span>)}</div>
      <OperationStatus status={active ? active.status === 'stopped' ? 'closed' : 'running' : 'pending'} />
      <div className="xn-operations-actions"><button className="xn-operation-primary" disabled={!sessionId || !workspace || unavailable || creating} onClick={create}>{creating ? tr('正在打开…') : tr('新建终端')}</button></div>
    </div><div className="xn-terminal-canvas">
      {active && !unavailable ? <TerminalView key={active.tabId} entry={active} registry={registry} fontSize={fontSize} fontFamily={fontFamily} /> : <div className="xn-terminal-empty"><IconTerminal size={36} /><h3>{sessionId ? tr('终端已就绪') : tr('请先选择一个会话')}</h3><p>{tr('新建终端需要明确操作。切换工作区或隐藏面板会保留终端；关闭标签会终止进程。')}</p></div>}
    </div><footer className="xn-terminal-footer"><span>{tr('工作区独立标签 · 隐藏时保留进程 · 关闭标签终止')}</span><kbd>Ctrl + C</kbd></footer></div>
  </section>;
}
