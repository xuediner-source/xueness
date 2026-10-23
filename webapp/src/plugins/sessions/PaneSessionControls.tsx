// sessions.pane_layout: all mutations are bound to this leaf and its runtime.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t as tr, messages } from '../../i18n';
import { approvePending, createSessionCommandClient, runSession, requestMutation, type WorkbenchSession, type PendingApproval } from '../../xuenessWorkbench';
import type { RunChoices } from '../../xuenessBridge';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { paneBindingKey, type PaneIdentity } from './paneIdentity';
import { useRunPermissionConfirmation } from './useRunPermissionConfirmation';
import { Approvals } from './XuenessWorkbenchView';
import { loadQuestion, answerQuestion, answerQuestionCards } from './questionApi';
import { PendingQuestion, QuestionResume, type QuestionTransport } from './PendingQuestion';
import { SessionQueue, QueueWithdrawalRecovery } from './SessionQueue';
import { cancelQueuedMessage, editQueuedMessage, reorderQueuedMessages } from './queueApi';
import { useQueueWithdrawals, type QueueWithdrawalTransport } from './useQueueWithdrawals';
import { PendingGuidancePanel } from './CurrentTurnInput';
import { promotePaneQueuedMessage, createLocalPaneGuidance, type PaneGuidanceTransport } from './paneWorkflowActions';
import type { QueueWithdrawal } from './queueApi';
import type { SessionCommandClient } from './commandClient';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { CommandDeliveryUnconfirmedError, validateSendCommandResult } from './commandClient';

messages['拒绝此工具请求'] = 'Reject this tool request';
messages['继续已保留的立即发送消息'] = 'Continue reserved send-now message';
messages['检查命令结果'] = 'Check command result';
messages['命令结果仍未确认，请勿重复提交。'] = 'The command outcome is still unknown. Do not submit it again.';
messages['远程答复通道尚不可用，请在远程会话中答复。'] = 'Remote question responses are unavailable. Answer in the remote conversation.';
messages['命令结果已确认，请检查最新会话状态。'] = 'Command result confirmed. Check the latest conversation state.';

export type PaneSessionControlsProps = {
  operationGate?: { acquire: () => (() => void) | null }; sharedCommands?: SessionCommandClient; identity: PaneIdentity; session: WorkbenchSession; enabled: boolean; choices: RunChoices;
  onChoicesChange: (choices: RunChoices) => void; onRefresh: () => Promise<unknown>;
  remoteAdapter?: RemoteSessionAdapter | null; questionTransport?: QuestionTransport; withdrawalTransport?: QueueWithdrawalTransport; onRestoreWithdrawal?: (withdrawal: QueueWithdrawal) => void; guidanceTransport?: PaneGuidanceTransport; readSession?: () => Promise<WorkbenchSession | null>;
};
export function pendingApprovalMatches(pending: PendingApproval, rows: PendingApproval[]): boolean {
  return rows.some(row => row.tool_call_id === pending.tool_call_id && row.kind === pending.kind
    && row.name === pending.name && row.subject === pending.subject);
}

export function approvalReceiptMatches(value: unknown, pending: PendingApproval, rejected: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const field = rejected ? 'rejected' : 'approved';
  const inner = result[field] as Record<string, unknown> | undefined;
  return !!inner && result[rejected ? 'approved' : 'rejected'] === undefined
    && inner.tool_call_id === pending.tool_call_id && inner.kind === (pending.kind ?? (pending.name.startsWith('mcp__') ? 'mcp' : pending.name));
}

