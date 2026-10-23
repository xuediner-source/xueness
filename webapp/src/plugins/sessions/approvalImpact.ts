import { internalToolName } from '../../xuenessToolNames';

export type ApprovalImpactKind = 'read' | 'write' | 'edit' | 'execute' | 'network' | 'external' | 'plan' | 'other';

/** The batch action is limited to one-shot approvals that have not already been granted. */
export function pendingBatchApprovals<T extends { granted?: boolean }>(pending: readonly T[]): T[] {
  return pending.filter(item => !item.granted);
}

const READ_KINDS = new Set(['read', 'list', 'glob', 'grep']);
const WRITE_KINDS = new Set(['write', 'create']);
const EDIT_KINDS = new Set(['edit', 'patch', 'replace', 'delete', 'remove']);
const NETWORK_KINDS = new Set(['web_search', 'search_web', 'web_fetch', 'http']);

/** Summarize the canonical Gate kind. Never infer permission scope from model prose. */
export function approvalImpactKind(kind: string | undefined, name: string): ApprovalImpactKind {
  const canonical = (kind || internalToolName(name)).toLowerCase();
  // ExitPlanMode (Step 3): approving leaves plan mode; the subject is the plan text.
  if (canonical === 'plan_exit' || canonical === 'exit_plan_mode') return 'plan';
  if (READ_KINDS.has(canonical)) return 'read';
  if (WRITE_KINDS.has(canonical)) return 'write';
  if (EDIT_KINDS.has(canonical)) return 'edit';
  if (canonical === 'exec' || canonical === 'exec_start') return 'execute';
  if (NETWORK_KINDS.has(canonical)) return 'network';
  if (canonical === 'mcp' || canonical.startsWith('mcp__')) return 'external';
  return 'other';
}
