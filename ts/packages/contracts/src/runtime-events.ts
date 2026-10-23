/** Durable, local-only session runtime event contract and recovery projection. */
export const XUENESS_SESSION_RUNTIME_SCHEMA = "xueness.session-runtime.v1" as const;
export const MAX_RUNTIME_EVENTS_PAGE = 500;
export const RUNTIME_TRANSCRIPT_LIMIT = 200;
export const RUNTIME_TOOL_LIMIT = 100;
export const RUNTIME_TEXT_LIMIT = 16_000;
export const RUNTIME_STREAM_LIMIT = 24_000;

export const SESSION_RUNTIME_EVENT_TYPES = [
  "RunStarted", "TurnPhase", "ModelRequest", "AssistantDelta", "ReasoningDelta",
  "AssistantMessage", "ToolCall", "ToolResult", "RunSettled", "HistoryReset", "Compacted", "FileRewound", "NetworkRequest", "McpActivity",
] as const;
export type SessionRuntimeEventType = typeof SESSION_RUNTIME_EVENT_TYPES[number];
export type RuntimePayload = Record<string, unknown>;

export interface SessionRuntimeEvent {
  schema: typeof XUENESS_SESSION_RUNTIME_SCHEMA;
  id: string;
  sessionId: string;
  turnId?: string;
  traceId?: string;
  type: SessionRuntimeEventType;
  timestamp: string;
  sequenceNumber: number;
  payload: RuntimePayload;
}

export interface RuntimeGap { expected: number; received: number }
export interface RuntimeTranscriptEntry {
  id: string;
  kind: "assistant" | "reasoning" | "tool" | "system";
  text: string;
  sequenceNumber: number;
  turnId?: string;
  messageId?: string;
  status?: string;
  name?: string;
  ok?: boolean;
}
export interface RuntimeToolProjection { id: string; name: string; status: "running" | "succeeded" | "failed" | "interrupted"; ok?: boolean; sequenceNumber: number; messageId?: string }
export interface RuntimeStreamProjection { id: string; assistantText: string; reasoningText: string; truncated?: boolean }
export interface SessionRuntimeProjection {
  schema: typeof XUENESS_SESSION_RUNTIME_SCHEMA;
  sessionId: string;
  lastSequenceNumber: number;
  generation?: number;
  status: string;
  turnId?: string;
  traceId?: string;
  phase?: string;
  stream: RuntimeStreamProjection | null;
  streamRecoveryAnchor?: RuntimePayload;
  transcript: RuntimeTranscriptEntry[];
  tools: RuntimeToolProjection[];
  gaps: RuntimeGap[];
  lastModelRequest?: RuntimePayload;
  lastNetworkRequest?: RuntimePayload;
  lastMcpActivity?: RuntimePayload;
}

