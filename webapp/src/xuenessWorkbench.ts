import type { PendingApproval } from './plugins/sessions/approvalTypes';
export type { PendingApproval } from './plugins/sessions/approvalTypes';
import { projectJournalAssistantWork } from './plugins/sessions/conversationJournalProjection';
import { internalToolName } from "./xuenessToolNames";
import { parseSessionsIndex } from './plugins/sessions/sessionsIndex';
import { submitQueuedTurn, couldHaveBeenAccepted, DeliveryUnconfirmedError } from './plugins/sessions/submissionTransport';
import { createSessionHttpError, createSessionNetworkError, createUnreadableSessionResponseError } from './plugins/sessions/sessionRequestErrors';
import { CommandDeliveryUnconfirmedError, createSessionCommandId, validateCreateCommandResult, validateEditCommandResult, validateSendCommandResult } from './plugins/sessions/commandReceipt';
import type { SessionCommandClient } from './plugins/sessions/commandClient';
import type { FollowupAdmission } from './plugins/sessions/commandLedger';
import { t as tr, tf as trf } from './i18n';
import { CommandReceiptLedger, type PendingCommandReference } from './plugins/sessions/commandLedger';

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
import type { PendingGuidance } from './plugins/sessions/CurrentTurnInput';


export type QueuedMessage = {
  id: string;
  text: string;
  status: "queued" | "running" | "paused" | "completed" | "needs_review" | "failed" | "cancelled";
  position?: number;
  created_at?: string;
  updated_at?: string;
  pause_reason?: string;
  editable?: boolean;
  has_attachments?: boolean;
  has_context?: boolean;
  promotion?: { id?: string; state?: 'reserved' | 'claimed' | 'released' | 'settled' };
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
      || (record.editable !== undefined && typeof record.editable !== "boolean")
      || (record.has_attachments !== undefined && typeof record.has_attachments !== 'boolean')
      || (record.has_context !== undefined && typeof record.has_context !== 'boolean')
      || (record.promotion !== undefined && (!record.promotion || typeof record.promotion !== 'object'
        || Array.isArray(record.promotion)
        || (record.promotion as Record<string, unknown>).id !== undefined && typeof (record.promotion as Record<string, unknown>).id !== 'string'
        || !['reserved', 'claimed', 'released', 'settled'].includes(String((record.promotion as Record<string, unknown>).state))))) {
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
      ...(typeof record.has_attachments === 'boolean' ? { has_attachments: record.has_attachments } : {}),
      ...(typeof record.has_context === 'boolean' ? { has_context: record.has_context } : {}),
      ...(record.promotion && typeof record.promotion === 'object' && !Array.isArray(record.promotion)
        ? { promotion: { ...((record.promotion as Record<string, unknown>).id ? { id: (record.promotion as Record<string, unknown>).id as string } : {}),
          state: (record.promotion as Record<string, unknown>).state as NonNullable<QueuedMessage['promotion']>['state'] } } : {}),
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
  active_turn_id?: string | null;
  /** Transient server identity of the command owning this active worker. */
  active_run_command_id?: string | null;
  history_revision?: number;
  /** Full journal message digest used to reject shares created from stale history. */
  message_revision?: string;
  pinned?: boolean;
  steps: number;
  mode: string;
  completion?: import('./plugins/planning/CompletionChecks').CompletionAssessment & { summary?: string; evidence?: unknown[] } | null;
  delivery_requirements?: import('./plugins/planning/CompletionChecks').DeliveryRequirement[];
  goal?: import('./plugins/planning/SessionGoal').SessionGoalRecord | null;
  queued_messages?: QueuedMessage[];
  queue_revision?: number;
  pending_guidance?: PendingGuidance[];
  guidance_history?: PendingGuidance[];
  current_queue_item_id?: string | null;
  todos?: unknown[];
  pending_question?: string | null;
  /** Bounded provider reasoning, keyed by the assistant message's journal index. */
  reasoning_history?: ReasoningHistoryEntry[];
  /** Optional sessions-owned wall-clock intervals for displayed reasoning rows. */
  reasoning_timing?: ReasoningTimingEntry[];
  tool_activity?: unknown;
  work_segments?: import('./plugins/sessions/conversationWorkSegments').ConversationWorkSegment[];
  timeline_markers?: import('./plugins/sessions/conversationMarkers').ConversationFactMarker[];
  pending: PendingApproval[];
  approved: { write: string[]; edit: string[]; exec: string[]; mcp: string[] };
  changed_files: string[];
  streaming?: { id: string; text: string; reasoning?: string; status: "streaming" | "interrupted"; text_format?: "markdown"; reasoning_started_at?: string; reasoning_ended_at?: string; interrupted_at?: string } | null;
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
  /** 上下文压缩记录（progressive compaction）；形状由 sessions 插件解析。 */
  compactions?: import('./plugins/sessions/conversationCompaction').SessionCompactionRecord[];
  compacting?: boolean;
};

