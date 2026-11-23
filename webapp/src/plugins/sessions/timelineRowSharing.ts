/**
 * Structural sharing for polled session data: unchanged rows, list entries and
 * snapshots keep their previous object identity, so memoized views skip work.
 */
import type { SessionSummary, TimelineRow, WorkbenchSession } from './workbenchTypes';

/** Show durable text during generation and after an interrupted request. */
export function reasoningTimeMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function withAssistantStream(rows: TimelineRow[], stream: WorkbenchSession["streaming"]): TimelineRow[] {
  if (!stream || (!stream.text && !stream.reasoning) || !["streaming", "interrupted"].includes(stream.status)) return rows;
  const streamingIndex = rows.findLastIndex(row => row.kind === "assistant"
    && (row.streamId === stream.id || row.turnId === stream.id)
    && (row.streaming === true || row.interrupted === true));
  const streaming = stream.status === "streaming";
  const interrupted = stream.status === "interrupted";
  const startedAt = reasoningTimeMs(stream.reasoning_started_at);
  const endedAt = reasoningTimeMs(stream.reasoning_ended_at)
    ?? (interrupted ? reasoningTimeMs(stream.interrupted_at) : undefined);
  const update = (row: Extract<TimelineRow, { kind: "assistant" }>): TimelineRow => ({ ...row,
    text: stream.text,
    streamId: stream.id,
    ...(stream.reasoning ? { reasoning: stream.reasoning } : (row.reasoning ? { reasoning: row.reasoning } : {})),
    ...(startedAt !== undefined ? { startedAt } : (row.startedAt !== undefined ? { startedAt: row.startedAt } : {})),
    ...(endedAt !== undefined ? { endedAt } : (row.endedAt !== undefined ? { endedAt: row.endedAt } : {})),
    streaming,
    interrupted,
  });
  // A reasoning-only stream starts with an empty answer and may later receive
  // public text. Match the synthetic row by stream id so the answer updates in
  // place instead of leaving a duplicate reasoning card behind.
  if (streamingIndex >= 0) {
    const current = rows[streamingIndex];
    if (current?.kind !== "assistant") return rows;
    const next = update(current);
    return isEqualTimelineRow(current, next) ? rows : [...rows.slice(0, streamingIndex), next, ...rows.slice(streamingIndex + 1)];
  }
  const latest = rows[rows.length - 1];
  if (latest?.kind === "assistant" && (!latest.turnId || latest.turnId === stream.id || latest.streamId === stream.id)
      && (latest.turnId === stream.id || latest.streamId === stream.id || latest.text === stream.text)) {
    if (latest.streaming === streaming && (latest.interrupted === true) === interrupted
      && (!stream.reasoning || latest.reasoning === stream.reasoning)
      && (startedAt === undefined || latest.startedAt === startedAt)
      && (endedAt === undefined || latest.endedAt === endedAt)) return rows;
    return [...rows.slice(0, -1), update(latest)];
  }
  return [...rows, { kind: "assistant", seq: rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1,
    turnId: stream.id, text: stream.text,
    streamId: stream.id,
    ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}),
    streaming, ...(interrupted ? { interrupted: true } : {}) }];
}

