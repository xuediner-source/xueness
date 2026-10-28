import React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { TimelineRow } from "../../xuenessWorkbench";
import { t as tr } from "../../i18n";
import { shouldDismissModalOnEscape } from "../shared";

export type ConversationFindMatch = {
  rowKey: string;
  rowSeq: number;
  occurrence: number;
  identity: string;
};

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 24_000);
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value).slice(0, 24_000); }
  catch { return ""; }
}

export function conversationFindRowKey(row: TimelineRow): string {
  if (row.kind === "subagent") return `subagent:${row.toolCallId}:${row.taskId}`;
  if (row.kind === "tool") return `tool:${row.toolCallId}`;
  if ((row.kind === "user" || row.kind === "assistant") && row.messageId) return `${row.kind}:${row.messageId}`;
  return `${row.kind}:${row.seq}`;
}

export function conversationFindText(row: TimelineRow): string {
  switch (row.kind) {
    case "subagent": return [row.label, row.agent, row.summary].filter(Boolean).join("\n");
    case "user": return (row.displayText ?? row.text).slice(0, 48_000);
    case "assistant": return [row.reasoning, row.displayText ?? row.text].filter(Boolean).join("\n").slice(0, 48_000);
    case "tool": return [row.subject, row.name, row.error, stringifySearchValue(row.input), stringifySearchValue(row.output)]
      .filter(Boolean).join("\n").slice(0, 48_000);
    case "completion": return row.summary.slice(0, 24_000);
    case "pending_question": return row.question.slice(0, 24_000);
    case "citation":
    case "preview":
    case "artifact": return [row.label, row.path].filter(Boolean).join("\n").slice(0, 2_000);
  }
}

export function buildConversationFindMatches(rows: TimelineRow[], query: string): ConversationFindMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: ConversationFindMatch[] = [];
  for (const row of rows) {
    const rowKey = conversationFindRowKey(row);
    const haystack = conversationFindText(row).toLocaleLowerCase();
    let occurrence = 0;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      matches.push({ rowKey, rowSeq: row.seq, occurrence, identity: `${rowKey}\u0000${occurrence}` });
      occurrence += 1;
    }
  }
  return matches;
}

function unwrapFindMarks(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll("mark[data-xueness-find]"))) {
    const parent = mark.parentNode;
    mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent ?? ""));
    parent?.normalize();
  }
}

/** Highlight rendered text without rewriting the Markdown source or its links. */
export function applyConversationFindHighlights(
  root: HTMLElement,
  query: string,
  activeRowKey: string | null,
  activeOccurrence: number,
): number {
  unwrapFindMarks(root);
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const view = root.ownerDocument.defaultView;
  if (!view) return 0;
  const filter = view.NodeFilter;
  const walker = root.ownerDocument.createTreeWalker(root, filter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !parent.closest("[data-zcode-row-key]")) return filter.FILTER_REJECT;
      if (parent.closest("button,input,textarea,select,script,style,svg,[data-zcode-find-ui]")) return filter.FILTER_REJECT;
      if (parent.closest("details:not([open])")) return filter.FILTER_REJECT;
      return node.textContent?.trim() ? filter.FILTER_ACCEPT : filter.FILTER_REJECT;
    },
  });
  const slices: Array<{ node: Text; rowKey: string; start: number; end: number; occurrence: number }> = [];
  const occurrences = new Map<string, number>();
  let total = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    const rowKey = node.parentElement?.closest<HTMLElement>("[data-zcode-row-key]")?.dataset.zcodeRowKey;
    if (!rowKey) continue;
    const value = node.data.toLocaleLowerCase();
    let local = occurrences.get(rowKey) ?? 0;
    for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + needle.length)) {
      slices.push({ node, rowKey, start: at, end: at + needle.length, occurrence: local });
      local += 1;
      total += 1;
    }
    occurrences.set(rowKey, local);
  }
  const activeMarks: HTMLElement[] = [];
  const groups = new Map<Text, typeof slices>();
  for (const slice of slices) groups.set(slice.node, [...(groups.get(slice.node) ?? []), slice]);
  for (const [node, nodeMatches] of groups) {
    for (const match of nodeMatches.reverse()) {
      const mark = root.ownerDocument.createElement("mark");
      mark.dataset.xuenessFind = "true";
      mark.className = "xn-zc-find__match";
      if (match.rowKey === activeRowKey && match.occurrence === activeOccurrence) {
        mark.dataset.xuenessFindActive = "true";
        activeMarks.push(mark);
      }
      const range = root.ownerDocument.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      range.surroundContents(mark);
      range.detach();
    }
  }
  activeMarks[0]?.scrollIntoView?.({ block: "center", inline: "nearest" });
  return total;
}

export function ConversationFindBar({
  open,
  query,
  resultCount,
  activeIndex,
  onOpen,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  open: boolean;
  query: string;
  resultCount: number;
  activeIndex: number;
  onOpen: () => void;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}): React.JSX.Element {
  if (!open) return <button type="button" data-shortcut-action="find-in-task" className="xn-zc-find__toggle" aria-label={tr("搜索会话")} title={tr("搜索会话")} onClick={onOpen}>
    <Search size={14} aria-hidden="true" />
  </button>;
  const status = resultCount ? `${activeIndex + 1} / ${resultCount}` : query.trim() ? "0 / 0" : "";
  return <div className="xn-zc-find" data-zcode-find-ui="true" role="search" aria-label={tr("搜索会话")}>
    <Search size={14} aria-hidden="true" />
    <input autoFocus type="search" value={query} aria-label={tr("搜索会话")} placeholder={tr("搜索会话")}
      onChange={event => onQueryChange(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.shiftKey ? onPrevious() : onNext(); }
        else if (shouldDismissModalOnEscape(event)) { event.preventDefault(); onClose(); }
      }} />
    <span className="xn-zc-find__count" aria-live="polite" data-testid="conversation-find-count">{status}</span>
    <button type="button" aria-label={tr("上一个匹配项")} title={tr("上一个匹配项")} disabled={!resultCount} onClick={onPrevious}>
      <ChevronUp size={14} aria-hidden="true" />
    </button>
    <button type="button" aria-label={tr("下一个匹配项")} title={tr("下一个匹配项")} disabled={!resultCount} onClick={onNext}>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    <button type="button" aria-label={tr("关闭")} title={tr("关闭")} onClick={onClose}><X size={14} aria-hidden="true" /></button>
  </div>;
}
