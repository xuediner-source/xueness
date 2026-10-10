/**
 * Adapted from Z.AI ZCode v3.14.3, commit 29628c9 (Apache-2.0):
 * ConversationTurnGroup, ConversationRowView, ToolSummaryRow and Reasoning.
 * Modified for Xueness: native disclosure controls, journal row adapter,
 * plugin-scoped callbacks and its existing safe Markdown renderer.
 * See NOTICE.md and docs/zcode-conversation-parity.md for provenance.
 */
import React from 'react';
import { Brain, Check, ChevronRight, Copy, FileText, TrendingUpDown, Pencil, Search, SquareTerminal, ThumbsUp, ThumbsDown, TriangleAlert } from 'lucide-react';
import { t as tr, tf, getLocale } from '../../i18n';
import type { TimelineRow } from '../../xuenessWorkbench';
import { SimpleMarkdown, MarkdownRenderOptionsContext, type MarkdownRenderOptions } from '../../XuenessShell';
import { useQuantizedStreamingText } from '../../ui/StreamingCommitGate';
import { assistantTextForDisplay, terminalResultForDisplay } from './XuenessTimeline';
import { completionPresentation, isDuplicateCompletionAnswer, shouldHideCompletionCard } from './completionPresentation';
import { conversationActivityLabel, reasoningIsActive } from './conversationActivity';
import { formatConversationWorkDuration } from './conversationWorkDuration';
import { useTimelineVirtualWindow } from './TimelineVirtualWindow';
import { XuenessConversationHistoryRail } from './XuenessConversationHistoryRail';
import { deferCompositionEnd, isImeComposingEvent, isModKeyPressed } from '../../xuenessShortcutDisplay';
import './zcode-conversation.css';
import './sessions.css';
import { formatCommandArgv } from '../../xuenessWorkbench';
import { parseDiffPreview } from './XuenessWorkbenchView';

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

function useDisclosure(key: string, defaultOpen = false) {
  const saved = React.useContext(DisclosureContext) ?? zcodeConversationDisclosures;
  const [override, setOpen] = React.useState<boolean | undefined>(() => saved.get(key));
  const open = override ?? defaultOpen;
  return { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    if (next !== open) { saved.set(key, next); zcodeConversationDisclosures.set(key, next); setOpen(next); }
  } };
}
export type ConversationTurn = { key: string; rows: TimelineRow[]; userSeq?: number };

/** Preserve source order, including tool results updated in place by call ID. */
export function buildConversationTurns(rows: TimelineRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    if (!turns.length || row.kind === 'user') {
      turns.push({ key: row.kind === 'user' ? `user:${row.seq}` : `leading:${row.seq}`, rows: [],
        ...(row.kind === 'user' ? { userSeq: row.seq } : {}) });
    }
    turns[turns.length - 1].rows.push(row);
  }
  return turns;
}

