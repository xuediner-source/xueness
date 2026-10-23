import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, Search, Trash2 } from 'lucide-react';
import { get, post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import './model-monitor.css';

export type ModelObservation = { id: string; at: string; sessionId?: string; providerId: string; requestedModel: string; returnedModels: string[]; protocol: string; outcome: 'success' | 'error' };
export function observationState(row: ModelObservation): 'same' | 'different' | 'unreported' {
  if (!row.returnedModels.length) return 'unreported';
  return row.returnedModels.every(model => model === row.requestedModel) ? 'same' : 'different';
}
export function filterObservations(rows: ModelObservation[], query: string, filter: string) {
  const needle = query.trim().toLowerCase();
  return rows.filter(row => (filter === 'all' || observationState(row) === filter)
    && [row.providerId, row.requestedModel, ...row.returnedModels].join(' ').toLowerCase().includes(needle)).slice().reverse();
}
export function ModelMonitorPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<ModelObservation[]>([]), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [clearing, setClearing] = useState(false), [confirm, setConfirm] = useState(false);
  const active = useRef(false), pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async (quiet = false) => {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    if (!quiet) setLoading(true);
    try { const payload = await get<{ observations: ModelObservation[] }>('/api/model_monitor', controller.signal);
      if (active.current && !controller.signal.aborted) { setRows(payload.observations); setError(''); } }
    catch (reason) { if (active.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (pending.current === controller) pending.current = null; if (active.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { active.current = true; void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(true); }, 5000);
    return () => { active.current = false; clearInterval(timer); pending.current?.abort(); pending.current = null; }; }, [refresh]);
  const clear = async () => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setClearing(true); setError('');
    try { await post('/api/model_monitor/clear', { confirmed: true }, controller.signal); if (active.current && !controller.signal.aborted) { setRows([]); setConfirm(false); } }
    catch (reason) { if (active.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (pending.current === controller) pending.current = null; if (active.current && !controller.signal.aborted) setClearing(false); }
  };
  const visible = useMemo(() => filterObservations(rows, query, filter), [rows, query, filter]);
  return <section className={`xn-model-monitor${embedded ? ' xn-model-monitor--embedded' : ''}`} data-testid="model-monitor-panel">
    {!embedded && <header className="xn-model-monitor__header"><div><h2>{tr('返回模型监测')}</h2><p>{tr('随会话对比请求型号与接口返回型号，不发送额外模型请求。')}</p></div><button type="button" disabled={loading || clearing} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{tr('刷新')}</button></header>}
    <div className="xn-model-monitor__toolbar"><label><Search size={15} aria-hidden="true" /><input aria-label={tr('搜索监测记录')} placeholder={tr('搜索供应商或型号')} value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label={tr('型号匹配状态')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{tf('全部（{0}）', [rows.length])}</option><option value="different">{tr('返回型号不同')}</option><option value="same">{tr('型号一致')}</option><option value="unreported">{tr('未报告型号')}</option></select>
      {embedded && <button type="button" disabled={loading || clearing} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{tr('刷新')}</button>}
    </div>
    {error && <p className="xn-model-monitor__error" role="alert">{error}</p>}
    {!rows.length && !error && <div className="xn-model-monitor__empty" role="status"><h3>{tr(loading ? '正在加载监测记录…' : '等待下一次会话响应')}</h3><p>{tr('启用后自动记录新响应。历史会话中的型号不会被猜测补填。')}</p></div>}
    {rows.length > 0 && !visible.length && <p role="status">{tr('没有匹配的监测记录')}</p>}
    <div className="xn-model-monitor__records">{visible.map(row => { const state = observationState(row);
      return <article className={`xn-model-monitor__record is-${state}`} key={row.id} data-testid="model-observation" data-state={state}>
        <div className="xn-model-monitor__meta"><span>{row.providerId || tr('环境模型')}</span><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></div>
        <dl><div className="xn-model-monitor__record-status"><dt>{tr('状态')}</dt><dd><span className="xn-model-monitor__badge">{state === 'same' ? <Check size={14} aria-hidden="true" /> : state === 'different' ? <AlertTriangle size={14} aria-hidden="true" /> : null}{tr(state === 'same' ? '型号一致' : state === 'different' ? '返回型号不同' : '未报告型号')}</span></dd></div>
          <div><dt>{tr('请求模型')}</dt><dd><code>{row.requestedModel || '—'}</code></dd></div><div><dt>{tr('返回模型')}</dt><dd>{row.returnedModels.length ? row.returnedModels.map(model => <code className="xn-model-monitor__returned" key={model}>{model}</code>) : <span className="xn-model-monitor__muted">{tr('上游未返回型号')}</span>}</dd></div></dl>
        {state === 'different' && <p className="xn-model-monitor__explanation">{tr('接口返回的型号与请求不同，可能涉及别名或服务端路由。此记录来自响应字段，不能单独证明底层模型或灰度版本。')}</p>}
        {state === 'unreported' && <p className="xn-model-monitor__explanation">{tr(row.outcome === 'error' ? '本次请求未完成，未获得可用的返回型号。' : '上游没有提供返回型号，暂时无法比较。')}</p>}
      </article>;
    })}</div>
    {rows.length > 0 && <footer className="xn-model-monitor__footer"><small>{tr('保留最近 200 条本机记录，仅保存型号与时间。')}</small>{confirm ? <><span>{tr('清空监测记录？')}</span><button type="button" disabled={clearing} onClick={() => void clear()}>{tr('确认清空')}</button><button type="button" disabled={clearing} onClick={() => setConfirm(false)}>{tr('取消')}</button></> : <button type="button" onClick={() => setConfirm(true)}><Trash2 size={14} aria-hidden="true" />{tr('清空记录')}</button>}</footer>}
  </section>;
}
