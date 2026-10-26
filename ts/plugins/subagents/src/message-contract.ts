/**
 * Coordinator message contract (F08.03): task identity resolution, the
 * split between message admission and the authorization boundary, and the
 * escalation request protocol a blocked child uses to ask its parent one
 * question (`escalations/<child>.json` beside `inboxes/`). The answer rides
 * the same safe-boundary inbox as any guide message, so ordering and
 * idempotency stay identical; only the pending-question refusal differs —
 * answering the escalation is exactly what clears it.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonLoads, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { isLink, pyExceptionName, readRegularBytes } from "@xueness/sessions";
import { ChildJournal, enqueueMessage, writeJournalRow } from "./child-journal.ts";
import type { Row } from "./definitions.ts";

const TASK = /^task-[A-Za-z0-9_-]{1,160}$/;
const REQUEST = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_ESCALATION_CHARS = 24000;
const MAX_ESCALATION_ITEMS = 40;
const ESCALATIONS = "escalations";

const digestOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const validMessage = (value: unknown): value is string => typeof value === "string" && !!pyStrip(value) && pyLen(value) <= MAX_ESCALATION_CHARS;
const validRequestId = (value: unknown): value is string => typeof value === "string" && REQUEST.test(value);

/** Resolve the (task id, child session) pair against this parent's registry row. */
export function resolveTaskIdentity(input: { taskId: unknown; row: Row | null; parentSessionId: unknown; childSessionId?: unknown }): Row {
  const { taskId, row } = input;
  if (typeof taskId !== "string" || !TASK.test(taskId)) return { ok: false, reason: "invalid_task_id", error: "task_id must name a task of this parent turn" };
  if (row == null || typeof row.id !== "string") return { ok: false, reason: "not_found", error: "unknown task id for this parent" };
  if (row.parent !== input.parentSessionId) return { ok: false, reason: "foreign_parent", error: "task belongs to another parent session" };
  if (input.childSessionId !== undefined && row.childSessionId !== undefined && row.childSessionId !== input.childSessionId) {
    return { ok: false, reason: "stale_child", error: "task identity no longer matches its child session" };
  }
  return { ok: true, taskId, childSessionId: row.childSessionId ?? null };
}

function escalationDirectory(journal: ChildJournal): string {
  const directory = join(journal.directory, ESCALATIONS);
  if (isLink(directory)) throw new PyValueError("invalid child escalation directory");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return directory;
}

function loadEscalations(journal: ChildJournal, childId: string): { directory: string; row: Row; items: Row[] } {
  const directory = escalationDirectory(journal);
  let row: Row;
  try { row = pyJsonLoads(readRegularBytes(join(directory, childId + ".json")).toString("utf8"), { lossless: true }) as Row; }
  catch (error) {
    if (pyExceptionName(error) !== "FileNotFoundError") throw error;
    row = { id: childId, items: [] };
  }
  if (!isDict(row) || !Array.isArray(row.items)) throw new PyValueError("invalid child escalation record");
  return { directory, row, items: row.items };
}

/**
 * Child side: raise one blocking question for `taskId`. Idempotent per
 * requestId; a task with a pending escalation cannot raise a second until it
 * is answered, and a full record prunes answered items like the inbox does.
 */
export function raiseEscalation(journal: ChildJournal, child: Row, question: unknown, requestId: unknown, taskId: unknown): Row {
  if (!validMessage(question) || !validRequestId(requestId)) throw new PyValueError("valid question and requestId are required");
  if (typeof taskId !== "string" || !TASK.test(taskId)) throw new PyValueError("valid task id is required");
  if (!isDict(child) || child.id == null || (child.status !== "pending" && child.status !== "running")) throw new PyValueError("child cannot raise an escalation in its current state");
  if (isDict(child.delegation) && child.delegation.cancelled === true) throw new PyValueError("child cannot raise an escalation in its current state");
  const { directory, row, items } = loadEscalations(journal, String(child.id));
  const digest = digestOf(question);
  for (const item of items) {
    if (!isDict(item) || item.id !== requestId) continue;
    if (item.digest !== digest) throw new PyValueError("requestId already names a different escalation");
    return { id: item.id, taskId: item.taskId, status: item.status };
  }
  const open = items.find((item) => isDict(item) && item.status === "pending" && item.taskId === taskId);
  if (open != null) throw new PyValueError("child already has a pending escalation for this task");
  if (items.length >= MAX_ESCALATION_ITEMS) {
    const settled = items.findIndex((item) => isDict(item) && item.status === "answered");
    if (settled < 0) throw new PyValueError("child escalation record is full");
    items.splice(settled, 1);
  }
  items.push({ id: requestId, taskId, question, digest, status: "pending", createdAt: Date.now() / 1000 });
  writeJournalRow(directory, row);
  return { id: requestId, taskId, status: "pending" };
}

