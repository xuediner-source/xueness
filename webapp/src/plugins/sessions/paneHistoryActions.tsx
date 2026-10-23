import type { PaneOperationGate } from './paneForkActions';
// sessions.pane_layout: history writes stay bound to one mounted leaf.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import { createSessionCommandClient, runSession, updateConversationMessage, type TimelineRow, type WorkbenchSession } from '../../xuenessWorkbench';
import type { RunChoices } from '../../xuenessBridge';
import { validateEditCommandResult, validateSendCommandResult, type SessionCommandClient } from './commandClient';
import { useRunPermissionConfirmation } from './useRunPermissionConfirmation';

import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';

type UserRow = Extract<TimelineRow, { kind: 'user' }>;
export function paneHistoryWritable(session: WorkbenchSession | null | undefined): boolean {
  return !!session && !['running', 'stopping'].includes(session.status) && session.streaming?.status !== 'streaming';
}

export function usePaneHistoryActions({ bindingKey, session, enabled, remote, remoteAdapter, commands: sharedCommands, operationGate, choices, onChoicesChange, onRefresh }: {
  bindingKey: string; session: WorkbenchSession | null | undefined; enabled: boolean; remote: boolean;
  commands?: SessionCommandClient; operationGate?: PaneOperationGate; remoteAdapter?: RemoteSessionAdapter | null; choices?: RunChoices; onChoicesChange?: (value: RunChoices) => void; onRefresh: () => Promise<unknown>;
}) {
  const live = useRef({ bindingKey, session, enabled, remote });
  live.current = { bindingKey, session, enabled, remote };
  const mounted = useRef(true);
  const lock = useRef(false);
  const current = () => mounted.current && live.current.bindingKey === bindingKey && live.current.enabled
    && (!live.current.remote || !!remoteAdapter?.isCurrent()) && !!live.current.session;
  const commands = useMemo(() => sharedCommands ?? (remote ? remoteAdapter?.createCommands(current) ?? createSessionCommandClient(() => false) : createSessionCommandClient(current)), [bindingKey, remoteAdapter, sharedCommands]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState<{ id: string; validate: (result: unknown) => void } | null>(null);
  const permission = useRunPermissionConfirmation(bindingKey, enabled && current());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (!sharedCommands) commands.dispose(); }, [commands, sharedCommands]);
  useEffect(() => { setUnknown(null); setError(''); setBusy(false); }, [bindingKey]);
  const perform = async (row?: UserRow, text?: string, onAccepted?: () => void, attachments?: { preparedToken: string }): Promise<boolean> => {
    if (!current() || !session || !choices || lock.current || unknown || !paneHistoryWritable(live.current.session)) return false;
    const release = operationGate?.acquire(); if (operationGate && !release) return false;
    lock.current = true; setBusy(true); setError('');
    let accepted = false;
    try {
      const selected = await permission.ensure({ ...choices, acknowledge_yolo: false }, session.permission_mode);
      if (!selected || !current() || !paneHistoryWritable(live.current.session)) return false;
      onChoicesChange?.({ ...selected, acknowledge_yolo: false });
      if (row) {
        const edited = await updateConversationMessage(session.id, row, { action: 'edit', text: text ?? '', ...(attachments ? { prepared_token: attachments.preparedToken } : {}) }, commands);
        if (!edited.ok) {
          if (current() && edited.outcomeUnknown) setUnknown({ id: edited.commandId ?? '', validate: value => validateEditCommandResult(session.id, row.messageIndex!, value) });
          throw new Error(edited.error);
        }
        if (!current()) return false;
        accepted = true; onAccepted?.();
        await onRefresh();
      }
      if (!current()) return accepted;
      const result = await runSession(session.id, selected, undefined, commands);
      if (!result.ok) {
        if (current() && result.outcomeUnknown) setUnknown({ id: result.commandId ?? '', validate: value => validateSendCommandResult(session.id, value) });
        throw new Error(result.error);
      }
      return true;
    } catch (problem) {
      if (current()) setError(problem instanceof Error ? problem.message : String(problem));
      // The editor preserves its draft on refusal; a confirmed edit has already
      // closed it even when the subsequent run failed.
      if (row) throw problem;
      return accepted;
    } finally {
      release?.();
      lock.current = false;
      if (current()) { setBusy(false); await onRefresh(); }
    }
  };
  const available = current() && !!choices && !busy && !unknown && paneHistoryWritable(session);
  return {
    onEdit: available ? (row: UserRow, text: string, accepted: () => void, attachments?: { preparedToken: string }) => perform(row, text, accepted, attachments) : undefined,
    // Pending tool permissions are approved through this pane's approval panel.
    onRetry: available && !session?.pending?.some(row => !row.granted) ? () => perform() : undefined,
    isEffective: current,
    controls: <>{permission.dialog}{error && <p role="alert">{error}</p>}{unknown && <button type="button" disabled={busy || !unknown.id} onClick={() => {
      if (!current() || lock.current || !session) return;
      lock.current = true; setBusy(true);
      void commands.query(session.id, unknown.id).then(async ack => {
        if (!current() || ack === 'unknown') return;
        const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
        if (status === 'accepted' || status === 'noop') unknown.validate(ack.result);
        else if (status !== 'rejected' && status !== 'stale') return;
        setUnknown(null); setError(''); await onRefresh();
      }).catch(problem => { if (current()) setError(String(problem)); })
        .finally(() => { lock.current = false; if (current()) setBusy(false); });
    }}>{tr('检查命令结果')}</button>}</>,
  };
}
