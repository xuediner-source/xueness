import { conversationTurnPropsEqual } from './conversationTurnPropsEqual';
import type { AttachmentPreviewTransport } from './composerAttachmentPreviewModel';
import type { MessageEditAttachmentTransport } from './messageEditAttachments';
import { ConversationMarkers } from './conversationMarkers';
/**
 * Adapted from Z.AI ZCode v3.14.3, commit 29628c9 (Apache-2.0):
 * ConversationTurnGroup, ConversationRowView, ToolSummaryRow and Reasoning.
 * Modified for Xueness: native disclosure controls, journal row adapter,
 * plugin-scoped callbacks and its existing safe Markdown renderer.
 * See NOTICE.md and docs/zcode-conversation-parity.md for provenance.
 */
import React from 'react';
import { Brain, Check, ChevronRight, Copy, FileText, TrendingUpDown, Pencil, Search, SquareTerminal, ThumbsUp, ThumbsDown, TriangleAlert } from 'lucide-react';
import { t as tr, tf, getLocale, useLocale } from '../../i18n';
import type { TimelineRow } from '../../xuenessWorkbench';
import { SimpleMarkdown, MarkdownRenderOptionsContext, type MarkdownRenderOptions } from '../../XuenessShell';
import { useStreamingReveal } from '../../ui/StreamingCommitGate';
import { assistantTextForDisplay, terminalResultForDisplay } from './XuenessTimeline';
import type { ConversationCompactionMarker } from './conversationCompaction';
import { completionPresentation, isDuplicateCompletionAnswer, shouldHideCompletionCard } from './completionPresentation';
import { conversationActivityLabel, reasoningIsActive } from './conversationActivity';
import { CompactionBoundary, ContextCompactionStatus } from './ContextCompactionStatus';
import { conversationWorkSegments, conversationActiveDuration, conversationWorkLabel } from './conversationWorkSegments';
import { formatConversationWorkDuration, conversationElapsedInterval } from './conversationWorkDuration';
import { useTimelineVirtualWindow } from './TimelineVirtualWindow';
import { XuenessConversationHistoryRail } from './XuenessConversationHistoryRail';
import { isImeComposingEvent, isModKeyPressed } from '../../xuenessShortcutDisplay';
import './zcode-conversation.css';
import './sessions.css';
import { formatCommandArgv } from '../../xuenessWorkbench';
import { parseDiffPreview, extractToolDiff } from './diffPreview';
import { setPersistedDisclosure } from './disclosureState';
import {
  applyConversationFindHighlights,
  buildConversationFindMatches,
  ConversationFindBar,
  conversationFindRowKey,
} from './ConversationFind';
import { ReferenceRowView } from './referenceRowView';
import { isReferenceTimelineRow } from './referenceRows';
import { SubagentRowView } from './SubagentRowView';
import { resolveToolRenderer, ToolStatusShell, type ToolRendererId } from './toolRenderers';
import { NativeToolCallCard } from './NativeToolCallCard';
import { nativeToolPayload } from './nativeToolPayload';
import { toolActivityRows } from './toolActivity';
import { TOOL_DISPLAY_STATUS_LABELS } from './toolDisplayStatus';

export function evaluateUserMessageEditKey(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    keyCode?: number;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  options: { saving?: boolean; platform?: string } = {},
): 'save' | 'cancel' | null {
  if (isImeComposingEvent(event)) return null;
  if (event.key === 'Escape' && !options.saving) return 'cancel';
  if (event.key === 'Enter' && !event.altKey && !event.shiftKey && isModKeyPressed(event, options.platform)) return 'save';
  return null;
}

type Assistant = Extract<TimelineRow, { kind: 'assistant' }>;
type Tool = Extract<TimelineRow, { kind: 'tool' }>;
type Completion = Extract<TimelineRow, { kind: 'completion' }>;
type User = Extract<TimelineRow, { kind: 'user' }>;
const streamingMarkdown: MarkdownRenderOptions = { codeHighlightTiming: 'after-stream', cacheParseResults: false };
const settledMarkdown: MarkdownRenderOptions = { codeHighlightTiming: 'on-visible', cacheParseResults: true };
export const zcodeConversationDisclosures = new Map<string, boolean>();
const DisclosureContext = React.createContext<Map<string, boolean> | null>(null);
const SessionIdContext = React.createContext<string | undefined>(undefined);
const DISCLOSURE_STORAGE_KEY = 'xueness.sessions.tool-disclosures.v1';
const DISCLOSURE_STORAGE_LIMIT = 500;

function readStoredDisclosure(key: string): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(DISCLOSURE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistDisclosure(key: string, value: boolean): void {
  try {
    const raw = window.localStorage.getItem(DISCLOSURE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const state: Record<string, boolean> = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, candidate]) => typeof candidate === 'boolean')) as Record<string, boolean>
      : {};
    delete state[key];
    state[key] = value;
    const keys = Object.keys(state);
    while (keys.length > DISCLOSURE_STORAGE_LIMIT) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete state[oldest];
    }
    window.localStorage.setItem(DISCLOSURE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing and storage quota failures leave the in-memory state
    // authoritative; disclosure persistence is an enhancement only.
  }
}

function useDisclosure(key: string, defaultOpen = false) {
  const sessionId = React.useContext(SessionIdContext);
  const fullKey = sessionId ? `${sessionId}:${key}` : key;
  const saved = React.useContext(DisclosureContext) ?? zcodeConversationDisclosures;
  const [override, setOpen] = React.useState<boolean | undefined>(() => saved.get(fullKey) ?? saved.get(key) ?? readStoredDisclosure(fullKey));
  React.useEffect(() => {
    setOpen(saved.get(fullKey) ?? saved.get(key) ?? readStoredDisclosure(fullKey));
  }, [fullKey, key, saved]);
  const open = override ?? defaultOpen;
  return { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    if (next !== open) {
      setPersistedDisclosure(saved, fullKey, next);
      setPersistedDisclosure(zcodeConversationDisclosures, fullKey, next);
      persistDisclosure(fullKey, next);
      setOpen(next);
    }
  } };
}
export type ConversationTurn = { key: string; rows: TimelineRow[]; userSeq?: number };