/** Pending (unanswered) escalations of one child, optionally for one task. */
export function pendingEscalations(journal: ChildJournal, child: Row, taskId?: string): Row[] {
  if (!isDict(child) || child.id == null) return [];
  let loaded: { items: Row[] };
  try { loaded = loadEscalations(journal, String(child.id)); } catch { return []; }
  return loaded.items.filter((item) => isDict(item) && item.status === "pending" && (taskId === undefined || item.taskId === taskId)).map((item) => ({ ...item }));
}

/**
 * Child side: apply every queued inbox item to the child transcript at a safe
 * boundary. Each item becomes one coordinator guide message (`_coordination`),
 * so the prompt view attributes it to the coordinating parent rather than the
 * user; the item is stamped `applied` in the same atomic step, and a replay of
 * the same drain never re-delivers an applied message. Returns the messages
 * added (empty when nothing was queued).
 */
export function drainInbox(journal: ChildJournal, child: Row): Row[] {
  if (!isDict(child) || child.id == null) return [];
  const inbox = join(journal.directory, "inboxes", String(child.id) + ".json");
  let row: Row;
  try { row = pyJsonLoads(readRegularBytes(inbox).toString("utf8"), { lossless: true }) as Row; }
  catch (error) {
    if (pyExceptionName(error) === "FileNotFoundError") return [];
    throw error;
  }
  if (!isDict(row) || !Array.isArray(row.items)) throw new PyValueError("invalid child message inbox");
  if (!Array.isArray(child.messages)) throw new PyValueError("child transcript is unavailable for delivery");
  const delivered: Row[] = [];
  for (const item of row.items) {
    if (!isDict(item) || item.status !== "queued" || typeof item.message !== "string") continue;
    child.messages.push({ role: "user", content: item.message, _input_kind: "guide", _coordination: true, _message_id: item.id, ...(typeof item.summary === "string" ? { _coordination_summary: item.summary } : {}) });
    item.status = "applied";
    item.appliedAt = Date.now() / 1000;
    delivered.push({ id: item.id, status: "applied" });
  }
  if (delivered.length) {
    writeJournalRow(join(journal.directory, "inboxes"), row);
    // Applying the queued answer is exactly what clears the pending question:
    // the flag falls only when no escalation of this child is still open.
    if (child.pending_question && pendingEscalations(journal, child).length === 0) child.pending_question = false;
  }
  return delivered;
}

/**
 * Parent side: answer one escalation. The answer is enqueued into the child's
 * safe-boundary inbox verbatim (a pending question does not block its own
 * answer) and the escalation is stamped answered exactly once — a replay with
 * the same requestId and answer returns the stored receipt; anything else on
 * an answered escalation is refused.
 */
export function answerEscalation(journal: ChildJournal, child: Row, escalationId: unknown, answer: unknown, answerRequestId: unknown): Row {
  if (!validRequestId(escalationId) || !validMessage(answer) || !validRequestId(answerRequestId)) throw new PyValueError("valid escalation id, answer and requestId are required");
  if (!isDict(child) || child.id == null) throw new PyValueError("child escalation record is unavailable");
  const { directory, row, items } = loadEscalations(journal, String(child.id));
  const item = items.find((entry) => isDict(entry) && entry.id === escalationId);
  if (item == null) throw new PyValueError("unknown escalation");
  if (item.status === "answered") {
    if (item.answerRequestId === answerRequestId && item.answerDigest === digestOf(answer)) {
      return { id: item.id, taskId: item.taskId, status: "answered", delivery: "guide", receipt: { id: answerRequestId, status: "queued" }, replay: true };
    }
    throw new PyValueError("escalation already answered");
  }
  const receipt = enqueueMessage(journal, child, answer, answerRequestId, { pendingQuestionOk: true });
  item.status = "answered";
  item.answeredAt = Date.now() / 1000;
  item.answerDigest = digestOf(answer);
  item.answerRequestId = answerRequestId;
  writeJournalRow(directory, row);
  return { id: item.id, taskId: item.taskId, status: "answered", delivery: "guide", receipt };
}
