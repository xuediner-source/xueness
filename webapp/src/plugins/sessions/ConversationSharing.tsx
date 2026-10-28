import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, LoaderCircle, Share2, X } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import type { WorkbenchSession } from '../../xuenessWorkbench';
import {
  createConversationShare,
  importConversationShare,
  loadConversationShare,
  loadConversationSharePreview,
  revokeConversationShare,
  type ConversationShare,
  type ConversationSharePreview,
} from '../../xuenessWorkbench';
import { shouldDismissModalOnEscape, useModalFocusScope } from '../shared';
import './sessions.css';

type ShareTurn = { id: string; preview: string };

function shareTurns(rows: ConversationSharePreview['rows']): ShareTurn[] {
  const turns = new Map<string, string>();
  for (const row of rows) {
    if (!row.turnId) continue;
    const preview = row.text.trim();
    if (!turns.has(row.turnId)) turns.set(row.turnId, preview);
    else if (!turns.get(row.turnId) && preview) turns.set(row.turnId, preview);
  }
  return Array.from(turns, ([id, preview]) => ({ id, preview }));
}

export function ConversationShareDialog({
  open,
  session,
  onClose,
}: {
  open: boolean;
  session: WorkbenchSession;
  onClose: () => void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewLiveRef = useRef(false);
  const [preview, setPreview] = useState<ConversationSharePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState(session.title || session.task || '');
  const [share, setShare] = useState<{ id: string; href: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const turns = useMemo(() => shareTurns(preview?.rows ?? []), [preview?.rows]);

  const refreshPreview = useCallback(async (preserveSelection?: Set<string>) => {
    if (!open || !previewLiveRef.current) return null;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewLoading(true);
    setError('');
    const result = await loadConversationSharePreview(session.id, controller.signal);
    if (controller.signal.aborted) return null;
    setPreviewLoading(false);
    if (!result.ok) {
      setPreview(null);
      setSelected(new Set());
      setError(result.error);
      return result;
    }
    setPreview(result.value);
    const available = new Set(shareTurns(result.value.rows).map(turn => turn.id));
    setSelected(preserveSelection
      ? new Set([...preserveSelection].filter(id => available.has(id)))
      : available);
    if (!preserveSelection) setTitle(result.value.title || session.title || session.task || '');
    return result;
  }, [open, session.id, session.title, session.task]);

  useEffect(() => {
    if (!open) {
      previewLiveRef.current = false;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      setPreview(null);
      setPreviewLoading(false);
      setSelected(new Set());
      return;
    }
    previewLiveRef.current = true;
    setBusy(false);
    setNotice('');
    setError('');
    void refreshPreview();
    return () => {
      previewLiveRef.current = false;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
    };
  }, [open, session.id, refreshPreview]);

  useModalFocusScope({ open, dialogRef });

  useEffect(() => {
    if (!open || busy) return;
    const keydown = (event: KeyboardEvent) => {
      if (shouldDismissModalOnEscape(event, busy)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open, busy, onClose]);

  if (!open) return null;
  const allSelected = turns.length > 0 && selected.size === turns.length && turns.every(turn => selected.has(turn.id));
  const canCreate = Boolean(preview && turns.length && selected.size && !busy && !previewLoading);
  const submit = async () => {
    if (!preview) {
      setError(tr('此会话尚无可分享的完整历史。'));
      return;
    }
    if (!selected.size) {
      setError(tr('选择至少一个轮次。'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const selectedAtSubmission = new Set(selected);
    const result = await createConversationShare(session.id, preview.message_revision,
      allSelected ? undefined : turns.filter(turn => selectedAtSubmission.has(turn.id)).map(turn => turn.id), title.trim() || undefined);
    if (!previewLiveRef.current) return;
    setBusy(false);
    if (!result.ok) {
      if (/conversation changed/iu.test(result.error)) {
        const refreshed = await refreshPreview(selectedAtSubmission);
        if (refreshed?.ok) setNotice(tr('会话内容已变化，轮次列表已刷新；请检查选择后重新创建链接。'));
        return;
      }
      setError(result.error);
      return;
    }
    const href = new URL(result.value.url, window.location.origin).toString();
    setShare({ id: result.value.id, href, title: result.value.title });
    setNotice(tr('链接已创建。'));
  };
  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.href);
      setNotice(tr('分享链接已复制。'));
      setError('');
    } catch {
      setError(tr('无法访问剪贴板，请复制显示的链接。'));
    }
  };
  const revoke = async () => {
    if (!share || busy) return;
    setBusy(true);
    setError('');
    const result = await revokeConversationShare(share.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setShare(null);
    setNotice(tr('链接已撤销。'));
  };

  return <div className="xn-share-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={dialogRef} tabIndex={-1} className="xn-share-dialog" role="dialog" aria-modal="true"
      aria-labelledby="xn-share-title" data-testid="conversation-share-dialog">
      <header className="xn-share-dialog__header">
        <span className="xn-share-dialog__icon" aria-hidden="true"><Share2 size={17} /></span>
        <div><h2 id="xn-share-title">{tr('分享会话')}</h2><p>{tr('只读分享')}</p></div>
        <button type="button" className="xn-share-dialog__close" aria-label={tr('关闭')} disabled={busy} onClick={onClose}><X size={17} /></button>
      </header>
      <div className="xn-share-dialog__body">
        <label className="xn-share-dialog__field"><span>{tr('分享标题')}</span>
          <input value={title} maxLength={120} disabled={busy || Boolean(share)} onChange={event => setTitle(event.currentTarget.value)} />
        </label>
        <fieldset className="xn-share-dialog__turns" disabled={busy || previewLoading || Boolean(share)}>
          <legend>{tr('选择要分享的轮次')}</legend>
          <label className="xn-share-dialog__all">
            <input type="checkbox" checked={allSelected} disabled={!turns.length} onChange={event => {
              setSelected(event.currentTarget.checked ? new Set(turns.map(turn => turn.id)) : new Set());
            }} />
            <span>{tr('分享全部轮次')}</span>
          </label>
          {previewLoading && <p role="status">{tr('加载分享轮次…')}</p>}
          {!previewLoading && preview && turns.length === 0 && <p role="status">{tr('此会话尚无可分享的完整历史。')}</p>}
          {!previewLoading && turns.map((turn, index) => (
            <label className="xn-share-dialog__turn" key={turn.id}>
              <input type="checkbox" checked={selected.has(turn.id)} onChange={event => {
                const checked = event.currentTarget.checked;
                setSelected(current => {
                const next = new Set(current);
                if (checked) next.add(turn.id); else next.delete(turn.id);
                return next;
                });
              }} />
              <span><strong>{tf('轮次 {0}', [index + 1])}</strong><small>{turn.preview || turn.id}</small></span>
            </label>
          ))}
        </fieldset>
        {!share && <button type="button" className="xn-share-dialog__refresh" disabled={busy || previewLoading}
          onClick={() => void refreshPreview(preview ? new Set(selected) : undefined)}>{tr('刷新轮次')}</button>}
        {share && <div className="xn-share-dialog__link" aria-label={tr('只读分享')}>
          <Link2 size={15} aria-hidden="true" />
          <a href={share.href} target="_blank" rel="noopener noreferrer" title={share.href}>{share.href}</a>
        </div>}
        <p className="xn-share-dialog__note">{tr('分享链接仅包含所选轮次的用户和助手文本，不包含工具数据或工作区文件。')}</p>
        {notice && <p className="xn-share-dialog__notice" role="status">{notice}</p>}
        {error && <p className="xn-share-dialog__error" role="alert">{error}</p>}
      </div>
      <footer className="xn-share-dialog__footer">
        {share ? <>
          <button type="button" className="xn-share-dialog__danger" disabled={busy} onClick={() => void revoke()}>{tr('撤销链接')}</button>
          <button type="button" disabled={busy} onClick={() => void copy()}>{tr('复制链接')}</button>
          <a className="xn-share-dialog__primary" href={share.href} target="_blank" rel="noopener noreferrer">{tr('打开链接')}</a>
        </> : <>
          <button type="button" disabled={busy} onClick={onClose}>{tr('取消')}</button>
          <button type="button" className="xn-share-dialog__primary" disabled={!canCreate} onClick={() => void submit()}>
            {busy ? <><LoaderCircle size={14} className="xn-share-dialog__spinner" />{tr('正在创建链接…')}</> : tr('创建只读链接')}
          </button>
        </>}
      </footer>
    </section>
  </div>;
}

export function ConversationSharePage({ shareId, onImported }: {
  shareId: string;
  onImported: (sessionId: string) => void;
}): React.JSX.Element {
  const [share, setShare] = useState<ConversationShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void loadConversationShare(shareId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setShare(result.value);
      else setError(result.error || tr('此分享不存在或已撤销。'));
      setLoading(false);
    });
    return () => controller.abort();
  }, [shareId]);

  const importShare = async () => {
    if (!share || busy) return;
    setBusy(true);
    setError('');
    const result = await importConversationShare(share.id, { title: share.title });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || tr('导入失败'));
      return;
    }
    setNotice(tr('正在打开导入的任务…'));
    onImported(result.value);
  };

  return <main className="xn-share-page" data-testid="conversation-share-page">
    <header className="xn-share-page__header">
      <span className="xn-share-page__icon" aria-hidden="true"><Share2 size={18} /></span>
      <div><p>{tr('只读对话副本')}</p><h1>{share?.title ?? tr('分享的对话')}</h1></div>
      {share && <button type="button" className="xn-share-page__import" disabled={busy} onClick={() => void importShare()}>
        {busy ? <><LoaderCircle size={15} className="xn-share-dialog__spinner" />{tr('正在导入…')}</> : tr('导入为新任务')}
      </button>}
    </header>
    <p className="xn-share-page__note">{tr('安全导入会创建一个暂停的新任务，不会自动调用模型。')}</p>
    {loading && <p className="xn-share-page__state" role="status">{tr('正在加载…')}</p>}
    {error && <p className="xn-share-page__error" role="alert">{error}</p>}
    {notice && <p className="xn-share-page__state" role="status">{notice}</p>}
    {share && <div className="xn-share-page__timeline" aria-label={tr('分享的对话')}>
      {share.rows.map(row => <article key={row.id} className="xn-share-page__message" data-role={row.role} data-turn-id={row.turnId}>
        <strong>{tr(row.role === 'user' ? '你' : '助手')}</strong>
        <pre>{row.text}</pre>
      </article>)}
    </div>}
  </main>;
}
