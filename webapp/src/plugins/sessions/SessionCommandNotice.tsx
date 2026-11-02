import React from 'react';
import { ContextCompactionStatus } from './ContextCompactionStatus';

export function SessionCommandNotice({ notice, compacting }: { notice: { message: string; compact?: 'running' | 'complete' | 'unchanged' }; compacting?: boolean }) {
  if (notice.compact === 'running' && compacting) return null;
  return notice.compact
    ? <p className="xn-session-queue__notice" role="status"><ContextCompactionStatus complete={notice.compact !== 'running'} label={notice.message} /></p>
    : <p className="xn-session-queue__error" role="alert">{notice.message}</p>;
}
