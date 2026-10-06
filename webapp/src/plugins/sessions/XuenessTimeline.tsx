import { t as tr, tf } from '../../i18n';
import React from "react";
import { Plug, SquareTerminal } from "lucide-react";
import type { TimelineRow } from "../../xuenessWorkbench";
import { SimpleMarkdown, TimelineCard } from "../../XuenessShell";
import { EmptyState } from "../../ui/primitives";
import { IconGear, IconPencil, IconSearch } from "../../ui/icons";
import { XuenessConversationHistoryRail } from "./XuenessConversationHistoryRail";
import { useTimelineVirtualWindow } from "./TimelineVirtualWindow";
import {
  completionPresentation,
  isDuplicateCompletionAnswer,
  isRecord,
  protocolAnswerEnvelope,
  decodeJsonStringFragment,
  unwrapProtocolEnvelopeText,
  type CompletionPresentationInput,
} from './completionPresentation';
import "./sessions.css";
import "../../styles/conversation-history-rail.css";

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
  /** 长会话窗口化渲染：只挂载可视区附近的节点（仅顶层时间线启用，工具分组递归不启用）。 */
  virtualize?: boolean;
  /** 窗口初始定位在末尾（自动滚动开启的会话从底部呈现）。 */
  virtualizeFromTail?: boolean;
};

type ToolGroupKind = "explore" | "terminal" | "changes";
type TimelineEntry = TimelineRow | { kind: "tool-group"; category: ToolGroupKind; rows: TimelineRow[] };
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

type ToolDisplayStatus = "running" | "ok" | "error" | "cancelled";

function toolDisplayStatus(row: Extract<TimelineRow, { kind: "tool" }>): ToolDisplayStatus {
  return row.status === "error" && row.errorCode === "xueness.error.cancelled" ? "cancelled" : row.status;
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

function commandFromInput(input: Record<string, unknown>): string | undefined {
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

function toolPrimaryText(row: ToolPayloadRow, input: Record<string, unknown>): { text: string; mono: boolean } {
  const name = row.name.toLowerCase();
  if (name === "exec" || name.startsWith("exec_") || name.includes("terminal")) {
    const command = commandFromInput(input);
    if (command) return { text: command, mono: true };
    const argv = input.argv ?? input.args;
    if (Array.isArray(argv) && argv.every((item) => typeof item === "string")) {
      return { text: argv.join(" "), mono: true };
    }
    return { text: formatToolSubject(row.name, row.subject), mono: true };
  }

  if (["read", "write", "edit"].includes(name)) {
    const path = readString(input, ["file_path", "filePath", "path", "filename", "target"]);
    return { text: path ?? formatToolSubject(row.name, row.subject), mono: false };
  }

  if (name === "mcp" || name.startsWith("mcp_") || name.startsWith("mcp__")) {
    const server = readString(input, ["server", "server_name", "serverName"]);
    const tool = readString(input, ["tool", "tool_name", "toolName"]);
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
  const hasDetails = Boolean(inputText || outputText);
  const status = toolDisplayStatus(row);
  const tone = status === "error" ? "error" : status === "ok" ? "ok" : status === "cancelled" ? "neutral" : "warn";
  const statusLabel = status === "running" ? tr("运行中") : status === "error" ? tr("失败") : status === "cancelled" ? tr("已取消") : tr("已完成");
  const toolKind = ["read", "write", "edit", "exec", "mcp"].find((kind) =>
    row.name.toLowerCase() === kind || row.name.toLowerCase().startsWith(`${kind}_`) || row.name.toLowerCase().startsWith(`${kind}__`),
  ) ?? "other";
  const errorText = row.error
    ? `${row.errorCode ? `[${row.errorCode}] ` : ""}${row.error}`
    : row.status === "error" && status !== "cancelled" ? tr("工具执行失败") : "";
  const kindLabel = toolKind === "mcp" ? "MCP" : row.name;

  const summaryRow = (
    <>
      <span className="xn-toolcall__kind-icon" aria-hidden="true"><ToolKindIcon name={row.name} /></span>
      <span className="xn-msg__tool-name xn-toolcall__kind">{kindLabel}</span>
      {primary.text && <span className={`xn-msg__tool-subject xn-toolcall__primary${primary.mono ? " xn-toolcall__primary--mono" : ""}`} title={primary.text}>{primary.text}</span>}
      <span className="xn-msg__tool-trailing xn-toolcall__trailing">
        {row.status === "error" && row.errorCode && <span className="xn-card__meta">{tf("错误码: {0}", [row.errorCode])}</span>}
        {statusLabel && <span className="xn-toolcall__status" data-tone={tone}>{statusLabel}</span>}
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
        <details className="xn-toolcall__details" open={!collapseTools}>
          <summary className="xn-msg__tool-line xn-toolcall__summary" aria-label={tr("展开工具详情")}>
            {summaryRow}
          </summary>
          <div className="xn-toolcall__content">
            {inputText && (
              <section className="xn-toolcall__section">
                <span className="xn-toolcall__section-label">{tr("输入参数")}</span>
                <pre className="xn-toolcall__body">{inputText}</pre>
              </section>
            )}
            {outputText && (
              <section className="xn-toolcall__section">
                <span className="xn-toolcall__section-label">{tr("工具结果")}</span>
                <pre className="xn-toolcall__body">{outputText}</pre>
              </section>
            )}
          </div>
        </details>
      ) : (
        <div className="xn-msg__tool-line xn-toolcall__summary">{summaryRow}</div>
      )}
      {errorText && <div className={status === "cancelled" ? "xn-toolcall__cancel-note" : "xn-msg__tool-error"} data-testid="xn-card-body">{errorText}</div>}
    </div>
  );
});

