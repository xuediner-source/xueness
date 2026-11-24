import React from "react";
import { t as tr } from '../../i18n';
import { IconArrowUp, IconLoader } from "../../ui/icons";
import { followupPointerDelivery, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import type { ComposerDraftState } from './composerTypes';

export function ComposerSubmitActions({
  showQueueControl, isSendDisabled, pointerDeliveryRef, effectiveFollowupMode, platform, queueBusy, showStopControl,
  stopping, onStop, running, draft,
}: {
  showQueueControl: boolean;
  isSendDisabled: boolean;
  pointerDeliveryRef: React.MutableRefObject<InputDelivery | undefined>;
  effectiveFollowupMode: FollowupMode;
  platform?: string;
  queueBusy: boolean;
  showStopControl: boolean;
  stopping: boolean;
  onStop?: () => void;
  running: boolean;
  draft: ComposerDraftState;
}) {
  return (
        <div className="xn-composer__submit-actions">
          {showQueueControl && <button type="submit" disabled={isSendDisabled}
            onClick={event => { pointerDeliveryRef.current = followupPointerDelivery(effectiveFollowupMode, event, platform); }}
            className="xn-composer__send xn-composer__queue" aria-label={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")}
            title={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")} data-testid="composer-queue">
            {queueBusy ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
          </button>}
          {showStopControl ? (
            <button
              type="button"
              disabled={stopping}
              className="xn-composer__send xn-composer__stop"
              aria-label={stopping ? tr("正在停止") : tr("停止")}
              aria-keyshortcuts="Escape"
              title={stopping ? tr("正在停止") : tr("停止当前任务 (Esc)")}
              data-testid="composer-stop"
              onClick={onStop}
            >
              {stopping ? <IconLoader size={16} /> : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              )}
            </button>
          ) : !running && (
            <button
              type="submit"
              disabled={isSendDisabled}
              className="xn-composer__send"
              aria-label={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
              title={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
            >
              {draft.pendingSubmission ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
            </button>
          )}
        </div>
  );
}
