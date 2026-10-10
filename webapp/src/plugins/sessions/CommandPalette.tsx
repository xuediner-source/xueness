import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Clock3, Folder } from "lucide-react";
import { t as tr, tf, useLocale } from "../../i18n";
import { fuzzyFilter } from "../../xuenessFuzzy";
import type { SessionSummary } from "../../xuenessWorkbench";
import { createDebouncer } from "./debounce";
import { deferCompositionEnd, isImeComposingEvent } from "../../xuenessShortcutDisplay";
import { searchTranscripts, type TranscriptHit, type TranscriptSearchState } from "./sessionSearch";
import "./sessions.css";

type PaletteCommand = { id: string; label: string; description: string };
type CommandEntry = { kind: "command"; id: string; label: string; description: string };
type SessionEntry = { kind: "session"; id: string; session: SessionSummary; label: string; description: string; disabled: boolean; snippet?: string };
export type CommandPaletteEntry = CommandEntry | SessionEntry;
type ElementRef<T extends HTMLElement> = { current: T | null };

const SESSION_STATUS_LABELS: Record<string, string> = {
  created: "待执行", pending: "等待中", queued: "已排队", running: "运行中", awaiting_user: "等待答复",
  pausing: "正在暂停", paused: "已暂停", stopping: "正在取消", cancelled: "已取消",
  completed: "已完成", failed: "失败", interrupted: "已中断", blocked: "受阻",
  closed: "已关闭", needs_review: "需要审核", provider_error: "供应商错误",
};
const EMPTY_TRANSCRIPT_HITS: TranscriptHit[] = [];

export function commandPaletteStatusLabel(status: string): string {
  return tr(SESSION_STATUS_LABELS[status] ?? status);
}

export function paletteWorkspaceLabel(root?: string): string {
  const parts = (root ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return "";
  return parts.length > 1 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : parts[0];
}

export function formatPaletteUpdatedAt(value: string | undefined, locale: "zh" | "en"): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function buildCommandPaletteResults(
  needle: string,
  commands: PaletteCommand[],
  sessions: SessionSummary[],
  busy: boolean,
  transcriptHits: TranscriptHit[] = [],
): CommandPaletteEntry[] {
  const normalizedNeedle = needle.trim();
  const commandHits = fuzzyFilter(commands, item => `${item.label} ${item.description}`, normalizedNeedle)
    .map(({ item }) => ({ kind: "command" as const, ...item }));
  const contentHits = new Map(normalizedNeedle ? transcriptHits.map(hit => [hit.session.id, hit]) : []);
  const metadataHits = fuzzyFilter(sessions, item => `${item.title || ""} ${item.task || ""} ${item.root || ""}`, normalizedNeedle).map(({ item }) => item);
  const metadataIds = new Set(metadataHits.map(item => item.id));
  const allSessions = [...metadataHits, ...[...contentHits.values()].filter(hit => !metadataIds.has(hit.session.id)).map(hit => hit.session)];
  const sessionHits = allSessions.map(item => ({
      kind: "session" as const,
      id: item.id,
      session: item,
      label: item.title || item.task || tr("未命名任务"),
      description: commandPaletteStatusLabel(item.status),
      disabled: busy,
      snippet: contentHits.get(item.id)?.snippet,
    }));
  return [...commandHits, ...sessionHits];
}

/** Move by enabled result position; Home/End select the first/last available item. */
export function nextPaletteIndex(key: string, current: number, enabledIndices: number[]): number | null {
  if (!enabledIndices.length) return null;
  const position = enabledIndices.indexOf(current);
  if (key === "Home") return enabledIndices[0] ?? null;
  if (key === "End") return enabledIndices.at(-1) ?? null;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  if (position < 0) return key === "ArrowDown" ? enabledIndices[0] ?? null : enabledIndices.at(-1) ?? null;
  const delta = key === "ArrowDown" ? 1 : -1;
  return enabledIndices[Math.max(0, Math.min(enabledIndices.length - 1, position + delta))] ?? null;
}

export function paletteActivationIndex(key: string, current: number | null, enabledIndices: number[], composing = false): number | null {
  return key === "Enter" && !composing && current !== null && enabledIndices.includes(current) ? current : null;
}

export function isPaletteCompositionKey(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  key?: string;
  compositionActive?: boolean;
}): boolean {
  return isImeComposingEvent(event);
}