export function PaneSessionControls({ operationGate, sharedCommands, identity, session, enabled, choices, onChoicesChange, onRefresh, remoteAdapter, questionTransport, withdrawalTransport, onRestoreWithdrawal, guidanceTransport, readSession }: PaneSessionControlsProps) {
  const remote = !!identity.scope.remoteConnectionId;
  const adapter = remote ? remoteAdapter : undefined;
  const key = JSON.stringify([paneBindingKey(identity), adapter?.runtimeKey ?? null]);
  const live = useRef({ key, enabled, session, generation: 0 });
  const generation = live.current.generation + (live.current.key !== key || live.current.enabled !== enabled ? 1 : 0);
  live.current = { key, enabled, session, generation };
  const mounted = useRef(true);
  const current = () => mounted.current && live.current.key === key && live.current.generation === generation && live.current.enabled
    && session.id === identity.sessionId && (!remote || !!adapter?.isCurrent());
  const guidance = remote ? guidanceTransport : createLocalPaneGuidance(current);
  const commands = useMemo(() => sharedCommands ?? (remote
    ? adapter?.createCommands(current) ?? createSessionCommandClient(() => false)
    : createSessionCommandClient(current)), [key, generation, adapter, sharedCommands]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (!sharedCommands) commands.dispose(); }, [commands, sharedCommands]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => { lock.current = false; setBusy(false); }, [key, generation]);
  const unknownRecovery = useRef<(() => Promise<boolean>) | null>(null);
  const receiptValidator = useRef<((result: unknown) => boolean) | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const permission = useRunPermissionConfirmation(key, enabled && current());
  const perform = async (work: () => Promise<void>, propagate = false) => {
    if (!current() || lock.current || unknown !== null || !commands.isEffective()) return;
    const release = operationGate?.acquire();
    if (operationGate && !release) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (problem) {
      if (current()) {
        setError(problem instanceof Error ? problem.message : String(problem));
        if (problem instanceof DeliveryUnconfirmedError) setUnknown(problem instanceof CommandDeliveryUnconfirmedError ? problem.commandId : '');
      }
      if (propagate) throw problem;
    } finally {
      try { if (current()) await onRefresh(); }
      catch (problem) { if (current()) setError(problem instanceof Error ? problem.message : String(problem)); }
      finally { release?.(); lock.current = false; if (current()) setBusy(false); }
    }
  };
  const run = async (continueQueue = false, promotionRequestId?: string) => {
    if (!current()) return;
    const confirmed = await permission.ensure({ ...choices, acknowledge_yolo: false }, session.permission_mode);
    if (!confirmed || !current()) return;
    onChoicesChange({ ...confirmed, acknowledge_yolo: false });
    receiptValidator.current = value => { try { validateSendCommandResult(session.id, value); return true; } catch { return false; } };
    const result = await runSession(session.id, confirmed, { continueQueue, ...(promotionRequestId ? { promotionRequestId } : {}) }, commands);
    if (!result.ok) {
      if (current() && result.outcomeUnknown) setUnknown(result.commandId ?? '');
      throw new Error(result.error);
    }
  };
  const approve = (rows: PendingApproval[]) => perform(async () => {
    // Calls waiting in the running turn continue in place; only replays need a new run.
    let resumed = rows.length > 0;
    for (const row of rows) {
      if (!current() || !pendingApprovalMatches(row, live.current.session.pending ?? [])) return;
      receiptValidator.current = value => approvalReceiptMatches(value, row, false);
      const result = await approvePending(session.id, row, commands);
      if (!result.ok) {
        if (current() && result.outcomeUnknown) setUnknown(result.commandId ?? '');
        throw new Error(result.error);
      }
      if (result.resumed !== true) resumed = false;
    }
    if (current() && !resumed) await run();
  });
  const reject = (row: PendingApproval) => perform(async () => {
    if (!current() || !pendingApprovalMatches(row, live.current.session.pending ?? [])) return;
    const kind = row.kind ?? (row.name.startsWith('mcp__') ? 'mcp' : row.name);
    receiptValidator.current = value => approvalReceiptMatches(value, row, true);
    await commands.submitApproval(session.id, 'reject', { kind, tool_call_id: row.tool_call_id, decision: 'reject' },
      signal => requestMutation('POST', `/api/sessions/${encodeURIComponent(session.id)}/approvals`,
        { kind, tool_call_id: row.tool_call_id, decision: 'reject' }, signal, current));
  });
  const guardedQuestion = useMemo<QuestionTransport | undefined>(() => {
    if (remote && !questionTransport) return undefined;
    const base = questionTransport ?? { load: loadQuestion,
      answer: (id: string, question: string, answer: string) => answerQuestion(id, question, answer, current),
      answerCards: (id: string, question: string, answers: Parameters<typeof answerQuestionCards>[2]) => answerQuestionCards(id, question, answers, current) };
    const submit = async <T,>(work: () => Promise<T>): Promise<T> => {
      if (!current()) throw new Error('Question binding changed');
      const release = operationGate?.acquire();
      if (operationGate && !release) throw new Error('Another pane operation is pending');
      try { return await work(); } finally { release?.(); }
    };
    return { load: base.load, answer: (id, question, answer) => submit(() => base.answer(id, question, answer)),
      answerCards: base.answerCards ? (id, question, answers) => submit(() => base.answerCards!(id, question, answers)) : undefined };
  }, [key, generation, questionTransport, operationGate]);
  const withdrawals = useQueueWithdrawals({ sessionId: session.id, root: remote ? adapter?.owner.workspaceIdentity ?? '' : identity.scope.workspaceRoot,
    enabled: enabled && current() && (!remote || !!withdrawalTransport) && !!onRestoreWithdrawal,
    bindingKey: key, revision: session.queue_revision, commands, transport: withdrawalTransport,
    onRestore: withdrawal => { if (current()) onRestoreWithdrawal?.(withdrawal); } });
  if (!enabled || !current()) return null;
  const disabled = busy || unknown !== null || withdrawals.busy || withdrawals.unknown;
  const running = session.status === 'running' || session.streaming?.status === 'streaming';
  return <section data-testid="pane-session-controls" data-pane-id={identity.paneId}>
    {permission.dialog}
    {session.pause_reason && <p role="status">{session.pause_reason}</p>}
    {error && <p role="alert">{error}</p>}
    {unknown !== null && <><p role="status">{tr('命令结果仍未确认，请勿重复提交。')}</p>
      <button type="button" disabled={busy} onClick={() => {
        if (!current() || unknown === null || lock.current) return;
        lock.current = true; setBusy(true);
        void (unknown ? commands.query(session.id, unknown) : Promise.resolve('unknown' as const)).then(async ack => {
          if (!unknown && current()) {
            const recovered = await unknownRecovery.current?.();
            const reconciled = !recovered ? await guidance?.reconcile?.(session.id) : undefined;
            if (current() && (recovered || reconciled?.result === 'accepted' || reconciled?.result === 'released')) { setUnknown(null); await onRefresh(); }
            return;
          }
          if (!current()) return;
          if (ack !== 'unknown') {
            const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
            // A failed execution receipt does not prove that its write did not happen.
            if (status === 'rejected' || status === 'stale' || ((status === 'accepted' || status === 'noop') && receiptValidator.current?.(ack.result))) { setUnknown(null); setError(tr('命令结果已确认，请检查最新会话状态。')); }
            await onRefresh();
          }
        }).catch(problem => { if (current()) setError(String(problem)); })
          .finally(() => { lock.current = false; if (current()) setBusy(false); });
      }}>{tr('检查命令结果')}</button></>}
    {!!session.pending?.length && <><Approvals pending={session.pending} busy={disabled || running}
      onApprove={row => approve([row])} onApproveAll={rows => approve(rows ?? session.pending ?? [])} />
      {session.pending.map(row => <button key={row.tool_call_id} type="button" disabled={disabled || running}
        aria-label={`${tr('拒绝此工具请求')}: ${row.name} ${row.subject}`} onClick={() => void reject(row)}>{tr('拒绝此工具请求')}: {row.name}</button>)}</>}
    {(!remote || questionTransport) ? <PendingQuestion key={key} sessionId={session.id} enabled={enabled}
      pendingQuestion={session.status === 'awaiting_user' ? session.pending_question : null} disabled={disabled}
      transport={guardedQuestion} onSubmitted={async (_id, continueRun, questionCurrent) => {
        if (!current() || !questionCurrent()) return;
        if (continueRun) await perform(async () => { if (questionCurrent()) await run(); }); else await onRefresh();
      }} /> : session.pending_question && <p role="alert">{tr('远程答复通道尚不可用，请在远程会话中答复。')}</p>}
    <QuestionResume enabled={enabled} resumeBudgetEnabled={enabled} pauseCode={session.pause_code}
      status={session.status} pendingQuestion={session.pending_question} disabled={disabled} onResume={() => perform(() => run())} />
    {!running && ['pending', 'provider_error', 'paused', 'needs_review'].includes(session.status) && !session.pending_question &&
      <button type="button" disabled={disabled} onClick={() => void perform(() => run())}>{tr('重试运行')}</button>}
    <PendingGuidancePanel items={session.pending_guidance ?? []} disabled={disabled}
      onWithdraw={guidance ? id => { void perform(async () => {
        const item = live.current.session.pending_guidance?.find(row => row.id === id);
        if (!item || !current()) return;
        unknownRecovery.current = async () => {
          const result = await guidance.reconcile?.(session.id);
          if (!current() || result?.result !== 'accepted') return false;
          onRestoreWithdrawal?.({ id: `guidance:${id}`, queueId: id, sessionId: session.id,
            root: identity.scope.workspaceRoot, text: item.text, hasContext: !!(item.has_context || item.has_attachments),
            expectedRevision: session.queue_revision ?? 0, createdAt: Date.now(), expiresAt: Date.now() + 86400000 });
          return true;
        };
        // Only the confirmed cancellation makes this text safe to restore.
        await guidance.cancel(session.id, id);
        if (!current()) return;
        onRestoreWithdrawal?.({ id: `guidance:${id}`, queueId: id, sessionId: session.id,
          root: identity.scope.workspaceRoot, text: item.text, hasContext: !!(item.has_context || item.has_attachments),
          expectedRevision: session.queue_revision ?? 0, createdAt: Date.now(), expiresAt: Date.now() + 86400000 });
      }); } : undefined} />
    {(session.queued_messages ?? []).filter(item => item.promotion?.state === 'reserved' && item.promotion.id).map(item =>
      <button key={`reserved:${item.id}`} type="button" disabled={disabled || running || session.status === 'stopping' || !!session.active_turn_id}
        onClick={() => void perform(() => run(true, item.promotion!.id))}>{tr('继续已保留的立即发送消息')}</button>)}
    <SessionQueue key={key} items={session.queued_messages ?? []} queueRevision={session.queue_revision} currentId={session.current_queue_item_id}
      disabled={disabled} onCancel={(id, text, revision) => { receiptValidator.current = value => !!value && typeof value === 'object' && (value as {id?: unknown}).id === id && (value as {removed?: unknown}).removed === true;
        void perform(() => cancelQueuedMessage(session.id, id, text, commands, revision)); }}
      onEdit={(id, text, expected, revision) => {
        receiptValidator.current = value => { const result = value as {id?: unknown; item?: {id?: unknown; text?: unknown}} | null;
          return result?.id === id && result.item?.id === id && result.item.text === text.trim(); };
        return perform(() => editQueuedMessage(session.id, id, text, expected, commands, revision), true);
      }}
      onReorder={(ids, expected, revision) => {
        receiptValidator.current = value => { const result = value as {ids?: unknown} | null;
          return Array.isArray(result?.ids) && JSON.stringify(result.ids) === JSON.stringify(ids); };
        return perform(() => reorderQueuedMessages(session.id, ids, expected, commands, revision), true);
      }}
      onSendNow={running && session.active_turn_id && guidance && readSession ? (id, revision) => perform(async () => {
        const confirmed = await permission.ensure({ ...choices, acknowledge_yolo: false }, session.permission_mode);
        if (!confirmed || !current()) return;
        onChoicesChange({ ...confirmed, acknowledge_yolo: false });
        receiptValidator.current = value => { try { validateSendCommandResult(session.id, value); return true; } catch { return false; } };
        unknownRecovery.current = async () => {
          const result = await guidance.reconcile?.(session.id);
          if (result?.result === 'accepted' || result?.result === 'released') return current();
          const latest = await readSession();
          return current() && latest?.id === session.id && !!latest.queued_messages?.some(item => item.id === id
            && !!item.promotion?.id && ['reserved', 'claimed', 'settled'].includes(item.promotion.state ?? ''));
        };
        await promotePaneQueuedMessage({ sessionId: session.id, queueId: id, expectedTurnId: session.active_turn_id!,
          expectedRevision: revision, choices: confirmed, commands, guidance, current, readSession });
      }, true) : undefined}
      onWithdraw={(!remote || withdrawalTransport) && onRestoreWithdrawal ? async (item, revision) => {
        await perform(async () => { if (current()) await withdrawals.withdraw(item.id, item.text, revision); });
      } : undefined}
      canContinue={!running && (session.queued_messages ?? []).some(row => row.status === 'paused')}
      onContinue={() => { void perform(() => run(true)); }} continuing={busy} />
    {onRestoreWithdrawal && (!remote || withdrawalTransport) && <QueueWithdrawalRecovery withdrawals={withdrawals.rows}
      notice={withdrawals.notice} error={withdrawals.error} disabled={busy || withdrawals.busy} onRefresh={withdrawals.refresh}
      onRestore={withdrawals.restore} onDismiss={withdrawals.dismiss} />}
  </section>;
}
