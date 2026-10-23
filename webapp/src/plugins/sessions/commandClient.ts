import { CommandReceiptLedger, validFollowupProof, type FollowupAdmission, type CommandReceiptStorage, type PendingCommandReference } from './commandLedger';
import { couldHaveBeenAccepted } from './submissionTransport';
import {
  CommandDeliveryUnconfirmedError, createSessionCommandId, validateCreateCommandResult, validateEditCommandResult,
  validateSendCommandResult,
} from './commandReceipt';

export {
  CommandDeliveryUnconfirmedError, createSessionCommandId, validateCreateCommandResult, validateEditCommandResult,
  validateSendCommandResult,
};

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

type Requests = {
  post: (path: string, body: unknown, signal: AbortSignal, beforeSend?: () => boolean) => Promise<unknown>;
  get: (path: string, signal: AbortSignal) => Promise<unknown>;
};
type Options = Requests & {
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
type EditReceipt = { commandId: string; result: unknown };
type EditPayload = { revision: string; messageIndex: number; action: 'edit'; text: string; prepared_token?: string };
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

let approvalCommands: typeof import('./approvalCommands') | undefined;
let approvalLoading: Promise<typeof import('./approvalCommands')> | undefined;

export function loadApprovalCommands(): Promise<typeof import('./approvalCommands')> {
  return approvalLoading ??= import('./approvalCommands').then(module => (approvalCommands = module)).catch(error => {
    approvalLoading = undefined;
    throw error;
  });
}

export class CommandRefusedError extends Error {
  constructor(readonly ack: SessionCommandAck) {
    super(ack.message || ack.reasonCode || `Command ${ack.originalStatus ?? ack.status}`);
    this.name = 'CommandRefusedError';
  }
}

function parseAck(value: unknown, commandId: string): SessionCommandAck {
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

function commandPath(sessionId: string | null): string {
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

/** A settled ACK confirms the existing writer's result; projection owns progress. */
export class SessionCommandClient {
  private readonly active = new Set<AbortController>();
  private readonly remembered = new Map<string, RememberedCommand>();
  private disposed = false;
  private approvalGeneration = 0;
  private readonly approvalLoads = new Map<string, { intent: string; promise: Promise<ApprovalReceipt> }>();

  private readonly ledger?: CommandReceiptLedger;
  constructor(private readonly options: Options) {
    if (options.receiptScope) this.ledger = new CommandReceiptLedger(options.receiptScope, options.receiptStorage);
  }

  pendingCommands(): PendingCommandReference[] { try { return this.ledger?.pending() ?? []; } catch { return []; } }
  recoveryStorageWarning(): string | null { return this.ledger?.recoveryWarning() ?? null; }
  recoveryStorageError(): string | null {
    return this.ledger?.recoveryError() ?? null;
  }

  isEffective(): boolean { return !this.disposed && this.options.isEffective(); }

  /** This page still awaits the original write (or its exact query); it is not a lost receipt. */
  isInFlight(sessionId: string | null, commandId: string): boolean {
    return this.remembered.get(`${commandPath(sessionId)}:${commandId}`)?.pending === true;
  }

  /** Disabling cancels deadlines and reads; it never falls back after a sent command. */
  cancelPending(): void {
    this.approvalGeneration++;
    for (const controller of this.active) controller.abort(new DOMException('Command cancelled', 'AbortError'));
  }

  dispose(): void { this.disposed = true; this.cancelPending(); this.remembered.clear(); this.approvalLoads.clear(); }

  private ensureEffective(commandId: string): void {
    if (!this.isEffective()) throw new CommandDeliveryUnconfirmedError(commandId);
  }

  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = this.options.timeoutMs ?? 20000): Promise<T> {
    if (this.disposed) throw Object.assign(new Error('Command client disposed'), { requestNotSent: true });
    if (this.active.size >= (this.options.maxPending ?? 16)) {
      throw Object.assign(new Error('Too many pending commands'), { requestNotSent: true });
    }
    const controller = new AbortController();
    this.active.add(controller);
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new DOMException('Command timed out', 'TimeoutError')), timeoutMs);
    try { return await Promise.race([work(controller.signal), aborted]); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.active.delete(controller);
    }
  }

  private async request<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? 20000): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parent.reason);
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
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
      parent.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async queryWithSignal(sessionId: string | null, commandId: string, signal: AbortSignal): Promise<SessionCommandAck | 'unknown'> {
    this.ensureEffective(commandId);
    if (signal.aborted) throw signal.reason;
    const response = await this.request(requestSignal => this.options.get(
      `${commandPath(sessionId)}/${encodeURIComponent(commandId)}`, requestSignal), signal);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new CommandDeliveryUnconfirmedError(commandId);
    const result = (response as Record<string, unknown>).result;
    const ack = result === 'unknown' ? 'unknown' : parseAck(result, commandId);
    await this.ledger?.settle(sessionId, commandId, ack, () => !signal.aborted && this.isEffective());
    return ack;
  }

  /** A caller may query an unconfirmed identity; querying never resends a write. */
  async query(sessionId: string, commandId: string): Promise<SessionCommandAck | 'unknown'> {
    this.ensureEffective(commandId);
    return this.bounded(signal => this.queryWithSignal(sessionId, commandId, signal));
  }

  /** Creation has no session id yet, so recovery uses the collection bucket. */
  async queryCreate(commandId: string): Promise<SessionCommandAck | 'unknown'> {
    this.ensureEffective(commandId);
    return this.bounded(signal => this.queryWithSignal(null, commandId, signal));
  }

  submitCreate(payload: Record<string, unknown>, direct: (signal: AbortSignal) => Promise<unknown>,
    commandId = createSessionCommandId()): Promise<unknown> {
    return this.submitAt(null, 'create_session', payload, direct, commandId);
  }

  submit(sessionId: string, type: SessionCommandType, payload: Record<string, unknown>,
    direct: (signal: AbortSignal) => Promise<unknown>, commandId = createSessionCommandId(), followup?: FollowupAdmission): Promise<unknown> {
    return this.submitAt(sessionId, type, payload, direct, commandId, followup);
  }

  /** An unresolved edit retains its target identity; another Save only queries it. */
  submitEdit(sessionId: string, payload: EditPayload,
    direct: (signal: AbortSignal) => Promise<unknown>): Promise<EditReceipt> {
    const target = JSON.stringify([sessionId, payload.revision, payload.messageIndex]);
    const entries = [...this.remembered.values()];
    // Reloading an unknown edit can change its revision and display index. The
    // whole session stays guarded until that original write has a known outcome.
    const existing = entries.find(entry => entry.editSessionId === sessionId && entry.editState === 'unknown')
      ?? entries.find(entry => (entry.editTarget === target || entry.editRecoveredTarget === target) && entry.editState !== 'refused');
    if (existing) {
      if (existing.editState === 'confirmed') return Promise.reject(Object.assign(
        new Error('This edit was already confirmed; refresh the conversation before editing again'), { requestNotSent: true }));
      const sameIntent = existing.editPayload!.messageIndex === payload.messageIndex && existing.editPayload!.text === payload.text && existing.editPayload!.prepared_token === payload.prepared_token;
      // A changed draft may reconcile the original write, but cannot claim it.
      const recover = (promise: Promise<EditReceipt>) => sameIntent ? promise.then(receipt => {
        existing.editRecoveredTarget = target;
        return receipt;
      }) : promise.then(() => {
        throw Object.assign(new Error('An earlier edit was confirmed; refresh the conversation before saving this draft'), { requestNotSent: true });
      });
      if (existing.editPromise) return recover(existing.editPromise);
      existing.pending = true;
      existing.editPromise = this.query(sessionId, existing.commandId).then(ack => {
        if (ack === 'unknown') throw new CommandDeliveryUnconfirmedError(existing.commandId);
        const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
        if (status === 'failed') throw new CommandDeliveryUnconfirmedError(existing.commandId);
        if (status !== 'accepted' && status !== 'noop') throw new CommandRefusedError(ack);
        validateEditCommandResult(sessionId, existing.editPayload!.messageIndex, ack.result, existing.commandId);
        existing.editState = 'confirmed';
        return { commandId: existing.commandId, result: ack.result };
      }).catch(error => {
        if (error instanceof CommandRefusedError) { existing.editState = 'refused'; throw error; }
        throw new CommandDeliveryUnconfirmedError(existing.commandId);
      }).finally(() => {
        existing.pending = false; existing.editPromise = undefined; this.trimRemembered();
      });
      return recover(existing.editPromise);
    }
    // Unknown targets are never evicted to make room for a new write.
    if ([...this.remembered.values()].filter(entry => entry.editState === 'unknown').length
      >= Math.max(1, this.options.maxRemembered ?? 128)) return Promise.reject(Object.assign(
        new Error('Too many unconfirmed edits; query their outcomes before editing again'), { requestNotSent: true }));
    const commandId = createSessionCommandId();
    const submitted = this.submit(sessionId, 'edit_message', payload, direct, commandId);
    const entry = this.remembered.get(`${commandPath(sessionId)}:${commandId}`);
    // Disposed clients reject before remembering or sending anything.
    if (!entry) return submitted.then(result => ({ commandId, result }));
    entry.editTarget = target; entry.editSessionId = sessionId; entry.editPayload = { ...payload }; entry.editState = 'unknown';
    entry.editPromise = submitted.then(result => {
      validateEditCommandResult(sessionId, payload.messageIndex, result, commandId);
      entry.editState = 'confirmed';
      return { commandId, result };
    }).catch(error => {
      if (!uncertain(error)) entry.editState = 'refused';
      throw error;
    }).finally(() => { entry.editPromise = undefined; this.trimRemembered(); });
    return entry.editPromise;
  }

  /** Unknown queue mutations guard the whole queue; retries only query the original identity. */
  submitQueue(sessionId: string, type: QueueCommandType, payload: Record<string, unknown>,
    direct: (signal: AbortSignal) => Promise<unknown>, validate: (result: unknown, commandId: string) => void): Promise<unknown> {
    const intent = JSON.stringify({ type, payload });
    const existing = [...this.remembered.values()].find(entry => entry.queueSessionId === sessionId && entry.queueState === 'unknown');
    if (existing) {
      const recover = existing.queueIntent === intent ? (result: unknown) => result : () => {
        throw Object.assign(new Error('An earlier queue change was confirmed; refresh the queue before changing it again'), { requestNotSent: true });
      };
      if (!existing.queuePromise) {
        existing.pending = true;
        existing.queuePromise = this.settleQueue(existing, this.query(sessionId, existing.commandId), true);
      }
      return existing.queuePromise.then(recover).catch(error => {
        // The original identity belongs to another operation. Its uncertainty
        // cannot be presented as evidence that this requested mutation was sent.
        if (existing.queueIntent !== intent && error instanceof CommandDeliveryUnconfirmedError) {
          throw Object.assign(new CommandDeliveryUnconfirmedError(existing.commandId), { queueIntentMismatch: true });
        }
        throw error;
      });
    }
    if ([...this.remembered.values()].filter(entry => entry.queueState === 'unknown').length
      >= Math.max(1, this.options.maxRemembered ?? 128)) return Promise.reject(Object.assign(
        new Error('Too many unconfirmed queue changes; query their outcomes before changing another queue'), { requestNotSent: true }));
    const commandId = createSessionCommandId();
    const submitted = this.submit(sessionId, type, payload, direct, commandId);
    const entry = this.remembered.get(`${commandPath(sessionId)}:${commandId}`);
    if (!entry) return submitted;
    entry.queueSessionId = sessionId; entry.queueIntent = intent; entry.queueState = 'unknown'; entry.queueValidate = validate;
    entry.queuePromise = this.settleQueue(entry, submitted, false);
    return entry.queuePromise;
  }

  /** A validated non-consuming escrow read can settle only its exact withdrawal intent. */
  confirmQueueWithdrawal(sessionId: string, root: string, withdrawal: import('./queueApi').QueueWithdrawal): boolean {
    if (this.ledger?.pending().some(entry => entry.sessionId === sessionId && entry.commandId === withdrawal.id)) return false;
    return this.confirmQueueWithdrawalLocal(sessionId, root, withdrawal);
  }

  async confirmQueueWithdrawalAsync(sessionId: string, root: string, withdrawal: import('./queueApi').QueueWithdrawal): Promise<boolean> {
    if (!this.confirmQueueWithdrawalLocal(sessionId, root, withdrawal)) return false;
    if (this.ledger && !await this.ledger.confirmWithdrawal(sessionId, root, withdrawal, () => this.isEffective())) return false;
    return this.isEffective();
  }

  private confirmQueueWithdrawalLocal(sessionId: string, root: string, withdrawal: import('./queueApi').QueueWithdrawal): boolean {
    if (!this.isEffective() || withdrawal.sessionId !== sessionId || withdrawal.root !== root) return false;
    const entry = this.remembered.get(`${commandPath(sessionId)}:${withdrawal.id}`);
    if (!entry) return true; // A reloaded client has no unresolved local guard.
    const intent = JSON.stringify({ type: 'withdraw_queue', payload: {
      queueId: withdrawal.queueId, expectedText: withdrawal.text, expectedRevision: withdrawal.expectedRevision,
    } });
    if (entry.queueSessionId !== sessionId || entry.queueIntent !== intent || entry.pending) return false;
    entry.queueValidate!({ id: withdrawal.queueId, removed: true, recoveryId: withdrawal.id }, withdrawal.id);
    entry.queueState = 'confirmed';
    this.trimRemembered();
    return true;
  }

  private settleQueue(entry: RememberedCommand, work: Promise<unknown>, queried: boolean): Promise<unknown> {
    return work.then(value => {
      let result = value;
      if (queried) {
        if (result === 'unknown') throw new CommandDeliveryUnconfirmedError(entry.commandId);
        const ack = result as SessionCommandAck;
        const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
        if (status === 'failed') throw new CommandDeliveryUnconfirmedError(entry.commandId);
        if (status !== 'accepted' && status !== 'noop') throw new CommandRefusedError(ack);
        result = ack.result;
      }
      entry.queueValidate!(result, entry.commandId);
      entry.queueState = 'confirmed';
      return result;
    }).catch(error => {
      if (error instanceof CommandRefusedError || (!queried && !uncertain(error))) entry.queueState = 'refused';
      else throw new CommandDeliveryUnconfirmedError(entry.commandId);
      throw error;
    }).finally(() => {
      entry.pending = false; entry.queuePromise = undefined; this.trimRemembered();
    });
  }

  /** Load approval policy only on use, sharing cold-load calls before any admission. */
  submitApproval(sessionId: string, type: 'approve' | 'approval' | 'reject', payload: Record<string, unknown>,
    direct: (signal: AbortSignal) => Promise<unknown>): Promise<ApprovalReceipt> {
    const submit = (module: typeof import('./approvalCommands')) => module.submitApproval(
      this, this.remembered, this.options.maxRemembered ?? 128, () => this.trimRemembered(), sessionId, type, payload, direct);
    const target = JSON.stringify([sessionId, payload.tool_call_id]);
    const intent = JSON.stringify({ type, payload });
    const existing = this.approvalLoads.get(target);
    if (existing) return existing.intent === intent ? existing.promise
      : loadApprovalCommands().then(module => module.refuseApproval('conflict'));
    if (approvalCommands) return submit(approvalCommands);
    if (this.approvalLoads.size >= Math.max(1, this.options.maxRemembered ?? 128)) {
      return loadApprovalCommands().then(module => module.refuseApproval('capacity'));
    }
    const wasEffective = this.isEffective();
    const generation = this.approvalGeneration;
    const promise = loadApprovalCommands().then(module => {
      if (this.disposed || generation !== this.approvalGeneration || (wasEffective && !this.isEffective())) throw Object.assign(
        new Error('Approval cancelled before admission'), { requestNotSent: true });
      return submit(module);
    }).finally(() => this.approvalLoads.delete(target));
    this.approvalLoads.set(target, { intent, promise });
    return promise;
  }

  private trimRemembered(): void {
    const limit = this.options.maxRemembered ?? 128;
    for (const [oldKey, old] of this.remembered) {
      if (this.remembered.size <= limit) break;
      if (!old.pending && old.editState !== 'unknown' && old.approvalState !== 'unknown' && old.queueState !== 'unknown') this.remembered.delete(oldKey);
    }
  }

  private submitAt(sessionId: string | null, type: SessionCommandType | 'create_session', payload: Record<string, unknown>,
    direct: (signal: AbortSignal) => Promise<unknown>, commandId: string, followup?: FollowupAdmission): Promise<unknown> {
    if (this.disposed) return Promise.reject(Object.assign(new Error('Command client disposed'), { requestNotSent: true }));
    const followupCurrent = () => !followup || (type === 'queue' && validFollowupProof(followup.proof)
      && followup.proof.sessionId === sessionId && followup.proof.expectedTurnId === payload.expected_turn_id && followup.current());
    if (!followupCurrent()) return Promise.reject(Object.assign(new Error('The observed follow-up turn is no longer current'), { requestNotSent: true }));
    if (followup && !this.isEffective()) return Promise.reject(Object.assign(new Error('Follow-up commands are no longer enabled'), {requestNotSent:true}));
    const key = `${commandPath(sessionId)}:${commandId}`;
    const fingerprint = JSON.stringify({ type, payload });
    const existing = this.remembered.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise
      : Promise.reject(Object.assign(new Error('Command identity already used for different input'), { requestNotSent: true }));
    // Compatibility is selected before submission only. An ambiguous command must
    // never be submitted again through REST, even if the plugin later disappears.
    const isSafetyStop = type === 'stop' && sessionId !== null
      && Object.keys(payload).length === 1 && typeof payload.expected_turn_id === 'string'
      && !!payload.expected_turn_id.trim() && payload.expected_turn_id.length <= 128;
    const commandEffective = () => !this.disposed && (this.isEffective()
      || (isSafetyStop && this.options.isSafetyStopEffective?.() === true));
    const useCommands = commandEffective();
    const writeTimeout = type === 'run' && this.options.timeoutMs === undefined ? RUN_COMMAND_TIMEOUT_MS : this.options.timeoutMs ?? 20000;
    const entry: RememberedCommand = { fingerprint, promise: Promise.resolve<unknown>(undefined), pending: true, commandId };
    let ledgerAdmitted = false;
    let dispatched = false;
    entry.promise = this.bounded(async signal => {
      if (!useCommands) {
        if (this.ledger?.pending().some(entry => entry.sessionId === sessionId)) throw Object.assign(
          new Error('An original command is unconfirmed; restore command transport to check its result'), { requestNotSent: true });
        if (this.options.allowDirectFallback === false) throw Object.assign(new Error('Command transport is unavailable'), { requestNotSent: true });
        try { return await direct(signal); }
        catch (error) { if (uncertain(error)) throw new CommandDeliveryUnconfirmedError(commandId); throw error; }
      }
      // Persist before the first POST, including the crash/in-flight window.
      // Admission rechecks stored entries after asynchronous descriptor hashing.
      if (this.ledger) {
        try {
          await this.ledger.admit(sessionId, commandId, type, payload, () => !signal.aborted && commandEffective() && followupCurrent(), followup?.proof);
          ledgerAdmitted = true;
          if (signal.aborted || !commandEffective() || !followupCurrent()) {
            // The outer deadline may already have rejected while the async hash ran.
            // This inner branch is still before transport and owns safe late cleanup.
            this.ledger.forget(sessionId, commandId);
            throw Object.assign(new Error('Command cancelled before admission'), { requestNotSent: true });
          }
        } catch (error) {
          const safetyStop = type === 'stop' && typeof payload.expected_turn_id === 'string' && payload.expected_turn_id.trim().length > 0 && payload.expected_turn_id.length <= 128
            && sessionId !== null && error instanceof Error && 'receiptStorageBlocked' in error;
          if (!safetyStop) throw error;
          // A server-fenced safety stop remains available even when storage is broken/full.
          // Never discard unrelated receipts or use this exception for another mutation.
        }
      }
      let ack: SessionCommandAck;
      if (!commandEffective()) throw Object.assign(new Error('Command transport is unavailable'), { requestNotSent: true });
      if (!followupCurrent()) throw Object.assign(new Error('The observed follow-up turn is no longer current'), { requestNotSent: true });
      if (signal.aborted) throw Object.assign(new Error('Command cancelled before admission'), { requestNotSent: true });
      try {
        this.ledger?.markDispatched(sessionId, commandId);
        dispatched = true;
        ack = parseAck(await this.request(requestSignal => this.options.post(
          commandPath(sessionId), { commandId, type, payload }, requestSignal, () => commandEffective() && followupCurrent()), signal, writeTimeout), commandId);
      } catch (error) {
        if (!uncertain(error)) throw error;
        let resolved: SessionCommandAck | undefined;
        for (let attempt = 0; attempt < Math.min(3, Math.max(1, this.options.queryAttempts ?? 3)); attempt++) {
          this.ensureEffective(commandId);
          if (signal.aborted) throw new CommandDeliveryUnconfirmedError(commandId);
          try {
            const result = await this.queryWithSignal(sessionId, commandId, signal);
            if (result !== 'unknown') { resolved = result; break; }
          } catch (queryError) {
            if (!this.isEffective() || signal.aborted) throw new CommandDeliveryUnconfirmedError(commandId);
            // A query denial or failed read cannot establish the original outcome.
            if (!couldHaveBeenAccepted(queryError)) break;
          }
        }
        if (!resolved) throw new CommandDeliveryUnconfirmedError(commandId);
        ack = resolved;
      }
      const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
      // The backend writes a `failed` receipt after a run handler has returned
      // a terminal provider/session error. Retire only that completed run and
      // surface its original message; other failed commands may have partial
      // effects and must remain fenced until their outcome is known.
      const terminalRunFailure = type === 'run' && status === 'failed';
      if (status === 'failed' && !terminalRunFailure) throw new CommandDeliveryUnconfirmedError(commandId);
      if (ledgerAdmitted && this.ledger && !await this.ledger.settle(sessionId, commandId, ack, () => !signal.aborted && commandEffective())) throw new CommandDeliveryUnconfirmedError(commandId);
      if (terminalRunFailure) throw new CommandRefusedError(ack);
      if (status !== 'accepted' && status !== 'noop') throw new CommandRefusedError(ack);
      if (this.ledger && !ledgerAdmitted && type === 'stop') {
        const stopped = ack.result as {stopping?: unknown; id?: unknown} | null;
        if (!stopped || typeof stopped.stopping !== 'boolean' || (stopped.id !== undefined && stopped.id !== sessionId)) throw new CommandDeliveryUnconfirmedError(commandId);
      }
      return ack.result;
    }, writeTimeout + (this.options.timeoutMs ?? 20000)).catch(error => {
      // A failure to retire a sent receipt is not evidence that transport never sent it.
      // Keep the original fence and report uncertainty, even for a transient quota failure.
      if (dispatched && error instanceof Error && 'receiptStorageBlocked' in error) throw new CommandDeliveryUnconfirmedError(commandId);
      if (ledgerAdmitted && (!dispatched || error instanceof CommandRefusedError
        || (error instanceof Error && 'requestNotSent' in error && error.requestNotSent === true))) {
        // Only proven non-dispatch/refusal can retire a record without a receipt.
        try { this.ledger!.forget(sessionId, commandId); } catch { /* Keep durable fence on storage failure. */ }
      }
      if (uncertain(error) && error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
        throw new CommandDeliveryUnconfirmedError(commandId);
      }
      throw error;
    }).finally(() => {
      entry.pending = false;
      this.trimRemembered();
    });
    this.remembered.set(key, entry);
    return entry.promise;
  }
}
