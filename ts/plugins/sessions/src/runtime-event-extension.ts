import { createSessionRuntimeEventLog, type SessionRuntimeEventLog } from "./runtime-event-log.ts";
import type { AgentContext, AgentEvent, AgentExtension, Row } from "@xueness/agent";

type RuntimeRecordEvent = (context: AgentContext, event: AgentEvent) => void;
type RuntimeExtension = AgentExtension & { recordEvent: RuntimeRecordEvent };
type Metadata = { epoch: string; lastSequenceNumber: number };
const logs = new WeakMap<AgentContext, SessionRuntimeEventLog>();
const metadata = new WeakMap<AgentContext, Metadata>();

function safeString(value: unknown, limit = 160): string | undefined { return typeof value === "string" && value.length ? value.slice(0, limit) : undefined; }
function safeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function safeBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function add(target: Row, source: Row, fields: readonly string[], numeric: readonly string[] = []): Row {
  for (const key of fields) { const value = safeString(source[key]); if (value !== undefined) target[key] = value; }
  for (const key of numeric) { const value = safeInteger(source[key]); if (value !== undefined) target[key] = value; }
  return target;
}

function anchor(context: AgentContext): Row {
  const stream = context.session.streaming && typeof context.session.streaming === "object" ? context.session.streaming as Row : {};
  const result: Row = { streamId: safeString(stream.id) ?? null, status: safeString(stream.status) ?? null };
  const turnId = safeString(stream.transcript_turn_id) ?? safeString(context.session.active_turn_id);
  if (turnId) result.turnId = turnId;
  const messageId = safeString(stream.after_message_id);
  if (messageId) result.afterMessageId = messageId;
  const index = safeInteger(stream.final_message_index);
  if (index !== undefined) result.finalMessageIndex = index;
  return result;
}

function sourceMessageId(context: AgentContext, event: Row): string | undefined {
  const rows = Array.isArray(context.session.messages) ? context.session.messages as Row[] : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const message = rows[i];
    if (!message || message.role !== "assistant" || typeof message._message_id !== "string") continue;
    if (event.type === "assistant" && message.content === event.text) return safeString(message._message_id, 128);
    if (event.type === "tool_call" || event.type === "tool_result") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Row[] : [];
      if (calls.some((call) => call && call.id === event.id)) return safeString(message._message_id, 128);
    }
  }
  return undefined;
}

function record(log: SessionRuntimeEventLog, meta: Metadata, type: Parameters<SessionRuntimeEventLog["append"]>[0]["type"], payload: Row, context: AgentContext, traceId?: string, turnId?: string): void {
  if (!traceId && type !== 'RunStarted' && context.session.runtime_turn && typeof context.session.runtime_turn === 'object') traceId = safeString((context.session.runtime_turn as Row).traceId);
  const event = log.append({ type, payload, ...(turnId ? { turnId } : typeof context.session.active_turn_id === "string" ? { turnId: context.session.active_turn_id } : {}), ...(traceId ? { traceId } : {}) });
  meta.lastSequenceNumber = event.sequenceNumber;
}

