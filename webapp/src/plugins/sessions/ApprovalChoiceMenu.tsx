import React, { useRef, useState } from 'react';
import { Info, ShieldAlert } from 'lucide-react';
import { t as tr } from '../../i18n';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import './ApprovalChoiceMenu.css';

export function ApprovalChoiceMenu({ disabled, canRemember, oneShot, onAllow, onProject, onFullAccess, onReject, onSession }: {
  disabled: boolean; canRemember: boolean; oneShot?: boolean;
  onAllow(): void; onProject?: () => void; onFullAccess?: () => void; onReject?: (feedback?: string) => void; onSession?: () => void;
}) {
  const [selected, setSelected] = useState('once'), [note, setNote] = useState('');
  const optionsRef = useRef<HTMLDivElement>(null), noteRef = useRef<HTMLInputElement>(null);
  const choices = [
    { id: 'once', label: tr('允许'), detail: tr('仅允许这一次'), action: onAllow },
    ...(onProject ? [{ id: 'project', label: tr('始终允许本项目'), detail: tr(canRemember ? '后续相同目标与操作不再询问' : '此操作需要单独确认，不能记住为项目规则'), action: onProject, disabled: !canRemember || oneShot }] : []),
    ...(onFullAccess ? [{ id: 'full', label: tr('完全访问'), detail: tr('授予此会话完全访问，跳过全部审批与权限规则'), action: onFullAccess }] : []),
    ...(onSession && !oneShot ? [{ id: 'session', label: tr('允许本会话'), detail: tr('本会话内相同调用不再询问'), action: onSession }] : []),
    ...(onReject ? [
      { id: 'reject', label: tr('拒绝'), detail: tr('这次先拒绝'), action: () => onReject() },
      { id: 'feedback', label: tr('告诉模型接下来应该怎么做…'), detail: '', action: () => onReject(note.trim()) },
    ] : []),
  ];
  const active = choices.find(choice => choice.id === selected) ?? choices[0]!;
  const confirm = () => { if (!disabled && !active.disabled && (active.id !== 'feedback' || note.trim())) active.action(); };
  return <div className="xn-permission-dialog" data-testid="approval-choice-menu" onKeyDown={event => {
    event.stopPropagation(); if (isImeComposingEvent(event)) return;
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement && event.target.dataset.confirm)) { event.preventDefault(); confirm(); return; }
    if (event.target === noteRef.current) return;
    const enabled = choices.filter(choice => !choice.disabled), current = enabled.findIndex(choice => choice.id === selected);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') next = (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    else if (/^[1-9]$/.test(event.key)) next = enabled.findIndex(choice => choice.id === choices[Number(event.key) - 1]?.id);
    if (next < 0) return;
    event.preventDefault(); const choice = enabled[next]!; setSelected(choice.id);
    optionsRef.current?.querySelector<HTMLButtonElement>(`[data-choice="${choice.id}"]`)?.focus();
  }}>
    <div ref={optionsRef} role="radiogroup" aria-label={tr('审批决定')} className="xn-permission-dialog__choices">
      {choices.map((choice, index) => <button type="button" key={choice.id} role="radio" aria-checked={selected === choice.id}
        data-choice={choice.id} disabled={disabled || choice.disabled} onFocus={() => setSelected(choice.id)} onClick={() => { setSelected(choice.id); if (choice.id === 'feedback') noteRef.current?.focus(); }}>
        <span className="xn-permission-dialog__number">{index + 1}.</span><span className="xn-permission-dialog__copy"><strong>{choice.id === 'full' && <ShieldAlert size={16} aria-hidden="true" />}{choice.label}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
      </button>)}
    </div>
    {selected === 'feedback' && <input ref={noteRef} className="xn-permission-dialog__feedback" aria-label={tr('拒绝理由（可选，会转告模型）')} placeholder={tr('告诉模型接下来应该怎么做…')} maxLength={2000} value={note} disabled={disabled} onChange={event => setNote(event.target.value)} />}
    <div className="xn-permission-dialog__footer"><span><Info size={16} aria-hidden="true" />{tr('使用 Tab / 上下键选择，回车确认')}</span><button type="button" data-confirm="true" disabled={disabled || active.disabled || active.id === 'feedback' && !note.trim()} onClick={confirm}>{tr('确认')}</button></div>
  </div>;
}
