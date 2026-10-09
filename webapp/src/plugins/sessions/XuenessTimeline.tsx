import { t as tr, tf, getLocale } from '../../i18n';
import React from "react";
import { Brain, Check, ChevronDown, Copy, Files, Plug, Search, SquareTerminal } from "lucide-react";
import type { TimelineRow, ToolDisplayStatus } from "../../xuenessWorkbench";
import { SimpleMarkdown, TimelineCard, MarkdownRenderOptionsContext, type MarkdownRenderOptions } from "../../XuenessShell";
import { EmptyState } from "../../ui/primitives";
import { useQuantizedStreamingText } from "../../ui/StreamingCommitGate";
import { IconGear, IconPencil, IconSearch } from "../../ui/icons";
import { XuenessConversationHistoryRail } from "./XuenessConversationHistoryRail";
import { useTimelineVirtualWindow } from "./TimelineVirtualWindow";
import {
  completionPresentation,
  isDuplicateCompletionAnswer,
  shouldHideCompletionCard,
  isRecord,
  protocolAnswerEnvelope,
  decodeJsonStringFragment,
  unwrapProtocolEnvelopeText,
  type CompletionPresentationInput,
} from './completionPresentation';
import { conversationActivityLabel, reasoningIsActive } from "./conversationActivity";
import { formatConversationWorkDuration } from './conversationWorkDuration';
import { TOOL_DISPLAY_STATUS_LABELS, TOOL_DISPLAY_STATUS_TONES, toolDisplayStatusOf } from './toolDisplayStatus';
import "./sessions.css";
import "../../styles/conversation-history-rail.css";

export { STREAM_COMMIT_INTERVAL_MS, StreamingCommitGate, useQuantizedStreamingText } from "../../ui/StreamingCommitGate";

export type TimelineStreamProps = {
  rows: TimelineRow[];
  /** 渲染空态时的文案 */
  emptyText?: string;
  collapseTools?: boolean;
  messageStreamShowReasoning?: boolean;
  grouping?: Partial<Record<ToolGroupKind, boolean>>;
  /** Only enabled for the local runtime configured to stream JSON tool envelopes. */
  jsonToolProtocol?: boolean;
  /** Wait briefly for the session's authoritative tool-calling metadata before showing protocol-looking JSON. */
  protocolModePending?: boolean;
  /** Shows that a turn is active before its first text or reasoning delta arrives. */
  streamingPending?: boolean;
  /** Authoritative runtime phase; absent metadata never implies generation. */
  activityPhase?: string;
  /** 长会话窗口化渲染：只挂载可视区附近的节点（仅顶层时间线启用，工具分组递归不启用）。 */
  virtualize?: boolean;
  /** 窗口初始定位在末尾（自动滚动开启的会话从底部呈现）。 */
  virtualizeFromTail?: boolean;
  /** Group contents already belong to their parent work segment. */
  nested?: boolean;
};

type ToolGroupKind = "explore" | "terminal" | "changes";
type ToolGroupEntry = { kind: "tool-group"; category: ToolGroupKind; rows: TimelineRow[] };
type WorkSummaryEntry = { kind: "work-summary"; key: string; seq: number; tools: number; running: boolean; interrupted: boolean; open: boolean; durationMs?: number };
type TimelineEntry = TimelineRow | ToolGroupEntry | WorkSummaryEntry;
type AssistantRow = Extract<TimelineRow, { kind: "assistant" }>;
type CompletionRow = Extract<TimelineRow, { kind: "completion" }>;

type ConversationIndexes = {
  completionByAssistantSeq: Map<number, CompletionRow>;
  assistantByCompletionSeq: Map<number, AssistantRow>;
};

/** Resolve turn relationships in one pass so long streaming histories stay linear. */
function indexConversationRows(rows: TimelineRow[]): ConversationIndexes {
  const segmentByAssistantSeq = new Map<number, number>();
  const assistantBySegment = new Map<number, AssistantRow>();
  const assistantByTurn = new Map<string, AssistantRow>();
  const completionBySegment = new Map<number, CompletionRow>();
  const completionByTurn = new Map<string, CompletionRow>();
  const assistantByCompletionSeq = new Map<number, AssistantRow>();
  let segment = -1;

  for (const row of rows) {
    if (row.kind === "user") {
      segment += 1;
    } else if (row.kind === "assistant") {
      segmentByAssistantSeq.set(row.seq, segment);
      assistantBySegment.set(segment, row);
      assistantByTurn.set(row.turnId, row);
    } else if (row.kind === "completion") {
      completionBySegment.set(segment, row);
      if (row.turnId) completionByTurn.set(row.turnId, row);
      const answer = row.turnId ? assistantByTurn.get(row.turnId) : undefined;
      const fallback = assistantBySegment.get(segment);
      const selected = answer && answer.seq < row.seq ? answer : fallback && fallback.seq < row.seq ? fallback : undefined;
      if (selected) assistantByCompletionSeq.set(row.seq, selected);
    }
  }

  const completionByAssistantSeq = new Map<number, CompletionRow>();
  for (const row of rows) {
    if (row.kind !== "assistant") continue;
    const segment = segmentByAssistantSeq.get(row.seq);
    const byTurn = completionByTurn.get(row.turnId);
    const bySegment = segment === undefined ? undefined : completionBySegment.get(segment);
    const completion = byTurn && byTurn.seq > row.seq ? byTurn : bySegment && bySegment.seq > row.seq ? bySegment : undefined;
    if (completion) completionByAssistantSeq.set(row.seq, completion);
  }
  return { completionByAssistantSeq, assistantByCompletionSeq };
}

