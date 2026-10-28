// sessions.command_ack: reload recovery queries original receipts; it never resends.
import React, { useEffect, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import type { SessionCommandClient } from './commandClient';
import { validateCreateCommandResult } from './commandReceipt';
import { loadQuestion, answerQuestion, answerQuestionCards } from './questionApi';
import type { QuestionTransport } from './PendingQuestion';
import { matchesFollowupPending, type FollowupProof, type PendingCommandReference } from './commandLedger';
import type { WorkbenchSession } from '../../xuenessWorkbench';
import { hasUnconfirmedLocalGuidance } from './steeringApi';
import { startSessionPolling } from './SessionPolling';

export function canAdmitSessionMutation(commands: SessionCommandClient, sessionId: string | null, enabled: () => boolean): boolean {
  return enabled() && commands.isEffective() && !commands.recoveryStorageError()
    && !commands.pendingCommands().some(row => row.sessionId === sessionId);
}
export function sessionFollowupProof(session: Pick<WorkbenchSession,'id'|'status'|'active_turn_id'|'active_run_command_id'> | null | undefined): FollowupProof | undefined {
  if (session?.status !== 'running' || !session.active_turn_id || !session.active_run_command_id) return undefined;
  return {sessionId:session.id, runCommandId:session.active_run_command_id, expectedTurnId:session.active_turn_id};
}
/** This exception certifies an active run, without settling or resending its receipt. */
export function canAdmitSessionFollowup(commands: SessionCommandClient, sessionId: string, proof: FollowupProof | undefined, current: () => boolean): boolean {
  return current() && commands.isEffective() && !commands.recoveryStorageError() && !hasUnconfirmedLocalGuidance(sessionId)
    && (proof?.sessionId === sessionId ? matchesFollowupPending(commands.pendingCommands(),proof)
      : !commands.pendingCommands().some(row=>row.sessionId===sessionId));
}
export function receiptGuardedQuestionTransport(commands: SessionCommandClient, enabled: () => boolean): QuestionTransport {
  return { load: loadQuestion,
    answer: (id, question, answer, current) => answerQuestion(id, question, answer, () => current?.() !== false && canAdmitSessionMutation(commands, id, enabled)),
    answerCards: (id, question, answers, current) => answerQuestionCards(id, question, answers, () => current?.() !== false && canAdmitSessionMutation(commands, id, enabled)) };
}
export async function queryOriginalPaneReceipts(commands: SessionCommandClient, rows: readonly PendingCommandReference[], current: () => boolean): Promise<string[]> {
  const created: string[] = [];
  for (const row of rows) {
    if (!current() || !commands.isEffective()) return created;
    const ack = row.sessionId === null ? await commands.queryCreate(row.commandId) : await commands.query(row.sessionId, row.commandId);
    if (!current()) return created;
    if (row.type === 'create_session' && ack !== 'unknown') {
      const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
      if (status === 'accepted' || status === 'noop') created.push(validateCreateCommandResult(ack.result, row.commandId));
    }
  }
  return created;
}
export function CommandReceiptRecovery({ commands, enabled, sessionId, autoCheck = false, onRefresh, onOpenSession }: {
  commands: SessionCommandClient; enabled: boolean; sessionId?: string | null;
  /** The owning session is idle, so its lost receipts may be read once without a click. */
  autoCheck?: boolean;
  onRefresh?: () => Promise<unknown>; onOpenSession?: (id: string) => void;
}) {
  const live = useRef({ commands, enabled, generation: 0 });
  const generation = live.current.generation + (live.current.commands !== commands || live.current.enabled !== enabled ? 1 : 0);
  live.current = { commands, enabled, generation };
  const mounted = useRef(true);
  const current = () => mounted.current && live.current.enabled && live.current.commands === commands && live.current.generation === generation;
  const [, redraw] = useState(0); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [message, setMessage] = useState(''); const [created, setCreated] = useState<string[]>([]);
  const autoChecked = useRef('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setBusy(false); lock.current = false; if (!enabled) return;
    // Local ledger observation only, never a network poll. Also observes lazy-client hydration.
    return startSessionPolling({ refresh: async () => { redraw(value => value + 1); }, isOnline: () => true });
  }, [commands, enabled, generation]);
  // A request this page is still awaiting is progress, not a lost receipt: a run
  // answers when its turn settles. Only receipts without a live request need recovery.
  const rows = commands.pendingCommands().filter(row => (sessionId === undefined || row.sessionId === sessionId || row.sessionId === null)
    && !commands.isInFlight?.(row.sessionId, row.commandId));
  const storageError = commands.recoveryStorageError();
  const storageWarning = commands.recoveryStorageWarning();
  const check = (targets: readonly PendingCommandReference[], quiet: boolean) => {
    if (!current() || lock.current) return;
    lock.current = true; setBusy(true); if (!quiet) setMessage('');
    void queryOriginalPaneReceipts(commands, targets, current).then(async ids => {
      if (!current()) return;
      setCreated(previous => [...new Set([...previous, ...ids])]);
      const pending = commands.pendingCommands();
      const unresolved = targets.some(row => pending.some(item => item.commandId === row.commandId));
      if (!quiet) setMessage(tr(unresolved ? '命令结果仍未确认，请勿重复提交。' : '命令结果已确认，请检查最新会话状态。'));
      if (!quiet || !unresolved) await onRefresh?.();
    }).catch(error => { if (current() && !quiet) setMessage(error instanceof Error ? error.message : String(error)); })
      .finally(() => { lock.current = false; if (current()) { setBusy(false); redraw(value => value + 1); } });
  };
  // One exact read per idle transition (for example after a reload during a run);
  // it never resends and never polls. Unresolved receipts keep the manual check.
  const autoKey = enabled && autoCheck && !storageError && rows.length ? rows.map(row => row.commandId).join('\n') : '';
  useEffect(() => { if (!autoCheck) autoChecked.current = ''; }, [autoCheck]);
  useEffect(() => {
    if (!autoKey || autoChecked.current === autoKey) return;
    autoChecked.current = autoKey;
    check(rows, true);
  }, [autoKey]);
  if (!enabled || (!rows.length && !message && !created.length && !storageError && !storageWarning)) return null;
  return <section className="xn-command-recovery" data-testid="command-receipt-recovery">
    {storageError && <p role="alert">{storageError}</p>}
    {storageWarning && <p role="status">{storageWarning}</p>}
    {!!rows.length && <><p role="status" className="xn-command-recovery__pending">{tr('命令结果仍未确认，请勿重复提交。')}</p>
      <button type="button" disabled={busy || !!storageError} onClick={() => check(rows, false)}>{tr('检查未确认的命令')}</button></>}
    {message && <p role="status">{message}</p>}
    {onOpenSession && created.map(id => <button key={id} type="button" className="xn-command-recovery__open" onClick={() => { if (current()) onOpenSession(id); }}>{tr('打开已确认创建的会话')}</button>)}
  </section>;
}