function CopyAction({ text }: { text: string }) {
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
        await navigator.clipboard.writeText(text);
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

function Reasoning({ row, activityPhase }: { row: Assistant; activityPhase?: string }) {
  const disclosure = useDisclosure(`reasoning:${row.messageIndex ?? row.seq}`);
  const active = reasoningIsActive(row.streaming, activityPhase, row.text);
  const summary = row.reasoning?.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  return <details className="xn-zc-reasoning" {...disclosure} data-active={active || undefined}>
    <summary><Brain size={16} /><span className="xn-zc-kind">{tr(active ? '思考中…' : '思考')}</span>
      {active && summary && <span className="xn-zc-reasoning-preview">{summary.slice(-180)}</span>}
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {disclosure.open && <div className="xn-zc-reasoning-content"><MarkdownRenderOptionsContext.Provider value={row.streaming ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={row.reasoning ?? ''} /></MarkdownRenderOptionsContext.Provider></div>}
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
  exec: '执行', exec_start: '执行', write: '写入', edit: '修改', search_web: '搜索网页', web_search: '搜索网页', web_fetch: '读取网页' };
function ToolRow({ row, pending, defaultOpen, onRetry }: { row: Tool; pending: boolean; defaultOpen: boolean; onRetry?: (row: Tool) => void | Promise<unknown> }) {
  const disclosure = useDisclosure(`tool:${row.toolCallId}`, defaultOpen);
  const Icon = /exec|bash|shell/u.test(row.name) ? SquareTerminal : /write|edit/u.test(row.name) ? Pencil : /search|grep|glob/u.test(row.name) ? Search : FileText;
  const running = row.status === 'running' || row.status === 'queued';
  const failed = row.status === 'error';
  const status = pending ? tr('等待批准') : failed ? tr('失败') : row.status === 'cancelled' || row.status === 'stopped' ? tr('已停止') : running ? tr('运行中') : undefined;
  const summarize = (value: unknown) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
    catch { return tr('无法显示工具数据'); }
  };
  const output = disclosure.open ? summarize(row.output) : '';
  const terminal = /^(exec|exec_start|exec_poll)$/u.test(row.name) ? terminalResultForDisplay(row.output) : null;
  const textResult = !terminal && row.output && typeof row.output === 'object'
    ? ['text', 'output', 'content'].map(key => (row.output as Record<string, unknown>)[key]).find(value => typeof value === 'string') : undefined;

  const diff = React.useMemo(() => {
    if (row.name !== "write" && row.name !== "edit") return null;
    const input = row.input && typeof row.input === "object" ? row.input as Record<string, unknown> : null;
    if (typeof input?.old_str === "string" && typeof input?.new_str === "string") {
      const oldLines = input.old_str.split(/\r?\n/);
      const newLines = input.new_str.split(/\r?\n/);
      const lines = [
        ...oldLines.map(t => ({ kind: "remove" as const, text: t })),
        ...newLines.map(t => ({ kind: "add" as const, text: t })),
      ];
      return { isDiff: true, added: newLines.length, removed: oldLines.length, lines };
    }
    if (typeof row.output === "string") {
      const parsed = parseDiffPreview(row.output);
      if (parsed.isDiff) return parsed;
    }
    if (typeof input?.patch === "string") {
      const parsed = parseDiffPreview(input.patch);
      if (parsed.isDiff) return parsed;
    }
    if (typeof input?.diff === "string") {
      const parsed = parseDiffPreview(input.diff);
      if (parsed.isDiff) return parsed;
    }
    return null;
  }, [row.name, row.input, row.output]);

  return <details className="xn-zc-tool" {...disclosure} data-tool-call-id={row.toolCallId}
    data-status={pending ? 'pendingApproval' : row.status} data-testid={`timeline-item-tool-${row.seq}`}>
    <summary><Icon size={16} /><span className="xn-zc-kind" data-running={running && !pending || undefined}>{tr(toolKinds[row.name] ?? row.name)}</span>
      <span className="xn-zc-tool-primary" title={toolSummary(row)}>{toolSummary(row)}</span>
      {diff && (diff.added > 0 || diff.removed > 0) && (
        <span className="xn-zc-diff-count" aria-label={tf("改动：+{0} -{1}", [diff.added, diff.removed])}>
          <span className="xn-diff-added">+{diff.added}</span>{" "}
          <span className="xn-diff-removed">-{diff.removed}</span>
        </span>
      )}
      {status && <span className="xn-zc-tool-state" data-failed={failed || undefined}>{status}</span>}
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
        >
          {tr("重试")}
        </button>
      )}
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {disclosure.open && <div className="xn-zc-tool-body">
      {diff && diff.lines.length > 0 && (
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
                {diff.lines.map((dl, i) => (
                  <tr key={i} className={`xn-diff-line xn-diff-line--${dl.kind}`}>
                    <td className="xn-diff-line__marker" aria-hidden="true">
                      {dl.kind === "add" ? "+" : dl.kind === "remove" ? "−" : dl.kind === "hunk" ? "@@" : " "}
                    </td>
                    <td className="xn-diff-line__text"><code>{dl.text}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {row.input && <details><summary>{tr('输入参数')}</summary><pre>{summarize(row.input)}</pre></details>}
      {row.error && <p role="alert">{row.errorCode ? `[${row.errorCode}] ` : ''}{row.error}</p>}
      {terminal ? <section aria-label={tr('终端输出')}><pre className="xn-zc-command">$ {toolSummary(row)}</pre>
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
  return <><pre>{text.slice(0, limit)}</pre>{text.length > limit && <button type="button" className="xn-zc-text-button"
    onClick={() => setLimit(value => value + 12000)}>{tr('显示更多')}</button>}</>;
}

function AssistantText({ row, summary, protocol }: { row: Assistant; summary?: string; protocol: boolean }) {
  const text = useQuantizedStreamingText(row.text, row.streaming === true);
  const displayed = assistantTextForDisplay(text, row.streaming, summary, protocol);
  return displayed.trim() ? <div className="xn-zc-answer" data-role="assistant" data-testid={`timeline-item-assistant-${row.seq}`}>
    <MarkdownRenderOptionsContext.Provider value={row.streaming ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={displayed} /></MarkdownRenderOptionsContext.Provider>
  </div> : null;
}

function CompletionCheck({ row, answer, protocol }: { row: Completion; answer: string; protocol: boolean }) {
  const disclosure = useDisclosure(`completion:${row.seq}`, completionPresentation(row, protocol).detailsOpen);
  if (shouldHideCompletionCard(row, answer, protocol)) return null;
  const check = completionPresentation(row, protocol);
  const duplicate = isDuplicateCompletionAnswer(check.summary ?? '', answer, protocol);
  return <details className="xn-zc-completion" {...disclosure} data-status={check.status} data-testid={`timeline-item-completion-${row.seq}`}>
    <summary>{check.status === 'ok' ? <Check size={14} /> : <TriangleAlert size={14} />}
      <span>{check.title}</span><ChevronRight size={14} className="xn-zc-chevron" /></summary>
    {disclosure.open && <div><p>{check.label}</p>{!duplicate && check.summary && <SimpleMarkdown text={check.summary} />}</div>}
  </details>;
}

export type ZCodeConversationProps = {
  rows: TimelineRow[];
  streamingPending?: boolean;
  activityPhase?: string;
  jsonToolProtocol?: boolean;
  showReasoning?: boolean;
  collapseTools?: boolean;
  autoScroll?: boolean;
  pendingToolIds?: ReadonlySet<string>;
  onFork?(row: Assistant): void;
  onFeedback?(row: Assistant, feedback: 'like' | 'dislike' | null): Promise<void>;
  onEdit?(row: User, text: string, onAccepted: () => void): Promise<boolean>;
  onRetry?(row?: Tool): void | Promise<unknown>;
};

function UserMessage({ row, onEdit }: { row: User; onEdit?: ZCodeConversationProps['onEdit'] }) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(row.text);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const compositionActiveRef = React.useRef(false);
  const save = async () => {
    if (!onEdit || saving || !text.trim()) return;
    setSaving(true); setError('');
    try {
      const accepted = await onEdit(row, text, () => setEditing(false));
      if (accepted) setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : tr('修改失败，输入已保留。')); }
    finally { setSaving(false); }
  };
  return <div className="xn-zc-user" data-history-user-seq={row.seq} data-role="user" data-testid={`timeline-item-user-${row.seq}`}>
    {editing ? <form className="xn-zc-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <textarea aria-label={tr('编辑消息')} value={text} autoFocus disabled={saving} onChange={event => setText(event.target.value)}
        onCompositionStart={(event) => {
          compositionActiveRef.current = true;
          event.currentTarget.setAttribute("data-composing", "true");
        }}
        onCompositionEnd={(event) => {
          const el = event.currentTarget;
          deferCompositionEnd(() => {
            compositionActiveRef.current = false;
            el?.removeAttribute("data-composing");
          });
        }}
        onKeyDown={event => {
          const action = evaluateUserMessageEditKey({ ...event, compositionActive: compositionActiveRef.current }, { saving });
          if (action === 'cancel') { event.preventDefault(); setEditing(false); }
          else if (action === 'save') { event.preventDefault(); void save(); }
        }} />
      <p className="xn-zc-editor-note">{tr('重新发送会替换这条消息及其后续对话。工作区文件保持当前状态。')}</p>
      {error && <p role="alert">{error}</p>}
      <div><button type="button" disabled={saving} onClick={() => setEditing(false)}>{tr('取消')}</button>
        <button type="submit" disabled={saving || !text.trim()}>{tr(saving ? '正在发送…' : '发送')}</button></div>
    </form> : <><div className="xn-zc-user-bubble">{row.text}</div><div className="xn-zc-actions"><CopyAction text={row.text} />
      {onEdit && row.messageRevision && row.messageIndex !== undefined && <button type="button" className="xn-zc-action"
        aria-label={tr('编辑消息')} title={tr('编辑消息')} onClick={() => { setText(row.text); setError(''); setEditing(true); }}><Pencil size={14} /></button>}
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

function Turn({ turn, latest, props }: { turn: ConversationTurn; latest: boolean; props: ZCodeConversationProps }) {
  const { showReasoning = true, jsonToolProtocol = false, pendingToolIds, onFork, onFeedback, onEdit, onRetry } = props;
  const assistantRows = turn.rows.filter((row): row is Assistant => row.kind === 'assistant');
  const completion = turn.rows.findLast((row): row is Completion => row.kind === 'completion');
  const final = assistantRows.findLast(row => Boolean(assistantTextForDisplay(row.text, row.streaming, completion?.summary, jsonToolProtocol).trim()));
  const finalIndex = final ? turn.rows.indexOf(final) : turn.rows.length;
  const work = turn.rows.filter((row, i) => (row.kind === 'assistant' && i < finalIndex) || row.kind === 'tool');
  const workPending = work.some(row => row.kind === 'tool' && pendingToolIds?.has(row.toolCallId));
  const workFailed = work.some(row => row.kind === 'tool' && row.status === 'error' && !pendingToolIds?.has(row.toolCallId));
  const workDisclosure = useDisclosure(`work:${turn.key}`, workFailed || workPending);
  const running = latest && props.streamingPending === true;
  const interrupted = assistantRows.some(row => row.interrupted === true);
  const firstTime = assistantRows.find(row => row.startedAt !== undefined)?.startedAt;
  const lastTime = assistantRows.findLast(row => row.endedAt !== undefined)?.endedAt;
  const duration = firstTime !== undefined && lastTime !== undefined ? formatConversationWorkDuration(Math.max(0, lastTime - firstTime), getLocale()) : undefined;
  const workLabel = workPending ? tr('等待批准') : interrupted ? tr('已停止') : running ? tr('工作中') : workFailed ? tr('运行失败') : duration ? tf('用时 {0}', [duration]) : tr('已完成');
  const answer = final ? assistantTextForDisplay(final.text, final.streaming, completion?.summary, jsonToolProtocol) : '';
  const copyText = assistantRows.map(row => assistantTextForDisplay(row.text, row.streaming, completion?.summary, jsonToolProtocol)).filter(text => text.trim()).join('\n\n');
  const workRows = work.map(row => row.kind === 'tool'
    ? <ToolRow key={`tool:${row.toolCallId}`} row={row} pending={pendingToolIds?.has(row.toolCallId) ?? false} defaultOpen={props.collapseTools === false || row.status === 'error' && !pendingToolIds?.has(row.toolCallId)} onRetry={onRetry} />
    : row.kind === 'assistant' ? <div key={`response:${row.messageIndex ?? row.seq}`} className="xn-zc-work-response">
      {showReasoning && row.reasoning && <Reasoning row={row} activityPhase={props.activityPhase} />}
      <AssistantText row={row} summary={completion?.summary} protocol={jsonToolProtocol} />
    </div> : null);
  return <section className="xn-zc-turn" data-turn-key={turn.key}>
    {turn.rows.filter((row): row is User => row.kind === 'user').map(row => <UserMessage key={`user:${row.messageIndex ?? row.seq}`} row={row} onEdit={onEdit} />)}
    {work.length > 0 && (running || !final ? <div className="xn-zc-work"><div className="xn-zc-work-status" role="status">{workLabel}</div><div className="xn-zc-work-content">{workRows}</div></div>
      : <details className="xn-zc-work" {...workDisclosure}><summary className="xn-zc-work-status"><span>{workLabel}</span><ChevronRight size={16} className="xn-zc-chevron" /></summary>
        {workDisclosure.open && <div className="xn-zc-work-content">{workRows}</div>}</details>)}
    {final && <div className="xn-zc-final">
      {showReasoning && final.reasoning && <Reasoning row={final} activityPhase={props.activityPhase} />}
      <AssistantText row={final} summary={completion?.summary} protocol={jsonToolProtocol} />
      {!running && <div className="xn-zc-actions"><CopyAction text={copyText} />
        {onFeedback && final.messageRevision && final.messageIndex !== undefined && <FeedbackActions row={final} onFeedback={onFeedback} />}
        {onFork && <button type="button" className="xn-zc-action" aria-label={tr('分叉会话')} title={tr('分叉会话')} onClick={() => onFork(final)}><TrendingUpDown size={14} /></button>}
      </div>}
    </div>}
    {completion && <CompletionCheck row={completion} answer={answer} protocol={jsonToolProtocol} />}
    {turn.rows.filter(row => row.kind === 'pending_question').map(row => row.kind === 'pending_question' ? <p key={`question:${row.seq}`} role="status" className="xn-zc-question">{tr('等待回答')} · {row.question}</p> : null)}
    {running && !assistantRows.some(row => row.streaming) && <p className="xn-zc-live" role="status" data-testid="timeline-stream-loading">{tr(conversationActivityLabel(props.activityPhase))}</p>}
  </section>;
}

/** Standard and lightweight runtimes use exactly the same conversation view. */
export function ZCodeConversation(props: ZCodeConversationProps) {
  const [disclosures] = React.useState(() => zcodeConversationDisclosures);
  const turns = React.useMemo(() => buildConversationTurns(props.rows), [props.rows]);
  const { snapshot, streamRef, reveal } = useTimelineVirtualWindow({ count: turns.length, enabled: true, initialTail: props.autoScroll !== false });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const requestReveal = React.useCallback((seq: number) => {
    const index = turns.findIndex(turn => turn.userSeq === seq);
    if (index >= 0) reveal(index);
  }, [turns, reveal]);
  return <DisclosureContext.Provider value={disclosures}><div className="xn-timeline-history-layout xn-zc-layout" data-testid="timeline-history-layout">
    <XuenessConversationHistoryRail rows={props.rows} timelineRootRef={rootRef} requestReveal={requestReveal} />
    <div className="xn-timeline-history-layout__content" ref={rootRef}>
      <div className="xn-zcode-conversation" data-testid="zcode-conversation" ref={streamRef} aria-label={tr('会话')}>
        {snapshot.topPad > 0 && <div aria-hidden="true" style={{ height: snapshot.topPad }} />}
        {turns.slice(snapshot.start, snapshot.end).map((turn, offset) => <div data-window-index={snapshot.start + offset} key={turn.key}>
          <Turn turn={turn} latest={snapshot.start + offset === turns.length - 1} props={props} />
        </div>)}
        {snapshot.bottomPad > 0 && <div aria-hidden="true" style={{ height: snapshot.bottomPad }} />}
        {!turns.length && props.streamingPending && <p className="xn-zc-live" role="status">{tr(conversationActivityLabel(props.activityPhase))}</p>}
      </div>
    </div>
  </div></DisclosureContext.Provider>;
}
