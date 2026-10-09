import React, { useRef, useState } from 'react';
import { post } from '../../xuenessApi';
import { t } from '../../i18n';
import { useModalFocusScope, shouldDismissModalOnEscape } from '../shared';
import { deferCompositionEnd } from '../../xuenessShortcutDisplay';
import './SessionGoal.css';
import type { SessionGoalRecord } from './SessionGoal';

export function GoalEditorDialog({ sessionId, goal, onClose, onSaved }: {
  sessionId: string; goal?: SessionGoalRecord | null; onClose(): void; onSaved(): void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const compositionActiveRef = useRef(false);
  const [text, setText] = useState(goal?.text ?? '');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const occupied = Boolean(goal && goal.status !== 'cleared');
  useModalFocusScope({ open: true, dialogRef: ref, initialFocusRef: inputRef });
  const save = async () => {
    if (busy || !text.trim() || occupied && !replace) return;
    setBusy(true); setError('');
    try {
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/goal`, { text: text.trim(), replace });
      onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="xn-dialog-overlay"><section ref={ref} className="xn-dialog xn-goal-editor" role="dialog" aria-modal="true"
    aria-labelledby="xn-goal-editor-title" tabIndex={-1} onKeyDown={event => {
      if (shouldDismissModalOnEscape({ ...event, compositionActive: compositionActiveRef.current }) && !busy) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <h2 id="xn-goal-editor-title" className="xn-dialog__title">{t('会话目标')}</h2>
    <p>{t('目标保存在当前会话中，每轮提醒模型；修改不会自动启动任务。')}</p>
    <textarea ref={inputRef} aria-label={t('目标内容')} className="xn-dialog__input xn-goal-editor__input" value={text}
      maxLength={5000} rows={5} disabled={busy} onChange={event => setText(event.target.value)}
      onCompositionStart={(e) => { compositionActiveRef.current = true; e.currentTarget.setAttribute('data-composing', 'true'); }}
      onCompositionEnd={(e) => { const el = e.currentTarget; deferCompositionEnd(() => { compositionActiveRef.current = false; el?.removeAttribute('data-composing'); }); }} />
    {occupied && <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />{t('确认替换现有目标')}</label>}
    {error && <p role="alert">{error}</p>}
    <div className="xn-dialog__actions">
      <button type="button" className="xn-btn xn-btn--md xn-btn--secondary" disabled={busy} onClick={onClose}>{t('取消')}</button>
      <button type="button" className="xn-btn xn-btn--md xn-btn--primary" disabled={busy || !text.trim() || occupied && !replace} onClick={() => void save()}>{t(busy ? '保存中…' : '保存目标')}</button>
    </div>
  </section></div>;
}