function toolCategory(row: TimelineRow): ToolGroupKind | null {
  if (row.kind !== "tool") return null;
  if (["read", "list", "glob", "grep"].includes(row.name)) return "explore";
  if (["exec", "exec_start", "exec_status", "exec_log", "exec_cancel"].includes(row.name)) return "terminal";
  if (["write", "edit"].includes(row.name)) return "changes";
  return null;
}

/** Group adjacent related calls only; a message or other tool keeps its position. */
export function groupTimelineRows(rows: TimelineRow[], grouping: TimelineStreamProps["grouping"] = {}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let index = 0; index < rows.length;) {
    const category = toolCategory(rows[index]);
    let end = index + 1;
    if (category && grouping[category]) {
      while (end < rows.length && toolCategory(rows[end]) === category) end += 1;
    }
    if (category && end - index > 1) entries.push({ kind: "tool-group", category, rows: rows.slice(index, end) });
    else entries.push(rows[index]);
    index = end;
  }
  return entries;
}

/** Keep the final reply and interaction boundaries outside collapsible work.
 * Flat entries retain the existing virtual window and per-row scroll anchors. */
export function buildConversationWorkEntries(entries: TimelineEntry[], collapsed: ReadonlySet<string>, streamingPending = false, openOverrides?: ReadonlyMap<string, boolean>): {
  entries: TimelineEntry[]; intermediate: Set<number>; summarized: Set<number>;
} {
  const result: TimelineEntry[] = [];
  const intermediate = new Set<number>(), summarized = new Set<number>();
  let work: TimelineEntry[] = [];
  const flush = (running = false, completion?: Extract<TimelineRow, { kind: 'completion' }>) => {
    if (!work.length) return;
    const rows = work.flatMap(entry => entry.kind === 'tool-group' ? entry.rows : entry.kind === 'work-summary' ? [] : [entry]);
    const tools = rows.filter(row => row.kind === 'tool').length;
    if (!tools) { result.push(...work); work = []; return; }
    const assistants = rows.filter((row): row is AssistantRow => row.kind === 'assistant');
    const lastText = assistants.filter(row => row.text.trim()).at(-1);
    const lastToolIndex = rows.findLastIndex(row => row.kind === 'tool');
    // Commentary that proposes a call is not a final reply if that call has no reply yet.
    const final = lastText && rows.indexOf(lastText) > lastToolIndex ? lastText : undefined;
    const firstTool = rows.find((row): row is Extract<TimelineRow, { kind: 'tool' }> => row.kind === 'tool')!;
    // Journal hydration can insert earlier commentary after a call arrives.
    // Keep the user's fold choice bound to the first real call, not row position.
    const key = `work:${firstTool.turnId}:${firstTool.toolCallId}`;
    const started = assistants.map(row => row.startedAt).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const ended = assistants.map(row => row.endedAt).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const durationMs = !running && started.length && ended.length && Math.max(...ended) >= Math.min(...started)
      ? Math.max(...ended) - Math.min(...started) : undefined;
    assistants.forEach(row => {
      summarized.add(row.seq);
      if (row !== final) intermediate.add(row.seq);
    });
    const active = running || assistants.some(row => row.streaming === true);
    const interrupted = assistants.some(row => row.interrupted === true);
    const abnormal = interrupted || rows.some(row => row.kind === 'tool' && ['error', 'cancelled'].includes(toolDisplayStatus(row)))
      || completion?.verified === false || completion?.deliveryStatus === 'failed';
    const defaultOpen = active || abnormal || !completion || !final;
    const open = openOverrides ? openOverrides.get(key) ?? defaultOpen : !collapsed.has(key);
    result.push({ kind: 'work-summary', key, seq: rows[0].seq, tools, running: active, interrupted, open, durationMs });
    result.push(...work.flatMap(entry => open ? [entry] : entry === final && entry.kind === 'assistant'
      ? [{ ...entry, reasoning: undefined }] : []));
    work = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'user' || entry.kind === 'completion' || entry.kind === 'pending_question') {
      flush(false, entry.kind === 'completion' ? entry : undefined); result.push(entry);
    } else work.push(entry);
  }
  flush(streamingPending);
  return { entries: result, intermediate, summarized };
}

function formatToolSubject(name: string, subject: string): string {
  if (!subject) return "";
  if (name === "exec") {
    try {
      if (subject.startsWith("[")) {
        const parsed = JSON.parse(subject);
        if (Array.isArray(parsed)) {
          return parsed.join(" ");
        }
      }
    } catch {
      // Keep raw subject
    }
  }
  return subject;
}

type ToolPayloadRow = Extract<TimelineRow, { kind: "tool" }> & {
  input?: Record<string, unknown>;
  output?: unknown;
};

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

/** 行状态 → 展示状态：显式查表（见 ./toolDisplayStatus），不再用 errorCode 推导。 */
function toolDisplayStatus(row: Extract<TimelineRow, { kind: "tool" }>): ToolDisplayStatus {
  return toolDisplayStatusOf(row.status);
}

function readString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function parseSubjectArguments(subject: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(subject);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringifyPayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const textParts = value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item) && typeof item.text === "string") return [item.text];
      return [];
    });
    if (textParts.length > 0) return textParts.join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output === "string") return value.output;
    if (typeof value.content === "string") return value.content;
    const stdout = readString(value, ["stdout"]);
    const stderr = readString(value, ["stderr"]);
    if (stdout || stderr) return [stdout, stderr].filter(Boolean).join("\n");
    if (value.rawOutput !== undefined) return stringifyPayload(value.rawOutput);
    if (typeof value.result === "string") return value.result;
    if (Array.isArray(value.content)) {
      const contentText = value.content.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (isRecord(item) && typeof item.text === "string") return [item.text];
        return [];
      });
      if (contentText.length > 0) return contentText.join("\n");
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

