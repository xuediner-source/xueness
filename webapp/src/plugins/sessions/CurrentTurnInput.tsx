import React from 'react';
import { messages, t as tr } from '../../i18n';
import { isModKeyPressed } from '../../xuenessShortcutDisplay';

messages['后续输入方式'] = 'Follow-up input behavior';
messages['当前轮引导'] = 'Guide the current turn';
messages['引导当前轮'] = 'Guide current turn';
messages['立即发送'] = 'Send now';
messages['在下一步模型请求前处理，不中断正在执行的工具。'] = 'Apply before the next model request, without interrupting an executing tool.';
messages['当前轮结束后执行。'] = 'Run after the current turn finishes.';
messages['等待当前轮就绪后可引导。'] = 'Guidance becomes available when the current turn is ready.';
messages['撤回到输入框'] = 'Withdraw to composer';
messages['待处理引导'] = 'Pending guidance';
messages['目标轮次已结束，请撤回后重新发送。'] = 'The target turn has ended. Withdraw this input to send it again.';
messages['原附件或上下文不会恢复，请重新添加。'] = 'Original attachments or context are not restored. Add them again before sending.';

export type FollowupMode = 'guide' | 'queue';
export type InputDelivery = FollowupMode | 'startNow';

/** Resolve the composer action for its selected mode and optional reversal. */
export function followupDelivery(mode: FollowupMode, reverse = false): InputDelivery {
  return reverse ? oppositeFollowupDelivery(mode) : mode;
}

/** Same one-shot reversal as the reference composer: guide→queue, queue→now. */
export function oppositeFollowupDelivery(mode: FollowupMode): InputDelivery {
  return mode === 'guide' ? 'queue' : 'startNow';
}

export function followupPointerDelivery(mode: FollowupMode,
  event: { metaKey?: boolean; ctrlKey?: boolean }, platform?: string): InputDelivery | undefined {
  return isModKeyPressed(event, platform) ? followupDelivery(mode, true) : undefined;
}

export function CurrentTurnInput({ mode, onChange, disabled = false, canGuide = true }: {
  mode: FollowupMode;
  onChange: (mode: FollowupMode) => void;
  disabled?: boolean;
  canGuide?: boolean;
}): React.JSX.Element {
  return <label className="xn-current-turn-input" title={tr(mode === 'guide'
    ? '在下一步模型请求前处理，不中断正在执行的工具。' : '当前轮结束后执行。')}>
    <span className="xn-sr-only">{tr('后续输入方式')}</span>
    <select aria-label={tr('后续输入方式')} value={mode} disabled={disabled}
      onChange={event => onChange(event.currentTarget.value as FollowupMode)}>
      <option value="guide" disabled={!canGuide}>{tr('当前轮引导')}</option>
      <option value="queue">{tr('加入队列')}</option>
    </select>
  </label>;
}

export type PendingGuidance = {
  id: string; text: string; status: 'queued' | 'running' | 'paused' | 'completed' | 'needs_review' | 'failed' | 'cancelled';
  targetTurnId?: string; pause_reason?: string; delivery?: 'guide'; position?: number;
  has_attachments?: boolean; has_context?: boolean;
};

export function PendingGuidancePanel({ items, onWithdraw, busyId, disabled = false }: {
  items: PendingGuidance[];
  onWithdraw?: (id: string) => void;
  busyId?: string | null;
  disabled?: boolean;
}): React.JSX.Element | null {
  if (!items.length) return null;
  return <section className="xn-session-queue xn-pending-guidance" aria-label={tr('待处理引导')}>
    <header className="xn-session-queue__header">{tr('待处理引导')}</header>
    <ol className="xn-session-queue__items">{items.map(item => <li key={item.id} className="xn-session-queue__item" data-status={item.status}>
      <div className="xn-session-queue__copy"><p>{item.text}</p>
        {item.status === 'paused' && <small>{tr('目标轮次已结束，请撤回后重新发送。')}</small>}
        {(item.has_attachments || item.has_context) && <small>{tr('原附件或上下文不会恢复，请重新添加。')}</small>}</div>
      {onWithdraw && (item.status === 'queued' || item.status === 'paused') && <button type="button"
        className="xn-session-queue__cancel" disabled={disabled || Boolean(busyId)}
        onClick={() => onWithdraw(item.id)}>{tr(busyId === item.id ? '正在取消…' : '撤回到输入框')}</button>}
    </li>)}</ol>
  </section>;
}