export type SessionSummary = {
  id: string;
  task: string;
  title?: string;
  status: string;
  pinned?: boolean;
  root?: string;
  updatedAt?: string;
  sidecar?: import('./plugins/sessions/sessionsIndex').SessionSidebarSidecar;
} & import('./plugins/sessions/sessionsIndex').SessionSidebarSidecar;

export type ArchivedSummary = { id: string; task: string; title?: string; archivedAt?: string; revision?: string };

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
export type ReasoningTimingEntry = { message_index: number; started_at: string; ended_at: string };
/** A saved turn survives a later run failure and must not be submitted twice. */
export type SubmissionResult<T> = Result<T> & { accepted?: boolean; id?: string; outcomeUnknown?: boolean; commandId?: string;
  /** An approval answered a call waiting in the running turn; no rerun is needed. */
  resumed?: boolean };

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

/** Display text after citation directives are replaced. Edit and events keep `text`. */
export type ReferenceAnchorRole = "user" | "assistant";

export type TimelineRow =
  | { kind: "subagent"; seq: number; turnId: string; toolCallId: string; taskId: string; agent: string; label: string; status: "running" | "completed" | "failed" | "cancelled" | "unknown"; summary: string; childSessionId?: string; steps?: number }
  | { kind: "user"; seq: number; turnId: string; text: string; displayText?: string; messageId?: string; messageIndex?: number; messageRevision?: string }
  | { kind: "assistant"; seq: number; turnId: string; text: string; displayText?: string; reasoning?: string; messageId?: string; streamId?: string; messageIndex?: number; messageRevision?: string; feedback?: 'like' | 'dislike'; streaming?: boolean; startedAt?: number; endedAt?: number; interrupted?: boolean }
  | {
      kind: "tool";
      seq: number;
      turnId: string;
      toolCallId: string;
      toolActivityId?: string;
      inputActivity?: { phase: "input_streaming"; inputChars: number; partialInput: string; truncated: boolean };
      name: string;
      subject: string;
      status: ToolDisplayStatus;
      error: string;
      errorCode: string;
      /** Display provenance used by the sessions compaction boundary. */
      archivedForCompaction?: boolean;
      input?: Record<string, unknown>;
      output?: unknown;
    }
  | { kind: "completion"; seq: number; verified: boolean; summary: string; status?: "verified" | "unverified" | "not_applicable" | "incomplete"; toolExecutionStatus?: "succeeded" | "failed" | "incomplete" | "not_applicable"; deliveryStatus?: "passed" | "failed" | "not_assessed"; turnId?: string }
  | { kind: "pending_question"; seq: number; question: string }
  | {
      kind: "citation" | "preview" | "artifact";
      seq: number;
      turnId: string;
      path: string;
      label: string;
      anchorRole: ReferenceAnchorRole;
      startLine?: number;
      endLine?: number;
      sizeBytes?: number;
      messageId?: string;
    };

/** Show durable text during generation and after an interrupted request. */
function reasoningTimeMs(value: unknown): number | undefined {
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

function parsePendingGuidance(value: unknown): PendingGuidance[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('invalid current-turn guidance response');
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('invalid current-turn guidance response');
    }
    const item = candidate as Record<string, unknown>;
    const statuses = ['queued', 'running', 'paused', 'completed', 'needs_review', 'failed', 'cancelled'];
    if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string'
      || typeof item.status !== 'string' || !statuses.includes(item.status)
      || (item.targetTurnId !== undefined && typeof item.targetTurnId !== 'string')
      || (item.pause_reason !== undefined && typeof item.pause_reason !== 'string')
      || (item.has_attachments !== undefined && typeof item.has_attachments !== 'boolean')
      || (item.has_context !== undefined && typeof item.has_context !== 'boolean')
      || (item.position !== undefined && (!Number.isInteger(item.position) || (item.position as number) < 0))) {
      throw new Error('invalid current-turn guidance response');
    }
    return { id: item.id, text: item.text, status: item.status as PendingGuidance['status'],
      ...(typeof item.targetTurnId === 'string' ? { targetTurnId: item.targetTurnId } : {}),
      ...(typeof item.pause_reason === 'string' ? { pause_reason: item.pause_reason } : {}),
      ...(item.has_attachments === true ? { has_attachments: true } : {}),
      ...(item.has_context === true ? { has_context: true } : {}),
      ...(Number.isInteger(item.position) ? { position: item.position as number } : {}) };
  });
}

