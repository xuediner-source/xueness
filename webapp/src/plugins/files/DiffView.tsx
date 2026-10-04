import React from "react";
import { t as tr, useLocale, type Locale } from "../../i18n";
import type { FileChange, FileChangeSet } from "../../xuenessWorkbench";
import "../../styles/office.css";
import "./diffView.css";

// -- bounded line diff -------------------------------------------------------

export type UnifiedDiffLine = {
  kind: "context" | "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type UnifiedDiffBlock =
  | { kind: "lines"; lines: UnifiedDiffLine[] }
  | { kind: "unchanged"; lines: UnifiedDiffLine[] };

export type UnifiedLineDiff = {
  lines: UnifiedDiffLine[];
  simplified: boolean;
  truncated: boolean;
  newlineMismatch: boolean;
};

const MAX_DIFF_INPUT_CHARS = 64_000;
const MAX_DIFF_LINES_PER_SIDE = 1_200;
const MAX_DIFF_MATRIX_CELLS = 1_000_000;
const CONTEXT_LINES = 3;

type SplitSource = { lines: string[]; truncated: boolean; finalNewline: boolean | null };

function splitSource(text: string): SplitSource {
  const sourceClipped = text.length > MAX_DIFF_INPUT_CHARS;
  const source = sourceClipped ? text.slice(0, MAX_DIFF_INPUT_CHARS) : text;
  if (!source) return { lines: [], truncated: sourceClipped, finalNewline: sourceClipped ? null : false };

  const finalNewline = sourceClipped ? null : /(?:\r\n|\n|\r)$/.test(source);
  const lines = source.split(/\r\n|\n|\r/);
  if (finalNewline) lines.pop();
  const lineClipped = lines.length > MAX_DIFF_LINES_PER_SIDE;
  return {
    lines: lineClipped ? lines.slice(0, MAX_DIFF_LINES_PER_SIDE) : lines,
    truncated: sourceClipped || lineClipped,
    finalNewline,
  };
}

function replaceAllLines(oldLines: string[], newLines: string[]): UnifiedDiffLine[] {
  const removed = oldLines.map((text, index) => ({ kind: "remove" as const, oldLine: index + 1, newLine: null, text }));
  const added = newLines.map((text, index) => ({ kind: "add" as const, oldLine: null, newLine: index + 1, text }));
  return [...removed, ...added];
}

/**
 * Build a unified-style line diff with a fixed LCS work budget. Inputs above
 * the character/line caps are explicitly marked truncated; pairs whose LCS
 * matrix would exceed the cell budget use a bounded remove/add view instead.
 */
export function buildUnifiedLineDiff(oldText: string, newText: string): UnifiedLineDiff {
  const oldSource = splitSource(oldText);
  const newSource = splitSource(newText);
  const oldLines = oldSource.lines;
  const newLines = newSource.lines;
  const cells = (oldLines.length + 1) * (newLines.length + 1);
  const truncated = oldSource.truncated || newSource.truncated;
  const newlineMismatch = oldSource.finalNewline !== null && newSource.finalNewline !== null
    && oldSource.finalNewline !== newSource.finalNewline;

  if (cells > MAX_DIFF_MATRIX_CELLS) {
    return { lines: replaceAllLines(oldLines, newLines), simplified: true, truncated, newlineMismatch };
  }

  const columns = newLines.length + 1;
  const table = new Uint16Array(cells);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = oldIndex * columns;
    const nextRow = (oldIndex + 1) * columns;
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[row + newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[nextRow + newIndex + 1] + 1
        : Math.max(table[nextRow + newIndex], table[row + newIndex + 1]);
    }
  }

  const lines: UnifiedDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: "context", oldLine: oldIndex + 1, newLine: newIndex + 1, text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const removeScore = oldIndex < oldLines.length ? table[(oldIndex + 1) * columns + newIndex] : -1;
    const addScore = newIndex < newLines.length ? table[oldIndex * columns + newIndex + 1] : -1;
    if (oldIndex < oldLines.length && (newIndex >= newLines.length || removeScore >= addScore)) {
      lines.push({ kind: "remove", oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      lines.push({ kind: "add", oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
      newIndex += 1;
    }
  }

  return { lines, simplified: false, truncated, newlineMismatch };
}

/** Keep nearby context visible and collect distant unchanged runs for disclosure. */
export function groupUnifiedDiffContext(lines: UnifiedDiffLine[], contextLines = CONTEXT_LINES): UnifiedDiffBlock[] {
  const visible = new Uint8Array(lines.length);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].kind === "context") continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    for (let contextIndex = start; contextIndex <= end; contextIndex += 1) visible[contextIndex] = 1;
  }

  const blocks: UnifiedDiffBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const collapsed = lines[index].kind === "context" && visible[index] === 0;
    const blockLines: UnifiedDiffLine[] = [lines[index]];
    index += 1;
    while (index < lines.length) {
      const nextCollapsed = lines[index].kind === "context" && visible[index] === 0;
      if (nextCollapsed !== collapsed) break;
      blockLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: collapsed ? "unchanged" : "lines", lines: blockLines });
  }
  return blocks;
}

