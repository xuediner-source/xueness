import React, { useState } from 'react';
import { categories, categoryLabel, compact, duration, format, label } from './labels';
import { DonutCard, color } from './charts';
import { DashboardSummary } from './DashboardSummary';
import { ContextBrowser } from './ContextBrowser';
import { ContextTrend } from './ContextTrend';
import type { Category, ContextLensView } from './types';

export function Composition({ values, legend = true }: { values: Record<Category, number>; legend?: boolean }) {
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  return <div className="xl-composition">
    <div className="xl-composition__bar" role="img" aria-label={categories.map(key => `${categoryLabel(key)} ${format(values[key])}`).join(', ')}>
      {categories.filter(key => values[key] > 0).map(key => <span key={key} data-category={key} title={`${categoryLabel(key)} ≈${format(values[key])}`} style={{ flexGrow: values[key] / Math.max(total, 1) }} />)}
    </div>
    {legend && <dl className="xl-legend">{categories.map(key => <div key={key}><dt><i data-category={key} />{categoryLabel(key)}</dt><dd>≈{compact(values[key])}<small>{total ? `${(values[key] / total * 100).toFixed(0)}%` : '—'}</small></dd></div>)}</dl>}
  </div>;
}

export function ContextView({ data, onPreferences }: { data: ContextLensView; onPreferences?(): void }) {
  const [step, setStep] = useState<number | null>(null);
  const timing = data.statistics.timing;
  const times = [
    { id: 'waiting', label: label('waiting'), value: timing.waitingMs },
    { id: 'thinking', label: label('thinking'), value: timing.thinkingMs },
    { id: 'generating', label: label('generating'), value: timing.generatingMs },
    { id: 'tool', label: label('toolElapsed'), value: timing.toolElapsedMs },
    { id: 'other', label: label('overhead'), value: timing.otherMs },
  ].map(row => ({ ...row, detail: duration(row.value) }));
  const tokens = [
    { id: 'assistant', label: label('uncached'), value: Math.max(0, data.totals.input - data.totals.cached) },
    { id: 'tool', label: label('cached'), value: data.totals.cached },
    { id: 'output', label: label('requestOutput'), value: data.totals.output },
  ];
  const occupied = data.current.hostEstimatedTokens ?? data.current.estimatedTokens;
  const pct = data.current.contextWindow ? 100 * occupied / data.current.contextWindow : null;
  const totalTime = times.reduce((n, row) => n + row.value, 0);
  return <>
    <DashboardSummary data={data} onPreferences={onPreferences} />
    <div className="xl-dashboard">
      <DonutCard title={label('tokenStats')} aside={`${label('cached')} ${data.totals.input ? (data.totals.cached / data.totals.input * 100).toFixed(2) + '%' : '—'}`}
        segments={tokens} center={data.totals.reported ? compact(data.totals.input + data.totals.output) : '—'} caption={label('totalTokens')}
        note={`${label('requestInput')} ${format(data.totals.input)} · ${label('requestOutput')} ${format(data.totals.output)} · ${label('unknownRequests')} ${data.totals.unknown}`} />
      <div className="xl-timing">
        <DonutCard title={label('timingStats')} aside={timing.speedMs ? `${label('requestSpeed')} ${(timing.speedTokens / timing.speedMs * 1000).toFixed(1)} tok/s` : undefined}
          segments={times} center={totalTime ? duration(totalTime) : '—'} caption={label('recordedTime')} note={`${label('sampleCount')} ${timing.samples} · ${label('timingScope')}`} />
        {timing.spans.length > 0 && <div className="xl-time-strip" role="img" aria-label={label('timingStats')}>{timing.spans.map((span, i) => <div key={i} title={`${label('step')} ${span.step}`} style={{ flexGrow: span.waitingMs + span.thinkingMs + span.generatingMs + span.otherMs }}>
          {(['waiting', 'thinking', 'generating', 'other'] as const).map(key => <span key={key} style={{ background: color(key), flexGrow: span[`${key}Ms`] }} />)}
        </div>)}</div>}
      </div>
      <section className="xl-card xl-current"><div className="xl-card-title"><h3>{label('currentContext')}</h3><small>{data.requests.at(-1)?.model}</small></div>
        <div className="xl-context-headline"><span><strong>{data.current.hostEstimatedTokens === null ? '≈' : ''}{compact(occupied)}</strong> / {data.current.contextWindow ? compact(data.current.contextWindow) : '—'} tokens</span><span><strong>{pct === null ? '—' : `${pct.toFixed(1)}%`}</strong> {label('contextUsage')}</span></div>
        <div className="xl-capacity" role="img" aria-label={`${label('contextUsage')} ${pct === null ? label('unknown') : pct.toFixed(1) + '%'}`}><div style={{ width: `${pct === null ? 100 : Math.min(100, pct)}%` }}><Composition values={data.current.composition} legend={false} /></div></div>
        <Composition values={data.current.composition} />
        <p className="xl-note xl-card-note">{label('source')}</p>
      </section>
      <ContextBrowser key={data.id} data={data} step={step} onStep={setStep} />
      <ContextTrend data={data} step={step} onStep={setStep} />
    </div>
    <details className="xl-card xl-events"><summary><strong>{label('events')}</strong><small>{data.events.length}</small></summary>{data.events.length ? data.events.map((event, index) => <details key={index}><summary>{event.kind} · {event.at}</summary><pre>{event.detail}</pre></details>) : <p className="xl-note">{label('noEvents')}</p>}</details>
  </>;
}