export interface RuntimeEventPage {
  schema: typeof XUENESS_SESSION_RUNTIME_SCHEMA;
  sessionId: string;
  epoch: string;
  head: number;
  events: SessionRuntimeEvent[];
  next: number;
  hasMore: boolean;
  snapshot?: SessionRuntimeProjection;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string";
const boundedText = (value: unknown, limit: number): string => typeof value === "string" ? value.slice(-limit) : "";
const payloadText = (payload: RuntimePayload, key: string): string => typeof payload[key] === "string" ? payload[key] as string : "";
const safeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function copyText(source: RuntimePayload, target: RuntimePayload, key: string, limit = 160): void { if (typeof source[key] === "string") target[key] = (source[key] as string).slice(0, limit); }
function copyNumber(source: RuntimePayload, target: RuntimePayload, key: string): void { if (safeNumber(source[key])) target[key] = source[key]; }
function copyBoolean(source: RuntimePayload, target: RuntimePayload, key: string): void { if (typeof source[key] === "boolean") target[key] = source[key]; }

/** Strip fields outside the runtime wire allowlists before a payload reaches durable storage. */
export function sanitizeSessionRuntimePayload(type: SessionRuntimeEventType, source: RuntimePayload): RuntimePayload {
  const payload: RuntimePayload = {};
  switch (type) {
    case "RunStarted": {
      if (object(source.streamRecoveryAnchor)) {
        const anchor = source.streamRecoveryAnchor, safe: RuntimePayload = {};
        for (const key of ["streamId", "status", "turnId", "afterMessageId"] as const) copyText(anchor, safe, key, 128);
        if (anchor.streamId === null) safe.streamId = null;
        if (anchor.status === null) safe.status = null;
        if (Number.isSafeInteger(anchor.finalMessageIndex) && Number(anchor.finalMessageIndex) >= 0) safe.finalMessageIndex = anchor.finalMessageIndex;
        payload.streamRecoveryAnchor = safe;
      }
      break;
    }
    case "TurnPhase":
      copyText(source, payload, "phase", 80); copyText(source, payload, "resultType", 80);
      copyNumber(source, payload, "requestCount"); copyNumber(source, payload, "toolCallCount"); break;
    case "ModelRequest": {
      for (const key of ["phase", "requestId", "attemptId", "modelId", "providerKind", "reason", "errorCode", "failurePhase"] as const) copyText(source, payload, key, 160);
      for (const key of ["attempt", "maxAttempts", "durationMs", "queuedMs", "statusCode", "retryAfterMs"] as const) copyNumber(source, payload, key);
      for (const key of ["retryable", "terminal"] as const) copyBoolean(source, payload, key);
      if (object(source.response)) { const response: RuntimePayload = {}; copyNumber(source.response, response, "contentChars"); copyNumber(source.response, response, "toolCalls"); payload.response = response; }
      break;
    }
    case "McpActivity":
      for (const key of ["phase", "serverId", "connectionId"] as const) copyText(source, payload, key, 160);
      copyNumber(source, payload, "toolCount"); break;
    case "NetworkRequest": {
      for (const key of ["phase", "requestId", "errorCode"] as const) copyText(source, payload, key, 160);
      for (const key of ["redirects", "bytes"] as const) copyNumber(source, payload, key);
      if (typeof source.url === "string") {
        try {
          const url = new URL(source.url);
          if (url.protocol === "https:" && !url.username && !url.password) payload.url = url.origin + "/";
        } catch { /* Malformed activity URLs are omitted. */ }
      }
      break;
    }
    case "AssistantDelta":
    case "ReasoningDelta": copyText(source, payload, "text", Number.MAX_SAFE_INTEGER); copyText(source, payload, "streamId", 128); break;
    case "AssistantMessage": copyText(source, payload, "text", Number.MAX_SAFE_INTEGER); copyText(source, payload, "messageId", 128); copyText(source, payload, "streamId", 128); break;
    case "ToolCall": copyText(source, payload, "toolCallId", 128); copyText(source, payload, "name", 160); copyText(source, payload, "messageId", 128); break;
    case "ToolResult": copyText(source, payload, "toolCallId", 128); copyText(source, payload, "name", 160); copyText(source, payload, "messageId", 128); copyBoolean(source, payload, "ok"); break;
    case "RunSettled": copyText(source, payload, "status", 80); copyBoolean(source, payload, "returned"); copyNumber(source, payload, "steps"); break;
    case "HistoryReset":
      copyText(source, payload, "reason", 120); copyText(source, payload, "revision", 160);
      if (Number.isSafeInteger(source.generation) && Number(source.generation) >= 0) payload.generation = source.generation;
      if (Array.isArray(source.removedMessageIds)) payload.removedMessageIds = source.removedMessageIds.filter(text).map((id) => id.slice(0, 128));
      break;
    case 'FileRewound':
      copyText(source, payload, 'messageId');
      if (Array.isArray(source.paths)) payload.paths = source.paths.filter(text);
      if (Array.isArray(source.operationIds)) payload.operationIds = source.operationIds.filter(text);
      break;
    case "Compacted":
      for (const key of ["reason", "checkpointId", "operationId"] as const) copyText(source, payload, key, 160);
      for (const key of ["removed", "masked", "previous_chars", "estimatedTokens", "kept"] as const) copyNumber(source, payload, key);
      break;
  }
  return payload;
}

function sameShape(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!object(a) || !object(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameValue(a[key], b[key]));
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (object(a) && object(b)) return sameShape(a, b);
  return false;
}
function validPayload(type: SessionRuntimeEventType, payload: RuntimePayload): boolean {
  const clean = sanitizeSessionRuntimePayload(type, payload);
  if (!sameShape(payload, clean)) return false;
  switch (type) {
    case "TurnPhase": return text(payload.phase);
    case "ModelRequest": return text(payload.phase);
    case "McpActivity": return text(payload.serverId) && ["connected", "disconnected", "tools_changed", "resources_changed", "resource_updated", "cancelled", "failed"].includes(String(payload.phase));
    case "NetworkRequest": return text(payload.requestId) && ["started", "redirected", "completed", "failed", "cache_hit"].includes(String(payload.phase));
    case "AssistantDelta":
    case "ReasoningDelta":
    case "AssistantMessage": return text(payload.text);
    case "ToolCall": return text(payload.toolCallId) && text(payload.name);
    case "ToolResult": return text(payload.toolCallId) && text(payload.name) && typeof payload.ok === "boolean";
    case "RunSettled": return text(payload.status) && typeof payload.returned === "boolean" && (payload.steps === undefined || safeNumber(payload.steps));
    case "HistoryReset": return (payload.generation === undefined || Number.isSafeInteger(payload.generation) && Number(payload.generation) >= 0)
      && (payload.removedMessageIds === undefined || Array.isArray(payload.removedMessageIds) && payload.removedMessageIds.every(text));
    default: return true;
  }
}

export function isSessionRuntimeEventType(value: unknown): value is SessionRuntimeEventType {
  return typeof value === "string" && (SESSION_RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}

export function isSessionRuntimeEvent(value: unknown): value is SessionRuntimeEvent {
  if (!object(value) || value.schema !== XUENESS_SESSION_RUNTIME_SCHEMA || !text(value.id) || !value.id || value.id.length > 128
    || !text(value.sessionId) || !/^[0-9a-f]{32}$/.test(value.sessionId) || !isSessionRuntimeEventType(value.type)
    || !text(value.timestamp) || value.timestamp.length > 128 || !Number.isFinite(Date.parse(value.timestamp)) || !positive(value.sequenceNumber) || !object(value.payload)
    || !validPayload(value.type, value.payload)) return false;
  return (value.turnId === undefined || text(value.turnId) && value.turnId.length <= 128) && (value.traceId === undefined || text(value.traceId) && value.traceId.length <= 128);
}

export function emptyRuntimeProjection(sessionId: string): SessionRuntimeProjection {
  return { schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId, lastSequenceNumber: 0, status: "pending", stream: null, transcript: [], tools: [], gaps: [] };
}

function boundedPush<T>(rows: T[], row: T, limit: number): void { rows.push(row); if (rows.length > limit) rows.splice(0, rows.length - limit); }
function addTranscript(state: SessionRuntimeProjection, row: RuntimeTranscriptEntry): void {
  row.text = boundedText(row.text, RUNTIME_TEXT_LIMIT);
  boundedPush(state.transcript, row, RUNTIME_TRANSCRIPT_LIMIT);
}
function toolIndex(state: SessionRuntimeProjection, id: string): number { return state.tools.findIndex((row) => row.id === id); }

/** Apply strictly forward events, ignore replayed sequence numbers, and preserve sequence gaps. */
export function reduceSessionRuntimeEvents(
  events: readonly SessionRuntimeEvent[], initial?: SessionRuntimeProjection,
): SessionRuntimeProjection {
  let state = initial ? structuredClone(initial) : events.length ? emptyRuntimeProjection(events[0]!.sessionId) : emptyRuntimeProjection("");
  for (const event of events) {
    if (!isSessionRuntimeEvent(event)) throw new TypeError("invalid session runtime event");
    if (event.sessionId !== state.sessionId) throw new TypeError("session runtime event belongs to another session");
    if (event.sequenceNumber <= state.lastSequenceNumber) continue;
    if (event.sequenceNumber !== state.lastSequenceNumber + 1) boundedPush(state.gaps, { expected: state.lastSequenceNumber + 1, received: event.sequenceNumber }, 32);
    state.lastSequenceNumber = event.sequenceNumber;
    if (event.turnId !== undefined) state.turnId = event.turnId.slice(0, 128);
    if (event.traceId !== undefined) state.traceId = event.traceId.slice(0, 128);
    const p = event.payload;
    switch (event.type) {
      case "RunStarted": {
        state.status = "running";
        state.phase = "starting";
        state.stream = null;
        state.streamRecoveryAnchor = object(p.streamRecoveryAnchor) ? sanitizeSessionRuntimePayload("RunStarted", p).streamRecoveryAnchor as RuntimePayload : undefined;
        state.tools = state.tools.map((tool) => tool.status === "running" ? { ...tool, status: "interrupted" } : tool);
        break;
      }
      case "TurnPhase": state.phase = payloadText(p, "phase"); break;
      case "ModelRequest": state.lastModelRequest = sanitizeSessionRuntimePayload("ModelRequest", p); break;
      case "AssistantDelta":
      case "ReasoningDelta": {
        const id = (payloadText(p, "streamId") || `stream-${event.turnId ?? "unknown"}`).slice(0, 128);
        if (!state.stream || state.stream.id !== id) state.stream = { id, assistantText: "", reasoningText: "" };
        const field = event.type === "AssistantDelta" ? "assistantText" : "reasoningText";
        const prior = state.stream[field], combined = prior + payloadText(p, "text");
        if (combined.length > RUNTIME_STREAM_LIMIT) state.stream.truncated = true;
        state.stream[field] = boundedText(combined, RUNTIME_STREAM_LIMIT);
        break;
      }
      case "AssistantMessage": {
        const messageId = payloadText(p, "messageId").slice(0, 128), id = (messageId || event.id).slice(0, 128);
        addTranscript(state, { id, kind: "assistant", text: payloadText(p, "text"), sequenceNumber: event.sequenceNumber, ...(messageId ? { messageId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) });
        if (state.stream && (!p.streamId || p.streamId === state.stream.id)) state.stream = null;
        break;
      }
      case "ToolCall": {
        const id = payloadText(p, "toolCallId").slice(0, 128);
        if (!id) break;
        const messageId = payloadText(p, "messageId").slice(0, 128), name = payloadText(p, "name").slice(0, 160);
        const tool: RuntimeToolProjection = { id, name, status: "running", sequenceNumber: event.sequenceNumber, ...(messageId ? { messageId } : {}) };
        const index = toolIndex(state, id);
        if (index >= 0) state.tools[index] = tool; else boundedPush(state.tools, tool, RUNTIME_TOOL_LIMIT);
        addTranscript(state, { id, kind: "tool", text: "", name: tool.name, status: tool.status, sequenceNumber: event.sequenceNumber, ...(messageId ? { messageId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) });
        break;
      }
      case "ToolResult": {
        const id = payloadText(p, "toolCallId").slice(0, 128), index = toolIndex(state, id);
        if (!id) break;
        const ok = p.ok === true, name = payloadText(p, "name").slice(0, 160) || (index >= 0 ? state.tools[index]!.name : "");
        const messageId = payloadText(p, "messageId").slice(0, 128) || (index >= 0 ? state.tools[index]!.messageId : undefined);
        const tool: RuntimeToolProjection = { id, name, status: ok ? "succeeded" : "failed", ok, sequenceNumber: event.sequenceNumber, ...(messageId ? { messageId } : {}) };
        if (index >= 0) state.tools[index] = tool; else boundedPush(state.tools, tool, RUNTIME_TOOL_LIMIT);
        addTranscript(state, { id, kind: "tool", text: "", name, ok, status: tool.status, sequenceNumber: event.sequenceNumber, ...(messageId ? { messageId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) });
        break;
      }
      case "RunSettled":
        state.status = payloadText(p, "status") || "settled";
        state.phase = "settled";
        state.stream = null;
        state.streamRecoveryAnchor = undefined;
        break;
      case "HistoryReset":
        {
          const removed = new Set(Array.isArray(p.removedMessageIds) ? p.removedMessageIds.filter(text) : []);
          state.transcript = state.transcript.filter((entry) => !removed.has(entry.messageId ?? entry.id));
          state.tools = state.tools.filter((tool) => !tool.messageId || !removed.has(tool.messageId));
          if (Number.isSafeInteger(p.generation) && Number(p.generation) >= 0) state.generation = Number(p.generation);
          state.stream = null; state.streamRecoveryAnchor = undefined; state.phase = "reset"; state.status = 'paused';
        }
        break;
      case "McpActivity": state.lastMcpActivity = { ...p }; break;
      case "NetworkRequest": state.lastNetworkRequest = { ...p }; break;
      case 'FileRewound': break;
      case "Compacted":
        addTranscript(state, { id: payloadText(p, "operationId") || event.id, kind: "system", text: "History compacted", sequenceNumber: event.sequenceNumber, ...(event.turnId ? { turnId: event.turnId } : {}) });
        break;
    }
  }
  return state;
}

/** Recover a bounded snapshot from one or more pages, optionally continuing an existing checkpoint. */
export function recoverRuntimeProjection(page: RuntimeEventPage, initial?: SessionRuntimeProjection): SessionRuntimeProjection {
  if (page.schema !== XUENESS_SESSION_RUNTIME_SCHEMA || !/^[0-9a-f]{32}$/.test(page.sessionId) || !page.epoch) throw new TypeError("invalid session runtime page");
  const state = reduceSessionRuntimeEvents(page.events, initial ?? page.snapshot ?? emptyRuntimeProjection(page.sessionId));
  return { ...state, lastSequenceNumber: Math.max(state.lastSequenceNumber, page.next) };
}
