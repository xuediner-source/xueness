import React, { useState } from 'react';
import { compact, format } from './labels';

export interface Segment { id: string; label: string; value: number; detail?: string; }
const COLORS: Record<string, string> = { system: 'var(--xl-system)', tools: 'var(--xl-tools)', user: 'var(--xl-user)', injected: 'var(--xl-injected)',
  assistant: 'var(--xl-assistant)', reasoning: 'var(--xl-reasoning)', tool: 'var(--xl-tool)', output: 'var(--xl-output)',
  waiting: 'var(--xl-waiting)', thinking: 'var(--xl-thinking)', generating: 'var(--xl-generating)', other: 'var(--xl-other)' };
export const color = (id: string) => COLORS[id];
export function DonutCard({ title, aside, segments, center, caption, note }: {
  title: string; aside?: string; segments: Segment[]; center: string; caption: string; note?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((sum, row) => sum + row.value, 0);
  let offset = 0;
  return <section className="xl-card xl-donut-card">
    <div className="xl-card-title"><h3>{title}</h3>{aside && <small>{aside}</small>}</div>
    <div className="xl-donut-row">
      <div className="xl-donut" role="img" aria-label={`${title}: ${center}, ${segments.map(row => `${row.label} ${row.detail ?? format(row.value)}`).join(', ')}`}>
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle className="xl-donut-track" cx="60" cy="60" r="49" />{segments.filter(row => row.value > 0).map(row => {
          const share = row.value / Math.max(total, 1) * 100, start = offset; offset += share;
          return <circle key={row.id} cx="60" cy="60" r="49" pathLength="100" fill="none" stroke={color(row.id)} strokeWidth={hover === row.id ? 13 : 11}
            strokeDasharray={`${Math.max(0, share - .3)} ${100 - Math.max(0, share - .3)}`} strokeDashoffset={-start} transform="rotate(-90 60 60)"
            opacity={hover && hover !== row.id ? .3 : 1} onMouseEnter={() => setHover(row.id)} onMouseLeave={() => setHover(null)} />;
        })}</svg>
        <div><strong>{center}</strong><small>{caption}</small></div>
      </div>
      <dl className="xl-slices">{segments.map(row => <div key={row.id} data-active={hover === row.id} onMouseEnter={() => setHover(row.id)} onMouseLeave={() => setHover(null)}>
        <dt><i style={{ background: color(row.id) }} />{row.label}<b>{total ? `${(row.value / total * 100).toFixed(1)}%` : '—'}</b></dt>
        <dd>{row.detail ?? compact(row.value)}</dd>
      </div>)}</dl>
    </div>{note && <p className="xl-note xl-card-note">{note}</p>}
  </section>;
}
