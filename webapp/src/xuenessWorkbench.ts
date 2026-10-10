import { projectJournalAssistantWork } from './plugins/sessions/conversationJournalProjection';
import { t as tr } from './i18n';

/**
 * Xueness workbench data layer.
 *
 * Every call goes to the real Python API through the same-origin bridge. Nothing
 * here invents state: a failure is reported as `{ok:false, error}` rather than
 * thrown, so the workbench can render an honest error instead of a blank pane.
 *
 * Contract: docs/xueness-workbench-contract.md (frozen). The exported types and
 * function signatures are the interface the UI layer builds against — changing
 * them is a contract change, not a refactor.
 */
import type { PermissionMode } from "./plugins/sessions/permissionModes";
import type { RunChoices } from "./xuenessBridge";
import type { XuenessEventV1 } from "./xuenessEvents";
import { getRunChoices, readRunOptIns } from "./xuenessBridge";
import { parseEventsEnvelope } from "./xuenessEvents";

export type PendingApproval = {
  tool_call_id: string;
  /** Canonical approval capability for newer journal events. Older snapshots omit it. */
  kind?: string;
  name: string;
  subject: string;
  preview: string;
  /** Live one-shot approval, bound to this exact call and subject on the host. */
  granted?: boolean;
};

export type QueuedMessage = {
  id: string;
  text: string;
  status: "queued" | "running" | "paused" | "completed" | "needs_review" | "failed" | "cancelled";
  position?: number;
  created_at?: string;
  updated_at?: string;
  pause_reason?: string;
  editable?: boolean;
};

const QUEUED_MESSAGE_STATUSES = ["queued", "running", "paused", "completed", "needs_review", "failed", "cancelled"] as const;

function parseQueuedMessages(value: unknown): QueuedMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid queued messages response");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid queued messages response");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.text !== "string"
      || typeof record.status !== "string" || !QUEUED_MESSAGE_STATUSES.includes(record.status as typeof QUEUED_MESSAGE_STATUSES[number])
      || (record.position !== undefined && (!Number.isInteger(record.position) || (record.position as number) < 0))
      || (record.created_at !== undefined && typeof record.created_at !== "string")
      || (record.updated_at !== undefined && typeof record.updated_at !== "string")
      || (record.pause_reason !== undefined && typeof record.pause_reason !== "string")
      || (record.editable !== undefined && typeof record.editable !== "boolean")) {
      throw new Error("invalid queued messages response");
    }
    return {
      id: record.id,
      text: record.text,
      status: record.status as QueuedMessage["status"],
      ...(typeof record.position === "number" ? { position: record.position } : {}),
      ...(typeof record.created_at === "string" ? { created_at: record.created_at } : {}),
      ...(typeof record.updated_at === "string" ? { updated_at: record.updated_at } : {}),
      ...(typeof record.pause_reason === "string" ? { pause_reason: record.pause_reason } : {}),
      ...(typeof record.editable === "boolean" ? { editable: record.editable } : {}),
    };
  });
}

export type WorkbenchRuntimeActivity = import('./plugins/providers/LocalRuntimeMonitor').RuntimeActivity & {
  phase: string;
  startedAt?: string;
  requestStep?: number;
  outputChars?: number;
  reasoningChars?: number;
  firstOutputSeconds?: number;
  firstReasoningSeconds?: number;
  requestSeconds?: number;
  charactersPerSecond?: number;
  reportedOutputTokens?: number;
  tokensPerSecond?: number;
};

export type WorkbenchSession = {
  id: string;
  task: string;
  title?: string;
  root?: string;
  status: string;
  pinned?: boolean;
  steps: number;
  mode: string;
  completion?: import('./plugins/planning/CompletionChecks').CompletionAssessment & { summary?: string; evidence?: unknown[] } | null;
  delivery_requirements?: import('./plugins/planning/CompletionChecks').DeliveryRequirement[];
  goal?: import('./plugins/planning/SessionGoal').SessionGoalRecord | null;
  queued_messages?: QueuedMessage[];
  todos?: unknown[];
  pending_question?: string | null;
  /** Bounded provider reasoning, keyed by the assistant message's journal index. */
  reasoning_history?: ReasoningHistoryEntry[];
  pending: PendingApproval[];
  approved: { write: string[]; edit: string[]; exec: string[]; mcp: string[] };
  changed_files: string[];
  streaming?: { id: string; text: string; reasoning?: string; status: "streaming" | "interrupted"; text_format?: "markdown" } | null;
  provider_usage?: Record<string, number>;
  model_selection?: { provider_id?: string | null; model?: string | null; reasoning_effort?: string | null; tool_calling?: "native" | "json" };
  runtime_profile?: "standard" | "lightweight";
  runtime_budget?: {
    profile?: "standard" | "lightweight";
    contextWindow?: number;
    reservedOutputTokens?: number;
    safetyReserveTokens?: number;
    inputBudgetTokens?: number;
    estimatedInputTokens?: number;
    previousEstimatedTokens?: number;
    estimateMethod?: string;
    omittedMessages?: number;
    activeTools?: number;
    overflowRetry?: boolean;
  } | null;
  runtime_activity?: WorkbenchRuntimeActivity | null;
  runtime_activity_history?: WorkbenchRuntimeActivity[] | null;
  tool_timings?: { step: number; name: string; tool_call_id: string; seconds: number; ok: boolean }[];
  pause_reason?: string | null;
  /** Stable reason code for resumable execution-budget pauses. */
  pause_code?: string | null;
  permission_mode?: PermissionMode;
  browser_enabled?: boolean;
  remote_connection?: { id: string; digest: string } | null;
  forkParent?: ForkParentInfo | null;
};

