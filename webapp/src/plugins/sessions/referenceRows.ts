import type { FilePreview, ReferenceAnchorRole, TimelineRow } from "../../xuenessWorkbench";

const DIRECTIVE_RE = /^:{1,2}(?:zcode-file-citation|xueness-file|xueness-artifact)\{[^{}\r\n]{0,400}\}$/;
const KINDS = new Set(["citation", "preview", "artifact"]);
const IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_CHARS = 4_000;

export type ReferenceKind = "citation" | "preview" | "artifact";

type Replacement = { start: number; end: number; text: string };
type SanitizedReference = {
  kind: ReferenceKind;
  path: string;
  label: string;
  startLine?: number;
  endLine?: number;
  sizeBytes?: number;
};
type ReferenceEntry = {
  messageId?: string;
  messageIndex?: number;
  replacements: Replacement[];
  references: SanitizedReference[];
};

export function isBoundedRelativePath(path: string): boolean {
  if (!path || path.length > 240) return false;
  if (/[\u0000-\u001f\\]/u.test(path) || path.startsWith("/") || path.startsWith("~") || path.includes("://") || /^[A-Za-z]:/u.test(path)) return false;
  const parts = path.split("/");
  return parts.length > 0 && parts.every(part => part !== "" && part !== "." && part !== "..");
}

/** Preview fetches exist only while both owning plugins are effective. */
export function referencePreviewAllowed(path: string, effectivePluginIds: ReadonlySet<string> | undefined): boolean {
  return Boolean(effectivePluginIds?.has("sessions") && effectivePluginIds.has("files") && isBoundedRelativePath(path));
}

export function isReferenceTimelineRow(row: TimelineRow): row is Extract<TimelineRow, { kind: ReferenceKind }> {
  return row.kind === "citation" || row.kind === "preview" || row.kind === "artifact";
}

