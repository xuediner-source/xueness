import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, Cpu, HardDrive, MemoryStick, Pause, Play, RefreshCw } from 'lucide-react';
import { startRuntimeSampling } from './runtimeSampling';
import { t } from '../../i18n';
import '../../styles/local-runtime-monitor.css';

export type RuntimeActivity = {
  phase: string;
  startedAt?: string;
  requestStep?: number;
  outputChars?: number;
  reasoningChars?: number;
  firstOutputSeconds?: number;
  firstReasoningSeconds?: number;
  requestSeconds?: number;
  charactersPerSecond?: number;
  reportedOutputTokens?: number;
  tokensPerSecond?: number;
  reportedInputTokens?: number;
  reportedCachedTokens?: number;
  reportedReasoningTokens?: number;
  terminationReason?: string;
  retryCount?: number;
  waitingSeconds?: number;
  thinkingSeconds?: number;
  generatingSeconds?: number;
  toolSeconds?: number;
};

export type LocalRuntimeSession = {
  runtime_profile?: string | null;
  runtime_budget?: {
    profile?: string;
    contextWindow?: number;
    inputBudgetTokens?: number;
    estimatedInputTokens?: number;
    reservedOutputTokens?: number;
    safetyReserveTokens?: number;
    previousEstimatedTokens?: number;
    omittedMessages?: number;
    activeTools?: number;
    calibrationFactor?: number;
  } | null;
  runtime_activity?: RuntimeActivity | null;
  runtime_activity_history?: RuntimeActivity[] | null;
  tool_timings?: { step: number; name: string; tool_call_id: string; seconds: number; ok: boolean }[];
};

export function RequestTiming({ session }: { session: LocalRuntimeSession | null }) {
  const rows = session?.runtime_activity_history ?? [];
  if (!rows.length) return null;
  return <details className="xn-runtime-monitor__timings"><summary>{t('步骤耗时与实际用量')}</summary>
    <p>{t('等待、思考和生成按收到流数据的时段计时，包含传输等待；非流式请求无法拆分思考与生成。缺失 Token 和重试信息显示 —。')}</p>
    <div style={{ overflowX: 'auto' }}><table><thead><tr>{['步骤', '模型请求', '等待', '思考流', '生成流', '工具', '输入 Token', '缓存 Token', '输出 Token', '失败重试'].map(label => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.startedAt ?? index}><td>#{row.requestStep ?? index + 1}</td>
        {[row.requestSeconds, row.waitingSeconds, row.thinkingSeconds, row.generatingSeconds, row.toolSeconds].map((seconds, i) => <td key={i}>{finite(seconds) ? `${seconds.toFixed(2)} s` : '—'}</td>)}
        {[row.reportedInputTokens, row.reportedCachedTokens, row.reportedOutputTokens, row.retryCount].map((count, i) => <td key={i}>{formatCount(count)}</td>)}
      </tr>)}</tbody></table></div>
    {session?.tool_timings?.length ? <ul>{session.tool_timings.slice(-30).map((tool, i) => <li key={`${tool.tool_call_id}-${i}`}>#{tool.step} · {tool.name} · {tool.seconds.toFixed(3)} s · {t(tool.ok ? '执行成功' : '执行未成功')}</li>)}</ul> : null}
  </details>;
}

export type RuntimeMetrics = {
  schema: 'xueness.runtime-metrics.v1';
  sampledAtISO: string;
  samplingSeconds: number;
  cpu: {
    logicalCores: number | null;
    loadAverage: [number | null, number | null, number | null];
    processPercent: number | null;
  };
  memory: {
    totalBytes: number | null;
    availableBytes: number | null;
    availableKind: 'kernel_estimate' | 'free_plus_reclaimable_estimate' | null;
    processRssBytes: number | null;
  };
  disk: { totalBytes: number | null; availableBytes: number | null };
  gpu: { available: false; reason: string };
};

const PHASE_LABELS: Record<string, string> = {
  waiting_model: '等待模型', thinking: '思考', generating: '生成', tools: '工具调用',
  repairing: '修复', completed: '已完成', needs_review: '需要审核', paused: '已暂停',
  stopped: '已停止', stalled: '运行停滞', awaiting_user: '等待用户', provider_error: '供应商错误',
  interrupted: '已中断',
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatRuntimeBytes(value: number | null | undefined): string {
  if (!finite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 'B';
  for (const next of units) {
    scaled /= 1024;
    unit = next;
    if (scaled < 1024 || next === units[units.length - 1]) break;
  }
  return `${scaled.toFixed(1)} ${unit}`;
}

function formatCount(value: number | null | undefined): string {
  return finite(value) ? Math.round(value).toLocaleString() : '—';
}

function formatRate(value: number | null | undefined, suffix: string): string {
  return finite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${t(suffix)}` : '—';
}

function percentage(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (!finite(numerator) || !finite(denominator) || denominator <= 0) return null;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

export function estimatedMemoryUsedBytes(totalBytes: number | null | undefined, availableBytes: number | null | undefined): number | null {
  return finite(totalBytes) && finite(availableBytes) ? Math.max(0, totalBytes - availableBytes) : null;
}

export function memoryAvailabilityExplanation(kind: RuntimeMetrics['memory']['availableKind']): string {
  if (kind === 'kernel_estimate') return t('可用内存为内核估计');
  if (kind === 'free_plus_reclaimable_estimate') return t('可用内存含可回收估算');
  return '';
}

type TrendPoint = { x: number; y: number; title: string };

export function runtimeCharacterTrend(history: RuntimeActivity[] | null | undefined): TrendPoint[] {
  const recent = (Array.isArray(history) ? history : []).slice(-24).filter(item => finite(item.charactersPerSecond));
  if (!recent.length) return [];
  const max = Math.max(1, ...recent.map(item => item.charactersPerSecond as number));
  return recent.map((item, index) => ({
    x: recent.length === 1 ? 120 : 8 + (index * 224) / (recent.length - 1),
    y: 42 - ((item.charactersPerSecond as number) / max) * 34,
    title: [
      item.requestStep === undefined ? '' : `#${item.requestStep}`,
      `${formatRate(item.charactersPerSecond, '字符/秒')}`,
      item.outputChars === undefined ? '' : `${formatCount(item.outputChars)} ${t('输出字符')}`,
      finite(item.reportedOutputTokens) ? `${formatCount(item.reportedOutputTokens)} ${t('输出 Token')} · ${formatRate(item.tokensPerSecond, 'Token/秒')}` : '',
    ].filter(Boolean).join(' · '),
  }));
}