export type SessionSummary = { id: string; task: string; title?: string; status: string; pinned?: boolean; root?: string; updatedAt?: string };

export type ArchivedSummary = { id: string; task: string; title?: string; archivedAt?: string };

export type ForkBoundary = { token: string; turn: number; endIndex: number; preview: string };
export type ForkParentInfo = {
  sourceId: string;
  sourceRevision: string;
  turn: number;
  endIndex: number;
  historyTruncated: boolean;
  truncationReason: string | null;
};
export type ForkBoundaryList = {
  sourceId: string;
  revision: string;
  boundaries: ForkBoundary[];
  historyTruncated: boolean;
  truncationReason: string | null;
  hasUnclosedTurn: boolean;
};
export type ForkSessionResponse = {
  session: { id: string; status: string; root: string; title: string; forkParent?: ForkParentInfo };
  sourceId: string;
  boundary: { turn: number; preview: string };
  historyTruncated: boolean;
  truncationReason: string | null;
};

export type TimelinePage = {
  events: XuenessEventV1[];
  cursor: number;
  nextCursor: number;
  head: number;
  hasMore: boolean;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type ReasoningHistoryEntry = { message_index: number; text: string };
/** A saved turn survives a later run failure and must not be submitted twice. */
export type SubmissionResult<T> = Result<T> & { accepted?: boolean; id?: string };

export type WorkspaceListing = {
  files: { path: string; size: number }[];
  truncated: boolean;
  count: number;
};

export type OfficeRun = { text: string; style?: { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; fontSize?: number } };
export type OfficeImage = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataUrl: string; alt?: string };
export type OfficeBlock = {
  type?: "paragraph" | "table" | "shape" | "image" | "text";
  text?: string;
  table?: string[][];
  runs?: OfficeRun[];
  images?: OfficeImage[];
  style?: { paragraphStyle?: string; align?: "left" | "center" | "right" | "justify"; fill?: string };
  position?: { x?: number; y?: number; width?: number; height?: number };
  cellStyles?: Record<string, unknown>[][];
  columns?: { min: number; max: number; width: number; hidden?: boolean }[];
  mergedRanges?: string[];
};
export type OfficeSection = {
  name: string;
  blocks: OfficeBlock[];
  layout?: { width?: number; height?: number; unit?: "emu" | "twip" };
};
export type OfficePreview = { kind: "docx" | "xlsx" | "pptx"; sections: OfficeSection[]; truncated: boolean; imageCount?: number; /** Base64 of a server-sanitized OOXML subset for optional full document/slide renderers. */ fullDocument?: string };

export type FilePreview = {
  path: string;
  size: number;
  truncated: boolean;
  /** Present for whitelisted image types: a data URL for <img> (no text then). */
  image?: string;
  /** Present for pdf/audio/video: a data URL + mime for <embed>/<audio>/<video>. */
  embed?: { mime: string; dataUrl: string };
  office?: OfficePreview;
  text: string;
};

/** 工具调用展示状态：显式枚举（参考 zcode 的 CompactToolCallState + stopped 特判）。
 * 展示层只做显式映射，不再用 errorCode 推导；"cancelled" 等状态由行构造时确定。 */
export type ToolDisplayStatus = "queued" | "running" | "ok" | "error" | "cancelled" | "stopped";

export type TimelineRow =
  | { kind: "user"; seq: number; turnId: string; text: string; messageIndex?: number; messageRevision?: string }
  | { kind: "assistant"; seq: number; turnId: string; text: string; reasoning?: string; messageIndex?: number; messageRevision?: string; feedback?: 'like' | 'dislike'; streaming?: boolean; startedAt?: number; endedAt?: number; interrupted?: boolean }
  | {
      kind: "tool";
      seq: number;
      turnId: string;
      toolCallId: string;
      name: string;
      subject: string;
      status: ToolDisplayStatus;
      error: string;
      errorCode: string;
      input?: Record<string, unknown>;
      output?: unknown;
    }
  | { kind: "completion"; seq: number; verified: boolean; summary: string; status?: "verified" | "unverified" | "not_applicable" | "incomplete"; toolExecutionStatus?: "succeeded" | "failed" | "incomplete" | "not_applicable"; deliveryStatus?: "passed" | "failed" | "not_assessed"; turnId?: string }
  | { kind: "pending_question"; seq: number; question: string };