/**
 * 从工具输入中提取可展示的命令。
 * 移植自 zcode `ToolCallBlocks/renderers/execute.tsx` 的 `getExecuteSecondaryText`：
 * 流式过程中 `input` 会逐步更新（字符串 / 字符串数组 / 对象都可能出现），
 * 这里消费最新值，而不是只读提交时的快照。
 */
function commandFromInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(input)) {
    const parts = input.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
    if (parts.length === 0) return undefined;
    const shellCommandIndex = parts.findIndex((part) => part === "-lc");
    if (shellCommandIndex >= 0 && parts[shellCommandIndex + 1]) return parts[shellCommandIndex + 1];
    return parts.join(" ");
  }
  if (!isRecord(input)) return undefined;
  const direct = readString(input, ["command", "cmd", "script"]);
  if (direct) return direct;
  const parsed = input.parsed_cmd;
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (!Array.isArray(parsed)) return undefined;
  const commandParts: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string" && item.trim()) commandParts.push(item.trim());
    else if (isRecord(item)) {
      const command = readString(item, ["cmd", "command", "script"]);
      if (command) commandParts.push(command);
    }
  }
  return commandParts.length > 0 ? commandParts.join(" && ") : undefined;
}

function formatMcpIdentifier(value: string): string {
  const words = value.trim().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : value;
}

/** Old journal entries persist only mcp__<server>__<tool>; mirror ZCode's
 * mechanical legacy split when the structured display envelope is absent. */
function mcpNameParts(name: string): { server: string; tool: string } | undefined {
  const segments = name.split("__");
  if (segments.length !== 3 || segments[0] !== "mcp" || !segments[1] || !segments[2]) return undefined;
  const encodedServer = segments[1];
  const encodedTool = segments[2];
  const serverTokens = encodedServer.split("_").filter(Boolean);
  const toolTokens = encodedTool.split("_").filter(Boolean);
  let sharedTokenCount = 0;
  for (let count = Math.min(serverTokens.length, toolTokens.length); count > 0; count -= 1) {
    if (serverTokens.slice(-count).join("_").toLocaleLowerCase() === toolTokens.slice(0, count).join("_").toLocaleLowerCase()) {
      sharedTokenCount = count;
      break;
    }
  }
  const server = sharedTokenCount > 0
    ? serverTokens.slice(-sharedTokenCount).join("_")
    : serverTokens[0]?.toLocaleLowerCase() === "plugin"
      ? serverTokens.at(-1)!
      : encodedServer;
  const tool = sharedTokenCount > 0 && sharedTokenCount < toolTokens.length
    ? toolTokens.slice(sharedTokenCount).join("_")
    : encodedTool;
  return { server: formatMcpIdentifier(server), tool: formatMcpIdentifier(tool) };
}

function toolPrimaryText(row: ToolPayloadRow, input: unknown): { text: string; mono: boolean } {
  const name = row.name.toLowerCase();
  if (name === "exec" || name.startsWith("exec_") || name.includes("terminal")) {
    const command = commandFromInput(input);
    if (command) return { text: command, mono: true };
    const record = isRecord(input) ? input : undefined;
    const argv = record?.argv ?? record?.args;
    if (Array.isArray(argv) && argv.every((item) => typeof item === "string")) {
      return { text: argv.join(" "), mono: true };
    }
    return { text: formatToolSubject(row.name, row.subject), mono: true };
  }

  if (["read", "write", "edit"].includes(name)) {
    const path = isRecord(input) ? readString(input, ["file_path", "filePath", "path", "filename", "target"]) : undefined;
    return { text: path ?? formatToolSubject(row.name, row.subject), mono: false };
  }

  if (name === "mcp" || name.startsWith("mcp_") || name.startsWith("mcp__")) {
    const record = isRecord(input) ? input : undefined;
    const server = record ? readString(record, ["server", "server_name", "serverName"]) : undefined;
    const tool = record ? readString(record, ["tool", "tool_name", "toolName"]) : undefined;
    if (server && tool) return { text: `${formatMcpIdentifier(server)} · ${formatMcpIdentifier(tool)}`, mono: false };
    const legacy = mcpNameParts(row.name);
    return { text: legacy ? `${legacy.server} · ${legacy.tool}` : row.name, mono: false };
  }

  return { text: formatToolSubject(row.name, row.subject), mono: true };
}

function ToolKindIcon({ name }: { name: string }): React.JSX.Element {
  const normalized = name.toLowerCase();
  if (normalized === "read" || normalized === "list" || normalized === "grep" || normalized === "glob") {
    return <IconSearch size={16} />;
  }
  if (normalized === "write" || normalized === "edit") return <IconPencil size={16} />;
  if (normalized === "mcp" || normalized.startsWith("mcp_") || normalized.startsWith("mcp__")) {
    return <Plug size={16} />;
  }
  if (normalized === "exec" || normalized.startsWith("exec_") || normalized.includes("terminal")) {
    return <SquareTerminal size={16} />;
  }
  return <IconGear size={16} />;
}

/** Tool payloads larger than this render a preview plus an explicit expand
 * toggle instead of the whole text, so a huge diff or exec log never lands in
 * the DOM uninvited. */
export const TOOL_PAYLOAD_FOLD_THRESHOLD = 1600;
const TOOL_PAYLOAD_FOLD_PREVIEW_CHARS = 1200;

function payloadPreview(text: string): string {
  const slice = text.slice(0, TOOL_PAYLOAD_FOLD_PREVIEW_CHARS);
  const lastLineBreak = slice.lastIndexOf("\n");
  const bounded = lastLineBreak > TOOL_PAYLOAD_FOLD_PREVIEW_CHARS / 2 ? slice.slice(0, lastLineBreak) : slice;
  return bounded.trimEnd();
}

