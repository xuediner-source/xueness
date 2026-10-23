/**
 * Context-overflow recognition and compaction error texts.
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0) `core/runtime/helpers/model-errors.ts`
 * (isModelContextExceededError, createCompactRapidRefillError),
 * `core/runtime/helpers/compact-selection.ts` (prompt-too-long token gap),
 * `core/compact/manual.ts` and `core/runtime/methods/compact-active-helpers.ts` (texts).
 */
type Row = Record<string, unknown>;
export const MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3;
export const COMPACT_PROMPT_TOO_LONG_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";
export const COMPACT_PROMPT_TOO_LONG_USER_MESSAGE = "Conversation too long to compact automatically. Try /compact again after narrowing the active context.";
export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_EMPTY_SUMMARY_MESSAGE = "Failed to generate compact summary";
export const COMPACT_UP_TO_DATE_MESSAGE = "Context is up to date; no compression needed";
export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const rapidRefillMessage = (): string =>
  `Autocompact stopped because the context refilled within fewer than ${RAPID_REFILL_TOOL_TURN_THRESHOLD} tool turns after compaction ${MAX_CONSECUTIVE_RAPID_REFILLS} times in a row. A file or tool output may be too large. Read it in smaller chunks, or start a new session.`;

/** A compaction failure; `retryable` mirrors ZCode CoreError.retryable for the auto retry loop. */
export class CompactionError extends Error {
  override name = "CompactionError";
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options); this.code = code; this.retryable = retryable;
  }
}

const MARKERS = new Set(["model_context_exceeded", "context_exceeded", "context_length_exceeded", "context_window_exceeded", "model_context_window_exceeded", "prompt_too_long"]);
const isMarker = (value: unknown): boolean => typeof value === "string" && MARKERS.has(value.trim().toLowerCase());
function isOverflowMessage(value: unknown): boolean {
  const message = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!message) return false;
  return message.includes("context") && message.includes("exceed")
    || message.includes("context") && message.includes("too long")
    || message.includes("prompt") && message.includes("too long");
}

/** ZCode isModelContextExceededError, plus the Xueness provider error's `contextOverflow` flag. */
export function isModelContextExceededError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null || typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const record = current as Row;
    if (record.contextOverflow === true || record.context_overflow === true) return true;
    if (record.category === "context_overflow") return true;
    if (isMarker(record.type) || isMarker(record.code) || isMarker(record.reason) || isMarker(record.stopReason) || isOverflowMessage(record.message)) return true;
    const context = record.context && typeof record.context === "object" ? record.context as Row : undefined;
    if (context && (isMarker(context.type) || isMarker(context.code) || isMarker(context.reason))) return true;
    current = record.cause ?? record.lastError ?? record.error;
  }
  return false;
}

/** `N tokens > M` in a provider message gives how far over the window the prompt was. */
export function parsePromptTooLongTokenGap(message: string): number | undefined {
  const match = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (!match) return undefined;
  const actual = Number(match[1]?.replace(/,/g, ""));
  const limit = Number(match[2]?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) return undefined;
  return Math.ceil(actual - limit);
}

export function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") return parsePromptTooLongTokenGap(current);
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    const record = current as Row;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }
  return undefined;
}
