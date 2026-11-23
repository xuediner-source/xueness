/**
 * Shapes of the sessions data layer (`xuenessWorkbench.ts` re-exports them).
 * Part of the frozen workbench contract: docs/xueness-workbench-contract.md.
 */
import type { PendingApproval } from './approvalTypes';
import type { PermissionMode } from './permissionModes';
import type { PendingGuidance } from './CurrentTurnInput';
import type { XuenessEventV1 } from '../../xuenessEvents';

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

export type WorkbenchRuntimeActivity = import('../providers/LocalRuntimeMonitor').RuntimeActivity & {
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
  completion?: import('../planning/CompletionChecks').CompletionAssessment & { summary?: string; evidence?: unknown[] } | null;
  delivery_requirements?: import('../planning/CompletionChecks').DeliveryRequirement[];
  goal?: import('../planning/SessionGoal').SessionGoalRecord | null;
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
  work_segments?: import('./conversationWorkSegments').ConversationWorkSegment[];
  timeline_markers?: import('./conversationMarkers').ConversationFactMarker[];
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
    overflowRetry?: boolean; prefixRequestChars?: number; prefixSharedChars?: number; prefixRequests?: number; prefixBreaks?: number; prefixTotalSharedChars?: number; prefixTotalChars?: number;
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
  compactions?: import('./conversationCompaction').SessionCompactionRecord[];
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
  sidecar?: import('./sessionsIndex').SessionSidebarSidecar;
} & import('./sessionsIndex').SessionSidebarSidecar;

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
      /** The tool_judge plugin's verdict for this call, from the session journal (shown only while it is effective). */
      judge?: unknown;
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

export type ConversationSnapshotWindow = {
  start: number; end: number; total: number; hasOlder: boolean; olderCursor: number | null;
  messageRevision: string; historyRevision: number;
};
export type ConversationSnapshotRequest = {tail?: number; before?: number; limit?: number; revision?: string};
export type ConversationSnapshot = {session: WorkbenchSession; journal: Record<string, unknown>; timeline: TimelinePage; window?: ConversationSnapshotWindow};
