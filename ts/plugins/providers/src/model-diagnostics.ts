import { reportedUsage } from "@xueness/providers";

export type Row = Record<string, unknown>;

const REQUEST_FIELDS = ["messageCount", "toolCount", "inputChars", "systemChars", "assistantChars", "toolCallCount"] as const;
const STREAM_FIELDS = ["textChunks", "textChars", "reasoningChunks", "reasoningChars", "toolSnapshots", "firstTextMs", "firstReasoningMs"] as const;
const RESPONSE_FIELDS = ["contentChars", "toolCalls"] as const;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Count canonical text only; media, tool arguments, signatures and arbitrary objects contribute nothing. */
export function summarizeModelRequest(request: { messages: Row[]; tools: Row[] }): Row {
  let inputChars = 0;
  let systemChars = 0;
  let assistantChars = 0;
  let toolCallCount = 0;
  for (const message of request.messages) {
    const role = message.role;
    const chars = canonicalTextLength(message.content);
    if (role === "system") systemChars += chars;
    else if (role === "assistant") assistantChars += chars;
    else inputChars += chars;
    if (Array.isArray(message.tool_calls)) toolCallCount += message.tool_calls.length;
  }
  return {
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    inputChars,
    systemChars,
    assistantChars,
    toolCallCount,
  };
}

/** Project request-attempt metadata into the versioned, content-free debug schema. */
export function modelDebugRecord(sessionId: string, info: Row, requestSummary?: Row): Row {
  const record: Row = {
    schema: "xueness.model-debug.v1",
    sessionId: safeId(sessionId) ?? "unknown",
    timestamp: safeTimestamp(info.timestamp) ?? new Date().toISOString(),
  };
  for (const key of ["requestId", "attemptId", "selectionId"] as const) {
    const value = safeId(info[key]);
    if (value) record[key] = value;
  }
  for (const key of ["attempt", "maxAttempts", "statusCode"] as const) {
    const value = safeCount(info[key]);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ["durationMs", "queuedMs"] as const) {
    const value = safeMetric(info[key]);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ["modelId", "providerKind", "type", "reason", "errorCode", "phase", "finishReason"] as const) {
    const value = key === "modelId" ? safeText(info[key], 160) : safeCode(info[key], 128);
    if (key === "type" && value !== undefined && !["model_request_started", "model_request_completed", "model_request_failed"].includes(value)) continue;
    if (value) record[key] = value;
  }
  for (const key of ["retryable", "terminal"] as const) {
    if (typeof info[key] === "boolean") record[key] = info[key];
  }

  const request = pickMetrics(requestSummary, REQUEST_FIELDS);
  const diagnostics = pickMetrics(asRow(info.diagnostics), STREAM_FIELDS);
  const response = pickMetrics(asRow(info.response), RESPONSE_FIELDS);
  if (Object.keys(request).length) record.request = request;
  if (Object.keys(diagnostics).length) record.diagnostics = diagnostics;
  if (Object.keys(response).length) record.response = response;

  const usage = reportedUsage(info.usage);
  if (Object.keys(usage).length) record.usage = usage;
  return record;
}

function canonicalTextLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let length = 0;
  for (const part of content) {
    const row = asRow(part);
    if (row.type === "text" || row.type === "reasoning") {
      if (typeof row.text === "string") length += row.text.length;
    } else if (row.type === "thinking" && typeof row.thinking === "string") {
      length += row.thinking.length;
    }
  }
  return length;
}

function pickMetrics<T extends readonly string[]>(source: Row | undefined, fields: T): Row {
  const result: Row = {};
  if (!source) return result;
  for (const key of fields) {
    const value = key.endsWith("Ms") ? safeMetric(source[key]) : safeCount(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function safeMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return clean || undefined;
}

function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(CONTROL, "").slice(0, limit);
  return clean || undefined;
}

function safeCode(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length > limit || !/^[a-zA-Z0-9_-]+$/.test(value)) return undefined;
  return value;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function asRow(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}
