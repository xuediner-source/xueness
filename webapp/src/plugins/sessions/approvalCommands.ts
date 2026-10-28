import { CommandDeliveryUnconfirmedError, CommandRefusedError, createSessionCommandId, uncertain } from './commandClient';
import type { ApprovalReceipt, RememberedCommand, SessionCommandAck, SessionCommandClient } from './commandClient';
import { DeliveryUnconfirmedError } from './submissionTransport';
import type { PendingApproval, SubmissionResult } from '../../xuenessWorkbench';

/** Confirm the requested decision and journal capability before continuing. */
function validateApprovalCommandResult(toolCallId: string, kind: unknown, decision: unknown,
  result: unknown, commandId: string): void {
  const unconfirmed = () => new CommandDeliveryUnconfirmedError(commandId);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed();
  const record = result as Record<string, unknown>;
  const field = decision === 'reject' ? 'rejected' : 'approved';
  const inner = record[field];
  if (record[field === 'approved' ? 'rejected' : 'approved'] !== undefined
    || !inner || typeof inner !== 'object' || Array.isArray(inner)) throw unconfirmed();
  const confirmation = inner as Record<string, unknown>;
  if (confirmation.tool_call_id !== toolCallId || confirmation.kind !== kind
    || typeof kind !== 'string' || !kind) throw unconfirmed();
}

export function refuseApproval(reason: 'conflict' | 'capacity'): Promise<never> {
  return Promise.reject(Object.assign(new Error(reason === 'conflict'
    ? 'An earlier approval decision is unconfirmed; query it before changing the decision'
    : 'Too many unconfirmed approvals; query their outcomes before approving again'), { requestNotSent: true }));
}

export function submitApproval(client: SessionCommandClient, remembered: Map<string, RememberedCommand>,
  maxRemembered: number, trim: () => void, sessionId: string, type: 'approve' | 'approval' | 'reject', payload: Record<string, unknown>,
  direct: (signal: AbortSignal) => Promise<unknown>): Promise<ApprovalReceipt> {
  const toolCallId = String(payload.tool_call_id || '');
  const target = JSON.stringify([sessionId, toolCallId]);
  const kind = payload.kind;
  const decision = type === 'reject' ? 'reject' : payload.decision ?? 'approve';
  const intent = JSON.stringify({ ...payload, decision });
  const entries = [...remembered.values()];
  // Only unsettled writes are retries. A confirmed ACK is historical evidence,
  // not a current grant: restart or revocation can invalidate it independently.
  const existing = entries.reverse().find(entry => entry.approvalTarget === target && entry.approvalState === 'unknown');
  if (existing) {
    if (existing.approvalIntent !== intent) return refuseApproval('conflict');
    if (existing.approvalPromise) return existing.approvalPromise;
    existing.pending = true;
    existing.approvalPromise = settleApproval(existing, client.query(sessionId, existing.commandId), kind, decision, true, trim);
    return existing.approvalPromise;
  }
  if ([...remembered.values()].filter(entry => entry.approvalState === 'unknown').length
    >= Math.max(1, maxRemembered)) return refuseApproval('capacity');
  const commandId = createSessionCommandId();
  const submitted = client.submit(sessionId, type, payload, direct, commandId);
  const entry = remembered.get(`/api/sessions/${encodeURIComponent(sessionId)}/commands:${commandId}`);
  if (!entry) return submitted.then(result => ({ commandId, result }));
  entry.approvalTarget = target; entry.approvalIntent = intent; entry.approvalState = 'unknown';
  entry.approvalPromise = settleApproval(entry, submitted, kind, decision, false, trim);
  return entry.approvalPromise;
}

function settleApproval(entry: RememberedCommand, work: Promise<unknown>, kind: unknown, decision: unknown,
  queried: boolean, trim: () => void): Promise<ApprovalReceipt> {
  return work.then(value => finishApproval(entry, { value }, kind, decision, queried),
    error => finishApproval(entry, { error }, kind, decision, queried)).catch(error => {
    if (uncertain(error)) throw new CommandDeliveryUnconfirmedError(entry.commandId);
    throw error;
  }).finally(() => {
    entry.pending = false; entry.approvalPromise = undefined; trim();
  });
}