/** Presentational fold/expand view for one large tool payload section. */
export function FoldablePayloadTextView({ text, expanded, onToggle }: {
  text: string;
  expanded: boolean;
  onToggle?: () => void;
}): React.JSX.Element {
  if (expanded) {
    return (
      <>
        <pre className="xn-toolcall__body" data-testid="xn-toolcall-fold-body" data-folded="false">{text}</pre>
        <button type="button" className="xn-toolcall__fold-toggle" aria-expanded="true" data-testid="xn-toolcall-fold-toggle" onClick={onToggle}>
          {tr("收起")}
        </button>
      </>
    );
  }
  return (
    <>
      <pre className="xn-toolcall__body xn-toolcall__body--folded" data-testid="xn-toolcall-fold-body" data-folded="true">{payloadPreview(text)}{"\n…"}</pre>
      <button type="button" className="xn-toolcall__fold-toggle" aria-expanded="false" data-testid="xn-toolcall-fold-toggle" onClick={onToggle}>
        {tf("展开全部（{0} 字符）", [text.length])}
      </button>
    </>
  );
}

function FoldablePayloadText({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  if (text.length <= TOOL_PAYLOAD_FOLD_THRESHOLD) return <pre className="xn-toolcall__body">{text}</pre>;
  return <FoldablePayloadTextView text={text} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />;
}

function RawToolPayload({ input, output }: { input: unknown; output: unknown }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const serialize = (value: unknown) => {
    try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
  };
  return <details className="xn-toolcall__raw" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{tr('原始工具数据')}</summary>
    {open && <div className="xn-toolcall__raw-content">
      {input !== undefined && <section className="xn-toolcall__section"><span className="xn-toolcall__section-label">{tr('输入参数')}</span><FoldablePayloadText text={serialize(input)} /></section>}
      {output !== undefined && <section className="xn-toolcall__section"><span className="xn-toolcall__section-label">{tr('工具结果')}</span><FoldablePayloadText text={serialize(output)} /></section>}
    </div>}
  </details>;
}

/**
 * 按 toolCallId 持久化的工具卡片展开态（移植自 zcode ToolLayout 的 toolLayoutOpenState）。
 * 原生 <details> 的展开态在虚拟列表重挂后会丢失，这里用模块级 Map 记住用户选择。
 */
export const toolCallOpenState = new Map<string, boolean>();

function useToolCallOpenState(toolCallId: string, defaultOpen: boolean): [boolean, (next: boolean) => void] {
  const [open, setOpen] = React.useState(() => toolCallOpenState.get(toolCallId) ?? defaultOpen);
  const setPersistedOpen = React.useCallback((next: boolean) => {
    toolCallOpenState.set(toolCallId, next);
    setOpen(next);
  }, [toolCallId]);
  return [open, setPersistedOpen];
}

/**
 * 流式参数实时摘要：primary 文本随 `row.input` 的流式更新重算，
 * 文本变化时用 key 重挂触发一次轻量 opacity 过渡。
 */
function StreamingPrimaryText({ text, mono }: { text: string; mono: boolean }): React.JSX.Element | null {
  const [pulseKey, setPulseKey] = React.useState(0);
  const prevTextRef = React.useRef(text);
  React.useEffect(() => {
    if (prevTextRef.current !== text) {
      prevTextRef.current = text;
      setPulseKey((key) => key + 1);
    }
  }, [text]);
  if (!text) return null;
  return (
    <span
      key={pulseKey}
      className={`xn-msg__tool-subject xn-toolcall__primary${mono ? " xn-toolcall__primary--mono" : ""} xn-toolcall__primary--pulse`}
      title={text}
      data-testid="xn-toolcall-primary"
    >
      {text}
    </span>
  );
}

/** 失败态一键复制：复制成功后 1500ms 内显示打勾态（移植自 zcode ToolLayout 的 handleCopyFailureTooltip）。 */
const FAILURE_COPY_RESET_MS = 1500;

export async function copyFailureText(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== "function" || !text.trim()) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function FailureCopyTooltip({ text, label }: { text: string; label: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const resetRef = React.useRef<number | null>(null);
  const tooltipId = React.useId();
  React.useEffect(() => () => {
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
  }, []);

  const copyFailure = (event: React.MouseEvent) => {
    // 复制按钮位于 <summary> 内：阻止默认行为，避免触发 details 展开/收起。
    event.preventDefault();
    event.stopPropagation();
    if (!text.trim()) return;
    const markCopied = () => {
      setCopied(true);
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => {
        setCopied(false);
        resetRef.current = null;
      }, FAILURE_COPY_RESET_MS);
    };
    void copyFailureText(navigator.clipboard, text).then((copiedSuccessfully) => {
      if (copiedSuccessfully) markCopied();
    });
  };

  const copyLabel = copied ? tr("已复制") : tr("复制错误信息");
  return (
    <span className="xn-toolcall__failure-tip" data-testid="xn-toolcall-failure-tip">
      <span className="xn-toolcall__status xn-toolcall__status--failure" data-tone="error" tabIndex={0} aria-describedby={tooltipId}>
        {label}
      </span>
      <span id={tooltipId} className="xn-toolcall__failure-tooltip" role="tooltip" data-testid="xn-toolcall-failure-tooltip">
        <span className="xn-toolcall__failure-text">{text}</span>
        <button
          type="button"
          className="xn-toolcall__failure-copy"
          data-testid="xn-toolcall-copy-failure"
          onClick={copyFailure}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </span>
    </span>
  );
}

const ToolTimelineCard = React.memo(function ToolTimelineCard({
  row,
  collapseTools,
}: {
  row: ToolPayloadRow;
  collapseTools: boolean;
}): React.JSX.Element {
  const parsedInput = row.input ?? parseSubjectArguments(row.subject);
  const input = parsedInput ?? {};
  const primary = toolPrimaryText(row, input);
  const inputText = parsedInput ? stringifyPayload(parsedInput) : undefined;
  const outputText = stringifyPayload(row.output);
  const terminal = ['exec', 'exec_start'].includes(row.name.toLowerCase()) ? terminalResultForDisplay(row.output) : null;
  const hasDetails = Boolean(inputText || outputText);
  const status = toolDisplayStatus(row);
  const tone = TOOL_DISPLAY_STATUS_TONES[status];
  const statusLabel = tr(TOOL_DISPLAY_STATUS_LABELS[status]);
  const [detailsOpen, setDetailsOpen] = useToolCallOpenState(row.toolCallId, !collapseTools);
  const toolKind = ["read", "write", "edit", "exec", "mcp"].find((kind) =>
    row.name.toLowerCase() === kind || row.name.toLowerCase().startsWith(`${kind}_`) || row.name.toLowerCase().startsWith(`${kind}__`),
  ) ?? "other";
  // 失败态不再强制展开：错误详情挂在状态词的 Tooltip 上（含一键复制），
  // 卡片保持和成功态一致的展开逻辑。
  const errorText = row.error
    ? `${row.errorCode ? `[${row.errorCode}] ` : ""}${row.error}`
    : row.status === "error" ? tr("工具执行失败") : "";
  const kindLabel = toolKind === "mcp" ? "MCP" : toolKind === 'exec' ? tr('终端') : row.name;

  const statusNode = status === "error" && errorText
    ? <FailureCopyTooltip text={errorText} label={statusLabel} />
    : <span className={`xn-toolcall__status${status === 'ok' ? ' xn-toolcall__status--quiet' : ''}`} data-tone={tone}>{statusLabel}</span>;

  const summaryRow = (
    <>
      <span className="xn-toolcall__kind-icon" aria-hidden="true"><ToolKindIcon name={row.name} /></span>
      <span className="xn-msg__tool-name xn-toolcall__kind">{kindLabel}</span>
      <StreamingPrimaryText text={primary.text} mono={primary.mono} />
      <span className="xn-msg__tool-trailing xn-toolcall__trailing">
        {row.status === "error" && row.errorCode && <span className="xn-card__meta">{tf("错误码: {0}", [row.errorCode])}</span>}
        {statusNode}
        {hasDetails && <span className="xn-toolcall__chevron" aria-hidden="true">›</span>}
      </span>
    </>
  );

  return (
    <div
      className={`xn-toolcall xn-toolcall--${toolKind} xn-msg xn-msg--tool xn-msg--status-${tone}`}
      data-testid={`xn-toolcall-${row.seq}`}
      data-role="tool"
      data-status={status}
      data-tone={tone}
      data-tool-name={row.name}
    >
      {hasDetails ? (
        <details
          className="xn-toolcall__details"
          open={detailsOpen}
          onToggle={(event) => {
            // toggle 事件不可取消：以 DOM 翻转后的实际状态为准并按 toolCallId 持久化，
            // 虚拟列表重挂后保持用户选择的展开态。
            setDetailsOpen(event.currentTarget.open);
          }}
        >
          <summary className="xn-msg__tool-line xn-toolcall__summary">
            {summaryRow}
          </summary>
          <div className={`xn-toolcall__content${terminal ? ' xn-toolcall__content--terminal' : ''}`}>
            {terminal ? <>
              <section className="xn-toolcall__terminal" aria-label={tr('终端输出')}>
                <pre className="xn-toolcall__command">$ {primary.text}</pre>
                {terminal.output && <FoldablePayloadText text={terminal.output} />}
                {terminal.stderr && <section className="xn-toolcall__section xn-toolcall__stderr"><span className="xn-toolcall__section-label">{tr('标准错误')}</span><FoldablePayloadText text={terminal.stderr} /></section>}
                {terminal.exitCode !== undefined && <span className="xn-toolcall__exit-code">{tf('退出码 {0}', [terminal.exitCode])}</span>}
              </section>
              <RawToolPayload input={parsedInput} output={row.output} />
            </> : <>
            {inputText && (
              <section className="xn-toolcall__section">
                <span className="xn-toolcall__section-label">{tr("输入参数")}</span>
                <FoldablePayloadText text={inputText} />
              </section>
            )}
            {outputText && (
              <section className="xn-toolcall__section">
                <span className="xn-toolcall__section-label">{tr("工具结果")}</span>
                <FoldablePayloadText text={outputText} />
              </section>
            )}
            </>}
          </div>
        </details>
      ) : (
        <div className="xn-msg__tool-line xn-toolcall__summary">{summaryRow}</div>
      )}
      {status === "cancelled" && errorText && <div className="xn-toolcall__cancel-note" data-testid="xn-card-body">{errorText}</div>}
    </div>
  );
});

/** Row objects are kept referentially stable across polling ticks by
 * `stabilizeTimelineRows`, so memoizing per-row items lets a streaming tick
 * bail out every unchanged entry instead of recomputing the whole timeline. */
type TimelineWindowIndex = number | undefined;

const SETTLED_MARKDOWN_RENDER_OPTIONS: MarkdownRenderOptions = { codeHighlightTiming: "on-visible", cacheParseResults: true };
const STREAMING_MARKDOWN_RENDER_OPTIONS: MarkdownRenderOptions = { codeHighlightTiming: "after-stream", cacheParseResults: false };

const UserTimelineItem = React.memo(function UserTimelineItem({ row, windowIndex }: {
  row: Extract<TimelineRow, { kind: "user" }>;
  windowIndex: TimelineWindowIndex;
}): React.JSX.Element {
  return (
    <div
      data-testid={`timeline-item-user-${row.seq}`}
      data-role="user"
      data-history-user-seq={row.seq}
      data-window-index={windowIndex}
      className="xn-timeline-item xn-timeline-item--user"
    >
      <TimelineCard role="user" body={row.text} seq={row.seq} />
    </div>
  );
});

/**
 * 每个 assistant 工作段顶部的状态条（移植自 zcode ConversationTurnGroup 的 AssistantHistoryStatus）：
 * 运行中「工作中 X」/ 完成「用时 X」/ 中断「已停止」。
 * 时长只用 row.startedAt/endedAt 计算；缺少权威起始时间时只显示「工作中」，
 * 不把此组件挂载后的可见时长说成实际工作时长。
 */
function AssistantWorkStatusPill({ row }: { row: AssistantRow }): React.JSX.Element | null {
  const streaming = row.streaming === true;
  // 流式期间每秒刷新一次「工作中 X」。
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    if (!streaming || row.startedAt == null) return;
    const timer = window.setInterval(forceTick, 1000);
    return () => window.clearInterval(timer);
  }, [streaming, row.startedAt]);

  let state: "running" | "done" | "stopped" | null = null;
  let durationMs: number | undefined;
  if (row.interrupted) {
    state = "stopped";
  } else if (streaming) {
    state = "running";
    durationMs = row.startedAt != null
      ? Math.max(0, Date.now() - row.startedAt)
      : undefined;
  } else if (row.startedAt != null && row.endedAt != null && row.endedAt >= row.startedAt) {
    state = "done";
    durationMs = row.endedAt - row.startedAt;
  }
  // 终态没有起止时间戳 → 隐藏 pill，不编造「用时 X」。
  if (state === null) return null;

  const durationLabel = formatConversationWorkDuration(durationMs, getLocale());
  const label = state === "stopped"
    ? tr("已停止")
    : state === "running"
      ? durationLabel ? tf("工作中 {0}", [durationLabel]) : tr("工作中")
      : durationLabel ? tf("用时 {0}", [durationLabel]) : tr("已完成");

  return (
    <div
      className="xn-turn-work-status"
      data-testid={`xn-turn-work-status-${row.seq}`}
      data-state={state}
      role="status"
    >
      <span className="xn-turn-work-status__label">{label}</span>
    </div>
  );
}

