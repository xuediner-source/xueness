import { useCallback, useEffect, useRef, useState } from 'react';
import { t as tr } from '../../i18n';
import type { SessionCommandClient } from './commandClient';
import { CommandDeliveryUnconfirmedError } from './commandReceipt';
import { dismissQueueWithdrawal, getQueueWithdrawal, listQueueWithdrawals, withdrawQueuedMessage,
  type QueueWithdrawal, type QueueWithdrawalMetadata } from './queueApi';

export type QueueWithdrawalTransport = {
  list: typeof listQueueWithdrawals; get: typeof getQueueWithdrawal; dismiss: typeof dismissQueueWithdrawal;
};
const localTransport: QueueWithdrawalTransport = { list: listQueueWithdrawals, get: getQueueWithdrawal, dismiss: dismissQueueWithdrawal };

/** Server escrow is authoritative. Local state never makes an unknown cancellation sendable. */
export function useQueueWithdrawals({ sessionId, root, enabled, revision, commands, onRestore, transport = localTransport, bindingKey = '' }: {
  transport?: QueueWithdrawalTransport; bindingKey?: string;
  sessionId: string | null; root: string; enabled: boolean; revision?: number;
  commands: SessionCommandClient; onRestore: (withdrawal: QueueWithdrawal) => void;
}) {
  const scope = JSON.stringify([sessionId, root, enabled, bindingKey]);
  const binding = useRef({ scope, generation: 0 });
  if (binding.current.scope !== scope) binding.current = { scope, generation: binding.current.generation + 1 };
  const generation = binding.current.generation;
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const [state, setState] = useState<{ generation: number; rows: QueueWithdrawalMetadata[]; unknown: boolean; error: string; busy: boolean }>(
    { generation, rows: [], unknown: false, error: '', busy: false });
  const listSequence = useRef(0);
  const unknownIdentity = useRef<{ generation: number; id: string } | null>(null);
  const current = useCallback(() => mounted.current && enabled && Boolean(sessionId)
    && generation === binding.current.generation, [enabled, sessionId, generation]);
  const request = useCallback(async <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!current()) throw new Error('Withdrawal recovery is no longer enabled');
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try { return await work(controller.signal); }
    finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }, [current]);
  const patch = useCallback((fields: Partial<typeof state>) => {
    if (current()) setState(previous => ({ ...(previous.generation === generation ? previous
      : { generation, rows: [], unknown: false, error: '', busy: false }), ...fields, generation }));
  }, [current, generation]);
  const refresh = useCallback(async () => {
    if (!current()) return;
    const sequence = ++listSequence.current;
    try {
      const rows = await request(signal => transport.list(sessionId!, root, signal));
      let reconciled = false;
      const pending = unknownIdentity.current;
      if (pending?.generation === generation && rows.some(row => row.id === pending.id) && current()) {
        const withdrawal = await request(signal => transport.get(sessionId!, root, pending.id, signal));
        reconciled = current() && await commands.confirmQueueWithdrawalAsync(sessionId!, root, withdrawal);
      }
      if (sequence === listSequence.current) patch({ rows, error: '', ...(reconciled ? { unknown: false } : {}) });
    } catch (error) { if (sequence === listSequence.current) patch({ error: error instanceof Error ? error.message : String(error) }); }
  }, [current, request, sessionId, root, patch, generation, commands, transport]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); };
  }, []);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, [generation]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  const busyRef = useRef(false);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (!current() || busyRef.current) return;
    busyRef.current = true; patch({ busy: true, error: '' });
    try { await work(); }
    catch (error) { patch({ error: error instanceof Error ? error.message : String(error) }); }
    finally { busyRef.current = false; patch({ busy: false }); }
  }, [current, patch]);
  const restore = useCallback((id: string) => perform(async () => {
    const withdrawal = await request(signal => transport.get(sessionId!, root, id, signal));
    // Restore is explicit, never consuming the server copy or submitting a turn.
    if (current() && await commands.confirmQueueWithdrawalAsync(sessionId!, root, withdrawal)) {
      if (!current()) return;
      onRestore(withdrawal);
      if (unknownIdentity.current?.id === withdrawal.id) patch({ unknown: false });
    }
  }), [perform, request, sessionId, root, current, onRestore, commands, patch, transport]);
  const dismiss = useCallback((id: string) => perform(async () => {
    const withdrawal = await request(signal => transport.get(sessionId!, root, id, signal));
    if (!current()) return;
    if (!await commands.confirmQueueWithdrawalAsync(sessionId!, root, withdrawal)) throw new Error('Withdrawal recovery identity could not be reconciled');
    await request(signal => transport.dismiss(sessionId!, id, signal, current));
    if (unknownIdentity.current?.id === id) patch({ unknown: false });
    await refresh();
  }), [perform, request, sessionId, root, current, refresh, commands, patch, transport]);
  const withdraw = useCallback((queueId: string, text: string, expectedRevision: number) => perform(async () => {
    try {
      const id = await withdrawQueuedMessage(sessionId!, queueId, text, expectedRevision, commands);
      if (!current()) return;
      const withdrawal = await request(signal => transport.get(sessionId!, root, id, signal));
      if (current()) onRestore(withdrawal);
      patch({ unknown: false });
    } catch (error) {
      if (error instanceof CommandDeliveryUnconfirmedError && !('queueIntentMismatch' in error)) {
        if (current()) { unknownIdentity.current = { generation, id: error.commandId }; patch({ unknown: true }); }
        return; // Read-only refresh below may prove escrow; never repeat the mutation.
      }
      throw error;
    } finally { if (current()) await refresh(); }
  }), [perform, sessionId, commands, current, request, root, onRestore, patch, refresh, generation, transport]);
  const visible = state.generation === generation ? state : { rows: [], unknown: false, error: '', busy: false };
  return { ...visible, refresh, restore, dismiss, withdraw,
    notice: visible.unknown ? tr('撤回结果尚未确认。仅服务器恢复副本可恢复原文；未找到副本不能证明撤回成功，请勿重复发送。') : '' };
}
