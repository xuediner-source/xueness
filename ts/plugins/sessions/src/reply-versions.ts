/**
 * Versions of the latest reply, as chat front ends call swipes: regenerating keeps the reply it replaces,
 * an edited reply is saved as a new version, and any kept version can be put back.
 *
 * Only the latest turn has versions, and only when it is a plain reply: the messages after the last user
 * message are assistant messages without tool calls, so swapping them never hides a workspace effect.
 * The journal always holds the version in use; `reply_versions` keeps the others:
 *
 *   { anchor: <_message_id of the last user message>, others: Message[][], position: number }
 *
 * The version in use sits at `position` among `others`, so versions are numbered 0..others.length. A
 * different anchor (a new user message, an edit or a rewind) makes the record stale; it is then ignored.
 */
import { isDict, isPyIntValue, pyDeepCopy } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";

type Row = Record<string, any>;
export type ReplyVersionAction = "regenerate" | "select_version" | "edit_reply";
/** Versions kept for one reply, the one in use included. */
export const MAX_REPLY_VERSIONS = 10;

interface LatestReply { anchorIndex: number; anchor: string; reply: Row[] }

/** The latest turn's reply when it is a plain one, else null. */
function latestReply(session: Session): LatestReply | null {
  const messages = Array.isArray(session.messages) ? session.messages as unknown[] : [];
  const anchorIndex = messages.findLastIndex((message) => isDict(message) && message.role === "user");
  const anchor = anchorIndex >= 1 ? messages[anchorIndex] as Row : null;
  if (!anchor || typeof anchor._message_id !== "string" || !anchor._message_id) return null;
  const reply = messages.slice(anchorIndex + 1);
  if (!reply.length || reply.some((message) => !isDict(message) || message.role !== "assistant" || Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) return null;
  return { anchorIndex, anchor: anchor._message_id, reply: reply as Row[] };
}

/** The kept versions for this anchor, or none when the record is stale or malformed. */
function kept(session: Session, anchor: string): { others: Row[][]; position: number } {
  const record = session.reply_versions;
  if (!isDict(record) || record.anchor !== anchor || !Array.isArray(record.others) || !record.others.every((version) => Array.isArray(version) && version.length > 0 && version.every(isDict))) return { others: [], position: 0 };
  const others = (record.others as Row[][]).slice(0, MAX_REPLY_VERSIONS - 1);
  const position = isPyIntValue(record.position) ? Math.max(0, Math.min(others.length, Number(record.position))) : others.length;
  return { others, position };
}

/** Metadata about messages after `keep` describes replies that are no longer in the journal. */
function pruneAfter(session: Session, keep: number): void {
  for (const key of ["reasoning_history", "reasoning_timing"]) if (Array.isArray(session[key])) session[key] = (session[key] as unknown[]).filter((row) => isDict(row) && isPyIntValue(row.message_index) && Number(row.message_index) < keep);
  if (isDict(session.message_annotations)) session.message_annotations = Object.fromEntries(Object.entries(session.message_annotations).filter(([key]) => /^\d+$/u.test(key) && Number(key) < keep));
}

/**
 * Apply one action to the session in memory. Returns a refusal, or null when the session was changed.
 * `regenerate` leaves the turn waiting for a new reply (status pending); the caller then runs the session.
 */
export function applyReplyVersionAction(session: Session, index: number, action: ReplyVersionAction, input: { version: number; text?: string; newId(): string }): { message: string; status: number } | null {
  const latest = latestReply(session);
  if (!latest || index <= latest.anchorIndex) return { message: "only the latest plain reply has versions", status: 409 };
  const messages = session.messages as Row[], prefix = messages.slice(0, latest.anchorIndex + 1);
  const { others, position } = kept(session, latest.anchor);
  const all = [...others]; all.splice(position, 0, latest.reply);
  const keepAll = (list: Row[][]): Row[][] => list.slice(-(MAX_REPLY_VERSIONS - 1));
  if (action === "regenerate") {
    const stored = keepAll(all);
    session.reply_versions = { anchor: latest.anchor, others: stored, position: stored.length };
    session.messages = prefix;
    pruneAfter(session, prefix.length);
    const turn = prefix.filter((message) => message.role === "user").length;
    session.completion_history = (Array.isArray(session.completion_history) ? session.completion_history as Row[] : []).filter((row) => isDict(row) && /^turn-[1-9][0-9]*$/.test(String(row.turn_id)) && Number(String(row.turn_id).slice(5)) < turn);
    Object.assign(session, { status: "pending", completion: null, pending_question: null, pause_code: null, pause_reason: null, streaming: null, runtime_activity: null });
    delete session.runtime_budget;
    return null;
  }
  if (action === "select_version") {
    if (input.version >= all.length) return { message: "that reply version no longer exists", status: 409 };
    const chosen = all[input.version]!;
    session.reply_versions = { anchor: latest.anchor, others: all.filter((_, at) => at !== input.version), position: input.version };
    session.messages = [...prefix, ...chosen];
  } else {
    const target = messages[index]!;
    if (typeof target.content !== "string") return { message: "this reply cannot be edited as text", status: 409 };
    const edited = pyDeepCopy(target) as Row;
    edited.content = input.text ?? ""; edited._message_id = input.newId();
    const reply = latest.reply.map((message) => message === target ? edited : message);
    const stored = keepAll(all);
    session.reply_versions = { anchor: latest.anchor, others: stored, position: stored.length };
    session.messages = [...prefix, ...reply];
  }
  pruneAfter(session, prefix.length);
  if (session.status !== "running") Object.assign(session, { status: "completed", pending_question: null, pause_code: null, pause_reason: null, streaming: null });
  return null;
}

/** What the conversation view needs: how many versions the latest reply has and which one is shown. */
export function publicReplyVersions(session: Session): { messageIndex: number; count: number; position: number } | null {
  const latest = latestReply(session);
  if (!latest) {
    // A reply being regenerated: the versions are kept while the new one is written.
    const messages = Array.isArray(session.messages) ? session.messages as Row[] : [];
    const last = messages.at(-1);
    if (!isDict(last) || last.role !== "user" || typeof last._message_id !== "string") return null;
    const { others } = kept(session, last._message_id);
    return others.length ? { messageIndex: messages.length, count: others.length + 1, position: others.length } : null;
  }
  const { others, position } = kept(session, latest.anchor);
  return { messageIndex: latest.anchorIndex + latest.reply.length, count: others.length + 1, position };
}
