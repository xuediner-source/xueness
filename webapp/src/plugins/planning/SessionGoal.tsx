import React, { useState } from 'react';
import { del, post } from '../../xuenessApi';
import { t } from '../../i18n';
import './SessionGoal.css';

export type SessionGoalHistoryEntry = {
  action: 'set' | 'replace' | 'clear' | 'achieved' | 'complete' | 'pause' | 'resume' | 'blocked' | 'budget_limited';
  at: string;
  text?: string;
  source?: string;
};

export type SessionGoalRecord = {
  text: string;
  status: 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete' | 'achieved' | 'cleared';
  setAt: string;
  updatedAt: string;
  history: SessionGoalHistoryEntry[];
  budget?: { maxRounds: number; maxWallSeconds: number; maxTokens?: number };
  runtime?: { reason?: string };
};

const STATUS_LABEL: Record<SessionGoalRecord['status'], string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  budget_limited: '达到预算',
  complete: '已完成',
  achieved: '已达成',
  cleared: '已清除',
};

const ACTION_LABEL: Record<SessionGoalHistoryEntry['action'], string> = {
  set: '设为目标',
  replace: '替换目标',
  clear: '清除目标',
  achieved: '达成目标',
  complete: '完成目标',
  pause: '暂停目标',
  resume: '继续目标',
  blocked: '目标受阻',
  budget_limited: '达到目标预算',
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
  const transition = async (action: 'pause' | 'resume') => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/goal`, { action });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('更新失败'));
    } finally {
      setBusy(false);
    }
  };
  const canPause = goal.status === 'active';
  const canResume = ['paused', 'blocked', 'budget_limited'].includes(goal.status);
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
          {t('目标受轮次和时间预算限制；完成需要独立核验与交付检查。')}
        </p>
        {goal.runtime?.reason && <p className="xn-session-goal__reason">{goal.runtime.reason}</p>}
        {canPause && <button className="xn-session-goal__button" type="button"
          disabled={disabled || busy} onClick={() => void transition('pause')}>
          {t(busy ? '更新中…' : '暂停目标')}
        </button>}
        {canResume && <button className="xn-session-goal__button" type="button"
          disabled={disabled || busy} onClick={() => void transition('resume')}>
          {t(busy ? '更新中…' : '继续目标')}
        </button>}
        <button className="xn-session-goal__button" type="button" disabled={disabled || busy} onClick={() => void clear()}>
          {t(busy ? '清除中…' : '清除目标')}
        </button>
        {error && <p className="xn-session-goal__error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
