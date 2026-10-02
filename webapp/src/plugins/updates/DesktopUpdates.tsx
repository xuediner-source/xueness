import React, { useEffect, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { t } from '../../i18n';
import { startUpdateStatusPolling, updateActionAvailability } from './updateLifecycle';
import './DesktopUpdates.css';

type UpdateState = { phase: string; version?: string; currentVersion?: string; reason?: string; percent?: number; canDownload?: boolean; canInstall?: boolean; installMode?: string };
export function DesktopUpdates({ enabled, compact = false, onManage }: { enabled: boolean; compact?: boolean; onManage?: () => void }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [autoDownload, setAutoDownload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const stopPolling = startUpdateStatusPolling<UpdateState | null>({
      readStatus: () => get<UpdateState>('/api/updates/status'), compact,
      onStatus: next => { setState(next); setError(''); },
      onError: cause => setError(cause instanceof Error ? cause.message : t('检查失败')),
    });
    if (!compact) void get<{ autoDownload: boolean }>('/api/updates/settings').then(value => { if (active && typeof value.autoDownload === 'boolean') setAutoDownload(value.autoDownload); }).catch(() => {});
    return () => { active = false; stopPolling(); };
  }, [enabled, compact]);
  const action = async (name: string) => {
    if (!enabled || busy) return;
    setBusy(true); setError('');
    try { setState(await post<UpdateState>(`/api/updates/${name}`, ['download', 'install'].includes(name) ? { version: state?.version } : {})); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('更新操作失败')); }
    finally { setBusy(false); }
  };
  if (!enabled) return null;
  if (compact) return state && ['available', 'downloading', 'ready', 'error', 'installer_opened'].includes(state.phase) ? <aside className="xn-update-notice" role="status"><span>{state.version ? `Xueness ${state.version} · ` : ''}{state.reason}</span><button type="button" onClick={onManage}>{t('查看更新')}</button></aside> : null;
  const actions = updateActionAvailability(state, busy);
  return <section className="xn-desktop-updates" data-testid="desktop-updates"><h2>{t('应用更新')}</h2>
    <p>{t('启动时检查稳定版，此后定期检查。更新下载到客户端，安装前保留会话并检查运行中的任务。')}</p>
    <p>{t('当前版本')} {state?.currentVersion ?? '—'}{state?.version ? ` · ${t('更新版本')} ${state.version}` : ''}</p>
    <p role="status">{state?.reason ?? t('正在读取更新状态…')}</p>
    {state?.phase === 'downloading' && <progress max={100} value={state.percent ?? 0} aria-label={t('更新下载进度')} />}
    <label><input type="checkbox" checked={autoDownload} disabled={busy || state?.phase === 'unsupported'} onChange={event => {
      const value = event.target.checked; setBusy(true);
      void post('/api/updates/settings', { autoDownload: value }).then(() => setAutoDownload(value)).catch(cause => setError(String(cause))).finally(() => setBusy(false));
    }} />{t('自动下载稳定版更新')}</label>
    <div><button type="button" disabled={actions.checkDisabled} onClick={() => void action('check')}>{t('检查更新')}</button>
      <button type="button" disabled={actions.downloadDisabled} onClick={() => void action('download')}>{t('下载更新')}</button>
      <button type="button" disabled={actions.installDisabled} onClick={() => void action('install')}>{t(state?.installMode === 'open-dmg' ? '打开安装器' : '重启并更新')}</button>
      {state?.phase === 'downloading' && <button type="button" disabled={actions.cancelDisabled} onClick={() => void action('cancel')}>{t('取消下载')}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    <small>{t('macOS 未签名版本可在客户端下载并打开 DMG，仍需在 Finder 中完成替换。Windows 便携版需换用安装版。')}</small>
  </section>;
}
