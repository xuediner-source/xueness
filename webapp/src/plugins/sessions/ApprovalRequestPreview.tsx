import React from 'react';
import { FileText, Terminal, Pencil, ChevronDown } from 'lucide-react';
import type { PendingApproval } from './approvalTypes';
import { ApprovalItemPreview } from './ApprovalPreview';
import { formatSubject, parseDiffPreview } from './diffPreview';

export function ApprovalRequestPreview({ pending, operation, impact }: { pending: PendingApproval; operation: string; impact: string }) {
  const subject = formatSubject(pending.kind ?? pending.name, pending.subject), diff = parseDiffPreview(pending.preview);
  const file = ['write', 'edit', 'read'].includes(pending.kind ?? pending.name), slash = Math.max(subject.lastIndexOf('/'), subject.lastIndexOf('\\'));
  return <details className="xn-permission-request" open={pending.kind === 'plan_exit'}>
    <summary><Pencil size={15} aria-hidden="true" /><small>{operation}</small>{file ? <FileText size={15} aria-hidden="true" /> : <Terminal size={15} aria-hidden="true" />}
      <span className="xn-permission-request__target">{file ? subject.slice(slash + 1) : subject}</span>{file && slash >= 0 && <small className="xn-permission-request__directory">{subject.slice(0, slash + 1)}</small>}
      {diff.added > 0 && <strong className="xn-permission-request__added">+{diff.added}</strong>}{diff.removed > 0 && <strong className="xn-permission-request__removed">−{diff.removed}</strong>}<ChevronDown size={13} aria-hidden="true" />
    </summary>
    <div className="xn-permission-request__detail"><p>{impact}</p>{pending.kind === 'plan_exit' ? <div className="xn-approval-plan" data-testid={`approval-plan-${pending.tool_call_id}`}>{pending.subject}</div> : <pre>{subject}</pre>}
      {pending.preview && <ApprovalItemPreview preview={pending.preview} toolCallId={pending.tool_call_id} />}
    </div>
  </details>;
}
