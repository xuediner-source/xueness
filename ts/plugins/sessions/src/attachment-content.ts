/** Typed, bounded attachment reads. Content never grants execution authority. */
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { pyCasefold, pyDecodeUtf8, pyLen, pySlice } from "@xueness/contracts";
import { b64decodeStrict, validMediaSignature } from "@xueness/providers";
import { readRegularBeneath, realish } from "@xueness/sessions";
import { MediaArtifactStore } from "./media-store.ts";
import type { AttachmentFiles } from "./attachment-fs.ts";
import { AttachmentError, byteLimit, digest, IMAGE_BYTES, MEDIA_BYTES, MEDIA_TYPES, textMime, type AttachmentRow } from "./attachment-types.ts";
const HIDDEN = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".state", ".web-runs"]);
export function boundedAttachmentPath(path: unknown): string {
  if (typeof path !== "string" || !path || pyLen(path) > 1024 || /[\\\0]/.test(path) || /^[A-Za-z]:/.test(path) || path.split("/").some((p) => !p || p === "." || p === "..")) throw new AttachmentError("workspace file unavailable");
  return path;
}
export function decodeAttachment(encoded: unknown, limit = MEDIA_BYTES): Buffer {
  if (typeof encoded !== "string") throw new AttachmentError();
  if (encoded.length > 4 * Math.ceil(limit / 3)) throw new AttachmentError("attachment exceeds its size limit");
  try { return b64decodeStrict(encoded, "3.11"); } catch { throw new AttachmentError("invalid attachment data"); }
}
export function validateContent(raw: Buffer, mime: string, name: string, durable = false): string {
  const expected = MEDIA_TYPES[extname(name).toLowerCase()];
  if (textMime(mime)) {
    if (expected || raw.length > 65536) throw new AttachmentError("text attachment exceeds its size limit");
    let text: string; try { text = pyDecodeUtf8(raw); } catch { throw new AttachmentError("text attachments must be UTF-8"); }
    if (text.includes("\0") || pyLen(text) > 8000) throw new AttachmentError("text attachment exceeds its size limit");
    return text;
  }
  if (expected !== mime || !validMediaSignature(raw, mime)) throw new AttachmentError("attachment type does not match its contents");
  if (raw.length > (durable && mime.startsWith("image/") ? IMAGE_BYTES : MEDIA_BYTES)) throw new AttachmentError("attachment exceeds its size limit");
  if (mime.startsWith("video/")) {
    let frames: Buffer;
    try { frames = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "fps=1/10,scale=768:768:force_original_aspect_ratio=decrease", "-frames:v", "6", "-fs", "12582912", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { input: raw, timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { const code = (e as NodeJS.ErrnoException).code; throw new AttachmentError(code === "ENOENT" ? "video attachments require ffmpeg; extract up to 6 frames and attach those images" : code ? "video could not be decoded within the local preview limit" : "video could not be decoded"); }
    const start = frames.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (start < 0 || frames.indexOf(Buffer.from([0xff, 0xd9]), start + 3) < 0) throw new AttachmentError("video contains no decodable frames");
  }
  return "";
}
export function workspaceBytes(files: AttachmentFiles, root: string, path: unknown, expectedMime?: string): { raw: Buffer; mime: string; text: string; path: string } {
  if (!files.options.enabled("files")) throw new AttachmentError("plugin disabled or dependency unavailable: files", 403);
  if ([realish(files.options.webRuns), realish("/tmp")].includes(root)) throw new AttachmentError("isolated workspaces cannot reference shared files or sessions");
  const name = boundedAttachmentPath(path);
  if (name.split("/").some((p) => HIDDEN.has(pyCasefold(p)))) throw new AttachmentError("workspace file unavailable");
  const mime = MEDIA_TYPES[extname(name).toLowerCase()] ?? "text/plain", max = byteLimit(name, mime);
  const result = readRegularBeneath(root, name, Math.min(max, MEDIA_BYTES) + 1);
  if (!result || result.size > Math.min(max, MEDIA_BYTES) || expectedMime && mime !== expectedMime) throw new AttachmentError("workspace file unavailable");
  try { return { raw: result.raw, mime, text: validateContent(result.raw, mime, name), path: name }; }
  catch { throw new AttachmentError("workspace file unavailable"); }
}
export async function authorizedAttachment(files: AttachmentFiles, root: string, directory: string, record: AttachmentRow): Promise<Buffer> {
  if (record.artifact) return new MediaArtifactStore(files.options.stateDir).resolve(files.draftOwner(record), record.artifact.id);
  const raw = record.source === "workspace" ? workspaceBytes(files, root, record.path, record.mimeType || "").raw : files.readBytes(files.path(directory, record.id, ".bin"));
  if ((record.source !== "workspace" || record.restored) && (raw.length !== record.size || digest(raw) !== record.sha256)) throw new AttachmentError(record.source === "workspace" ? "workspace file unavailable" : "invalid attachment");
  return raw;
}
export function attachmentPreview(record: AttachmentRow, raw: Buffer, index?: unknown): AttachmentRow {
  const mime = record.mimeType;
  if (typeof mime !== "string") throw new AttachmentError();
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "pdf" : textMime(mime) ? "text" : "file";
  const result: AttachmentRow = { id: record.id, name: record.name, mimeType: mime, size: raw.length, kind, truncated: false };
  if (kind === "image" && (raw.length > MEDIA_BYTES || index !== undefined)) {
    if (raw.length <= 0 || raw.length > IMAGE_BYTES || !validMediaSignature(raw, mime)) throw new AttachmentError("invalid image preview");
    const chunk = index ?? 0, chunkBytes = 256 * 1024, count = Math.ceil(raw.length / chunkBytes);
    if (!Number.isInteger(chunk) || Number(chunk) < 0 || Number(chunk) >= count) throw new AttachmentError("invalid image preview chunk");
    return { ...result, schema: "xueness.image-preview-chunk.v1", sha256: digest(raw), chunkIndex: chunk, chunkBytes, totalChunks: count, data: raw.subarray(Number(chunk) * chunkBytes, (Number(chunk) + 1) * chunkBytes).toString("base64") };
  }
  if (index !== undefined) throw new AttachmentError("chunk preview requires an image");
  if (["image", "video", "pdf"].includes(kind)) {
    if (raw.length > MEDIA_BYTES) throw new AttachmentError("large image preview unavailable; the attachment remains ready to send", 413);
    if (!validMediaSignature(raw, mime)) throw new AttachmentError(); return { ...result, data: raw.toString("base64") };
  }
  if (kind === "text") {
    let text: string; try { text = pyDecodeUtf8(raw); } catch { throw new AttachmentError(); }
    if (text.includes("\0") || record.source === "workspace" && pyLen(text) > 8000) throw new AttachmentError();
    return { ...result, text: pySlice(text, 2000), truncated: pyLen(text) > 2000 };
  }
  return result;
}
