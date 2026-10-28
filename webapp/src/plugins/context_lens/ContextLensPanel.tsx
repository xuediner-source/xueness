import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Preferences } from './Preferences';
import { get } from '../../xuenessApi';
import { useLocale } from '../../i18n';
import { startSessionPolling } from '../sessions/SessionPolling';
import { ContextView } from './ContextView';
import { ActivityView } from './ActivityView';
import { format, label } from './labels';
import type { ContextLensView } from './types';
import './context-lens.css';

export interface SessionSummary { id: string; title: string; root: string; status: string; requests: number; tokens: number; lastAt: string; days: { at: string; tokens: number }[]; }
export function ContextLensPanel({ enabled, settingsEnabled = false, sessionId, onOpenSession, onSelectSession }: { enabled: boolean; settingsEnabled?: boolean; sessionId?: string | null; onOpenSession?(id: string): void; onSelectSession?(id: string): void; }) {
  useLocale();
  const [summaries, setSummaries] = useState<SessionSummary[]>([]), [selected, setSelected] = useState(sessionId ?? ''), [tab, setTab] = useState<'overview' | 'context' | 'activity' | 'fleet' | 'preferences'>(sessionId ? 'context' : 'overview');
  const [view, setView] = useState<ContextLensView | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, reload] = useState(0), [search, setSearch] = useState(''), [range, setRange] = useState('all');
  useEffect(() => { if (sessionId) { setSelected(sessionId); setTab('context'); } }, [sessionId]);
  useEffect(() => {
    setSummaries([]); setError('');
    if (!enabled) return;
    const request = new AbortController(); setLoading(true);
    void get<{ sessions: SessionSummary[] }>('/api/context-lens/sessions', request.signal).then(value => { if (!request.signal.aborted) setSummaries(value.sessions); }).catch(e => { if (!request.signal.aborted) setError(String(e.message ?? e)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [enabled, revision]);
  useEffect(() => {
    setView(null); setError('');
    if (!enabled || !selected) return;
    const controller = new AbortController();
    const stop = startSessionPolling({ initialDelayMs: 0, visibleDelayMs: 4000, hiddenDelayMs: 30000, refresh: async () => {
      try { const value = await get<ContextLensView>(`/api/context-lens/sessions/${selected}`, controller.signal); if (!controller.signal.aborted) { setView(value); setError(''); } }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    } });
    return () => { stop(); controller.abort(); };
  }, [enabled, selected, revision]);
  if (!enabled) return null;
  const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86400000;
  const visible = summaries.filter(row => (!search || `${row.title} ${row.root}`.toLowerCase().includes(search.toLowerCase())) && (!cutoff || row.days.some(day => Date.parse(day.at) >= cutoff)));
  const days = new Map<string, number>();
  for (const row of visible) for (const day of row.days) if (!cutoff || Date.parse(day.at) >= cutoff) { const key = new Date(day.at).toLocaleDateString('sv-SE'); days.set(key, (days.get(key) ?? 0) + day.tokens); }
  const maxDay = Math.max(1, ...days.values());
  const select = (id: string) => { setSelected(id); setTab('context'); if (id) onSelectSession?.(id); };
  return <div className="xl-root" data-testid="context-lens-panel">
    <div className="xl-panel-bar"><nav className="xl-tabs" aria-label={label('title')}>{(['context', 'activity', 'fleet', 'overview', 'preferences'] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label(key)}</button>)}</nav><button type="button" className="xl-refresh" onClick={() => reload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />{label('refresh')}</button></div>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">{label('loading')}</p>}
    {tab === 'preferences' ? <Preferences enabled={enabled && settingsEnabled} /> : tab === 'overview' ? <>
      <div className="xl-controls"><input aria-label={label('search')} placeholder={label('search')} value={search} onChange={e => setSearch(e.target.value)} /><select aria-label={label('overview')} value={range} onChange={e => setRange(e.target.value)}><option value="7">{label('week')}</option><option value="30">{label('month')}</option><option value="all">{label('allTime')}</option></select></div>
      <section className="xl-card"><h3>{label('overview')} · {visible.length}</h3><div className="xl-days">{[...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, tokens]) => <div key={day} title={`${day}: ${format(tokens)}`}><span style={{ height: `${Math.max(2, tokens / maxDay * 100)}%` }} /><small>{day.slice(5)}</small></div>)}</div></section>
      <div className="xl-session-grid">{visible.map(row => <button type="button" key={row.id} className="xl-card xl-session" onClick={() => select(row.id)}><strong>{row.title}</strong><span>{row.status} · {row.requests} {label('requests')}</span><b>{format(row.tokens)} Token</b><small>{row.root}</small></button>)}</div>
      {!loading && !visible.length && <p>{label('empty')}</p>}
    </> : <>
      <div className="xl-controls"><select aria-label={label('overview')} value={selected} onChange={e => select(e.target.value)}><option value="">{label('overview')}</option>{summaries.map(row => <option value={row.id} key={row.id}>{row.title}</option>)}</select>{selected && onOpenSession && <button type="button" onClick={() => onOpenSession(selected)}>{label('openChat')}</button>}</div>
      {view ? <>
        {tab === 'context' ? <ContextView key={view.id} data={view} onPreferences={() => setTab('preferences')} /> : tab === 'activity' ? <ActivityView key={view.id} data={view} /> : <section className="xl-card"><h3>{label('fleet')}</h3><p>{label('noFamily')}</p><div className="xl-family">{view.family.map(member => <div key={member.id} className="xl-card"><small>{label(member.relation as 'self')}</small><strong>{member.title}</strong><span>{member.status}</span></div>)}</div></section>}
      </> : !error && <p role="status">{selected ? label('loading') : label('empty')}</p>}
    </>}
    <footer className="xl-provenance"><a href="https://github.com/bowenliang123/dsh-context" target="_blank" rel="noreferrer">{label('provenance')}</a></footer>
  </div>;
}
