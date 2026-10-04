import type { XuenessEvent } from "./xuenessBridge";

export const XUENESS_EVENT_SCHEMA = "xueness.event.v1" as const;
export const XUENESS_EVENTS_SCHEMA = "xueness.events.v1" as const;
export const XUENESS_PROTOCOL_VERSION = 1 as const;

export type XuenessErrorCode =
  | ""
  | "xueness.error.denied"
  | "xueness.error.cancelled"
  | "xueness.error.not_found"
  | "xueness.error.invalid_argument"
  | "xueness.error.tool_failed";

export interface XuenessEventBase {
  schema: typeof XUENESS_EVENT_SCHEMA;
  seq: number;
  sessionId: string;
  type: string;
}

export interface XuenessSessionStatusEvent extends XuenessEventBase {
  type: "session.status";
  status: string;
  steps: number;
  mode: string;
}

export interface XuenessTurnUserEvent extends XuenessEventBase {
  type: "turn.user";
  turnId: string;
  preview: string;
}

export interface XuenessAssistantTextEvent extends XuenessEventBase {
  type: "assistant.text";
  turnId: string;
  preview: string;
}

export interface XuenessToolCallEvent extends XuenessEventBase {
  type: "tool.call";
  turnId: string;
  toolCallId: string;
  name: string;
  subject: string;
}

export interface XuenessToolResultEvent extends XuenessEventBase {
  type: "tool.result";
  turnId: string;
  toolCallId: string;
  name: string;
  subject: string;
  ok: boolean;
  errorCode: string;
  error: string;
}

export interface XuenessSessionCompletionEvent extends XuenessEventBase {
  type: "session.completion";
  verified: boolean;
  summary: string;
  evidenceCount: number;
  /** Assessment state; optional to keep older v1 event journals valid. */
  status?: "verified" | "unverified" | "not_applicable" | "incomplete";
  toolExecutionStatus?: "succeeded" | "failed" | "incomplete" | "not_applicable";
  deliveryStatus?: "passed" | "failed" | "not_assessed";
  turnId?: string;
}

export interface XuenessSessionPendingQuestionEvent extends XuenessEventBase {
  type: "session.pending_question";
  question: string;
}

export type XuenessEventV1 =
  | XuenessSessionStatusEvent
  | XuenessTurnUserEvent
  | XuenessAssistantTextEvent
  | XuenessToolCallEvent
  | XuenessToolResultEvent
  | XuenessSessionCompletionEvent
  | XuenessSessionPendingQuestionEvent;

export interface XuenessEventsEnvelopeV1 {
  schema: typeof XUENESS_EVENTS_SCHEMA;
  protocolVersion: typeof XUENESS_PROTOCOL_VERSION;
  sessionId: string;
  status: string;
  steps: number;
  mode: string;
  events: XuenessEventV1[];
  cursor: number;
  nextCursor: number;
  head: number;
  hasMore: boolean;
}

export interface PageEventsOptions {
  cursor?: number;
  limit?: number;
}

export interface PageEventsResult {
  events: XuenessEventV1[];
  cursor: number;
  nextCursor: number;
  head: number;
  hasMore: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || typeof value === "string" && allowed.includes(value);
}

/**
 * 校验给定对象是否为合法的 XuenessEventV1。
 * 严格检查 schema、seq（正整数）、sessionId 及 7 种 type 的专属字段。未知或不符返回 false，不 throw。
 */
export function isXuenessEventV1(value: unknown): value is XuenessEventV1 {
  if (!isPlainObject(value)) return false;
  if (value.schema !== XUENESS_EVENT_SCHEMA) return false;
  if (!isPositiveInteger(value.seq)) return false;
  if (typeof value.sessionId !== "string") return false;
  if (typeof value.type !== "string") return false;

  switch (value.type) {
    case "session.status":
      return (
        typeof value.status === "string" &&
        Number.isInteger(value.steps) &&
        typeof value.mode === "string"
      );

    case "turn.user":
      return typeof value.turnId === "string" && typeof value.preview === "string";

    case "assistant.text":
      return typeof value.turnId === "string" && typeof value.preview === "string";

    case "tool.call":
      return (
        typeof value.turnId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string" &&
        typeof value.subject === "string"
      );

    case "tool.result":
      return (
        typeof value.turnId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string" &&
        typeof value.subject === "string" &&
        typeof value.ok === "boolean" &&
        typeof value.errorCode === "string" &&
        typeof value.error === "string"
      );

    case "session.completion":
      return (
        typeof value.verified === "boolean" &&
        typeof value.summary === "string" &&
        Number.isInteger(value.evidenceCount) &&
        (value.evidenceCount as number) >= 0 &&
        isOptionalEnum(value.status, ["verified", "unverified", "not_applicable", "incomplete"]) &&
        isOptionalEnum(value.toolExecutionStatus, ["succeeded", "failed", "incomplete", "not_applicable"]) &&
        isOptionalEnum(value.deliveryStatus, ["passed", "failed", "not_assessed"]) &&
        (value.turnId === undefined || typeof value.turnId === "string")
      );

    case "session.pending_question":
      return typeof value.question === "string";

    default:
      return false;
  }
}

/**
 * 校验信封对象，坏数据或字段不符返回 null，不 throw。
 */
