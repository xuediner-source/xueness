import { runSession, type WorkbenchSession } from '../../xuenessWorkbench';
import type { RunChoices } from '../../xuenessBridge';
import type { SessionCommandClient } from './commandClient';
import { guideCurrentTurn, reserveQueuedMessageNow, withdrawGuidance, readGuidance, reconcileLocalGuidanceReceipt } from './steeringApi';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { CommandDeliveryUnconfirmedError } from './commandReceipt';
export type PaneGuidanceTransport = { send: typeof guideCurrentTurn; cancel: typeof withdrawGuidance;
  promote: typeof reserveQueuedMessageNow; read: typeof readGuidance;
  reconcile?: (sessionId: string) => Promise<{ result: 'accepted' | 'released' | 'unknown' | 'none' }>;
};
export function createLocalPaneGuidance(current: () => boolean): PaneGuidanceTransport {
  return { send: (id, turn, text, token) => guideCurrentTurn(id, turn, text, token, current),
    cancel: (id, input) => withdrawGuidance(id, input, current),
    promote: (id, queue, turn, revision) => reserveQueuedMessageNow(id, queue, turn, revision, current), read: readGuidance,
    reconcile: id => reconcileLocalGuidanceReceipt(id, current) }; 
}
/** Reserve one observed queue item, wait for the old worker, then admit exactly one run. */
export async function promotePaneQueuedMessage(args: {
  sessionId: string; queueId: string; expectedTurnId: string; expectedRevision?: number; choices: RunChoices;
  commands: SessionCommandClient; guidance: PaneGuidanceTransport; current: () => boolean;
  readSession: () => Promise<WorkbenchSession | null>; sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { current, commands, guidance, sessionId, queueId, expectedTurnId, expectedRevision, choices } = args;
  if (!current() || !commands.isEffective()) return;
  const reserved = await guidance.promote(sessionId, queueId, expectedTurnId, expectedRevision);
  if (!reserved.ok) throw reserved.outcomeUnknown ? new DeliveryUnconfirmedError() : new Error(reserved.error);
  if (!current()) return;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (!current() || !commands.isEffective()) return;
    const latest = await args.readSession();
    if (!current()) return;
    if (latest?.id !== sessionId) throw new Error('Conversation state is unavailable; reserved input remains in the queue');
    if (latest.status !== 'running' && latest.status !== 'stopping' && !latest.active_turn_id && latest.streaming?.status !== 'streaming') {
      const result = await runSession(sessionId, choices, { continueQueue: true, promotionRequestId: reserved.value.request_id }, commands);
      if (!result.ok) {
        if (result.outcomeUnknown && result.commandId) throw new CommandDeliveryUnconfirmedError(result.commandId);
        throw new Error(result.error);
      }
      return;
    }
    await (args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250);
  }
  throw new Error('The current turn is still stopping. The reserved input remains visible in the queue.');
}
