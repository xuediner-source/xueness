/** Composer attachments stay feature-owned behind the host's HTTP guards. */
import { existsSync } from "node:fs";
import { isLink } from "@xueness/sessions";
import { AttachmentFiles } from "./attachment-fs.ts";
import { attachmentPreview, authorizedAttachment } from "./attachment-content.ts";
import { beginAttachment, chunkAttachment, commitAttachment } from "./attachment-upload.ts";
import { restoreEpoch, restoreOperation } from "./attachment-receipts.ts";
import { restoreAttachments } from "./attachment-restore.ts";
import { AttachmentError, attachmentKeys, publicAttachment, uploadProgress, type AttachmentOptions, type AttachmentRow } from "./attachment-types.ts";
import type { SessionReply } from "./http-api.ts";
export async function disposeAttachment(files: AttachmentFiles, data: unknown, abort = false): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "id"], abort ? "attachment abort" : "attachment");
  return files.transaction(async () => {
    const { root, sid, id, directory } = await files.target(data), path = files.path(directory, id);
    if (abort && !existsSync(path) && !isLink(path)) return { status: "aborted" };
    let record: AttachmentRow;
    try { record = await files.record(directory, id, root, sid); }
    catch (error) {
      if (abort && error instanceof AttachmentError && error.status === 410) return { status: "aborted" };
      if (!abort && !existsSync(path) && !isLink(path)) return {};
      throw error;
    }
    if (abort && record.status === "committed") return { status: "committed", ref: publicAttachment(record) };
    await files.remove(directory, id); return abort ? { status: "aborted" } : {};
  });
}
export async function previewAttachment(files: AttachmentFiles, data: unknown): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "id", "chunkIndex"]);
  if (Object.hasOwn(data, "chunkIndex") && (!Number.isInteger(data.chunkIndex) || data.chunkIndex < 0 || data.chunkIndex >= 80)) throw new AttachmentError("invalid image preview chunk");
  return files.transaction(async () => {
    const { root, sid, id, directory } = await files.target(data), record = await files.record(directory, id, root, sid);
    if (record.status !== "committed") throw new AttachmentError();
    return attachmentPreview(record, await authorizedAttachment(files, root, directory, record), data.chunkIndex);
  });
}
export async function statusAttachment(files: AttachmentFiles, data: unknown): Promise<AttachmentRow> {
  attachmentKeys(data, ["root", "session_id", "id"], "attachment status");
  return files.transaction(async () => {
    const { root, sid, id, directory } = await files.target(data);
    const record = await files.record(directory, id, root, sid, true);
    return uploadProgress(record);
  });
}
export function createAttachmentsApi(options: AttachmentOptions) {
  const files = new AttachmentFiles(options);
  const actions = ["begin", "chunk", "abort", "commit", "status", "release", "preview", "restore-epoch", "restore-status", "restore-abort", "restore"];
  const owns = (_method: string, parts: readonly string[]): boolean => parts.slice(0, 3).join("/") === "api/composer/attachments";
  return { files, routes: actions.map((action) => "POST /api/composer/attachments/" + action), owns,
    async dispatch(method: string, parts: string[], _query: Record<string, unknown>, data: unknown): Promise<SessionReply | null> {
      if (!owns(method, parts)) return null;
      try {
        if (!options.enabled("sessions")) throw new AttachmentError("plugin disabled or dependency unavailable: sessions", 403);
        if (method !== "POST" || parts.length !== 4) return [405, { error: "method not allowed" }];
        switch (parts[3]) {
          case "begin": return [200, await beginAttachment(files, data)];
          case "chunk": return [200, await chunkAttachment(files, data)];
          case "commit": return [200, { ref: await commitAttachment(files, data), status: "committed" }];
          case "status": return [200, await statusAttachment(files, data)];
          case "abort": return [200, { ok: true, ...await disposeAttachment(files, data, true) }];
          case "release": await disposeAttachment(files, data); return [200, { ok: true }];
          case "preview": return [200, { preview: await previewAttachment(files, data) }];
          case "restore-epoch": return [200, await restoreEpoch(files, data)];
          case "restore-status": return [200, await restoreOperation(files, data)];
          case "restore-abort": return [200, await restoreOperation(files, data, true)];
          case "restore": return [200, await restoreAttachments(files, data)];
          default: return [404, { error: "unknown attachment action" }];
        }
      } catch (error) { return error instanceof AttachmentError ? [error.status, { error: error.message }] : [400, { error: "invalid attachment" }]; }
    },
  };
}