function replacementAllowed(text: string): boolean {
  if (text === "" || text === " ") return true;
  return text.length <= 300 && !/[<>`\u0000-\u001f]|\]\(|:\/\//u.test(text);
}

function applyReplacements(text: string, replacements: Replacement[]): string {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let next = text;
  let limit = text.length;
  for (const item of ordered) {
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) continue;
    if (item.start < 0 || item.end > limit || item.start >= item.end) continue;
    if (!DIRECTIVE_RE.test(text.slice(item.start, item.end)) || !replacementAllowed(item.text)) continue;
    next = next.slice(0, item.start) + item.text + next.slice(item.end);
    limit = item.start;
  }
  return next;
}

function sanitizeReference(value: unknown): SanitizedReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== "string" || !KINDS.has(item.kind)) return null;
  if (typeof item.path !== "string" || !isBoundedRelativePath(item.path)) return null;
  if (typeof item.label !== "string") return null;
  const label = item.label.replace(/\s+/gu, " ").trim().slice(0, 80);
  if (!label) return null;
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (item.start_line !== undefined || item.end_line !== undefined) {
    if (!Number.isInteger(item.start_line) || !Number.isInteger(item.end_line)) return null;
    const start = item.start_line as number;
    const end = item.end_line as number;
    if (start < 1 || end < start || end > 100_000 || end - start + 1 > MAX_PREVIEW_LINES) return null;
    startLine = start;
    endLine = end;
  }
  let sizeBytes: number | undefined;
  if (item.kind === "artifact" && item.size_bytes !== undefined) {
    if (!Number.isSafeInteger(item.size_bytes) || (item.size_bytes as number) < 0) return null;
    sizeBytes = item.size_bytes as number;
  }
  return {
    kind: item.kind as ReferenceKind, path: item.path, label,
    ...(startLine !== undefined ? { startLine, endLine } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function readEntries(journal: unknown): ReferenceEntry[] {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return [];
  const raw = (journal as Record<string, unknown>).message_references;
  if (!Array.isArray(raw)) return [];
  const entries: ReferenceEntry[] = [];
  for (const value of raw.slice(0, 80)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const messageId = typeof item.message_id === "string" && item.message_id && item.message_id.length <= 80
      ? item.message_id : undefined;
    const messageIndex = Number.isInteger(item.message_index) && (item.message_index as number) >= 0
      ? item.message_index as number : undefined;
    if (!messageId && messageIndex === undefined) continue;
    const replacements = Array.isArray(item.replacements) ? item.replacements.slice(0, 8).flatMap(candidate => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as Record<string, unknown>;
      if (!Number.isInteger(row.start) || !Number.isInteger(row.end) || typeof row.text !== "string") return [];
      return [{ start: row.start as number, end: row.end as number, text: row.text }];
    }) : [];
    const references = Array.isArray(item.references)
      ? item.references.slice(0, 16).flatMap(candidate => {
        const reference = sanitizeReference(candidate);
        return reference ? [reference] : [];
      })
      : [];
    if (!replacements.length && !references.length) continue;
    entries.push({ messageId, messageIndex, replacements, references });
  }
  return entries;
}

function entryFor(row: Extract<TimelineRow, { kind: "user" | "assistant" }>, entries: ReferenceEntry[]): ReferenceEntry | undefined {
  if (row.messageId) return entries.find(entry => entry.messageId === row.messageId);
  if (row.messageIndex !== undefined) return entries.find(entry => entry.messageId === undefined && entry.messageIndex === row.messageIndex);
  return undefined;
}

/**
 * Attach citation, preview and artifact rows from the snapshot sidecar.
 * File bodies are never copied. When files is not effective, verified rows are
 * dropped and only the plain-text replacements remain.
 */
export function projectReferenceRows(rows: TimelineRow[], journal: unknown, options: { filesEffective: boolean }): TimelineRow[] {
  const entries = readEntries(journal);
  if (!entries.length && !rows.some(isReferenceTimelineRow)) return rows;
  const next: TimelineRow[] = [];
  let changed = false;
  for (const row of rows) {
    if (isReferenceTimelineRow(row)) {
      changed = true;
      continue;
    }
    if (row.kind !== "user" && row.kind !== "assistant") {
      next.push(row);
      continue;
    }
    const entry = entryFor(row, entries);
    const displayText = entry ? applyReplacements(row.text, entry.replacements) : row.text;
    const shown = displayText === row.text ? undefined : displayText;
    const withDisplay = shown === row.displayText ? row : { ...row, ...(shown === undefined ? { displayText: undefined } : { displayText: shown }) };
    if (withDisplay !== row) changed = true;
    next.push(withDisplay);
    if (!options.filesEffective || !entry) continue;
    entry.references.forEach((reference, index) => {
      changed = true;
      next.push({
        kind: reference.kind,
        seq: row.seq + (index + 1) / 100,
        turnId: row.turnId,
        path: reference.path,
        label: reference.label,
        anchorRole: row.kind as ReferenceAnchorRole,
        ...(reference.startLine !== undefined ? { startLine: reference.startLine, endLine: reference.endLine } : {}),
        ...(reference.sizeBytes !== undefined ? { sizeBytes: reference.sizeBytes } : {}),
        ...(row.messageId ? { messageId: row.messageId } : {}),
      });
    });
  }
  return changed ? next : rows;
}

/** Keep a mounted preview to a bounded text window or a whitelisted image. */
export function clipMountedPreview(
  preview: Pick<FilePreview, "path" | "text" | "image">,
  requestedPath: string,
  range?: { startLine?: number; endLine?: number },
): { text?: string; image?: string } | null {
  if (preview.path !== requestedPath || !isBoundedRelativePath(requestedPath)) return null;
  if (typeof preview.image === "string" && preview.image.length <= 2_000_000 && IMAGE_RE.test(preview.image)) {
    return { image: preview.image };
  }
  if (typeof preview.text !== "string") return { text: "" };
  const lines = preview.text.split(/\r?\n/u);
  const start = range?.startLine && range.startLine > 0 ? range.startLine : 1;
  const requestedEnd = range?.endLine && range.endLine >= start ? range.endLine : start + MAX_PREVIEW_LINES - 1;
  const end = Math.min(requestedEnd, start + MAX_PREVIEW_LINES - 1);
  const text = lines.slice(start - 1, end).join("\n").slice(0, MAX_PREVIEW_CHARS);
  return { text };
}
