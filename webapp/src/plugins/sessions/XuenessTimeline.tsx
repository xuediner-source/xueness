import { t as tr } from '../../i18n';
import React from "react";
import { useQuantizedStreamingText } from "../../ui/StreamingCommitGate";
import { isRecord, protocolAnswerEnvelope, decodeJsonStringFragment, unwrapProtocolEnvelopeText } from './completionPresentation';


import "./sessions.css";


import "../../styles/conversation-history-rail.css";



export { STREAM_COMMIT_INTERVAL_MS, StreamingCommitGate, useQuantizedStreamingText } from "../../ui/StreamingCommitGate";



function isProtocolToolEnvelope(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.tool === "string" && isRecord(value.arguments);
}



function protocolJsonBody(text: string): { body?: string; knownFence: boolean } {
  const source = text.trimStart();
  if (!source.startsWith("```json")) return { body: source, knownFence: false };
  if (source.length === 7) return { knownFence: true };
  const rest = source.slice(7);
  if (!rest.startsWith("\n") && !rest.startsWith("\r\n")) return { body: source, knownFence: false };
  const body = rest.replace(/^\r?\n/u, "");
  return { body: body.replace(/\r?\n```\s*$/u, "").trimEnd(), knownFence: true };
}



function isKnownAnswerEnvelopePrefix(text: string): boolean {
  const normalized = protocolJsonBody(text);
  if (normalized.knownFence && normalized.body === undefined) return true;
  const source = normalized.body ?? "";
  if (!source.startsWith("{")) return false;
  let index = 1;
  while (/\s/u.test(source[index] ?? " ") && index < source.length) index += 1;
  if (index >= source.length) return true;
  if (source[index] !== '"') return false;
  index += 1;
  let key = "";
  while (index < source.length && source[index] !== '"') {
    if (source[index] === "\\") return false;
    key += source[index]!;
    index += 1;
    if (!("summary".startsWith(key) || "answer".startsWith(key) || "tool".startsWith(key))) return false;
  }
  if (index >= source.length) return "summary".startsWith(key) || "answer".startsWith(key) || "tool".startsWith(key);
  if (key !== "summary" && key !== "answer" && key !== "tool") return false;
  index += 1;
  while (/\s/u.test(source[index] ?? " ") && index < source.length) index += 1;
  if (index >= source.length) return true;
  if (source[index] !== ":") return false;
  if (key === "tool") return true;
  index += 1;
  while (/\s/u.test(source[index] ?? " ") && index < source.length) index += 1;
  return index >= source.length || source[index] === '"';
}



/** Decode the visible prefix of a JSON string without leaking its syntax. */
function extractProtocolAnswerPrefix(text: string): string | undefined {
  const source = protocolJsonBody(text).body ?? "";
  const prefix = /^\{\s*"(?:summary|answer)"\s*:\s*"/u.exec(source);
  if (!prefix) return undefined;
  const content = source.slice(prefix[0].length);
  let end = 0;
  let inEscape = false;
  while (end < content.length) {
    if (inEscape) {
      inEscape = false;
      end += 1;
    } else if (content[end] === "\\") {
      inEscape = true;
      end += 1;
    } else if (content[end] === '"') {
      break;
    } else {
      end += 1;
    }
  }
  return decodeJsonStringFragment(content.slice(0, end));
}



function comparableText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}



/** Keep ordinary JSON intact; unwrap only a server-confirmed or live protocol answer envelope. */
export function assistantTextForDisplay(text: string, streaming = false, completionSummary?: string, jsonToolProtocol = false, protocolModePending = false): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (streaming && protocolModePending && isKnownAnswerEnvelopePrefix(text)) return "";
  try {
    const protocolText = protocolJsonBody(trimmed).body ?? trimmed;
    const parsed: unknown = JSON.parse(protocolText);
    const envelope = protocolAnswerEnvelope(parsed);
    const matchesSummary = completionSummary !== undefined && Boolean(
      envelope?.answer && comparableText(envelope.answer) === comparableText(completionSummary)
    );
    if (envelope && (jsonToolProtocol || matchesSummary || (streaming && jsonToolProtocol))) return envelope.answer;
    if ((streaming || jsonToolProtocol) && isProtocolToolEnvelope(parsed)) return "";
    // A complete, valid but differently shaped JSON value is user content.
    // Only incomplete recognized prefixes are held back while the stream grows.
    if (streaming && jsonToolProtocol) return text;
  } catch {
    // A live JSON protocol response can be incomplete; the prefix parser below
    // extracts only its user-facing answer field.
  }
  if (streaming && jsonToolProtocol) {
    const answer = extractProtocolAnswerPrefix(text);
    if (answer !== undefined) return answer;
    if (isKnownAnswerEnvelopePrefix(text)) return "";
  }
  if (!streaming && jsonToolProtocol) {
    const unwrapped = unwrapProtocolEnvelopeText(text, true);
    if (unwrapped !== text) return unwrapped;
  }
  return text;
}



/** Only recognized text results become a terminal transcript. Unknown result
 * objects keep the generic view instead of being presented as process output. */
export function terminalResultForDisplay(value: unknown, depth = 0): { output: string; stderr?: string; exitCode?: number } | null {
  if (typeof value === 'string') return { output: value };
  if (!isRecord(value) || depth > 3) return null;
  const code = value.exit_code ?? value.exitCode;
  const exitCode = typeof code === 'number' && Number.isInteger(code) ? code : undefined;
  if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
    return { output: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : undefined, exitCode };
  }
  for (const key of ['output', 'text', 'content', 'result']) {
    if (typeof value[key] === 'string') return { output: value[key], exitCode };
  }
  if (Array.isArray(value.content) && value.content.length && value.content.every(item =>
    typeof item === 'string' || (isRecord(item) && typeof item.text === 'string' && (item.type === undefined || item.type === 'text')))) {
    return { output: value.content.map(item => typeof item === 'string' ? item : item.text).join('\n'), exitCode };
  }
  if (value.rawOutput !== undefined) {
    const nested = terminalResultForDisplay(value.rawOutput, depth + 1);
    return nested ? { ...nested, exitCode: exitCode ?? nested.exitCode } : null;
  }
  return null;
}



export function TaskTodos({ todos }: { todos: unknown[] }): React.JSX.Element | null {
  const items = todos.filter((item): item is { id: string; text: string; status: string } =>
    Boolean(item && typeof item === "object" && "id" in item && "text" in item && "status" in item
      && typeof item.id === "string" && typeof item.text === "string" && typeof item.status === "string"));
  if (!items.length) return null;
  return <section className="xn-task-todos" aria-label={tr("任务待办")}><h3>{tr("任务待办")} <span>{items.filter(item => item.status === "done").length}/{items.length}</span></h3>
    <ul>{items.map(item => <li key={item.id} data-status={item.status}><span aria-hidden="true">{item.status === "done" ? "✓" : item.status === "in_progress" ? "◉" : "○"}</span><span>{item.text}</span></li>)}</ul>
  </section>;
}
