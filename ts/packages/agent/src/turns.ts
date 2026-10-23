import { pyLen, PyValueError } from "@xueness/contracts";
import { recordAttachments, withAttachments, type Attachment, type Session, type SessionStore } from "@xueness/sessions";

export interface TurnOptions { attachments?: readonly Attachment[]; preserveWhitespace?: boolean; queueMessageId?: string; persist?: boolean }
export class SessionStateError extends Error { override name = "LookupError"; }
export async function appendUserTurn(session: Session, store: SessionStore, text: string, options: TurnOptions = {}): Promise<Session> {
  if (typeof text !== "string" || !text.trim() || pyLen(text) > 5000) throw new PyValueError("message must be 1..5000 characters");
  if (!["pending", "completed", "needs_review", "paused", "stopped"].includes(session.status as string)) throw new SessionStateError("session is not ready for a new turn");
  if (session.pending_question) throw new SessionStateError("answer the pending question first");
  if (options.queueMessageId !== undefined && !/^[0-9a-f]{32}$/.test(options.queueMessageId)) throw new PyValueError("invalid queued message id");
  if (!Array.isArray(session.messages)) session.messages = [];
  (session.messages as unknown[]).push({ role: "user", content: withAttachments(options.preserveWhitespace ? text : text.trim(), options.attachments) });
  recordAttachments(session, options.attachments);
  if (options.queueMessageId !== undefined) session.current_queue_item_id = options.queueMessageId;
  session.status = "pending"; session.completion = null; delete session.completion_reference_repair;
  if (options.persist !== false) await store.save(session);
  return session;
}

export async function answerSession(session: Session, store: SessionStore, answer: string, options: TurnOptions = {}): Promise<Session> {
  if (session.status !== "awaiting_user" || !session.pending_question) throw new SessionStateError("session is not awaiting a user answer");
  if (typeof answer !== "string" || !answer.trim() || pyLen(answer) > 5000) throw new PyValueError("answer must be 1..5000 characters");
  const content = withAttachments("Operator answer: " + (options.preserveWhitespace ? answer : answer.trim()), options.attachments);
  session.pending_question = null; delete session.completion_reference_repair;
  if (!Array.isArray(session.messages)) session.messages = [];
  (session.messages as unknown[]).push({ role: "user", content });
  recordAttachments(session, options.attachments);
  session.status = "paused"; await store.save(session);
  return session;
}
