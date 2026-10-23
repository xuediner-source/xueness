/**
 * Line diff (Myers) and unified-diff rendering for tool results.
 * Common prefix and suffix are trimmed first, so typical edits are cheap; a
 * huge rewrite falls back to "remove all, add all" instead of quadratic work.
 */

export type DiffOp = { kind: "equal" | "add" | "remove"; line: string };

const MAX_MYERS_WORK = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function myers(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
      let x = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[], offset: number, depth: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d -= 1) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: "equal", line: a[x] as string });
    }
    if (down) {
      y -= 1;
      ops.push({ kind: "add", line: b[y] as string });
    } else {
      x -= 1;
      ops.push({ kind: "remove", line: a[x] as string });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: "equal", line: a[x] as string });
  }
  return ops.reverse();
}

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = (midA.length + midB.length) * Math.min(midA.length + midB.length, 2000) > MAX_MYERS_WORK
    ? [...midA.map((line): DiffOp => ({ kind: "remove", line })), ...midB.map((line): DiffOp => ({ kind: "add", line }))]
    : myers(midA, midB);
  return [
    ...a.slice(0, start).map((line): DiffOp => ({ kind: "equal", line })),
    ...middle,
    ...a.slice(endA).map((line): DiffOp => ({ kind: "equal", line })),
  ];
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** Unified diff text; empty when nothing changed. */
  unified: string;
  truncated: boolean;
}

/** Render a unified diff with `context` lines around each change. */
export function unifiedDiff(before: string, after: string, path: string, options: { context?: number; maxChars?: number } = {}): DiffSummary {
  const context = options.context ?? 3;
  const maxChars = options.maxChars ?? 20_000;
  const ops = diffLines(before, after);
  const added = ops.filter((op) => op.kind === "add").length;
  const removed = ops.filter((op) => op.kind === "remove").length;
  if (!added && !removed) return { added, removed, unified: "", truncated: false };
  // oldLine[i] / newLine[i]: 1-based line numbers at op i.
  const oldLine = new Int32Array(ops.length + 1);
  const newLine = new Int32Array(ops.length + 1);
  oldLine[0] = 1;
  newLine[0] = 1;
  ops.forEach((op, i) => {
    oldLine[i + 1] = (oldLine[i] as number) + (op.kind === "add" ? 0 : 1);
    newLine[i + 1] = (newLine[i] as number) + (op.kind === "remove" ? 0 : 1);
  });
  const hunks: Array<[number, number]> = [];
  ops.forEach((op, i) => {
    if (op.kind === "equal") return;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else hunks.push([start, end]);
  });
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of hunks) {
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "add").length;
    const newCount = hunk.filter((op) => op.kind !== "remove").length;
    const oldStart = (oldLine[start] as number) - (oldCount ? 0 : 1);
    const newStart = (newLine[start] as number) - (newCount ? 0 : 1);
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) lines.push((op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " ") + op.line);
  }
  let unified = lines.join("\n") + "\n";
  const truncated = unified.length > maxChars;
  if (truncated) unified = unified.slice(0, maxChars) + `\n… diff truncated (${unified.length - maxChars} more characters)\n`;
  return { added, removed, unified, truncated };
}
