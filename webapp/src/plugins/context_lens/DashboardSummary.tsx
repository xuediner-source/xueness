import React from 'react';
import { ExternalLink, Puzzle, Settings2, Network } from 'lucide-react';
import { compact, format, label } from './labels';
import type { ContextLensView } from './types';

export function DashboardSummary({ data, onPreferences }: { data: ContextLensView; onPreferences?(): void }) {
  const s = data.statistics, reads = data.files.reduce((n, row) => n + row.reads, 0), writes = data.files.reduce((n, row) => n + row.writes, 0);
  const searches = data.files.reduce((n, row) => n + row.searches, 0);
  return <div className="xl-summary-grid">
    <section className="xl-card xl-summary"><h3>{label('statistics')}</h3><div className="xl-flow">
      <div className="xl-flow-column"><div className="xl-flow-box"><div className="xl-card-title"><span>{label('io')}</span><b>{format(s.humanInputs + reads + writes + searches)}</b></div>
        <div className="xl-chips"><span>{label('turns')} <b>{s.humanInputs}</b></span><span>{label('read')} <b>{reads}</b></span><span>{label('write')} <b>{writes}</b></span><span>{label('searched')} <b>{searches}</b></span></div></div>
        <div className="xl-flow-box"><div className="xl-card-title"><span>{label('events')}</span><b>{s.injections + s.compactions}</b></div><div className="xl-chips xl-event-chips"><span>{label('injectedCount')} <b>{s.injections}</b></span><span>{label('compactCount')} <b>{s.compactions}</b></span><span>{label('maskedCount')} <b>{s.masked}</b></span></div></div></div>
      <div className="xl-flow-core"><span>{label('session')}</span><div><strong>{s.humanInputs}<small>{label('turns')}</small></strong><strong>{s.steps}<small>{label('step')}</small></strong></div><div><strong>{data.captures.length}<small>{label('captureCount')}</small></strong><strong>{s.answers}<small>{label('answers')}</small></strong></div></div>
      <div className="xl-flow-column"><div className="xl-flow-box"><div className="xl-card-title"><span>{label('tools')}</span><b>{format(data.limits.toolCount)}</b></div><div className="xl-chips">{data.toolCounts.slice(0, 3).map(row => <span key={row.name}>{row.name} <b>{row.count}</b></span>)}{data.toolCounts.length > 3 && <span>+{data.toolCounts.length - 3}</span>}</div></div>
        <div className="xl-flow-box xl-network"><div className="xl-card-title"><span><Network size={13} /> {label('fleet')}</span><b>{data.family.length}</b></div><span>{label('self')}<b>{compact(data.totals.input + data.totals.output)} Token</b></span><span>{label('child')}<b>{data.family.filter(row => row.relation === 'child').length}</b></span></div></div>
    </div></section>
    <section className="xl-card xl-plugin-info"><h3>{label('pluginInfo')}</h3><dl>
      <div><dt><Puzzle size={14} />{label('nativePlugin')}</dt><dd>context_lens <small>v1.0.0</small></dd></div>
      <div><dt><ExternalLink size={14} />GitHub</dt><dd><a href="https://github.com/bowenliang123/dsh-context" target="_blank" rel="noreferrer">bowenliang123/dsh-context</a></dd></div>
      <div><dt><Settings2 size={14} />{label('pluginSettings')}</dt><dd><button type="button" onClick={onPreferences} disabled={!onPreferences}>{label('preferences')}</button></dd></div>
    </dl><p className="xl-note">{label('provenance')}</p></section>
  </div>;
}
