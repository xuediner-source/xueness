/**
 * Local microcompact: clear old tool results in the request view.
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0) `core/compact/microcompact.ts` and
 * `core/runtime/methods/microcompact.ts`. Rows are OpenAI-shaped request messages after
 * the tool-contract projection (ZCode tool names). As in ZCode it is off unless enabled.
 */
import { contentText, estimateMessageTokens } from "./policy.ts";

type Row = Record<string, unknown>;
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
export const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = ["Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Edit", "Write", "ApplyPatch"] as const;

export interface LocalMicrocompactPolicyConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
}
export interface LocalMicrocompactResult {
  decision: { estimatedTokenCount: number; reason: "disabled" | "not_triggered" | "no_candidates" | "nothing_to_clear" | "below_min_savings" | "applied"; thresholdTokens?: number; trigger?: "time_based" | "token_pressure" };
  messages: Row[];
  payload?: { clearedMessageCount: number; clearedToolCallIds: string[]; keptToolCallIds: string[]; preMicrocompactTokenCount: number; postMicrocompactTokenCount: number; tokensSaved: number; trigger: "time_based" | "token_pressure" };
}
const positiveInt = (value: number | undefined): number | undefined => value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.floor(value);

export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratio = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  return Math.max(0, Math.min(ratio, autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS));
}

function hasMedia(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => block && typeof block === "object" && ["image", "image_url", "video", "file"].includes(String((block as Row).type)));
}

export function maybeLocalMicrocompactMessages(input: { config?: LocalMicrocompactPolicyConfig; messages: readonly Row[]; isError?: (toolCallId: string) => boolean; lastAssistantCompletedAtMs?: number; nowMs?: number }): LocalMicrocompactResult {
  const config = input.config ?? {};
  const messages = input.messages.map((message) => ({ ...message }));
  const estimatedTokenCount = estimateMessageTokens(messages);
  const thresholdTokens = positiveInt(config.thresholdTokens);
  if (config.enabled === false) return { decision: { estimatedTokenCount, reason: "disabled", thresholdTokens }, messages };
  let trigger: "time_based" | "token_pressure" | undefined;
  const idle = positiveInt(config.idleThresholdMinutes) ?? DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (input.lastAssistantCompletedAtMs !== undefined && Number.isFinite(input.lastAssistantCompletedAtMs) && (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs > idle * 60_000) trigger = "time_based";
  else if (thresholdTokens !== undefined && estimatedTokenCount >= thresholdTokens) trigger = "token_pressure";
  if (!trigger) return { decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens }, messages };

  const compactable = new Set(config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS);
  const names = new Map<string, string>();
  const groups: { index: number; id: string }[][] = [];
  let current: { index: number; id: string }[] | undefined;
  const flush = (): void => { if (current?.length) groups.push(current); current = undefined; };
  messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls as Row[]) if (typeof call?.id === "string") names.set(call.id, String((call.function as Row | undefined)?.name ?? ""));
      flush(); current = []; return;
    }
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") return;
    const name = names.get(message.tool_call_id);
    if (!name || !compactable.has(name)) return;
    if (config.clearErrorResults !== true && input.isError?.(message.tool_call_id)) return;
    if (contentText(message.content) === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE || hasMedia(message.content)) return;
    if (!current) { groups.push([{ index, id: message.tool_call_id }]); return; }
    current.push({ index, id: message.tool_call_id });
  });
  flush();
  if (!groups.length) return { decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger }, messages };
  const keep = Math.max(1, positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS);
  const clearCount = Math.max(0, groups.length - keep);
  if (!clearCount) return { decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger }, messages };
  const toClear = groups.slice(0, clearCount).flat(), toKeep = groups.slice(clearCount).flat();
  for (const candidate of toClear) messages[candidate.index] = { ...messages[candidate.index]!, content: MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE };
  const post = estimateMessageTokens(messages);
  const saved = Math.max(0, estimatedTokenCount - post);
  if (saved < (positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS)) {
    return { decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger }, messages: input.messages.map((message) => ({ ...message })) };
  }
  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger }, messages,
    payload: { clearedMessageCount: toClear.length, clearedToolCallIds: toClear.map((c) => c.id), keptToolCallIds: toKeep.map((c) => c.id), preMicrocompactTokenCount: estimatedTokenCount, postMicrocompactTokenCount: post, tokensSaved: saved, trigger },
  };
}
