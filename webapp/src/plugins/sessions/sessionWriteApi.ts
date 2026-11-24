/**
 * Session writes. A saved turn survives a later run failure: results carry
 * `accepted`/`outcomeUnknown` so callers never submit the same turn twice.
 */
import type { RunChoices } from '../../xuenessBridge';
import { getRunChoices, readRunOptIns } from '../../xuenessBridge';
import type { PendingApproval } from './approvalTypes';
import type { SessionCommandClient } from './commandClient';
import type { FollowupAdmission } from './commandLedger';
import { CommandDeliveryUnconfirmedError, createSessionCommandId, validateCreateCommandResult, validateEditCommandResult, validateSendCommandResult } from './commandReceipt';
import { cancelQueuedMessage } from './queueApi';
import { requestMutation, requestPost, sessionPath, toErrorMessage } from './sessionHttp';
import { couldHaveBeenAccepted, DeliveryUnconfirmedError, submitQueuedTurn } from './submissionTransport';
import type { QueuedMessage, Result, SubmissionResult, TimelineRow } from './workbenchTypes';

/** Renaming changes the display title only; the original task stays intact. */
export async function renameSession(id: string, title: string): Promise<Result<string>> {
  const clean = title.trim();
  if (!clean || clean.length > 120 || /[\x00-\x1f\x7f]/.test(clean)) {
    return { ok: false, error: "title must be 1..120 printable characters" };
  }
  try {
    const result = await requestMutation<{ title: string }>("PATCH", sessionPath(id), { title: clean });
    return { ok: true, value: result.title };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Soft-delete archives the journal; it never deletes workspace files. */
export async function deleteSession(id: string): Promise<Result<void>> {
  try {
    await requestMutation<{ deleted: boolean }>("DELETE", sessionPath(id), {});
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Toggles the sidebar pin flag on a live session. */
export async function pinSession(id: string, pinned: boolean): Promise<Result<void>> {
  try {
    await requestPost(sessionPath(id, "/pin"), { pinned });
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Moves an archived session back into the active list. */
export async function restoreSession(id: string, signal?: AbortSignal): Promise<Result<void>> {
  try {
    await requestPost(sessionPath(id, "/restore"), {}, signal);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function approvePending(
  id: string,
  pending: PendingApproval,
  commands?: SessionCommandClient,
  decision: 'approve' | 'reject' = 'approve',
  answer: { message?: string; scope?: 'session' | 'project' } = {},
): Promise<SubmissionResult<string>> {
  const commandWasEffective = commands?.isEffective() === true;
  return import('./approvalCommands').then(module => module.approvePending(id, pending, commands,
    (body, signal) => requestPost(sessionPath(id, "/approvals"), body, signal), toErrorMessage, commandWasEffective, decision, answer))
    .catch(error => ({ ok: false, error: toErrorMessage(error) }));
}

/**
 * Shared run body: user choices + opt-ins. Runs never add a step budget: the
 * server loop follows ZCode and runs until the model stops calling tools
 * (an explicit caller `steps` choice is still forwarded unchanged).
 * readRunOptIns fails closed to {} and must never enable a capability.
 */
async function runSessionWith(id: string, choices?: RunChoices, options?: { continueQueue?: boolean; promotionRequestId?: string; mayStart?: () => boolean }, commands?: SessionCommandClient): Promise<void> {
  const useCommands = commands?.isEffective() === true;
  const mayStart = options?.mayStart ?? (useCommands ? () => commands!.isEffective() : undefined);
  if (mayStart && !mayStart()) throw new Error('Session commands are no longer enabled');
  const effectiveChoices = choices ?? getRunChoices();
  const optIns = await readRunOptIns();
  if (mayStart && !mayStart()) throw new Error('Session commands are no longer enabled');
  const body = {
    ...effectiveChoices,
    ...optIns,
    ...(options?.continueQueue ? { continue_queue: true } : {}),
    ...(options?.promotionRequestId ? { promotion_request_id: options.promotionRequestId } : {}),
  };
  if (commands) {
    const commandId = createSessionCommandId();
    validateSendCommandResult(id, await commands.submit(id, 'run', body,
      signal => requestPost(sessionPath(id, '/run'), body, signal, mayStart), commandId), commandId);
  }
  else await requestPost(sessionPath(id, '/run'), body, undefined, mayStart);
}

export async function createSession(
  task: string,
  choices?: RunChoices,
  /** `plugin_ref`: the plugin that starts this session tags it with its own reference (validated by the server). */
  context?: { root?: string; prepared_token?: string; plugin_ref?: { plugin: string; id: string } },
  onCreated?: (id: string) => void,
  commands?: SessionCommandClient,
): Promise<SubmissionResult<string>> {
  let createdId = "";
  try {
    // No root: sessions default to the host workspace root.
    const useCommands = commands?.isEffective() === true;
    const commandId = commands ? createSessionCommandId() : undefined;
    const body = { task, ...context };
    const created = commands
      ? await commands.submitCreate(body, signal => requestPost('/api/sessions', body, signal), commandId)
      : await requestPost<{ id?: string }>('/api/sessions', body, AbortSignal.timeout(20000));
    const id = useCommands ? validateCreateCommandResult(created, commandId)
      : created && typeof created === 'object' && 'id' in created && typeof created.id === 'string' ? created.id : '';
    if (!id) throw new DeliveryUnconfirmedError();
    createdId = id;
    onCreated?.(id);
    await runSessionWith(id, choices, useCommands ? { mayStart: () => commands!.isEffective() } : undefined, commands);
    return { ok: true, value: id };
  } catch (error) {
    const outcomeUnknown = (!createdId && couldHaveBeenAccepted(error)) || error instanceof CommandDeliveryUnconfirmedError;
    return { ok: false, error: toErrorMessage(outcomeUnknown ? new DeliveryUnconfirmedError() : error),
      ...(createdId ? { accepted: true, id: createdId } : {}), ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(error instanceof CommandDeliveryUnconfirmedError ? { commandId: error.commandId } : {}) };
  }
}

export async function sendTurn(
  id: string,
  text: string,
  choices?: RunChoices,
  preparedToken?: string,
  onAccepted?: () => void,
  commands?: SessionCommandClient,
): Promise<SubmissionResult<void>> {
  let accepted = false;
  try {
    const useCommands = commands?.isEffective() === true;
    const body = { text, ...(preparedToken ? { prepared_token: preparedToken } : {}) };
    if (commands) validateSendCommandResult(id, await commands.submit(id, 'send', body, signal => requestPost(sessionPath(id, '/messages'), body, signal)));
    else await requestPost(sessionPath(id, '/messages'), body, AbortSignal.timeout(20000));
    accepted = true;
    onAccepted?.();
    await runSessionWith(id, choices, useCommands ? { mayStart: () => commands!.isEffective() } : undefined, commands);
    return { ok: true, value: undefined };
  } catch (error) {
    const outcomeUnknown = (!accepted && couldHaveBeenAccepted(error)) || error instanceof CommandDeliveryUnconfirmedError;
    return { ok: false, error: toErrorMessage(outcomeUnknown ? new DeliveryUnconfirmedError() : error),
      ...(accepted ? { accepted: true } : {}), ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(error instanceof CommandDeliveryUnconfirmedError ? { commandId: error.commandId } : {}) };
  }
}

/** Add a user turn to the active run's FIFO queue. The prepared token is one-use. */
export async function queueTurn(id: string, text: string, preparedToken?: string, commands?: SessionCommandClient, followup?: FollowupAdmission): Promise<SubmissionResult<QueuedMessage>> {
  try {
    if (followup && (!commands || !followup.current())) throw Object.assign(new Error('The observed follow-up turn is no longer current'), {requestNotSent:true});
    const body = { text, request_id: crypto.randomUUID().replaceAll('-', ''), ...(preparedToken ? { prepared_token: preparedToken } : {}),
      ...(followup ? {expected_turn_id: followup.proof.expectedTurnId} : {}) };
    const payload = commands
      ? await commands.submit(id, 'queue', body, signal => requestPost(sessionPath(id, '/queue'), body, signal, followup?.current), undefined, followup)
      : await submitQueuedTurn((path, legacyBody, signal) => requestPost(path, legacyBody, signal), id, text, preparedToken);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new DeliveryUnconfirmedError();
    const record = payload as Record<string, unknown>;
    const item = record.item && typeof record.item === "object" && !Array.isArray(record.item)
      ? record.item as Record<string, unknown>
      : null;
    if (typeof record.id !== "string" || !record.id || !item || typeof item.id !== "string" || item.id !== record.id || typeof item.text !== "string"
      || typeof item.status !== "string" || (item.status !== "queued" && item.status !== "paused") || !Number.isInteger(item.position) || (item.position as number) < 0
      || (item.created_at !== undefined && typeof item.created_at !== "string")
      || (item.updated_at !== undefined && typeof item.updated_at !== "string")) throw new DeliveryUnconfirmedError();
    return { ok: true, value: {
      id: record.id,
      text: item.text,
      status: item.status,
      position: item.position as number,
      ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
      ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
      ...(typeof item.pause_reason === "string" ? { pause_reason: item.pause_reason } : {}),
    } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), ...(error instanceof DeliveryUnconfirmedError ? { outcomeUnknown: true } : {}),
      ...(error instanceof CommandDeliveryUnconfirmedError ? { commandId: error.commandId } : {}) };
  }
}

/** A stop ACK admits cancellation; existing polling observes the worker settling. */
export async function stopSession(id: string, expectedTurnId: string | null, commands?: SessionCommandClient): Promise<Result<{ stopping: boolean }>> {
  try {
    const body = { expected_turn_id: expectedTurnId };
    const payload = commands
      ? await commands.submit(id, 'stop', body, signal => requestPost(sessionPath(id, '/stop'), {}, signal))
      : await requestPost(sessionPath(id, '/stop'), {});
    if (!payload || typeof payload !== 'object' || typeof (payload as { stopping?: unknown }).stopping !== 'boolean') {
      throw new DeliveryUnconfirmedError();
    }
    return { ok: true, value: { stopping: (payload as { stopping: boolean }).stopping } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

/** Cancel a queued turn; the server rejects removal after the worker claims it. */
export async function cancelQueuedTurn(id: string, queueId: string, expectedText?: string,
  commands?: SessionCommandClient, expectedRevision?: number): Promise<SubmissionResult<void>> {
  const wasEffective = commands?.isEffective();
  try {
    if (wasEffective && !commands?.isEffective()) throw Object.assign(new Error('Session commands are no longer enabled'), { requestNotSent: true });
    await cancelQueuedMessage(id, queueId, expectedText, commands, expectedRevision);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error),
      ...(error instanceof CommandDeliveryUnconfirmedError ? { outcomeUnknown: true, ...('queueIntentMismatch' in error ? {} : { commandId: error.commandId }) } : {}) };
  }
}

export async function answerQuestion(id: string, answer: string): Promise<Result<void>> {
  try {
    await requestPost(sessionPath(id, "/answer"), { answer });
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function runSession(id: string, choices?: RunChoices, options?: { continueQueue?: boolean; promotionRequestId?: string }, commands?: SessionCommandClient): Promise<SubmissionResult<void>> {
  try {
    await runSessionWith(id, choices, options, commands);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error),
      ...(couldHaveBeenAccepted(error) ? { outcomeUnknown: true } : {}),
      ...(error instanceof CommandDeliveryUnconfirmedError ? { commandId: error.commandId } : {}) };
  }
}

/** The journal-issued revision and message index identify one persisted row. */
export async function updateConversationMessage(id: string,
  row: Extract<TimelineRow, {kind: 'user' | 'assistant'}>,
  action: {action: 'edit'; text: string; prepared_token?: string} | {action: 'feedback'; feedback: 'like' | 'dislike' | null},
  commands?: SessionCommandClient,
): Promise<SubmissionResult<void>> {
  if (row.messageIndex === undefined || !row.messageRevision) return {ok: false, error: 'Refresh this conversation before editing its history'};
  try {
    const body = { revision: row.messageRevision, messageIndex: row.messageIndex, ...action };
    if (action.action === 'edit') {
      const editBody = { revision: row.messageRevision, messageIndex: row.messageIndex, ...action };
      if (commands) {
        const receipt = await commands.submitEdit(id, editBody,
          signal => requestMutation('PATCH', sessionPath(id, '/message-actions'), editBody, signal));
        return {ok: true, value: undefined, commandId: receipt.commandId};
      }
      validateEditCommandResult(id, row.messageIndex, await requestMutation('PATCH',
        sessionPath(id, '/message-actions'), editBody, AbortSignal.timeout(20000)));
    } else await requestMutation('PATCH', sessionPath(id, '/message-actions'), body);
    return {ok: true, value: undefined};
  } catch (error) {
    const outcomeUnknown = action.action === 'edit' && couldHaveBeenAccepted(error);
    return {ok: false, error: toErrorMessage(outcomeUnknown ? new DeliveryUnconfirmedError() : error),
      ...(outcomeUnknown ? {outcomeUnknown: true} : {}),
      ...(error instanceof CommandDeliveryUnconfirmedError ? {commandId: error.commandId} : {})};
  }
}