export function parseEventsEnvelope(value: unknown): XuenessEventsEnvelopeV1 | null {
  if (!isPlainObject(value)) return null;
  if (value.schema !== XUENESS_EVENTS_SCHEMA) return null;
  if (value.protocolVersion !== XUENESS_PROTOCOL_VERSION) return null;
  if (typeof value.sessionId !== "string") return null;
  if (typeof value.status !== "string") return null;
  if (!Number.isInteger(value.steps)) return null;
  if (typeof value.mode !== "string") return null;
  if (!isNonNegativeInteger(value.cursor)) return null;
  if (!isNonNegativeInteger(value.nextCursor)) return null;
  if (!isNonNegativeInteger(value.head)) return null;
  if (typeof value.hasMore !== "boolean") return null;
  if (!Array.isArray(value.events)) return null;

  for (const ev of value.events) {
    if (!isXuenessEventV1(ev)) {
      return null;
    }
  }

  return value as unknown as XuenessEventsEnvelopeV1;
}

/**
 * 契约第 4 节：错误码（稳定枚举）确定性派生。
 * 判定顺序自上而下，先命中先返回：
 * 1. ok == true -> ""
 * 2. error（去空白、小写）等于 "denied"，或以 "denied" 开头 -> xueness.error.denied
 * 3. error 含 "cancel"（覆盖 cancelled/canceled） -> xueness.error.cancelled
 * 4. error 含 "not found" 或 "no such" -> xueness.error.not_found
 * 5. error 含 "invalid" 或 "required" -> xueness.error.invalid_argument
 * 6. 其他非空 error（或 ok==false 时的兜底） -> xueness.error.tool_failed
 */
export function errorCodeFor(ok: boolean, error: string): string {
  if (ok) return "";

  const trimmedLower = error.trim().toLowerCase();
  if (trimmedLower === "denied" || trimmedLower.startsWith("denied")) {
    return "xueness.error.denied";
  }
  if (trimmedLower.includes("cancel")) {
    return "xueness.error.cancelled";
  }
  if (trimmedLower.includes("not found") || trimmedLower.includes("no such")) {
    return "xueness.error.not_found";
  }
  if (trimmedLower.includes("invalid") || trimmedLower.includes("required")) {
    return "xueness.error.invalid_argument";
  }
  return "xueness.error.tool_failed";
}

/**
 * 纯函数，复刻契约第 2/5/6 节的分页语义：
 * - cursor: 整数，默认 0，若非法或小于 0 则抛出或处理；函数层处理 number 并钳位/校验
 * - limit: 默认 200，钳位到 1..500
 * - head = events.length（若以传入 events 的最大 seq 或长度衡量；派生事件从 1 开始连续编号）
 * - 只返回 seq > cursor 的事件
 * - nextCursor = 本次返回事件的最大 seq；本次没有事件时等于请求的 cursor
 * - hasMore = 在 seq > cursor 的集合里，是否还有超出 limit 的未返回事件
 */
export function pageEvents(
  events: XuenessEventV1[],
  cursor = 0,
  limit = 200,
): PageEventsResult {
  const head = events.length > 0 ? events[events.length - 1].seq : 0;

  // limit 钳位到 1..500
  const clampedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const effectiveCursor = Math.max(0, Math.floor(cursor));

  const afterCursor = events.filter((e) => e.seq > effectiveCursor);
  const paged = afterCursor.slice(0, clampedLimit);
  const hasMore = afterCursor.length > clampedLimit;

  const nextCursor = paged.length > 0 ? paged[paged.length - 1].seq : effectiveCursor;

  return {
    events: paged,
    cursor: effectiveCursor,
    nextCursor,
    head,
    hasMore,
  };
}

/**
 * v1 → 现有 legacy XuenessEvent 的降级投影。
 * 映射对应关系：
 * - tool.call -> { type: "tool_call", id: event.toolCallId, name: event.name, subject: event.subject }
 * - tool.result -> { type: "tool_result", id: event.toolCallId, subject: event.subject, ok: event.ok, error: event.error }
 * - assistant.text -> { type: "assistant", preview: event.preview }
 * - turn.user -> { type: "user", preview: event.preview }
 * - session.completion -> { type: "completion", verified: event.verified, summary: event.summary }
 * - session.status -> null（无直接 legacy 事件消费物，由 session 状态对象承担）
 * - session.pending_question -> null（无直接 legacy 事件消费物，legacy session 对象直接用 pending_question 字段）
 */
export function toLegacyEvent(event: XuenessEventV1): XuenessEvent | null {
  switch (event.type) {
    case "tool.call":
      return {
        type: "tool_call",
        id: event.toolCallId,
        name: event.name,
        subject: event.subject,
      };

    case "tool.result":
      return {
        type: "tool_result",
        id: event.toolCallId,
        subject: event.subject,
        ok: event.ok,
        error: event.error,
      };

    case "assistant.text":
      return {
        type: "assistant",
        preview: event.preview,
      };

    case "turn.user":
      return {
        type: "user",
        preview: event.preview,
      };

    case "session.completion":
      return {
        type: "completion",
        verified: event.verified,
        summary: event.summary,
      };

    case "session.status":
    case "session.pending_question":
      return null;

    default:
      return null;
  }
}