function parseSessionInboxFields(value: Record<string, unknown>): Partial<WorkbenchSession> {
  if (value.active_run_command_id !== undefined && value.active_run_command_id !== null
    && (typeof value.active_run_command_id !== 'string' || !value.active_run_command_id
      || value.active_run_command_id.length > 128)) throw new Error('invalid active run command identity');
  if (Object.prototype.hasOwnProperty.call(value, "queue_revision")
    && (!Number.isSafeInteger(value.queue_revision) || (value.queue_revision as number) < 0)) {
    throw new Error("invalid queue revision");
  }
  const historyRevision = value.history_revision;
  if (historyRevision !== undefined && (!Number.isInteger(historyRevision) || (historyRevision as number) < 0)) {
    throw new Error('invalid session history revision');
  }
  if (value.active_turn_id !== undefined && value.active_turn_id !== null
    && (typeof value.active_turn_id !== 'string' || !value.active_turn_id)) {
    throw new Error('invalid active turn id');
  }
  const pendingGuidance = parsePendingGuidance(value.pending_guidance);
  const guidanceHistory = parsePendingGuidance(value.guidance_history);
  return { ...(typeof value.active_turn_id === 'string' || value.active_turn_id === null
      ? { active_turn_id: value.active_turn_id } : {}),
    ...(typeof value.active_run_command_id === 'string' || value.active_run_command_id === null
      ? {active_run_command_id:value.active_run_command_id} : {}),
    ...(typeof historyRevision === 'number' ? { history_revision: historyRevision } : {}),
    ...(pendingGuidance ? { pending_guidance: pendingGuidance } : {}),
    ...(guidanceHistory ? { guidance_history: guidanceHistory } : {}) };
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
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason ?? error;
    if (error instanceof TypeError) throw createSessionNetworkError(error);
    throw error;
  }
  let payload: unknown;
  let jsonParsed = true;
  let jsonError: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason ?? error;
    jsonParsed = false;
    jsonError = error;
  }
  if (!response.ok) {
    const detail = (payload as { error?: unknown } | null | undefined)?.error;
    const code = (payload as { error_code?: unknown } | null | undefined)?.error_code;
    const errorCode = typeof code === 'string' && code.trim() ? code : undefined;
    const backendDetail = typeof detail === 'string' && detail.trim() ? detail : undefined;
    const appendDetail = (message: string) => backendDetail ? trf('{0}\n服务器说明：{1}', [message, backendDetail]) : message;
    if (code === 'yolo_confirmation_required') {
      throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('发送前需要确认完全访问，请重新发送并完成确认。')));
    }
    if (code === 'message_action_conflict') {
      const message = String(detail);
      if (message.includes('conversation changed')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('会话已发生变化。请刷新后重新编辑；当前输入已保留。')));
      if (message.includes('queued messages')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('请先处理或取消排队消息，再编辑历史。')));
      if (message.includes('run already in progress')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('会话正在运行，结束后可修改历史。')));
    }
    throw createSessionHttpError(response.status, errorCode, backendDetail);
  }
  if (!jsonParsed) throw createUnreadableSessionResponseError(response.status, jsonError);
  return payload as T;
}

