/**
 * Xueness Event Protocol v1: wire types and validators.
 *
 * The shapes match `webapp/src/xuenessEvents.ts` and the frozen golden file
 * `tools/protocol-v1-golden.json`. This package is meant to become the single
 * source both the server and the webapp import.
 */

export const XUENESS_EVENT_SCHEMA = "xueness.event.v1" as const;
export const XUENESS_EVENTS_SCHEMA = "xueness.events.v1" as const;
export const XUENESS_PROTOCOL_VERSION = 1 as const;

/** Bound on how many events an unpaginated caller can pull in one response. */
export const DEFAULT_EVENTS_LIMIT = 200;
export const MAX_EVENTS_LIMIT = 500;

export const ERROR_CODES = {
  denied: "xueness.error.denied",
  cancelled: "xueness.error.cancelled",
  notFound: "xueness.error.not_found",
  invalidArgument: "xueness.error.invalid_argument",
  toolFailed: "xueness.error.tool_failed",
} as const;

export type XuenessErrorCode = "" | (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const COMPLETION_STATUSES = ["verified", "unverified", "not_applicable", "incomplete"] as const;
export const TOOL_EXECUTION_STATUSES = ["succeeded", "failed", "incomplete", "not_applicable"] as const;
export const DELIVERY_STATUSES = ["passed", "failed", "not_assessed"] as const;

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
  status?: (typeof COMPLETION_STATUSES)[number];
  toolExecutionStatus?: (typeof TOOL_EXECUTION_STATUSES)[number];
  deliveryStatus?: (typeof DELIVERY_STATUSES)[number];
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

export type XuenessEventType = XuenessEventV1["type"];

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

type Shape = Record<string, unknown>;

function isPlainObject(value: unknown): value is Shape {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === "string" && allowed.includes(value));
}

function allStrings(value: Shape, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

const BODY_CHECKS: Record<XuenessEventType, (value: Shape) => boolean> = {
  "session.status": (v) => typeof v.status === "string" && Number.isInteger(v.steps) && typeof v.mode === "string",
  "turn.user": (v) => allStrings(v, ["turnId", "preview"]),
  "assistant.text": (v) => allStrings(v, ["turnId", "preview"]),
  "tool.call": (v) => allStrings(v, ["turnId", "toolCallId", "name", "subject"]),
  "tool.result": (v) => allStrings(v, ["turnId", "toolCallId", "name", "subject", "errorCode", "error"])
    && typeof v.ok === "boolean",
  "session.completion": (v) => typeof v.verified === "boolean" && typeof v.summary === "string"
    && isNonNegativeInteger(v.evidenceCount)
    && isOptionalEnum(v.status, COMPLETION_STATUSES)
    && isOptionalEnum(v.toolExecutionStatus, TOOL_EXECUTION_STATUSES)
    && isOptionalEnum(v.deliveryStatus, DELIVERY_STATUSES)
    && (v.turnId === undefined || typeof v.turnId === "string"),
  "session.pending_question": (v) => typeof v.question === "string",
};

/** Strict structural check. Unknown types and wrong field types return false. */
export function isXuenessEventV1(value: unknown): value is XuenessEventV1 {
  if (!isPlainObject(value)) return false;
  if (value.schema !== XUENESS_EVENT_SCHEMA) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return false;
  if (typeof value.sessionId !== "string" || typeof value.type !== "string") return false;
  const check = Object.hasOwn(BODY_CHECKS, value.type) ? BODY_CHECKS[value.type as XuenessEventType] : undefined;
  return check !== undefined && check(value);
}

/** Validate an events envelope; returns null instead of throwing. */
export function parseEventsEnvelope(value: unknown): XuenessEventsEnvelopeV1 | null {
  if (!isPlainObject(value)) return null;
  if (value.schema !== XUENESS_EVENTS_SCHEMA || value.protocolVersion !== XUENESS_PROTOCOL_VERSION) return null;
  if (typeof value.sessionId !== "string" || typeof value.status !== "string") return null;
  if (!Number.isInteger(value.steps) || typeof value.mode !== "string") return null;
  if (!isNonNegativeInteger(value.cursor) || !isNonNegativeInteger(value.nextCursor)) return null;
  if (!isNonNegativeInteger(value.head) || typeof value.hasMore !== "boolean") return null;
  if (!Array.isArray(value.events) || !value.events.every(isXuenessEventV1)) return null;
  return value as unknown as XuenessEventsEnvelopeV1;
}
