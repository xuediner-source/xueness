import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { categories, categoryLabel, compact, format, label } from './labels';
import { Composition } from './ContextView';
import type { ContextItem, ContextLensView } from './types';

export function browserItems(data: ContextLensView, step: number | null): (ContextItem & { unavailable?: boolean })[] {
  if (step === null) return data.current.items;
  const bodies = new Map(data.current.items.map(row => [row.id, row]));
  return (data.captures.find(row => row.step === step)?.items ?? []).map(row => {
    const retained = bodies.get(row.id);
    return { ...row, text: retained?.text ?? '', truncated: retained?.truncated ?? false, unavailable: !retained };
  });
}
export function ContextBrowser({ data, step, onStep }: { data: ContextLensView; step: number | null; onStep(step: number | null): void }) {
  const [search, setSearch] = useState(''), [limit, setLimit] = useState(40);
  const capture = data.captures.find(row => row.step === step), request = data.requests.find(row => row.step === step);
  const current = step === null, values = current ? data.current.composition : capture?.composition;
  const items = useMemo(() => browserItems(data, step).filter(row => !search || `${row.label}\n${row.text}`.toLowerCase().includes(search.toLowerCase())), [data, step, search]);
  const steps = [...data.captures.map(row => row.step), null], index = steps.indexOf(step);
  return <section className="xl-card xl-context-browser">
    <div className="xl-card-title"><h3>{label('browse')}</h3><div className="xl-step-controls"><button type="button" disabled={index <= 0} onClick={() => onStep(steps[index - 1])}>{label('previousStep')}</button><button type="button" disabled={index < 0 || index >= steps.length - 1} onClick={() => onStep(steps[index + 1])}>{label('nextStep')}</button></div></div>
    <select aria-label={label('requestDetails')} value={step ?? 'current'} onChange={e => { onStep(e.target.value === 'current' ? null : Number(e.target.value)); setLimit(40); }}>
      <option value="current">{label('nextRequest')}</option>{data.captures.slice().reverse().map(row => <option key={row.step} value={row.step}>{label('step')} {row.step} · {row.model}</option>)}
    </select>
    <div className="xl-browser-meta"><strong>{current ? label('nextRequest') : `${label('step')} ${step}`}</strong><small>{label('compositionTotal')} ≈{compact(current ? data.current.estimatedTokens : capture?.estimatedTokens ?? 0)}{request?.input != null && ` · ${label('requestInput')} ${compact(request.input)}`}</small></div>
    {values && <Composition values={values} legend={false} />}
    <label className="xl-content-search"><Search size={14} aria-hidden="true" /><input aria-label={label('filter')} placeholder={label('filter')} value={search} onChange={e => { setSearch(e.target.value); setLimit(40); }} /></label>
    <div className="xl-browser">{categories.map(key => {
      const group = items.filter(row => row.category === key), total = group.reduce((n, row) => n + row.tokens, 0);
      return <details key={`${step}:${key}:${search}`} className="xl-context-group" data-category-group={key}><summary><ChevronRight size={14} className="xl-disclosure" /><i data-category={key} /><strong>{categoryLabel(key)}</strong><span>{group.length} {label('itemCount')}</span><b>≈{compact(total)}</b></summary>
        {group.slice(0, limit).map((row, i) => <details key={`${row.id}:${i}`} className="xl-content-item"><summary><ChevronDown size={12} /><span>{row.label}</span><small>≈{format(row.tokens)}</small></summary><pre>{row.unavailable ? label('unavailableBody') : row.text}</pre>{row.truncated && <p className="xl-note">{label('clip')}</p>}</details>)}
        {!group.length && <p className="xl-note">{label('contextEmpty')}</p>}{group.length > limit && <button type="button" onClick={() => setLimit(n => n + 40)}>{label('showMore')}</button>}
      </details>;
    })}</div><p className="xl-note xl-card-note">{current ? label('toolsScope') : label('historical')}</p>
    {request && <div className="xl-request-detail" data-testid="context-request-detail"><strong>{label('requestDetails')} · {request.step}</strong><small>{request.model} · {request.at}</small><span>{label('requestInput')} {format(request.input)} · {label('requestOutput')} {format(request.output)} · {label('cached')} {format(request.cached)}</span></div>}
  </section>;
}
