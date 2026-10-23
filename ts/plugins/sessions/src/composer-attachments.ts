/**
 * Composer attachment intake (Python `composer_api._decode_browser_attachments`,
 * `_workspace_attachments`, `cli_input.snapshot` and
 * `composer_attachments.resolve_refs`): typed, bounded snapshots only.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname, resolve } from "node:path";
import { isDict, pyDecodeUtf8, pyLen } from "@xueness/contracts";
import { b64decodeStrict, validMediaSignature } from "@xueness/providers";
import { MAX_FILES, MAX_MEDIA_TOTAL_BYTES, MAX_TOTAL_CHARS, realish, type Attachment } from "@xueness/sessions";
import { authorizedAttachment } from "./attachment-content.ts";
import { AttachmentFiles } from "./attachment-fs.ts";
import { MEDIA_TYPES, textMime, type AttachmentRow } from "./attachment-types.ts";
import type { MediaRef } from "./media-db.ts";
import { MediaArtifactStore } from "./media-store.ts";
import type { Owner } from "./media-owner.ts";
import { ComposerError, ignoredFileSelection, isolatedRoots, parts, requireEnabled, rootCrossesIgnored, within, type ComposerScope } from "./composer-roots.ts";

const MAX_FILE_BYTES = 65536, MAX_FILE_CHARS = 8000, MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024;
const sha256 = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex");
export const checkKeys = (value: unknown, allowed: readonly string[], field: string): Record<string, unknown> => {
  if (!isDict(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ComposerError(400, "invalid " + field);
  return value;
};

/** `_extract_video_frames`: up to six JPEG frames from the local ffmpeg. */
export function videoFrames(raw: Uint8Array): Promise<string[]> {
  const fail = (message: string) => new ComposerError(400, message);
  return new Promise((done, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "fps=1/10,scale=768:768:force_original_aspect_ratio=decrease", "-frames:v", "6", "-fs", "12582912", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(fail("video could not be decoded within the local preview limit")); return; }
    const chunks: Buffer[] = []; let settled = false;
    const finish = (error: Error | null, frames?: string[]) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else done(frames!); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(fail("video could not be decoded within the local preview limit")); }, 8000);
    child.on("error", (error: NodeJS.ErrnoException) => finish(fail(error.code === "ENOENT" ? "video attachments require ffmpeg; extract up to 6 frames and attach those images" : "video could not be decoded within the local preview limit")));
    child.stdout!.on("data", (part: Buffer) => chunks.push(part));
    child.stderr!.resume(); child.stdin!.on("error", () => {});
    child.once("close", (code) => {
      if (code !== 0) { finish(fail("video could not be decoded")); return; }
      const output = Buffer.concat(chunks), frames: string[] = [];
      let offset = 0;
      while (frames.length < 6) {
        const start = output.indexOf(Buffer.from([0xff, 0xd8, 0xff]), offset);
        if (start < 0) break;
        const end = output.indexOf(Buffer.from([0xff, 0xd9]), start + 3);
        if (end < 0) break;
        frames.push(output.subarray(start, end + 2).toString("base64")); offset = end + 2;
      }
      finish(frames.length ? null : fail("video contains no decodable frames"), frames);
    });
    child.stdin!.end(Buffer.from(raw));
  });
}

/** `_decode_browser_attachments`: inline uploads become text or media snapshots. */
export async function decodeBrowserAttachments(items: unknown): Promise<Attachment[]> {
  if (items === null || items === undefined) return [];
  if (!Array.isArray(items) || items.length > MAX_FILES) throw new ComposerError(400, "at most four attachments are supported");
  const result: Attachment[] = [];
  let totalMedia = 0, totalText = 0;
  for (const item of items) {
    const { name, mimeType: mime, data: encoded } = checkKeys(item, ["name", "mimeType", "data"], "attachment");
    if (typeof name !== "string" || !name || pyLen(name) > 255 || /[/\\\x00-\x1f\x7f]/u.test(name) || name === "." || name === "..") throw new ComposerError(400, "invalid attachment");
    if (typeof mime !== "string" || typeof encoded !== "string") throw new ComposerError(400, "invalid attachment");
    const expected = MEDIA_TYPES[extname(name).toLowerCase()];
    if (encoded.length > 4 * Math.floor((MAX_MEDIA_FILE_BYTES + 2) / 3)) throw new ComposerError(400, "attachment exceeds its size limit");
    let raw: Buffer;
    try { raw = b64decodeStrict(encoded, "3.11"); } catch { throw new ComposerError(400, "invalid attachment data"); }
    if (raw.length > MAX_MEDIA_FILE_BYTES) throw new ComposerError(400, "attachment exceeds its size limit");
    const digest = sha256(raw);
    if (textMime(mime)) {
      if (expected !== undefined || raw.length > MAX_FILE_BYTES) throw new ComposerError(400, "text attachment exceeds its size limit");
      let content: string;
      try { content = pyDecodeUtf8(raw); } catch { throw new ComposerError(400, "text attachments must be UTF-8"); }
      if (content.includes("\0") || pyLen(content) > MAX_FILE_CHARS) throw new ComposerError(400, "text attachment exceeds its size limit");
      totalText += pyLen(content);
      result.push({ path: name, content, size: raw.length, sha256: digest });
      continue;
    }
    if (expected !== mime || !validMediaSignature(raw, mime)) throw new ComposerError(400, "attachment type does not match its contents");
    totalMedia += raw.length;
    if (totalMedia > MAX_MEDIA_TOTAL_BYTES) throw new ComposerError(400, "attachments exceed the total media size limit");
    if (mime.startsWith("video/")) result.push({ path: name, content: "", size: raw.length, sha256: digest, mimeType: mime, dataBase64: null, frames: await videoFrames(raw) });
    else result.push({ path: name, content: "", size: raw.length, sha256: digest, mimeType: mime, dataBase64: encoded });
  }
  if (totalText > MAX_TOTAL_CHARS) throw new ComposerError(400, "text attachments exceed the total size limit");
  return result;
}