/** Row objects are kept referentially stable across polling ticks by
 * `stabilizeTimelineRows`, so memoizing per-row items lets a streaming tick
 * bail out every unchanged entry instead of recomputing the whole timeline. */
type TimelineWindowIndex = number | undefined;

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

const AssistantTimelineItem = React.memo(function AssistantTimelineItem({ row, windowIndex, showReasoning, jsonToolProtocol, protocolModePending, completionSummary }: {
  row: AssistantRow;
  windowIndex: TimelineWindowIndex;
  showReasoning: boolean;
  jsonToolProtocol: boolean;
  protocolModePending: boolean;
  completionSummary?: string;
}): React.JSX.Element {
  const displayText = assistantTextForDisplay(row.text, row.streaming, completionSummary, jsonToolProtocol, protocolModePending);
  return (
    <div
      data-testid={`timeline-item-assistant-${row.seq}`}
      data-role="assistant"
      data-window-index={windowIndex}
      className="xn-timeline-item xn-timeline-item--assistant"
    >
      {showReasoning && row.reasoning && <details className="xn-reasoning"><summary>{row.streaming ? tr("思考中…") : tr("思考过程")}</summary><pre className="xn-reasoning__text">{row.reasoning}</pre></details>}
      {displayText.trim()
        ? <TimelineCard role="assistant" body={displayText} markdown seq={row.seq} />
        : row.streaming && <p className="xn-assistant-stream-status" role="status">{tr("正在生成回复…")}</p>}
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
}): React.JSX.Element {
  const typedCompletion = row as CompletionRow & CompletionPresentationInput;
  const completion = completionPresentation(typedCompletion, jsonToolProtocol);
  const assistantAnswer = assistantTextForDisplay(assistantText, false, typedCompletion.summary, jsonToolProtocol, protocolModePending);
  const duplicateSummary = isDuplicateCompletionAnswer(completion.summary, assistantAnswer, jsonToolProtocol);
  const completionDetails = duplicateSummary ? "" : completion.summary;
  return (
    <div
      data-testid={`timeline-item-completion-${row.seq}`}
      data-role="completion"
      data-window-index={windowIndex}
      className="xn-timeline-item xn-timeline-item--completion"
    >
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
    </div>
  );
});

export function TimelineStream({ rows, emptyText = tr("暂无事件"), collapseTools = true, grouping, messageStreamShowReasoning = true, jsonToolProtocol = false, protocolModePending = false, streamingPending = false, virtualize = false, virtualizeFromTail = false }: TimelineStreamProps): React.JSX.Element {
  const timelineRootRef = React.useRef<HTMLDivElement>(null);
  const conversationIndexes = React.useMemo(() => indexConversationRows(rows ?? []), [rows]);
  const groupedTimeline = React.useMemo(() => groupTimelineRows(rows ?? [], grouping), [rows, grouping]);
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
      <p className="xn-assistant-stream-status" role="status">{tr("正在生成回复…")}</p>
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
        if (r.kind === "tool-group") {
          const label = r.category === "explore" ? tr("探索工作区") : r.category === "terminal" ? tr("终端操作") : tr("文件修改");
          const errors = r.rows.filter(row => row.kind === "tool" && toolDisplayStatus(row) === "error").length;
          return <details className="xn-tool-group" key={`group-${r.rows[0].seq}-${entryIndex}`} data-window-index={windowIndexAttribute(entryIndex)} open={!collapseTools}>
            <summary>{label}<span>{r.rows.length}</span>{errors > 0 && <strong>{tf("{0} 项失败", [errors])}</strong>}</summary>
            <TimelineStream rows={r.rows} collapseTools={collapseTools} />
          </details>;
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
        <p className="xn-assistant-stream-status" role="status">{tr("正在生成回复…")}</p>
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
