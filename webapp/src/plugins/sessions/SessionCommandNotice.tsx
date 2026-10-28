import React from 'react';
import { ContextCompactionStatus } from './ContextCompactionStatus';

export function SessionCommandNotice({ notice, compacting }: { notice: { message: string; compact?: 'running' | 'complete' }; compacting?: boolean }) {
  if (notice.compact === 'running' && compacting) return null;
  return notice.compact
    ? <p className="xn-session-queue__notice" role="status"><ContextCompactionStatus complete={notice.compact === 'complete'} label={notice.message} /></p>
    : <p className="xn-session-queue__error" role="alert">{notice.message}</p>;
}
