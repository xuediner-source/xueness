import { t as tr, tf } from '../../i18n';
import React from "react";
import { Plug, SquareTerminal } from "lucide-react";
import type { TimelineRow } from "../../xuenessWorkbench";
import { TimelineCard } from "../../XuenessShell";
import { EmptyState } from "../../ui/primitives";
import { IconGear, IconPencil, IconSearch } from "../../ui/icons";
import { XuenessConversationHistoryRail } from "./XuenessConversationHistoryRail";
import { completionPresentation } from './completionPresentation';
import "../../styles/conversation-history-rail.css";

export type TimelineStreamProps = {
  rows: TimelineRow[];
  /** 渲染空态时的文案 */
  emptyText?: string;
  collapseTools?: boolean;
  messageStreamShowReasoning?: boolean;
  grouping?: Partial<Record<ToolGroupKind, boolean>>;
};

type ToolGroupKind = "explore" | "terminal" | "changes";
type TimelineEntry = TimelineRow | { kind: "tool-group"; category: ToolGroupKind; rows: TimelineRow[] };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function ToolTimelineCard({
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
  const tone = row.status === "error" ? "error" : row.status === "ok" ? "ok" : "warn";
  const statusLabel = row.status === "running" ? tr("运行中") : row.status === "error" ? tr("失败") : "";
  const toolKind = ["read", "write", "edit", "exec", "mcp"].find((kind) =>
    row.name.toLowerCase() === kind || row.name.toLowerCase().startsWith(`${kind}_`) || row.name.toLowerCase().startsWith(`${kind}__`),
  ) ?? "other";
  const errorText = row.error
    ? `${row.errorCode ? `[${row.errorCode}] ` : ""}${row.error}`
    : row.status === "error" ? tr("工具执行失败") : "";
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
      data-status={row.status}
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
      {errorText && <div className="xn-msg__tool-error" data-testid="xn-card-body">{errorText}</div>}
    </div>
  );
}

export function TimelineStream({ rows, emptyText = tr("暂无事件"), collapseTools = true, grouping, messageStreamShowReasoning = true }: TimelineStreamProps): React.JSX.Element {
  const timelineRootRef = React.useRef<HTMLDivElement>(null);
  if (!rows || rows.length === 0) {
    return (
      <div data-testid="timeline-stream-empty" className="xn-timeline-empty">
        <EmptyState title={emptyText} />
      </div>
    );
  }

  const stream = (
    <div
      aria-label={tr("时间线卡片流")}
      data-testid="timeline-stream"
      className="xn-timeline-stream"
    >
      {groupTimelineRows(rows, grouping).map((r, idx) => {
        if (r.kind === "tool-group") {
          const label = r.category === "explore" ? tr("探索工作区") : r.category === "terminal" ? tr("终端操作") : tr("文件修改");
          const errors = r.rows.filter(row => row.kind === "tool" && row.status === "error").length;
          return <details className="xn-tool-group" key={`group-${r.rows[0].seq}-${idx}`} open>
            <summary>{label}<span>{r.rows.length}</span>{errors > 0 && <strong>{tf("{0} 项失败", [errors])}</strong>}</summary>
            <TimelineStream rows={r.rows} collapseTools={collapseTools} />
          </details>;
        }
        const key = `${r.kind}-${r.seq}-${idx}`;

        if (r.kind === "user") {
          return (
            <div
              key={key}
              data-testid={`timeline-item-user-${r.seq}`}
              data-role="user"
              data-history-user-seq={r.seq}
              className="xn-timeline-item xn-timeline-item--user"
            >
              <TimelineCard role="user" body={r.text} seq={r.seq} />
            </div>
          );
        }

        if (r.kind === "assistant") {
          return (
            <div
              key={key}
              data-testid={`timeline-item-assistant-${r.seq}`}
              data-role="assistant"
              className="xn-timeline-item xn-timeline-item--assistant"
            >
              {messageStreamShowReasoning && r.reasoning && <details className="xn-reasoning"><summary>{r.streaming ? tr("思考中…") : tr("思考过程")}</summary><div>{r.reasoning}</div></details>}
              <TimelineCard role="assistant" body={r.text} markdown seq={r.seq} />
            </div>
          );
        }

        if (r.kind === "tool") {
          return (
            <div
              key={key}
              data-testid={`timeline-item-tool-${r.seq}`}
              data-role="tool"
              data-tool-status={r.status}
              className={`xn-timeline-item xn-timeline-item--tool xn-timeline-item--${r.status}`}
            >
              <ToolTimelineCard row={r as ToolPayloadRow} collapseTools={collapseTools} />
            </div>
          );
        }

        if (r.kind === "completion") {
          const completion = completionPresentation(r);
          return (
            <div
              key={key}
              data-testid={`timeline-item-completion-${r.seq}`}
              data-role="completion"
              className="xn-timeline-item xn-timeline-item--completion"
            >
              <TimelineCard
                role="completion"
                title={completion.title}
                status={completion.status}
                statusLabel={completion.label}
                body={completion.summary}
                markdown
                seq={r.seq}
              />
            </div>
          );
        }

        if (r.kind === "pending_question") {
          return (
            <div
              key={key}
              data-testid={`timeline-item-question-${r.seq}`}
              data-role="pending_question"
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
    </div>
  );

  if (!rows.some((row) => row.kind === "user")) return stream;

  return (
    <div className="xn-timeline-history-layout" data-testid="timeline-history-layout">
      <XuenessConversationHistoryRail rows={rows} timelineRootRef={timelineRootRef} />
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
