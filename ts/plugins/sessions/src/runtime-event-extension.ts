import { createSessionRuntimeEventLog, type SessionRuntimeEventLog } from "./runtime-event-log.ts";
import type { AgentContext, AgentEvent, AgentExtension, Row } from "@xueness/agent";

type RuntimeRecordEvent = (context: AgentContext, event: AgentEvent) => void;
type RuntimeExtension = AgentExtension & { recordEvent: RuntimeRecordEvent };
type Metadata = { epoch: string; lastSequenceNumber: number };
const logs = new WeakMap<AgentContext, SessionRuntimeEventLog>();
const metadata = new WeakMap<AgentContext, Metadata>();

function safeString(value: unknown, limit = 160): string | undefined { return typeof value === "string" && value.length ? value.slice(0, limit) : undefined; }
function safeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function safeNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function safeBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function add(target: Row, source: Row, fields: readonly string[], numeric: readonly string[] = [], metrics: readonly string[] = []): Row {
  for (const key of fields) { const value = safeString(source[key]); if (value !== undefined) target[key] = value; }
  for (const key of numeric) { const value = safeInteger(source[key]); if (value !== undefined) target[key] = value; }
  for (const key of metrics) { const value = safeNumber(source[key]); if (value !== undefined) target[key] = value; }
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

const USAGE_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cached_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "reasoning_tokens"];
/** Provider-reported counters only; a completion without usage keeps the field absent (unknown), never zero-filled. */
function usageProjection(raw: unknown): Row | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Row, usage: Row = {};
  for (const key of USAGE_KEYS) { const value = safeInteger(source[key]); if (value !== undefined) usage[key] = value; }
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    const detail = source[key];
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
    const clean: Row = {};
    for (const name of ["cached_tokens", "reasoning_tokens"]) { const value = safeInteger((detail as Row)[name]); if (value !== undefined) clean[name] = value; }
    if (Object.keys(clean).length) usage[key] = clean;
  }
  return Object.keys(usage).length ? usage : undefined;
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
    add(payload, e, ["requestId", "attemptId", "selectionId", "modelId", "providerKind", "reason", "errorCode"], ["attempt", "maxAttempts", "statusCode"], ["durationMs", "queuedMs", "retryAfterMs"]);
    if (safeString(e.phase)) payload.failurePhase = safeString(e.phase);
    const response = e.response as Row | undefined;
    if (response && typeof response === "object") payload.response = add({}, response, [], ["contentChars", "toolCalls"]);
    const usage = usageProjection(e.usage);
    if (usage) payload.usage = usage;
    const retryable = safeBoolean(e.retryable), terminal = safeBoolean(e.terminal);
    if (retryable !== undefined) payload.retryable = retryable;
    if (terminal !== undefined) payload.terminal = terminal;
    return { type: "ModelRequest", payload, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  }
  if (type === "model_retry_scheduled") {
    const payload: Row = {};
    add(payload, e, ["requestId", "attemptId", "selectionId", "modelId", "providerKind", "reason", "errorCode"], ["attempt", "nextAttempt", "maxAttempts", "statusCode"], ["delayMs", "retryAfterMs"]);
    return { type: "ModelRetry", payload, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
  }
  if (type === "model_execution_fallback" || type === "model_execution_fallback_unavailable") {
    // Flatten the record onto the wire shape: from/to selections become IDs, the
    // skipped-candidate details stay out (their error text is not ledger material).
    const payload: Row = { applied: e.applied === true };
    add(payload, e, ["selectionId", "requestId", "attemptId", "reason", "providerErrorCode"], ["attempt", "statusCode"]);
    const from = e.from as Row | undefined, to = e.to as Row | undefined;
    const fromProviderId = from && typeof from === "object" ? safeString(from.providerId) : undefined;
    const fromModelId = from && typeof from === "object" ? safeString(from.modelId) : undefined;
    const toProviderId = to && typeof to === "object" ? safeString(to.providerId) : undefined;
    const toModelId = to && typeof to === "object" ? safeString(to.modelId) : undefined;
    if (fromProviderId) payload.fromProviderId = fromProviderId;
    if (fromModelId) payload.fromModelId = fromModelId;
    if (toProviderId) payload.toProviderId = toProviderId;
    if (toModelId) payload.toModelId = toModelId;
    if (safeString(e.toSource)) payload.toSource = safeString(e.toSource);
    const settled = e.settled as Row | undefined;
    if (settled && typeof settled === "object") {
      const projection: Row = add({}, settled, ["streamId"], ["textChars", "reasoningChars", "toolSnapshots"]);
      if (safeBoolean(settled.truncated) !== undefined) projection.truncated = safeBoolean(settled.truncated);
      payload.settled = projection;
    }
    if (Array.isArray(e.skipped)) payload.skippedCount = e.skipped.length;
    return { type: "ModelExecutionFallback", payload, ...(turnId ? { turnId } : {}), ...(traceId ? { traceId } : {}) };
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
