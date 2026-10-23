import { createHash } from "node:crypto";
import { extname } from "node:path";
import { isDict, pyLen, PyValueError } from "@xueness/contracts";
import type { SessionStore } from "@xueness/sessions";
export type AttachmentRow = Record<string, any>;
export interface AttachmentOptions { stateDir: string; webRuns: string; projectDir: string; store: SessionStore; enabled(id: string): boolean; allowedRoots?: () => readonly string[]; }
export class AttachmentError extends PyValueError {
  readonly status: number;
  constructor(message = "invalid attachment", status = 400) { super(message); this.status = status; }
}
export const IMAGE_BYTES = 20 * 1024 * 1024, MEDIA_BYTES = 2 * 1024 * 1024, CHUNK_BYTES = 512 * 1024, STAGED_BYTES = 64 * 1024 * 1024;
export const ORIGINS = new Set(["file", "paste", "drop", "workspace"]);
export const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
export const textMime = (mime: string): boolean => mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mime);
export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const validName = (name: unknown): name is string => typeof name === "string" && pyLen(name) > 0 && pyLen(name) <= 255 && !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name);
export function attachmentToken(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new AttachmentError(); return value; }
export function sessionSelection(value: unknown): string | null { if (value == null) return null; if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new AttachmentError("invalid session selection"); return value; }
export function ownershipId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new AttachmentError("invalid upload ownership identifier"); return value; }
export function attachmentKeys(data: unknown, allowed: readonly string[], label = "attachment"): asserts data is AttachmentRow { if (!isDict(data) || Object.keys(data).some((key) => !allowed.includes(key))) throw new AttachmentError("invalid " + label); }
export function byteLimit(name: string, mime: string): number {
  const expected = MEDIA_TYPES[extname(name).toLowerCase()];
  if (textMime(mime)) return expected ? -1 : 65536;
  return expected !== mime ? -1 : mime.startsWith("image/") ? IMAGE_BYTES : MEDIA_BYTES;
}
export function publicAttachment(record: AttachmentRow): AttachmentRow {
  return { ...Object.fromEntries(["id", "name", "mimeType", "size", "origin", "source"].map((key) => [key, record[key]])), token: record.id, ...(record.path ? { path: record.path } : {}) };
}
export function uploadProgress(record: AttachmentRow): AttachmentRow { return { ref: publicAttachment(record), status: record.status, nextChunkIndex: record.nextChunkIndex ?? 0, uploadedBytes: record.uploadedBytes ?? 0 }; }
export function reservedMedia(records: AttachmentRow[]): void {
  const media = records.filter((r) => typeof r.mimeType === "string" && (r.mimeType.startsWith("image/") || r.mimeType.startsWith("video/") || r.mimeType === "application/pdf"));
  const total = media.reduce((sum, r) => sum + r.size, 0);
  const legacy = media.filter((r) => !((r.version === 1 || r.artifact) && r.mimeType.startsWith("image/"))).reduce((sum, r) => sum + r.size, 0);
  if (total > STAGED_BYTES || legacy > 4 * 1024 * 1024) throw new AttachmentError("attachments exceed their combined size limit");
}