function mappedEvent(context: AgentContext, event: AgentEvent): { type: Parameters<SessionRuntimeEventLog["append"]>[0]["type"]; payload: Row; turnId?: string; traceId?: string } | null {
  const e = event as Row, type = safeString(e.type) ?? "";
  const turnId = safeString(e.turnId) ?? safeString(context.session.active_turn_id), traceId = safeString(e.traceId);
  if (type === "turn_phase") return { type: "TurnPhase", payload: add({ phase: safeString(e.phase) ?? "unknown" }, e, ["resultType"], ["requestCount", "toolCallCount"]), ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  if (type.startsWith("model_request_")) {
    const payload: Row = { phase: type.slice("model_request_".length) };
    add(payload, e, ["requestId", "attemptId", "modelId", "providerKind", "reason", "errorCode"], ["attempt", "maxAttempts", "durationMs", "queuedMs", "statusCode", "retryAfterMs"]);
    if (safeString(e.phase)) payload.failurePhase = safeString(e.phase);
    const response = e.response as Row | undefined;
    if (response && typeof response === "object") payload.response = add({}, response, [], ["contentChars", "toolCalls"]);
    const retryable = safeBoolean(e.retryable), terminal = safeBoolean(e.terminal);
    if (retryable !== undefined) payload.retryable = retryable;
    if (terminal !== undefined) payload.terminal = terminal;
    return { type: "ModelRequest", payload, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  }
  if (type === "mcp_activity") return { type: "McpActivity", payload: add({}, e, ["phase", "serverId", "connectionId"], ["toolCount"]), ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  if (type === "network_request") return { type: "NetworkRequest", payload: { ...add({}, e, ["phase", "requestId", "errorCode"], ["redirects", "bytes"]), ...(typeof e.url === "string" ? { url: e.url } : {}) }, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  if (type === "assistant_delta" || type === "reasoning_delta") {
    const text = typeof e.text === "string" ? e.text : "";
    return { type: type === "assistant_delta" ? "AssistantDelta" : "ReasoningDelta", payload: { text, ...(safeString(e.stream_id) ? { streamId: safeString(e.stream_id) } : {}) }, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  }
  if (type === "assistant") return { type: "AssistantMessage", payload: { text: typeof e.text === "string" ? e.text : "", ...(sourceMessageId(context, e) ? { messageId: sourceMessageId(context, e) } : {}) }, ...(turnId ? { turnId } : {}) };
  if (type === "tool_call") return { type: "ToolCall", payload: { toolCallId: safeString(e.id) ?? "", name: safeString(e.name) ?? "", ...(sourceMessageId(context, e) ? { messageId: sourceMessageId(context, e) } : {}) }, ...(turnId ? { turnId } : {}) };
  if (type === "tool_result") return { type: "ToolResult", payload: { toolCallId: safeString(e.id) ?? "", name: safeString(e.name) ?? "", ok: e.ok === true, ...(sourceMessageId(context, e) ? { messageId: sourceMessageId(context, e) } : {}) }, ...(turnId ? { turnId } : {}) };
  if (type === "history_reset") {
    const payload = add({}, e, ["reason", "revision"], ["generation"]);
    if (Array.isArray(e.removedMessageIds)) payload.removedMessageIds = e.removedMessageIds.filter((id): id is string => typeof id === "string");
    return { type: "HistoryReset", payload, ...(turnId ? { turnId } : {}) };
  }
  if (type === "compacted") return { type: "Compacted", payload: add({}, e, ["reason"], ["removed", "masked", "previous_chars", "estimatedTokens"]), ...(turnId ? { turnId } : {}) };
  if (type === "context/compaction_completed") return { type: "Compacted", payload: add({}, e, ["checkpointId", "operationId"], ["removed", "kept"]), ...(turnId ? { turnId } : {}) };
  return null;
}

export function runtimeEventMetadata(context: AgentContext): Readonly<Metadata> | null {
  const value = metadata.get(context);
  return value ? { ...value } : null;
}

export function sessionsRuntimeEventsExtension(): AgentExtension {
  const extension: RuntimeExtension = {
    id: "sessions",
    capabilities: ["sessions.runtime_events"],
    beforeRun(context) {
      const log = createSessionRuntimeEventLog(context.stateDir, String(context.session.id));
      const current = log.metadata();
      logs.set(context, log); metadata.set(context, { ...current });
    },
    runStarted(context) {
      const log = logs.get(context), meta = metadata.get(context);
      if (!log || !meta) throw new Error("runtime event log was not bound before run start");
      // Turn runtime initializes its new trace in the next hook; never reuse a prior run's trace here.
      record(log, meta, "RunStarted", { streamRecoveryAnchor: anchor(context) }, context);
    },
    recordEvent(context, event) {
      const log = logs.get(context), meta = metadata.get(context);
      if (!log || !meta) return;
      const mapped = mappedEvent(context, event);
      if (mapped) {
        record(log, meta, mapped.type, mapped.payload, context, mapped.traceId, mapped.turnId);
      }
    },
    settleRun(context, returned) {
      const log = logs.get(context), meta = metadata.get(context);
      if (!log || !meta) return;
      record(log, meta, "RunSettled", { status: safeString(context.session.status) ?? "unknown", returned, steps: safeInteger(context.session.steps) ?? 0 }, context);
    },
    close(context) { logs.delete(context); metadata.delete(context); },
  };
  return extension;
}
