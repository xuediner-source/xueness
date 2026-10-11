import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { listArchivedSessions, restoreSession, type ArchivedSummary } from '../../xuenessWorkbench';
import { t as tr, tf } from '../../i18n';
import { shouldDismissModalOnEscape, useModalFocusScope } from '../shared';
import { deleteArchivedSession } from './archiveApi';
import './ArchivedSessions.css';

export function ArchivedSessionDeleteDialog({ entry, busy = false, error = '', returnFocusTo, onCancel, onConfirm }: {
  entry: ArchivedSummary; busy?: boolean; error?: string; returnFocusTo?: HTMLElement | null;
  onCancel(): void; onConfirm(): void;
}): React.JSX.Element {
  const titleId = useId(), descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null), cancelRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusScope({ open: true, dialogRef, initialFocusRef: cancelRef, returnFocusTo });
  return <div className="xn-dialog-overlay" role="presentation" data-testid="xn-archived-delete-backdrop"
    onClick={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section ref={dialogRef} className="xn-dialog xn-archive-delete-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}
      onKeyDown={event => { if (shouldDismissModalOnEscape(event, busy)) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <h2 id={titleId} className="xn-dialog__title">{tr('永久删除归档会话？')}</h2>
      <p className="xn-archive-delete-dialog__name">{entry.title || entry.task || tr('未命名任务')}</p>
      <p id={descriptionId}>{tr('会话记录及其恢复副本将永久删除，无法恢复。工作区文件不会删除。')}</p>
      {error && <p className="xn-sidebar-archived__error" role="alert">{error}</p>}
      <div className="xn-dialog__actions">
        <button ref={cancelRef} type="button" className="xn-btn xn-btn--md xn-btn--secondary" data-testid="xn-archived-delete-cancel"
          disabled={busy} onClick={onCancel}>{tr('取消')}</button>
        <button type="button" className="xn-btn xn-btn--md xn-archive-delete-dialog__confirm" data-testid="xn-archived-delete-confirm"
          disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="xn-archived-spinner" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
          {tr(busy ? '正在删除…' : '永久删除')}</button>
      </div>
    </section>
  </div>;
}

/** Mounted only while sessions is effective; owns all archived-list IO. */
export function ArchivedSessions({ open, disabled = false, reloadKey = 0, onClose, onRestored }: {
  open: boolean; disabled?: boolean; reloadKey?: number; onClose(): void; onRestored(): void | Promise<void>;
}): React.JSX.Element | null {
  const [entries, setEntries] = useState<ArchivedSummary[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState<{ id: string; action: 'restore' | 'delete' } | null>(null);
  const [target, setTarget] = useState<ArchivedSummary | null>(null), [deleteError, setDeleteError] = useState('');
  const openerRef = useRef<HTMLElement | null>(null), toggleRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef<AbortController | null>(null), aliveRef = useRef(false);
  const bodyId = useId();

  useEffect(() => {
    aliveRef.current = open;
    return () => { aliveRef.current = false; actionRef.current?.abort(); actionRef.current = null; };
  }, [open]);
  useEffect(() => {
    if (!open) { setTarget(null); setPending(null); return; }
    const controller = new AbortController();
    setLoading(true);
    void listArchivedSessions(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) { setEntries(result.value); setError(''); }
      else setError(result.error);
      setLoading(false);
    });
    return () => controller.abort();
  }, [open, reloadKey, refreshKey]);

  const restore = async (entry: ArchivedSummary) => {
    if (disabled || loading || actionRef.current) return;
    const controller = new AbortController();
    actionRef.current = controller;
    setPending({ id: entry.id, action: 'restore' }); setError(''); setNotice('');
    try {
      const result = await restoreSession(entry.id, controller.signal);
      if (!aliveRef.current || controller.signal.aborted) return;
      if (!result.ok) { setError(result.error); return; }
      setEntries(previous => previous.filter(item => item.id !== entry.id));
      setNotice(tf('已恢复会话「{0}」', [entry.title || entry.task]));
      await onRestored();
      if (aliveRef.current) setRefreshKey(previous => previous + 1);
    } catch (failure) {
      if (aliveRef.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (actionRef.current === controller) actionRef.current = null;
      if (aliveRef.current && !controller.signal.aborted) setPending(null);
    }
  };
  const confirmDelete = async () => {
    if (!target?.revision || disabled || loading || actionRef.current) return;
    const controller = new AbortController();
    actionRef.current = controller;
    setPending({ id: target.id, action: 'delete' }); setDeleteError(''); setNotice('');
    try {
      await deleteArchivedSession(target.id, target.revision, controller.signal);
      if (!aliveRef.current || controller.signal.aborted) return;
      setEntries(previous => previous.filter(item => item.id !== target.id));
      setNotice(tf('已永久删除会话「{0}」', [target.title || target.task]));
      setTarget(null); setRefreshKey(previous => previous + 1);
      window.requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
    } catch (failure) {
      if (aliveRef.current && !controller.signal.aborted) setDeleteError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (actionRef.current === controller) actionRef.current = null;
      if (aliveRef.current && !controller.signal.aborted) setPending(null);
    }
  };

  if (!open) return null;
  const blocked = disabled || loading || pending !== null;
  return <section className="xn-sidebar-archived" data-testid="xn-sidebar-archived">
    <div className="xn-sidebar-archived__header">
      <button ref={toggleRef} type="button" className="xn-sidebar-archived__toggle" aria-expanded="true" aria-controls={bodyId}
        disabled={pending !== null} onClick={onClose}><ChevronDown size={14} aria-hidden="true" />{tr('已归档')}{entries.length > 0 && <span>({entries.length})</span>}</button>
      <button type="button" className="xn-sidebar-archived__action" title={tr('刷新归档列表')} aria-label={tr('刷新归档列表')}
        disabled={blocked} onClick={() => { setNotice(''); setRefreshKey(previous => previous + 1); }}>
        {loading ? <LoaderCircle size={14} className="xn-archived-spinner" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}</button>
    </div>
    {error && <p role="alert" className="xn-sidebar-archived__error">{error}</p>}
    {notice && <p role="status" className="xn-sidebar-archived__notice">{notice}</p>}
    <div id={bodyId} className="xn-sidebar-archived__body" aria-busy={loading || pending !== null}>
      {loading && entries.length === 0 && <p className="xn-sidebar-archived__empty" role="status">{tr('正在加载归档会话…')}</p>}
      {!loading && !error && entries.length === 0 && <p className="xn-sidebar-archived__empty">{tr('没有归档任务')}</p>}
      {entries.map(entry => {
        const name = entry.title || entry.task || tr('未命名任务');
        return <div key={entry.id} className="xn-sidebar-archived__item" data-testid={`xn-archived-row-${entry.id}`}>
          <span className="xn-sidebar-archived__title" title={name}>{name}</span>
          <div className="xn-sidebar-archived__actions">
            <button type="button" className="xn-sidebar-archived__restore" aria-label={tf('恢复任务 {0}', [name])}
              title={tr('恢复')} data-testid={`xn-archived-restore-${entry.id}`} disabled={blocked} onClick={() => void restore(entry)}>
              {pending?.id === entry.id && pending.action === 'restore' ? <LoaderCircle size={14} className="xn-archived-spinner" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
              <span>{tr('恢复')}</span></button>
            <button type="button" className="xn-sidebar-archived__action xn-sidebar-archived__delete" aria-label={tf('永久删除会话 {0}', [name])}
              title={tr(entry.revision ? '永久删除' : '归档记录缺少有效版本，请刷新列表后重试。')} data-testid={`xn-archived-delete-${entry.id}`}
              disabled={blocked || !entry.revision} onClick={event => { openerRef.current = event.currentTarget; setDeleteError(''); setTarget(entry); }}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        </div>;
      })}
    </div>
    {target && createPortal(<ArchivedSessionDeleteDialog entry={target} busy={disabled || pending !== null} error={deleteError}
      returnFocusTo={openerRef.current} onCancel={() => setTarget(null)} onConfirm={() => void confirmDelete()} />, document.body)}
  </section>;
}
