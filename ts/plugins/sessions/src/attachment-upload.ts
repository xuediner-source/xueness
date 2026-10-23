import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pyEquals, pyLen } from "@xueness/contracts";
import { AttachmentFiles } from "./attachment-fs.ts";
import { authorizedAttachment, decodeAttachment, validateContent, workspaceBytes } from "./attachment-content.ts";
import { AttachmentError, attachmentKeys, attachmentToken, byteLimit, CHUNK_BYTES, digest, MEDIA_BYTES, ORIGINS, ownershipId, publicAttachment, reservedMedia, sessionSelection, STAGED_BYTES, textMime, uploadProgress, validName, type AttachmentRow } from "./attachment-types.ts";
import { MediaArtifactStore } from "./media-store.ts";
export async function beginAttachment(files: AttachmentFiles, data: unknown): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "name", "mimeType", "size", "origin", "path", "version", "uploadId", "totalChunks", "checksum", "chunkBytes", "draftId"]);
  const root = await files.root(data.root), sid = sessionSelection(data.session_id), origin = data.origin;
  if (!ORIGINS.has(origin)) throw new AttachmentError();
  let name: string, mime: string, size: number, path = "", sha256 = "";
  if (origin === "workspace") {
    const content = workspaceBytes(files, root, data.path); name = Object.hasOwn(data, "name") ? data.name : basename(content.path);
    if (!validName(name) || name !== basename(content.path)) throw new AttachmentError();
    mime = content.mime; size = content.raw.length; path = content.path; sha256 = digest(content.raw);
  } else {
    if (Object.hasOwn(data, "path") || !validName(data.name) || typeof data.mimeType !== "string" || pyLen(data.mimeType) > 127) throw new AttachmentError();
    name = data.name; mime = data.mimeType; size = data.size;
    const limit = data.version === 1 ? byteLimit(name, mime) : Math.min(byteLimit(name, mime), MEDIA_BYTES);
    if (limit < 0) throw new AttachmentError();
    if (!Number.isInteger(size) || size < 0 || size > limit) throw new AttachmentError("attachment exceeds its size limit");
  }
  const record: AttachmentRow = { id: randomBytes(16).toString("hex"), name, mimeType: mime, size, origin, source: origin === "workspace" ? "workspace" : "upload", path, sha256, status: "pending", root, session_id: sid || "", created: Math.floor(Date.now() / 1000) };
  const transaction = ["version", "uploadId", "totalChunks", "checksum", "chunkBytes"].some((key) => Object.hasOwn(data, key));
  if (Object.hasOwn(data, "draftId")) record.draftId = ownershipId(data.draftId);
  if (transaction) {
    if (origin === "workspace" || (Object.hasOwn(data, "version") ? data.version : 1) !== 1) throw new AttachmentError("invalid upload version");
    if (!Number.isInteger(data.chunkBytes) || data.chunkBytes <= 0 || data.chunkBytes > CHUNK_BYTES || !Number.isInteger(data.totalChunks) || data.totalChunks !== Math.ceil(size / data.chunkBytes) || data.totalChunks > 128 || typeof data.checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(data.checksum)) throw new AttachmentError("invalid upload declaration");
    Object.assign(record, { version: 1, uploadId: ownershipId(data.uploadId), draftId: ownershipId(data.draftId), totalChunks: data.totalChunks, chunkBytes: data.chunkBytes, checksum: data.checksum, nextChunkIndex: 0, uploadedBytes: 0 });
  }
  return files.transaction(async () => {
    const directory = await files.scope(root, sid), records = await files.staged(directory);
    if (transaction) for (const [folder, existing] of records) if (folder === directory && existing.uploadId === record.uploadId) {
      if (["root", "session_id", "name", "mimeType", "size", "origin", "source", "draftId", "totalChunks", "chunkBytes", "checksum", "version"].some((key) => !pyEquals(existing[key], record[key]))) throw new AttachmentError("upload ID conflicts with another selection", 409);
      return uploadProgress(existing);
    }
    const owned = records.filter(([folder, r]) => folder === directory && (r.draftId ?? "") === (record.draftId ?? "")).map(([, r]) => r);
    const durable = (r: AttachmentRow): boolean => !!(r.version === 1 || r.artifact) && r.mimeType.startsWith("image/");
    if (owned.length >= 8 || !durable(record) && owned.filter((r) => !durable(r)).length >= 4) throw new AttachmentError(durable(record) ? "at most eight attachments are supported" : "at most four attachments are supported");
    if (records.length >= 256 || records.filter(([, r]) => r.status === "pending").length >= 64 || records.reduce((sum, [, r]) => sum + (r.size ?? 0), 0) + size > STAGED_BYTES) throw new AttachmentError("attachment staging capacity reached; release unused selections", 429);
    reservedMedia([...owned, record]); files.writeJson(files.path(directory, record.id), record); return uploadProgress(record);
  });
}
export async function chunkAttachment(files: AttachmentFiles, data: unknown): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "id", "chunkIndex", "data"], "attachment chunk");
  const root = await files.root(data.root), sid = sessionSelection(data.session_id), id = attachmentToken(data.id);
  const index = data.chunkIndex;
  if (!Number.isInteger(index) || index < 0 || typeof data.data !== "string" || data.data.length > 4 * Math.ceil(CHUNK_BYTES / 3)) throw new AttachmentError("invalid attachment chunk");
  const raw = decodeAttachment(data.data, CHUNK_BYTES);
  return files.transaction(async () => {
    const directory = await files.scope(root, sid), record = await files.record(directory, id, root, sid);
    if (record.version !== 1 || index >= record.totalChunks) throw new AttachmentError("invalid attachment chunk");
    const expected = Math.min(record.chunkBytes, record.size - index * record.chunkBytes);
    if (raw.length !== expected) throw new AttachmentError("attachment chunk size mismatch");
    if (index > record.nextChunkIndex) throw new AttachmentError("attachment chunks must be contiguous", 409);
    const path = files.path(directory, id, `.${index}.chunk`);
    if (index < record.nextChunkIndex) {
      const previous = record.status === "committed" ? files.readBytes(files.path(directory, id, ".bin")).subarray(index * record.chunkBytes, index * record.chunkBytes + expected) : files.readBytes(path);
      if (!previous.equals(raw)) throw new AttachmentError("conflicting attachment chunk retry", 409); return uploadProgress(record);
    }
    if (existsSync(path)) { if (!files.readBytes(path).equals(raw)) throw new AttachmentError("conflicting attachment chunk retry", 409); }
    else files.writeBytes(path, raw);
    record.nextChunkIndex += 1; record.uploadedBytes += raw.length; files.writeJson(files.path(directory, id), record); return uploadProgress(record);
  });
}
async function commitBudget(files: AttachmentFiles, root: string, directory: string, record: AttachmentRow, content: string): Promise<void> {
  let chars = pyLen(content); const owned = [record];
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const other = files.readJson(join(directory, name));
    if (other.id === record.id || (other.draftId ?? "") !== (record.draftId ?? "")) continue;
    owned.push(other);
    if (other.status !== "committed" || !textMime(other.mimeType ?? "")) continue;
    const raw = await authorizedAttachment(files, root, directory, other); chars += pyLen(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  }
  reservedMedia(owned); if (chars > 16000) throw new AttachmentError("attachments exceed their combined text limit");
}
export async function commitAttachment(files: AttachmentFiles, data: unknown): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "id", "data"]);
  return files.transaction(async () => {
    const { root, sid, id, directory } = await files.target(data), r = await files.record(directory, id, root, sid);
    if (r.version === 1 && Object.hasOwn(data, "data")) throw new AttachmentError("transaction commit must not contain data");
    if (r.source === "workspace") {
      if (r.status !== "committed" && Object.hasOwn(data, "data")) throw new AttachmentError();
      const snapshot = workspaceBytes(files, root, r.path);
      if (r.status === "committed") return publicAttachment(r);
      await commitBudget(files, root, directory, r, snapshot.text); r.status = "committed"; files.writeJson(files.path(directory, id), r); return publicAttachment(r);
    }
    if (r.status === "committed") {
      if (Object.hasOwn(data, "data")) { const raw = decodeAttachment(data.data); if (raw.length !== r.size || digest(raw) !== r.sha256) throw new AttachmentError(); }
      return publicAttachment(r);
    }
    let raw: Buffer;
    if (r.version === 1) {
      if (r.nextChunkIndex !== r.totalChunks) throw new AttachmentError("upload is incomplete", 409);
      raw = Buffer.concat(Array.from({ length: r.totalChunks }, (_, i) => files.readBytes(files.path(directory, id, `.${i}.chunk`))));
      if (raw.length !== r.size || "sha256:" + digest(raw) !== r.checksum) throw new AttachmentError("upload checksum or size mismatch", 409);
    } else { raw = decodeAttachment(data.data); if (raw.length !== r.size) throw new AttachmentError(); }
    const durable = !!(r.version === 1 || r.artifact) && r.mimeType.startsWith("image/");
    const content = validateContent(raw, r.mimeType, r.name, durable); await commitBudget(files, root, directory, r, content);
    if (durable) {
      const media = new MediaArtifactStore(files.options.stateDir), owner = files.draftOwner(r), previous = await media.listOwned(owner);
      const expected = { name: r.name, mimeType: r.mimeType, size: r.size, sha256: digest(raw) };
      if (previous.length) {
        if (previous.length !== 1 || Object.entries(expected).some(([key, value]) => previous[0]![key as keyof typeof previous[0]] !== value)) throw new AttachmentError("upload artifact binding changed", 409);
        if (!(await media.resolve(owner, previous[0]!.id)).equals(raw)) throw new AttachmentError("upload artifact contents changed", 409);
        r.artifact = previous[0];
      } else r.artifact = await media.importBytes(owner, raw, { name: r.name, mimeType: r.mimeType, size: r.size });
    }
    files.writeBytes(files.path(directory, id, ".bin"), raw); r.status = "committed"; r.sha256 = digest(raw);
    files.writeJson(files.path(directory, id), r); files.chunks(directory, id); return publicAttachment(r);
  });
}
