import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { t as tr } from '../../i18n';
import { shouldDismissModalOnEscape, useModalFocusScope } from '../shared';

export type BrowserRuntime = { available: boolean; browser: 'Chrome' | 'Edge' | 'Chromium' | null;
  reason: string | null; desktop: boolean; importEnabled: boolean };
export type ChromeProfile = { id: string; name: string };

export async function readBrowserRuntime(signal?: AbortSignal): Promise<BrowserRuntime> {
  const value = await get<BrowserRuntime>('/api/browser/runtime', signal);
  if (!value || typeof value.available !== 'boolean' || typeof value.desktop !== 'boolean' || typeof value.importEnabled !== 'boolean'
    || ![null, 'Chrome', 'Edge', 'Chromium'].includes(value.browser)
    || (value.available && value.browser === null)
    || (value.reason !== null && typeof value.reason !== 'string')) throw new Error(tr('浏览器环境状态无效。'));
  return value;
}

export async function readChromeProfiles(signal?: AbortSignal): Promise<ChromeProfile[]> {
  const value = await get<{ profiles: ChromeProfile[] }>('/api/browser/profiles', signal);
  if (!value || !Array.isArray(value.profiles) || value.profiles.length > 50 || value.profiles.some(row => !row || typeof row.id !== 'string' || !/^(Default|Profile [0-9]{1,4})$/.test(row.id) || typeof row.name !== 'string')) throw new Error(tr('Chrome 资料列表无效。'));
  return value.profiles;
}

export async function importChromeProfile(profileId: string): Promise<boolean> {
  if (typeof profileId !== 'string' || !/^(Default|Profile [0-9]{1,4})$/.test(profileId)) throw new Error(tr('请选择 Chrome 资料。'));
  const value = await post<{ ok: boolean; cleanupPending?: boolean }>('/api/browser/profiles', { profileId, confirmed: true });
  if (value.ok !== true) throw new Error(tr('Chrome 资料导入未完成。'));
  return value.cleanupPending === true;
}

export function browserImportError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : String(cause);
  const messages: Record<string, string> = {
    close_chrome: '请先完全退出 Chrome，再重试导入。',
    source_busy: 'Chrome 资料正在使用或无法读取，请退出 Chrome 后重试。',
    tasks_running: '请先结束运行中的任务，再导入资料。',
    profile_too_large: '所选资料过大，请选择较小的资料或清理站点存储后重试。',
    source_invalid: 'Chrome 资料无效或包含不支持的链接目录。',
    profile_invalid: '受管理浏览器资料目录无效。',
    profile_not_found: '所选 Chrome 资料已不可用，请重新选择。',
    plugin_disabled: '浏览器或桌面集成已关闭，请启用后重试。',
    desktop_required: '请启用桌面集成后再导入 Chrome 资料。',
    confirmation_required: '请确认导入资料。',
  };
  return messages[code] ? tr(messages[code]) : tr('Chrome 资料导入失败，请重试。');
}

export function browserRuntimeLabel(runtime: BrowserRuntime | null, enabled: boolean) {
  if (!enabled) return tr('浏览器控制已关闭');
  if (!runtime) return tr('正在检查浏览器环境…');
  if (runtime.available) return `${runtime.browser} · ${tr('浏览器环境可用')}`;
  return tr(runtime.reason === 'browser_missing' ? '未检测到 Chrome、Edge 或 Chromium，请安装浏览器后刷新。' : '浏览器运行环境不可用，请重新安装桌面应用后重试。');
}