/** Show durable text during generation and after an interrupted request. */
export function withAssistantStream(rows: TimelineRow[], stream: WorkbenchSession["streaming"]): TimelineRow[] {
  if (!stream || (!stream.text && !stream.reasoning) || !["streaming", "interrupted"].includes(stream.status)) return rows;
  const latest = rows[rows.length - 1];
  if (latest?.kind === "assistant" && latest.text === stream.text) {
    const streaming = stream.status === "streaming";
    const interrupted = stream.status === "interrupted";
    if (latest.streaming === streaming && (latest.interrupted === true) === interrupted && (!stream.reasoning || latest.reasoning === stream.reasoning)) return rows;
    return [...rows.slice(0, -1), { ...latest, ...(stream.reasoning ? { reasoning: stream.reasoning } : {}), streaming, interrupted }];
  }
  return [...rows, { kind: "assistant", seq: rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1,
    turnId: stream.id, text: stream.text,
    ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
    streaming: stream.status === "streaming", ...(stream.status === "interrupted" ? { interrupted: true } : {}) }];
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
  if (a.kind === "user" && b.kind === "user") {
    return a.turnId === b.turnId && a.text === b.text && a.messageIndex === b.messageIndex && a.messageRevision === b.messageRevision;
  }
  if (a.kind === "assistant" && b.kind === "assistant") {
    return a.turnId === b.turnId && a.text === b.text && a.reasoning === b.reasoning && a.messageIndex === b.messageIndex && a.messageRevision === b.messageRevision && a.feedback === b.feedback && a.streaming === b.streaming
      && a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.interrupted === b.interrupted;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    if (a.turnId !== b.turnId || a.toolCallId !== b.toolCallId || a.name !== b.name || a.subject !== b.subject || a.status !== b.status || a.error !== b.error || a.errorCode !== b.errorCode) return false;
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

function areSessionSummariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return a.id === b.id && a.task === b.task && a.title === b.title && a.status === b.status && a.pinned === b.pinned && a.root === b.root && a.updatedAt === b.updatedAt;
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

  let anyReused = false;
  const result = next.map(item => {
    const existing = prevById.get(item.id);
    if (existing && areSessionSummariesEqual(existing, item)) {
      anyReused = true;
      return existing;
    }
    return item;
  });
  return result;
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

// -- implementation below is filled by the data-layer lane ------------------

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Same-origin fetch helper. Any non-2xx or unreadable body becomes a thrown
 * Error that the exported wrappers catch into `{ok:false, error}` — it never
 * escapes as an exception to the UI.
 */
async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let payload: unknown;
  let jsonParsed = true;
  try {
    payload = await response.json();
  } catch {
    jsonParsed = false;
  }
  if (!response.ok) {
    const detail = (payload as { error?: unknown } | null | undefined)?.error;
    const code = (payload as { error_code?: unknown } | null | undefined)?.error_code;
    if (code === 'yolo_confirmation_required') throw new Error(tr('发送前需要确认完全访问，请重新发送并完成确认。'));
    if (code === 'message_action_conflict') {
      const message = String(detail);
      if (message.includes('conversation changed')) throw new Error(tr('会话已发生变化。请刷新后重新编辑；当前输入已保留。'));
      if (message.includes('queued messages')) throw new Error(tr('请先处理或取消排队消息，再编辑历史。'));
      if (message.includes('run already in progress')) throw new Error(tr('会话正在运行，结束后可修改历史。'));
    }
    throw new Error(typeof detail === "string" && detail ? detail : `HTTP ${response.status}`);
  }
  if (!jsonParsed) throw new Error("invalid JSON response");
  return payload as T;
}

function requestGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
}

/** Every mutation fetches a fresh CSRF token first and sends it as a header. */
export async function requestMutation<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = await requestGet<{ csrfToken?: string }>("/api/csrf", signal);
  const csrfToken = typeof token?.csrfToken === "string" ? token.csrfToken : "";
  if (!csrfToken) throw new Error("missing csrf token");
  return requestJson<T>(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function requestPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestMutation<T>("POST", path, body, signal);
}

function sessionPath(id: string, suffix = ""): string {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}

// -- reads -------------------------------------------------------------------

