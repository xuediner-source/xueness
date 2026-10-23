import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, Check, ChevronDown, Radio, RefreshCw } from 'lucide-react';
import { get } from '../../xuenessApi';
import { t as tr } from '../../i18n';
import { observationState, type ModelObservation } from './index';
import './model-monitor.css';

export type ModelMonitorHomeProps = {
  sessionId?: string; providerId?: string; requestedModel?: string; providerName?: string;
  running?: boolean; onOpenHistory: () => void;
};

/** Legacy global observations never become evidence for the active chat. */
export function latestSessionObservation(rows: ModelObservation[], sessionId?: string): ModelObservation | undefined {
  if (!sessionId) return undefined;
  return rows.slice().reverse().find(row => row.sessionId === sessionId);
}

export function ModelMonitorHome(props: ModelMonitorHomeProps) {
  const [snapshot, setSnapshot] = useState<{ sessionId?: string; rows: ModelObservation[] }>({ rows: [] });
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null), mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!props.sessionId || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    try {
      const payload = await get<{ observations: ModelObservation[] }>(`/api/model_monitor?session_id=${encodeURIComponent(props.sessionId)}`, controller.signal);
      if (mounted.current && !controller.signal.aborted) { setSnapshot({ sessionId: props.sessionId, rows: payload.observations }); setError(''); }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (pending.current === controller) pending.current = null; }
  }, [props.sessionId]);
  useEffect(() => {
    mounted.current = true; setError(''); void refresh();
    const timer = props.sessionId ? setInterval(() => { if (!document.hidden) void refresh(); }, 3000) : undefined;
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { mounted.current = false; clearInterval(timer); pending.current?.abort(); pending.current = null; document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, props.sessionId]);
  useEffect(() => { void refresh(); }, [props.running, refresh]);
  const row = snapshot.sessionId === props.sessionId ? latestSessionObservation(snapshot.rows, props.sessionId) : undefined;
  return <ModelMonitorHomeView {...props} observation={row} error={error} onRefresh={() => void refresh()} />;
}

export function ModelMonitorHomeView({ sessionId, providerId, requestedModel, providerName, running, onOpenHistory,
  observation, error = '', onRefresh }: ModelMonitorHomeProps & { observation?: ModelObservation; error?: string; onRefresh?: () => void }) {
  const row = observation?.sessionId === sessionId && sessionId ? observation : undefined;
  const state = row ? observationState(row) : 'ready';
  const changed = Boolean(row && ((requestedModel !== undefined && row.requestedModel !== requestedModel)
    || (providerId !== undefined && row.providerId !== providerId)));
  const requestFailed = row?.outcome === 'error' && !running;
  const hasError = Boolean(error || requestFailed);
  const label = error ? '监测暂不可用' : running ? '正在等待本轮响应' : requestFailed ? '本次请求未完成，未获得可用的返回型号。' : state === 'same' ? '型号一致'
    : state === 'different' ? '返回型号不同' : state === 'unreported' ? '未报告型号' : '监测已就绪';
  const requested = row?.requestedModel || requestedModel || tr('尚未选择模型');
  const returned = row?.returnedModels.length ? row.returnedModels.join(' · ') : tr(row ? '上游未返回型号' : '等待会话响应');
  return <section className={`xn-model-monitor-home is-${state}${hasError ? ' is-error' : ''}${sessionId ? ' has-session' : ''}`} data-testid="model-monitor-home" data-state={state} data-outcome={row?.outcome} aria-label={tr('返回模型监测')}>
    <div className="xn-model-monitor-home__heading">
      <span className="xn-model-monitor-home__icon" aria-hidden="true"><Activity size={15} /></span>
      <strong className="xn-model-monitor-home__title">{tr('返回模型监测')}</strong>
      <span className="xn-model-monitor-home__status" role="status">{state === 'same' && !running && !hasError ? <Check size={13} aria-hidden="true" /> : hasError ? <AlertTriangle size={13} aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}{tr(label)}</span>
      <div className="xn-model-monitor-home__route" title={`${tr('请求模型')}: ${requested} → ${tr('返回模型')}: ${returned}`}>
        <code title={requested}>{requested}</code><ArrowRight size={13} aria-hidden="true" /><code title={returned}>{returned}</code>
      </div>
      <button type="button" className="xn-model-monitor-home__history" onClick={onOpenHistory} title={tr('查看监测记录')}>{tr('记录')}<ArrowRight size={14} aria-hidden="true" /></button>
    {(row || error) && <details className="xn-model-monitor-home__details" key={row?.id ?? 'error'} open={hasError ? true : undefined}>
      <summary>{tr('响应详情')}<ChevronDown size={13} aria-hidden="true" /></summary>
      <div>
        {error ? <p role="alert">{error}</p> : <>
          <div className="xn-model-monitor-home__models">
            <div><span>{tr('请求模型')}</span><code title={requested}>{requested}</code></div>
            <ArrowRight className="xn-model-monitor-home__expanded-route" size={15} aria-hidden="true" />
            <div><span>{tr('返回模型')}</span><code title={returned}>{returned}</code></div>
          </div>
          <p>{tr(row?.outcome === 'error' ? '本次请求未完成，未获得可用的返回型号。'
            : state === 'different' ? '返回字段与请求型号不同，可能是别名或上游路由；不据此推断底层模型。' : state === 'unreported' ? '上游没有提供返回型号，暂时无法比较。' : '请求型号与接口返回字段一致。')}</p>
          {changed && <p>{tr('模型选择已更改，以上展示本会话的上次响应。')}{requestedModel && <code>{requestedModel}</code>}</p>}
          <small>{providerName && !changed ? providerName : row?.providerId || tr('环境模型')} · {row?.protocol} · <time dateTime={row?.at}>{row?.at && new Date(row.at).toLocaleString()}</time></small>
        </>}
        {onRefresh && <button type="button" onClick={onRefresh}><RefreshCw size={12} aria-hidden="true" />{tr('刷新')}</button>}
      </div>
    </details>}
    </div>
  </section>;
}