function timelineRowTurnId(row: TimelineRow): string | undefined {
  if (!('turnId' in row)) return undefined;
  const turnId = row.turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

/** Preserve source order, including tool results updated in place by call ID. */
export function buildConversationTurns(rows: TimelineRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurnId: string | undefined;
  for (const row of rows) {
    const rowTurnId = timelineRowTurnId(row);
    if (!turns.length || row.kind === 'user' && rowTurnId !== currentTurnId) {
      const stableId = (row.kind === 'user' || row.kind === 'assistant') && row.messageId ? row.messageId : row.seq;
      turns.push({ key: row.kind === 'user' ? `user:${stableId}` : `leading:${stableId}`, rows: [],
        ...(row.kind === 'user' ? { userSeq: row.seq } : {}) });
      currentTurnId = undefined;
    }
    turns[turns.length - 1].rows.push(row);
    if (!currentTurnId && rowTurnId) currentTurnId = rowTurnId;
  }
  return turns;
}

function CopyAction({ text }: { text: string | (() => string) }) {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return <><button type="button" className="xn-zc-action" aria-label={tr('复制')} title={tr('复制')}
    onClick={async () => {
      try {
        await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
        if (!mounted.current) return;
        setError(false); setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (mounted.current) setCopied(false);
        }, 1500);
      } catch {
        if (mounted.current) setError(true);
      }
    }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    {error && <span role="alert" className="xn-zc-action-error">{tr('复制失败')}</span>}</>;
}

export type ZCodeConversationSelection = {
  text: string;
  turnId: string;
  rowKey: string;
  rowKind: TimelineRow['kind'];
  rowSeq: number;
  overLimit: boolean;
};

function rowData(row: TimelineRow): { 'data-zcode-row-key': string; 'data-zcode-row-kind': string; 'data-zcode-row-seq': number } {
  return {
    'data-zcode-row-key': conversationFindRowKey(row),
    'data-zcode-row-kind': row.kind,
    'data-zcode-row-seq': row.seq,
  };
}

