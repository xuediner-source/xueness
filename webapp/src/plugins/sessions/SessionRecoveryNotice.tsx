import React from 'react';

export function showInterruptedRecovery(status: string, streamStatus?: string, error?: string): boolean {
  return streamStatus === 'interrupted' && !error && !['provider_error', 'failed'].includes(status);
}

/** One factual status and its existing recovery action, kept together in the transcript. */
export function SessionRecoveryNotice({ kind, reason, actionLabel, onAction }: {
  kind: 'interrupted' | 'failed' | 'awaiting-approval' | 'unverified';
  reason: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return <div className="xn-run-recovery xn-session-recovery-notice" data-testid="session-recovery-notice"
    data-recovery-kind={kind} role="status" aria-live="polite"
    style={{ alignItems: 'center', gap: 10 }}>
    <span>{reason}</span>
    {onAction && <button type="button" className="xn-zc-retry" onClick={onAction}>{actionLabel}</button>}
  </div>;
}
