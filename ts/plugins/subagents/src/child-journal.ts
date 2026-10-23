/**
 * Parent-scoped child journals (Python `child_sessions.py`): list, validate,
 * project, explicit resume, and the safe-boundary inbox. The kernel session
 * store is not reused; its save hooks rewrite parent journals.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDict, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyLen, pySlice, pyStrip, PyValueError, uuid4Hex } from "@xueness/contracts";
import { isLink, isPyOSError, mkstemp, protectPrivateFile, pyCodeCompare, pyExceptionName, readRegularBytes, realish, replaceFile, writeAll } from "@xueness/sessions";
import type { Row } from "./definitions.ts";
import { recoveryInfo, validParent } from "./records.ts";

const MAX_CHILD_BYTES = 8 * 1024 * 1024;
const MAX_CHILD_MESSAGES = 2000;
const MAX_CHILD_SESSIONS = 100;
const MAX_INBOX_ITEMS = 40;
const MAX_MESSAGE_CHARS = 24000;
const SID = /^[0-9a-f]{32}$/;
const TASK = /^task-[A-Za-z0-9_-]{1,160}$/;
const REQUEST = /^[A-Za-z0-9._:-]{1,160}$/;

export function childDirectory(stateDir: string, parent: string): string {
  if (!validParent(parent)) throw new PyValueError("invalid parent session id");
  if (isLink(stateDir)) throw new PyValueError("invalid child session directory");
  let current = stateDir;
  for (const name of ["subagent-sessions", parent]) {
    current = join(current, name);
    if (isLink(current)) throw new PyValueError("invalid child session directory");
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return current;
}

function jsonNames(directory: string): string[] {
  const windows = process.platform === "win32";
  return readdirSync(directory).filter((name) => windows ? name.toLowerCase().endsWith(".json") : name.endsWith(".json")).sort(pyCodeCompare);
}

function byteSize(value: unknown): number {
  return pyEncodeUtf8(pyJsonDumps(value)).byteLength;
}

export class ChildJournal {
  readonly parent: string;
  readonly taskId: string | null;
  readonly root: string | null;
  readonly directory: string;

  constructor(stateDir: string, parent: string, options: { taskId?: string | null; root?: string | null } = {}) {
    this.parent = parent;
    this.taskId = options.taskId ?? null;
    this.root = options.root == null ? null : realish(String(options.root));
    this.directory = childDirectory(stateDir, parent);
  }

  validate(child: unknown): Row {
    if (!isDict(child) || !SID.test(String(child.id || ""))) throw new PyValueError("invalid child session id");
    const lineage = child.delegation;
    if (!isDict(lineage) || lineage.parentSessionId !== this.parent) throw new PyValueError("child does not belong to parent session");
    if (!TASK.test(String(lineage.taskId || ""))) throw new PyValueError("invalid child task id");
    if (this.taskId != null && lineage.taskId !== this.taskId) throw new PyValueError("child does not belong to task");
    if (this.root != null && realish(String(child.root || "")) !== this.root) throw new PyValueError("child workspace does not match parent");
    if (child.read_only !== true || child.permission_mode !== "plan") throw new PyValueError("invalid child permission ceiling");
    if (!Array.isArray(child.messages) || child.messages.length > MAX_CHILD_MESSAGES) throw new PyValueError("child transcript limit reached");
    if (byteSize(child) > MAX_CHILD_BYTES) throw new PyValueError("child transcript size limit reached");
    return child;
  }

  load(sid: string): Row {
    const path = join(this.directory, sid + ".json");
    if (statSync(path).size > MAX_CHILD_BYTES) throw new PyValueError("child transcript size limit reached");
    return this.validate(pyJsonLoads(readRegularBytes(path).toString("utf8"), { lossless: true }));
  }

  findTask(taskId: string): Row {
    if (!TASK.test(taskId)) throw new PyValueError("invalid task id");
    const names = jsonNames(this.directory);
    if (names.length > MAX_CHILD_SESSIONS) throw new PyValueError("child session limit reached for parent");
    for (const name of names) {
      const stem = name.slice(0, -".json".length);
      if (!SID.test(stem)) continue;
      try {
        const child = this.load(stem);
        if (isDict(child.delegation) && child.delegation.taskId === taskId) return child;
      } catch (error) { if (isPyOSError(error) || error instanceof PyValueError || error instanceof TypeError) continue; throw error; }
    }
    const missing = new Error("child session not found");
    missing.name = "FileNotFoundError";
    throw missing;
  }

  children(): Row[] {
    const names = jsonNames(this.directory);
    if (names.length > MAX_CHILD_SESSIONS) throw new PyValueError("child session limit reached for parent");
    const rows: Row[] = [];
    for (const name of names) {
      const stem = name.slice(0, -".json".length);
      if (!SID.test(stem)) continue;
      try { rows.push(this.load(stem)); } catch (error) { if (isPyOSError(error) || error instanceof PyValueError || error instanceof TypeError) continue; throw error; }
    }
    rows.sort((left, right) => {
      const a = isDict(left.delegation) && typeof left.delegation.createdAt === "number" && left.delegation.createdAt ? left.delegation.createdAt : 0;
      const b = isDict(right.delegation) && typeof right.delegation.createdAt === "number" && right.delegation.createdAt ? right.delegation.createdAt : 0;
      if (a !== b) return a - b;
      const leftId = String(left.id || ""), rightId = String(right.id || "");
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return rows;
  }
}

export function projectChild(child: Row): Row {
  const lineage = child.delegation;
  if (!isDict(lineage)) throw new TypeError("delegation");
  const status = child.status;
  const mapped = status === "completed" ? "completed" : status === "stopped" || status === "cancelled" ? "cancelled" : status === "running" ? "running" : "failed";
  const completion = child.completion;
  return {
    id: lineage.taskId, parent: lineage.parentSessionId, parentSessionId: lineage.parentSessionId,
    rootSessionId: lineage.rootSessionId, childSessionId: child.id, agent: lineage.agent, status: mapped,
    childStatus: status, steps: child.steps ?? 0, startedAt: lineage.createdAt, endedAt: lineage.endedAt,
    summary: isDict(completion) ? pySlice(String(completion.summary || ""), 4000) : "",
    error: pySlice(String(child.pause_reason || ""), 500), ...recoveryInfo(child),
  };
}

export function prepareResume(child: Row, message?: unknown): Row {
  const info = recoveryInfo(child);
  if (!info.canResume) throw new PyValueError("child recovery refused: " + info.recoveryReason);
  if (message != null && (typeof message !== "string" || !pyStrip(message) || pyLen(message) > MAX_MESSAGE_CHARS)) throw new PyValueError("message must contain 1..24000 characters");
  if (info.recoveryReason === "followup_required" && message == null) throw new PyValueError("completed child requires a followup message");
  if (typeof message === "string") {
    if (!Array.isArray(child.messages)) throw new PyValueError("child recovery refused: invalid_transcript");
    child.messages.push({ role: "user", content: message, _message_id: uuid4Hex(), _turn_id: uuid4Hex() });
  }
  if (isDict(child.streaming)) { child.streaming.status = "interrupted"; child.streaming.interrupted = true; }
  child.status = "pending";
  child.completion = null;
  delete child.pause_code;
  delete child.pause_reason;
  if (!isDict(child.delegation)) throw new PyValueError("child recovery refused: invalid_transcript");
  const count = child.delegation.resumeCount;
  child.delegation.resumeCount = (typeof count === "number" && Number.isInteger(count) ? count : 0) + 1;
  return child;
}

function writeInbox(directory: string, row: Row): void {
  const bytes = pyEncodeUtf8(pyJsonDumps(row, { indent: 2 }));
  const temp = mkstemp(directory, ".session-");
  let fd: number | null = temp.fd;
  try {
    protectPrivateFile(fd);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    replaceFile(temp.path, join(directory, String(row.id) + ".json"));
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
}

export function enqueueMessage(journal: ChildJournal, child: Row, message: unknown, requestId: unknown): Row {
  if (typeof message !== "string" || !pyStrip(message) || pyLen(message) > MAX_MESSAGE_CHARS || typeof requestId !== "string" || !REQUEST.test(requestId)) throw new PyValueError("valid message and requestId are required");
  const delegationCancelled = isDict(child.delegation) && child.delegation.cancelled === true;
  if ((child.status !== "pending" && child.status !== "running") || delegationCancelled || child.pending_question) throw new PyValueError("child cannot accept messages in its current state");
  const directory = join(journal.directory, "inboxes");
  if (isLink(directory)) throw new PyValueError("invalid child inbox directory");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const path = join(directory, String(child.id) + ".json");
  let row: Row;
  try { row = pyJsonLoads(readRegularBytes(path).toString("utf8"), { lossless: true }) as Row; }
  catch (error) { if (pyExceptionName(error) === "FileNotFoundError") row = { id: child.id, items: [] }; else throw error; }
  if (!isDict(row) || !Array.isArray(row.items)) throw new PyValueError("valid message and requestId are required");
  const digest = createHash("sha256").update(message, "utf8").digest("hex");
  for (const item of row.items) {
    if (!isDict(item) || item.id !== requestId) continue;
    if (item.digest !== digest) throw new PyValueError("requestId already names a different message");
    return { id: item.id, status: item.status };
  }
  if (row.items.length >= MAX_INBOX_ITEMS) {
    const settled = row.items.findIndex((item) => isDict(item) && item.status === "applied");
    if (settled < 0) throw new PyValueError("child message inbox is full");
    row.items.splice(settled, 1);
  }
  row.items.push({ id: requestId, message, digest, status: "queued", createdAt: Date.now() / 1000 });
  writeInbox(directory, row);
  return { id: requestId, status: "queued" };
}