/** Both initial delivery and read-only recovery settle the same guarded identity. */
function finishApproval(entry: RememberedCommand, outcome: { value: unknown } | { error: unknown },
  kind: unknown, decision: unknown, queried: boolean): ApprovalReceipt {
  try {
    if ('error' in outcome) throw outcome.error;
    let result = outcome.value;
    if (queried) {
      if (result === 'unknown') throw new CommandDeliveryUnconfirmedError(entry.commandId);
      const ack = result as SessionCommandAck;
      const status = ack.status === 'duplicate' ? ack.originalStatus : ack.status;
      if (status === 'failed') throw new CommandDeliveryUnconfirmedError(entry.commandId);
      if (status !== 'accepted' && status !== 'noop') throw new CommandRefusedError(ack);
      result = ack.result;
    }
    validateApprovalCommandResult(JSON.parse(entry.approvalTarget!)[1], kind, decision, result, entry.commandId);
    entry.approvalState = 'confirmed';
    entry.approvalResult = result;
    return { commandId: entry.commandId, result };
  } catch (error) {
    if (queried) {
      if (error instanceof CommandRefusedError) entry.approvalState = 'refused';
      else throw new CommandDeliveryUnconfirmedError(entry.commandId);
    } else if (!uncertain(error)) entry.approvalState = 'refused';
    throw error;
  }
}

export async function approvePending(
  id: string,
  pending: PendingApproval,
  commands: SessionCommandClient | undefined,
  post: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  toErrorMessage: (error: unknown) => string,
  commandWasEffective: boolean,
  decision: 'approve' | 'reject' = 'approve',
  /** `message`: reject feedback for the model; `scope: 'session'`: allow identical calls for this session. Waiting calls only. */
  answer: { message?: string; scope?: 'session' | 'project' } = {},
): Promise<SubmissionResult<string>> {
  // Contract §4: validate and build the body locally first — rejected shapes
  // must fail without any network request.
  const toolCallId = typeof pending?.tool_call_id === "string" ? pending.tool_call_id : "";
  const subject = typeof pending?.subject === "string" ? pending.subject : "";
  const name = typeof pending?.name === "string" ? pending.name : "";

  if (!toolCallId) {
    return { ok: false, error: "approval is missing tool_call_id" };
  }

  let body: Record<string, unknown>;
  if (typeof pending.kind === "string" && pending.kind) {
    // New approval rows are resolved from their canonical journal entry on the
    // server. Only send the capability and call id; never replay client args.
    body = { kind: pending.kind, tool_call_id: toolCallId };
  } else
  if (name === "write" || name === "edit") {
    if (!subject) return { ok: false, error: "approval is missing subject" };
    body = { kind: name, subject, tool_call_id: toolCallId };
  } else if (name === "exec") {
    let argv: unknown;
    try {
      argv = JSON.parse(subject);
    } catch {
      return { ok: false, error: "exec approval subject must be a JSON array" };
    }
    if (!Array.isArray(argv)) {
      return { ok: false, error: "exec approval subject must be a JSON array" };
    }
    body = { kind: "exec", argv, tool_call_id: toolCallId };
  } else if (name.startsWith("mcp__")) {
    if (!subject) return { ok: false, error: "approval is missing subject" };
    // The subject is resolved server-side from the journal; never send it.
    body = { kind: "mcp", tool_call_id: toolCallId };
  } else {
    return { ok: false, error: "unsupported approval kind" };
  }

  try {
    // Loading the approval path must not turn a just-disabled command into REST.
    if (commandWasEffective && !commands?.isEffective()) throw Object.assign(
      new Error('Approval cancelled because sessions is no longer effective'), { requestNotSent: true });
    // Rejecting only answers a call that waits in the running turn (ZCode "拒绝").
    if (decision === 'reject') {
      const message = typeof answer.message === 'string' ? answer.message.trim().slice(0, 2000) : '';
      body = { ...body, decision: 'reject', ...(message ? { message } : {}) };
    } else if (answer.scope === 'project' && pending.projectRules?.length) body = { ...body, scope: 'project' };
    else if (answer.scope === 'session' && pending.waiting && !pending.oneShot) body = { ...body, scope: 'session' };
    const direct = (signal: AbortSignal) => post(body, signal);
    const result = commands ? (await commands.submitApproval(id, decision, body, direct))?.result
      : await direct(AbortSignal.timeout(20000));
    const resumed = !!result && typeof result === 'object' && (result as Record<string, unknown>).resumed === true;
    return { ok: true, value: toolCallId, ...(resumed ? { resumed: true } : {}) };
  } catch (error) {
    const outcomeUnknown = error instanceof CommandDeliveryUnconfirmedError;
    return {
      ok: false,
      error: toErrorMessage(outcomeUnknown ? new DeliveryUnconfirmedError() : error),
      ...(outcomeUnknown ? { outcomeUnknown: true, commandId: error.commandId } : {}),
    };
  }
}