function ReasoningDisclosure({ row, activityPhase }: { row: AssistantRow; activityPhase?: string }): React.JSX.Element {
  const active = reasoningIsActive(row.streaming, activityPhase, row.text);
  const [open, setOpen] = useToolCallOpenState(`reasoning:${row.turnId}:${row.messageIndex ?? row.seq}`, false);
  const preview = active && !open ? row.reasoning?.trim().split(/\r?\n/u).filter(Boolean).at(-1)?.slice(-180) : undefined;
  return <details className="xn-reasoning" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-active={active || undefined}>
    <summary>
      <Brain size={16} aria-hidden="true" />
      <span className="xn-reasoning__label">{active ? tr("思考中…") : tr("思考过程")}</span>
      {preview && <span className="xn-reasoning__preview" aria-hidden="true">{preview}</span>}
      <ChevronDown size={13} className="xn-reasoning__chevron" aria-hidden="true" />
    </summary>
    <pre className="xn-reasoning__text">{row.reasoning}</pre>
  </details>;
}

const AssistantTimelineItem = React.memo(function AssistantTimelineItem({ row, windowIndex, showReasoning, jsonToolProtocol, protocolModePending, completionSummary, activityPhase, intermediate = false, summarized = false }: {
  row: AssistantRow;
  windowIndex: TimelineWindowIndex;
  showReasoning: boolean;
  jsonToolProtocol: boolean;
  protocolModePending: boolean;
  completionSummary?: string;
  activityPhase?: string;
  intermediate?: boolean;
  summarized?: boolean;
}): React.JSX.Element {
  const sourceText = useQuantizedStreamingText(row.text, Boolean(row.streaming));
  const displayText = assistantTextForDisplay(sourceText, row.streaming, completionSummary, jsonToolProtocol, protocolModePending);
  return (
    <div
      data-testid={`timeline-item-assistant-${row.seq}`}
      data-role="assistant"
      data-window-index={windowIndex}
      className={`xn-timeline-item xn-timeline-item--assistant${intermediate ? ' xn-timeline-item--intermediate' : ''}`}
    >
      {!summarized && <AssistantWorkStatusPill row={row} />}
      <MarkdownRenderOptionsContext.Provider value={row.streaming ? STREAMING_MARKDOWN_RENDER_OPTIONS : SETTLED_MARKDOWN_RENDER_OPTIONS}>
        {showReasoning && row.reasoning && <ReasoningDisclosure row={row} activityPhase={activityPhase} />}
        {displayText.trim()
          ? <TimelineCard role="assistant" body={displayText} markdown seq={row.seq} />
          : row.streaming && !(showReasoning && row.reasoning && reasoningIsActive(row.streaming, activityPhase, row.text)) && <p className="xn-assistant-stream-status" role="status">{tr(conversationActivityLabel(activityPhase))}</p>}
      </MarkdownRenderOptionsContext.Provider>
    </div>
  );
});

