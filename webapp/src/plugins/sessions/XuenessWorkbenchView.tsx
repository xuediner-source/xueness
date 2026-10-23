import { t as tr, tf } from '../../i18n';
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  WorkbenchSession,
  SessionSummary,
  TimelineRow,
  PendingApproval,
} from "../../xuenessWorkbench";
import { Button, Badge, EmptyState } from "../../ui/primitives";
import { IconArrowUp, IconLoader, IconPaperclip, IconPencil, IconPin, IconRefresh, IconTrash, IconX } from "../../ui/icons";
import type { ComposerCapability, ComposerInput } from "../../xuenessComposer";
import {
  attachmentsFromRefs,
  editorAttachmentRefs, parseStoredAttachmentRefs, persistedAttachmentFields,
  type AttachmentOrigin, type AttachmentRef, type ComposerAttachment,
} from "./composerAttachmentRef";
import type { UploadTransport } from './composerAttachmentUpload';
import type { RemoteAttachmentEndpoint } from './composerAttachmentRef';
import { deferComposerAttachmentRelease } from './composerAttachmentCleanup';
import { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
import { attachmentOwnerMatches, composerDraftIdentityIsOwned, composerReferenceIsOwned, hasUnscopedComposerAttachments, parseComposerAttachmentOwner, reconcileComposerUploads, type ComposerAttachmentOwner } from './composerAttachmentDraft';
import { ComposerCapabilityMenu, MAX_SELECTED_COMPOSER_CAPABILITIES, capabilityLabel, matchesComposerSearch } from './ComposerCapabilityMenu';
import { retainRejectedComposerDraft, recoverComposerDraft, composerDraftContent, subscribeComposerDrafts, notifyComposerDrafts } from './composerRecovery';
import {
  applyEditorSuggestion, contextAfterEditorEdit, deleteEditorAtom, editorHasAtomicNodes, editorStateForPlainText,
  editorStateHasContent, editorStateMatching, editorStateSignature, insertEditorText, navigationLength, navigationText,
  parseComposerEditorState, renderEditorHtml, sendableText, type ComposerEditorState,
} from './composerEditorState';
import { ComposerStructuredEditor, readEditorCursor } from './ComposerStructuredEditor';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { ComposerRecoveryPanel } from './ComposerRecoveryPanel';
import { getWorkbenchStorage } from '../desktop/desktopStorage';
import { ComposerMaterialManifest } from './ComposerMaterialManifest';
import { composerInputForDraft, composerMaterialsForDraft } from './composerMaterialSummary';
import { approvalImpactKind, pendingBatchApprovals } from './approvalImpact';
import { SessionRecoveryNotice } from './SessionRecoveryNotice';
import { CurrentTurnInput, followupDelivery, followupPointerDelivery, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { Search, Target, Workflow, Blocks, Folder } from 'lucide-react';
import { completionPresentation } from './completionPresentation';
import { deferCompositionEnd, displayBinding, isModKeyPressed, isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { formatCommandArgv } from "../../xuenessWorkbench";
import { matchesShortcut, resolveShortcutBinding } from "../../xuenessShortcutCommands";

// Chip shell stays in this module. Preview kind, button and dialog load on demand.
const attachmentPublishers = new WeakMap<object, () => void>();
const missingAttachmentDrafts = new Set<string>();
const ComposerAttachmentChips = React.lazy(() => import('./composerAttachmentPreview'));

export type TaskListProps = {
  sessions: SessionSummary[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
};

export function TaskList({ sessions, activeId, onSelect }: TaskListProps) {
  if (!sessions || sessions.length === 0) {
    return (
      <div data-testid="task-list-empty" className="p-3 text-xs text-[var(--fg-muted)]">{tr("暂无任务")}</div>
    );
  }

  return (
    <ul aria-label={tr("任务列表")} className="xn-task-list">
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        return (
          <li key={s.id}>
            <button
              type="button"
              data-testid={`task-item-${s.id}`}
              data-active={isActive ? "true" : undefined}
              aria-current={isActive ? "true" : undefined}
              onClick={onSelect ? () => onSelect(s.id) : undefined}
              className="xn-task-item"
            >
              <span className="xn-task-item__title">
                {s.title || s.task || tr("未命名任务")}
              </span>
              <span className="xn-task-item__status">
                {s.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type TimelineProps = {
  rows: TimelineRow[];
};

export function Timeline({ rows }: TimelineProps) {
  if (!rows || rows.length === 0) {
    return (
      <div data-testid="timeline-empty" className="p-4 text-xs text-[var(--fg-muted)]">{tr("暂无事件")}</div>
    );
  }

  return (
    <div aria-label={tr("时间线")} className="xn-timeline-container">
      {rows.map((r, idx) => {
        const key = `${r.kind}-${r.seq}-${idx}`;

        if (r.kind === "user") {
          return (
            <div
              key={key}
              data-testid={`timeline-row-user-${r.seq}`}
              className="xn-timeline-row--user"
            >
              {r.text}
            </div>
          );
        }

        if (r.kind === "assistant") {
          return (
            <div
              key={key}
              data-testid={`timeline-row-assistant-${r.seq}`}
              className="xn-timeline-row--assistant"
            >
              {r.text}
            </div>
          );
        }

        if (r.kind === "tool") {
          let tone: "warn" | "ok" | "error" = "warn";
          if (r.status === "ok") {
            tone = "ok";
          } else if (r.status === "error") {
            tone = "error";
          }

          let formattedSubject = r.subject;
          try {
            if (r.subject.startsWith("[")) {
              const parsed = JSON.parse(r.subject);
              if (Array.isArray(parsed)) {
                formattedSubject = formatCommandArgv(parsed);
              }
            }
          } catch {
            // Keep raw subject
          }

          return (
            <div
              key={key}
              data-testid={`timeline-row-tool-${r.seq}`}
              data-tool-status={r.status}
              className="xn-timeline-row--tool"
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>{r.name}</span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--fg-subtle)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {formattedSubject}
                  </span>
                </div>
                <Badge tone={tone}>
                  {r.status}
                </Badge>
              </div>
              {r.status === "error" && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "6px 10px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--error-bg)",
                    color: "var(--error-fg)",
                    fontSize: 11,
                    border: "1px solid var(--error-border)",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>[{r.errorCode || "ERROR"}]</span>{" "}
                  <span>{r.error || tr("工具执行失败")}</span>
                </div>
              )}
            </div>
          );
        }

        if (r.kind === "completion") {
          const completion = completionPresentation(r);
          return (
            <div
              key={key}
              data-testid={`timeline-row-completion-${r.seq}`}
              className="xn-timeline-row--completion"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                <span>{completion.title}</span>
                <Badge tone={completion.status === 'ok' ? 'ok' : completion.status === 'error' ? 'error' : 'warn'}>{completion.label}</Badge>
              </div>
              <div>{completion.summary}</div>
            </div>
          );
        }

        if (r.kind === "pending_question") {
          return (
            <div
              key={key}
              data-testid={`timeline-row-question-${r.seq}`}
              className="xn-timeline-row--question"
            >
              <div style={{ fontWeight: 600 }}>{tr("等待回答")}</div>
              <div>{r.question}</div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export function formatSubject(name: string, subject: string): string {
  if (name === "exec") {
    try {
      const parsed = JSON.parse(subject);
      if (Array.isArray(parsed)) {
        return formatCommandArgv(parsed);
      }
    } catch {
      // Return raw subject if not json
    }
  }
  return subject;
}

export type DiffPreviewLine = {
  kind: "add" | "remove" | "context" | "hunk";
  text: string;
};

export type DiffPreviewSummary = {
  isDiff: boolean;
  added: number;
  removed: number;
  lines: DiffPreviewLine[];
};

export function parseDiffPreview(text: string): DiffPreviewSummary {
  if (!text || typeof text !== "string") {
    return { isDiff: false, added: 0, removed: 0, lines: [] };
  }
  const rawLines = text.split(/\r?\n/);
  const hasHunk = rawLines.some(l => /^@@ -\d+.* \+\d+.* @@/.test(l));
  const hasDiffHeader = rawLines.some(l => /^(?:diff --git|---\s+\S|\+\+\+\s+\S)/.test(l));
  const addLines = rawLines.filter(l => l.startsWith("+") && !l.startsWith("+++"));
  const removeLines = rawLines.filter(l => l.startsWith("-") && !l.startsWith("---"));
  const isDiff = hasHunk || hasDiffHeader || (addLines.length > 0 && removeLines.length > 0);

  if (!isDiff) {
    return { isDiff: false, added: 0, removed: 0, lines: [] };
  }

  let added = 0;
  let removed = 0;
  const lines: DiffPreviewLine[] = [];
  let inHunk = false;

  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
      lines.push({ kind: "hunk", text: line });
    } else if (/^---\s+(?:[ab]\/|\/dev\/null)/.test(line) || /^\+\+\+\s+(?:[ab]\/|\/dev\/null)/.test(line)) {
      inHunk = false;
      lines.push({ kind: "hunk", text: line });
    } else if (!inHunk && (line.startsWith("index ") || /^---\s+\S/.test(line) || /^\+\+\+\s+\S/.test(line))) {
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      added++;
      lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      removed++;
      lines.push({ kind: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "hunk", text: line });
    } else {
      lines.push({ kind: "context", text: line });
    }
  }

  return { isDiff: true, added, removed, lines };
}

function findFirstStringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function computeLineDiff(before: string, after: string): DiffPreviewSummary {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);

  let prefixCount = 0;
  while (
    prefixCount < beforeLines.length &&
    prefixCount < afterLines.length &&
    beforeLines[prefixCount] === afterLines[prefixCount]
  ) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < beforeLines.length - prefixCount &&
    suffixCount < afterLines.length - prefixCount &&
    beforeLines[beforeLines.length - 1 - suffixCount] === afterLines[afterLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const beforeMiddle = beforeLines.slice(prefixCount, beforeLines.length - suffixCount);
  const afterMiddle = afterLines.slice(prefixCount, afterLines.length - suffixCount);

  const contextLimit = 3;
  const leadContextStart = Math.max(0, prefixCount - contextLimit);
  const trailContextEnd = Math.min(suffixCount, contextLimit);

  const lines: DiffPreviewLine[] = [];

  for (let i = leadContextStart; i < prefixCount; i++) {
    lines.push({ kind: "context", text: beforeLines[i] ?? "" });
  }

  const cells = (beforeMiddle.length + 1) * (afterMiddle.length + 1);
  let added = 0;
  let removed = 0;

  if (cells <= 40000 && beforeMiddle.length > 0 && afterMiddle.length > 0) {
    const cols = afterMiddle.length + 1;
    const table = new Uint16Array(cells);
    for (let bi = beforeMiddle.length - 1; bi >= 0; bi--) {
      const row = bi * cols;
      const nextRow = (bi + 1) * cols;
      for (let ai = afterMiddle.length - 1; ai >= 0; ai--) {
        table[row + ai] = beforeMiddle[bi] === afterMiddle[ai]
          ? table[nextRow + ai + 1] + 1
          : Math.max(table[nextRow + ai], table[row + ai + 1]);
      }
    }
    let bi = 0;
    let ai = 0;
    while (bi < beforeMiddle.length || ai < afterMiddle.length) {
      if (bi < beforeMiddle.length && ai < afterMiddle.length && beforeMiddle[bi] === afterMiddle[ai]) {
        lines.push({ kind: "context", text: beforeMiddle[bi] ?? "" });
        bi++;
        ai++;
      } else {
        const remScore = bi < beforeMiddle.length ? table[(bi + 1) * cols + ai] : -1;
        const addScore = ai < afterMiddle.length ? table[bi * cols + ai + 1] : -1;
        if (bi < beforeMiddle.length && (ai >= afterMiddle.length || remScore >= addScore)) {
          removed++;
          lines.push({ kind: "remove", text: beforeMiddle[bi] ?? "" });
          bi++;
        } else {
          added++;
          lines.push({ kind: "add", text: afterMiddle[ai] ?? "" });
          ai++;
        }
      }
    }
  } else {
    for (const bLine of beforeMiddle) {
      removed++;
      lines.push({ kind: "remove", text: bLine });
    }
    for (const aLine of afterMiddle) {
      added++;
      lines.push({ kind: "add", text: aLine });
    }
  }

  const suffixStartIndex = beforeLines.length - suffixCount;
  for (let i = 0; i < trailContextEnd; i++) {
    lines.push({ kind: "context", text: beforeLines[suffixStartIndex + i] ?? "" });
  }

  if (added === 0 && removed === 0) {
    return { isDiff: false, added: 0, removed: 0, lines: [] };
  }

  return { isDiff: true, added, removed, lines };
}

const BEFORE_DIFF_KEYS = [
  "before",
  "old_str",
  "old_string",
  "oldString",
  "oldText",
  "old_text",
  "oldContent",
  "TargetContent",
] as const;

const AFTER_DIFF_KEYS = [
  "after",
  "new_str",
  "new_string",
  "newString",
  "newText",
  "new_text",
  "newContent",
  "ReplacementContent",
  "CodeContent",
  "content",
] as const;

export function extractToolDiff(row: {
  name?: string;
  input?: unknown;
  output?: unknown;
}): DiffPreviewSummary | null {
  if (!row) return null;
  const name = (row.name ?? "").toLowerCase();

  if (typeof row.output === "string") {
    const parsed = parseDiffPreview(row.output);
    if (parsed.isDiff) return parsed;
  }

  let input: Record<string, unknown> | null =
    row.input && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : null;
  if (!input && typeof row.input === "string" && row.input.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(row.input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed JSON input
    }
  }

  if (input) {
    if (typeof input.patch === "string") {
      const parsed = parseDiffPreview(input.patch);
      if (parsed.isDiff) return parsed;
    }
    if (typeof input.diff === "string") {
      const parsed = parseDiffPreview(input.diff);
      if (parsed.isDiff) return parsed;
    }

    const before = findFirstStringField(input, BEFORE_DIFF_KEYS);
    const after = findFirstStringField(input, AFTER_DIFF_KEYS);

    if (before !== undefined && after !== undefined) {
      const diff = computeLineDiff(before, after);
      if (diff.isDiff) return diff;
      return null;
    }

    if (after !== undefined && (/(write|create|save|patch|edit|replace)/i.test(name) || input.TargetFile || input.file_path || input.path)) {
      const lines = after.split(/\r?\n/).map(text => ({ kind: "add" as const, text }));
      return { isDiff: true, added: lines.length, removed: 0, lines };
    }

    if (before !== undefined && (/(delete|remove|patch|edit|replace)/i.test(name) || input.TargetFile || input.file_path || input.path)) {
      const lines = before.split(/\r?\n/).map(text => ({ kind: "remove" as const, text }));
      return { isDiff: true, added: 0, removed: lines.length, lines };
    }
  }

  return null;
}

const MAX_DISCLOSURE_ENTRIES = 500;
export function setPersistedDisclosure(map: Map<string, boolean>, key: string, value: boolean): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_DISCLOSURE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export const approvalPreviewOpenState = new Map<string, boolean>();

function ApprovalItemPreview({
  preview,
  toolCallId,
}: {
  preview: string;
  toolCallId: string;
}) {
  const diff = useMemo(() => parseDiffPreview(preview), [preview]);
  const [isOpen, setIsOpen] = useState(() => approvalPreviewOpenState.get(toolCallId) ?? true);

  const toggleOpen = () => {
    const next = !isOpen;
    setPersistedDisclosure(approvalPreviewOpenState, toolCallId, next);
    setIsOpen(next);
  };

  const lineCount = preview.split(/\r?\n/).length;
  const canFold = lineCount > 6 || preview.length > 280;

  if (diff.isDiff) {
    return (
      <div className="xn-approval-diff" data-testid={`approval-diff-${toolCallId}`}>
        <div className="xn-approval-diff__toolbar">
          <span className="xn-diff-stat" aria-label={tf("改动：+{0} -{1}", [diff.added, diff.removed])}>
            <span className="xn-diff-stat--add">+{diff.added}</span>{" "}
            <span className="xn-diff-stat--remove">-{diff.removed}</span>
          </span>
          {canFold && (
            <button
              type="button"
              className="xn-approval-preview-toggle"
              onClick={toggleOpen}
              aria-expanded={isOpen}
            >
              {tr(isOpen ? "收起预览" : "展开预览")}
            </button>
          )}
        </div>
        {isOpen && (
          <div
            className="xn-unified-diff"
            style={{
              maxHeight: 160,
              overflowY: "auto",
              background: "var(--bg-card)",
              padding: "4px 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <table aria-label={tr("文件改动差异")}>
              <tbody>
                {diff.lines.map((dl, i) => (
                  <tr key={i} className={`xn-diff-line xn-diff-line--${dl.kind}`}>
                    <td className="xn-diff-line__marker" aria-hidden="true">
                      {dl.kind === "add" ? "+" : dl.kind === "remove" ? "−" : dl.kind === "hunk" ? "@@" : " "}
                    </td>
                    <td className="xn-diff-line__text"><code>{dl.text || " "}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {canFold && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="xn-approval-preview-toggle"
            onClick={toggleOpen}
            aria-expanded={isOpen}
          >
            {tr(isOpen ? "收起预览" : "展开预览")}
          </button>
        </div>
      )}
      {isOpen && (
        <div
          style={{
            color: "var(--fg-subtle)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflowY: "auto",
            background: "var(--bg-card)",
            padding: "6px 8px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
          }}
        >
          {preview}
        </div>
      )}
    </div>
  );
}

export type ApprovalsProps = {
  pending: PendingApproval[];
  /** Resolves false when the answer did not go through (the card then offers a retry). */
  onApprove?: (pending: PendingApproval) => void | Promise<unknown>;
  onApproveAll?: (items: PendingApproval[]) => void | Promise<unknown>;
  /** Deny a call that waits in the running turn; the model gets the denial and goes on. */
  /** Rejects a waiting call; `feedback` (optional) is handed to the model with the denial (ZCode permission-response). */
  onReject?: (pending: PendingApproval, feedback?: string) => void | Promise<unknown>;
  /** Allows a waiting call and identical calls for the rest of this session (ZCode "允许本会话"). */
  onAllowSession?: (pending: PendingApproval) => void | Promise<unknown>;
  /** Holds the replay path (older sessions); waiting calls stay answerable while a run is busy. */
  busy?: boolean;
};

function approvalOperationLabel(kind: ReturnType<typeof approvalImpactKind>): string {
  return tr(kind === 'read' ? '读取' : kind === 'write' ? '写入' : kind === 'edit' ? '修改'
    : kind === 'execute' ? '执行命令' : kind === 'network' ? '访问网络'
      : kind === 'external' ? '调用外部工具' : kind === 'plan' ? '批准计划' : '执行操作');
}

function approvalImpactDescription(kind: ReturnType<typeof approvalImpactKind>): string {
  return tr(kind === 'read' ? '读取所列目标，不会修改文件。'
    : kind === 'write' ? '向所列目标写入内容，可能创建或覆盖文件。'
      : kind === 'edit' ? '修改所列目标；请检查下面的变更预览。'
        : kind === 'execute' ? '运行所列命令；命令可能改变文件或系统状态。'
          : kind === 'network' ? '访问联网服务，并向所列目标发送查询或读取内容。'
            : kind === 'external' ? '调用所列外部工具；请核对工具名称与目标。'
              : '按所列操作类型处理目标；请检查目标和详细预览。');
}

function approvalTarget(pending: PendingApproval): string {
  return pending.subject ? formatSubject(pending.kind ?? pending.name, pending.subject) : tr('未提供目标');
}

export type ApprovalsKeyAction =
  | { type: "approve-item"; index: number; item: PendingApproval }
  | { type: "approve-all" }
  | { type: "approve-active"; index: number; item: PendingApproval }
  | { type: "next" }
  | { type: "prev" }
  | null;

export function evaluateApprovalsKeyDown(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    nativeEvent?: { isComposing?: boolean };
    target?: unknown;
    preventDefault?: () => void;
  },
  options: {
    pending: PendingApproval[];
    activeIndex: number;
    platform?: string;
  },
): ApprovalsKeyAction {
  if (event.nativeEvent?.isComposing) return null;
  const targetEl = event.target as { closest?: (selector: string) => unknown } | null;
  if (targetEl && typeof targetEl.closest === "function") {
    if (targetEl.closest("input, textarea, select, button, a")) {
      return null;
    }
  }

  const isPlainKey = !event.ctrlKey && !event.metaKey && !event.altKey;

  // Number keys 1..9: directly approve corresponding pending item (no modifier keys)
  if (isPlainKey && /^[1-9]$/.test(event.key)) {
    const idx = Number(event.key) - 1;
    if (idx < options.pending.length) {
      const item = options.pending[idx];
      return item ? { type: "approve-item", index: idx, item } : null;
    }
  }

  // A or Mod+Enter: batch approve
  const isBatchKey =
    (isPlainKey && (event.key === "a" || event.key === "A")) ||
    (event.key === "Enter" && isModKeyPressed(event, options.platform));
  if (isBatchKey && options.pending.length > 1) {
    return { type: "approve-all" };
  }

  // Arrow navigation
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    return { type: "next" };
  }
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    return { type: "prev" };
  }

  // Enter on active item (plain Enter only, non-button target)
  if (event.key === "Enter" && isPlainKey) {
    const item = options.pending[options.activeIndex];
    return item ? { type: "approve-active", index: options.activeIndex, item } : null;
  }

  return null;
}

export function Approvals({ pending, onApprove, onApproveAll, onReject, onAllowSession, busy = false }: ApprovalsProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // ZCode PermissionDialog: an answer in flight disables that card; a failed one says so.
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [feedback, setFeedback] = useState<ReadonlyMap<string, string>>(() => new Map());
  const blocked = (p: PendingApproval) => p.waiting ? responding.has(p.tool_call_id) : busy;
  const respond = async (items: PendingApproval[], action: () => void | Promise<unknown>) => {
    const ids = items.map(p => p.tool_call_id);
    setResponding(previous => new Set([...previous, ...ids]));
    setFailed(previous => new Set([...previous].filter(id => !ids.includes(id))));
    let outcome: unknown;
    try { outcome = await action(); } catch { outcome = false; }
    finally { setResponding(previous => new Set([...previous].filter(id => !ids.includes(id)))); }
    if (outcome === false && items.some(p => p.waiting)) setFailed(previous => new Set([...previous, ...ids]));
  };
  const approveOne = (p: PendingApproval) => { if (onApprove && !blocked(p)) void respond([p], () => onApprove(p)); };
  const rejectOne = (p: PendingApproval) => {
    if (!onReject || !p.waiting || blocked(p)) return;
    const note = (feedback.get(p.tool_call_id) ?? '').trim();
    void respond([p], () => note ? onReject(p, note) : onReject(p));
  };
  const allowSessionOne = (p: PendingApproval) => { if (onAllowSession && p.waiting && !p.oneShot && !blocked(p)) void respond([p], () => onAllowSession(p)); };

  if (!pending || pending.length === 0) {
    return (
      <div data-testid="approvals-empty" className="p-2 text-xs text-[var(--fg-muted)]">{tr("无待审批")}</div>
    );
  }

  const activeIndex = Math.min(Math.max(0, focusedIndex), pending.length - 1);
  const allGranted = pending.every(p => p.granted);
  const ungranted = pendingBatchApprovals(pending);

  const liveBatch = ungranted.length > 0 && ungranted.every(p => p.waiting);
  const batchBlocked = allGranted || (liveBatch ? ungranted.some(p => responding.has(p.tool_call_id)) : busy);
  const handleBatchApprove = async () => {
    if (batchBlocked) return;
    // Keep the callback's actual scope identical to the visible ungranted list.
    const remaining = pendingBatchApprovals(pending);
    await respond(remaining, async () => {
      if (onApproveAll) return onApproveAll(remaining);
      let outcome: unknown = true;
      if (onApprove) for (const p of remaining) if (await onApprove(p) === false) outcome = false;
      return outcome;
    });
  };

  useEffect(() => {
    if (focusedIndex >= 0 && containerRef.current) {
      const el = containerRef.current.querySelector<HTMLElement>('[data-focused="true"]');
      el?.scrollIntoView?.({ block: "nearest" });
    }
  }, [focusedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const action = evaluateApprovalsKeyDown(event, {
      pending,
      activeIndex,
    });
    if (!action) return;

    if (action.type === "approve-item") {
      event.preventDefault();
      setFocusedIndex(action.index);
      approveOne(action.item);
    } else if (action.type === "approve-all") {
      event.preventDefault();
      void handleBatchApprove();
    } else if (action.type === "approve-active") {
      if (onApprove && !blocked(action.item)) {
        event.preventDefault();
        approveOne(action.item);
      }
    } else if (action.type === "next") {
      event.preventDefault();
      setFocusedIndex(i => (i + 1) % pending.length);
    } else if (action.type === "prev") {
      event.preventDefault();
      setFocusedIndex(i => (i - 1 + pending.length) % pending.length);
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={tr("待审批操作")}
      onKeyDown={handleKeyDown}
      className="xn-approvals"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        background: "var(--card-bg)",
        border: "1px solid var(--warn-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="xn-approvals__header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="xn-approvals__title" style={{ fontWeight: 600, fontSize: 13, color: "var(--warn-fg)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>{tr("需要审批的操作 (")}{pending.length})</span>
        </div>
        {pending.length > 1 && (onApproveAll || onApprove) && (
          <div className="xn-approvals__batch-actions" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="xn-approval-kbd" title={tf("快捷键：A 或 {0} 批量批准", [displayBinding("Mod+Enter")])} aria-hidden="true">A</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={batchBlocked}
              onClick={() => void handleBatchApprove()}
              data-testid="approvals-batch-button"
            >
              {allGranted ? tr("全部已批准") : liveBatch ? tf("全部允许 ({0})", [ungranted.length]) : busy ? tr("正在继续…") : tf("全部批准 ({0})", [ungranted.length])}
            </Button>
          </div>
        )}
      </div>

      {pending.length > 1 && !allGranted && (
        <div className="xn-approvals__scope" role="note" aria-label={tr('本次批量批准范围')} data-testid="approvals-batch-scope"
          style={{ padding: '8px 10px', border: '1px solid var(--warn-border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)' }}>
          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{tf('全部批准将批准以下 {0} 项：', [ungranted.length])}</p>
          <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 5 }}>
            {ungranted.map(item => {
              const kind = approvalImpactKind(item.kind, item.name);
              return <li key={item.tool_call_id}>
                <span>{approvalOperationLabel(kind)} · {approvalTarget(item)}</span>
                {kind === 'external' && item.name !== (item.kind ?? item.name) && <small> · {tf('工具：{0}', [item.name])}</small>}
                <small style={{ display: 'block', color: 'var(--fg-muted)' }}>{approvalImpactDescription(kind)}</small>
              </li>;
            })}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pending.map((p, index) => {
          const impactKind = approvalImpactKind(p.kind, p.name);
          const readableSubject = approvalTarget(p);
          const isFocused = index === activeIndex;
          return (
            <div
              key={p.tool_call_id}
              data-testid={`approval-item-${p.tool_call_id}`}
              data-focused={isFocused ? "true" : undefined}
              className="xn-approval-item"
              onClick={() => setFocusedIndex(index)}
              style={{
                border: isFocused ? "1px solid var(--primary)" : "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                padding: "8px 12px",
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "var(--bg-subtle)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontWeight: 600,
                    background: "var(--bg-hover)",
                    color: "var(--fg)",
                    padding: "2px 6px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {approvalOperationLabel(impactKind)}
                </span>
                {impactKind !== 'plan' && <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    overflowWrap: "anywhere",
                    color: "var(--fg)",
                  }}
                >
                  {readableSubject}
                </span>}
              </div>
              {impactKind === 'plan' && p.subject && (
                <div data-testid={`approval-plan-${p.tool_call_id}`} className="xn-approval-plan"
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflowY: "auto", color: "var(--fg)", lineHeight: 1.5 }}>
                  {p.subject}
                </div>
              )}
              <p className="xn-approval-impact" style={{ margin: 0, color: 'var(--fg-muted)' }}>
                {approvalImpactDescription(impactKind)}{impactKind === 'external' && p.name !== (p.kind ?? p.name) ? ` ${tf('工具：{0}', [p.name])}` : ''}
              </p>
              {p.preview && (
                <ApprovalItemPreview preview={p.preview} toolCallId={p.tool_call_id} />
              )}
              {failed.has(p.tool_call_id) && <p role="alert" className="xn-approval-error" style={{ margin: 0, color: "var(--danger-fg, var(--warn-fg))" }}>{tr("审批未完成，请重试。")}</p>}
              {onApprove && (
                <div style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                  <span className="xn-approval-shortcut" aria-hidden="true" title={tf("按数字键 {0} 快速批准", [index + 1])}>
                    {index + 1}
                  </span>
                  {p.waiting ? <>
                    {/* ZCode PermissionDialog: the call waits in this turn; 允许 / 拒绝 answer it in place. */}
                    <span className="xn-approval-waiting" role="status" data-testid={`approval-waiting-${p.tool_call_id}`}>{tr("等待确认")}</span>
                    {onReject && <input
                      type="text" className="xn-approval-feedback" maxLength={2000} disabled={blocked(p)}
                      data-testid={`approval-feedback-${p.tool_call_id}`}
                      aria-label={tr("拒绝理由（可选，会转告模型）")} placeholder={tr("拒绝理由（可选，会转告模型）")}
                      value={feedback.get(p.tool_call_id) ?? ''}
                      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); rejectOne(p); } }}
                      onChange={event => { const value = event.target.value; setFeedback(previous => new Map(previous).set(p.tool_call_id, value)); }}
                      style={{ flex: 1, minWidth: 0, fontSize: 12 }}
                    />}
                    {onReject && <Button variant="secondary" size="sm" disabled={blocked(p)} onClick={() => rejectOne(p)}>{tr("拒绝")}</Button>}
                    {onAllowSession && !p.oneShot && <Button variant="secondary" size="sm" disabled={blocked(p)} title={tr("本会话内同样的调用不再询问；停止或关闭会话后失效")} onClick={() => allowSessionOne(p)}>{tr("允许本会话")}</Button>}
                    <Button variant="primary" size="sm" disabled={blocked(p)} onClick={() => approveOne(p)}>{tr("允许")}</Button>
                  </> : <>
                    {p.granted && <span className="xn-approval-granted" role="status">{tr("已批准，等待执行")}</span>}
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => approveOne(p)}
                    >
                      {tr(busy ? "正在继续…" : p.granted ? "继续执行" : "批准并重试")}
                    </Button>
                  </>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A slash command or @-file suggestion shown above the composer. */
export type ComposerSuggestion = {
  kind: "command" | "file";
  /** Command id (without "/") or workspace file path. */
  token: string;
  description?: string;
};

/** Pure token analysis so SSR tests can assert suggestion behaviour. */
export function composerSuggestions(
  text: string,
  commands: { id: string; description?: string }[],
  files: string[],
): ComposerSuggestion[] {
  // "/name" with no whitespace yet → command suggestions by id prefix.
  const slash = /^\/([A-Za-z0-9._-]*)$/.exec(text);
  if (slash) {
    const prefix = slash[1].toLowerCase();
    return commands
      .filter((c) => c.id.toLowerCase().startsWith(prefix))
      .slice(0, 8)
      .map((c) => ({ kind: "command" as const, token: c.id, description: c.description }));
  }
  // An unfinished "@path" fragment at the end (no whitespace after the last @)
  // → file suggestions by substring, deepest-path-friendly: plain includes().
  const at = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (at) {
    const needle = at[1].toLowerCase();
    return files
      .filter((f) => f.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((f) => ({ kind: "file" as const, token: f }));
  }
  return [];
}

/** Replace the trailing "/cmd" or "@path" fragment with the chosen token. */
export function applySuggestion(text: string, suggestion: ComposerSuggestion): string {
  if (suggestion.kind === "command") return `/${suggestion.token} `;
  return text.replace(/(?:^|\s)@([^\s@]*)$/, (m) => {
    const lead = m.match(/^\s*/)?.[0] ?? "";
    return `${lead}@${suggestion.token} `;
  });
}

export type ComposerMention = {
  id: string;
  label: string;
  kind: "file" | "session" | "skill" | "plugin";
  description?: string;
};
export type ContextComposerSuggestion = {
  kind: "command" | "file" | "session" | "skill" | "plugin" | "goal" | "workflow";
  token: string;
  label?: string;
  description?: string;
};
export type ComposerStartActions = {
  canGoal: boolean;
  canWorkflow: boolean;
  canCompact?: boolean;
  onGoal?: () => void;
  onWorkflow: () => void;
  onPlugins: () => void;
  onModels?: () => void;
};

/** Recovery shown when an active composer cannot send because its model catalog is unavailable. */
export type ComposerModelRecovery =
  | { kind: "loading" }
  | { kind: "error"; onRetry: () => void }
  | { kind: "missing"; onConfigure: () => void }
  | { kind: "blocked" };

/** Shared autocomplete for the hero and conversation composer. */
export function contextComposerSuggestions(
  text: string,
  commands: { id: string; description?: string }[],
  mentions: ComposerMention[],
  actions?: Pick<ComposerStartActions, "canGoal" | "canWorkflow" | "canCompact">,
  cursorOffset?: number,
): ContextComposerSuggestion[] {
  const textBefore = typeof cursorOffset === "number" ? text.slice(0, cursorOffset) : text;
  const slash = /(?:^|\s)\/([A-Za-z0-9._-]*)$/.exec(textBefore);
  if (slash) {
    const prefix = slash[1].toLowerCase();
    const items: ContextComposerSuggestion[] = commands
      .filter((command) => {
        const norm = command.id.replace(/^\/+/, "").toLowerCase();
        return norm.startsWith(prefix) || (prefix.length > 0 && command.description?.toLowerCase().includes(prefix));
      })
      .slice(0, 6)
      .map((command) => ({ kind: "command", token: command.id.replace(/^\/+/, ""), description: command.description }));
    if (actions?.canGoal && "goal".startsWith(prefix)) items.push({ kind: "goal", token: "goal", description: tr("标记为目标任务") });
    if (actions?.canWorkflow && "workflow".startsWith(prefix)) items.push({ kind: "workflow", token: "workflow", description: tr("创建工作流") });
    // /compact is a host command, not a user-defined one: it only appears while
    // the sessions plugin that implements it is effective.
    if (actions?.canCompact && "compact".startsWith(prefix) && !items.some((item) => item.token === "compact")) {
      items.push({ kind: "command", token: "compact", description: tr("压缩当前对话（可附说明）") });
    }
    return items.slice(0, 8);
  }
  const trigger = /(?:^|\s)([@$])([^\s@#$]*)$/.exec(textBefore);
  if (!trigger) return [];
  const isSkillTrigger = trigger[1] === "$";
  const needle = trigger[2].toLowerCase();
  return mentions
    .filter((mention) => (isSkillTrigger ? mention.kind === "skill" : mention.kind !== "skill") &&
      (mention.label.toLowerCase().includes(needle) || mention.id.toLowerCase().includes(needle) || (mention.description && mention.description.toLowerCase().includes(needle))))
    .slice(0, 8)
    .map((mention) => ({
      kind: mention.kind,
      token: mention.id,
      label: mention.label,
      description: mention.description,
    }));
}

export function applyContextSuggestion(
  text: string,
  suggestion: ContextComposerSuggestion,
  cursorOffset?: number,
): string {
  const offset = typeof cursorOffset === "number" ? cursorOffset : text.length;
  const before = text.slice(0, offset);
  const after = text.slice(offset);

  if (suggestion.kind === "command") {
    const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) =>
      (match.match(/^\s*/)?.[0] ?? "") + "/" + suggestion.token + " ",
    );
    return replaced + after;
  }
  if (suggestion.kind === "goal" || suggestion.kind === "workflow") {
    const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
    return replaced + after;
  }
  const expression = suggestion.kind === "skill"
    ? /(?:^|\s)\$([^\s@#$]*)$/
    : /(?:^|\s)@[^\s@#$]*$/;
  const replaced = before.replace(expression, (match) => match.match(/^\s*/)?.[0] ?? "");
  return replaced + after;
}

export const COMPOSER_ATTACHMENT_LIMITS = {
  count: 4,
  eachBytes: 2 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
} as const;

export function composerAttachmentBytes(data: string): number {
  if (!data) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

async function encodeComposerFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function extractFilesFromClipboard(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file) files.push(file);
    }
  } else if (clipboardData.items) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files;
}

export function isFileDragEvent(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).some(
    (type) => type.toLowerCase() === "files" || type === "application/x-moz-file",
  );
}

export const MAX_PROMPT_HISTORY = 30;

export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = entry.trim();
  if (!trimmed) {
    return [...entries];
  }
  if (entries.at(-1)?.trim() === trimmed) {
    return [...entries];
  }
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: "up" | "down",
): {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
} {
  if (entries.length === 0) {
    return {
      nextIndex: currentIndex,
      nextValue: "",
      shouldHandle: false,
    };
  }

  if (direction === "up") {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex === null) {
    const nextIndex = entries.length - 1;
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex >= entries.length - 1) {
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    };
  }

  const nextIndex = currentIndex + 1;
  return {
    nextIndex,
    nextValue: entries[nextIndex] ?? "",
    shouldHandle: true,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function getBrowserStorage(): StorageLike | null {
  return getWorkbenchStorage();
}

export const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "xueness:chat-prompt-history:";

export function readPromptHistoryEntries(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(-MAX_PROMPT_HISTORY);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspaceKey: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const normalized = entries
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(-MAX_PROMPT_HISTORY);
    storage.setItem(`${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`, JSON.stringify(normalized));
  } catch {}
}

export const COMPOSER_DRAFT_STORAGE_KEY_PREFIX = "xueness:composer-drafts:v1:";

export type PersistedComposerDraft = {
  draftId?: string;
  attachmentOwner?: ComposerAttachmentOwner;
  text: string;
  goal?: boolean;
  selectedCapabilities?: string[];
  selectedContext?: {
    files: string[];
    sessions: string[];
    skills: string[];
    plugins: string[];
  };
  updatedAt?: number;
  recoverableDrafts?: PersistedComposerDraft[];
  hadAttachments?: boolean;
  attachmentRefs?: ReturnType<typeof parseStoredAttachmentRefs>;
  editorState?: ComposerEditorState;
  deliveryUnconfirmed?: boolean;
  pendingSubmission?: PersistedComposerDraft;
};

function persistedEditorState(text: string, stored: unknown): ComposerEditorState | undefined {
  return editorStateMatching(text, stored) ?? undefined;
}

export function restoredDraft(value: PersistedComposerDraft): ComposerDraftState {
  const recovered = value.recoverableDrafts?.map(item => restoredDraft({ ...item, recoverableDrafts: undefined, pendingSubmission: undefined })) ?? [];
  if (value.pendingSubmission) recovered.push(restoredDraft({ ...value.pendingSubmission, deliveryUnconfirmed: true,
    recoverableDrafts: undefined, pendingSubmission: undefined }));
  const attachmentRefs = parseStoredAttachmentRefs(value.attachmentRefs);
  return { ...emptyComposerDraft(value.text), draftId: value.draftId || crypto.randomUUID(),
    attachmentOwner: parseComposerAttachmentOwner(value.attachmentOwner), goal: value.goal === true,
    selectedCapabilities: value.selectedCapabilities ?? [],
    selectedContext: value.selectedContext ?? { files: [], sessions: [], skills: [], plugins: [] },
    attachments: attachmentsFromRefs(attachmentRefs),
    editorState: persistedEditorState(value.text, value.editorState),
    attachmentError: value.hadAttachments ? tr('重新打开后请重新添加附件。') : '',
    hadAttachments: value.hadAttachments === true, deliveryUnconfirmed: value.deliveryUnconfirmed === true,
    recoverableDrafts: recovered };
}

function readStoredDraft(value: unknown, includeRecovery = true): PersistedComposerDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('text' in value) || typeof value.text !== 'string') return null;
  const input = value as PersistedComposerDraft;
  const strings = (items: unknown): string[] => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : [];
  return { draftId: typeof input.draftId === 'string' ? input.draftId : undefined,
    attachmentOwner: parseComposerAttachmentOwner(input.attachmentOwner), text: input.text, goal: input.goal === true, selectedCapabilities: strings(input.selectedCapabilities),
    selectedContext: { files: strings(input.selectedContext?.files), sessions: strings(input.selectedContext?.sessions),
      skills: strings(input.selectedContext?.skills), plugins: strings(input.selectedContext?.plugins) },
    ...(input.hadAttachments === true ? { hadAttachments: true } : {}),
    ...(parseStoredAttachmentRefs(input.attachmentRefs).length
      ? { attachmentRefs: parseStoredAttachmentRefs(input.attachmentRefs) } : {}),
    ...(persistedEditorState(input.text, input.editorState) ? { editorState: persistedEditorState(input.text, input.editorState) } : {}),
    ...(input.deliveryUnconfirmed === true ? { deliveryUnconfirmed: true } : {}),
    ...(includeRecovery && input.pendingSubmission ? { pendingSubmission: readStoredDraft(input.pendingSubmission, false) ?? undefined } : {}),
    ...(includeRecovery && Array.isArray(input.recoverableDrafts) ? { recoverableDrafts: input.recoverableDrafts
      .map(item => readStoredDraft(item, false)).filter((item): item is PersistedComposerDraft => item !== null) } : {}) };
}

export function readPersistedDraft(
  workspaceKey: string,
  scope: string,
  storage: StorageLike | null = getBrowserStorage(),
): PersistedComposerDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.scopes) return null;
    const scopeData = parsed.scopes[scope];
    return readStoredDraft(scopeData);
  } catch {
    return null;
  }
}

export function persistDraft(
  workspaceKey: string,
  scope: string,
  draft: Pick<ComposerDraftState, "text" | "goal" | "selectedCapabilities" | "selectedContext" | "recoverableDrafts"> & Partial<Pick<ComposerDraftState, 'attachments' | 'pendingSubmission' | 'deliveryUnconfirmed' | 'hadAttachments' | 'editorState' | 'draftId' | 'attachmentOwner'>>,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const storageKey = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
    const raw = storage.getItem(storageKey);
    let file = { version: 1, scopes: {} as Record<string, PersistedComposerDraft> };
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.scopes) file = parsed;
      } catch {}
    }
    const hasContent = Boolean(
      draft.text.trim() || editorStateHasContent(draft.editorState) ||
      draft.recoverableDrafts?.length || draft.attachments?.length || draft.pendingSubmission || draft.hadAttachments ||
      draft.goal ||
      draft.selectedCapabilities?.length ||
      draft.selectedContext.files.length ||
      draft.selectedContext.sessions.length ||
      draft.selectedContext.skills.length ||
      draft.selectedContext.plugins.length,
    );
    if (!hasContent) {
      delete file.scopes[scope];
    } else {
      const snapshot = (item: typeof draft): PersistedComposerDraft => {
        const editorState = persistedEditorState(item.text, item.editorState);
        return { draftId: item.draftId, attachmentOwner: item.attachmentOwner, text: item.text, goal: item.goal,
          selectedCapabilities: item.selectedCapabilities, selectedContext: item.selectedContext,
          ...persistedAttachmentFields(item.attachments, item.hadAttachments),
          ...(item.hadAttachments ? { hadAttachments: true } : {}),
          ...(editorState ? { editorState } : {}),
          deliveryUnconfirmed: item.deliveryUnconfirmed === true };
      };
      const editorState = persistedEditorState(draft.text, draft.editorState);
      file.scopes[scope] = {
        draftId: draft.draftId, attachmentOwner: draft.attachmentOwner,
        text: draft.text,
        goal: draft.goal,
        selectedCapabilities: draft.selectedCapabilities,
        selectedContext: draft.selectedContext,
        ...persistedAttachmentFields(draft.attachments, draft.hadAttachments),
        ...(draft.hadAttachments ? { hadAttachments: true } : {}),
        ...(editorState ? { editorState } : {}),
        deliveryUnconfirmed: draft.deliveryUnconfirmed === true,
        recoverableDrafts: draft.recoverableDrafts?.map(snapshot),
        pendingSubmission: draft.pendingSubmission ? snapshot(draft.pendingSubmission.draft) : undefined,
        updatedAt: Date.now(),
      };
    }
    if (Object.keys(file.scopes).length === 0) {
      if (storage.removeItem) storage.removeItem(storageKey);
      else storage.setItem(storageKey, "");
    } else {
      storage.setItem(storageKey, JSON.stringify(file));
    }
  } catch {}
}

export function clearPersistedDraft(
  workspaceKey: string,
  scope: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const storageKey = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
    const raw = storage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.scopes || !parsed.scopes[scope]) return;
    delete parsed.scopes[scope];
    if (Object.keys(parsed.scopes).length === 0) {
      if (storage.removeItem) storage.removeItem(storageKey);
      else storage.setItem(storageKey, "");
    } else {
      storage.setItem(storageKey, JSON.stringify(parsed));
    }
  } catch {}
}

export type ComposerProps = {
  sendShortcut?: "enter" | "mod-enter";
  onSend?: (text: string, input?: ComposerInput, onAccepted?: () => void, delivery?: InputDelivery) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  /** Disable sending while keeping the prompt editable (for model/permission gates). */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  modelRecovery?: ComposerModelRecovery;
  running?: boolean;
  queueWhenRunning?: boolean;
  guideWhenRunning?: boolean;
  followupMode?: FollowupMode;
  onFollowupModeChange?: (mode: FollowupMode) => void;
  queueBusy?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  /** Isolate and retain draft contents for each session without remounting the composer. */
  draftKey?: string;
  /** Parent-owned store retains per-session drafts while loading or changing views. */
  draftStore?: React.MutableRefObject<Map<string, ComposerDraftState>>;
  /** Workspace scope key for persisting prompt history and session drafts. */
  workspaceKey?: string;
  placeholder?: string;
  defaultValue?: string;
  /** "hero" renders the centered new-task card; "docked" the bottom composer. */
  variant?: "hero" | "docked";
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLElement>;
  /** Left side of the bottom row: mode/provider selects and other real controls. */
  footer?: React.ReactNode;
  /** Optional workspace/context controls shown inside the input surface. */
  topContent?: React.ReactNode;
  /** Complete model, permission and capability toolbar. */
  controls?: React.ReactNode;
  startActions?: ComposerStartActions;
  mentions?: ComposerMention[];
  capabilities?: ComposerCapability[];
  /** Slash-command candidates (loaded by the container from /api/resources/commands). */
  commands?: { id: string; description?: string }[];
  /** Workspace file candidates for @-mentions (loaded by the container). */
  files?: string[];
  /**
   * Minimal input chrome (lightweight local profile, owned by the providers
   * plugin): keep send/stop and the passed controls, hide the context "+" menu
   * and the keyboard hint. Chips and @-mention suggestions stay available.
   */
  minimal?: boolean;
  platform?: string;
  /** Settings-owned overrides for sessions-scoped send/stop commands. */
  shortcutBindings?: Record<string, string>;
  /** sessions.rich_composer. When false, keep the textarea and inline attachments. */
  richComposer?: boolean;
  /** Active session id for attachment begin/commit. Omitted for a new task. */
  attachmentSessionId?: string;
  /** Workspace root the attachment store binds to. Required for committed refs. */
  attachmentRoot?: string;
  attachmentsEnabled?: boolean;
  attachmentGeneration?: string | number;
  attachmentTransport?: UploadTransport;
  attachmentRemoteOwner?: RemoteAttachmentEndpoint;
};

export type ComposerDraftState = {
  draftId?: string;
  attachmentOwner?: ComposerAttachmentOwner;
  recoverableDrafts?: import('./composerRecovery').RecoverableComposerDraft[];
  pendingSubmission?: { id: string; draft: import('./composerRecovery').RecoverableComposerDraft };
  deliveryUnconfirmed?: boolean;
  hadAttachments?: boolean;
  /** sessions.rich_composer structured document. Absent when degraded to plain text. */
  editorState?: ComposerEditorState;
  text: string;
  attachments: ComposerAttachment[];
  goal: boolean;
  selectedCapabilities?: string[];
  selectedContext: Pick<ComposerInput, "files" | "sessions" | "skills" | "plugins">;
  submissionError: string;
  attachmentError: string;
  revision: number;
};

function emptyComposerDraft(text = ""): ComposerDraftState {
  return {
    draftId: crypto.randomUUID(),
    text,
    attachments: [],
    goal: false,
    selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "",
    attachmentError: "",
    revision: 0,
  };
}

/** Clear only the submitted session's draft, and only if nobody edited it since submission. */
export function clearSubmittedComposerDraft(
  drafts: Map<string, ComposerDraftState>,
  draftKey: string,
  submittedRevision: number,
): Map<string, ComposerDraftState> {
  const current = drafts.get(draftKey);
  if (!current || current.revision !== submittedRevision) return drafts;
  const next = new Map(drafts);
  next.set(draftKey, { ...emptyComposerDraft(), recoverableDrafts: current.recoverableDrafts, pendingSubmission: current.pendingSubmission, revision: current.revision + 1 });
  return next;
}

/** A rejected submission may restore its snapshot only while the cleared draft is still untouched. */
export function restoreSubmittedComposerDraft(
  drafts: Map<string, ComposerDraftState>, draftKey: string, clearedRevision: number,
  submittedDraft: ComposerDraftState, error = "",
): Map<string, ComposerDraftState> {
  const current = drafts.get(draftKey);
  if (!current || current.revision !== clearedRevision) return drafts;
  const next = new Map(drafts);
  next.set(draftKey, { ...submittedDraft, revision: current.revision + 1, submissionError: error });
  return next;
}

export function isImeCompositionKey(e: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  isComposing?: boolean;
  key?: string;
  compositionActive?: boolean;
}): boolean {
  return isImeComposingEvent(e);
}

export function composerEnterIntent(
  e: {
    key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number; isComposing?: boolean;
    compositionActive?: boolean;
  },
  sendShortcut: "enter" | "mod-enter",
  hasSuggestions: boolean,
  platform?: string,
): "accept-suggestion" | "send" | null {
  if (e.key !== "Enter" || isImeCompositionKey(e)) return null;
  if (hasSuggestions && !e.shiftKey && !e.altKey) return "accept-suggestion";
  if (e.shiftKey || e.altKey) return null;
  if (sendShortcut === "enter") return "send";
  return isModKeyPressed(e, platform) ? "send" : null;
}

export function handleComposerEscapeAction(
  e: {
    key: string;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    keyCode?: number;
    isComposing?: boolean;
    compositionActive?: boolean;
    preventDefault: () => void;
  },
  state: {
    hasSuggestions: boolean;
    onDismissSuggestions: () => void;
    plusOpen: boolean;
    onClosePlus: () => void;
    running: boolean;
    stopping: boolean;
    onStop?: () => void;
    hasHistory?: boolean;
    onExitHistory?: () => void;
  },
): boolean {
  if (e.key !== "Escape") return false;
  if (isImeCompositionKey(e)) return false;
  e.preventDefault();
  if (state.hasSuggestions) {
    state.onDismissSuggestions();
    return true;
  }
  if (state.plusOpen) {
    state.onClosePlus();
    return true;
  }
  if (state.hasHistory && state.onExitHistory) {
    state.onExitHistory();
    return true;
  }
  if (state.running && state.onStop && !state.stopping) {
    state.onStop();
    return true;
  }
  return true;
}

export function Composer({
  sendShortcut = "enter",
  onSend,
  disabled = false,
  sendDisabled = false,
  sendDisabledReason,
  modelRecovery,
  running = false,
  queueWhenRunning = false,
  guideWhenRunning = false,
  followupMode,
  onFollowupModeChange,
  queueBusy = false,
  stopping = false,
  onStop,
  draftKey = "default",
  draftStore,
  workspaceKey,
  placeholder = tr("输入消息或指令..."),
  defaultValue = "",
  variant = "docked",
  autoFocus = false,
  inputRef,
  footer,
  topContent,
  controls,
  startActions,
  mentions = [],
  capabilities = [],
  commands = [],
  files = [],
  minimal = false,
  platform,
  shortcutBindings = {},
  richComposer = false,
  attachmentSessionId,
  attachmentRoot,
  attachmentsEnabled = true,
  attachmentGeneration = "default",
  attachmentTransport,
  attachmentRemoteOwner,
}: ComposerProps) {
  const localDraftsRef = useRef<Map<string, ComposerDraftState>>(new Map());
  const [localFollowupMode, setLocalFollowupMode] = useState<FollowupMode>('guide');
  const effectiveFollowupMode = guideWhenRunning ? followupMode ?? localFollowupMode : 'queue';
  const pointerDeliveryRef = useRef<InputDelivery | undefined>(undefined);
  const draftsRef = draftStore ?? localDraftsRef;
  const resolvedWorkspaceKey = workspaceKey ?? "default";
  const scopedDraftKey = `${resolvedWorkspaceKey}:${draftKey}`;
  const [draftRenderVersion, setDraftRenderVersion] = useState(0);
  useEffect(() => subscribeComposerDrafts(draftsRef, () => setDraftRenderVersion(version => version + 1)), [draftsRef]);
  const compositionActiveRef = useRef(false);
  const historyIndexRef = useRef<number | null>(null);
  const savedDraftTextRef = useRef<string>("");
  const [cursorOffset, setCursorOffset] = useState<number | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    historyIndexRef.current = null;
    savedDraftTextRef.current = "";
    setCursorOffset(null);
    setSuggestDismissed(false);
    setActiveSuggestion(0);
  }, [draftKey, resolvedWorkspaceKey]);

  if (!draftsRef.current.has(scopedDraftKey)) {
    const persisted = readPersistedDraft(resolvedWorkspaceKey, draftKey);
    if (persisted) {
      draftsRef.current.set(scopedDraftKey, restoredDraft(persisted));
    } else {
      draftsRef.current.set(scopedDraftKey, emptyComposerDraft(defaultValue));
    }
  }
  const draft = draftsRef.current.get(scopedDraftKey)!;
  if (!draft.draftId) draft.draftId = crypto.randomUUID();
  // State lives in a per-scope map so late handlers keep writing to the draft
  // they submitted, even after this component has switched to another session.
  void draftRenderVersion;
  const updateDraftFor = (
    scope: string,
    update: (current: ComposerDraftState) => ComposerDraftState,
    contentChanged = true,
  ): ComposerDraftState => {
    const current = draftsRef.current.get(scope) ?? emptyComposerDraft();
    const updated = update(current);
    if (updated === current) return current;
    const nextDraft = { ...updated, revision: current.revision + (contentChanged ? 1 : 0) };
    const nextDrafts = new Map(draftsRef.current);
    nextDrafts.set(scope, nextDraft);
    draftsRef.current = nextDrafts;
    const scopePrefix = `${resolvedWorkspaceKey}:`;
    persistDraft(resolvedWorkspaceKey, scope.startsWith(scopePrefix) ? scope.slice(scopePrefix.length) : draftKey, nextDraft);
    notifyComposerDrafts(draftsRef);
    return nextDraft;
  };
  const updateCurrentDraft = (update: (current: ComposerDraftState) => ComposerDraftState, contentChanged = true) =>
    updateDraftFor(scopedDraftKey, update, contentChanged);
  const { text, attachments, goal, selectedContext, submissionError, attachmentError } = draft;
  const selectedCapabilities = draft.selectedCapabilities ?? [];
  const toggleCapability = (item: ComposerCapability) => {
    if (item.available === false || !capabilities.some(entry => entry.id === item.id && entry.available !== false)) return;
    updateCurrentDraft(current => {
      const previous = current.selectedCapabilities ?? [];
      if (previous.includes(item.id)) {
        return { ...current, selectedCapabilities: previous.filter(id => id !== item.id) };
      }
      if (previous.length >= MAX_SELECTED_COMPOSER_CAPABILITIES) return current;
      return { ...current, selectedCapabilities: [...previous, item.id] };
    });
  };
  const setText = (value: string | ((previous: string) => string)) => updateCurrentDraft(current => {
    const nextText = typeof value === "function" ? value(current.text) : value;
    if (!richComposer) {
      if (nextText === current.text && !current.submissionError && !current.editorState) return current;
      return { ...current, text: nextText, editorState: undefined, submissionError: "" };
    }
    if (nextText === current.text && !current.submissionError && editorStateMatching(nextText, current.editorState)) return current;
    const editorState = editorStateForPlainText(nextText) ?? undefined;
    if (nextText === current.text && !current.submissionError && !editorState && !current.editorState) return current;
    return { ...current, text: nextText, editorState, submissionError: "" };
  });
  const setGoal = (value: boolean | ((previous: boolean) => boolean)) => updateCurrentDraft(current => {
    const nextGoal = typeof value === "function" ? value(current.goal) : value;
    return nextGoal === current.goal ? current : { ...current, goal: nextGoal };
  });
  const [legacyAttachmentBusy, setLegacyAttachmentBusy] = useState(false);
  const legacyAttachmentBusyRef = useRef(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const plusRef = useRef<HTMLDivElement | null>(null);
  const plusButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  // Local handle for the helper buttons; external inputRef stays in sync.
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editorDomRef = useRef<HTMLDivElement | null>(null);
  const localEditSignature = useRef("");
  const pendingCaret = useRef<number | null>(null);
  const surfaceRef = useRef({ scope: "", key: 0, signature: "", html: "", caret: 0 });
  const wasTokenMode = useRef(false);
  const attachRef = (el: HTMLTextAreaElement | null) => {
    localInputRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") {
      (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }
  };
  const updateAttachments = (next: ComposerAttachment[]) => updateCurrentDraft(current =>
    current.attachments === next ? current : { ...current, attachments: next, hadAttachments: false });
  const setAttachmentError = (message: string) => updateCurrentDraft(current =>
    current.attachmentError === message ? current : { ...current, attachmentError: message }, false);
  const setSubmissionError = (message: string) => updateCurrentDraft(current =>
    current.submissionError === message ? current : { ...current, submissionError: message }, false);
  const uploadOwner = draft.attachmentOwner ?? { remote: attachmentRemoteOwner, root: attachmentRoot ?? '', sessionId: attachmentSessionId,
    draftId: draft.draftId ?? scopedDraftKey };
  const uploadStore = useMemo(() => getComposerAttachmentUploadStore({ root: uploadOwner.root,
    sessionId: uploadOwner.sessionId, draftKey: uploadOwner.draftId, remote: uploadOwner.remote }, attachmentTransport),
    [uploadOwner.root, uploadOwner.sessionId, uploadOwner.draftId, JSON.stringify(uploadOwner.remote), attachmentTransport]);
  const uploadEnabled = (!attachmentRemoteOwner || Boolean(attachmentTransport)) && richComposer && attachmentsEnabled && !disabled && Boolean(attachmentRoot);
  const uploadItems = uploadStore.getSnapshot();
  const ownerMismatch = Boolean((draft.attachments.length || draft.hadAttachments || uploadItems.length) && !attachmentOwnerMatches(draft.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner));
  const unavailableAttachments = attachments.length > 0 && (!attachmentsEnabled || (!richComposer && attachments.some(item => item.ref)));
  const attachmentBusy = legacyAttachmentBusy || uploadStore.hasUnready();
  useEffect(() => {
    if (!richComposer) return;
    uploadStore.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
    // Initialize once. A retained manager may already contain completions from
    // an unmounted editor; never replace those with an older persisted snapshot.
    if (draft.hadAttachments && !uploadStore.hasUnready()) missingAttachmentDrafts.add(uploadOwner.draftId);
    const retainedUploads = uploadStore.getSnapshot().length > 0;
    if (!retainedUploads) uploadStore.syncReadyRefs(editorAttachmentRefs(draft.attachments));
    const publish = () => {
      for (const [key, value] of draftsRef.current) {
        const next = reconcileComposerUploads(value, uploadOwner.draftId,
          uploadStore.readyAttachments(), uploadStore.hasUnready() || missingAttachmentDrafts.has(uploadOwner.draftId));
        if (next === value) continue;
        draftsRef.current.set(key, next);
        const prefix = `${resolvedWorkspaceKey}:`;
        if (key.startsWith(prefix)) persistDraft(resolvedWorkspaceKey, key.slice(prefix.length), next);
      }
      notifyComposerDrafts(draftsRef);
    };
    // Keep persistence subscribed through remounts, until this manager is reused.
    const key = uploadStore as object;
    attachmentPublishers.get(key)?.();
    attachmentPublishers.set(key, uploadStore.subscribe(publish));
  }, [uploadStore, draftsRef, richComposer]);
  useEffect(() => {
    uploadStore.setContext({ enabled: uploadEnabled && !ownerMismatch, generation: attachmentGeneration });
  }, [uploadStore, uploadEnabled, ownerMismatch, attachmentGeneration]);
  const disposeRef = (ref: AttachmentRef | undefined, owner = uploadOwner) => {
    if (!ref) return;
    const refId = ref.id;
    // An id collision must never turn a restored remote reference into local cleanup.
    if (JSON.stringify(ref.remoteOwner ? { connectionId: ref.remoteOwner.connectionId, digest: ref.remoteOwner.digest, workspaceIdentity: ref.remoteOwner.workspaceIdentity } : null) !== JSON.stringify(owner.remote ?? null)) return;
    deferComposerAttachmentRelease(owner, refId, () => composerReferenceIsOwned(draftsRef.current.values(), refId), owner.remote && JSON.stringify(owner.remote) !== JSON.stringify(attachmentRemoteOwner) ? undefined : attachmentTransport);
  };
  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    const item = uploadStore.getSnapshot().find(item => item.ref?.id === removed?.ref?.id);
    if (item) uploadStore.remove(item.id);
    updateAttachments(attachments.filter((_, itemIndex) => itemIndex !== index));
    disposeRef(removed?.ref);
  };
  const removeUpload = (id: string) => {
    const removed = uploadStore.getSnapshot().find(item => item.id === id);
    uploadStore.remove(id);
    disposeRef(removed?.ref);
  };
  const addAttachmentFiles = async (filesToAdd: FileList | File[], origin: AttachmentOrigin = "file") => {
    const incoming = Array.from(filesToAdd);
    if (!incoming.length || disabled || !attachmentsEnabled || running || ownerMismatch) return;
    const uploadOrigin = origin === 'workspace' ? 'file' : origin;
    if (richComposer) {
      if (!attachmentRoot) { setAttachmentError(tr('附件未能写入会话，草稿已保留。')); return; }
      updateCurrentDraft(current => ({ ...current, attachmentOwner: uploadOwner, attachmentError: '' }));
      uploadStore.setContext({ enabled: uploadEnabled, generation: attachmentGeneration });
      const result = uploadStore.enqueue(incoming, uploadOrigin);
      if (result.rejected.length) setAttachmentError(tr('最多 8 个附件；图片单个 20 MiB，总量 64 MiB；其他文件最多 4 个，PDF/视频单个 2 MiB、合计 4 MiB，文本 64 KiB。'));
      return;
    }
    // Plain composer compatibility. Transaction failures never enter this path.
    if (legacyAttachmentBusyRef.current) return;
    legacyAttachmentBusyRef.current = true; setLegacyAttachmentBusy(true);
    const scope = scopedDraftKey;
    try {
      const existing = (draftsRef.current.get(scope) ?? emptyComposerDraft()).attachments;
      const added: ComposerAttachment[] = [];
      let total = existing.reduce((sum, item) => sum + composerAttachmentBytes(item.data), 0);
      for (const file of incoming) {
        if (existing.length + added.length >= COMPOSER_ATTACHMENT_LIMITS.count || file.size > COMPOSER_ATTACHMENT_LIMITS.eachBytes || total + file.size > COMPOSER_ATTACHMENT_LIMITS.totalBytes) {
          setAttachmentError(tr('附件最多 4 个，单个不超过 2 MiB，总量不超过 4 MiB。')); continue;
        }
        const data = await encodeComposerFile(file);
        added.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data }); total += file.size;
      }
      updateDraftFor(scope, current => ({ ...current, attachments: [...current.attachments, ...added], hadAttachments: false }));
    } catch { setAttachmentError(tr('读取附件失败，请重新选择。')); }
    finally { legacyAttachmentBusyRef.current = false; setLegacyAttachmentBusy(false); }
  };
  const toggleContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => {
      const values = current.selectedContext[field];
      const next = values.includes(mention.id)
        ? values.filter((id) => id !== mention.id)
        : [...values, mention.id];
      if (next === values) return current;
      return { ...current, selectedContext: { ...current.selectedContext, [field]: next } };
    });
  };
  const addContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => current.selectedContext[field].includes(mention.id)
      ? current
      : { ...current, selectedContext: { ...current.selectedContext, [field]: [...current.selectedContext[field], mention.id] } });
  };
  const closePlusMenu = (restoreFocus = false) => {
    setPlusOpen(false);
    setAddSearch('');
    if (restoreFocus) plusButtonRef.current?.focus();
  };
  const openAttachmentPicker = () => {
    closePlusMenu();
    attachInputRef.current?.click();
  };
  const handlePlusMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeCompositionKey(event)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePlusMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length]?.focus();
    } else if (event.target instanceof HTMLInputElement) {
      // Searching the Add menu must never submit the enclosing message form.
      if (event.key === 'Enter') { event.preventDefault(); items[0]?.focus(); }
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  useEffect(() => {
    if (!plusOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)');
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) closePlusMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [plusOpen]);

  const availableMentions: ComposerMention[] = [...mentions];
  for (const path of files) {
    if (!availableMentions.some((item) => item.kind === "file" && item.id === path)) {
      availableMentions.push({ id: path, label: path, kind: "file" });
    }
  }
  const selectedMention = (kind: ComposerMention["kind"], id: string): ComposerMention =>
    availableMentions.find((item) => item.kind === kind && item.id === id) ?? { id, label: id, kind };

  // Escape dismisses suggestions first, closes the plus menu next, then stops a running task.
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const suggestionListId = useId();
  const plusMenuId = useId();

  const matchedEditor = richComposer ? editorStateMatching(text, draft.editorState) : null;
  const plainEditor = richComposer ? editorStateForPlainText(text) : null;
  const tokenEditor = matchedEditor && editorHasAtomicNodes(matchedEditor) ? matchedEditor : null;
  const structuredDraft = Boolean(richComposer && (tokenEditor || plainEditor));
  let editorSurface = surfaceRef.current;
  if (!tokenEditor) {
    if (editorSurface.scope) {
      editorSurface = { scope: "", key: 0, signature: "", html: "", caret: 0 };
      surfaceRef.current = editorSurface;
    }
  } else {
    const signature = editorStateSignature(tokenEditor);
    const local = localEditSignature.current === signature;
    if (local) {
      localEditSignature.current = "";
      if (editorSurface.signature !== signature) {
        editorSurface = { ...editorSurface, signature };
        surfaceRef.current = editorSurface;
      }
    } else if (editorSurface.scope !== scopedDraftKey || editorSurface.signature !== signature) {
      const caret = pendingCaret.current ?? navigationLength(tokenEditor);
      pendingCaret.current = null;
      editorSurface = {
        scope: scopedDraftKey,
        key: editorSurface.scope === scopedDraftKey ? editorSurface.key + 1 : 0,
        signature,
        html: renderEditorHtml(tokenEditor),
        caret,
      };
      surfaceRef.current = editorSurface;
    }
  }
  const suggestionSource = tokenEditor ? navigationText(tokenEditor).replaceAll("\uFFFC", "\n") : text;
  const suggestionCursor = tokenEditor ? (cursorOffset ?? navigationLength(tokenEditor)) : (cursorOffset ?? text.length);
  const trimmed = text.trim();
  const selectedContextCount = Object.values(selectedContext).reduce((sum, values) => sum + values.length, selectedCapabilities.length);
  const visibleCapabilities = capabilities.filter(item => matchesComposerSearch(addSearch,
    item.id, item.label, item.labelEn, item.description, item.descriptionEn));
  const visibleMentions = availableMentions.filter(item => matchesComposerSearch(addSearch, item.id, item.label, item.description));
  const canOfferGoal = Boolean(startActions?.canGoal);
  const canOfferWorkflow = Boolean(startActions?.canWorkflow);
  const hasSendableContent = trimmed.length > 0 || attachments.length > 0 || selectedContextCount > 0;
  const materialRows = composerMaterialsForDraft(draft, richComposer, {
    mentions: availableMentions,
    capabilities,
    uploads: uploadItems,
    attachmentsEnabled,
    ownerMismatch,
  });
  const isSendDisabled = disabled || sendDisabled || queueBusy || Boolean(draft.pendingSubmission) || (running && !queueWhenRunning) || attachmentBusy || unavailableAttachments || ownerMismatch || Boolean(draft.hadAttachments) || !hasSendableContent;
  // 停止/发送互斥（对标 ZCode showStopControl = canStop && !hasDraftToSubmit）：
  // 运行中且草稿为空时，停止按钮独占发送槽位；有草稿时显示排队发送键。
  // queueWhenRunning=false 时发送键在运行中没有排队语义，停止键始终保留。
  const canStop = running && Boolean(onStop);
  const showStopControl = canStop && (!queueWhenRunning || !hasSendableContent);
  const showQueueControl = running && queueWhenRunning && hasSendableContent;
  const suggestions = !disabled && !suggestDismissed && historyIndexRef.current === null
    ? contextComposerSuggestions(suggestionSource, commands, availableMentions, {
      canGoal: canOfferGoal,
      canWorkflow: canOfferWorkflow,
      canCompact: Boolean(startActions?.canCompact),
    }, suggestionCursor)
    : [];
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const currentSuggestion = suggestions.length > 0 ? Math.min(activeSuggestion, suggestions.length - 1) : -1;
  const tokenSignature = tokenEditor ? editorStateSignature(tokenEditor) : "";
  useEffect(() => {
    const tokens = tokenSignature.length > 0;
    if (wasTokenMode.current && !tokens) localInputRef.current?.focus();
    wasTokenMode.current = tokens;
  }, [tokenSignature]);

  useEffect(() => {
    if (!running || !onStop || stopping) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Custom stop bindings are composer-only. Escape outside the editor belongs
      // to the focused leaf, never the first running composer's document listener.
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || isImeCompositionKey(event)) return;
      const pane = (editorDomRef.current ?? localInputRef.current)?.closest<HTMLElement>('[data-pane-focused]');
      if (pane && (pane.hidden || pane.dataset.paneFocused !== 'true')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("textarea, input, select, [contenteditable='true']")) return;
      if (
        plusOpen ||
        suggestions.length > 0 ||
        document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"], .xn-composer-toolbar__mode[open], .xn-composer-toolbar__model[open]')
      ) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener("keydown", onWindowKeyDown);
    return () => document.removeEventListener("keydown", onWindowKeyDown);
  }, [onStop, platform, plusOpen, running, shortcutBindings, stopping, suggestions.length]);

  // Keep the input compact for short prompts and let it grow for longer ones.
  useEffect(() => {
    const input = localInputRef.current;
    if (!input) return;
    const maxHeight = 160;
    const measure = () => {
      input.style.height = "auto";
      const contentHeight = input.scrollHeight;
      input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = input.clientWidth;
      if (next !== width) { width = next; measure(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [text, variant]);

  const readSelectionOffset = () => {
    if (tokenEditor && editorDomRef.current) return readEditorCursor(editorDomRef.current);
    return localInputRef.current?.selectionStart ?? cursorOffset ?? text.length;
  };
  const commitStructured = (state: ComposerEditorState, cursor: number, local: boolean) => {
    const previous = parseComposerEditorState(draftsRef.current.get(scopedDraftKey)?.editorState);
    if (local) localEditSignature.current = editorStateSignature(state);
    else pendingCaret.current = cursor;
    updateCurrentDraft(current => ({
      ...current,
      text: sendableText(state),
      editorState: state,
      selectedContext: contextAfterEditorEdit(current.selectedContext, previous, state),
      submissionError: "",
    }));
    setCursorOffset(cursor);
  };
  const acceptSuggestion = (suggestion: ContextComposerSuggestion) => {
    const cursor = readSelectionOffset();
    if (richComposer) {
      const base = editorStateMatching(text, draftsRef.current.get(scopedDraftKey)?.editorState) ?? editorStateForPlainText(text);
      const applied = base ? applyEditorSuggestion(base, cursor, suggestion) : null;
      if (applied) {
        if (suggestion.kind === "goal") {
          if (startActions?.onGoal) startActions.onGoal();
          else setGoal(current => !current);
        } else if (suggestion.kind === "workflow") startActions?.onWorkflow();
        else if (suggestion.kind !== "command") addContext(selectedMention(suggestion.kind, suggestion.token));
        commitStructured(applied.state, applied.cursor, false);
        setSuggestDismissed(false);
        setActiveSuggestion(0);
        if (!editorHasAtomicNodes(applied.state)) {
          setTimeout(() => {
            localInputRef.current?.focus();
            try { localInputRef.current?.setSelectionRange(applied.cursor, applied.cursor); } catch { /* The structured surface has no selection range. */ }
          }, 0);
        }
        return;
      }
    }
    let nextText = text;
    let nextCursor = cursor;

    const offset = cursor;
    const before = text.slice(0, offset);
    const after = text.slice(offset);

    if (suggestion.kind === "goal") {
      if (startActions?.onGoal) startActions.onGoal();
      else setGoal((current) => !current);
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "workflow") {
      startActions?.onWorkflow();
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else if (suggestion.kind === "command") {
      const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) =>
        (match.match(/^\s*/)?.[0] ?? "") + "/" + suggestion.token + " ",
      );
      nextText = replaced + after;
      nextCursor = replaced.length;
    } else {
      addContext(selectedMention(suggestion.kind, suggestion.token));
      const expression = suggestion.kind === "skill"
        ? /(?:^|\s)\$([^\s@#$]*)$/
        : /(?:^|\s)@[^\s@#$]*$/;
      const replaced = before.replace(expression, (match) => match.match(/^\s*/)?.[0] ?? "");
      nextText = replaced + after;
      nextCursor = replaced.length;
    }

    setText(nextText);
    setCursorOffset(nextCursor);
    setSuggestDismissed(false);
    setActiveSuggestion(0);
    setTimeout(() => {
      localInputRef.current?.focus();
      try {
        localInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    }, 0);
  };

  const handleSend = async (requestedDelivery?: InputDelivery) => {
    if (isSendDisabled || draftsRef.current.get(scopedDraftKey)?.pendingSubmission || !onSend) return;
    setSubmissionError("");
    const submittedDraft = draftsRef.current.get(scopedDraftKey) ?? emptyComposerDraft(defaultValue);
    if (uploadStore.hasUnready() || legacyAttachmentBusyRef.current || submittedDraft.hadAttachments || unavailableAttachments ||
      (submittedDraft.attachments.length > 0 && !attachmentOwnerMatches(submittedDraft.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner))) return;
    const submittedRevision = submittedDraft.revision;
    const draft = composerInputForDraft(submittedDraft, richComposer);
    const ticket = crypto.randomUUID();
    const submittedText = submittedDraft.text.trim();
    if (submittedText) {
      const history = readPromptHistoryEntries(resolvedWorkspaceKey);
      persistPromptHistoryEntries(resolvedWorkspaceKey, appendPromptHistoryEntry(history, submittedText));
    }
    historyIndexRef.current = null;
    // Move the complete submission out of the editor before the async run can
    // promote/remount the composer. A rejection restores this frozen snapshot.
    draftsRef.current = clearSubmittedComposerDraft(draftsRef.current, scopedDraftKey, submittedRevision);
    const clearedRevision = draftsRef.current.get(scopedDraftKey)!.revision;
    draftsRef.current.set(scopedDraftKey, { ...draftsRef.current.get(scopedDraftKey)!,
      pendingSubmission: { id: ticket, draft: composerDraftContent(submittedDraft) } });
    persistDraft(resolvedWorkspaceKey, draftKey, draftsRef.current.get(scopedDraftKey)!);
    notifyComposerDrafts(draftsRef);
    let accepted = false;
    const release = () => {
      const current = draftsRef.current.get(scopedDraftKey);
      if (current?.pendingSubmission?.id !== ticket) return;
      const next = { ...current, pendingSubmission: undefined };
      draftsRef.current.set(scopedDraftKey, next);
      persistDraft(resolvedWorkspaceKey, draftKey, next);
      notifyComposerDrafts(draftsRef);
    };
    const acknowledge = () => { accepted = true; release(); };
    const restore = (error = "", deliveryUnconfirmed = false) => {
      if (accepted) return;
      // An unknown delivery stays saved beside the editor, so it cannot be
      // resent by a second Enter press before the user checks the conversation.
      const next = deliveryUnconfirmed ? draftsRef.current : restoreSubmittedComposerDraft(draftsRef.current, scopedDraftKey, clearedRevision, submittedDraft, error);
      if (next !== draftsRef.current) {
        draftsRef.current = next;
        persistDraft(resolvedWorkspaceKey, draftKey, next.get(scopedDraftKey)!);
        notifyComposerDrafts(draftsRef);
      } else {
        updateDraftFor(scopedDraftKey, current => retainRejectedComposerDraft(current, submittedDraft, error, deliveryUnconfirmed));
      }
    };
    try {
      const delivery = running && queueWhenRunning ? requestedDelivery ?? followupDelivery(effectiveFollowupMode) : undefined;
      const sent = await onSend(submittedDraft.text.trim(), draft, acknowledge, delivery);
      if (sent === false) restore();
      else {
        acknowledge();

      }
    } catch (error) {
      restore(error instanceof Error ? error.message : tr("发送失败，草稿已保留。"), error instanceof DeliveryUnconfirmedError);
    } finally {
      release();
      if (accepted) {
        for (const ref of editorAttachmentRefs(submittedDraft.attachments)) disposeRef(ref, submittedDraft.attachmentOwner ?? uploadOwner);
        if (submittedDraft.draftId && !composerDraftIdentityIsOwned(draftsRef.current.values(), submittedDraft.draftId)) {
          uploadStore.syncReadyRefs([]);
          attachmentPublishers.get(uploadStore)?.(); attachmentPublishers.delete(uploadStore);
          uploadStore.invalidate();
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const isComposing = compositionActiveRef.current || isImeCompositionKey(e);
    if (tokenEditor && !isComposing && (e.key === "Backspace" || e.key === "Delete")) {
      const edited = deleteEditorAtom(tokenEditor, readSelectionOffset(), e.key === "Backspace" ? "backspace" : "delete");
      if (edited) {
        e.preventDefault();
        commitStructured(edited.state, edited.cursor, false);
        return;
      }
    }
    if (e.defaultPrevented || e.repeat) return;
    const newlineBinding = resolveShortcutBinding("insert-newline", shortcutBindings);
    if (!isComposing && matchesShortcut(e, newlineBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      const cursor = readSelectionOffset();
      if (tokenEditor) {
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
      } else {
        const end = localInputRef.current?.selectionEnd ?? cursor;
        setText(text.slice(0, cursor) + "\n" + text.slice(end));
        requestAnimationFrame(() => localInputRef.current?.setSelectionRange(cursor + 1, cursor + 1));
      }
      return;
    }
    const sendBinding = resolveShortcutBinding("send-message", shortcutBindings);
    const stopBinding = resolveShortcutBinding("stop-generation", shortcutBindings);
    if (!isComposing && matchesShortcut(e, sendBinding, platform) && suggestions.length === 0) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (!isComposing && running && onStop && !stopping && matchesShortcut(e, stopBinding, platform)) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Escape") {
      if (isComposing) return;
      e.preventDefault();
      if (suggestions.length > 0) {
        setSuggestDismissed(true);
        return;
      }
      if (plusOpen) {
        closePlusMenu(true);
        return;
      }
      if (historyIndexRef.current !== null) {
        setText(savedDraftTextRef.current);
        historyIndexRef.current = null;
        return;
      }
      if (running && onStop && !stopping) onStop();
    } else if (e.key === "Tab" && suggestions.length > 0 && currentSuggestion >= 0) {
      if (isComposing) return;
      e.preventDefault();
      acceptSuggestion(suggestions[currentSuggestion]);
    } else if (e.key === "ArrowDown") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion + 1) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && historyIndexRef.current !== null) {
        e.preventDefault();
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        const result = navigatePromptHistory(entries, historyIndexRef.current, "down");
        if (result.nextIndex === null) {
          setText(savedDraftTextRef.current);
          historyIndexRef.current = null;
        } else {
          historyIndexRef.current = result.nextIndex;
          setText(result.nextValue);
        }
      }
    } else if (e.key === "ArrowUp") {
      if (isComposing) return;
      if (suggestions.length > 0) {
        e.preventDefault();
        setActiveSuggestion((currentSuggestion - 1 + suggestions.length) % suggestions.length);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const entries = readPromptHistoryEntries(resolvedWorkspaceKey);
        if (historyIndexRef.current === null && text.length === 0 && !tokenEditor) {
          savedDraftTextRef.current = text;
          const result = navigatePromptHistory(entries, null, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        } else if (historyIndexRef.current !== null) {
          const result = navigatePromptHistory(entries, historyIndexRef.current, "up");
          if (result.shouldHandle) {
            e.preventDefault();
            historyIndexRef.current = result.nextIndex;
            setText(result.nextValue);
          }
        }
      }
    } else {
      if (running && queueWhenRunning && e.key === 'Enter' && isModKeyPressed(e, platform)
          && !e.shiftKey && !e.altKey && !isComposing) {
        e.preventDefault();
        void handleSend(followupDelivery(effectiveFollowupMode, true));
        return;
      }
      const intent = composerEnterIntent(
        { ...e, compositionActive: compositionActiveRef.current },
        sendShortcut,
        suggestions.length > 0 && currentSuggestion >= 0,
        platform,
      );
      if (intent === "accept-suggestion") {
        e.preventDefault();
        acceptSuggestion(suggestions[currentSuggestion]);
      } else if (intent === "send") {
        e.preventDefault();
        void handleSend();
      } else if (tokenEditor && e.key === "Enter" && !isComposing) {
        e.preventDefault();
        const cursor = readSelectionOffset();
        const inserted = insertEditorText(tokenEditor, cursor, "\n");
        if (inserted) commitStructured(inserted.state, inserted.cursor, false);
        else degradeToTextarea((editorDomRef.current?.textContent ?? text).replace(/\u200B/g, ""));
      }
    }
  };
  const degradeToTextarea = (fallback: string) => {
    localEditSignature.current = "";
    pendingCaret.current = null;
    updateCurrentDraft(current => ({ ...current, text: fallback, editorState: undefined, submissionError: "" }));
  };

  const handlePasteEvent = (event: React.ClipboardEvent) => {
    const pastedFiles = extractFilesFromClipboard(event.clipboardData);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(pastedFiles, "paste");
    }
  };

  const handleDropEvent = (event: React.DragEvent) => {
    setIsDraggingOver(false);
    const files = extractFilesFromClipboard(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(files, "drop");
    }
  };

  const attachmentChipShell = attachments.map((attachment, index) => (
    <span className="xn-composer__context-chip" key={(attachment.ref?.id ?? attachment.name) + ":" + index}
      data-testid="composer-attachment-chip" data-attachment-origin={attachment.ref?.origin}>
      <span>{attachment.name}</span>
      <button type="button" aria-label={tf("移除附件：{0}", [attachment.name])} onClick={() => removeAttachment(index)}>
        <IconX size={12} />
      </button>
    </span>
  ));
  const previewChips = Boolean(richComposer && attachmentRoot && attachments.length > 0);

  return (
    <div className={`xn-composer-region xn-composer-region--${variant}`}>
      <form
      aria-label={tr("消息编写器")}
      className={`xn-composer xn-composer--${variant}${topContent ? " xn-composer--with-top-content" : ""}`}
      data-rich-composer={richComposer ? "true" : "false"}
      data-editor={tokenEditor ? "tokens" : structuredDraft ? "text" : "textarea"}
      data-drag-over={isDraggingOver ? "true" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        const delivery = pointerDeliveryRef.current;
        pointerDeliveryRef.current = undefined;
        void handleSend(delivery);
      }}
      onPaste={handlePasteEvent}
      onDragOver={(event) => {
        if (isFileDragEvent(event.dataTransfer)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragEnter={(event) => {
        if (isFileDragEvent(event.dataTransfer)) {
          event.preventDefault();
          setIsDraggingOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setIsDraggingOver(false);
      }}
      onDrop={handleDropEvent}
    >
      <input
        ref={attachInputRef}
        type="file"
        multiple
        hidden
        disabled={disabled || !attachmentsEnabled || legacyAttachmentBusy}
        aria-label={tr("添加附件")}
        data-testid="composer-attachment-input"
        onChange={(event) => {
          if (event.currentTarget.files) void addAttachmentFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {topContent && <div className="xn-composer__top-content">{topContent}</div>}
      {suggestions.length > 0 && (
        <ul id={suggestionListId} role="listbox" className="xn-composer__suggest" aria-label={tr("输入建议")} data-testid="composer-suggestions">
          {suggestions.map((s, index) => (
            <li key={`${s.kind}-${s.token}`}>
              <button
                type="button"
                className={`xn-composer__suggest-item ${index === currentSuggestion ? "xn-composer__suggest-item--active" : ""}`}
                data-testid={`composer-suggestion-${s.kind}-${s.token}`}
                aria-selected={index === currentSuggestion ? "true" : undefined}
                id={`${suggestionListId}-option-${index}`}
                role="option"
                onClick={() => {
                  acceptSuggestion(s);
                  setActiveSuggestion(0);
                }}
              >
                <code>{(s.kind === "command" || s.kind === "goal" || s.kind === "workflow" ? "/" : s.kind === "skill" ? "$" : "@") + (s.label ?? s.token)}</code>
                {s.description && <span>{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(goal || attachments.length > 0 || uploadItems.length > 0 || selectedContextCount > 0) && (
        <div className="xn-composer__chips" aria-label={tr("已添加的上下文")} data-testid="composer-selected-context" aria-live="polite" aria-relevant="additions removals">
          {selectedCapabilities.map(id => {
            const capability = capabilities.find(item => item.id === id);
            return <span className="xn-composer__context-chip" key={id} data-testid={`composer-capability-chip-${id}`}>
              <span>{capability ? capabilityLabel(capability) : id}</span>
              <button type="button" aria-label={tr("移除能力")} onClick={() => updateCurrentDraft(current => ({ ...current,
                selectedCapabilities: (current.selectedCapabilities ?? []).filter(value => value !== id) }))}><IconX size={12} /></button>
            </span>;
          })}
          {goal && (
            <span className="xn-composer__context-chip" data-testid="composer-goal-chip">
              {tr("目标")}
              <button type="button" aria-label={tr("移除目标标记")} onClick={() => setGoal(false)}><IconX size={12} /></button>
            </span>
          )}
          {(["files", "sessions", "skills", "plugins"] as const).flatMap((field) => {
            const kind = field === "files" ? "file" : field === "sessions" ? "session" : field === "skills" ? "skill" : "plugin";
            return selectedContext[field].map((id) => {
              const mention = selectedMention(kind, id);
              return (
                <span className="xn-composer__context-chip" key={kind + ":" + id} data-testid={"composer-context-" + kind}>
                  <span>{mention.label}</span>
                  <button type="button" aria-label={tf("移除上下文：{0}", [mention.label])} onClick={() => toggleContext(mention)}><IconX size={12} /></button>
                </span>
              );
            });
          })}
          {richComposer && uploadItems.length > 0 ? uploadItems.map(item => (
            <span className="xn-composer__context-chip" key={item.id} data-testid="composer-upload-chip" data-upload-state={item.state} title={item.error}>
              {item.state === 'ready' && item.ref ? <React.Suspense fallback={<span>{item.name}</span>}>
                <ComposerAttachmentChips attachments={attachmentsFromRefs([item.ref])} enabled={uploadEnabled}
                  root={uploadOwner.root} sessionId={uploadOwner.sessionId} onRemove={() => removeUpload(item.id)} />
              </React.Suspense> : <span>{item.name}</span>}
              <span role="status">{item.state === 'queued' ? tr('附件排队中') : item.state === 'uploading' ? `${tr('附件上传中')} ${Math.round(item.progress)}%` : item.state === 'failed' ? tr('附件上传失败') : tr('附件已就绪')}</span>
              {item.state === 'uploading' && <progress max={item.size || 1} value={item.uploadedBytes} aria-label={item.name} />}
              {item.state === 'failed' && <button type="button" disabled={!uploadEnabled || ownerMismatch} onClick={() => uploadStore.retry(item.id)}>{tr('重试附件')}</button>}
              {item.state !== 'ready' && <button type="button" aria-label={tf('移除附件：{0}', [item.name])} onClick={() => removeUpload(item.id)}>{item.state === 'uploading' || item.state === 'queued' ? tr('取消') : <IconX size={12} />}</button>}
            </span>
          )) : previewChips ? (
            <React.Suspense fallback={attachmentChipShell}>
              <ComposerAttachmentChips
                attachments={attachments}
                enabled={richComposer}
                root={attachmentRoot}
                sessionId={attachmentSessionId}
                onRemove={removeAttachment}
              />
            </React.Suspense>
          ) : attachmentChipShell}
        </div>
      )}
      <ComposerMaterialManifest materials={materialRows} />
      {ownerMismatch && <div className="xn-composer__error" role="alert">{tr("附件属于原草稿，请移除后重新添加。")}</div>}
      {legacyAttachmentBusy && <div className="xn-composer__status" role="status">{tr("正在读取附件...")}</div>}
      {attachmentError && <div className="xn-composer__error" role="alert">{attachmentError}</div>}
      {draft.hadAttachments && !uploadStore.hasUnready() && <button type="button" onClick={() => { missingAttachmentDrafts.delete(uploadOwner.draftId); updateCurrentDraft(current => ({ ...current, hadAttachments: false, attachmentError: '' })); }}>{tr('移除未恢复附件')}</button>}
      {selectedCapabilities.length > 0 && <div className="xn-composer__status" role="status" data-testid="composer-capability-hint">{tr('已添加能力。描述具体需求后发送，即可使用。')}</div>}
      {sendDisabled && (hasSendableContent || goal || modelRecovery) && <div className="xn-composer__status xn-composer__setup" role="status" aria-live="polite" data-testid="composer-send-unavailable">
        <span>{sendDisabledReason || tr('选择或配置模型后即可发送。')}</span>
        {modelRecovery?.kind === "loading" && <button type="button" data-testid="composer-model-recovery-loading" disabled aria-busy="true">{tr('正在加载…')}</button>}
        {modelRecovery?.kind === "error" && <button type="button" data-testid="composer-model-recovery-retry" onClick={modelRecovery.onRetry}>{tr('重试')}</button>}
        {modelRecovery?.kind === "missing" && <button type="button" data-testid="composer-model-recovery-configure" onClick={modelRecovery.onConfigure}>{tr('配置模型')}</button>}
        {!modelRecovery && startActions?.onModels && <button type="button" onClick={startActions.onModels}>{tr('配置模型')}</button>}
      </div>}
      {submissionError && <div className="xn-composer__error" role="alert">{submissionError}</div>}
      {draft.deliveryUnconfirmed && <div className="xn-composer__error" role="status">{tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。')}</div>}
      {draft.pendingSubmission && <div className="xn-composer-recovery xn-composer-recovery--sending" data-testid="composer-sending" role="status">
        <span>{tr('正在发送…')}</span>
        <p className="xn-composer-recovery__preview">{draft.pendingSubmission.draft.text || tr('附件与上下文')}</p>
      </div>}
      <ComposerRecoveryPanel drafts={draft.recoverableDrafts ?? []}
        references={availableMentions}
        capabilities={capabilities}
        attachmentState={recovered => !recovered.attachmentOwner ? 'unknown-scope'
          : attachmentOwnerMatches(recovered.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner) ? 'available' : 'different-scope'}
        onRestore={index => { updateCurrentDraft(current => recoverComposerDraft(current, index)); localInputRef.current?.focus(); }}
        onDiscard={index => {
          const discarded = draftsRef.current.get(scopedDraftKey)?.recoverableDrafts?.[index];
          if (discarded && hasUnscopedComposerAttachments(discarded)) {
            setAttachmentError(tr('无法确认原附件的归属范围，已保留恢复草稿。'));
            return;
          }
          updateCurrentDraft(current => ({ ...current,
            recoverableDrafts: current.recoverableDrafts?.filter((_, position) => position !== index) }));
          if (!discarded) return;
          const owner = discarded.attachmentOwner;
          if (owner && !composerDraftIdentityIsOwned(draftsRef.current.values(), owner.draftId)) {
            const manager = getComposerAttachmentUploadStore({ root: owner.root, sessionId: owner.sessionId, draftKey: owner.draftId, remote: owner.remote });
            manager.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
            for (const item of manager.getSnapshot()) manager.remove(item.id);
            attachmentPublishers.get(manager)?.();
            attachmentPublishers.delete(manager);
            manager.invalidate();
            for (const ref of editorAttachmentRefs(discarded.attachments)) disposeRef(ref, owner);
          }
        }} />
      {tokenEditor ? <ComposerStructuredEditor
        html={editorSurface.html}
        resetKey={editorSurface.key}
        caret={editorSurface.caret}
        disabled={disabled}
        label={tr("输入消息或指令...")}
        describedBy={minimal ? undefined : `${suggestionListId}-keyboard-help`}
        controls={suggestions.length ? suggestionListId : undefined}
        expanded={suggestions.length > 0}
        activeDescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        editorRef={element => {
          editorDomRef.current = element;
          if (typeof inputRef === "function") inputRef(element);
          else if (inputRef && typeof inputRef === "object") {
            (inputRef as React.MutableRefObject<HTMLElement | null>).current = element;
          }
        }}
        onLocalChange={(state, cursor) => commitStructured(state, cursor, true)}
        onDegrade={degradeToTextarea}
        onKeyDown={handleKeyDown}
        onPaste={handlePasteEvent}
        onDrop={handleDropEvent}
        onDragOver={event => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onCompositionStart={() => { compositionActiveRef.current = true; }}
        onCompositionEnd={() => { deferCompositionEnd(() => { compositionActiveRef.current = false; }); }}
        onCursor={setCursorOffset}
      /> : <textarea
        ref={attachRef}
        className="xn-composer__input"
        data-editor={structuredDraft ? "text" : "textarea"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCursorOffset(e.target.selectionStart);
          historyIndexRef.current = null;
          setSuggestDismissed(false);
          setActiveSuggestion(0);
          setSubmissionError("");
        }}
        onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onClick={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
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
        onPaste={handlePasteEvent}
        onDragOver={(event) => {
          if (isFileDragEvent(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleDropEvent}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-label={tr("输入消息或指令...")}
        aria-controls={suggestions.length ? suggestionListId : undefined}
        aria-expanded={suggestions.length > 0}
        aria-activedescendant={currentSuggestion >= 0 ? `${suggestionListId}-option-${currentSuggestion}` : undefined}
        aria-describedby={minimal ? undefined : `${suggestionListId}-keyboard-help`}
      />}
      <div className="xn-composer__row">
        <div className="xn-composer__tools">
          {<div className="xn-composer__actions" role="group" aria-label={tr("输入辅助")}>
            <div className="xn-composer__plus-wrap" ref={plusRef}>
              {/* 附件一级入口（ZCode attachmentAction 式）：直接调现有附件逻辑，
                  「+」菜单保留给 mentions/命令，减少一次点击。 */}
              <button
                type="button"
                className="xn-composer__chip"
                aria-label={tr("添加附件")}
                title={tr("添加附件")}
                data-testid="composer-attachment"
                disabled={disabled || !attachmentsEnabled || legacyAttachmentBusy}
                onClick={openAttachmentPicker}
              >
                <IconPaperclip size={16} />
              </button>
              <button
                ref={plusButtonRef}
                type="button"
                className="xn-composer__chip xn-composer__plus"
                aria-label={tr("添加上下文或能力")}
                aria-haspopup="menu"
                aria-expanded={plusOpen}
                aria-controls={plusOpen ? plusMenuId : undefined}
                data-testid="composer-plus"
                disabled={disabled}
                onClick={() => setPlusOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event)) return;
                  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPlusOpen(true);
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {plusOpen && (
                <div
                  ref={menuRef}
                  id={plusMenuId}
                  className="xn-composer__plus-menu"
                  role="menu"
                  aria-label={tr("添加上下文或能力")}
                  onKeyDown={handlePlusMenuKeyDown}
                  onBlur={(event) => {
                    // Native mouse/touch focus loss can report null before click.
                    // Outside pointerdown and a real Tab focus destination dismiss it.
                    if (event.relatedTarget && !plusRef.current?.contains(event.relatedTarget as Node)) closePlusMenu();
                  }}
                >
                  <div className="xn-composer-add-search"><Search size={15} aria-hidden="true" /><input
                    type="search" value={addSearch} data-testid="composer-add-search"
                    aria-label={tr('搜索能力或上下文')} placeholder={tr('搜索能力或上下文')}
                    onChange={event => setAddSearch(event.target.value)} /></div>
                  <div className="xn-composer__plus-heading">{tr("添加")}</div>
                  <button type="button" role="menuitem" disabled={!attachmentsEnabled || legacyAttachmentBusy} onClick={openAttachmentPicker}>
                    <IconPaperclip size={16} />{tr("附件")}
                  </button>
                  {canOfferGoal && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-pressed={goal}
                      onClick={() => {
                        if (startActions?.onGoal) startActions.onGoal();
                        else setGoal((current) => !current);
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Target size={16} aria-hidden="true" />{goal ? tr("移除目标标记") : tr("添加为目标")}</button>
                  )}
                  {canOfferWorkflow && startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onWorkflow();
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Workflow size={16} aria-hidden="true" />{tr("创建工作流")}</button>
                  )}
                  {startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onPlugins();
                        closePlusMenu();
                      }}
                    ><Blocks size={16} aria-hidden="true" />{tr("管理插件")}</button>
                  )}
                  <ComposerCapabilityMenu items={visibleCapabilities} selected={selectedCapabilities} onToggle={item => {
                    toggleCapability(item); closePlusMenu(); localInputRef.current?.focus();
                  }} />
                  {(["plugin", "file", "session", "skill"] as const).map((kind) => {
                    const items = visibleMentions.filter((mention) => mention.kind === kind).slice(0, addSearch.trim() ? 50 : 8);
                    if (items.length === 0) return null;
                    const field = kind === "file" ? "files" : kind === "session" ? "sessions" : kind === "skill" ? "skills" : "plugins";
                    const heading = kind === "plugin" ? tr("插件") : kind === "file" ? tr("文件") : kind === "session" ? tr("任务") : tr("技能");
                    return (
                      <div className="xn-composer__plus-group" role="group" aria-label={heading} key={kind}>
                        <div className="xn-composer__plus-heading">{heading}</div>
                        {items.map((mention) => (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={selectedContext[field].includes(mention.id)}
                            key={mention.id}
                            title={mention.description}
                            onClick={() => {
                              toggleContext(mention);
                              closePlusMenu();
                              localInputRef.current?.focus();
                            }}
                          >{mention.label}</button>
                        ))}
                      </div>
                    );
                  })}
                  {addSearch.trim() && !visibleCapabilities.length && !visibleMentions.length && <div className="xn-composer__plus-empty" role="status">{tr('没有匹配的能力或上下文')}</div>}
                  {availableMentions.length === 0 && !startActions && (
                    <div className="xn-composer__plus-empty">{tr("暂无可添加的上下文")}</div>
                  )}
                  <div className="xn-composer__plus-help">{tr("@ 文件、插件或会话 · $ 技能 · / 命令")}</div>
                </div>
              )}
            </div>
          </div>}
          {(controls || footer) && <div className="xn-composer__settings" role="group" aria-label={tr("运行选项")}>{controls ?? footer}</div>}
          {running && queueWhenRunning && guideWhenRunning && <CurrentTurnInput mode={effectiveFollowupMode}
            disabled={disabled || queueBusy || Boolean(draft.pendingSubmission)}
            onChange={mode => { setLocalFollowupMode(mode); onFollowupModeChange?.(mode); }} />}
          {!minimal && <span id={`${suggestionListId}-keyboard-help`} className="xn-composer__keyboard-help">
            {queueWhenRunning && running
              ? guideWhenRunning ? `${effectiveFollowupMode === 'guide' ? tr('引导当前轮') : tr('加入队列')} · ${displayBinding('Mod+Enter', platform)} ${effectiveFollowupMode === 'guide' ? tr('加入队列') : tr('立即发送')}`
                : sendShortcut === "mod-enter" ? tf("{0} 排队 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 排队 · Shift+Enter 换行")
              : sendShortcut === "mod-enter" ? tf("{0} 发送 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 发送 · Shift+Enter 换行")}
          </span>}
        </div>
        <div className="xn-composer__submit-actions">
          {showQueueControl && <button type="submit" disabled={isSendDisabled}
            onClick={event => { pointerDeliveryRef.current = followupPointerDelivery(effectiveFollowupMode, event, platform); }}
            className="xn-composer__send xn-composer__queue" aria-label={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")}
            title={tr(queueBusy ? "正在排队…" : effectiveFollowupMode === 'guide' ? '引导当前轮' : "加入队列")} data-testid="composer-queue">
            {queueBusy ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
          </button>}
          {showStopControl ? (
            <button
              type="button"
              disabled={stopping}
              className="xn-composer__send xn-composer__stop"
              aria-label={stopping ? tr("正在停止") : tr("停止")}
              aria-keyshortcuts="Escape"
              title={stopping ? tr("正在停止") : tr("停止当前任务 (Esc)")}
              data-testid="composer-stop"
              onClick={onStop}
            >
              {stopping ? <IconLoader size={16} /> : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              )}
            </button>
          ) : !running && (
            <button
              type="submit"
              disabled={isSendDisabled}
              className="xn-composer__send"
              aria-label={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
              title={tr(draft.pendingSubmission ? "正在发送…" : "发送")}
            >
              {draft.pendingSubmission ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
            </button>
          )}
        </div>
      </div>
      </form>
    </div>
  );
}

/** 时段问候（ZCode 式）：按本地时间分五档。 */
export function heroGreeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 9) return tr("早上好呀，新的一天开始啦");
  if (h >= 9 && h < 12) return tr("上午好呀，有什么想让我帮忙的吗");
  if (h >= 12 && h < 14) return tr("中午好呀，要不要先休息一下");
  if (h >= 14 && h < 18) return tr("下午好呀，接下来交给我吧");
  if (h >= 18 && h < 23) return tr("晚上好呀，今天辛苦啦");
  return tr("夜深啦，别忘了照顾好自己哦");
}

export type WorkbenchHeaderProps = {
  session?: WorkbenchSession | null;
  /** Right side: view switcher and other real controls. */
  actions?: React.ReactNode;
  menuItems?: React.ReactNode;
  pinned?: boolean;
  onTogglePin?: () => void;
  onRefresh?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
};

/** Conversation header. Renders nothing without a session — the hero owns that state. */
export function WorkbenchHeader({
  session,
  actions,
  menuItems,
  pinned = false,
  onTogglePin,
  onRefresh,
  onRename,
  onDelete,
}: WorkbenchHeaderProps) {
  if (!session) {
    return null;
  }

  const title = session.title || session.task || tr("未命名任务");
  // Project folder name for the Codex 风格 header mark; no visual change in the default palette.
  const project = session.root?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined;
  const hasMenuActions = Boolean(onRefresh || onTogglePin || onRename || onDelete || menuItems);

  return (
    <header
      aria-label={title}
      className="xn-conv-header"
    >
      <h2 className="xn-conv-header__title" data-project={project}>
        {project && <Folder size={16} className="xn-conv-header__project-icon" aria-hidden="true" />}
        <span>{title}</span>
      </h2>
      <div className="xn-conv-header__main">
        <div className="xn-conv-header__spacer" />
        <div className="xn-conv-header__tools">
          {actions}
          {hasMenuActions && (
            <details
              className="xn-conv-header__more"
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  event.currentTarget.removeAttribute("open");
                }
              }}
              onKeyDown={event => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.removeAttribute("open");
                event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
              }}
            >
              <summary aria-label={tr("更多操作")} title={tr("更多操作")}>⋯</summary>
              <div
                className="xn-conv-header__menu"
                onClick={event => {
                  if (!(event.target as HTMLElement).closest("button")) return;
                  const details = event.currentTarget.closest("details");
                  details?.removeAttribute("open");
                  details?.querySelector<HTMLElement>("summary")?.focus();
                }}
              >
                {onRefresh && (
                  <button type="button" className="xn-conv-header__action" aria-label={tr("刷新历史")} title={tr("刷新")} onClick={onRefresh}>
                    <IconRefresh size={14} />
                    <span>{tr("刷新历史")}</span>
                  </button>
                )}
                {onTogglePin && (
                  <button
                    type="button"
                    className={`xn-conv-header__action ${pinned ? "xn-conv-header__action--pinned" : ""}`}
                    aria-label={pinned ? tr("取消置顶") : tr("置顶任务")}
                    aria-pressed={pinned}
                    title={pinned ? tr("取消置顶") : tr("置顶")}
                    data-testid="xn-conv-pin"
                    onClick={onTogglePin}
                  >
                    <IconPin size={14} />
                    <span>{pinned ? tr("取消置顶") : tr("置顶任务")}</span>
                  </button>
                )}
                {onRename && (
                  <button type="button" className="xn-conv-header__action" aria-label={tr("重命名任务")} title={tr("重命名")} onClick={onRename}>
                    <IconPencil size={14} />
                    <span>{tr("重命名任务")}</span>
                  </button>
                )}
                {menuItems}
                {onDelete && (
                  <button type="button" className="xn-conv-header__action xn-conv-header__action--danger" aria-label={tr("删除任务")} title={tr("删除")} onClick={onDelete}>
                    <IconTrash size={14} />
                    <span>{tr("删除任务")}</span>
                  </button>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </header>
  );
}

export type XuenessWorkbenchProps = {
  sessions: SessionSummary[];
  activeSessionId?: string | null;
  activeSession?: WorkbenchSession | null;
  timelineRows: TimelineRow[];
  pendingApprovals?: PendingApproval[];
  onSelectSession?: (id: string) => void;
  onApprove?: (pending: PendingApproval) => void | Promise<unknown>;
  onApproveAll?: (items: PendingApproval[]) => void | Promise<unknown>;
  onSend?: (text: string) => boolean | void | Promise<boolean | void>;
  onRefresh?: () => void | Promise<unknown>;
  composerDisabled?: boolean;
};

export function XuenessWorkbench({
  sessions,
  activeSessionId,
  activeSession,
  timelineRows,
  pendingApprovals = activeSession?.pending ?? [],
  onSelectSession,
  onApprove,
  onApproveAll,
  onSend,
  onRefresh,
  composerDisabled = false,
}: XuenessWorkbenchProps) {
  const composerInputRef = useRef<HTMLElement | null>(null);
  const liveText = activeSession?.streaming?.text ?? "";
  const duplicateLiveText = Boolean(liveText && timelineRows.some(row => row.kind === "assistant" && row.text === liveText));
  const visibleRows: TimelineRow[] = liveText && !duplicateLiveText
    ? [...timelineRows, { kind: "assistant", seq: Math.max(0, ...timelineRows.map(row => row.seq)) + 1, turnId: activeSession?.streaming?.id ?? "live", text: liveText }]
    : timelineRows;
  return (
    <div
      data-testid="xueness-workbench"
      className="xn-shell"
      style={{
        width: "100%",
        height: "100%",
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <div className="xn-shell__body" style={{ flex: 1, minHeight: 0 }}>
        {/* 侧边栏：任务列表 */}
        <aside className="xn-shell__sidebar">
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--bg-subtle)",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>{tr("任务列表")}</span>
            {onRefresh && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onRefresh()}
              >{tr("刷新")}</Button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            <TaskList
              sessions={sessions}
              activeId={activeSessionId}
              onSelect={onSelectSession}
            />
          </div>
        </aside>

        {/* 主区域 */}
        <main className="xn-shell__main">
          <WorkbenchHeader session={activeSession} />

          {pendingApprovals && pendingApprovals.length > 0 && (
            <div style={{ padding: "12px 16px 0" }}>
              <Approvals pending={pendingApprovals} onApprove={onApprove} onApproveAll={onApproveAll} busy={composerDisabled} />
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <Timeline rows={visibleRows} />
            {activeSession?.streaming?.status === "interrupted" && <SessionRecoveryNotice kind="interrupted"
              reason={tr(liveText ? '本轮已停止，已保留收到的内容。' : '本轮已停止，可以继续补充。')}
              actionLabel={tr('接着做')} onAction={() => composerInputRef.current?.focus()} />}
          </div>

          <Composer
            inputRef={composerInputRef}
            onSend={onSend}
            disabled={composerDisabled || !activeSession}
          />
        </main>
      </div>
    </div>
  );
}
