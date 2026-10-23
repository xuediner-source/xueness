/**
 * Applying a located Edit match to LF text.
 *
 * `countOccurrences` is ported from apps/zcode-cli/packages/core/src/tool/handlers/edit.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f). `applyEditToContent`
 * keeps ZCode's literal replacement (no `$&` tokens) and its "deleting a line
 * also deletes its newline" rule, but decides that per occurrence:
 *
 * - ZCode switches the whole search to `old\n` when that appears anywhere, so
 *   with replace_all the occurrences not followed by a newline were left in
 *   place, and a deletion ending mid-line joined two lines.
 * - Here every occurrence is replaced, and a deleted occurrence takes its
 *   following newline only when it starts a line, i.e. it removed whole lines.
 */

export interface EditSpan {
  start: number;
  end: number;
}

export function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (position < content.length) {
    const index = content.indexOf(needle, position);
    if (index === -1) break;
    count += 1;
    position = index + needle.length;
  }
  return count;
}

/** Non-overlapping spans of `oldString` (only the first unless replaceAll). */
export function editSpans(content: string, oldString: string, newString: string, replaceAll: boolean): EditSpan[] {
  if (oldString === "") return [];
  const spans: EditSpan[] = [];
  for (let index = content.indexOf(oldString); index !== -1; index = content.indexOf(oldString, index + oldString.length)) {
    let end = index + oldString.length;
    const startsLine = index === 0 || content[index - 1] === "\n";
    if (newString === "" && !oldString.endsWith("\n") && startsLine && content[end] === "\n") end += 1;
    spans.push({ start: index, end });
    if (!replaceAll) break;
  }
  return spans;
}

export function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  let result = content;
  for (const span of editSpans(content, oldString, newString, replaceAll).reverse()) {
    result = result.slice(0, span.start) + newString + result.slice(span.end);
  }
  return result;
}
