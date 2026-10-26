import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, X } from 'lucide-react';
import { CapabilitySection, type CapabilitySectionProps } from '../../XuenessCapabilitiesPanel';
import type { CapabilityItem } from '../../xuenessCapabilities';
import { del, get, post, put } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';

const ROOT = '/api/resources/skills';
type FolderSkill = { id: string; name: string; description: string; source: string; directory?: string; imported?: boolean; shadowed?: boolean; enabled?: boolean };
type Started = { token: string; files: string[]; limits: { chunkBytes: number } };
type Imported = { imported: { name: string; description: string }[]; files: number };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function base64(raw: ArrayBuffer): string {
  const bytes = new Uint8Array(raw);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

/** Browser directory selection supplies file bytes; the API never reads a client path. */
export async function uploadSkillFolder(files: readonly File[], signal: AbortSignal,
  progress: (text: string) => void, onToken: (token: string) => void): Promise<Imported> {
  if (!files.length) throw new Error(tr('未选择文件夹'));
  const selected = new Map(files.map(file => [file.webkitRelativePath || file.name, file]));
  if (selected.size !== files.length) throw new Error(tr('文件夹中包含重复路径'));
  const started = await post<Started>(`${ROOT}/imports`, { files: [...selected].map(([path, file]) => ({ path, bytes: file.size })) }, signal);
  onToken(started.token);
  let completed = 0;
  for (const path of started.files) {
    const file = selected.get(path);
    if (!file) throw new Error(tr('导入文件清单不匹配'));
    progress(tf('正在添加 {0}/{1} 个文件', [completed + 1, started.files.length]));
    for (let offset = 0; offset < file.size || offset === 0; offset += started.limits.chunkBytes) {
      signal.throwIfAborted();
      const raw = await file.slice(offset, offset + started.limits.chunkBytes).arrayBuffer();
      await put(`${ROOT}/imports/${encodeURIComponent(started.token)}`, { path, offset, content: base64(raw) }, signal);
    }
    completed++;
  }
  signal.throwIfAborted();
  progress(tr('正在校验技能…'));
  return post<Imported>(`${ROOT}/imports/${encodeURIComponent(started.token)}/commit`, {}, signal);
}

export function fileSkillItem(skill: FolderSkill): CapabilityItem {
  return { id: skill.id, enabled: skill.enabled !== false, readOnly: true, toggleable: true, removable: skill.imported === true,
    description: `${skill.source === 'bundled' ? tr('内置技能') + ' · ' : ''}${skill.description}` + (skill.shadowed ? ` · ${tr('已被同名技能覆盖')}` : ''),
    extra: { name: skill.name, source: skill.source, directory: skill.directory, folderSkill: true } };
}

/** Skills owns folder IO; the resource shell only provides its normal list and header slot. */
export function SkillsSection(props: CapabilitySectionProps) {
  const [folders, setFolders] = useState<FolderSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = async (signal?: AbortSignal) => {
    const result = await get<{ skills: FolderSkill[] }>(`${ROOT}/files`, signal);
    if (mounted.current) setFolders(result.skills.filter(skill => skill.source !== 'resource'));
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); current.current?.abort(); };
  }, []);
  const add = async (files: File[]) => {
    if (!files.length || busy) return;
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError(''); setStatus(tr('正在读取文件夹…'));
    let token: string | null = null, committed = false;
    try {
      const result = await uploadSkillFolder(files, controller.signal, text => { if (mounted.current) setStatus(text); }, value => { token = value; });
      committed = true;
      await refresh(controller.signal);
      if (mounted.current) setStatus(tf('已添加 {0} 个技能', [result.imported.length]));
    } catch (reason) {
      if (mounted.current) {
        if (controller.signal.aborted) setStatus(tr('已取消导入'));
        else { setError(message(reason)); setStatus(''); }
      }
    } finally {
      if (token && !committed && mounted.current) await del(`${ROOT}/imports/${encodeURIComponent(token)}`).catch(() => undefined);
      if (mounted.current) setBusy(false);
      current.current = null;
    }
  };
  const remove = async (item: CapabilityItem) => {
    if (busy) return;
    const name = String(item.extra?.name ?? '');
    if (!window.confirm(tf('移除技能“{0}”的导入副本？', [name]))) return;
    setBusy(true); setError(''); setStatus('');
    const controller = new AbortController(); current.current = controller;
    try { await del(`${ROOT}/folders/${encodeURIComponent(name)}`, controller.signal); await refresh(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) setError(message(reason)); }
    finally { if (mounted.current) setBusy(false); current.current = null; }
  };
  const toggle = async (item: CapabilityItem, enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError(''); setStatus('');
    const controller = new AbortController(); current.current = controller;
    try { await post(`${ROOT}/files/state`, { id: item.id, enabled }, controller.signal); await refresh(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) setError(message(reason)); }
    finally { if (mounted.current) setBusy(false); current.current = null; }
  };
  const query = props.searchQuery?.toLocaleLowerCase() ?? '';
  const items = folders.filter(skill => !query || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query)).map(fileSkillItem);
  return <>
    <CapabilitySection {...props} render={undefined} loading={props.loading || loading} error={error || props.error}
      scopeLabel={tr('内置与用户技能')}
      items={[...props.items, ...items]} disabled={busy || props.disabled}
      onToggle={(kind, item, enabled) => { if (item.readOnly) void toggle(item, enabled); else props.onToggle?.(kind, item, enabled); }}
      onDelete={(kind, item) => { if (item.readOnly) void remove(item); else props.onDelete?.(kind, item); }}
      headerActions={<>
        <input ref={input} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} data-testid="skills-folder-input"
          onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void add(files); }} />
        <button type="button" className="xn-cap-section__create" disabled={busy || loading} data-testid="skills-folder-add" onClick={() => input.current?.click()}>
          {busy ? <LoaderCircle size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}{tr('从文件夹添加')}
        </button>
      </>} />
    {status && <p className="xn-cap-loading" role="status" data-testid="skills-folder-status">{status}{busy && <button type="button" onClick={() => current.current?.abort()} aria-label={tr('取消导入')}><X size={14} /></button>}</p>}
  </>;
}