export function DesktopBrowserImport({ enabled, disabled, runtime, onImported, onPendingChange }: {
  enabled: boolean; disabled: boolean; runtime: BrowserRuntime | null; onImported: (cleanupPending: boolean) => void; onPendingChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [selected, setSelected] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null), cancelRef = useRef<HTMLButtonElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true), busy = useRef(false);
  const active = useRef(enabled); active.current = enabled;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled || !runtime?.importEnabled) { setOpen(false); setProfiles([]); }
  }, [enabled, runtime?.importEnabled]);
  useEffect(() => {
    if (!open || !enabled || !runtime?.importEnabled) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setConfirmed(false); setProfiles([]); setSelected('');
    void readChromeProfiles(controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      setProfiles(rows); setSelected(rows[0]?.id ?? '');
    }).catch(cause => { if (!controller.signal.aborted) setError(browserImportError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, enabled, runtime?.importEnabled]);
  useModalFocusScope({ open, dialogRef, initialFocusRef: cancelRef, returnFocusTo: triggerRef.current });
  const canImport = enabled && runtime?.importEnabled === true && runtime.available;
  const description = !enabled ? tr('启用浏览器控制后，可选择本机 Chrome 资料。')
    : !runtime ? tr('正在检查桌面浏览器能力…')
    : !runtime.available ? browserRuntimeLabel(runtime, true)
    : !runtime.desktop ? tr('网页版无法导入本机 Chrome 资料，请使用桌面应用。')
    : !runtime.importEnabled ? tr('请启用桌面集成后再导入 Chrome 资料。')
    : tr('选择资料并复制到独立浏览器目录；部分站点可能需要重新登录。');
  const submit = async () => {
    if (!canImport || disabled || !confirmed || !selected || loading || busy.current) return;
    busy.current = true; setPending(true); setError(''); onPendingChange(true);
    try {
      const cleanupPending = await importChromeProfile(selected);
      if (mounted.current && active.current) { setOpen(false); onImported(cleanupPending); }
    } catch (cause) { if (mounted.current) setError(browserImportError(cause)); }
    finally { busy.current = false; if (mounted.current) { setPending(false); onPendingChange(false); } }
  };
  return <>
    <div className="xn-browser-settings__row is-import">
      <div className="xn-browser-settings__row-copy"><h5>{tr('导入 Chrome 浏览器资料')}</h5><p>{description}</p></div>
      <button ref={triggerRef} type="button" data-testid="browser-import-profile" disabled={disabled || !canImport || pending} onClick={() => setOpen(true)}>{tr('选择资料…')}</button>
    </div>
    {open && <div className="xn-browser-settings__backdrop"><div ref={dialogRef} className="xn-browser-settings__dialog" role="dialog" aria-modal="true" aria-labelledby="xn-browser-import-title" aria-describedby="xn-browser-import-description" tabIndex={-1}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (shouldDismissModalOnEscape(event, pending)) { event.preventDefault(); setOpen(false); } } }}>
      <h4 id="xn-browser-import-title">{tr('导入 Chrome 浏览器资料')}</h4>
      <p id="xn-browser-import-description">{tr('请先完全退出 Chrome。导入书签、历史和站点存储到 Xueness 的独立目录，不会修改原资料，也不会复制已保存的密码或扩展。部分登录状态可能需要重新登录。')}</p>
      {loading ? <p role="status">{tr('正在读取 Chrome 资料…')}</p> : profiles.length ? <label className="xn-browser-settings__profile-select">{tr('Chrome 资料')}<select value={selected} disabled={pending} onChange={event => setSelected(event.target.value)}>{profiles.map(row => <option key={row.id} value={row.id}>{row.name} ({row.id})</option>)}</select></label> : <p>{tr('未找到本机 Chrome 资料。')}</p>}
      <label className="xn-browser-settings__import-confirm"><input type="checkbox" checked={confirmed} disabled={pending || loading || !profiles.length} onChange={event => setConfirmed(event.target.checked)} />{tr('确认复制所选资料，并替换 Xueness 现有的受管理浏览器资料。')}</label>
      {error && <p className="xn-browser-settings__feedback is-error" role="alert">{error}</p>}
      <div className="xn-browser-settings__dialog-actions"><button ref={cancelRef} type="button" disabled={pending} onClick={() => setOpen(false)}>{tr('取消')}</button><button type="button" disabled={disabled || !canImport || pending || loading || !selected || !confirmed} onClick={() => void submit()}>{tr(pending ? '正在导入…' : '确认导入')}</button></div>
    </div></div>}
  </>;
}