function shallowEqualRecords(a: Record<string, unknown> | undefined | null, b: Record<string, unknown> | undefined | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function isEqualTimelineRow(a: TimelineRow, b: TimelineRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.seq !== b.seq) return false;
  if (a.kind === "subagent" && b.kind === "subagent") {
    return a.turnId === b.turnId && a.toolCallId === b.toolCallId && a.taskId === b.taskId && a.agent === b.agent
      && a.label === b.label && a.status === b.status && a.summary === b.summary && a.childSessionId === b.childSessionId
      && a.steps === b.steps;
  }
  if (a.kind === "user" && b.kind === "user") {
    return a.turnId === b.turnId && a.text === b.text && a.displayText === b.displayText && a.messageId === b.messageId && a.messageIndex === b.messageIndex && a.messageRevision === b.messageRevision;
  }
  if (a.kind === "assistant" && b.kind === "assistant") {
    return a.turnId === b.turnId && a.text === b.text && a.displayText === b.displayText && a.reasoning === b.reasoning && a.messageId === b.messageId && a.messageIndex === b.messageIndex && a.messageRevision === b.messageRevision && a.feedback === b.feedback && a.streaming === b.streaming
      && a.streamId === b.streamId && a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.interrupted === b.interrupted;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    if (a.turnId !== b.turnId || a.toolCallId !== b.toolCallId || a.name !== b.name || a.subject !== b.subject || a.status !== b.status || a.error !== b.error || a.errorCode !== b.errorCode || a.archivedForCompaction !== b.archivedForCompaction) return false;
    if (!shallowEqualRecords(a.input, b.input)) return false;
    if (a.output !== b.output) {
      if (typeof a.output === "object" && typeof b.output === "object" && a.output !== null && b.output !== null) {
        if (!shallowEqualRecords(a.output as Record<string, unknown>, b.output as Record<string, unknown>)) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  if (a.kind === "completion" && b.kind === "completion") {
    return a.verified === b.verified && a.summary === b.summary && a.status === b.status && a.toolExecutionStatus === b.toolExecutionStatus && a.deliveryStatus === b.deliveryStatus && a.turnId === b.turnId;
  }
  if (a.kind === "pending_question" && b.kind === "pending_question") {
    return a.question === b.question;
  }
  if ((a.kind === "citation" || a.kind === "preview" || a.kind === "artifact") && a.kind === b.kind) {
    return a.turnId === b.turnId && a.path === b.path && a.label === b.label && a.anchorRole === b.anchorRole
      && a.startLine === b.startLine && a.endLine === b.endLine && a.sizeBytes === b.sizeBytes && a.messageId === b.messageId;
  }
  return false;
}

/** Structural sharing for timeline rows to avoid re-rendering unchanged cards on polling ticks. */
export function stabilizeTimelineRows(prevRows: TimelineRow[] | undefined, nextRows: TimelineRow[]): TimelineRow[] {
  if (!prevRows || prevRows.length === 0) return nextRows;
  if (prevRows === nextRows) return prevRows;

  let allReused = prevRows.length === nextRows.length;
  const result: TimelineRow[] = new Array(nextRows.length);
  for (let i = 0; i < nextRows.length; i++) {
    const nextItem = nextRows[i];
    const prevItem = prevRows[i];
    if (prevItem && isEqualTimelineRow(prevItem, nextItem)) {
      result[i] = prevItem;
    } else {
      result[i] = nextItem;
      allReused = false;
    }
  }
  return allReused ? prevRows : result;
}

/** Merge overlapping transcript windows by durable row identity, preferring
 * the newest tail values while preserving global display order. */
export function mergeTimelineRowsByIdentity(...pages: TimelineRow[][]): TimelineRow[] {
  const rows = new Map<string, TimelineRow>();
  for (const page of pages) for (const row of page) {
    const identity = row.kind === 'tool' ? `tool:${row.toolCallId}`
      : row.kind === 'subagent' ? `subagent:${row.toolCallId}:${row.taskId}`
      : (row.kind === 'user' || row.kind === 'assistant') && row.messageId ? `${row.kind}:${row.messageId}`
      : row.kind === 'completion' ? `completion:${row.turnId ?? ''}:${row.summary}`
      : row.kind === 'pending_question' ? `question:${row.question}`
      : (row.kind === 'citation' || row.kind === 'preview' || row.kind === 'artifact')
        ? `${row.kind}:${row.messageId ?? row.turnId}:${row.path}:${row.startLine ?? ''}:${row.endLine ?? ''}:${row.seq}`
        : `${row.kind}:${row.seq}`;
    rows.set(identity, row);
  }
  return [...rows.values()].sort((left, right) => left.seq - right.seq);
}

function areSessionSummariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return a.id === b.id && a.task === b.task && a.title === b.title && a.status === b.status && a.pinned === b.pinned && a.root === b.root && a.updatedAt === b.updatedAt
    && a.workspace === b.workspace && a.workspaceId === b.workspaceId && a.workspacePath === b.workspacePath
    && a.workspaceName === b.workspaceName && a.purpose === b.purpose && a.unread === b.unread
    && a.unreadAt === b.unreadAt && JSON.stringify(a.pendingInteraction ?? null) === JSON.stringify(b.pendingInteraction ?? null)
    && JSON.stringify(a.changeSummary ?? null) === JSON.stringify(b.changeSummary ?? null)
    && JSON.stringify(a.remote ?? null) === JSON.stringify(b.remote ?? null)
    && JSON.stringify(a.sidecar ?? null) === JSON.stringify(b.sidecar ?? null);
}

/** Structural sharing for session lists so polling skips re-rendering when sessions are unchanged. */
export function stabilizeSessionList(prev: SessionSummary[] | undefined, next: SessionSummary[]): SessionSummary[] {
  if (!prev || prev.length === 0) return next;
  if (prev === next) return prev;
  if (prev.length === next.length) {
    let allEqual = true;
    for (let i = 0; i < prev.length; i++) {
      if (!areSessionSummariesEqual(prev[i], next[i])) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) return prev;
  }

  const prevById = new Map<string, SessionSummary>();
  for (const item of prev) prevById.set(item.id, item);
  return next.map(item => {
    const existing = prevById.get(item.id);
    return existing && areSessionSummariesEqual(existing, item) ? existing : item;
  });
}

/** Compare JSON-shaped snapshots independent of object key order. API payloads
 * are parsed JSON, so enumerable own fields and array order define identity. */
function areSessionSnapshotsEqual(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  const seen = new WeakMap<object, WeakSet<object>>();

  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    if (Object.is(left, right)) continue;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;

    const leftArray = Array.isArray(left);
    if (leftArray !== Array.isArray(right)) return false;
    if (!leftArray) {
      const leftPrototype = Object.getPrototypeOf(left);
      const rightPrototype = Object.getPrototypeOf(right);
      // Parsed payload objects are plain records. Treat other object types as
      // changed unless they were already identical above.
      if (leftPrototype !== rightPrototype || (leftPrototype !== Object.prototype && leftPrototype !== null)) return false;
    }

    let paired = seen.get(left);
    if (paired?.has(right)) continue;
    if (!paired) {
      paired = new WeakSet<object>();
      seen.set(left, paired);
    }
    paired.add(right);

    if (leftArray) {
      const leftItems = left as unknown[];
      const rightItems = right as unknown[];
      if (leftItems.length !== rightItems.length) return false;
      for (let index = 0; index < leftItems.length; index++) {
        pending.push([leftItems[index], rightItems[index]]);
      }
      continue;
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      pending.push([leftRecord[key], rightRecord[key]]);
    }
  }
  return true;
}

/** Structural sharing for session details so polling returns the stable object reference when data has not changed. */
export function stabilizeSession(prev: WorkbenchSession | null | undefined, next: WorkbenchSession): WorkbenchSession {
  if (!prev || prev.id !== next.id) return next;
  return areSessionSnapshotsEqual(prev, next) ? prev : next;
}
