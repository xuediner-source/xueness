import { type CommandReceiptStorage } from './commandLedger';
import { couldHaveBeenAccepted } from './submissionTransport';
import { CommandDeliveryUnconfirmedError } from './commandReceipt';

export type SessionCommandType = 'send' | 'queue' | 'stop' | 'run' | 'fork' | 'edit_message' | 'approve' | 'approval' | 'reject' | QueueCommandType;
export type QueueCommandType = 'edit_queue' | 'cancel_queue' | 'withdraw_queue' | 'reorder_queue';
export type SessionCommandStatus = 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'noop' | 'failed';
export type SessionCommandAck = {
  commandId: string;
  status: SessionCommandStatus;
  originalStatus?: Exclude<SessionCommandStatus, 'duplicate'>;
  result?: unknown;
  reasonCode?: string;
  message?: string;
};

export type Requests = {
  post: (path: string, body: unknown, signal: AbortSignal, beforeSend?: () => boolean) => Promise<unknown>;
  get: (path: string, signal: AbortSignal) => Promise<unknown>;
};
export type Options = Requests & {
  isEffective: () => boolean;
  /** Narrow admission for an explicit observed-turn Stop; never authorizes reads or other writes. */
  isSafetyStopEffective?: () => boolean;
  /** Scoped transports must never use legacy same-origin callbacks. */
  allowDirectFallback?: boolean;
  /** Stable backend/workspace namespace. Enables same-tab reload receipt recovery. */
  receiptScope?: string;
  receiptStorage?: CommandReceiptStorage;
  timeoutMs?: number;
  queryAttempts?: number;
  maxPending?: number;
  maxRemembered?: number;
};
export type ApprovalReceipt = { commandId: string; result: unknown };
export type EditReceipt = { commandId: string; result: unknown };
export type EditPayload = { revision: string; messageIndex: number; action: 'edit'; text: string; prepared_token?: string };
export type RememberedCommand = {
  fingerprint: string;
  promise: Promise<unknown>;
  pending: boolean;
  commandId: string;
  editTarget?: string;
  editRecoveredTarget?: string;
  editSessionId?: string;
  editPayload?: EditPayload;
  editState?: 'unknown' | 'confirmed' | 'refused';
  editPromise?: Promise<EditReceipt>;
  approvalTarget?: string;
  approvalIntent?: string;
  approvalState?: 'unknown' | 'confirmed' | 'refused';
  approvalPromise?: Promise<ApprovalReceipt>;
  approvalResult?: unknown;
  queueSessionId?: string;
  queueIntent?: string;
  queueState?: 'unknown' | 'confirmed' | 'refused';
  queuePromise?: Promise<unknown>;
  queueValidate?: (result: unknown, commandId: string) => void;
};

export class CommandRefusedError extends Error {
  constructor(readonly ack: SessionCommandAck) {
    super(ack.message || ack.reasonCode || `Command ${ack.originalStatus ?? ack.status}`);
    this.name = 'CommandRefusedError';
  }
}

export function parseAck(value: unknown, commandId: string): SessionCommandAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandDeliveryUnconfirmedError(commandId);
  const ack = value as Record<string, unknown>;
  const statuses = ['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed'];
  if (ack.commandId !== commandId || typeof ack.status !== 'string' || !statuses.includes(ack.status)
    || (ack.status === 'duplicate' && (typeof ack.originalStatus !== 'string'
      || !statuses.includes(ack.originalStatus) || ack.originalStatus === 'duplicate'))
    || (ack.reasonCode !== undefined && typeof ack.reasonCode !== 'string')
    || (ack.message !== undefined && typeof ack.message !== 'string')) throw new CommandDeliveryUnconfirmedError(commandId);
  return value as SessionCommandAck;
}

export function commandPath(sessionId: string | null): string {
  return sessionId === null ? '/api/sessions/commands' : `/api/sessions/${encodeURIComponent(sessionId)}/commands`;
}

export function uncertain(error: unknown): boolean {
  if (error instanceof Error && 'requestNotSent' in error && error.requestNotSent === true) return false;
  return couldHaveBeenAccepted(error) || (error instanceof Error && error.name === 'AbortError');
}

/** The run writer answers when its turn settles: the host executes /run
 * synchronously (bounded by the turn wall-time limit, up to 3600 s, and it may
 * advance queued successors in the same request). Its default deadline therefore
 * follows the run instead of the 20 s write deadline; ending the original request
 * early made every turn longer than 20 s look unconfirmed and fenced follow-ups. */
export const RUN_COMMAND_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export async function raceAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const cancel = parentSignal ? () => controller.abort(parentSignal.reason) : undefined;
  if (cancel && parentSignal) {
    parentSignal.addEventListener('abort', cancel, { once: true });
    if (parentSignal.aborted) cancel();
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new DOMException('Command timed out', 'TimeoutError')), timeoutMs);
  try { return await Promise.race([work(controller.signal), aborted]); }
  finally {
    clearTimeout(timer);
    if (cancel && parentSignal) parentSignal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