function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <div className="xn-runtime-monitor__meter xn-runtime-monitor__meter--empty" aria-label={`${label}: —`} />;
  return <div className="xn-runtime-monitor__meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
    <span style={{ width: `${value}%` }} />
  </div>;
}

function MetricCard({ icon, label, value, detail, percent }: {
  icon: React.ReactNode; label: string; value: string; detail?: string; percent?: number | null;
}) {
  return <article className="xn-runtime-monitor__metric">
    <header>{icon}<span>{label}</span></header>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
    {percent !== undefined && <Meter value={percent} label={label} />}
  </article>;
}

function dateLabel(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

function RuntimeActivityView({ session }: { session: LocalRuntimeSession | null }) {
  const activity = session?.runtime_activity ?? null;
  const history = session?.runtime_activity_history ?? [];
  const budget = session?.runtime_budget ?? null;
  const trend = useMemo(() => runtimeCharacterTrend(history), [history]);
  const inputPercent = percentage(budget?.estimatedInputTokens, budget?.inputBudgetTokens);
  const phase = activity?.phase;
  const phaseLabel = phase ? t(PHASE_LABELS[phase] ?? phase) : t('暂无输出活动数据');

  return <section className="xn-runtime-monitor__activity" aria-label={t('轻量输出状态')}>
    <header className="xn-runtime-monitor__section-heading"><Activity size={15} /><h3>{t('轻量输出状态')}</h3></header>
    {activity ? <>
      <div className="xn-runtime-monitor__activity-head">
        <strong className={`xn-runtime-monitor__phase xn-runtime-monitor__phase--${phase ?? 'unknown'}`}>{phaseLabel}</strong>
        <span>{activity.startedAt ? `${t('开始时间')} ${dateLabel(activity.startedAt)}` : ''}</span>
        {finite(activity.requestStep) && <span>{t('请求轮次')} #{activity.requestStep}</span>}
      </div>
      <div className="xn-runtime-monitor__activity-grid">
        <div><span>{t('输出字符')}</span><strong>{formatCount(activity.outputChars)}</strong></div>
        <div><span>{t('思考字符')}</span><strong>{formatCount(activity.reasoningChars)}</strong></div>
        <div><span>{t('已报告输出 Token')}</span><strong>
          {finite(activity.reportedOutputTokens) ? formatCount(activity.reportedOutputTokens) : t('本轮未报告输出 Token')}
        </strong></div>
        <div><span>{t('首次输出')}</span><strong>{formatRate(activity.firstOutputSeconds, '秒')}</strong></div>
        <div><span>{t('首次思考')}</span><strong>{formatRate(activity.firstReasoningSeconds, '秒')}</strong></div>
        <div><span>{t('请求耗时')}</span><strong>{formatRate(activity.requestSeconds, '秒')}</strong></div>
        <div><span>{t('平均字符速率')}</span><strong>{formatRate(activity.charactersPerSecond, '字符/秒')}</strong></div>
        <div><span>{t('按整个请求耗时计算的平均输出 Token 速率')}</span><strong>
          {finite(activity.reportedOutputTokens) ? formatRate(activity.tokensPerSecond, 'Token/秒') : t('本轮未报告输出 Token')}
        </strong></div>
      </div>
      <p className="xn-runtime-monitor__rate-note">{t('字符与 Token 速率按整个请求耗时计算，不代表逐字解码速度。')}</p>
    </> : <p className="xn-runtime-monitor__empty">{t('暂无输出活动数据')}</p>}
    {budget && <div className="xn-runtime-monitor__budget">
      <div><span>{t('输入预算估算')}</span><strong>
        {`${formatCount(budget.estimatedInputTokens)} / ${formatCount(budget.inputBudgetTokens)} ${t('Token')}`}
      </strong></div>
      <Meter value={inputPercent} label={t('输入预算估算')} />
      <small>{t('估算输入')} · {t('预留输出')} {formatCount(budget.reservedOutputTokens)} · {t('安全预留')} {formatCount(budget.safetyReserveTokens)}</small>
      {finite(budget.calibrationFactor) && budget.calibrationFactor > 1 && <small>
        {t('已按实际输入用量校准估算')} ×{budget.calibrationFactor.toFixed(2)} · {t('缓存 Token 仍占上下文')}
      </small>}
    </div>}
    <div className="xn-runtime-monitor__trend-wrap">
      <div className="xn-runtime-monitor__trend-title">{t('按请求统计的字符速率趋势')}</div>
      {trend.length ? <svg className="xn-runtime-monitor__trend" viewBox="0 0 240 50" role="img" aria-label={t('按请求统计的字符速率趋势')}>
        {trend.length > 1 && <polyline points={trend.map(point => `${point.x},${point.y}`).join(' ')} />}
        {trend.map((point, index) => <circle key={`${index}-${point.x}`} cx={point.x} cy={point.y} r="2.5"><title>{point.title}</title></circle>)}
      </svg> : <p className="xn-runtime-monitor__empty">{t('暂无输出活动数据')}</p>}
    </div>
  </section>;
}

export function RuntimeMonitorDetails({ lightweight, session }: {
  lightweight: boolean;
  session: LocalRuntimeSession | null;
}) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [paused, setPaused] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const lastManualRefresh = useRef(0);
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const manualPending = manualRefresh > lastManualRefresh.current;
    if (!lightweight || !visible || (paused && !manualPending)) {
      setLoading(false);
      return undefined;
    }
    lastManualRefresh.current = manualRefresh;
    return startRuntimeSampling({ repeat: !paused, onMetrics: setMetrics, onError: setError, onLoading: setLoading });
  }, [lightweight, visible, paused, manualRefresh]);

  if (!lightweight) return null;

  const cores = finite(metrics?.cpu.logicalCores) ? metrics.cpu.logicalCores : null;
  const processCpu = finite(metrics?.cpu.processPercent) ? metrics.cpu.processPercent : null;
  const cpuPercent = processCpu === null ? null : percentage(processCpu, cores ? cores * 100 : 100);
  const memory = metrics?.memory;
  const disk = metrics?.disk;
  const ramUsed = estimatedMemoryUsedBytes(memory?.totalBytes, memory?.availableBytes);
  const ramPercent = percentage(ramUsed, memory?.totalBytes);
  const diskUsed = finite(disk?.totalBytes) && finite(disk?.availableBytes)
    ? Math.max(0, disk.totalBytes - disk.availableBytes) : null;
  const diskPercent = percentage(diskUsed, disk?.totalBytes);
  const loads = metrics?.cpu.loadAverage ?? [null, null, null];
  const memoryEstimateLabel = memoryAvailabilityExplanation(memory?.availableKind ?? null);

  return <section className="xn-runtime-monitor__body" aria-label={t('详细资源采样')}>
    <header className="xn-runtime-monitor__header">
      <div><p>{t('资源数据来自本机 Xueness 服务所在设备；远端模型主机资源不可见')}</p><small>{t('约每 2 秒自动采样')}</small></div>
      <div className="xn-runtime-monitor__actions">
        <button type="button" onClick={() => setPaused(value => !value)} aria-label={t(paused ? '恢复采样' : '暂停采样')} title={t(paused ? '恢复采样' : '暂停采样')}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button type="button" onClick={() => setManualRefresh(value => value + 1)} disabled={loading} aria-label={t('刷新')} title={t('刷新')}>
          <RefreshCw size={14} className={loading ? 'xn-runtime-monitor__spin' : ''} />
        </button>
      </div>
    </header>
    <div className="xn-runtime-monitor__sampled">
      <span>{t('最近采样')}: {dateLabel(metrics?.sampledAtISO)}</span>
      {!visible && <span>{t('采样已随页面隐藏而暂停')}</span>}
      {error && <span role="status">{t('采样失败，稍后可重试。')}</span>}
      {!metrics && loading && <span>{t('加载中…')}</span>}
    </div>
    <div className="xn-runtime-monitor__metrics">
      <MetricCard icon={<Cpu size={15} />} label={t('CPU')} value={cores === null ? '—' : `${cores} ${t('逻辑核心')}`}
        detail={`${t('系统负载（1 / 5 / 15 分钟）')}: ${loads.map(value => finite(value) ? value.toFixed(2) : '—').join(' / ')}`} />
      <MetricCard icon={<Activity size={15} />} label={t('本进程 CPU（100% = 一个核心）')}
        value={processCpu === null ? '—' : `${processCpu.toFixed(1)}%`} percent={cpuPercent} />
      <MetricCard icon={<MemoryStick size={15} />} label={t('内存')}
        value={`${t('内存已用估算')} ${formatRuntimeBytes(ramUsed)} / ${formatRuntimeBytes(memory?.totalBytes)}`}
        detail={`${t('可用')} ${formatRuntimeBytes(memory?.availableBytes)}${memoryEstimateLabel ? ` · ${memoryEstimateLabel}` : ''} · ${t('本进程常驻内存')} ${formatRuntimeBytes(memory?.processRssBytes)}`} percent={ramPercent} />
      <MetricCard icon={<HardDrive size={15} />} label={t('磁盘（状态目录所在文件系统）')}
        value={`${formatRuntimeBytes(diskUsed)} / ${formatRuntimeBytes(disk?.totalBytes)}`}
        detail={`${t('可用')} ${formatRuntimeBytes(disk?.availableBytes)}`} percent={diskPercent} />
    </div>
    <div className="xn-runtime-monitor__gpu"><span>{t('GPU / 模型显存遥测不可用')}</span><small>{t('GPU 内存遥测不可用于本地运行时采样。')}</small></div>
    <RuntimeActivityView session={session} />
  </section>;
}

export function LocalRuntimeMonitor({ lightweight, session }: { lightweight: boolean; session: LocalRuntimeSession | null }) {
  const [expanded, setExpanded] = useState(false);
  const id = React.useId();
  if (!lightweight) return null;
  const phase = session?.runtime_activity?.phase;
  return <section className="xn-runtime-monitor" aria-label={t('本机运行状态')} data-expanded={expanded}>
    <button type="button" className="xn-runtime-monitor__toggle" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>
      <Activity size={14} aria-hidden="true" /><span>{t('本机资源')}</span>
      <span className="xn-runtime-monitor__compact-status">{phase ? t(PHASE_LABELS[phase] ?? phase) : t('资源与运行详情')}</span>
      <ChevronDown size={14} aria-hidden="true" className={expanded ? 'xn-runtime-monitor__chevron--expanded' : ''} />
    </button>
    <div id={id} hidden={!expanded}>
      {expanded && <RuntimeMonitorDetails lightweight session={session} />}
    </div>
  </section>;
}

export default LocalRuntimeMonitor;
