/**
 * Line-trim, shared-indent and block-anchor Edit matchers.
 *
 * Ported from apps/zcode-cli/packages/core/src/tool/edit-matchers.ts
 * (v3.15.1 @ aac4755666d09fdcd70272fcf063c077a639015f).
 */
import type { Candidate } from "./edit-matchers-types.ts";

const BLOCK_ANCHOR_MIN_SIMILARITY = 0.8;

export function collectLineTrimmedCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length === 0) return [];

  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (!block.every((line, offset) => line.trim() === searchLines[offset]!.trim())) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

export function collectIndentationFlexibleCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 2) return [];

  const normalizedSearch = removeCommonIndent(searchLines);
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (removeCommonIndent(block) !== normalizedSearch) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

export function collectBlockAnchorCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 3) return [];

  const first = searchLines[0]!.trim();
  const last = searchLines[searchLines.length - 1]!.trim();
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (block[0]!.trim() !== first) continue;
    if (block[block.length - 1]!.trim() !== last) continue;
    if (averageMiddleSimilarity(block, searchLines) < BLOCK_ANCHOR_MIN_SIMILARITY) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function blockCandidate(lines: string[], startLine: number, lineCount: number): Candidate {
  const index = offsetForLine(lines, startLine);
  return {
    value: lines.slice(startLine, startLine + lineCount).join("\n"),
    index,
  };
}

function offsetForLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index]!.length + 1;
  }
  return offset;
}

function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function removeCommonIndent(lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join("\n");
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0));
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
}

function averageMiddleSimilarity(actual: string[], expected: string[]): number {
  if (actual.length <= 2) return 1;
  let total = 0;
  let count = 0;
  for (let index = 1; index < actual.length - 1; index += 1) {
    total += lineSimilarity(actual[index]!.trim(), expected[index]!.trim());
    count += 1;
  }
  return count === 0 ? 1 : total / count;
}

function lineSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(left, right) / maxLength;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}