function Reasoning({ row, activityPhase, findActive = false }: { row: Assistant; activityPhase?: string; findActive?: boolean }) {
  const disclosure = useDisclosure(`reasoning:${row.messageId ?? row.messageIndex ?? row.seq}`);
  const open = disclosure.open || findActive;
  const active = reasoningIsActive(row.streaming, activityPhase, row.text);
  const summary = row.reasoning?.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  // Keep the reasoning block independent from the assistant prose while
  // retaining the legacy assistant row identity for old event consumers.
  // Empty streaming reasoning is intentionally absent until the first token.
  if (row.streaming && !row.reasoning?.trim()) return null;
  const durationMs = conversationElapsedInterval(row.startedAt, row.endedAt);
  const duration = durationMs !== undefined ? formatConversationWorkDuration(durationMs, getLocale()) : undefined;
  const state = active ? 'streaming' : row.interrupted ? 'interrupted' : 'complete';
  const label = active ? tr('思考中…') : duration ? tf('思考了 {0}', [duration]) : row.interrupted ? tr('思考已停止') : tr('思考');
  return <details className="xn-zc-reasoning" open={open} onToggle={disclosure.onToggle} {...rowData(row)} data-active={active || undefined}
    data-testid={`timeline-item-reasoning-${row.seq}`} data-state={state}>
    <summary><Brain size={16} /><span className="xn-zc-kind">{label}</span>
      {!open && summary && <span className="xn-zc-reasoning-preview" title={summary}>{summary.slice(-180)}</span>}
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {open && <div className="xn-zc-reasoning-content"><MarkdownRenderOptionsContext.Provider value={row.streaming ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={row.reasoning ?? ''} /></MarkdownRenderOptionsContext.Provider></div>}
  </details>;
}

function toolSummary(row: Tool): string {
  let input = row.input;
  if (!input) { try { input = JSON.parse(row.subject) as Record<string, unknown>; } catch { /* plain subject */ } }
  for (const key of ['path', 'file_path', 'query', 'pattern', 'command', 'cmd', 'url']) {
    if (typeof input?.[key] === 'string') return input[key] as string;
  }
  if (Array.isArray(input?.argv)) return formatCommandArgv(input.argv);
  if (Array.isArray(input)) return formatCommandArgv(input);
  return row.subject;
}

const toolKinds: Record<string, string> = { read: '读取', list: '列出', glob: '查找', grep: '搜索',
  exec: '执行', exec_start: '执行', write: '写入', edit: '修改', search_web: '搜索网页', web_search: '搜索网页', web_fetch: '读取网页',
  todo_read: '读取待办', todo_write: '更新待办', ask_user: '提问', exec_output: '查看后台任务', exec_kill: '停止后台任务', exit_plan_mode: '退出计划模式', enter_plan_mode: '进入计划模式' };
const TOOL_PAYLOAD_LIMIT = 48_000;
const TOOL_DIFF_PREVIEW_LINES = 240;
const TOOL_SUMMARY_LIMIT = 2_000;
function ToolRow({ row, pending, defaultOpen, findActive = false, effectivePluginIds, onRetry }: { row: Tool; pending: boolean; defaultOpen: boolean; findActive?: boolean; effectivePluginIds?: ReadonlySet<string>; onRetry?: (row: Tool) => void | Promise<unknown> }) {
  const disclosure = useDisclosure(`tool:${row.toolActivityId ?? row.toolCallId}`, defaultOpen);
  const open = disclosure.open || findActive;
  const renderer = resolveToolRenderer(row.name, effectivePluginIds);
  const rendererId: ToolRendererId = renderer.id;
  const Icon = rendererId === 'exec' ? SquareTerminal : rendererId === 'edit' ? Pencil : rendererId === 'read' ? Search : FileText;
  const native = ['files', 'browser', 'workflow', 'task'].includes(rendererId);
  const nativeSummary = native ? nativeToolPayload(rendererId, row) : undefined;
  const primaryText = row.inputActivity ? '' : rendererId === 'fallback' ? '' : nativeSummary
    ? nativeSummary.url ?? nativeSummary.fields[0]?.value ?? '' : toolSummary(row);
  const boundedPrimaryText = primaryText.length > TOOL_SUMMARY_LIMIT ? `${primaryText.slice(0, TOOL_SUMMARY_LIMIT)}…` : primaryText;
  const running = row.status === 'running' || row.status === 'queued';
  const failed = row.status === 'error';
  const status = row.inputActivity ? (getLocale() === 'en' ? 'Receiving tool input' : '正在接收工具输入') : pending ? tr('等待批准') : row.status === 'ok' ? undefined : tr(TOOL_DISPLAY_STATUS_LABELS[row.status]);
  const summarize = (value: unknown) => {
    let text: string;
    try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
    catch { return tr('无法显示工具数据'); }
    return text.length > TOOL_PAYLOAD_LIMIT ? `${text.slice(0, TOOL_PAYLOAD_LIMIT)}\n${tr('[输出已截断]')}` : text;
  };
  const detailsAvailable = rendererId !== 'fallback' && !native;
  const output = open && detailsAvailable ? summarize(row.output) : '';
  const terminal = rendererId === 'exec' ? terminalResultForDisplay(row.output) : null;
  const textResult = detailsAvailable && !terminal && row.output && typeof row.output === 'object'
    ? ['text', 'output', 'content'].map(key => (row.output as Record<string, unknown>)[key]).find(value => typeof value === 'string') : undefined;

  const diff = React.useMemo(() => rendererId === 'edit' ? extractToolDiff(row) : null, [rendererId, row]);
  const diffLines = diff?.lines.slice(0, TOOL_DIFF_PREVIEW_LINES) ?? [];
  const diffTruncated = Boolean(diff && diff.lines.length > TOOL_DIFF_PREVIEW_LINES);

  if (row.inputActivity) return <details className="xn-zc-tool" open={open} onToggle={disclosure.onToggle} {...rowData(row)}
    data-tool-call-id={row.toolCallId} data-tool-renderer={rendererId} data-tool-phase="input_streaming" data-status="running">
    <summary><Icon size={16} /><span className="xn-zc-kind">{tr(toolKinds[row.name] ?? row.name)}</span>
      <ToolStatusShell status="running">{status} · {row.inputActivity.inputChars} {getLocale() === 'en' ? 'characters' : '字符'}</ToolStatusShell>
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {open && <div className="xn-zc-tool-body">{rendererId !== 'fallback' && row.inputActivity.partialInput
      ? <pre>{row.inputActivity.partialInput}{row.inputActivity.truncated ? `\n${tr('[输出已截断]')}` : ''}</pre>
      : <p className="xn-zc-tool-safe-summary">{tr('工具详情不可用')}</p>}</div>}
  </details>;

  return <details className="xn-zc-tool" open={open} onToggle={disclosure.onToggle} {...rowData(row)} data-tool-call-id={row.toolCallId} data-tool-renderer={rendererId}
    data-status={pending ? 'pendingApproval' : row.status} data-testid={`timeline-item-tool-${row.seq}`}>
    <summary><Icon size={16} /><span className="xn-zc-kind" data-running={running && !pending || undefined}>{tr(toolKinds[row.name] ?? row.name)}</span>
      <span className="xn-zc-tool-primary" title={boundedPrimaryText}>{boundedPrimaryText}</span>
      {diff && (diff.added > 0 || diff.removed > 0) && (
        <span className="xn-zc-diff-count" aria-label={tf("改动：+{0} -{1}", [diff.added, diff.removed])}>
          <span className="xn-diff-added">+{diff.added}</span>{" "}
          <span className="xn-diff-removed">-{diff.removed}</span>
        </span>
      )}
      {status && <ToolStatusShell status={row.status} pendingApproval={pending}>{status}</ToolStatusShell>}
      {failed && onRetry && (
        <button
          type="button"
          className="xn-zc-retry-btn"
          data-testid={`tool-retry-${row.seq}`}
          aria-label={tr("重试此工具")}
          title={tr("重试此工具")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void onRetry(row);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
            }
          }}
        >
          {tr("重试")}
        </button>
      )}
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {open && <div className="xn-zc-tool-body">
      {diff && diffLines.length > 0 && (
        <section className="xn-zc-tool-diff" aria-label={tr("文件改动差异")}>
          <div
            className="xn-unified-diff"
            style={{
              maxHeight: 180,
              overflowY: "auto",
              background: "var(--bg-card)",
              padding: "4px 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <table>
              <tbody>
                {diffLines.map((dl, i) => (
                  <tr key={i} className={`xn-diff-line xn-diff-line--${dl.kind}`}>
                    <td className="xn-diff-line__marker" aria-hidden="true">
                      {dl.kind === "add" ? "+" : dl.kind === "remove" ? "−" : dl.kind === "hunk" ? "@@" : " "}
                    </td>
                    <td className="xn-diff-line__text"><code>{dl.text || " "}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {diffTruncated && <p className="xn-zc-tool-truncated" role="status">{tr('[输出已截断]')}</p>}
          </div>
        </section>
      )}
      {rendererId === 'fallback' && <p className="xn-zc-tool-safe-summary" role="note">{tr(renderer.safeLabel)}</p>}
      {(native || rendererId === 'read') && <NativeToolCallCard kind={rendererId} row={row} />}
      {detailsAvailable && row.input && <details><summary>{tr('输入参数')}</summary><pre>{summarize(row.input)}</pre></details>}
      {detailsAvailable && row.error && <p role="alert">{row.errorCode ? `[${row.errorCode.slice(0, 100)}] ` : ''}{row.error.slice(0, TOOL_PAYLOAD_LIMIT)}</p>}
      {terminal ? <section aria-label={tr('终端输出')}><pre className="xn-zc-command">$ {boundedPrimaryText}</pre>
        {terminal.output && <Payload text={terminal.output} />}
        {terminal.stderr && <><span>{tr('标准错误')}</span><Payload text={terminal.stderr} /></>}
        {terminal.exitCode !== undefined && <span>{tf('退出码 {0}', [terminal.exitCode])}</span>}
        <details><summary>{tr('原始工具数据')}</summary><Payload text={output} /></details></section>
        : typeof textResult === 'string' ? <><Payload text={textResult} /><details><summary>{tr('原始工具数据')}</summary><Payload text={output} /></details></>
        : output && <Payload text={output} />}
    </div>}
  </details>;
}

function Payload({ text }: { text: string }) {
  const [limit, setLimit] = React.useState(6000);
  const boundedLimit = Math.min(limit, 48_000);
  const visible = text.slice(0, boundedLimit);
  const capped = text.length > boundedLimit;
  return <><pre>{visible}{capped ? `\n${tr('[输出已截断]')}` : ''}</pre>{capped && boundedLimit < 48_000 && <button type="button" className="xn-zc-text-button"
    onClick={() => setLimit(value => Math.min(48_000, value + 12_000))}>{tr('显示更多')}</button>}</>;
}

function visibleAssistantText(row: Assistant): string {
  return row.streaming ? row.text : (row.displayText ?? row.text);
}

function AssistantText({ row, summary, protocol }: { row: Assistant; summary?: string; protocol: boolean }) {
  // Reveal decoded answer text at an even pace. The streaming presentation is
  // kept until the reveal catches up, so the end of a stream does not pop.
  const target = assistantTextForDisplay(visibleAssistantText(row), row.streaming, summary, protocol);
  const { text: displayed, revealing } = useStreamingReveal(target, row.streaming === true);
  const live = row.streaming === true || revealing;
  return displayed.trim() ? <div className="xn-zc-answer" data-role="assistant" data-testid={`timeline-item-assistant-${row.seq}`} {...rowData(row)}>
    <MarkdownRenderOptionsContext.Provider value={live ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={displayed} /></MarkdownRenderOptionsContext.Provider>
  </div> : null;
}

function CompletionCheck({ row, answer, protocol, findActive = false }: { row: Completion; answer: string; protocol: boolean; findActive?: boolean }) {
  const disclosure = useDisclosure(`completion:${row.seq}`, completionPresentation(row, protocol).detailsOpen);
  const open = disclosure.open || findActive;
  if (shouldHideCompletionCard(row, answer, protocol)) return null;
  const check = completionPresentation(row, protocol);
  const duplicate = isDuplicateCompletionAnswer(check.summary ?? '', answer, protocol);
  return <details className="xn-zc-completion" open={open} onToggle={disclosure.onToggle} {...rowData(row)} data-status={check.status} data-testid={`timeline-item-completion-${row.seq}`}>
    <summary>{check.status === 'ok' ? <Check size={14} /> : <TriangleAlert size={14} />}
      <span>{check.title}</span><ChevronRight size={14} className="xn-zc-chevron" /></summary>
    {open && <div><p>{check.label}</p>{!duplicate && check.summary && <SimpleMarkdown text={check.summary} />}</div>}
  </details>;
}

export type ZCodeConversationProps = {
  toolActivity?: unknown;
  currentStreamId?: string;
  currentTurnId?: string;
  workActivity?: unknown;
  sessionId?: string;
  rows: TimelineRow[];
  /** 上下文压缩边界（由快照的 compactions 与归档行推导）；缺省不渲染分隔行。 */
  compactionMarker?: ConversationCompactionMarker | null;
  timelineMarkers?: unknown;
  findQuery?: string;
  onFindQueryChange?(query: string): void;
  findRequest?: { id: string; query: string; rowKey?: string; occurrence?: number };
  renderSelectionAction?(selection: ZCodeConversationSelection): React.ReactNode;
  streamingPending?: boolean;
  activityPhase?: string;
  jsonToolProtocol?: boolean;
  showReasoning?: boolean;
  collapseTools?: boolean;
  autoScroll?: boolean;
  pendingToolIds?: ReadonlySet<string>;
  /** Effective plugin IDs from the backend catalog. Renderer dependencies
   * fail closed when files/shell is disabled or blocked. */
  effectivePluginIds?: ReadonlySet<string>;
  isSessionsEffective?: () => boolean;
  onFork?(row: Assistant): void;
  onFeedback?(row: Assistant, feedback: 'like' | 'dislike' | null): Promise<void>;
  messageEditSessionId?: string;
  messageEditPreviewTransport?: AttachmentPreviewTransport;
  messageEditTransport?: MessageEditAttachmentTransport;
  onEdit?(row: User, text: string, onAccepted: () => void, attachments?: { preparedToken: string }): Promise<boolean>;
  onRetry?(row?: Tool): void | Promise<unknown>;
};

const UserMessageEditor = React.lazy(() => import('./UserMessageEditor'));

function UserMessage({ row, onEdit, enabled, isSessionsEffective, attachmentTransport, editSessionId, previewTransport }: { row: User; editSessionId?: string; previewTransport?: AttachmentPreviewTransport; attachmentTransport?: MessageEditAttachmentTransport; onEdit?: ZCodeConversationProps['onEdit']; enabled: boolean; isSessionsEffective?: () => boolean }) {
  const [editing, setEditing] = React.useState(false);
  const sessionId = React.useContext(SessionIdContext);
  return <div className="xn-zc-user" data-history-user-seq={row.seq} data-role="user" data-testid={`timeline-item-user-${row.seq}`}>
    {editing && enabled ? <React.Suspense fallback={null}><UserMessageEditor previewTransport={previewTransport} attachmentTransport={attachmentTransport} row={row} sessionId={editSessionId ?? sessionId} enabled={enabled} isSessionsEffective={isSessionsEffective}
      onEdit={onEdit} onClose={() => setEditing(false)} evaluateKey={evaluateUserMessageEditKey} /></React.Suspense>
      : <>{(row.displayText ?? row.text).trim() ? <div className="xn-zc-user-bubble">{row.displayText ?? row.text}</div> : null}<div className="xn-zc-actions"><CopyAction text={(row.displayText ?? row.text).trim() ? (row.displayText ?? row.text) : row.text} />
      {enabled && onEdit && row.messageRevision && row.messageIndex !== undefined && <button type="button" className="xn-zc-action"
        aria-label={tr('编辑消息')} title={tr('编辑消息')} onClick={() => { if (isSessionsEffective?.() !== false) setEditing(true); }}><Pencil size={14} /></button>}
    </div></>}
  </div>;
}

function FeedbackActions({ row, onFeedback }: { row: Assistant; onFeedback: NonNullable<ZCodeConversationProps['onFeedback']> }) {
  const [feedback, setFeedback] = React.useState(row.feedback);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  React.useEffect(() => setFeedback(row.feedback), [row.feedback]);
  const submit = async (value: 'like' | 'dislike') => {
    if (busy) return;
    const previous = feedback;
    const next = feedback === value ? undefined : value;
    setFeedback(next); setBusy(true); setError('');
    try { await onFeedback(row, next ?? null); }
    catch (reason) {
      if (mounted.current) {
        setFeedback(previous);
        setError(reason instanceof Error ? reason.message : tr('反馈保存失败'));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <>{(['like', 'dislike'] as const).map(value => <button key={value} type="button" className="xn-zc-action" disabled={busy}
    aria-label={tr(value === 'like' ? '有帮助' : '没有帮助')} title={tr(value === 'like' ? '有帮助' : '没有帮助')}
    aria-pressed={feedback === value} data-feedback={value} onClick={() => void submit(value)}>
    {value === 'like' ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}</button>)}
    {error && <span className="xn-zc-action-error" role="alert">{error}</span>}</>;
}

/** 上下文压缩边界：归档历史与仍在模型上下文中的消息之间的浅色分隔行。
 * 纯展示、无动画；文案与计数由 sessions 插件的 compaction 记录推导。 */
function TurnView({ turn, latest, props, activeFindRowKey, compactionMarker }: { turn: ConversationTurn; latest: boolean; props: ZCodeConversationProps; activeFindRowKey: string | null; compactionMarker?: ConversationCompactionMarker | null }) {
  useLocale();
  const { showReasoning = true, jsonToolProtocol = false, pendingToolIds, effectivePluginIds, onFork, onFeedback, onEdit, onRetry } = props;
  const canShowReasoning = showReasoning && (!effectivePluginIds || effectivePluginIds.has('sessions'));
  const assistantRows: Assistant[] = [];
  let completion: Completion | undefined;
  let lastToolIndex = -1;
  for (const [index, row] of turn.rows.entries()) {
    if (row.kind === 'assistant') assistantRows.push(row);
    else if (row.kind === 'completion') completion = row;
    else if (row.kind === 'tool') lastToolIndex = index;
  }
  // Stopped partials stay in the work segment, not the final answer.
  let final: Assistant | undefined;
  for (let index = turn.rows.length - 1; index > lastToolIndex; index -= 1) {
    const row = turn.rows[index];
    if (row.kind === 'assistant' && !row.interrupted
      && assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim()) {
      final = row;
      break;
    }
  }
  const work = turn.rows.filter(row => {
    if (row.kind === 'tool') return true;
    if (row.kind === 'subagent' && effectivePluginIds?.has('sessions')) return true;
    if (row.kind === 'assistant' && row !== final) {
      const hasText = Boolean(assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim());
      const hasReasoning = Boolean(canShowReasoning && row.reasoning);
      return hasText || hasReasoning;
    }
    return false;
  });
  const workPending = work.some(row => row.kind === 'tool' && pendingToolIds?.has(row.toolCallId));
  const workFailed = work.some(row => row.kind === 'tool' && row.status === 'error' && !pendingToolIds?.has(row.toolCallId)
    || row.kind === 'subagent' && row.status === 'failed');
  const subagentRunning = work.some(row => row.kind === 'subagent' && row.status === 'running');
  const workDisclosure = useDisclosure(`work:${turn.key}`, workFailed || workPending || subagentRunning);
  const workFindActive = work.some(row => conversationFindRowKey(row) === activeFindRowKey);
  const workOpen = workDisclosure.open || workFindActive;
  const running = latest && props.streamingPending === true;
  const interrupted = assistantRows.some(row => row.interrupted === true);
  const firstTime = assistantRows[0]?.startedAt;
  const lastTime = assistantRows.at(-1)?.endedAt;
  const elapsedMs = conversationElapsedInterval(firstTime, lastTime);
  const duration = elapsedMs !== undefined && elapsedMs > 0 ? formatConversationWorkDuration(elapsedMs, getLocale()) : null;
  const facts = effectivePluginIds?.has('sessions') ? conversationWorkSegments(props.workActivity, turn.rows.map(timelineRowTurnId).find(Boolean)) : [];
  const activeMs = conversationActiveDuration(facts);
  const factualLabel = conversationWorkLabel(facts, getLocale(), activeMs === undefined ? null : formatConversationWorkDuration(activeMs, getLocale()));
  const workLabel = factualLabel ?? (workPending ? tr('等待批准') : interrupted ? tr('已停止') : running || subagentRunning ? tr('工作中') : workFailed ? tr('运行失败') : duration ? (getLocale() === 'en' ? `Elapsed ${duration}` : `经过 ${duration}`) : tr('已完成'));
  const answer = final ? assistantTextForDisplay(visibleAssistantText(final), final.streaming, completion?.summary, jsonToolProtocol) : '';
  const streamingRow = props.activityPhase !== 'compacting' && assistantRows.some(row => row.streaming);
  const liveLabel = props.activityPhase === 'compacting' ? <ContextCompactionStatus /> : tr(conversationActivityLabel(props.activityPhase));
  const copyText = () => assistantRows.map(row => assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol)).filter(text => text.trim()).join('\n\n');
  const referenceRows = turn.rows.filter(isReferenceTimelineRow);
  const userReferences = referenceRows.filter(row => row.anchorRole === 'user');
  const assistantReferences = referenceRows.filter(row => row.anchorRole !== 'user');
  const workRows = work.map(row => row.kind === 'tool'
    ? <ToolRow key={`tool:${row.toolActivityId ?? row.toolCallId}`} row={row} pending={pendingToolIds?.has(row.toolCallId) ?? false} effectivePluginIds={effectivePluginIds} defaultOpen={props.collapseTools === false || row.status === 'error' && !pendingToolIds?.has(row.toolCallId)} findActive={activeFindRowKey === conversationFindRowKey(row)} onRetry={onRetry} />
    : row.kind === 'subagent' ? <SubagentRowView key={`subagent:${row.toolCallId}:${row.taskId}`} row={row}
      sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} findActive={activeFindRowKey === conversationFindRowKey(row)} />
    : row.kind === 'assistant' ? <React.Fragment key={`response:${row.messageId ?? row.messageIndex ?? row.seq}`}>
      {canShowReasoning && row.reasoning && <Reasoning row={row} activityPhase={props.activityPhase} findActive={activeFindRowKey === conversationFindRowKey(row)} />}
      {Boolean(assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim()) && (
        <div className="xn-zc-work-response"><AssistantText row={row} summary={completion?.summary} protocol={jsonToolProtocol} /></div>
      )}
    </React.Fragment> : null);
  const stableTurnId = turn.rows.map(timelineRowTurnId).find(Boolean) ?? turn.key;
  return <section className="xn-zc-turn" data-turn-key={turn.key} data-zcode-turn-id={stableTurnId}>
    {compactionMarker && <CompactionBoundary marker={compactionMarker} />}
    <ConversationMarkers facts={props.timelineMarkers} rows={turn.rows} placement="before_user" enabled={effectivePluginIds?.has('sessions') === true} />
    {turn.rows.filter((row): row is User => row.kind === 'user').map(row => <div key={`user:${row.messageId ?? row.messageIndex ?? row.seq}`} {...rowData(row)}><UserMessage editSessionId={props.messageEditSessionId} previewTransport={props.messageEditPreviewTransport} attachmentTransport={props.messageEditTransport} row={row} onEdit={onEdit} enabled={effectivePluginIds?.has('sessions') === true} isSessionsEffective={props.isSessionsEffective} /></div>)}
    {userReferences.map(row => <ReferenceRowView key={`${row.kind}:${row.seq}`} row={row} sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} />)}
    {(work.length > 0 || facts.length > 0) && (running || !final ? <div className="xn-zc-work"><div className="xn-zc-work-status" role="status">{workLabel}{facts.length > 1 && <span> · {facts.length} {getLocale() === 'en' ? 'segments' : '段工作'}</span>}</div><div className="xn-zc-work-content">{workRows}</div></div>
      : <details className="xn-zc-work" open={workOpen} onToggle={workDisclosure.onToggle}><summary className="xn-zc-work-status"><span>{workLabel}{facts.length > 1 && ` · ${facts.length} ${getLocale() === 'en' ? 'segments' : '段工作'}`}</span><ChevronRight size={16} className="xn-zc-chevron" /></summary>
        {workOpen && <div className="xn-zc-work-content">{workRows}</div>}</details>)}
    <ConversationMarkers facts={props.timelineMarkers} rows={turn.rows} placement="work_tail" enabled={effectivePluginIds?.has('sessions') === true} />
    {final && <div className="xn-zc-final">
      {canShowReasoning && final.reasoning && <Reasoning row={final} activityPhase={props.activityPhase} findActive={activeFindRowKey === conversationFindRowKey(final)} />}
      <AssistantText row={final} summary={completion?.summary} protocol={jsonToolProtocol} />
      {/* While the turn runs, the action row is reserved (it is invisible until
          hover anyway); a settling turn shows its status there, so finishing
          does not add or remove a line below the answer. Distinct keys keep the
          reserved row's opacity from fading through the new buttons. */}
      {running ? <div key="reserved" className="xn-zc-actions xn-zc-actions--reserved" aria-hidden={streamingRow ? true : undefined}>
        {!streamingRow && <span className="xn-zc-live" role="status" data-testid="timeline-stream-loading">{liveLabel}</span>}
      </div>
      : <div key="actions" className="xn-zc-actions"><CopyAction text={copyText} />
        {onFeedback && final.messageRevision && final.messageIndex !== undefined && <FeedbackActions row={final} onFeedback={onFeedback} />}
        {onFork && <button type="button" className="xn-zc-action" aria-label={tr('分叉会话')} title={tr('分叉会话')} onClick={() => onFork(final)}><TrendingUpDown size={14} /></button>}
      </div>}
    </div>}
    {assistantReferences.map(row => <ReferenceRowView key={`${row.kind}:${row.seq}`} row={row} sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} />)}
    {completion && <CompletionCheck row={completion} answer={answer} protocol={jsonToolProtocol} findActive={activeFindRowKey === conversationFindRowKey(completion)} />}
    {turn.rows.filter(row => row.kind === 'pending_question').map(row => row.kind === 'pending_question' ? <p key={`question:${row.seq}`} {...rowData(row)} role="status" className="xn-zc-question">{tr('等待回答')} · {row.question}</p> : null)}
    {running && !streamingRow && !final && <p className="xn-zc-live" role="status" data-testid="timeline-stream-loading">{liveLabel}</p>}
  </section>;
}

const Turn = React.memo(TurnView, conversationTurnPropsEqual);

/** Standard and lightweight runtimes use exactly the same conversation view. */
export function ZCodeConversation(props: ZCodeConversationProps) {
  const [disclosures] = React.useState(() => zcodeConversationDisclosures);
  const identityScope = `${props.sessionId ?? ''}:${props.currentTurnId ?? ''}`;
  const identities = React.useRef({ scope: identityScope, calls: new Map<string, string>() });
  if (identities.current.scope !== identityScope) identities.current = { scope: identityScope, calls: new Map() };
  const projectedRows = toolActivityRows(props.rows, props.toolActivity, { running: props.streamingPending,
    currentTurnId: props.currentTurnId, currentStreamId: props.currentStreamId,
    effectivePluginIds: props.effectivePluginIds, identities: identities.current.calls });
  const turns = React.useMemo(() => buildConversationTurns(projectedRows), [projectedRows]);
  // 压缩边界挂在「第一条仍在模型上下文内的行」所属轮次的顶部；归档轮次在前。
  const markerTurnIndex = React.useMemo(() => props.compactionMarker
    ? turns.findIndex(turn => turn.rows.some(row => row.seq >= props.compactionMarker!.boundarySeq))
    : -1, [turns, props.compactionMarker]);
  const { snapshot, streamRef, reveal } = useTimelineVirtualWindow({ count: turns.length, enabled: true,
    initialTail: props.autoScroll !== false, followTail: props.autoScroll !== false, scopeKey: props.sessionId });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [internalFindQuery, setInternalFindQuery] = React.useState("");
  const findQuery = props.findQuery ?? internalFindQuery;
  const [findOpen, setFindOpen] = React.useState(false);
  const [activeFindIdentity, setActiveFindIdentity] = React.useState<string | null>(null);
  const findMatches = React.useMemo(() => buildConversationFindMatches(props.rows, findQuery), [props.rows, findQuery]);
  const foundActiveIndex = findMatches.findIndex(match => match.identity === activeFindIdentity);
  const activeFindIndex = foundActiveIndex >= 0 ? foundActiveIndex : findMatches.length ? 0 : -1;
  const activeFindMatch = activeFindIndex >= 0 ? findMatches[activeFindIndex] : null;
  const previousFindQuery = React.useRef(findQuery);
  const findHighlightsApplied = React.useRef(false);
  const handledFindRequest = React.useRef<string | null>(null);
  const requestedFindTarget = React.useRef<{ query: string; rowKey: string; occurrence: number } | null>(null);
  React.useEffect(() => {
    const request = props.findRequest;
    if (!request || handledFindRequest.current === request.id) return;
    handledFindRequest.current = request.id;
    setFindOpen(true);
    requestedFindTarget.current = request.rowKey
      ? { query: request.query, rowKey: request.rowKey, occurrence: request.occurrence ?? 0 }
      : null;
    if (props.onFindQueryChange) props.onFindQueryChange(request.query);
    else setInternalFindQuery(request.query);
    const matches = buildConversationFindMatches(props.rows, request.query);
    const target = request.rowKey
      ? matches.find(match => match.rowKey === request.rowKey
        && match.occurrence === (request.occurrence ?? 0))
      : matches[0];
    setActiveFindIdentity(target?.identity ?? matches[0]?.identity ?? null);
  }, [props.findRequest, props.onFindQueryChange, props.rows]);
  React.useEffect(() => {
    const requested = requestedFindTarget.current;
    const requestedMatch = requested && requested.query === findQuery
      ? findMatches.find(match => match.rowKey === requested.rowKey && match.occurrence === requested.occurrence)
      : undefined;
    if (requested && requested.query !== findQuery) requestedFindTarget.current = null;
    if (previousFindQuery.current !== findQuery) {
      previousFindQuery.current = findQuery;
      setActiveFindIdentity(requestedMatch?.identity ?? findMatches[0]?.identity ?? null);
    } else if (requestedMatch && activeFindIdentity !== requestedMatch.identity) {
      setActiveFindIdentity(requestedMatch.identity);
    } else if (foundActiveIndex < 0 && findMatches.length > 0) {
      setActiveFindIdentity(findMatches[0].identity);
    } else if (!findMatches.length && activeFindIdentity !== null) {
      setActiveFindIdentity(null);
    }
  }, [findQuery, findMatches, foundActiveIndex, activeFindIdentity]);
  React.useEffect(() => {
    const conversation = rootRef.current?.querySelector<HTMLElement>(".xn-zcode-conversation");
    if (!conversation) return;
    if (!findQuery.trim() && !findHighlightsApplied.current) return;
    const turnIndex = activeFindMatch
      ? turns.findIndex(turn => turn.rows.some(row => conversationFindRowKey(row) === activeFindMatch.rowKey))
      : -1;
    if (turnIndex >= 0 && (turnIndex < snapshot.start || turnIndex >= snapshot.end)) {
      const frame = window.requestAnimationFrame(() => reveal(turnIndex));
      return () => window.cancelAnimationFrame(frame);
    }
    applyConversationFindHighlights(conversation, findQuery, activeFindMatch?.rowKey ?? null, activeFindMatch?.occurrence ?? -1);
    findHighlightsApplied.current = Boolean(findQuery.trim());
  }, [findQuery, activeFindMatch?.rowKey, activeFindMatch?.occurrence, turns, snapshot.start, snapshot.end, reveal, props.rows]);
  const updateFindQuery = React.useCallback((query: string) => {
    requestedFindTarget.current = null;
    if (props.onFindQueryChange) props.onFindQueryChange(query);
    else setInternalFindQuery(query);
    const matches = buildConversationFindMatches(props.rows, query);
    setActiveFindIdentity(matches[0]?.identity ?? null);
    setFindOpen(true);
  }, [props.onFindQueryChange, props.rows]);
  const moveFind = React.useCallback((direction: -1 | 1) => {
    if (!findMatches.length) return;
    const index = activeFindIndex < 0 ? 0 : (activeFindIndex + direction + findMatches.length) % findMatches.length;
    setActiveFindIdentity(findMatches[index].identity);
  }, [findMatches, activeFindIndex]);
  const [selection, setSelection] = React.useState<ZCodeConversationSelection | null>(null);
  React.useEffect(() => {
    if (!props.renderSelectionAction) { setSelection(null); return; }
    const updateSelection = () => {
      const conversation = rootRef.current?.querySelector<HTMLElement>(".xn-zcode-conversation");
      const selected = window.getSelection();
      const text = selected?.toString().trim() ?? "";
      const anchor = selected?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const row = anchorElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const turn = row?.closest<HTMLElement>("[data-zcode-turn-id]");
      const focus = selected?.focusNode;
      const focusElement = focus instanceof Element ? focus : focus?.parentElement;
      const focusRow = focusElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const range = selected?.rangeCount === 1 ? selected.getRangeAt(0) : null;
      const startElement = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
      const endElement = range?.endContainer instanceof Element ? range.endContainer : range?.endContainer.parentElement;
      const startRow = startElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const endRow = endElement?.closest<HTMLElement>("[data-zcode-row-key]");
      if (!conversation || !text || !anchor || !focus || !conversation.contains(anchor) || !conversation.contains(focus)
        || !row || !turn || row !== focusRow || row !== startRow || row !== endRow
        || !conversation.contains(row) || !conversation.contains(turn)) {
        setSelection(null);
        return;
      }
      const rowSeq = Number(row.dataset.zcodeRowSeq);
      const rowKind = row.dataset.zcodeRowKind as TimelineRow['kind'] | undefined;
      const turnId = turn.dataset.zcodeTurnId;
      if (!Number.isInteger(rowSeq) || !rowKind || !turnId) { setSelection(null); return; }
      setSelection({ text: text.slice(0, 8_001), overLimit: text.length > 8_000,
        turnId, rowKey: row.dataset.zcodeRowKey!, rowKind, rowSeq });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [props.renderSelectionAction]);
  React.useEffect(() => {
    const onFindShortcut = (event: KeyboardEvent) => {
      if (!isModKeyPressed(event) || event.altKey || event.key.toLowerCase() !== 'f') return;
      if (!rootRef.current) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onFindShortcut, true);
    return () => window.removeEventListener('keydown', onFindShortcut, true);
  }, []);
  const requestReveal = React.useCallback((seq: number) => {
    const index = turns.findIndex(turn => turn.userSeq === seq);
    if (index >= 0) reveal(index);
  }, [turns, reveal]);
  return <DisclosureContext.Provider value={disclosures}>
    <SessionIdContext.Provider value={props.sessionId}>
      <div className="xn-timeline-history-layout xn-zc-layout" data-testid="timeline-history-layout">
        <XuenessConversationHistoryRail rows={props.rows} timelineRootRef={rootRef} requestReveal={requestReveal} />
        <div className="xn-timeline-history-layout__content" ref={rootRef}>
          <div className="xn-zcode-conversation" data-testid="zcode-conversation" ref={streamRef} aria-label={tr('会话')}>
            <div className="xn-zc-find__dock">
              <ConversationFindBar open={findOpen || Boolean(findQuery)} query={findQuery} resultCount={findMatches.length}
                activeIndex={activeFindIndex} onOpen={() => setFindOpen(true)} onQueryChange={updateFindQuery}
                onPrevious={() => moveFind(-1)} onNext={() => moveFind(1)} onClose={() => {
                  requestedFindTarget.current = null;
                  setFindOpen(false);
                  if (props.onFindQueryChange) props.onFindQueryChange("");
                  else setInternalFindQuery("");
                  setActiveFindIdentity(null);
                }} />
            </div>
            {props.renderSelectionAction && selection && <div className="xn-zc-selection-action" data-zcode-selection-action="true"
              onMouseDown={event => event.preventDefault()}>{props.renderSelectionAction(selection)}</div>}
            {snapshot.topPad > 0 && <div data-testid="timeline-window-top-spacer" aria-hidden="true" style={{ height: snapshot.topPad }} />}
            {turns.slice(snapshot.start, snapshot.end).map((turn, offset) => <div data-window-index={snapshot.start + offset} key={turn.key}>
              <Turn turn={turn} latest={snapshot.start + offset === turns.length - 1} props={props}
                activeFindRowKey={activeFindMatch?.rowKey ?? null}
                compactionMarker={snapshot.start + offset === markerTurnIndex ? props.compactionMarker : null} />
            </div>)}
            {snapshot.bottomPad > 0 && <div data-testid="timeline-window-bottom-spacer" aria-hidden="true" style={{ height: snapshot.bottomPad }} />}
            {!turns.length && props.streamingPending && <p className="xn-zc-live" role="status">{props.activityPhase === 'compacting' ? <ContextCompactionStatus /> : tr(conversationActivityLabel(props.activityPhase))}</p>}
          </div>
        </div>
      </div>
    </SessionIdContext.Provider>
  </DisclosureContext.Provider>;
}