export async function listSessions(signal?: AbortSignal): Promise<Result<SessionSummary[]>> {
  try {
    const payload = await requestGet<{ sessions?: SessionSummary[] }>("/api/sessions", signal);
    return { ok: true, value: payload.sessions ?? [] };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadSession(id: string, signal?: AbortSignal): Promise<Result<WorkbenchSession>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(id), signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid session response");
    const value = payload as WorkbenchSession;
    const queuedMessages = parseQueuedMessages((payload as Record<string, unknown>).queued_messages);
    return { ok: true, value: { ...value, ...(queuedMessages ? { queued_messages: queuedMessages } : {}) } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export type ConversationSnapshot = {session: WorkbenchSession; journal: Record<string, unknown>; timeline: TimelinePage};

/** Reject mixed sessions and incomplete snapshots before updating the view. */
export async function loadConversationSnapshot(id: string, signal?: AbortSignal): Promise<Result<ConversationSnapshot>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(id, '/conversation'), signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation snapshot');
    const record = payload as Record<string, unknown>;
    const session = record.session as WorkbenchSession | null;
    const journal = record.journal as Record<string, unknown> | null;
    const timeline = parseEventsEnvelope(record.timeline);
    if (!session || typeof session !== 'object' || Array.isArray(session) || session.id !== id || typeof session.status !== 'string'
      || !journal || typeof journal !== 'object' || Array.isArray(journal) || journal.id !== id || !Array.isArray(journal.messages)
      || typeof journal.message_revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(journal.message_revision)
      || !timeline || timeline.sessionId !== id || timeline.status !== session.status || journal.status !== session.status
      || timeline.hasMore || timeline.cursor !== 0 || timeline.events.length !== timeline.head || timeline.nextCursor !== timeline.head
      || timeline.events.some((event, index) => event.sessionId !== id || event.seq !== index + 1)) throw new Error('invalid conversation snapshot');
    const queued_messages = parseQueuedMessages(session.queued_messages);
    return {ok: true, value: {session: {...session, ...(queued_messages ? {queued_messages} : {})}, journal,
      timeline: {events: timeline.events, cursor: 0, nextCursor: timeline.nextCursor, head: timeline.head, hasMore: false}}};
  } catch (error) { return {ok: false, error: toErrorMessage(error)}; }
}

/** Read opaque, revision-bound safe fork selectors from the server. */
export async function loadForkBoundaries(sourceId: string, signal?: AbortSignal): Promise<Result<ForkBoundaryList>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(sourceId, "/fork-boundaries"), signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid fork boundaries response");
    const record = payload as Record<string, unknown>;
    if (record.sourceId !== sourceId || typeof record.revision !== "string" || !record.revision
      || typeof record.historyTruncated !== "boolean" || !Array.isArray(record.boundaries)
      || (record.truncationReason !== null && typeof record.truncationReason !== "string")
      || typeof record.hasUnclosedTurn !== "boolean") {
      throw new Error("invalid fork boundaries response");
    }
    const boundaries = record.boundaries.map((item): ForkBoundary => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid fork boundaries response");
      const boundary = item as Record<string, unknown>;
      if (typeof boundary.token !== "string" || !boundary.token || !Number.isInteger(boundary.turn) || (boundary.turn as number) < 1
        || !Number.isInteger(boundary.endIndex) || (boundary.endIndex as number) < 0 || typeof boundary.preview !== "string") {
        throw new Error("invalid fork boundaries response");
      }
      return { token: boundary.token, turn: boundary.turn as number, endIndex: boundary.endIndex as number, preview: boundary.preview };
    });
    return { ok: true, value: {
      sourceId: record.sourceId,
      revision: record.revision,
      boundaries,
      historyTruncated: record.historyTruncated,
      truncationReason: record.truncationReason as string | null,
      hasUnclosedTurn: record.hasUnclosedTurn,
    } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Create a child session from one server-issued complete-turn boundary. */
export async function forkSession(
  sourceId: string,
  boundary: string,
  revision: string,
  title?: string,
): Promise<Result<ForkSessionResponse>> {
  try {
    const cleanTitle = title?.trim();
    const payload = await requestPost<unknown>(sessionPath(sourceId, "/fork"), {
      boundary,
      revision,
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid fork response");
    const record = payload as Record<string, unknown>;
    const session = record.session;
    const selectedBoundary = record.boundary;
    const sessionRecord = session && typeof session === "object" && !Array.isArray(session) ? session as Record<string, unknown> : null;
    const forkParent = sessionRecord?.forkParent;
    const parentIsValid = forkParent === undefined || forkParent === null || (
      typeof forkParent === "object" && !Array.isArray(forkParent)
      && typeof (forkParent as Record<string, unknown>).sourceId === "string"
      && typeof (forkParent as Record<string, unknown>).sourceRevision === "string"
      && Number.isInteger((forkParent as Record<string, unknown>).turn)
      && Number.isInteger((forkParent as Record<string, unknown>).endIndex)
      && typeof (forkParent as Record<string, unknown>).historyTruncated === "boolean"
      && ((forkParent as Record<string, unknown>).truncationReason === null || typeof (forkParent as Record<string, unknown>).truncationReason === "string")
    );
    if (!session || typeof session !== "object" || Array.isArray(session)
      || typeof (session as Record<string, unknown>).id !== "string"
      || !parentIsValid
      || record.sourceId !== sourceId || !selectedBoundary || typeof selectedBoundary !== "object" || Array.isArray(selectedBoundary)
      || !Number.isInteger((selectedBoundary as Record<string, unknown>).turn)
      || typeof (selectedBoundary as Record<string, unknown>).preview !== "string"
      || typeof record.historyTruncated !== "boolean"
      || (record.truncationReason !== null && typeof record.truncationReason !== "string")) {
      throw new Error("invalid fork response");
    }
    return { ok: true, value: record as unknown as ForkSessionResponse };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadTimeline(
  id: string,
  cursor = 0,
  limit = 200,
  signal?: AbortSignal,
): Promise<Result<TimelinePage>> {
  try {
    const query = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    const payload = await requestGet<unknown>(`${sessionPath(id, "/events.v1")}?${query.toString()}`, signal);
    // Bad data counts as failure: the UI must never render an unvalidated envelope.
    const envelope = parseEventsEnvelope(payload);
    if (!envelope) throw new Error("invalid events.v1 envelope");
    return {
      ok: true,
      value: {
        events: envelope.events,
        cursor: envelope.cursor,
        nextCursor: envelope.nextCursor,
        head: envelope.head,
        hasMore: envelope.hasMore,
      },
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Read every validated event through the head reported by the first page. */
export async function loadCompleteTimeline(id: string, signal?: AbortSignal): Promise<Result<TimelinePage>> {
  try {
    const first = await loadTimeline(id, 0, 200, signal);
    if (!first.ok) return first;

    const snapshotHead = first.value.head;
    const eventsBySeq = new Map<number, XuenessEventV1>();
    let cursor = 0;
    let page = first.value;

    while (true) {
      if (page.cursor !== cursor) throw new Error("timeline page cursor mismatch");
      if (page.head < snapshotHead) throw new Error("timeline head changed before the snapshot was complete");
      if (page.nextCursor < cursor || page.nextCursor > page.head) throw new Error("invalid timeline page cursor");

      const maxEventSeq = page.events.reduce((max, event) => Math.max(max, event.seq), 0);
      if (page.events.length === 0) {
        if (page.nextCursor !== cursor) throw new Error("timeline cursor advanced without events");
      } else if (page.nextCursor !== maxEventSeq) {
        throw new Error("timeline next cursor did not match its events");
      }

      for (const event of page.events) {
        if (event.seq > snapshotHead) continue;
        const previous = eventsBySeq.get(event.seq);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
          throw new Error(`conflicting timeline event at sequence ${event.seq}`);
        }
        eventsBySeq.set(event.seq, event);
      }

      if (page.nextCursor >= snapshotHead) break;
      if (page.nextCursor <= cursor) throw new Error("timeline cursor did not advance");
      if (!page.hasMore) throw new Error("timeline ended before the snapshot head");

      cursor = page.nextCursor;
      const next = await loadTimeline(id, cursor, 200, signal);
      if (!next.ok) return next;
      page = next.value;
    }

    const events = [...eventsBySeq.values()].sort((left, right) => left.seq - right.seq);
    if (events.length !== snapshotHead || events.some((event, index) => event.seq !== index + 1)) {
      throw new Error("timeline pages did not cover the snapshot head");
    }
    return {
      ok: true,
      value: { events, cursor: 0, nextCursor: snapshotHead, head: snapshotHead, hasMore: false },
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadFiles(id: string, signal?: AbortSignal): Promise<Result<WorkspaceListing>> {
  try {
    const value = await requestGet<WorkspaceListing>(sessionPath(id, "/files"), signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadFilePreview(id: string, path: string, signal?: AbortSignal): Promise<Result<FilePreview>> {
  try {
    const query = new URLSearchParams({ path });
    const value = await requestGet<FilePreview>(`${sessionPath(id, "/file")}?${query.toString()}`, signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

// -- writes ------------------------------------------------------------------

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

/** Lists soft-deleted sessions from the archive, newest archive first. */
export async function listArchivedSessions(signal?: AbortSignal): Promise<Result<ArchivedSummary[]>> {
  try {
    const payload = await requestGet<{ sessions?: ArchivedSummary[] }>("/api/sessions/archived", signal);
    return { ok: true, value: payload.sessions ?? [] };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Moves an archived session back into the active list. */
export async function restoreSession(id: string): Promise<Result<void>> {
  try {
    await requestPost(sessionPath(id, "/restore"), {});
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function approvePending(
  id: string,
  pending: PendingApproval,
): Promise<Result<string>> {
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
    await requestPost(sessionPath(id, "/approvals"), body);
    return { ok: true, value: toolCallId };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Shared run body: user choices + opt-ins. Ordinary turns leave the step budget
 * to the selected server runtime profile; goal runs keep their explicit budget.
 * readRunOptIns fails closed to {} and must never enable a capability.
 */
async function runSessionWith(id: string, choices?: RunChoices, options?: { continueQueue?: boolean }): Promise<void> {
  const effectiveChoices = choices ?? getRunChoices();
  const optIns = await readRunOptIns();
  await requestPost(sessionPath(id, "/run"), {
    ...effectiveChoices,
    ...(effectiveChoices.goal ? { steps: 20 } : {}),
    ...optIns,
    ...(options?.continueQueue ? { continue_queue: true } : {}),
  });
}

export async function createSession(
  task: string,
  choices?: RunChoices,
  context?: { root?: string; prepared_token?: string },
  onCreated?: (id: string) => void,
): Promise<SubmissionResult<string>> {
  let createdId = "";
  try {
    // No root: sessions default to the host workspace root.
    const created = await requestPost<{ id?: string }>("/api/sessions", { task, ...context });
    const id = typeof created?.id === "string" ? created.id : "";
    if (!id) throw new Error("create session returned no id");
    createdId = id;
    onCreated?.(id);
    await runSessionWith(id, choices);
    return { ok: true, value: id };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), ...(createdId ? { accepted: true, id: createdId } : {}) };
  }
}

export async function sendTurn(
  id: string,
  text: string,
  choices?: RunChoices,
  preparedToken?: string,
  onAccepted?: () => void,
): Promise<SubmissionResult<void>> {
  let accepted = false;
  try {
    await requestPost(sessionPath(id, "/messages"), { text, ...(preparedToken ? { prepared_token: preparedToken } : {}) });
    accepted = true;
    onAccepted?.();
    await runSessionWith(id, choices);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), ...(accepted ? { accepted: true } : {}) };
  }
}

/** Add a user turn to the active run's FIFO queue. The prepared token is one-use. */
export async function queueTurn(id: string, text: string, preparedToken?: string): Promise<Result<QueuedMessage>> {
  try {
    const payload = await requestPost<unknown>(sessionPath(id, "/queue"), {
      text,
      ...(preparedToken ? { prepared_token: preparedToken } : {}),
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid queue response");
    const record = payload as Record<string, unknown>;
    const item = record.item && typeof record.item === "object" && !Array.isArray(record.item)
      ? record.item as Record<string, unknown>
      : null;
    if (typeof record.id !== "string" || !record.id || !item || typeof item.id !== "string" || item.id !== record.id || typeof item.text !== "string"
      || typeof item.status !== "string" || (item.status !== "queued" && item.status !== "paused") || !Number.isInteger(item.position) || (item.position as number) < 0
      || (item.created_at !== undefined && typeof item.created_at !== "string")
      || (item.updated_at !== undefined && typeof item.updated_at !== "string")) throw new Error("invalid queue response");
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
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Cancel a queued turn; the server rejects removal after the worker claims it. */
export async function cancelQueuedTurn(id: string, queueId: string): Promise<Result<void>> {
  try {
    const payload = await requestMutation<{ removed?: unknown }>("DELETE", `${sessionPath(id, "/queue")}/${encodeURIComponent(queueId)}`, undefined);
    if (payload?.removed !== true) throw new Error("invalid queue cancellation response");
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
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

export async function runSession(id: string, choices?: RunChoices, options?: { continueQueue?: boolean }): Promise<Result<void>> {
  try {
    await runSessionWith(id, choices, options);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** The journal-issued revision and message index identify one persisted row. */
export async function updateConversationMessage(id: string,
  row: Extract<TimelineRow, {kind: 'user' | 'assistant'}>,
  action: {action: 'edit'; text: string} | {action: 'feedback'; feedback: 'like' | 'dislike' | null},
): Promise<Result<void>> {
  if (row.messageIndex === undefined || !row.messageRevision) return {ok: false, error: 'Refresh this conversation before editing its history'};
  try {
    await requestMutation('PATCH', sessionPath(id, '/message-actions'), {
      revision: row.messageRevision, messageIndex: row.messageIndex, ...action,
    });
    return {ok: true, value: undefined};
  } catch (error) { return {ok: false, error: toErrorMessage(error)}; }
}

// -- pure view model ---------------------------------------------------------

/** Attach recorded tool content without changing the stable event sequence.
 * Events intentionally carry small summaries; the existing journal endpoint
 * owns full observations. Each call is matched by ID, never by row position.
 */
export function hydrateTimelineTools(rows: TimelineRow[], journal: unknown): TimelineRow[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const inputs = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, unknown>();
  const texts: string[] = [];
  let remaining = 80_000;
  const bounded = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > 8) return "…";
    if (typeof value === "string") {
      const result = value.slice(0, Math.min(16_000, remaining));
      remaining -= result.length;
      return result.length < value.length ? `${result}\n…` : result;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map(item => bounded(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, bounded(item, depth + 1)]));
    return value;
  };
  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content) texts.push(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (typeof call?.id !== "string" || typeof call?.function?.arguments !== "string") continue;
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputs.set(call.id, bounded(parsed) as Record<string, unknown>);
        } catch { /* Invalid recorded arguments stay represented by the event summary. */ }
      }
    } else if (message.role === "tool" && typeof message.tool_call_id === "string") {
      try { outputs.set(message.tool_call_id, bounded(JSON.parse(message.content))); }
      catch { if (typeof message.content === "string") outputs.set(message.tool_call_id, bounded(message.content)); }
    }
  }
  let textIndex = 0;
  return rows.map(row => {
    if (row.kind === "assistant") return { ...row, text: texts[textIndex++]?.slice(0, 40_000) ?? row.text };
    if (row.kind !== "tool") return row;
    return { ...row, ...(inputs.has(row.toolCallId) ? { input: inputs.get(row.toolCallId) } : {}),
      ...(outputs.has(row.toolCallId) ? { output: outputs.get(row.toolCallId) } : {}) };
  });
}

/** Full text and display-only reasoning are joined by the existing v1 event
 * position. The event protocol stays bounded and unchanged; row ordering and
 * message identity come from the same journal used by the server projection.
 */
export function hydrateTimelineJournalRows(rows: TimelineRow[], journal: unknown, history: ReasoningHistoryEntry[] = []): TimelineRow[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const messages = source.messages;
  if (!Array.isArray(messages)) return rows;
  const reasoning = new Map(history.filter(item => Number.isInteger(item?.message_index) && typeof item?.text === "string")
    .map(item => [item.message_index, item.text.slice(0, 32_000)]));
  const texts = new Map<number, { kind: "user" | "assistant"; text: string; messageIndex: number }>();
  // events.v1 inserts historical completion records before the next user
  // message. Ignoring them shifts every later message and its reasoning.
  const completionCounts = new Map<string, number>();
  for (const record of Array.isArray(source.completion_history) ? source.completion_history.slice(-200) : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.turn_id !== 'string' || !/^turn-[1-9][0-9]*$/u.test(record.turn_id)) continue;
    completionCounts.set(record.turn_id, (completionCounts.get(record.turn_id) ?? 0) + 1);
  }
  let seq = 1, firstUser = true, turn = 1;
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) if (call && typeof call === "object") seq++;
      if (message.content) texts.set(++seq, { kind:"assistant", text:String(message.content), messageIndex });
    } else if (message.role === "tool") seq++;
    else if (message.role === "user") {
      if (firstUser) firstUser = false;
      else {
        seq += completionCounts.get(`turn-${turn}`) ?? 0;
        turn += 1;
        const content = Array.isArray(message.content) ? message.content.filter((part: unknown) =>
          part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string')
          .map((part: { text: string }) => part.text).join('\n') : String(message.content ?? '');
        texts.set(++seq, { kind:"user", text:content, messageIndex });
      }
    }
  });
  const hydrated = rows.map((row): TimelineRow => {
    if (row.kind !== "user" && row.kind !== "assistant") return row;
    const full = texts.get(row.seq);
    if (!full || full.kind !== row.kind) return row;
    const revision = typeof source.message_revision === 'string' ? source.message_revision : undefined;
    if (row.kind === "user") return {...row, text:full.text, ...(revision ? {messageIndex:full.messageIndex, messageRevision:revision} : {})};
    const annotations = source.message_annotations && typeof source.message_annotations === 'object'
      ? (source.message_annotations as Record<string, unknown>)[String(full.messageIndex)] : undefined;
    const feedback = annotations && typeof annotations === 'object' ? (annotations as Record<string, unknown>).feedback : undefined;
    return {...row, text:full.text, messageIndex:full.messageIndex,
      ...(revision ? {messageRevision:revision, feedback:feedback === 'like' || feedback === 'dislike' ? feedback : undefined} : {}),
      ...(reasoning.has(full.messageIndex) ? { reasoning:reasoning.get(full.messageIndex) } : {})};
  });
  return projectJournalAssistantWork(hydrated, messages, history);
}

/** Add the journal's original task message, which events.v1 deliberately omits. */
export function withInitialUserMessage(rows: TimelineRow[], journal: unknown, fallbackTask?: string): TimelineRow[] {
  let initialText: string | undefined;
  let initialIndex: number | undefined;
  const source = journal && typeof journal === 'object' && !Array.isArray(journal) ? journal as Record<string, unknown> : undefined;
  if (journal && typeof journal === "object" && !Array.isArray(journal)) {
    const messages = (journal as Record<string, unknown>).messages;
    if (Array.isArray(messages)) {
      for (const [index, message] of messages.entries()) {
        if (!message || typeof message !== "object") continue;
        const candidate = message as Record<string, unknown>;
        if (candidate.role !== "user") continue;
        initialIndex = index;
        if (typeof candidate.content === "string" && candidate.content.trim()) initialText = candidate.content;
        else if (Array.isArray(candidate.content)) {
          const text = candidate.content
            .filter((part: unknown): part is { type: "text"; text: string } => {
              if (!part || typeof part !== "object" || Array.isArray(part)) return false;
              const block = part as Record<string, unknown>;
              return block.type === "text" && typeof block.text === "string";
            })
            .map(part => part.text)
            .join("\n");
          if (text.trim()) initialText = text;
        }
        break;
      }
    }
  }
  if (initialText === undefined && typeof fallbackTask === "string" && fallbackTask.trim()) {
    initialText = fallbackTask;
  }
  if (initialText === undefined) return rows;
  return [
    { kind: "user", seq: 0, turnId: "turn-1", text: initialText,
      ...(initialIndex !== undefined && typeof source?.message_revision === 'string' ? {messageIndex: initialIndex, messageRevision: source.message_revision} : {}) },
    ...rows.filter(row => row.seq !== 0),
  ];
}

export function toTimelineRows(events: XuenessEventV1[]): TimelineRow[] {
  // Contract §5: rows follow ascending seq; tool.result upgrades the matching
  // tool row in place instead of appending. Sort a copy so the input is never
  // mutated and out-of-order pages still project deterministically.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const rows: TimelineRow[] = [];
  const rowIndexByToolCallId = new Map<string, number>();

  for (const event of ordered) {
    switch (event.type) {
      case "turn.user":
        rows.push({ kind: "user", seq: event.seq, turnId: event.turnId, text: event.preview });
        break;
      case "assistant.text":
        rows.push({ kind: "assistant", seq: event.seq, turnId: event.turnId, text: event.preview });
        break;
      case "tool.call": {
        rowIndexByToolCallId.set(event.toolCallId, rows.length);
        rows.push({
          kind: "tool",
          seq: event.seq,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          name: event.name,
          subject: event.subject,
          status: "running",
          error: "",
          errorCode: "",
        });
        break;
      }
      case "tool.result": {
        const index = rowIndexByToolCallId.get(event.toolCallId);
        const existing = index !== undefined ? rows[index] : undefined;
        if (index !== undefined && existing && existing.kind === "tool") {
          // In-place upgrade: same position, same call seq, only the outcome changes.
          rows[index] = {
            ...existing,
            // 取消态在行构造时显式确定，展示层只做 status → ToolDisplayStatus 的显式映射。
            status: event.ok ? "ok" : event.errorCode === "xueness.error.cancelled" ? "cancelled" : "error",
            error: event.error,
            errorCode: event.errorCode,
          };
        } else {
          // Orphan result: no matching call row, emit a terminal row directly.
          rowIndexByToolCallId.set(event.toolCallId, rows.length);
          rows.push({
            kind: "tool",
            seq: event.seq,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            name: event.name,
            subject: event.subject,
            status: event.ok ? "ok" : event.errorCode === "xueness.error.cancelled" ? "cancelled" : "error",
            error: event.error,
            errorCode: event.errorCode,
          });
        }
        break;
      }
      case "session.completion":
        rows.push({
          kind: "completion",
          seq: event.seq,
          verified: event.verified,
          summary: event.summary,
          ...(event.status ? { status: event.status } : {}),
          ...(event.toolExecutionStatus ? { toolExecutionStatus: event.toolExecutionStatus } : {}),
          ...(event.deliveryStatus ? { deliveryStatus: event.deliveryStatus } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
        });
        break;
      case "session.pending_question":
        rows.push({ kind: "pending_question", seq: event.seq, question: event.question });
        break;
      case "session.status":
        // Describes the session, not timeline content: no row.
        break;
    }
  }

  return rows;
}

// -- slice 2: journal-derived file changes -----------------------------------
// The backend has no diff endpoint. These helpers project the *recorded* tool
// calls out of a session journal, so the UI can show what the agent tried to
// change. This is deliberately labelled as session-recorded intent, never as a
// live working-tree diff.

export type FileChange = {
  path: string;
  kind: "write" | "edit";
  ok: boolean;
  old?: string;
  new?: string;
  content?: string;
};

export type FileChangeSet = {
  changes: FileChange[];
  source: "session-journal";
};

export async function loadJournal(id: string, signal?: AbortSignal): Promise<Result<unknown>> {
  try {
    return { ok: true, value: await requestGet<unknown>(sessionPath(id, "/journal"), signal) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Per-field cap on any recorded text we surface. Keeps a huge write from
 * blowing up the DOM; the UI labels it as trimmed when it is. */
const CHANGE_TEXT_LIMIT = 4000;

function clip(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > CHANGE_TEXT_LIMIT ? value.slice(0, CHANGE_TEXT_LIMIT) : value;
}

/**
 * Project the recorded write/edit tool calls out of a session journal.
 *
 * This reads *intent from the journal*, not the working tree: nothing here
 * touches disk, so it cannot and must not be presented as a live diff. The
 * returned `source` says so explicitly. Malformed entries are skipped rather
 * than throwing — one bad call must not blank the whole view.
 */
export function deriveFileChanges(journal: unknown): FileChangeSet {
  const changes: FileChange[] = [];
  const root = journal && typeof journal === "object" ? (journal as Record<string, unknown>) : null;
  const messages = Array.isArray(root?.messages) ? (root!.messages as unknown[]) : [];
  const results =
    root?.results && typeof root.results === "object"
      ? (root.results as Record<string, unknown>)
      : {};

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const calls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const record = call as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") continue;
      const name = (fn as Record<string, unknown>).name;
      if (name !== "write" && name !== "edit") continue;

      let args: unknown;
      try {
        args = JSON.parse(String((fn as Record<string, unknown>).arguments ?? "{}"));
      } catch {
        continue;
      }
      if (!args || typeof args !== "object") continue;
      const argMap = args as Record<string, unknown>;
      const path = argMap.path;
      if (typeof path !== "string" || !path) continue;

      const callId = typeof record.id === "string" ? record.id : "";
      const result = callId ? results[callId] : undefined;
      const ok = !!result && typeof result === "object" && (result as Record<string, unknown>).ok === true;

      if (name === "write") {
        changes.push({ path, kind: "write", ok, content: clip(argMap.content) });
      } else {
        if (typeof argMap.old !== "string" || typeof argMap.new !== "string") continue;
        changes.push({ path, kind: "edit", ok, old: clip(argMap.old), new: clip(argMap.new) });
      }
    }
  }

  return { changes, source: "session-journal" };
}


/**
 * 把 argv 数组格式化成可读的命令行，用于审批卡片和时间线展示。
 * 含空白、引号或为空的参数加双引号，避免 ["git","commit","-m","fix bug"] 与
 * ["git","commit","-m","fix","bug"] 显示成同一串——Windows 上 "C:\Program Files\…"
 * 这类带空格路径尤其常见。只用于展示，不用于实际执行。
 */
export function formatCommandArgv(argv: readonly unknown[]): string {
  return argv.map((item) => {
    const text = typeof item === "string" ? item : JSON.stringify(item) ?? String(item);
    if (text !== "" && !/[\s"']/.test(text)) return text;
    // 只转义双引号：保留 Windows 路径里的反斜杠原样可读。
    return `"${text.replace(/"/g, '\\"')}"`;
  }).join(" ");
}
