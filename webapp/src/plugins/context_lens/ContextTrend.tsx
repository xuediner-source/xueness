import React, { useState } from 'react';
import { categories, categoryLabel, compact, label } from './labels';
import type { ContextLensView } from './types';

export function ContextTrend({ data, step, onStep }: { data: ContextLensView; step: number | null; onStep(step: number): void }) {
  const [dna, setDna] = useState(true), [delta, setDelta] = useState(false);
  const steps = [...new Set([...data.requests.map(row => row.step), ...data.captures.map(row => row.step)])].sort((a, b) => a - b);
  const rows = steps.map((s, i) => {
    const request = data.requests.find(row => row.step === s), capture = data.captures.find(row => row.step === s);
    const previous = data.requests.find(row => row.step === steps[i - 1]);
    const input = Math.max(0, (request?.input ?? 0) - (delta ? previous?.input ?? 0 : 0));
    return { step: s, request, capture, input, total: dna ? capture?.estimatedTokens ?? request?.input ?? 0 : input + (request?.output ?? 0) };
  });
  const max = Math.max(1, ...rows.map(row => row.total));
  return <section className="xl-card xl-context-trend"><div className="xl-card-title"><h3>{label('trend')}</h3><div className="xl-segmented"><button type="button" aria-pressed={dna} onClick={() => setDna(true)}>{label('dna')}</button><button type="button" aria-pressed={!dna} onClick={() => setDna(false)}>{label('usageMode')}</button></div></div>
    {!dna && <div className="xl-trend-options xl-segmented"><button type="button" aria-pressed={!delta} onClick={() => setDelta(false)}>{label('full')}</button><button type="button" aria-pressed={delta} onClick={() => setDelta(true)}>{label('delta')}</button></div>}
    <div className="xl-chart-area"><div className="xl-y-axis"><small>{compact(max)}</small><small>{compact(max / 2)}</small><small>0</small></div><div className="xl-trend" role="list" aria-label={label('trend')}>{rows.map((row, i) => <button key={row.step} type="button" role="listitem" aria-label={`${label('step')} ${row.step}: ${compact(row.total)}`} aria-pressed={step === row.step} onClick={() => onStep(row.step)} title={`${label('step')} ${row.step} · ${row.request?.model ?? row.capture?.model ?? ''}${dna && !row.capture ? ' · ' + label('missingCapture') : ''}`}>
      <span className="xl-trend-stack" style={{ height: `${Math.max(2, 100 * row.total / max)}%` }}>{dna && row.capture ? categories.filter(key => row.capture!.composition[key] > 0).map(key => <i key={key} data-category={key} style={{ flexGrow: row.capture!.composition[key] }} />) : <><i data-category="assistant" style={{ flexGrow: dna ? row.total : row.input }} /><i data-category="output" style={{ flexGrow: dna ? 0 : row.request?.output ?? 0 }} /></>}</span>
      {(i === 0 || i === rows.length - 1 || i % Math.max(1, Math.ceil(rows.length / 7)) === 0) && <small>{row.step}</small>}
    </button>)}</div></div>
    <div className="xl-chart-key">{(dna ? categories : ['assistant', 'output']).map(key => <span key={key}><i data-category={key} />{key === 'output' ? label('requestOutput') : !dna ? label('requestInput') : categoryLabel(key as typeof categories[number])}</span>)}</div>
    <p className="xl-note xl-card-note">{dna ? label('missing') : label('cacheNote')}</p>
  </section>;
}
