import React, { useState } from 'react';
import { format, label } from './labels';
import type { ContextLensView } from './types';

export function ActivityView({ data }: { data: ContextLensView }) {
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [limit, setLimit] = useState(50);
  const tools = data.tools.filter(row => (!search || `${row.name} ${row.subject} ${row.error}`.toLowerCase().includes(search.toLowerCase())) && (status === 'all' || status === (row.ok === null ? 'pending' : row.ok ? 'passed' : 'failed')));
  return <>
    <section className="xl-card"><h3>{label('files')}</h3><p className="xl-note">{label('footprint')}</p><div className="xl-files">{data.files.map(file => <div key={file.path}><code>{file.path}</code><span>{label('read')} {file.reads} · {label('write')} {file.writes} · {label('searched')} {file.searches}</span><strong>+{file.added} / −{file.removed}</strong></div>)}</div></section>
    <section className="xl-card"><h3>{label('tools')} · {format(data.limits.toolCount)}</h3><p className="xl-note">{label('limits')}</p>
      <div className="xl-controls"><input aria-label={label('filter')} placeholder={label('filter')} value={search} onChange={e => { setSearch(e.target.value); setLimit(50); }} /><select aria-label={label('status')} value={status} onChange={e => setStatus(e.target.value)}>{(['all', 'passed', 'failed', 'pending'] as const).map(key => <option key={key} value={key}>{label(key)}</option>)}</select></div>
      {tools.slice(0, limit).map(tool => <details key={tool.id} className="xl-tool" data-outcome={String(tool.ok)}><summary><strong>{tool.name}</strong><span>{tool.subject}</span><small>{tool.ok === null ? label('pending') : tool.ok ? label('passed') : label('failed')}</small></summary>
        <pre>{tool.subject}</pre><dl className="xl-legend"><div><dt>{label('owner')}</dt><dd>{tool.owner ?? label('unknown')}</dd></div><div><dt>{label('execution')}</dt><dd>{tool.executionMs === null ? label('unknown') : `${format(tool.executionMs)} ms`}</dd></div><div><dt>{label('elapsed')}</dt><dd>{tool.seconds === null ? label('unknown') : `${format(tool.seconds)} s`}</dd></div><div><dt>{label('exit')}</dt><dd>{format(tool.exitCode)}</dd></div></dl>
        {tool.error && <pre role="alert">{tool.error}</pre>}
      </details>)}
      {!tools.length && <p>{label('noTools')}</p>}{tools.length > limit && <button type="button" onClick={() => setLimit(limit + 50)}>{label('showMore')}</button>}
    </section>
  </>;
}