const ToolTimelineItem = React.memo(function ToolTimelineItem({ row, windowIndex, collapseTools }: {
  row: Extract<TimelineRow, { kind: "tool" }>;
  windowIndex: TimelineWindowIndex;
  collapseTools: boolean;
}): React.JSX.Element {
  return (
    <div
      data-testid={`timeline-item-tool-${row.seq}`}
      data-role="tool"
      data-tool-status={toolDisplayStatus(row)}
      data-window-index={windowIndex}
      className={`xn-timeline-item xn-timeline-item--tool xn-timeline-item--${toolDisplayStatus(row)}`}
    >
      <ToolTimelineCard row={row} collapseTools={collapseTools} />
    </div>
  );
});

const CompletionTimelineItem = React.memo(function CompletionTimelineItem({ row, assistantText, windowIndex, jsonToolProtocol, protocolModePending }: {
  row: CompletionRow;
  assistantText: string;
  windowIndex: TimelineWindowIndex;
  jsonToolProtocol: boolean;
  protocolModePending: boolean;
}): React.JSX.Element | null {
  const typedCompletion = row as CompletionRow & CompletionPresentationInput;
  const completion = completionPresentation(typedCompletion, jsonToolProtocol);
  const assistantAnswer = assistantTextForDisplay(assistantText, false, typedCompletion.summary, jsonToolProtocol, protocolModePending);
  const duplicateSummary = isDuplicateCompletionAnswer(completion.summary, assistantAnswer, jsonToolProtocol);
  const completionDetails = duplicateSummary ? "" : completion.summary;
  // The assistant row owns an ordinary chat answer. Do not add a generic
  // "completed" card when there is no verification outcome and its summary
  // merely repeats that answer (or is empty).
  if (shouldHideCompletionCard(typedCompletion, assistantAnswer, jsonToolProtocol)) return null;
  return (
    <div
      data-testid={`timeline-item-completion-${row.seq}`}
      data-role="completion"
      data-window-index={windowIndex}
      className="xn-timeline-item xn-timeline-item--completion"
    >
      <MarkdownRenderOptionsContext.Provider value={SETTLED_MARKDOWN_RENDER_OPTIONS}>
        <TimelineCard
          role="completion"
          title={completion.title}
          status={completion.status}
          statusLabel={completion.label}
          body=""
          markdown
          seq={row.seq}
        />
        {completionDetails && <details className="xn-completion-details" open={completion.detailsOpen}>
          <summary>{tr("查看完成详情")}</summary>
          <div className="xn-completion-details__body"><SimpleMarkdown text={completionDetails} /></div>
        </details>}
      </MarkdownRenderOptionsContext.Provider>
    </div>
  );
});

