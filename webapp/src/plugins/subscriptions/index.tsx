import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, KeyRound, LoaderCircle, LogIn, RefreshCw, Search, ShieldCheck, Unplug } from 'lucide-react';
import { t as tr, tf, useLocale } from '../../i18n';
import { accountAction, listAccounts, loginStatus, parseModelIds, remainingPercent, safeAuthorizeUrl, type LoginStatus, type Quota, type SubscriptionAccount } from './api';
import './subscriptions.css';

const labels = { oauth: '账号授权', local: '订阅凭证' };
export function filterAccounts(accounts: SubscriptionAccount[], query: string, group: string): SubscriptionAccount[] {
  const needle = query.trim().toLowerCase();
  return accounts.filter(account => (group === 'all' || group === 'connected' && account.connected || account.mode === group)
    && [account.name, account.nameEn, account.id, account.help, account.helpEn, ...(account.tags ?? [])].filter(Boolean).join(' ').toLowerCase().includes(needle));
}
function number(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
export function QuotaCard({ quota }: { quota: Quota | null }) {
  if (!quota) return <p className="xn-subscriptions__muted">{tr('尚未查询额度')}</p>;
  return <div className="xn-subscriptions__quota" data-testid="subscription-quota">
    {!quota.supported || !quota.windows.length ? <p className="xn-subscriptions__muted">{tr('暂不可查询：上游未提供可用额度数据。')}</p> : quota.windows.map((window, index) => {
      const remaining = window.usedPercent === undefined ? undefined : remainingPercent(window.usedPercent);
      const windowLabel = tr(({ session: '短时额度', weekly: '每周额度', daily: '每日额度', monthly: '每月额度', lifetime: '账户余额', other: '额度' } as Record<string, string>)[window.kind] ?? '额度');
      return <div className="xn-subscriptions__quota-window" key={index}>
        <div><span>{windowLabel}{window.scope ? ` · ${window.scope}` : ''}</span>
          {remaining !== undefined ? <strong>{tf('剩余 {0}%', [number(remaining)])}</strong> : window.remaining !== undefined ? <strong>{number(window.remaining)} {window.unit ?? ''}</strong> : window.usedUsd !== undefined ? <strong>{tf('已使用 ${0}', [number(window.usedUsd)])}</strong> : null}</div>
        {remaining !== undefined && <progress aria-label={windowLabel} value={remaining} max={100} />}
        {window.resetsAt !== undefined && <small>{tf('重置：{0}', [new Date(window.resetsAt).toLocaleString()])}</small>}
        {window.limit !== undefined && <small>{tf('上限：{0}', [number(window.limit)])} {window.unit ?? ''}</small>}
      </div>;
    })}
    <small className="xn-subscriptions__muted">{quota.plan ? `${quota.plan} · ` : ''}{tf('查询于 {0}', [new Date(quota.checkedAt).toLocaleString()])}</small>
  </div>;
}

export function SubscriptionsPanel({ onChanged, onSelectModel, embedded = false }: { onChanged?: () => void; onSelectModel?: (id: string) => void; embedded?: boolean }) {
  const locale = useLocale();
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([]), [selected, setSelected] = useState('codex');
  const [query, setQuery] = useState(''), [group, setGroup] = useState('all');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [flow, setFlow] = useState<LoginStatus | null>(null), [disconnect, setDisconnect] = useState(false);
  const [token, setToken] = useState(''), [userId, setUserId] = useState(''), [models, setModels] = useState(''), [callback, setCallback] = useState('');
  const mounted = useRef(false), inFlight = useRef<AbortController | null>(null), polling = useRef<AbortController | null>(null);
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const account = accounts.find(row => row.id === selected);
  const visible = useMemo(() => filterAccounts(accounts, query, group), [accounts, query, group]);
  const displayName = (row: SubscriptionAccount) => locale === 'en' ? row.nameEn ?? row.name : row.name;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try { const payload = await listAccounts(signal); if (mounted.current && !signal?.aborted) setAccounts(payload.accounts); }
    catch (reason) { if (mounted.current && !signal?.aborted) setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { if (mounted.current && !signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); void refresh(controller.signal);
    return () => { mounted.current = false; controller.abort(); inFlight.current?.abort(); polling.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    setToken(''); setUserId(''); setCallback(''); setFlow(null); setDisconnect(false); setError(''); setNotice('');
    setModels(account?.models.map(model => model.id).join('\n') ?? '');
    const controller = new AbortController();
    if (account?.mode === 'oauth') void loginStatus(selected, controller.signal).then(result => {
      if (!controller.signal.aborted && mounted.current && result.status.busy) setFlow(result.status);
    }).catch(() => {});
    return () => { controller.abort(); };
  }, [selected, Boolean(account)]);
  useEffect(() => {
    if (!flow?.busy) return;
    const controller = new AbortController(); polling.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined; const deadline = Date.now() + 190_000;
    const poll = async () => {
      try {
        const payload = await loginStatus(selected, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setAccounts(current => current.map(row => row.id === selected ? payload.account : row));
        setFlow(payload.status);
        if (!payload.status.busy) {
          if (payload.status.detail) setError(payload.status.detail);
          if (payload.account.connected) { setNotice(tr('账号已接入，可以选择模型用于会话。')); changedRef.current?.(); }
          return;
        }
      } catch (reason) {
        if (controller.signal.aborted || !mounted.current) return;
        setError(reason instanceof Error ? reason.message : String(reason)); setFlow(null); return;
      }
      if (Date.now() < deadline) timer = setTimeout(() => void poll(), 1500);
      else setFlow(null);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { controller.abort(); if (timer) clearTimeout(timer); if (polling.current === controller) polling.current = null; };
  }, [selected, flow?.busy]);
  const run = async (action: string, body: object = {}) => {
    if (busy || !account) return;
    const controller = new AbortController(); inFlight.current = controller;
    setBusy(action); setError(''); setNotice('');
    try {
      const payload = await accountAction(selected, action, body, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setAccounts(payload.accounts); setToken(''); setUserId(''); setDisconnect(false);
      if (action === 'login') setFlow({ ...payload.result, busy: Boolean(payload.result.authorizeUrl || payload.result.busy) });
      else if (action === 'cancel' || action === 'disconnect') { setFlow(null); setCallback(''); }
      if (action === 'models') setModels(payload.accounts.find(row => row.id === selected)?.models.map(model => model.id).join('\n') ?? '');
      setNotice(tr(action === 'disconnect' ? '已移除本机接入。' : action === 'cancel' ? '授权已取消。' : action === 'login' && payload.result.authorizeUrl ? '打开授权页面完成登录。' : action === 'quota' ? '额度查询已更新。' : '接入信息已更新。'));
      changedRef.current?.();
    } catch (reason) { if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current && !controller.signal.aborted) setBusy(''); if (inFlight.current === controller) inFlight.current = null; }
  };
  const authorize = safeAuthorizeUrl(flow?.authorizeUrl);
  return <section className="xn-subscriptions" data-testid="subscriptions-panel">
    {!embedded && <header className="xn-subscriptions__header"><div><h2>{tr('订阅中心')}</h2><p>{tr('通过账号授权或订阅凭证接入，查看额度并用于会话。')}</p></div>
      <button type="button" disabled={loading || Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{tr('刷新')}</button></header>
    }
    <div className="xn-subscriptions__toolbar"><label><Search size={15} aria-hidden="true" /><input aria-label={tr('搜索上游供应商')} placeholder={tr('搜索订阅账号供应商')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label={tr('接入类型')} value={group} onChange={event => setGroup(event.target.value)}><option value="all">{tf('全部（{0}）', [accounts.length])}</option><option value="connected">{tr('已接入')}</option>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{tr(label)}</option>)}</select>
      {embedded && <button type="button" disabled={loading || Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{tr('刷新')}</button>}
    </div>
    {loading && !accounts.length && <p role="status">{tr('正在加载供应商…')}</p>}
    {!loading && !accounts.length && error && <p className="xn-subscriptions__error" role="alert">{error}</p>}
    {accounts.length > 0 && <div className="xn-subscriptions__layout"><nav className="xn-subscriptions__providers" aria-label={tr('上游供应商')}>
      {!visible.length && <p className="xn-subscriptions__muted">{tr('没有匹配的供应商')}</p>}
      {visible.map(row => <button type="button" key={row.id} data-testid={`subscription-provider-${row.id}`} aria-pressed={row.id === selected} disabled={Boolean(busy)} onClick={() => setSelected(row.id)}>
        <span><strong>{displayName(row)}</strong><small>{tr(labels[row.mode])}</small></span><i className={row.connected ? 'is-connected' : ''} aria-label={tr(row.connected ? '已接入' : '未接入')} /></button>)}
    </nav>{account && <article className="xn-subscriptions__detail" key={selected}>
      <header className="xn-subscriptions__account-heading"><div><h3 title={displayName(account)}>{displayName(account)}</h3><p>{account.account || tr(labels[account.mode])}</p></div><span className={`xn-subscriptions__badge ${account.connected ? 'is-connected' : ''}`}>{account.connected ? <Check size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}{tr(account.connected ? '已接入' : account.expired ? '登录已过期' : '未接入')}</span></header>
      <p className="xn-subscriptions__help">{locale === 'en' ? account.helpEn ?? tr('使用账号授权、CLI 登录或订阅账号凭证接入。') : account.help ?? tr('使用账号授权、CLI 登录或订阅账号凭证接入。')}</p>
      {error && <p className="xn-subscriptions__error" role="alert">{error}</p>}{notice && <p className="xn-subscriptions__notice" role="status">{notice}</p>}
      <div className="xn-subscriptions__actions">
        {account.mode === 'oauth' && account.loginMethod !== 'cli' && <button type="button" disabled={Boolean(busy) || flow?.busy} onClick={() => void run('login')}><LogIn size={15} aria-hidden="true" />{tr(account.connected ? '重新授权' : '登录账号')}</button>}
        {account.importSupport && <button type="button" disabled={Boolean(busy) || flow?.busy} onClick={() => void run('import')}><LogIn size={15} aria-hidden="true" />{tr(account.transport === 'qoder' ? '导入环境登录凭证' : '导入本机登录')}</button>}
        {flow?.busy && <button type="button" disabled={Boolean(busy)} onClick={() => void run('cancel')}>{tr('取消授权')}</button>}
        {busy && <span role="status"><LoaderCircle size={15} aria-hidden="true" className="is-spinning" />{tr('处理中…')}</span>}
      </div>
      {flow?.busy && <div className="xn-subscriptions__login" role="status">
        <p>{tr('等待账号授权…')}</p>{authorize && <a href={authorize} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />{tr('打开授权页面')}</a>}
        {flow.userCode && <p>{tr('设备码：')}<code>{flow.userCode}</code></p>}
        {!flow.userCode && <form onSubmit={event => { event.preventDefault(); void run('manual', { callback }); }}><label>{tr('浏览器未自动回到应用时，粘贴完整回调地址')}<input value={callback} onChange={event => setCallback(event.target.value)} autoComplete="off" /></label><button type="submit" disabled={!callback.trim() || Boolean(busy)}>{tr('完成授权')}</button></form>}
      </div>}
      {account.transport === 'qoder' && <form className="xn-subscriptions__form" onSubmit={event => { event.preventDefault(); void run('connect', { accessToken: token, userId }); }}>
        <label>{tr('账号登录 Token')}<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="new-password" required={!account.credentialsSaved} placeholder={tr(account.credentialsSaved ? '已保存，留空保留' : '填写订阅账号的登录凭证')} disabled={Boolean(busy)} /></label>
        <label>{tr('账号 User ID')}<input value={userId} onChange={event => setUserId(event.target.value)} autoComplete="off" required={!account.hasUserId} placeholder={account.hasUserId ? tr('已保存，留空保留') : 'Qoder User ID'} disabled={Boolean(busy)} /></label>
        <button type="submit" disabled={Boolean(busy)}><ShieldCheck size={15} aria-hidden="true" />{tr('保存订阅凭证')}</button>
      </form>}
      {account.connected && <>
        <section className="xn-subscriptions__section"><header><h4>{tr('上游额度')}</h4><button type="button" disabled={Boolean(busy)} onClick={() => void run('quota')}><RefreshCw size={14} aria-hidden="true" />{tr('查询额度')}</button></header><QuotaCard quota={account.quota} /></section>
        <section className="xn-subscriptions__section"><header><h4>{tr('会话模型')}</h4><button type="button" disabled={Boolean(busy)} onClick={() => void run('models')}><RefreshCw size={14} aria-hidden="true" />{tr('发现模型')}</button></header>
          <p className="xn-subscriptions__muted">{tr('预置型号仅供选择，是否可用取决于套餐；可发现实际型号或手动指定。')}</p>
          {account.models.length ? <ul className="xn-subscriptions__models">{account.models.map(model => <li key={model.id}><span><strong>{model.name}</strong><code title={model.id}>{model.id}</code><small>{tr(model.source === 'upstream' ? '上游返回' : model.source === 'manual' ? '手动指定' : '预置型号')}</small></span><button type="button" disabled={Boolean(busy) || !onSelectModel} onClick={() => onSelectModel?.(model.providerId)}>{tr('用于会话')}</button></li>)}</ul> : <p className="xn-subscriptions__muted">{tr('先发现模型或填写型号，再用于会话。')}</p>}
          <details><summary>{tr('手动指定型号')}</summary><form onSubmit={event => { event.preventDefault(); void run('set-models', { models: parseModelIds(models) }); }}><label>{tr('模型 ID（每行一个）')}<textarea rows={3} value={models} onChange={event => setModels(event.target.value)} /></label><button type="submit" disabled={Boolean(busy) || !parseModelIds(models).length}>{tr('保存型号')}</button></form></details>
        </section>
        <div className="xn-subscriptions__disconnect">{disconnect ? <><span>{tr('移除本应用保存的接入？')}</span><button type="button" disabled={Boolean(busy)} onClick={() => void run('disconnect')}>{tr('确认移除')}</button><button type="button" onClick={() => setDisconnect(false)}>{tr('取消')}</button></> : <button type="button" disabled={Boolean(busy)} onClick={() => setDisconnect(true)}><Unplug size={14} aria-hidden="true" />{tr('移除接入')}</button>}</div>
      </>}
    </article>}</div>}
  </section>;
}