function localized(locale: Locale, zh: string, en: string): string {
  return locale === "en" ? en : zh;
}

function DiffLineRow({ line, locale }: { line: UnifiedDiffLine; locale: Locale }) {
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
  return <tr className={`xn-diff-line xn-diff-line--${line.kind}`} data-diff-line={line.kind}>
    <td className="xn-diff-line__number" aria-label={line.oldLine === null ? undefined : localized(locale, `旧行 ${line.oldLine}`, `Old line ${line.oldLine}`)}>{line.oldLine ?? ""}</td>
    <td className="xn-diff-line__number" aria-label={line.newLine === null ? undefined : localized(locale, `新行 ${line.newLine}`, `New line ${line.newLine}`)}>{line.newLine ?? ""}</td>
    <td className="xn-diff-line__marker" aria-hidden="true">{marker}</td>
    <td className="xn-diff-line__text"><code>{line.text || " "}</code></td>
  </tr>;
}

// -- change view -------------------------------------------------------------

export type DiffViewProps = {
  changeSet: FileChangeSet | null;
  error?: string;
};

function ChangeBlock({ change, locale }: { change: FileChange; locale: Locale }) {
  const oldText = change.kind === "edit" ? change.old ?? "" : "";
  const newText = change.kind === "edit" ? change.new ?? "" : change.content ?? "";
  const diff = React.useMemo(() => buildUnifiedLineDiff(oldText, newText), [oldText, newText]);
  const blocks = React.useMemo(() => groupUnifiedDiffContext(diff.lines), [diff.lines]);
  const changedLineCount = React.useMemo(() => diff.lines.filter(line => line.kind !== "context").length, [diff.lines]);

  return <article data-testid={`change-${change.path}`} className="xn-diff-file">
    <header className="xn-diff-file__header">
      <code className="xn-diff-file__path">{change.path}</code>
      <span className={change.ok ? "xn-diff-file__status is-applied" : "xn-diff-file__status is-unapplied"}>
        {change.kind} · {change.ok ? tr("已应用") : tr("未应用")}
      </span>
    </header>
    {(diff.simplified || diff.truncated) && <p className="xn-diff-file__limit" data-testid="diff-limit">
      {diff.truncated
        ? localized(locale, "预览已限制大小，后续内容未显示。", "The preview is capped; remaining content is omitted.")
        : localized(locale, "改动较大，已使用有界的逐行替换预览。", "The change is large; a bounded line replacement preview is shown.")}
    </p>}
    {changedLineCount === 0 && !diff.newlineMismatch
      ? <p className="xn-diff-file__unchanged">{localized(locale, "未发现文本行差异。", "No text line changes were found.")}</p>
      : <div className="xn-unified-diff" data-testid="unified-diff">
        <table aria-label={localized(locale, `文件 ${change.path} 的统一差异`, `Unified diff for ${change.path}`)}>
          <tbody>{blocks.map((block, blockIndex) => block.kind === "unchanged"
            ? <tr className="xn-diff-context-disclosure" key={`context-${blockIndex}`}>
                <td colSpan={4}>
                  <details>
                    <summary>{localized(locale, `显示 ${block.lines.length} 行未变内容`, `Show ${block.lines.length} unchanged lines`)}</summary>
                    <table aria-label={localized(locale, "未变内容", "Unchanged lines")}><tbody>
                      {block.lines.map((line, lineIndex) => <DiffLineRow key={`context-line-${line.oldLine}-${line.newLine}-${lineIndex}`} line={line} locale={locale} />)}
                    </tbody></table>
                  </details>
                </td>
              </tr>
            : block.lines.map((line, lineIndex) => <DiffLineRow key={`${line.kind}-${line.oldLine}-${line.newLine}-${lineIndex}`} line={line} locale={locale} />))}</tbody>
        </table>
        {diff.newlineMismatch && <p className="xn-diff-file__newline" data-testid="diff-newline-change">
          {localized(locale, "文件末尾换行符发生变化。", "The trailing newline changed.")}
        </p>}
      </div>}
  </article>;
}

export function DiffView({ changeSet, error }: DiffViewProps) {
  const locale = useLocale();
  // This provenance is essential: the records are journaled intent, never a
  // fresh read of disk, and the panel has no accept/revert mutation controls.
  const provenance = <div data-testid="diff-provenance" className="xn-diff-provenance">
    {tr("来自会话记录，不是当前磁盘差异")}
  </div>;

  if (error) {
    return <div data-testid="diff-view" className="xn-diff-container">
      {provenance}
      <p role="alert" data-testid="diff-error">{tr("读取改动失败：")}{error}</p>
    </div>;
  }

  if (!changeSet || changeSet.changes.length === 0) {
    return <div data-testid="diff-view" className="xn-diff-container">
      {provenance}
      <div data-testid="diff-empty">{tr("暂无改动")}</div>
    </div>;
  }

  return <div data-testid="diff-view" className="xn-diff-container">
    {provenance}
    {changeSet.changes.map((change, index) => <ChangeBlock key={`${change.path}-${index}`} change={change} locale={locale} />)}
  </div>;
}