function ToolGroupTimelineItem({ entry, collapseTools, windowIndex }: { entry: ToolGroupEntry; collapseTools: boolean; windowIndex?: number }): React.JSX.Element {
  const [open, setOpen] = useToolCallOpenState(`group:${entry.rows[0].kind === 'tool' ? entry.rows[0].toolCallId : entry.rows[0].seq}`, !collapseTools);
  const label = entry.category === 'explore' ? tr('探索工作区') : entry.category === 'terminal' ? tr('终端操作') : tr('文件修改');
  const errors = entry.rows.filter(row => row.kind === 'tool' && toolDisplayStatus(row) === 'error').length;
  const running = entry.rows.some(row => row.kind === 'tool' && ['running', 'queued'].includes(row.status));
  const latest = entry.rows.at(-1);
  const preview = latest?.kind === 'tool' ? toolPrimaryText(latest, latest.input ?? parseSubjectArguments(latest.subject) ?? {}).text : '';
  const Icon = entry.category === 'terminal' ? SquareTerminal : entry.category === 'explore' ? Search : Files;
  return <details className="xn-tool-group" data-window-index={windowIndex} data-testid={`timeline-tool-group-${entry.rows[0].seq}`}
    open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <Icon size={16} className="xn-tool-group__icon" aria-hidden="true" />
      <span className="xn-tool-group__label">{label}</span>
      <span className="xn-tool-group__count">{entry.rows.length}</span>
      {!open && preview && <span className="xn-tool-group__preview" title={preview}>{preview}</span>}
      {errors > 0 && <strong>{tf('{0} 项失败', [errors])}</strong>}
      {running && <span className="xn-tool-group__running">{tr('执行中')}</span>}
      <ChevronDown size={13} className="xn-tool-group__chevron" aria-hidden="true" />
    </summary>
    <TimelineStream rows={entry.rows} collapseTools={collapseTools} nested />
  </details>;
}

