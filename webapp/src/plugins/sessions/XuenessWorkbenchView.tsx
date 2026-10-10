import { t as tr, tf } from '../../i18n';
import React, { useEffect, useId, useRef, useState } from "react";
import type {
  WorkbenchSession,
  SessionSummary,
  TimelineRow,
  PendingApproval,
} from "../../xuenessWorkbench";
import { Button, Badge, EmptyState } from "../../ui/primitives";
import { IconArrowUp, IconLoader, IconPaperclip, IconPencil, IconPin, IconRefresh, IconTrash, IconX } from "../../ui/icons";
import type { ComposerCapability, ComposerInput } from "../../xuenessComposer";
import { ComposerCapabilityMenu, MAX_SELECTED_COMPOSER_CAPABILITIES, capabilityLabel, matchesComposerSearch } from './ComposerCapabilityMenu';
import { Search, Target, Workflow, Blocks } from 'lucide-react';
import { completionPresentation } from './completionPresentation';
import { deferCompositionEnd, displayBinding, isModKeyPressed, isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { formatCommandArgv } from "../../xuenessWorkbench";

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

export type ApprovalsProps = {
  pending: PendingApproval[];
  onApprove?: (pending: PendingApproval) => void | Promise<unknown>;
  busy?: boolean;
};

export function Approvals({ pending, onApprove, busy = false }: ApprovalsProps) {
  if (!pending || pending.length === 0) {
    return (
      <div data-testid="approvals-empty" className="p-2 text-xs text-[var(--fg-muted)]">{tr("无待审批")}</div>
    );
  }

  return (
    <div
      aria-label={tr("待审批操作")}
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
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--warn-fg)" }}>{tr("需要审批的操作 (")}{pending.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {pending.map((p) => {
          const readableSubject = formatSubject(p.kind ?? p.name, p.subject);
          return (
            <div
              key={p.tool_call_id}
              data-testid={`approval-item-${p.tool_call_id}`}
              className="xn-approval-item"
              style={{
                border: "1px solid var(--border)",
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
                  {p.kind ?? p.name}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    overflowWrap: "anywhere",
                    color: "var(--fg)",
                  }}
                >
                  {readableSubject}
                </span>
              </div>
              {p.preview && (
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
                  {p.preview}
                </div>
              )}
              {onApprove && (
                <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}>
                  {p.granted && <span className="xn-approval-granted" role="status">{tr("已批准，等待执行")}</span>}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onApprove(p)}
                  >{tr(busy ? "正在继续…" : p.granted ? "继续执行" : "批准并重试")}</Button>
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
      items.push({ kind: "command", token: "compact", description: tr("按预算压缩当前上下文") });
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
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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
};

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
    if (!scopeData || typeof scopeData.text !== "string") return null;
    return scopeData;
  } catch {
    return null;
  }
}

export function persistDraft(
  workspaceKey: string,
  scope: string,
  draft: Pick<ComposerDraftState, "text" | "goal" | "selectedCapabilities" | "selectedContext">,
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
      draft.text.trim() ||
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
      file.scopes[scope] = {
        text: draft.text,
        goal: draft.goal,
        selectedCapabilities: draft.selectedCapabilities,
        selectedContext: draft.selectedContext,
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
  onSend?: (text: string, input?: ComposerInput, onAccepted?: () => void) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  /** Disable sending while keeping the prompt editable (for model/permission gates). */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  running?: boolean;
  queueWhenRunning?: boolean;
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
  inputRef?: React.Ref<HTMLTextAreaElement>;
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
};

export type ComposerDraftState = {
  text: string;
  attachments: ComposerInput["attachments"];
  goal: boolean;
  selectedCapabilities?: string[];
  selectedContext: Pick<ComposerInput, "files" | "sessions" | "skills" | "plugins">;
  submissionError: string;
  attachmentError: string;
  revision: number;
};

function emptyComposerDraft(text = ""): ComposerDraftState {
  return {
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
  next.set(draftKey, { ...emptyComposerDraft(), revision: current.revision + 1 });
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
  running = false,
  queueWhenRunning = false,
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
}: ComposerProps) {
  const localDraftsRef = useRef<Map<string, ComposerDraftState>>(new Map());
  const draftsRef = draftStore ?? localDraftsRef;
  const resolvedWorkspaceKey = workspaceKey ?? "default";
  const scopedDraftKey = `${resolvedWorkspaceKey}:${draftKey}`;
  const [draftRenderVersion, setDraftRenderVersion] = useState(0);
  const pendingSubmissionsRef = useRef(new Map<string, number>());
  const submissionTicketRef = useRef(0);
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
      draftsRef.current.set(scopedDraftKey, {
        text: persisted.text,
        attachments: [],
        goal: Boolean(persisted.goal),
        selectedCapabilities: persisted.selectedCapabilities ?? [],
        selectedContext: {
          files: persisted.selectedContext?.files ?? [],
          sessions: persisted.selectedContext?.sessions ?? [],
          skills: persisted.selectedContext?.skills ?? [],
          plugins: persisted.selectedContext?.plugins ?? [],
        },
        submissionError: "",
        attachmentError: "",
        revision: 0,
      });
    } else {
      draftsRef.current.set(scopedDraftKey, emptyComposerDraft(defaultValue));
    }
  }
  const draft = draftsRef.current.get(scopedDraftKey)!;
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
    persistDraft(resolvedWorkspaceKey, draftKey, nextDraft);
    setDraftRenderVersion(version => version + 1);
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
    if (nextText === current.text && !current.submissionError) return current;
    return { ...current, text: nextText, submissionError: "" };
  });
  const setGoal = (value: boolean | ((previous: boolean) => boolean)) => updateCurrentDraft(current => {
    const nextGoal = typeof value === "function" ? value(current.goal) : value;
    return nextGoal === current.goal ? current : { ...current, goal: nextGoal };
  });
  const attachmentBusyRef = useRef(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const plusRef = useRef<HTMLDivElement | null>(null);
  const plusButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  // Local handle for the helper buttons; external inputRef stays in sync.
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachRef = (el: HTMLTextAreaElement | null) => {
    localInputRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") {
      (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }
  };
  const updateAttachments = (next: ComposerInput["attachments"]) => updateCurrentDraft(current =>
    current.attachments === next ? current : { ...current, attachments: next });
  const setAttachmentError = (message: string) => updateCurrentDraft(current =>
    current.attachmentError === message ? current : { ...current, attachmentError: message }, false);
  const setSubmissionError = (message: string) => updateCurrentDraft(current =>
    current.submissionError === message ? current : { ...current, submissionError: message }, false);
  const addAttachmentFiles = async (filesToAdd: FileList | File[]) => {
    const incoming = Array.from(filesToAdd);
    if (incoming.length === 0 || disabled || running || attachmentBusyRef.current) return;
    attachmentBusyRef.current = true;
    setAttachmentBusy(true);
    setAttachmentError("");
    const currentAttachments = (draftsRef.current.get(draftKey) ?? emptyComposerDraft()).attachments;
    let next = [...currentAttachments];
    const initialCount = next.length;
    let totalBytes = next.reduce((sum, item) => sum + composerAttachmentBytes(item.data), 0);
    let rejected = false;
    let failed = false;
    for (const file of incoming) {
      if (
        next.length >= COMPOSER_ATTACHMENT_LIMITS.count ||
        file.size > COMPOSER_ATTACHMENT_LIMITS.eachBytes ||
        totalBytes + file.size > COMPOSER_ATTACHMENT_LIMITS.totalBytes
      ) {
        rejected = true;
        continue;
      }
      try {
        const data = await encodeComposerFile(file);
        next = [...next, { name: file.name, mimeType: file.type || "application/octet-stream", data }];
        totalBytes += file.size;
      } catch {
        failed = true;
      }
    }
    const added = next.slice(initialCount);
    if (added.length > 0) updateCurrentDraft(current => ({ ...current, attachments: [...current.attachments, ...added] }));
    if (rejected) setAttachmentError(tr("附件最多 4 个，单个不超过 2 MiB，总量不超过 4 MiB。"));
    else if (failed) setAttachmentError(tr("读取附件失败，请重新选择。"));
    attachmentBusyRef.current = false;
    setAttachmentBusy(false);
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

  const trimmed = text.trim();
  const selectedContextCount = Object.values(selectedContext).reduce((sum, values) => sum + values.length, selectedCapabilities.length);
  const visibleCapabilities = capabilities.filter(item => matchesComposerSearch(addSearch,
    item.id, item.label, item.labelEn, item.description, item.descriptionEn));
  const visibleMentions = availableMentions.filter(item => matchesComposerSearch(addSearch, item.id, item.label, item.description));
  const canOfferGoal = Boolean(startActions?.canGoal);
  const canOfferWorkflow = Boolean(startActions?.canWorkflow);
  const hasSendableContent = trimmed.length > 0 || attachments.length > 0 || selectedContextCount > 0;
  const isSendDisabled = disabled || sendDisabled || queueBusy || pendingSubmissionsRef.current.has(scopedDraftKey) || (running && !queueWhenRunning) || attachmentBusy || !hasSendableContent;
  // 停止/发送互斥（对标 ZCode showStopControl = canStop && !hasDraftToSubmit）：
  // 运行中且草稿为空时，停止按钮独占发送槽位；有草稿时显示排队发送键。
  // queueWhenRunning=false 时发送键在运行中没有排队语义，停止键始终保留。
  const canStop = running && Boolean(onStop);
  const showStopControl = canStop && (!queueWhenRunning || !hasSendableContent);
  const showQueueControl = running && queueWhenRunning && hasSendableContent;
  const suggestions = !disabled && !suggestDismissed && historyIndexRef.current === null
    ? contextComposerSuggestions(text, commands, availableMentions, {
      canGoal: canOfferGoal,
      canWorkflow: canOfferWorkflow,
      canCompact: Boolean(startActions?.canCompact),
    }, cursorOffset ?? text.length)
    : [];
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const currentSuggestion = suggestions.length > 0 ? Math.min(activeSuggestion, suggestions.length - 1) : -1;

  useEffect(() => {
    if (!running || !onStop || stopping) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat || isImeCompositionKey(event)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("textarea, input, select, [contenteditable='true']")) return;
      if (
        plusOpen ||
        suggestions.length > 0 ||
        document.querySelector('[role="dialog"], [aria-modal="true"], .xn-composer-toolbar__mode[open], .xn-composer-toolbar__model[open]')
      ) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener("keydown", onWindowKeyDown);
    return () => document.removeEventListener("keydown", onWindowKeyDown);
  }, [onStop, plusOpen, running, stopping, suggestions.length]);

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

  const acceptSuggestion = (suggestion: ContextComposerSuggestion) => {
    const cursor = localInputRef.current?.selectionStart ?? cursorOffset ?? text.length;
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

  const handleSend = async () => {
    if (isSendDisabled || pendingSubmissionsRef.current.has(scopedDraftKey) || !onSend) return;
    setSubmissionError("");
    const submittedDraft = draftsRef.current.get(scopedDraftKey) ?? emptyComposerDraft(defaultValue);
    const submittedRevision = submittedDraft.revision;
    const draft: ComposerInput = {
      attachments: submittedDraft.attachments,
      files: submittedDraft.selectedContext.files,
      sessions: submittedDraft.selectedContext.sessions,
      skills: submittedDraft.selectedContext.skills,
      plugins: submittedDraft.selectedContext.plugins,
      capabilities: submittedDraft.selectedCapabilities ?? [],
      goal: submittedDraft.goal,
    };
    const ticket = ++submissionTicketRef.current;
    pendingSubmissionsRef.current.set(scopedDraftKey, ticket);
    clearPersistedDraft(resolvedWorkspaceKey, draftKey);
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
    setDraftRenderVersion(version => version + 1);
    let accepted = false;
    const release = () => {
      if (pendingSubmissionsRef.current.get(scopedDraftKey) !== ticket) return;
      pendingSubmissionsRef.current.delete(scopedDraftKey);
      setDraftRenderVersion(version => version + 1);
    };
    const acknowledge = () => { accepted = true; release(); };
    const restore = (error = "") => {
      if (accepted) return;
      const next = restoreSubmittedComposerDraft(draftsRef.current, scopedDraftKey, clearedRevision, submittedDraft, error);
      if (next !== draftsRef.current) {
        draftsRef.current = next;
        persistDraft(resolvedWorkspaceKey, draftKey, submittedDraft);
        setDraftRenderVersion(version => version + 1);
      }
    };
    try {
      const sent = await onSend(submittedDraft.text.trim(), draft, acknowledge);
      if (sent === false) restore();
    } catch (error) {
      restore(error instanceof Error ? error.message : tr("发送失败，草稿已保留。"));
    } finally { release(); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = compositionActiveRef.current || isImeCompositionKey(e);
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
        if (historyIndexRef.current === null && text.length === 0) {
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
      }
    }
  };

  const handlePasteEvent = (event: React.ClipboardEvent) => {
    const pastedFiles = extractFilesFromClipboard(event.clipboardData);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(pastedFiles);
    }
  };

  const handleDropEvent = (event: React.DragEvent) => {
    setIsDraggingOver(false);
    const files = extractFilesFromClipboard(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(files);
    }
  };

  return (
    <div className={`xn-composer-region xn-composer-region--${variant}`}>
      <form
      aria-label={tr("消息编写器")}
      className={`xn-composer xn-composer--${variant}${topContent ? " xn-composer--with-top-content" : ""}`}
      data-drag-over={isDraggingOver ? "true" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void handleSend();
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
        disabled={disabled || attachmentBusy}
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
      {(goal || attachments.length > 0 || selectedContextCount > 0) && (
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
          {attachments.map((attachment, index) => (
            <span className="xn-composer__context-chip" key={attachment.name + ":" + index} data-testid="composer-attachment-chip">
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={tf("移除附件：{0}", [attachment.name])}
                onClick={() => updateAttachments(attachments.filter((_, itemIndex) => itemIndex !== index))}
              ><IconX size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {attachmentBusy && <div className="xn-composer__status" role="status">{tr("正在读取附件...")}</div>}
      {attachmentError && <div className="xn-composer__error" role="alert">{attachmentError}</div>}
      {selectedCapabilities.length > 0 && <div className="xn-composer__status" role="status" data-testid="composer-capability-hint">{tr('已添加能力。描述具体需求后发送，即可使用。')}</div>}
      {sendDisabled && (hasSendableContent || goal) && <div className="xn-composer__status xn-composer__setup" role="status" data-testid="composer-send-unavailable">
        <span>{sendDisabledReason || tr('选择或配置模型后即可发送。')}</span>
        {startActions?.onModels && <button type="button" onClick={startActions.onModels}>{tr('配置模型')}</button>}
      </div>}
      {submissionError && <div className="xn-composer__error" role="alert">{submissionError}</div>}
      <textarea
        ref={attachRef}
        className="xn-composer__input"
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
      />
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
                disabled={disabled || attachmentBusy}
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
                  <button type="button" role="menuitem" disabled={attachmentBusy} onClick={openAttachmentPicker}>
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
          {!minimal && <span id={`${suggestionListId}-keyboard-help`} className="xn-composer__keyboard-help">
            {queueWhenRunning && running
              ? sendShortcut === "mod-enter" ? tf("{0} 排队 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 排队 · Shift+Enter 换行")
              : sendShortcut === "mod-enter" ? tf("{0} 发送 · Enter 换行", [displayBinding("Mod+Enter")]) : tr("Enter 发送 · Shift+Enter 换行")}
          </span>}
        </div>
        <div className="xn-composer__submit-actions">
          {showQueueControl && <button type="submit" disabled={isSendDisabled}
            className="xn-composer__send xn-composer__queue" aria-label={tr(queueBusy ? "正在排队…" : "加入队列")}
            title={tr(queueBusy ? "正在排队…" : "加入队列")} data-testid="composer-queue">
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
              aria-label={tr(pendingSubmissionsRef.current.has(scopedDraftKey) ? "正在发送…" : "发送")}
              title={tr(pendingSubmissionsRef.current.has(scopedDraftKey) ? "正在发送…" : "发送")}
            >
              {pendingSubmissionsRef.current.has(scopedDraftKey) ? <IconLoader size={16} /> : <IconArrowUp size={16} />}
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
      <h2 className="xn-conv-header__title" data-project={project}>{title}</h2>
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
  onSend,
  onRefresh,
  composerDisabled = false,
}: XuenessWorkbenchProps) {
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
              <Approvals pending={pendingApprovals} onApprove={onApprove} />
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <Timeline rows={visibleRows} />
            {activeSession?.streaming?.status === "interrupted" && liveText && <p role="status">{tr("输出已中断，已保留收到的内容。")}</p>}
          </div>

          <Composer
            onSend={onSend}
            disabled={composerDisabled || !activeSession}
          />
        </main>
      </div>
    </div>
  );
}