function readBounded(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("附件必须是普通文件");
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read) read = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/** `cli_input.snapshot`: one regular workspace file, named by its resolved relative path. */
export async function snapshot(root: string, name: string): Promise<Attachment> {
  const base = realish(root), target = realish(resolve(base, name));
  if (!within(base, target)) throw new Error("附件必须位于当前工作区内");
  const mime = MEDIA_TYPES[extname(target).toLowerCase()];
  const limit = mime ? MAX_MEDIA_FILE_BYTES : MAX_FILE_BYTES;
  const data = readBounded(target, limit);
  if (data.length > limit) throw new Error(mime ? "media attachment exceeds 2 MiB" : "附件超过 64 KiB，未添加");
  const path = parts(base, target).join("/");
  if (mime) {
    if (!validMediaSignature(data, mime)) throw new Error("media extension does not match its file contents");
    const frames = mime.startsWith("video/") ? await videoFrames(data) : [];
    return { path, content: "", size: data.length, sha256: sha256(data), mimeType: mime, dataBase64: frames.length ? null : data.toString("base64"), frames };
  }
  const content = pyDecodeUtf8(data);
  if (content.includes("\0")) throw new Error("不支持二进制附件");
  if (pyLen(content) > MAX_FILE_CHARS) throw new Error("附件超过 8000 字符，未添加；请选取较小文件");
  return { path, content, size: data.length, sha256: sha256(data) };
}

/** `_workspace_attachments`: selected workspace files, never inside ignored directories. */
export async function workspaceAttachments(o: ComposerScope, root: string, values: unknown): Promise<Attachment[]> {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_FILES) throw new ComposerError(400, "at most four attachments are supported");
  if (values.length && rootCrossesIgnored(o, root)) throw new ComposerError(400, "workspace file unavailable");
  const result: Attachment[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || pyLen(value) > 1024) throw new ComposerError(400, "invalid workspace file selection");
    if (ignoredFileSelection(root, value)) throw new ComposerError(400, "workspace file unavailable");
    try { result.push(await snapshot(root, value)); }
    catch { throw new ComposerError(400, "workspace file unavailable"); }
  }
  return result;
}

/** `composer_attachments.resolve_refs`: committed draft attachments, durable media kept by reference. */
export async function resolveRefs(o: ComposerScope, root: string, sid: string | null, refs: unknown, media: [MediaRef, Owner][]): Promise<[Attachment[], Attachment[]]> {
  if (refs === null || refs === undefined) return [[], []];
  if (!Array.isArray(refs)) throw new ComposerError(400, "invalid attachment");
  if (!refs.length) return [[], []];
  requireEnabled(o, "sessions");
  if (refs.length > 8) throw new ComposerError(400, "at most eight attachments are supported");
  const files = new AttachmentFiles({ store: o.store, stateDir: o.stateDir, webRuns: o.webRuns, projectDir: o.projectDir, enabled: o.enabled, allowedRoots: o.allowedRoots });
  const browser: Attachment[] = [], workspace: Attachment[] = [], seen = new Set<string>();
  await files.transaction(async () => {
    for (const item of refs) {
      const { id } = checkKeys(item, ["id"], "attachment ref");
      if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new ComposerError(400, "invalid attachment");
      const directory = await files.scope(root, sid);
      const record: AttachmentRow = await files.record(directory, id, root, sid);
      if (record.status !== "committed" || seen.has(record.id)) throw new ComposerError(400, "invalid attachment");
      seen.add(record.id);
      if (record.artifact) {
        const owner = files.draftOwner(record);
        media.push([await new MediaArtifactStore(o.stateDir).describe(owner, record.artifact.id), owner]);
        continue;
      }
      if (record.source === "workspace") {
        requireEnabled(o, "files");
        if (isolatedRoots(o).includes(root)) throw new ComposerError(400, "isolated workspaces cannot reference shared files or sessions");
        if (ignoredFileSelection(root, record.path)) throw new ComposerError(400, "workspace file unavailable");
        let shot: Attachment;
        try { shot = await snapshot(root, record.path); } catch { throw new ComposerError(400, "workspace file unavailable"); }
        if (record.restored && shot.sha256 !== record.sha256) throw new ComposerError(400, "workspace file unavailable");
        workspace.push(shot);
      } else {
        const raw = await authorizedAttachment(files, root, directory, record);
        browser.push(...await decodeBrowserAttachments([{ name: record.name, mimeType: record.mimeType, data: raw.toString("base64") }]));
      }
    }
  });
  return [browser, workspace];
}
