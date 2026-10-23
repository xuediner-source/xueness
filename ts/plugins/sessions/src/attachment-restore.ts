import { randomBytes } from "node:crypto";
import { isDict, pyEquals, pyLen } from "@xueness/contracts";
import type { AttachmentFiles } from "./attachment-fs.ts";
import { messageSnapshot } from "./attachment-history.ts";
import { messageRevision } from "./journal-http.ts";
import { messageOwner, messageRefs } from "./media-history.ts";
import { MediaArtifactStore } from "./media-store.ts";
import { replayRestore, restoreIdentity, RestoreReceipts, restoreSession } from "./attachment-receipts.ts";
import { AttachmentError, attachmentKeys, publicAttachment, sessionSelection, STAGED_BYTES, type AttachmentRow as Row } from "./attachment-types.ts";
export async function restoreAttachments(files: AttachmentFiles, data: unknown): Promise<Row> {
  attachmentKeys(data, ["root", "session_id", "messageIndex", "revision", "restoreId", "restoreEpoch"], "attachment restore");
  const sid = sessionSelection(data.session_id), index = data.messageIndex, expected = data.revision;
  if (!sid || !Number.isInteger(index) || index < 0 || typeof expected !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expected)) throw new AttachmentError("invalid attachment restore");
  const session = await restoreSession(files, sid); if (!session) throw new AttachmentError("session not found", 404);
  const root = await files.root(session.root);
  if (Object.hasOwn(data, "root") && await files.root(data.root) !== root) throw new AttachmentError("workspace root not permitted");
  const ident = Object.hasOwn(data, "restoreId") ? restoreIdentity(root, sid, data) : null;
  if (ident) {
    const previous = await files.transaction(async () => new RestoreReceipts(files, await files.scope(root, sid)).load(ident));
    if (previous) return replayRestore(previous);
  }
  if (messageRevision(session) !== expected) throw new AttachmentError("conversation changed; refresh before editing this message", 409);
  const messages = session.messages;
  if (!Array.isArray(messages) || index >= messages.length || !isDict(messages[index]) || messages[index].role !== "user") throw new AttachmentError("invalid attachment restore target");
  const snapshot = await messageSnapshot(files, session, index), text = snapshot.text;
  if (typeof text !== "string" || pyLen(text) > 50000) throw new AttachmentError("invalid attachment restore text");
  const recovered: { record: Row; raw: Buffer | null }[] = snapshot.recovered.map((r) => ({ record: r.record, raw: r.raw }));
  const durable = messageRefs(messages[index]), media = new MediaArtifactStore(files.options.stateDir), sourceOwner = durable.length ? messageOwner(session, messages[index]) : null;
  for (const ref of durable) {
    if (!pyEquals(await media.describe(sourceOwner!, ref.id), ref)) throw new AttachmentError("saved media metadata changed", 409);
    recovered.push({ record: { id: randomBytes(16).toString("hex"), name: ref.name, mimeType: ref.mimeType, size: ref.size, origin: "file", source: "upload", path: "", sha256: ref.sha256, status: "committed", root, session_id: sid, created: Math.floor(Date.now() / 1000), restored: true, artifact: ref }, raw: null });
  }
  return files.transaction(async () => {
    const directory = await files.scope(root, sid), staged = await files.staged(directory), receipts = new RestoreReceipts(files, directory);
    const remaining = Math.max(0, Math.min((durable.length ? 8 : 4) - staged.filter(([d]) => d === directory).length, 256 - staged.length));
    let bytes = staged.reduce((n, [, r]) => n + r.size, 0);
    if (durable.length && (recovered.length > remaining || bytes + recovered.reduce((n, r) => n + r.record.size, 0) > STAGED_BYTES)) throw new AttachmentError("attachment restore capacity exhausted", 409);
    const selected: typeof recovered = [];
    for (const entry of recovered.slice(0, remaining)) { if (bytes + entry.record.size > STAGED_BYTES) break; bytes += entry.record.size; selected.push(entry); }
    const result = { text, refs: selected.map(({ record }) => publicAttachment(record)), root }; let receipt: Row | null = null;
    if (ident) {
      const previous = receipts.load(ident); if (previous) return replayRestore(previous);
      for (const { record } of selected) record.restoreId = ident.restoreId;
      receipt = receipts.begin(ident, result);
    }
    const written: string[] = [];
    try {
      for (const { record, raw } of selected) {
        written.push(record.id);
        if (record.artifact) {
          record.status = "pending"; files.writeJson(files.path(directory, record.id), record);
          await media.adopt(sourceOwner!, files.draftOwner(record), [record.artifact.id]); record.status = "committed";
        } else if (record.source === "upload") files.writeBytes(files.path(directory, record.id, ".bin"), raw!);
        files.writeJson(files.path(directory, record.id), record);
      }
      if (receipt) { receipt.status = "committed"; receipts.save(ident!, receipt); }
    } catch (e) {
      // Receipts retain the complete allocation through uncertain writes/adoption.
      if (!receipt) for (const id of written) await files.remove(directory, id);
      throw e;
    }
    return result;
  });
}
