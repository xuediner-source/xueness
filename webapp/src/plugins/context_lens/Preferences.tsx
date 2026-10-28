import React, { useEffect, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { label } from './labels';

export function Preferences({ enabled }: { enabled: boolean }) {
  const [prefix, setPrefix] = useState(''), [suffix, setSuffix] = useState(''), [capture, setCapture] = useState(true);
  const [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => {
    setReady(false); if (!enabled) return;
    const request = new AbortController();
    void get<{ config: { plugins?: { context_lens?: { promptPrefix?: string; promptSuffix?: string; captureRequests?: boolean } } } }>('/api/runtime-config', request.signal).then(value => {
      if (request.signal.aborted) return;
      const config = value.config.plugins?.context_lens;
      setPrefix(config?.promptPrefix ?? ''); setSuffix(config?.promptSuffix ?? ''); setCapture(config?.captureRequests !== false); setReady(true);
    }).catch(e => { if (!request.signal.aborted) setError(String(e.message ?? e)); });
    return () => request.abort();
  }, [enabled]);
  if (!enabled) return <p>{label('settingsOff')}</p>;
  return <form className="xl-card xl-preferences" onSubmit={async event => {
    event.preventDefault(); if (!ready || saving) return;
    setSaving(true); setError(''); setSaved(false);
    try { await post('/api/runtime-config', { config: { plugins: { context_lens: { promptPrefix: prefix, promptSuffix: suffix, captureRequests: capture } } } }); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }}>
    <h3>{label('preferences')}</h3><p className="xl-note">{label('preferenceScope')}</p>
    <label className="xl-check"><input type="checkbox" checked={capture} onChange={e => { setCapture(e.target.checked); setSaved(false); }} disabled={!ready || saving} />{label('captureSwitch')}</label>
    <label>{label('prefix')}<textarea value={prefix} maxLength={8000} onChange={e => { setPrefix(e.target.value); setSaved(false); }} disabled={!ready || saving} rows={5} /></label>
    <label>{label('suffix')}<textarea value={suffix} maxLength={8000} onChange={e => { setSuffix(e.target.value); setSaved(false); }} disabled={!ready || saving} rows={5} /></label>
    <button type="submit" disabled={!ready || saving}>{label('save')}</button>{saved && <p role="status">{label('saved')}</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
