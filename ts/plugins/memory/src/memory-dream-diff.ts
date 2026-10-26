/** Pure unified line diff between the dream baseline KEY.md and a candidate. */
import { createHash } from "node:crypto";
import { pyEncodeUtf8 } from "@xueness/contracts";

const CONTEXT_LINES = 3, MAX_HUNKS = 100, MAX_DIFF_LINES = 4_000, MAX_DP_CELLS = 4_000_000;

export interface MemoryDreamDiffLine { op: "context" | "add" | "remove"; text: string }
export interface MemoryDreamDiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: MemoryDreamDiffLine[] }
export interface MemoryDreamDiff {
  baseDigest: string;
  candidateDigest: string;
  oldLines: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
  hunks: MemoryDreamDiffHunk[];
  truncated: boolean;
}

const splitLines = (text: string): string[] => {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? [] : body.split("\n");
};

type Op = MemoryDreamDiffLine["op"];

function aligned(oldLines: readonly string[], newLines: readonly string[]): { ops: Op[]; oldIndex: number[]; newIndex: number[] } | null {
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [], oldIndex: number[] = [], newIndex: number[] = [];
  let i = 0, j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) { ops.push("context"); oldIndex.push(i); newIndex.push(j); i += 1; j += 1; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { ops.push("remove"); oldIndex.push(i); newIndex.push(-1); i += 1; }
    else { ops.push("add"); oldIndex.push(-1); newIndex.push(j); j += 1; }
  }
  while (i < oldLines.length) { ops.push("remove"); oldIndex.push(i); newIndex.push(-1); i += 1; }
  while (j < newLines.length) { ops.push("add"); oldIndex.push(-1); newIndex.push(j); j += 1; }
  return { ops, oldIndex, newIndex };
}

function wholeFile(oldLines: readonly string[], newLines: readonly string[]): { ops: Op[]; oldIndex: number[]; newIndex: number[] } {
  const ops: Op[] = [], oldIndex: number[] = [], newIndex: number[] = [];
  oldLines.forEach((_, at) => { ops.push("remove"); oldIndex.push(at); newIndex.push(-1); });
  newLines.forEach((_, at) => { ops.push("add"); oldIndex.push(-1); newIndex.push(at); });
  return { ops, oldIndex, newIndex };
}

/** Review-only projection; it never touches the memory tracks or the dream record. */
export function dreamKeyDiff(base: { content: string; digest: string }, candidate: { content: string; digest: string }): MemoryDreamDiff {
  const oldLines = splitLines(base.content), newLines = splitLines(candidate.content);
  const walk = oldLines.length * newLines.length <= MAX_DP_CELLS ? aligned(oldLines, newLines) ?? wholeFile(oldLines, newLines) : wholeFile(oldLines, newLines);
  const hunks: MemoryDreamDiffHunk[] = [];
  let addedLines = 0, removedLines = 0, diffLines = 0, truncated = false;
  for (let at = 0; at < walk.ops.length && !truncated;) {
    while (at < walk.ops.length && walk.ops[at] === "context") at += 1;
    if (at >= walk.ops.length) break;
    const start = Math.max(0, at - CONTEXT_LINES);
    let end = at;
    let next = at, sinceChange = 0;
    while (next < walk.ops.length && sinceChange < 2 * CONTEXT_LINES + 1) {
      if (walk.ops[next] === "context") sinceChange += 1; else { sinceChange = 0; end = next + 1; }
      next += 1;
    }
    const lines: MemoryDreamDiffLine[] = [];
    let oldStart = -1, newStart = -1, oldCount = 0, newCount = 0;
    for (let index = start; index < end; index += 1) {
      const op = walk.ops[index]!;
      if (op === "remove") { removedLines += 1; oldCount += 1; if (oldStart < 0) oldStart = walk.oldIndex[index]! + 1; }
      if (op === "add") { addedLines += 1; newCount += 1; if (newStart < 0) newStart = walk.newIndex[index]! + 1; }
      lines.push({ op, text: op === "add" ? newLines[walk.newIndex[index]!] ?? "" : oldLines[walk.oldIndex[index]!] ?? "" });
    }
    hunks.push({ oldStart: Math.max(1, oldStart), oldLines: oldCount, newStart: Math.max(1, newStart), newLines: newCount, lines });
    diffLines += lines.length;
    truncated = hunks.length >= MAX_HUNKS || diffLines >= MAX_DIFF_LINES;
    at = end;
  }
  return {
    baseDigest: base.digest, candidateDigest: candidate.digest || createHash("sha256").update(pyEncodeUtf8(candidate.content)).digest("hex"),
    oldLines: oldLines.length, newLines: newLines.length, addedLines, removedLines, hunks, truncated,
  };
}
