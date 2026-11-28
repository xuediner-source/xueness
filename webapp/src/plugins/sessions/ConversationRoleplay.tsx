/**
 * Chat-style sessions a plugin presents (Tavern roleplay): who is speaking, the opening line shown before
 * the first message, versions of the latest reply, and editing a reply. Pure presentation plus callbacks;
 * the session journal and the plugin's data stay on the server.
 */
import React from 'react';
import { ChevronLeft, ChevronRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import type { Assistant, ConversationPresentation, ConversationSpeaker, ReplyVersionsInfo, ZCodeConversationProps } from './conversationTypes';
import './conversationRoleplay.css';

const pictures = new Map<string, Promise<string | null>>();
/** A speaker's picture from the presenting plugin's own API; read once per address. */
function usePicture(url: string | null | undefined): string | null {
  const [picture, setPicture] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!url) { setPicture(null); return; }
    let alive = true;
    let pending = pictures.get(url);
    if (!pending) {
      pending = fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(response => response.ok ? response.json() as Promise<{ avatar?: unknown }> : null)
        .then(body => typeof body?.avatar === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(body.avatar) ? body.avatar : null)
        .catch(() => null);
      pictures.set(url, pending);
    }
    void pending.then(value => { if (alive) setPicture(value); });
    return () => { alive = false; };
  }, [url]);
  return picture;
}

function hue(name: string): number { let hash = 0; for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0; return hash % 360; }

export function SpeakerLabel({ speaker, side }: { speaker: ConversationSpeaker; side: 'assistant' | 'user' }) {
  const picture = usePicture(speaker.avatarUrl);
  return <div className="xn-rp-speaker" data-side={side}>
    {picture ? <img className="xn-rp-avatar" src={picture} alt="" draggable={false} />
      : <span className="xn-rp-avatar xn-rp-avatar--letter" style={{ ['--xn-rp-hue' as string]: String(hue(speaker.name)) }} aria-hidden="true">{Array.from(speaker.name.trim())[0]?.toUpperCase() ?? '?'}</span>}
    <span className="xn-rp-speaker__name">{speaker.name}</span>
  </div>;
}

/** Roleplay text: "speech" in strong type, *actions* in italics; never interpreted as HTML. */
export function RoleplayProse({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|“[^”]*”|"[^"\n]*"|「[^」]*」|『[^』]*』)/g);
  return <div className="xn-rp-prose">{parts.map((part, index) => index % 2 === 0 ? part
    : part.startsWith('*') ? <em key={index}>{part.slice(1, -1)}</em> : <strong key={index}>{part}</strong>)}</div>;
}

/** The plugin's opening line, shown as the character's first message. */
export function OpeningRow({ presentation }: { presentation: ConversationPresentation }) {
  if (!presentation.opening) return null;
  return <section className="xn-zc-turn xn-rp-opening" aria-label={tr('开场白')}>
    <div className="xn-zc-final">
      <SpeakerLabel speaker={presentation.assistant} side="assistant" />
      <RoleplayProse text={presentation.opening.text} />
      {presentation.opening.total > 1 && <p className="xn-rp-opening__note">{tf('开场白 {0}/{1}，可在酒馆的存档设置里更换', [presentation.opening.index + 1, presentation.opening.total])}</p>}
    </div>
  </section>;
}

/** ‹ 2/3 › and regenerate, under the latest reply of a chat-style session. */
export function ReplyVersionActions({ row, versions, onAction, onEdit }: { row: Assistant; versions: ReplyVersionsInfo | null | undefined; onAction: NonNullable<ZCodeConversationProps['onReplyAction']>; onEdit(): void }) {
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState('');
  const act = async (action: Parameters<typeof onAction>[0]) => {
    if (working) return;
    setWorking(true); setError('');
    try { if (!await onAction(action, row)) setError(tr('操作没有完成，请刷新后重试。')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };
  const count = versions?.count ?? 1, position = versions?.position ?? 0;
  return <>
    {count > 1 && <span className="xn-rp-versions" role="group" aria-label={tr('回复版本')}>
      <button type="button" className="xn-zc-action" aria-label={tr('上一个版本')} title={tr('上一个版本')} disabled={working || position === 0} onClick={() => void act({ kind: 'select', version: position - 1 })}><ChevronLeft size={14} /></button>
      <span className="xn-rp-versions__count">{position + 1}/{count}</span>
      <button type="button" className="xn-zc-action" aria-label={tr('下一个版本')} title={tr('下一个版本')} disabled={working || position >= count - 1} onClick={() => void act({ kind: 'select', version: position + 1 })}><ChevronRight size={14} /></button>
    </span>}
    <button type="button" className="xn-zc-action" aria-label={tr('重新生成')} title={tr('重新生成（保留当前版本）')} disabled={working || count >= 10} onClick={() => void act({ kind: 'regenerate' })}><RefreshCw size={14} /></button>
    <button type="button" className="xn-zc-action" aria-label={tr('编辑回复')} title={tr('编辑回复（存为新版本）')} disabled={working} onClick={onEdit}><Pencil size={14} /></button>
    {error && <span role="alert" className="xn-zc-action-error">{error}</span>}
  </>;
}

/** Edit the latest reply in place; saving keeps the original as another version. */
export function ReplyEditor({ row, text, onAction, onClose }: { row: Assistant; text: string; onAction: NonNullable<ZCodeConversationProps['onReplyAction']>; onClose(): void }) {
  const [draft, setDraft] = React.useState(text);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const save = async () => {
    if (!draft.trim() || draft === text) { onClose(); return; }
    setSaving(true); setError('');
    try { if (await onAction({ kind: 'edit', text: draft }, row)) onClose(); else setError(tr('操作没有完成，请刷新后重试。')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <div className="xn-rp-editor">
    <textarea value={draft} rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))} maxLength={50000} aria-label={tr('编辑回复')} autoFocus
      onChange={event => setDraft(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }} />
    <div className="xn-rp-editor__actions">
      {error && <span role="alert" className="xn-zc-action-error">{error}</span>}
      <span className="xn-rp-editor__hint">{tr('保存后原回复会作为另一个版本保留')}</span>
      <button type="button" className="xn-rp-button" disabled={saving} onClick={onClose}>{tr('取消')}</button>
      <button type="button" className="xn-rp-button xn-rp-button--primary" disabled={saving || !draft.trim()} onClick={() => void save()}>{tr('保存为新版本')}</button>
    </div>
  </div>;
}

/** Deletes a user message and everything after it, after asking once in place. */
export function RewindAction({ onConfirm }: { onConfirm(): Promise<boolean> }) {
  const [asking, setAsking] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState('');
  if (!asking) return <button type="button" className="xn-zc-action xn-rp-rewind" aria-label={tr('从这里删除')} title={tr('删除这条消息及之后的对话')} onClick={() => setAsking(true)}><Trash2 size={14} /></button>;
  return <span className="xn-rp-confirm" role="group" aria-label={tr('删除这条消息及之后的对话')}>
    <span>{tr('删除这条及之后的消息？')}</span>
    <button type="button" className="xn-rp-button xn-rp-button--danger" disabled={working} onClick={async () => {
      setWorking(true); setError('');
      try { if (!await onConfirm()) setError(tr('操作没有完成，请刷新后重试。')); else setAsking(false); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setWorking(false); }
    }}>{tr('删除')}</button>
    <button type="button" className="xn-rp-button" disabled={working} onClick={() => setAsking(false)}>{tr('取消')}</button>
    {error && <span role="alert" className="xn-zc-action-error">{error}</span>}
  </span>;
}