export function TimelineStream({ rows, emptyText = tr("暂无事件"), collapseTools = true, grouping, messageStreamShowReasoning = true, jsonToolProtocol = false, protocolModePending = false, streamingPending = false, activityPhase, virtualize = false, virtualizeFromTail = false, nested = false }: TimelineStreamProps): React.JSX.Element {
  const timelineRootRef = React.useRef<HTMLDivElement>(null);
  const [workOpenOverrides, setWorkOpenOverrides] = React.useState(() => new Map<string, boolean>());
  const conversationIndexes = React.useMemo(() => indexConversationRows(rows ?? []), [rows]);
  const grouped = React.useMemo(() => groupTimelineRows((rows ?? []).filter(row =>
    messageStreamShowReasoning || row.kind !== 'assistant' || row.text.trim() || row.streaming || !row.reasoning), grouping), [rows, grouping, messageStreamShowReasoning]);
  const presentation = React.useMemo(() => nested ? { entries: grouped, intermediate: new Set<number>(), summarized: new Set<number>() }
    : buildConversationWorkEntries(grouped, new Set(), streamingPending, workOpenOverrides), [grouped, workOpenOverrides, streamingPending, nested]);
  const groupedTimeline = presentation.entries;
  const { snapshot: windowState, streamRef, reveal } = useTimelineVirtualWindow({
    count: groupedTimeline.length,
    enabled: virtualize,
    initialTail: virtualizeFromTail,
  });
  const userEntryIndexBySeq = React.useMemo(() => {
    const indexes = new Map<number, number>();
    groupedTimeline.forEach((entry, index) => {
      if (entry.kind === "user") indexes.set(entry.seq, index);
    });
    return indexes;
  }, [groupedTimeline]);
  const requestReveal = React.useCallback((seq: number) => {
    const index = userEntryIndexBySeq.get(seq);
    if (index === undefined) return;
    if (index >= windowState.start && index < windowState.end) return;
    reveal(index);
  }, [reveal, userEntryIndexBySeq, windowState.start, windowState.end]);
  if (!rows || rows.length === 0) {
    if (streamingPending) return <div className="xn-timeline-empty xn-timeline-empty--streaming" data-testid="timeline-stream-loading">
      <p className="xn-assistant-stream-status" role="status">{tr(conversationActivityLabel(activityPhase))}</p>
    </div>;
    return (
      <div data-testid="timeline-stream-empty" className="xn-timeline-empty">
        <EmptyState title={emptyText} />
      </div>
    );
  }

  const windowed = windowState.windowed;
  const rangeStart = windowed ? Math.min(windowState.start, groupedTimeline.length) : 0;
  const rangeEnd = windowed ? Math.min(Math.max(rangeStart + 1, windowState.end), groupedTimeline.length) : groupedTimeline.length;
  const visibleEntries = groupedTimeline.slice(rangeStart, rangeEnd);
  const windowIndexAttribute = (entryIndex: number) => (windowed ? entryIndex : undefined);

  const stream = (
    <div
      ref={streamRef}
      aria-label={tr("时间线卡片流")}
      data-testid="timeline-stream"
      className="xn-timeline-stream"
    >
      {windowed && windowState.topPad > 0 && (
        <div aria-hidden="true" className="xn-timeline-window-spacer" data-testid="timeline-window-top-spacer" style={{ height: windowState.topPad }} />
      )}
      {visibleEntries.map((r, idx) => {
        const entryIndex = rangeStart + idx;
        if (r.kind === 'work-summary') {
          const open = r.open;
          const duration = formatConversationWorkDuration(r.durationMs, getLocale());
          const label = r.interrupted ? tr('已停止') : r.running ? tr('工作中') : duration ? tf('已工作 {0}', [duration]) : tr('工作过程');
          return <div className="xn-conversation-work-summary" key={r.key} data-window-index={windowIndexAttribute(entryIndex)}>
            <button type="button" data-testid={`timeline-work-toggle-${r.seq}`} aria-expanded={open}
              onClick={() => setWorkOpenOverrides(previous => new Map(previous).set(r.key, !open))}>
              <span>{label}</span><ChevronDown size={14} aria-hidden="true" />
            </button>
            <span className="xn-conversation-work-summary__count">{tf('{0} 次工具调用', [r.tools])}</span>
          </div>;
        }
        if (r.kind === "tool-group") {
          return <ToolGroupTimelineItem key={`group-${r.rows[0].seq}`} entry={r} collapseTools={collapseTools} windowIndex={windowIndexAttribute(entryIndex)} />;
        }
        const key = `${r.kind}-${r.seq}-${entryIndex}`;
        const windowIndex = windowIndexAttribute(entryIndex);

        if (r.kind === "user") {
          return <UserTimelineItem key={key} row={r} windowIndex={windowIndex} />;
        }

        if (r.kind === "assistant") {
          return (
            <AssistantTimelineItem
              key={key}
              row={r}
              windowIndex={windowIndex}
              showReasoning={messageStreamShowReasoning}
              activityPhase={activityPhase}
              intermediate={presentation.intermediate.has(r.seq)}
              summarized={presentation.summarized.has(r.seq)}
              jsonToolProtocol={jsonToolProtocol}
              protocolModePending={protocolModePending}
              completionSummary={conversationIndexes.completionByAssistantSeq.get(r.seq)?.summary}
            />
          );
        }

        if (r.kind === "tool") {
          return <ToolTimelineItem key={key} row={r} windowIndex={windowIndex} collapseTools={collapseTools} />;
        }

        if (r.kind === "completion") {
          return (
            <CompletionTimelineItem
              key={key}
              row={r}
              assistantText={conversationIndexes.assistantByCompletionSeq.get(r.seq)?.text ?? ""}
              windowIndex={windowIndex}
              jsonToolProtocol={jsonToolProtocol}
              protocolModePending={protocolModePending}
            />
          );
        }

        if (r.kind === "pending_question") {
          return (
            <div
              key={key}
              data-testid={`timeline-item-question-${r.seq}`}
              data-role="pending_question"
              data-window-index={windowIndexAttribute(entryIndex)}
              className="xn-timeline-item xn-timeline-item--question"
            >
              <TimelineCard
                role="question"
                title={tr("等待回答")}
                status="pending"
                body={r.question}
                seq={r.seq}
              />
            </div>
          );
        }

        return null;
      })}
      {windowed && windowState.bottomPad > 0 && (
        <div aria-hidden="true" className="xn-timeline-window-spacer" data-testid="timeline-window-bottom-spacer" style={{ height: windowState.bottomPad }} />
      )}
      {streamingPending && !rows.some(row => row.kind === "assistant" && row.streaming) && <div className="xn-timeline-item xn-timeline-item--assistant xn-assistant-stream-pending" data-testid="timeline-stream-loading">
        <p className="xn-assistant-stream-status" role="status">{tr(conversationActivityLabel(activityPhase))}</p>
      </div>}
    </div>
  );

  if (!rows.some((row) => row.kind === "user")) return stream;

  return (
    <div className="xn-timeline-history-layout" data-testid="timeline-history-layout">
      <XuenessConversationHistoryRail rows={rows} timelineRootRef={timelineRootRef} requestReveal={requestReveal} />
      <div ref={timelineRootRef} className="xn-timeline-history-layout__content">
        {stream}
      </div>
    </div>
  );
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
