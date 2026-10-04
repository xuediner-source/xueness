import React, { useState } from 'react';
import { del } from '../../xuenessApi';
import { t } from '../../i18n';
import './SessionGoal.css';

export type SessionGoalHistoryEntry = {
  action: 'set' | 'replace' | 'clear' | 'achieved';
  at: string;
  text?: string;
  source?: string;
};

export type SessionGoalRecord = {
  text: string;
  status: 'active' | 'achieved' | 'cleared';
  setAt: string;
  updatedAt: string;
  history: SessionGoalHistoryEntry[];
};

const STATUS_LABEL: Record<SessionGoalRecord['status'], string> = {
  active: '进行中',
  achieved: '已达成',
  cleared: '已清除',
};

const ACTION_LABEL: Record<SessionGoalHistoryEntry['action'], string> = {
  set: '设为目标',
  replace: '替换目标',
  clear: '清除目标',
  achieved: '达成目标',
};

/** 会话目标的一行徽标：摘要只显示状态与文本，展开后查看完整目标、变更历史和清除。 */
export function SessionGoal({ sessionId, goal, disabled, onChanged }: {
  sessionId: string;
  goal?: SessionGoalRecord | null;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A cleared goal leaves the conversation without a one-line reminder to show.
  if (!goal || goal.status === 'cleared') return null;
  const clear = async () => {
    setBusy(true);
    setError('');
    try {
      await del(`/api/sessions/${encodeURIComponent(sessionId)}/goal`);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('清除失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="xn-session-goal" data-status={goal.status} data-testid="session-goal">
      <summary className="xn-session-goal__bar">
        <span className="xn-session-goal__label">{t('会话目标')}</span>
        <span className="xn-session-goal__text" title={goal.text}>{goal.text}</span>
        <span className="xn-session-goal__status">{t(STATUS_LABEL[goal.status])}</span>
      </summary>
      <div className="xn-session-goal__body">
        <p className="xn-session-goal__full">{goal.text}</p>
        {goal.history.length > 0 && (
          <ul className="xn-session-goal__history">
            {goal.history.slice(-6).reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <span>{t(ACTION_LABEL[entry.action] ?? entry.action)}</span>
                <time dateTime={entry.at}>{entry.at}</time>
              </li>
            ))}
          </ul>
        )}
        <p className="xn-session-goal__scope">
          {t('目标每轮注入模型，运行结束时由主机核对；未声明达成则需要复核。')}
        </p>
        <button className="xn-session-goal__button" type="button" disabled={disabled || busy} onClick={() => void clear()}>
          {t(busy ? '清除中…' : '清除目标')}
        </button>
        {error && <p className="xn-session-goal__error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
