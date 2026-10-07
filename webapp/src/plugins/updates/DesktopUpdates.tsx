import React, { useEffect, useState } from 'react';
import { CircleArrowUp, LoaderCircle } from 'lucide-react';
import { get, post } from '../../xuenessApi';
import { t, tf } from '../../i18n';
import { startUpdateStatusPolling, updateActionAvailability } from './updateLifecycle';
import './DesktopUpdates.css';

type UpdateState = { phase: string; version?: string; currentVersion?: string; reason?: string; percent?: number; canDownload?: boolean; canInstall?: boolean; installMode?: string; transferredBytes?: number | null; totalBytes?: number | null; bytesPerSecond?: number | null; etaSeconds?: number | null };

function measured(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0);
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Display only observed metrics. Older clients and missing samples stay indeterminate. */
export function UpdateDownloadProgress({ state }: { state: UpdateState }) {
  if (state.phase !== 'downloading') return null;
  const transferred = measured(state.transferredBytes) ? state.transferredBytes : null;
  const total = measured(state.totalBytes, true) && (transferred === null || transferred <= state.totalBytes) ? state.totalBytes : null;
  const speed = measured(state.bytesPerSecond) ? state.bytesPerSecond : null;
  const eta = total !== null && speed !== null && speed > 0 && measured(state.etaSeconds) ? state.etaSeconds : null;
  const percent = measured(state.percent) && state.percent <= 100 ? state.percent : null;
  return <div className="xn-desktop-updates__download" data-testid="update-download-progress">
    <progress max={100} value={percent ?? undefined} aria-label={t('更新下载进度')} />
    <div className="xn-desktop-updates__metrics">
      <span>{transferred === null ? t('正在读取下载进度…') : total === null ? tf('已下载 {0}', [bytesLabel(transferred)]) : `${bytesLabel(transferred)} / ${bytesLabel(total)}`}</span>
      <span>{percent === null ? '—' : `${percent.toFixed(1)}%`}</span>
      <span>{speed === null ? t('正在测量下载速度…') : `${bytesLabel(speed)}/s`}</span>
      <span>{eta === null ? t('剩余时间待估算') : eta < 60 ? tf('预计剩余 {0} 秒', [Math.ceil(eta)]) : tf('预计剩余约 {0} 分钟', [Math.ceil(eta / 60)])}</span>
    </div>
    <small>{t('从 GitHub 下载，显示网络传输量；差量更新会复用本地数据。剩余时间为估算，速度取决于当前网络。')}</small>
  </div>;
}

const UPDATE_IN_PROGRESS_PHASES = ['available', 'downloading', 'ready', 'installing', 'opening-installer', 'installer_opened'];

/** The authenticated host reports installation support; avoid guessing it from the browser OS. */
export function UpdateInstallationHelp({ installMode }: { installMode?: string }) {
  const message = installMode === 'open-dmg'
    ? '更新下载到客户端，打开 DMG 后请在 Finder 中将 Xueness 替换到应用程序文件夹。'
    : installMode === 'restart'
      ? '更新下载到客户端，结束运行中的任务后点击“重启并更新”完成安装。会话和设置会保留。'
      : installMode === 'unsupported'
        ? '当前运行方式不支持应用内安装更新。Windows 请使用安装版，源码运行请更新源码。'
        : '正在确认当前客户端的更新安装方式…';
  return <small data-testid="update-installation-help">{t(message)}</small>;
}

function compareStableVersions(candidate: unknown, current: unknown): number | null {
  const parse = (value: unknown): number[] | null => {
    if (typeof value !== 'string') return null;
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    return match ? match.slice(1).map(Number) : null;
  };
  const next = parse(candidate);
  const installed = parse(current);
  if (!next || !installed) return null;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > installed[index]) return 1;
    if (next[index] < installed[index]) return -1;
  }
  return 0;
}

function hasKnownUpdate(state: UpdateState | null): boolean {
  if (!state || ['disabled', 'unsupported', 'current'].includes(state.phase)) return false;
  const versionRelation = compareStableVersions(state.version, state.currentVersion);
  // Rechecks preserve the last accepted candidate version. Keep the entry
  // visible during those checks only when that version still proves an update.
  if (state.phase === 'checking') return versionRelation === 1;
  if (UPDATE_IN_PROGRESS_PHASES.includes(state.phase)) {
    // The coordinator phase itself confirms discovery; use version fields to
    // reject contradictory or stale status when both versions are available.
    return versionRelation === null || versionRelation > 0;
  }
  // A failed or cancelled operation remains actionable only when its status
  // still carries a version newer than the installed one.
  return ['error', 'cancelled'].includes(state.phase) && versionRelation === 1;
}

export function DesktopUpdateIndicator({ state, failed = false, onManage }: { state: UpdateState | null; failed?: boolean; onManage?: () => void }) {
  if (!hasKnownUpdate(state)) return null;
  const phase = failed ? 'error' : state?.phase ?? 'idle';
  const pending = ['available', 'ready', 'installer_opened'].includes(phase);
  const working = ['checking', 'downloading', 'installing', 'opening-installer'].includes(phase);
  const status = phase === 'error' ? t('检查失败') : phase === 'ready'
    ? state?.installMode === 'open-dmg' ? t('打开安装器') : t('重启并更新')
    : phase === 'downloading' ? t('更新下载进度') : phase === 'available' ? t('下载更新')
    : phase === 'installer_opened' ? t('打开安装器') : working ? t('检查更新') : '';
  const label = [t('应用更新'), state?.version ? `Xueness ${state.version}` : '', status].filter(Boolean).join(' · ');
  return <button type="button" className="xn-sidebar-footer__action xn-update-indicator" onClick={onManage}
    aria-label={label} title={label} data-sidebar-navigate="true" data-testid="desktop-update-indicator"
    data-pending={pending || undefined} data-error={phase === 'error' || undefined}>
    {working ? <LoaderCircle size={16} className="xn-update-indicator__spinner" aria-hidden="true" /> : <CircleArrowUp size={16} aria-hidden="true" />}
    <span className="xn-update-indicator__dot" aria-hidden="true" />
  </button>;
}
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
  if (compact) return <DesktopUpdateIndicator state={state} failed={Boolean(error)} onManage={onManage} />;
  const actions = updateActionAvailability(state, busy);
  return <section className="xn-desktop-updates" data-testid="desktop-updates"><h2>{t('应用更新')}</h2>
    <p>{t('启动时检查稳定版，此后定期检查。更新下载到客户端，安装前保留会话并检查运行中的任务。')}</p>
    <p>{t('当前版本')} {state?.currentVersion ?? '—'}{state?.version ? ` · ${t('更新版本')} ${state.version}` : ''}</p>
    <p role="status">{t(state?.reason ?? '正在读取更新状态…')}</p>
    {state && <UpdateDownloadProgress state={state} />}
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
    <UpdateInstallationHelp installMode={state?.installMode} />
  </section>;
}
