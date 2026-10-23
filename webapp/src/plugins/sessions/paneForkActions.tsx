import { paneHistoryWritable } from './paneHistoryActions';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createSessionCommandClient, forkSession, loadForkBoundaries, type TimelineRow, type WorkbenchSession } from '../../xuenessWorkbench';
import { createSessionCommandId, CommandDeliveryUnconfirmedError, CommandRefusedError, uncertain, type SessionCommandClient } from './commandClient';
const ForkSessionDialog = React.lazy(() => import('./ForkSessionDialog').then(module => ({ default: module.ForkSessionDialog })));
export type PaneOperationGate = { acquire: () => (() => void) | null };

/** One unresolved fork keeps its original ID even when the dialog is reopened. */
export class PaneForkCommand {
  private pending: string | null = null;
  private busy = false;
  constructor(private readonly commands: SessionCommandClient, private readonly sourceId: string) {}
  async submit(payload: Record<string, unknown>): Promise<unknown> {
    if (this.busy) throw Object.assign(new Error('Fork command is in progress'), { requestNotSent: true });
    this.busy = true;
    try {
      let result: unknown;
      if (this.pending) {
        const ack = await this.commands.query(this.sourceId, this.pending);
        if (ack === 'unknown') throw new CommandDeliveryUnconfirmedError(this.pending);
        const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
        if (status === 'rejected' || status === 'stale') { this.pending = null; throw new CommandRefusedError(ack); }
        if (status !== 'accepted' && status !== 'noop') throw new CommandDeliveryUnconfirmedError(this.pending);
        result = ack.result;
      } else {
        this.pending = createSessionCommandId();
        try {
          result = await this.commands.submit(this.sourceId, 'fork', payload,
            async () => { throw Object.assign(new Error('Durable fork commands are required'), { requestNotSent: true }); }, this.pending);
        } catch (error) {
          if (!(error instanceof CommandDeliveryUnconfirmedError) && !uncertain(error)) this.pending = null;
          throw error;
        }
      }
      const value = result as { sourceId?: string; session?: { id?: string }; boundary?: { turn?: number; preview?: string }; historyTruncated?: boolean; truncationReason?: unknown } | null;
      if (!value || value.sourceId !== this.sourceId || !/^[0-9a-f]{32}$/u.test(value.session?.id ?? '')
        || value.session?.id === this.sourceId || !Number.isInteger(value.boundary?.turn) || typeof value.boundary?.preview !== 'string'
        || typeof value.historyTruncated !== 'boolean' || !(value.truncationReason === null || typeof value.truncationReason === 'string')) {
        throw new CommandDeliveryUnconfirmedError(this.pending!);
      }
      // Keep the original receipt until navigation: another click cannot create
      // another child even if the UI failed to consume the confirmed response.
      return result;
    } finally { this.busy = false; }
  }
}

export function usePaneForkActions({ bindingKey, session, enabled, remote, remoteAdapter, commands: sharedCommands, operationGate, onForkSession }: {
  bindingKey: string; session?: WorkbenchSession; enabled: boolean; remote: boolean; remoteAdapter?: RemoteSessionAdapter | null; commands?: SessionCommandClient; operationGate?: PaneOperationGate; onForkSession?: (id: string) => void;
}) {
  const live = useRef({ bindingKey, enabled, session }); live.current = { bindingKey, enabled, session };
  const mounted = useRef(true);
  const current = () => mounted.current && live.current.bindingKey === bindingKey && live.current.enabled && (!remote || !!remoteAdapter?.isCurrent() && remoteAdapter.owner.capabilities?.historyFork === true) && !!live.current.session;
  const commands = useMemo(() => sharedCommands ?? (remote ? remoteAdapter?.createCommands(current) ?? createSessionCommandClient(() => false) : createSessionCommandClient(current)), [bindingKey, remoteAdapter, sharedCommands]);
  const command = useMemo(() => new PaneForkCommand(commands, session?.id ?? ''), [commands, session?.id]);
  const [selected, setSelected] = useState<{ key: string; turn?: number } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (!sharedCommands) commands.dispose(); }, [commands, sharedCommands]);
  const createFork = useMemo<typeof forkSession>(() => (id, boundary, revision, title) => forkSession(id, boundary, revision, title,
    async (_path, body) => { if (!current() || id !== session?.id) throw new Error('Fork scope changed'); const release = operationGate?.acquire(); if (operationGate && !release) throw new Error('Another pane operation is active'); try { return await command.submit(body as Record<string, unknown>); } finally { release?.(); } }), [command, bindingKey]);
  const loadBoundaries = useMemo<typeof loadForkBoundaries>(() => async (id, signal) => {
    if (!current() || id !== session?.id) return { ok: false, error: 'Fork scope changed' };
    return loadForkBoundaries(id, signal, remote ? async (_path, abort) => remoteAdapter!.request('history/fork-boundaries', { sessionId: id }, abort, current) : undefined);
  }, [bindingKey, session?.id]);
  return {
    onFork: current() && paneHistoryWritable(session) && onForkSession ? (row: Extract<TimelineRow, { kind: 'assistant' }>) => setSelected({ key: bindingKey, turn: /^turn-[1-9][0-9]*$/u.test(row.turnId) ? Number(row.turnId.slice(5)) : undefined }) : undefined,
    dialog: current() && session && selected?.key === bindingKey ? <React.Suspense fallback={null}><ForkSessionDialog open sourceId={session.id} sourceTitle={session.title || session.task}
      initialTurn={selected.turn} loadBoundaries={loadBoundaries} createFork={createFork} onCancel={() => setSelected(null)}
      onFork={result => { if (current()) { setSelected(null); onForkSession?.(result.session.id); } }} /></React.Suspense> : null,
  };
}