async function requestGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException(tr('读取超时，请稍后重试。'), 'TimeoutError')), 20000);
  try {
    return await requestJson<T>(path, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Every mutation fetches a fresh CSRF token first and sends it as a header. */
export async function requestMutation<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, signal?: AbortSignal, beforeSend?: () => boolean): Promise<T> {
  let token: { csrfToken?: string };
  try { token = await requestGet<{ csrfToken?: string }>("/api/csrf", signal); }
  catch (error) { if (error instanceof Error) Object.assign(error, { requestNotSent: true }); throw error; }
  const csrfToken = typeof token?.csrfToken === "string" ? token.csrfToken : "";
  if (!csrfToken) throw new Error("missing csrf token");
  if (signal?.aborted) throw Object.assign(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'), { requestNotSent: true });
  if (beforeSend && !beforeSend()) throw Object.assign(new Error('Request is no longer enabled'), { requestNotSent: true });
  return requestJson<T>(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function requestPost<T>(path: string, body: unknown, signal?: AbortSignal, beforeSend?: () => boolean): Promise<T> {
  return requestMutation<T>("POST", path, body, signal, beforeSend);
}

function sessionPath(id: string, suffix = ""): string {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}

type CommandModule = typeof import('./plugins/sessions/commandClient');
let commandModuleLoading: Promise<CommandModule> | undefined;

/** Command admission loads on use. The receipt helpers stay in the startup graph. */
function loadCommandModule(): Promise<CommandModule> {
  return commandModuleLoading ??= import('./plugins/sessions/commandClient').catch(error => {
    commandModuleLoading = undefined;
    throw error;
  });
}

/**
 * Startup stand-in for SessionCommandClient. The real client is fetched when the
 * workbench creates this handle, so the command module stays out of the static
 * startup graph. Calls made before it arrives keep the effectiveness captured
 * at the call, and cancel or dispose during that gap never falls through to REST.
 */
class StartupCommandHandle {
  private instance: SessionCommandClient | undefined;
  private opening: Promise<SessionCommandClient> | undefined;
  private disposed = false;
  private epoch = 0;

  constructor(private readonly effective: () => boolean, private readonly receiptScope?: string) {
    void this.open().catch(() => undefined);
  }

  private disposedError(): Error {
    return Object.assign(new Error('Command client disposed'), { requestNotSent: true });
  }

  private cancelledError(): Error {
    return Object.assign(new Error('Command cancelled before admission'), { requestNotSent: true });
  }

  private open(): Promise<SessionCommandClient> {
    if (this.instance) return Promise.resolve(this.instance);
    return this.opening ??= loadCommandModule().then(({ SessionCommandClient: CommandClient }) => {
      if (!this.instance) {
        this.instance = new CommandClient({
          isEffective: () => this.effective(), receiptScope: this.receiptScope,
          post: (path, body, signal, beforeSend) => requestPost(path, body, signal, () => this.effective() && (!beforeSend || beforeSend())),
          get: (path, signal) => requestGet(path, signal),
        });
        if (this.disposed) this.instance.dispose();
      }
      return this.instance;
    }).catch(error => {
      this.opening = undefined;
      throw error;
    });
  }

  isEffective(): boolean {
    return this.instance ? this.instance.isEffective() : !this.disposed && this.effective();
  }

  /** Nothing can be in flight before the real client exists. */
  isInFlight(sessionId: string | null, commandId: string): boolean {
    return this.instance?.isInFlight(sessionId, commandId) ?? false;
  }

  pendingCommands(): PendingCommandReference[] {
    if (this.instance) return this.instance.pendingCommands();
    try { return this.receiptScope ? new CommandReceiptLedger(this.receiptScope).pending() : []; } catch { return []; }
  }
  recoveryStorageWarning(): string | null { return this.instance?.recoveryStorageWarning() ?? null; }

  recoveryStorageError(): string | null {
    if (this.instance) return this.instance.recoveryStorageError();
    try { if (this.receiptScope) new CommandReceiptLedger(this.receiptScope).pending(); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  cancelPending(): void {
    this.epoch += 1;
    this.instance?.cancelPending();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.instance?.dispose();
  }

  private forward<T>(run: (client: SessionCommandClient) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(this.disposedError());
    const wasEffective = this.isEffective();
    if (this.instance) return run(this.instance);
    const epoch = this.epoch;
    return this.open().then(client => {
      if (this.disposed) return Promise.reject(this.disposedError());
      if (epoch !== this.epoch || (wasEffective && !client.isEffective())) return Promise.reject(this.cancelledError());
      return run(client);
    });
  }

  query(...args: Parameters<SessionCommandClient['query']>) {
    return this.forward(client => client.query(...args));
  }

  queryCreate(...args: Parameters<SessionCommandClient['queryCreate']>) {
    return this.forward(client => client.queryCreate(...args));
  }

  submitCreate(...args: Parameters<SessionCommandClient['submitCreate']>) {
    return this.forward(client => client.submitCreate(...args));
  }

  submit(...args: Parameters<SessionCommandClient['submit']>) {
    return this.forward(client => client.submit(...args));
  }

  submitEdit(...args: Parameters<SessionCommandClient['submitEdit']>) {
    return this.forward(client => client.submitEdit(...args));
  }

  confirmQueueWithdrawalAsync(...args: Parameters<SessionCommandClient['confirmQueueWithdrawalAsync']>): Promise<boolean> {
    return this.forward(client => client.confirmQueueWithdrawalAsync(...args));
  }

  confirmQueueWithdrawal(...args: Parameters<SessionCommandClient['confirmQueueWithdrawal']>): boolean {
    return this.instance?.confirmQueueWithdrawal(...args) ?? false;
  }

  submitQueue(...args: Parameters<SessionCommandClient['submitQueue']>) {
    return this.forward(client => client.submitQueue(...args));
  }

  submitApproval(...args: Parameters<SessionCommandClient['submitApproval']>) {
    return this.forward(client => client.submitApproval(...args));
  }
}

/** The sessions plugin owns command policy; this adapter reuses the API boundary. */
export function createSessionCommandClient(isEffective: () => boolean, receiptScope: string | undefined = typeof window === 'undefined' ? undefined : JSON.stringify(['local', window.location?.origin ?? 'same-origin'])): SessionCommandClient {
  // Private client fields stay in the lazy module. Callers use the public command API.
  return new StartupCommandHandle(isEffective, receiptScope) as unknown as SessionCommandClient;
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

/** Same-origin transport; sessions owns snapshot parsing and list fallback. */
export async function listSessionsIndex(signal?: AbortSignal): Promise<Result<SessionSummary[]>> {
  try {
    const payload = await requestGet<unknown>("/api/sessions/index", signal);
    return { ok: true, value: parseSessionsIndex(payload) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadSession(id: string, signal?: AbortSignal): Promise<Result<WorkbenchSession>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(id), signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid session response");
    const value = payload as WorkbenchSession;
    const record = payload as Record<string, unknown>;
    const queuedMessages = parseQueuedMessages(record.queued_messages);
    const inboxFields = parseSessionInboxFields(record);
    return { ok: true, value: { ...value, ...inboxFields, ...(queuedMessages ? { queued_messages: queuedMessages } : {}) } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export type ConversationSnapshotWindow = {
  start: number; end: number; total: number; hasOlder: boolean; olderCursor: number | null;
  messageRevision: string; historyRevision: number;
};
export type ConversationSnapshotRequest = {tail?: number; before?: number; limit?: number; revision?: string};
export type ConversationSnapshot = {session: WorkbenchSession; journal: Record<string, unknown>; timeline: TimelinePage; window?: ConversationSnapshotWindow};

/** Reject mixed sessions and incomplete snapshots before updating the view. */
export async function loadConversationSnapshot(id: string, signal?: AbortSignal,
  window?: ConversationSnapshotRequest): Promise<Result<ConversationSnapshot>> {
  try {
    const query = new URLSearchParams();
    if (window?.tail !== undefined) query.set('tail', String(window.tail));
    if (window?.before !== undefined) query.set('before', String(window.before));
    if (window?.limit !== undefined) query.set('limit', String(window.limit));
    if (window?.revision) query.set('revision', window.revision);
    const suffix = `/conversation${query.size ? `?${query.toString()}` : ''}`;
    const payload = await requestGet<unknown>(sessionPath(id, suffix), signal);
    return {ok: true, value: parseConversationSnapshot(id, payload)};
  } catch (error) { return {ok: false, error: toErrorMessage(error)}; }
}

export async function loadOlderConversationPage(id: string, before: number, revision: string,
  signal?: AbortSignal, limit = 80): Promise<Result<ConversationSnapshot>> {
  return loadConversationSnapshot(id, signal, {before, limit, revision});
}

export function parseConversationSnapshot(id: string, payload: unknown): ConversationSnapshot {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation snapshot');
    const record = payload as Record<string, unknown>;
    const session = record.session as WorkbenchSession | null;
    const journal = record.journal as Record<string, unknown> | null;
    const timeline = parseEventsEnvelope(record.timeline);
    let window: ConversationSnapshotWindow | undefined;
    if (record.window !== undefined) {
      if (!record.window || typeof record.window !== 'object' || Array.isArray(record.window)) throw new Error('invalid conversation window');
      const raw = record.window as Record<string, unknown>;
      const messageWindow = journal?.message_window;
      if (!messageWindow || typeof messageWindow !== 'object' || Array.isArray(messageWindow)) throw new Error('invalid conversation window');
      const page = messageWindow as Record<string, unknown>;
      if (!Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || !Number.isSafeInteger(raw.total)
        || (raw.start as number) < 0 || (raw.end as number) < (raw.start as number) || (raw.total as number) < (raw.end as number)
        || typeof raw.hasOlder !== 'boolean' || raw.hasOlder !== ((raw.start as number) > 0)
        || (raw.olderCursor !== null && raw.olderCursor !== raw.start)
        || typeof raw.messageRevision !== 'string' || raw.messageRevision !== journal?.message_revision
        || !Number.isSafeInteger(raw.historyRevision) || (raw.historyRevision as number) < 0
        || raw.historyRevision !== journal?.history_revision
        || page.start !== raw.start || page.end !== raw.end || page.total !== raw.total
        || page.hasOlder !== raw.hasOlder || page.olderCursor !== raw.olderCursor
        || page.messageRevision !== raw.messageRevision || !Array.isArray(page.messageIndices)
        || page.messageIndices.length !== (journal?.messages as unknown[] | undefined)?.length
        || (raw.end as number) - (raw.start as number) !== page.messageIndices.length
        || page.messageIndices.some(value => value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))) {
        throw new Error('invalid conversation window');
      }
      window = {start: raw.start as number, end: raw.end as number, total: raw.total as number,
        hasOlder: raw.hasOlder, olderCursor: raw.olderCursor as number | null,
        messageRevision: raw.messageRevision, historyRevision: raw.historyRevision as number};
    }
    if (!session || typeof session !== 'object' || Array.isArray(session) || session.id !== id || typeof session.status !== 'string'
      || !journal || typeof journal !== 'object' || Array.isArray(journal) || journal.id !== id || !Array.isArray(journal.messages)
      || typeof journal.message_revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(journal.message_revision)
      || !timeline || timeline.sessionId !== id || timeline.status !== session.status || journal.status !== session.status
      || timeline.hasMore || timeline.cursor !== 0 || timeline.events.length !== timeline.head || timeline.nextCursor !== timeline.head
      || timeline.events.some((event, index) => event.sessionId !== id || event.seq !== index + 1)) throw new Error('invalid conversation snapshot');
    const queued_messages = parseQueuedMessages(session.queued_messages);
    const inboxFields = parseSessionInboxFields(session as unknown as Record<string, unknown>);
    return {session: {...session, ...inboxFields, ...(queued_messages ? {queued_messages} : {}),
      message_revision: journal.message_revision}, journal,
      timeline: {events: timeline.events, cursor: 0, nextCursor: timeline.nextCursor, head: timeline.head, hasMore: false},
      ...(window ? {window} : {})};
}

/** Read opaque, revision-bound safe fork selectors from the server. */
export async function loadForkBoundaries(sourceId: string, signal?: AbortSignal, request = requestGet<unknown>): Promise<Result<ForkBoundaryList>> {
  try {
    const payload = await request(sessionPath(sourceId, "/fork-boundaries"), signal);
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
  request: (path: string, body: unknown) => Promise<unknown> = requestPost<unknown>,
): Promise<Result<ForkSessionResponse>> {
  try {
    const cleanTitle = title?.trim();
    const payload = await request(sessionPath(sourceId, "/fork"), {
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

export type ConversationShareRow = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
};

export type ConversationShare = {
  schema: 'xueness.conversation-share.v1';
  id: string;
  title: string;
  createdAt: string;
  rows: ConversationShareRow[];
};

export type CreatedConversationShare = { id: string; url: string; title: string };

export type ConversationSharePreview = {
  title: string;
  rows: ConversationShareRow[];
  message_revision: string;
};

/** Read the complete, sanitized transcript and the exact revision to publish. */
export async function loadConversationSharePreview(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Result<ConversationSharePreview>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(sessionId, '/share'), signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share preview');
    const record = payload as Record<string, unknown>;
    if (typeof record.title !== 'string' || !record.title
      || typeof record.message_revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.message_revision)
      || !Array.isArray(record.rows)) throw new Error('invalid conversation share preview');
    const rows = record.rows.map((value): ConversationShareRow => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid conversation share preview row');
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || typeof row.turnId !== 'string' || !/^turn-[1-9][0-9]*$/u.test(row.turnId)
        || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') {
        throw new Error('invalid conversation share preview row');
      }
      return { id: row.id, turnId: row.turnId, role: row.role, text: row.text };
    });
    return { ok: true, value: { title: record.title, rows, message_revision: record.message_revision } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

/** Create a same-host, read-only transcript share tied to one exact journal revision. */
export async function createConversationShare(
  sessionId: string,
  expectedRevision: string,
  turnIds?: string[],
  title?: string,
): Promise<Result<CreatedConversationShare>> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedRevision)) {
    return { ok: false, error: 'Refresh this conversation before creating a share link.' };
  }
  const cleanTitle = title?.trim();
  try {
    const payload = await requestPost<unknown>(sessionPath(sessionId, '/share'), {
      expected_revision: expectedRevision,
      ...(cleanTitle ? { title: cleanTitle } : {}),
      ...(turnIds ? { turn_ids: turnIds } : {}),
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share response');
    const record = payload as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || typeof record.title !== 'string' || typeof record.url !== 'string'
      || record.url !== `/share/${encodeURIComponent(record.id)}`) throw new Error('invalid conversation share response');
    return { ok: true, value: { id: record.id, url: record.url, title: record.title } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

/** Read the sanitized, read-only projection at the local share URL. */
export async function loadConversationShare(id: string, signal?: AbortSignal): Promise<Result<ConversationShare>> {
  try {
    const payload = await requestGet<unknown>(`/api/conversation_shares/${encodeURIComponent(id)}`, signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share');
    const record = payload as Record<string, unknown>;
    if (record.schema !== 'xueness.conversation-share.v1' || record.id !== id || typeof record.title !== 'string'
      || typeof record.createdAt !== 'string' || !Array.isArray(record.rows)) throw new Error('invalid conversation share');
    const rows = record.rows.map((value): ConversationShareRow => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid conversation share row');
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || typeof row.turnId !== 'string' || !row.turnId
        || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') throw new Error('invalid conversation share row');
      return { id: row.id, turnId: row.turnId, role: row.role, text: row.text };
    });
    return { ok: true, value: { schema: 'xueness.conversation-share.v1', id, title: record.title,
      createdAt: record.createdAt, rows } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export async function revokeConversationShare(id: string): Promise<Result<void>> {
  try {
    const payload = await requestMutation<unknown>('DELETE', `/api/conversation_shares/${encodeURIComponent(id)}`, undefined);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as Record<string, unknown>).revoked !== true) {
      throw new Error('invalid conversation share revoke response');
    }
    return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export async function importConversationShare(
  id: string,
  options: { root?: string; title?: string } = {},
): Promise<Result<string>> {
  try {
    const cleanTitle = options.title?.trim();
    const payload = await requestPost<unknown>(`/api/conversation_shares/${encodeURIComponent(id)}/import`, {
      ...(options.root ? { root: options.root } : {}),
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as Record<string, unknown>).id !== 'string') {
      throw new Error('invalid imported conversation response');
    }
    return { ok: true, value: (payload as Record<string, unknown>).id as string };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
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
  return import('./plugins/sessions/approvalCommands').then(module => module.approvePending(id, pending, commands,
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
  context?: { root?: string; prepared_token?: string },
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
    const { cancelQueuedMessage } = await import('./plugins/sessions/queueApi');
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
export function hydrateTimelineJournalRows(rows: TimelineRow[], journal: unknown, history: ReasoningHistoryEntry[] = [], timing: ReasoningTimingEntry[] = []): TimelineRow[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const messages = source.messages;
  if (!Array.isArray(messages)) return rows;
  const reasoning = new Map(history.filter(item => Number.isInteger(item?.message_index) && typeof item?.text === "string")
    .map(item => [item.message_index, item.text.slice(0, 32_000)]));
  const sourceTiming = timing.length > 0 ? timing
    : Array.isArray(source.reasoning_timing) ? source.reasoning_timing as ReasoningTimingEntry[] : [];
  const reasoningTiming = new Map(sourceTiming.filter(item => Number.isInteger(item?.message_index)
    && typeof item?.started_at === "string" && typeof item?.ended_at === "string")
    .map(item => [item.message_index, item]));
  const texts = new Map<number, {
    kind: "user" | "assistant"; text: string; messageIndex: number; messageId?: string;
    streamId?: string; interrupted?: boolean; reasoning?: string; startedAt?: number; endedAt?: number;
  }>();
  // events.v1 inserts historical completion records before the next user
  // message. Ignoring them shifts every later message and its reasoning.
  const completionCounts = new Map<string, number>();
  for (const record of Array.isArray(source.completion_history) ? source.completion_history.slice(-200) : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.turn_id !== 'string' || !/^turn-[1-9][0-9]*$/u.test(record.turn_id)) continue;
    completionCounts.set(record.turn_id, (completionCounts.get(record.turn_id) ?? 0) + 1);
  }
  const messageWindow = source.message_window && typeof source.message_window === 'object'
    ? source.message_window as Record<string, unknown> : undefined;
  const pagedStart = Number.isSafeInteger(messageWindow?.start) ? messageWindow!.start as number : 0;
  const messageIndices = Array.isArray(messageWindow?.messageIndices) ? messageWindow!.messageIndices as unknown[] : undefined;
  let seq = 1, firstUser = pagedStart === 0, turn = 1;
  if (pagedStart > 0) {
    const firstVisibleUser = messages.find((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user'));
    const firstVisible = firstVisibleUser?._turn_id;
    if (typeof firstVisible === 'string' && /^turn-[1-9][0-9]*$/u.test(firstVisible)) {
      const turnNumber = Number(firstVisible.slice(5));
      turn = firstVisibleUser?._input_kind === 'guide' ? turnNumber : Math.max(1, turnNumber - 1);
    }
  }
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    const identity = typeof message._message_id === 'string' ? {messageId: message._message_id} : {};
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) if (call && typeof call === "object") seq++;
      if (message.content) texts.set(++seq, {
        kind:"assistant", text:String(message.content), messageIndex, ...identity,
        ...(message._transcript_partial === true ? {
          streamId: typeof message._stream_id === 'string' ? message._stream_id : undefined,
          interrupted: true,
          ...(typeof message._stream_reasoning === 'string' && message._stream_reasoning
            ? {reasoning: message._stream_reasoning} : {}),
          ...(reasoningTimeMs(message._stream_reasoning_started_at) !== undefined
            ? {startedAt: reasoningTimeMs(message._stream_reasoning_started_at)} : {}),
          ...(reasoningTimeMs(message._stream_reasoning_ended_at ?? message._stream_interrupted_at) !== undefined
            ? {endedAt: reasoningTimeMs(message._stream_reasoning_ended_at ?? message._stream_interrupted_at)} : {}),
        } : {}),
      });
    } else if (message.role === "tool") seq++;
    else if (message.role === "user") {
      if (firstUser) {
        firstUser = false;
        if (typeof message._turn_id === 'string' && /^turn-[1-9][0-9]*$/u.test(message._turn_id)) turn = Number(message._turn_id.slice(5));
      }
      else {
        if (message._input_kind !== 'guide') {
          seq += completionCounts.get(`turn-${turn}`) ?? 0;
          turn = typeof message._turn_id === 'string' && /^turn-[1-9][0-9]*$/u.test(message._turn_id) ? Number(message._turn_id.slice(5)) : turn + 1;
        }
        const content = Array.isArray(message.content) ? message.content.filter((part: unknown) =>
          part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string')
          .map((part: { text: string }) => part.text).join('\n') : String(message.content ?? '');
        texts.set(++seq, { kind:"user", text:content, messageIndex, ...identity });
      }
    }
  });
  const hydrated = rows.map((row): TimelineRow => {
    if (row.kind !== "user" && row.kind !== "assistant") return row;
    const full = texts.get(row.seq);
    if (!full || full.kind !== row.kind) return row;
    const revision = typeof source.message_revision === 'string' ? source.message_revision : undefined;
    if (row.kind === "user") return {...row, text:full.text, messageId:full.messageId, ...(revision ? {messageIndex:full.messageIndex, messageRevision:revision} : {})};
    const annotations = source.message_annotations && typeof source.message_annotations === 'object'
      ? (source.message_annotations as Record<string, unknown>)[String(full.messageIndex)] : undefined;
    const feedback = annotations && typeof annotations === 'object' ? (annotations as Record<string, unknown>).feedback : undefined;
    return {...row, text:full.text, messageIndex:full.messageIndex, messageId:full.messageId,
      ...(full.streamId ? {streamId:full.streamId} : {}),
      ...(full.interrupted ? {interrupted:true, streaming:false} : {}),
      ...(full.reasoning ? {reasoning:full.reasoning} : reasoning.has(full.messageIndex) ? { reasoning:reasoning.get(full.messageIndex) } : {}),
      ...(!full.interrupted && revision ? {messageRevision:revision, feedback:feedback === 'like' || feedback === 'dislike' ? feedback : undefined} : {}),
      ...(!full.interrupted && reasoningTiming.has(full.messageIndex) ? {
        startedAt: reasoningTimeMs(reasoningTiming.get(full.messageIndex)?.started_at),
        endedAt: reasoningTimeMs(reasoningTiming.get(full.messageIndex)?.ended_at),
      } : {}),
      ...(full.startedAt !== undefined ? {startedAt:full.startedAt} : {}),
      ...(full.endedAt !== undefined ? {endedAt:full.endedAt} : {})};
  });
  let projected = projectJournalAssistantWork(hydrated, messages, history, sourceTiming);
  if (messageIndices) {
    projected = projected.map(row => {
      if ((row.kind !== 'user' && row.kind !== 'assistant') || row.messageIndex === undefined) return row;
      const currentIndex = messageIndices[row.messageIndex];
      if (Number.isSafeInteger(currentIndex) && (currentIndex as number) >= 0) {
        return {...row, messageIndex: currentIndex as number,
          ...(typeof source.message_revision === 'string' ? {messageRevision: source.message_revision} : {})};
      }
      if (row.kind === 'assistant') {
        const {messageIndex: _index, messageRevision: _revision, feedback: _feedback, ...readonlyRow} = row;
        return readonlyRow;
      }
      const {messageIndex: _index, messageRevision: _revision, ...readonlyRow} = row;
      return readonlyRow;
    });
  }
  const offset = pagedStart * 1_000_000;
  return pagedStart ? projected.map(row => ({...row, seq: row.seq + offset})) : projected;
}

/** Add the journal's original task message, which events.v1 deliberately omits. */
export function withInitialUserMessage(rows: TimelineRow[], journal: unknown, fallbackTask?: string): TimelineRow[] {
  let initialText: string | undefined;
  let initialIndex: number | undefined;
  let initialTurnId = 'turn-1';
  let initialMessageId: string | undefined;
  const source = journal && typeof journal === 'object' && !Array.isArray(journal) ? journal as Record<string, unknown> : undefined;
  const messageWindow = source?.message_window && typeof source.message_window === 'object'
    ? source.message_window as Record<string, unknown> : undefined;
  if (Number.isSafeInteger(messageWindow?.start) && (messageWindow!.start as number) > 0) return rows;
  if (journal && typeof journal === "object" && !Array.isArray(journal)) {
    const messages = (journal as Record<string, unknown>).messages;
    if (Array.isArray(messages)) {
      for (const [index, message] of messages.entries()) {
        if (!message || typeof message !== "object") continue;
        const candidate = message as Record<string, unknown>;
        if (candidate.role !== "user") continue;
        initialIndex = index;
        if (typeof candidate._turn_id === 'string') initialTurnId = candidate._turn_id;
        if (typeof candidate._message_id === 'string') initialMessageId = candidate._message_id;
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
  const indices = Array.isArray(messageWindow?.messageIndices) ? messageWindow!.messageIndices as unknown[] : undefined;
  const activeIndex = indices?.[initialIndex ?? 0];
  return [
    { kind: "user", seq: 0, turnId: initialTurnId, text: initialText,
      ...(initialMessageId ? {messageId: initialMessageId} : {}),
      ...(initialIndex !== undefined && typeof source?.message_revision === 'string'
        && (indices === undefined || Number.isSafeInteger(activeIndex) && (activeIndex as number) >= 0)
        ? {messageIndex: indices ? activeIndex as number : initialIndex, messageRevision: source.message_revision} : {}) },
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
          name: internalToolName(event.name),
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
            name: internalToolName(event.name),
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
