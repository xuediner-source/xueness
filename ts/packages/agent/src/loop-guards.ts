/**
 * ZCode-aligned turn-loop guards, adapted from ZCode v3.15.1 core runtime
 * (`runtime/helpers/model-anomaly.ts`, `runtime/methods/turn-output-token-continuation.ts`;
 * Apache-2.0, Copyright 2026 Z.AI Co., Ltd.). Neither guard ends a turn by itself:
 * repeated identical tool calls only add a reminder, and an output-token cut
 * resumes with a turn-local prompt at most three times.
 */
import { argumentsObject } from "@xueness/providers";
import type { Row } from "./types.ts";

export const OUTPUT_TOKEN_CONTINUE_PROMPT = "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
export const MAX_OUTPUT_TOKEN_CONTINUATIONS = 3;
const OUTPUT_LIMIT_RAW_REASONS = new Set(["max_tokens", "max_output_tokens", "model_context_window_exceeded"]);
const REPEATED_TOOL_CALL_THRESHOLD = 3;
const MAX_ANOMALY_WARNINGS_PER_TURN = 3;

/** A successful response cut by the output budget (normalized `length` or a raw provider limit reason). */
export function isOutputTokenLimit(finish: string | null, raw: unknown): boolean {
  return finish === "length" || typeof raw === "string" && OUTPUT_LIMIT_RAW_REASONS.has(raw);
}

/** Inserts the turn-local continuation prompt after each recorded partial; prompts are never persisted. */
export function withContinuationPrompts(messages: Row[], anchors: ReadonlySet<string>): Row[] {
  if (!anchors.size) return messages;
  let inserted = false;
  const result = messages.flatMap((message) => {
    if (typeof message._message_id !== "string" || !anchors.has(message._message_id)) return [message];
    inserted = true; return [message, { role: "user", content: OUTPUT_TOKEN_CONTINUE_PROMPT }];
  });
  return inserted ? result : [...messages, { role: "user", content: OUTPUT_TOKEN_CONTINUE_PROMPT }];
}

export interface RepeatedCallState { signature?: string; streak: number; warnings: number }

/** Per-call streak of identical name+input; the third repeat yields a reminder, at most three per turn. */
export function repeatedToolCallReminders(calls: Row[], state: RepeatedCallState): string[] {
  const reminders: string[] = [];
  for (const call of calls) {
    const fn = (call.function ?? {}) as Row;
    const name = String(fn.name ?? "");
    let input: unknown;
    try { input = argumentsObject(fn.arguments); } catch { input = fn.arguments ?? null; }
    const signature = `${JSON.stringify(name)}:${stableJson(input)}`;
    if (state.signature === signature) state.streak += 1; else { state.signature = signature; state.streak = 1; }
    if (state.streak !== REPEATED_TOOL_CALL_THRESHOLD || state.warnings >= MAX_ANOMALY_WARNINGS_PER_TURN) continue;
    state.warnings += 1;
    reminders.push([
      `You have called ${name} with the same input ${state.streak} times in a row.`,
      "Do not repeat the exact same tool call again unless the user explicitly asked you to retry it unchanged.",
      "Use the existing result to take a different next step, explain the blocker, or ask the user for guidance.",
    ].join("\n"));
  }
  return reminders;
}

/** Identity of the latest human message; a new one (including steering) resets the repeat streak. */
export function lastUserMessageId(messages: Row[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user" && messages[index]!._input_kind !== "background_notice") return messages[index]!._message_id ?? index;
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Row;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