export function shouldDismissPaletteOnEscape(
  event: {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  compositionActive = false,
): boolean {
  if (event.key !== "Escape") return false;
  return !compositionActive && !isPaletteCompositionKey(event);
}

function makePaletteCommands(settingsEnabled: boolean): PaletteCommand[] {
  return [
    { id: "new-task", label: tr("新建任务"), description: tr("回到空态输入卡开始新任务") },
    ...(settingsEnabled ? [{ id: "open-settings", label: tr("打开设置"), description: tr("运行参数与 Agent 能力开关") }] : []),
    { id: "refresh", label: tr("刷新历史"), description: tr("重新加载任务列表与当前会话") },
  ];
}

export type CommandPaletteProps = {
  dialogRef: ElementRef<HTMLDivElement>;
  inputRef: ElementRef<HTMLInputElement>;
  sessions: SessionSummary[];
  busy: boolean;
  sessionsEnabled: boolean;
  settingsEnabled: boolean;
  onClose: () => void;
  onRunCommand: (id: string) => void;
  onSelectSession: (id: string) => void;
};

/** 会话很多时，模糊过滤按防抖后的输入执行；清空输入立即恢复，不拖尾。 */
const SEARCH_DEBOUNCE_MS = 120;

/** Session-owned search, result rendering and keyboard navigation. The host only mounts it and provides actions. */
export function CommandPalette({ dialogRef, inputRef, sessions, busy, sessionsEnabled, settingsEnabled, onClose, onRunCommand, onSelectSession }: CommandPaletteProps): React.JSX.Element | null {
  const locale = useLocale();
  const listboxId = `xn-command-palette-listbox-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptSearchState | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchRef = useRef(search);
  searchRef.current = search;
  const compositionActiveRef = useRef(false);
  const debouncerRef = useRef<ReturnType<typeof createDebouncer> | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer(SEARCH_DEBOUNCE_MS, () => { if (!compositionActiveRef.current) setNeedle(searchRef.current); });
  }
  useEffect(() => () => debouncerRef.current?.cancel(), []);
  const commands = useMemo(() => makePaletteCommands(settingsEnabled), [settingsEnabled, locale]);
  useEffect(() => {
    const query = needle.trim();
    setTranscripts(null); setSearchError(""); setSearchLoading(false);
    if (!sessionsEnabled || !query) return;
    const controller = new AbortController();
    setSearchLoading(true);
    void searchTranscripts(query, controller.signal, setTranscripts)
      .catch(error => { if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    return () => controller.abort();
  }, [needle, sessionsEnabled]);
  const contentHits = transcripts?.query === needle.trim() ? transcripts.matches : EMPTY_TRANSCRIPT_HITS;
  const results = useMemo(() => buildCommandPaletteResults(needle, commands, sessions, busy, contentHits), [needle, commands, sessions, busy, contentHits]);
  const enabledIndices = useMemo(() => results.flatMap((entry, index) => entry.kind === "command" || !entry.disabled ? [index] : []), [results]);
  const [activeIndex, setActiveIndex] = useState<number | null>(() => 0);

  const onSearchChange = (value: string) => {
    setSearch(value);
    setActiveIndex(0);
    const debouncer = debouncerRef.current!;
    if (value === "") {
      debouncer.cancel();
      setNeedle("");
      return;
    }
    debouncer.push();
  };

  useEffect(() => {
    if (!enabledIndices.includes(activeIndex ?? -1)) setActiveIndex(enabledIndices[0] ?? null);
  }, [enabledIndices, activeIndex]);

  const activeDescendant = activeIndex === null ? undefined : `${listboxId}-option-${activeIndex}`;
  useEffect(() => {
    if (activeDescendant) document.getElementById(activeDescendant)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDescendant]);

  if (!sessionsEnabled) return null;

  const choose = (index: number) => {
    const entry = results[index];
    if (!entry || (entry.kind === "session" && entry.disabled)) return;
    onClose();
    if (entry.kind === "command") onRunCommand(entry.id);
    else onSelectSession(entry.session.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const isComposing = compositionActiveRef.current || isPaletteCompositionKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (shouldDismissPaletteOnEscape(event, compositionActiveRef.current)) {
        onClose();
      }
      return;
    }
    if (event.target !== inputRef.current || isComposing) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const next = nextPaletteIndex(event.key, activeIndex ?? -1, enabledIndices);
      if (next !== null) {
        event.preventDefault();
        setActiveIndex(next);
      }
    } else {
      const selected = paletteActivationIndex(event.key, activeIndex, enabledIndices, false);
      if (selected !== null) {
        event.preventDefault();
        event.stopPropagation();
        choose(selected);
      }
    }
  };

  const commandCount = results.filter(entry => entry.kind === "command").length;
  const sessionCount = results.length - commandCount;
  let commandIndex = 0;
  let sessionIndex = 0;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={tr("命令面板")}
      tabIndex={-1}
      className="xn-command-overlay"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="xn-command-panel" onClick={event => event.stopPropagation()}>
        <input
          ref={inputRef}
          role="combobox"
          aria-label={tr("搜索任务或命令")}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          placeholder={tr("搜索任务或命令…")}
          value={search}
          maxLength={200}
          onChange={event => onSearchChange(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={(event) => {
            compositionActiveRef.current = true;
            event.currentTarget.setAttribute("data-composing", "true");
          }}
          onCompositionEnd={(event) => {
            const el = event.currentTarget;
            deferCompositionEnd(() => {
              compositionActiveRef.current = false;
              el?.removeAttribute("data-composing");
              debouncerRef.current?.push();
            });
          }}
        />
        <div className="xn-command-results" id={listboxId} role="listbox" aria-label={tr("搜索结果")}>
          {commandCount > 0 && (
            <div className="xn-command-group" role="group" aria-label={tr("命令")} data-testid="palette-group-commands">
              <div className="xn-command-group__title" aria-hidden="true">{tr("命令")}</div>
              {results.map((entry, index) => {
                if (entry.kind !== "command") return null;
                const groupIndex = commandIndex++;
                return (
                  <div
                    key={entry.id}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="xn-command-option"
                    data-testid={`palette-command-${entry.id}`}
                    data-active={index === activeIndex}
                    data-group-index={groupIndex}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => choose(index)}
                  >
                    <span>{entry.label}</span>
                    <span className="xn-command-group__desc">{entry.description}</span>
                  </div>
                );
              })}
            </div>
          )}
          {sessionCount > 0 && (
            <div className="xn-command-group" role="group" aria-label={tr("任务")} data-testid="palette-group-tasks">
              <div className="xn-command-group__title" aria-hidden="true">{tr("任务")}</div>
              {results.map((entry, index) => {
                if (entry.kind !== "session") return null;
                const groupIndex = sessionIndex++;
                const workspace = paletteWorkspaceLabel(entry.session.root);
                const updatedAt = formatPaletteUpdatedAt(entry.session.updatedAt, locale);
                return (
                  <div
                    key={entry.id}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={entry.disabled || undefined}
                    aria-label={[
                      entry.label,
                      entry.description,
                      workspace && tf("工作区 {0}", [entry.session.root || workspace]),
                      updatedAt && tf("最后更新 {0}", [updatedAt]),
                    ].filter(Boolean).join("，")}
                    className="xn-command-option"
                    data-testid={`palette-session-${entry.id}`}
                    data-active={index === activeIndex}
                    data-disabled={entry.disabled || undefined}
                    data-group-index={groupIndex}
                    data-updated-at={entry.session.updatedAt || undefined}
                    onMouseMove={() => { if (!entry.disabled) setActiveIndex(index); }}
                    onClick={() => choose(index)}
                  >
                    <span className="xn-command-option__title">{entry.label}</span>
                    {entry.snippet && <span className="xn-command-option__snippet">{entry.snippet}</span>}
                    <span className="xn-command-option__meta">
                      <span className="xn-command-option__status">{entry.description}</span>
                      {workspace && <span className="xn-command-option__detail" title={entry.session.root}><Folder size={12} aria-hidden="true" />{workspace}</span>}
                      {updatedAt && <time className="xn-command-option__detail" dateTime={entry.session.updatedAt}><Clock3 size={12} aria-hidden="true" />{updatedAt}</time>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {results.length === 0 && !searchLoading && <div className="xn-command-empty" role="status">{tr("无匹配结果")}</div>}
          {searchLoading && <div className="xn-command-search-status" role="status">{tr("正在搜索会话正文…")}</div>}
          {searchError && <div className="xn-command-search-status" role="alert">{tf("正文搜索失败：{0}", [searchError])}</div>}
          {transcripts?.truncated && <div className="xn-command-search-status" role="status">{tr("结果较多，请输入更具体的关键词。")}</div>}
          {Boolean(transcripts?.skipped) && <div className="xn-command-search-status" role="status">{tr("部分会话过大、不可读或不在允许的工作区，已跳过。")}</div>}
        </div>
        <div className="xn-command-hint" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> {tr("选择")} <kbd>↵</kbd> {tr("打开")}</div>
      </div>
    </div>
  );
}
