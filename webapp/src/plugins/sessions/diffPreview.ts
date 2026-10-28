import { formatCommandArgv } from "../../xuenessWorkbench";



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
  const beforeLines = before ? before.split(/\r?\n/) : [];
  const afterLines = after ? after.split(/\r?\n/) : [];

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
