import React from 'react';
import { ChevronRight, FileText, Pencil, Search, SquareTerminal } from 'lucide-react';
import { t as tr, tf, getLocale } from '../../i18n';
import { terminalResultForDisplay } from './XuenessTimeline';
import { formatCommandArgv } from '../../xuenessWorkbench';
import { extractToolDiff } from './diffPreview';
import { resolveToolRenderer, ToolStatusShell, type ToolRendererId } from './toolRenderers';
import { NativeToolCallCard } from './NativeToolCallCard';
import { ToolJudgeBadge } from '../tool_judge/ToolJudgeBadge';
import { nativeToolPayload } from './nativeToolPayload';
import { TOOL_DISPLAY_STATUS_LABELS } from './toolDisplayStatus';
import { useDisclosure } from './conversationDisclosure';
import { rowData } from './conversationRows';
import type { Tool } from './conversationTypes';

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
export function ToolRow({ row, pending, defaultOpen, findActive = false, effectivePluginIds, onRetry }: { row: Tool; pending: boolean; defaultOpen: boolean; findActive?: boolean; effectivePluginIds?: ReadonlySet<string>; onRetry?: (row: Tool) => void | Promise<unknown> }) {
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
      {row.judge !== undefined && effectivePluginIds?.has('tool_judge') && <ToolJudgeBadge judge={row.judge} />}
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
