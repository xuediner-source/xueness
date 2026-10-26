/**
 * Request-view pass for ZCode compaction; the journal itself is never rewritten here.
 * - A `_compact_summary` journal row becomes ZCode's user summary message, followed by its
 *   post-compact system-reminders (ZCode `compact-active.ts` buildPostCompactRuntimeEntries);
 *   `tool_discovery` reminders (C-TOOL-05/F02.04) pass through as their own source.
 * - Optional microcompact (ZCode `microcompact.ts`; off by default as in ZCode).
 * - Read file_unchanged: ZCode's Read tool answers a repeated, unchanged read with a stub
 *   (ZCode `core/src/tool/handlers/read.ts` FILE_UNCHANGED_STUB). Xueness reads always return the
 *   content, so the view stubs a later Read whose input and result equal an earlier Read
 *   result that is still visible in the same request.
 */
import { MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE, maybeLocalMicrocompactMessages, wrapSystemReminderForSource, type LocalMicrocompactPolicyConfig, type Row } from "@xueness/agent";

export const FILE_UNCHANGED_STUB = "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

export function projectCompactSummaries(messages: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const message of messages) {
    if (message._compact_summary !== true) { out.push(message); continue; }
    const { _post_compact_reminders: reminders, _compact_summary: _, ...rest } = message;
    out.push({ ...rest, role: "user", content: typeof message.content === "string" ? message.content : "" });
    for (const reminder of Array.isArray(reminders) ? reminders.filter(isRow) : []) {
      if (typeof reminder.content !== "string" || !reminder.content) continue;
      const source = reminder.source === "todo_reminder" || reminder.source === "tool_discovery" || reminder.source === "resume_referenced_session_context"
        ? reminder.source : "resume_referenced_session_context";
      out.push({ role: "user", content: wrapSystemReminderForSource(source, reminder.content), _meta_source: source });
    }
  }
  return out;
}

/** Normalized Read input; offset 1 and an absent offset name the same view. */
function readKey(args: unknown): string | null {
  let input: unknown = args;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return null; } }
  if (!isRow(input) || typeof input.file_path !== "string") return null;
  const offset = typeof input.offset === "number" && input.offset > 1 ? input.offset : 1;
  return JSON.stringify([input.file_path, offset, typeof input.limit === "number" ? input.limit : null, input.pages ?? null]);
}

export function stubUnchangedReads(messages: readonly Row[], isError: (id: string) => boolean = () => false): Row[] {
  const readCalls = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls.filter(isRow)) {
      const fn = isRow(call.function) ? call.function : null;
      const key = fn?.name === "Read" ? readKey(fn.arguments) : null;
      if (key && typeof call.id === "string") readCalls.set(call.id, key);
    }
  }
  const seen = new Map<string, string>();
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") return message;
    const key = readCalls.get(message.tool_call_id);
    if (!key || typeof message.content !== "string" || isError(message.tool_call_id)) return message;
    const content = message.content;
    if (content === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE || content === FILE_UNCHANGED_STUB || content.length <= FILE_UNCHANGED_STUB.length) return message;
    if (seen.get(key) === content) return { ...message, content: FILE_UNCHANGED_STUB };
    seen.set(key, content);
    return message;
  });
}

export function compactRequestView(messages: readonly Row[], options: { isError?: (id: string) => boolean; microcompact?: LocalMicrocompactPolicyConfig; lastAssistantCompletedAtMs?: number } = {}): Row[] {
  let view = projectCompactSummaries(messages);
  if (options.microcompact?.enabled === true) {
    view = maybeLocalMicrocompactMessages({ config: options.microcompact, messages: view, isError: options.isError, lastAssistantCompletedAtMs: options.lastAssistantCompletedAtMs }).messages;
  }
  return stubUnchangedReads(view, options.isError);
}
