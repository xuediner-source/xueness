import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pyEquals, pyJsonDumps, pyLen } from "@xueness/contracts";
import { fsyncDirectory, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";
import { Owner } from "./media-owner.ts";
import { IMAGE_MIMES, MAX_DISK_BYTES, MAX_IMAGE_BYTES, MAX_RECORDS, MAX_STAGED_BYTES, MediaArtifactError, MediaDatabase, readMedia, type MediaDb, type MediaRef } from "./media-db.ts";

export const commandIssued = (id: string): number | null => /^c_([0-9]{13})_([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(id) ? Number(id.slice(2, 15)) : null;
export class MediaArtifactStore extends MediaDatabase {
  importBytes(owner: Owner, bytes: Uint8Array, options: { name: string; mimeType: string; size: number }): Promise<MediaRef> {
    const { name, mimeType, size } = options;
    if (!(owner instanceof Owner) || !IMAGE_MIMES.has(mimeType) || !Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) throw new MediaArtifactError("invalid media import");
    if (typeof name !== "string" || !name || pyLen(name) > 512 || name.includes("\0")) throw new MediaArtifactError("invalid media name");
    return this.transaction((db) => {
      this.collect(db);
      if (Object.keys(db.artifacts).length >= MAX_RECORDS) throw new MediaArtifactError("media record budget exceeded");
      let used = 0;
      for (const name of readdirSync(this.blobs)) {
        const s = lstatSync(join(this.blobs, name));
        if (!s.isFile() || s.nlink !== 1) throw new MediaArtifactError("invalid media blob");
        used += s.size;
      }
      const staged = Object.values(db.artifacts).filter((r) => r.owners.some((o) => JSON.parse(o)[0] === "draft")).reduce((n, r) => n + r.size, 0);
      if (used + size > MAX_DISK_BYTES || owner.kind === "draft" && staged + size > MAX_STAGED_BYTES) throw new MediaArtifactError("media storage budget exceeded");
      const id = randomBytes(24).toString("hex");
      const record = { id, name, mimeType, size, sha256: "", owners: [owner.token()] };
      this.quota(db, owner, [record]);
      const temp = mkstemp(this.blobs, ".import-"); let fd: number | null = temp.fd;
      try {
        if (bytes.byteLength !== size) throw new MediaArtifactError("invalid media stream size");
        protectPrivateFile(fd); writeAll(fd, bytes); fsyncSync(fd); closeSync(fd); fd = null;
        record.sha256 = createHash("sha256").update(bytes).digest("hex");
        replaceFile(temp.path, join(this.blobs, id + ".bin")); fsyncDirectory(this.blobs);
        db.artifacts[id] = record; this.save(db); return this.ref(record);
      } finally { if (fd !== null) closeSync(fd); if (existsSync(temp.path)) unlinkSync(temp.path); }
    });
  }
  listOwned(owner: Owner): Promise<MediaRef[]> {
    if (!(owner instanceof Owner)) throw new MediaArtifactError("invalid media owner");
    return this.transaction((db) => Object.values(db.artifacts).filter((r) => r.owners.includes(owner.token())).map((r) => this.ref(r)));
  }
  describe(owner: Owner, id: string): Promise<MediaRef> { return this.transaction((db) => this.ref(this.owned(db, owner, id))); }
  resolve(owner: Owner, id: string): Promise<Buffer> {
    return this.transaction((db) => {
      const record = this.owned(db, owner, id), raw = readMedia(join(this.blobs, id + ".bin"), MAX_IMAGE_BYTES);
      if (raw.length !== record.size || createHash("sha256").update(raw).digest("hex") !== record.sha256) throw new MediaArtifactError("media integrity check failed");
      return raw;
    });
  }
  adopt(source: Owner, target: Owner, ids: readonly string[]): Promise<MediaRef[]> {
    return this.transaction((db) => {
      const records = ids.map((id) => this.owned(db, source, id)); this.quota(db, target, records);
      for (const r of records) if (!r.owners.includes(target.token())) r.owners.push(target.token());
      this.save(db); return records.map((r) => this.ref(r));
    });
  }
  release(owner: Owner, ids?: readonly string[]): Promise<void> {
    return this.transaction((db) => {
      const selected = ids ? new Set(ids) : null;
      for (const [id, r] of Object.entries(db.artifacts)) if ((!selected || selected.has(id)) && r.owners.includes(owner.token())) r.owners.splice(r.owners.indexOf(owner.token()), 1);
      this.save(db); this.collect(db);
    });
  }
  async pin(source: Owner, ids: readonly string[], key: string): Promise<{ owner: Owner; release: () => Promise<void> }> {
    const owner = new Owner("provider_pin", key + ":" + randomBytes(16).toString("hex"), source.root, source.sessionId);
    await this.adopt(source, owner, ids);
    return { owner, release: () => this.release(owner) };
  }
  admissionKey(commandId: string, destination: Owner): string {
    if (typeof commandId !== "string" || !commandId || pyLen(commandId) > 256) throw new MediaArtifactError("invalid media command");
    return createHash("sha256").update(pyJsonDumps([commandId, destination.token()], { ensureAscii: true })).digest("hex");
  }
  reserveAdmission(commandId: string, destination: Owner, sources: readonly [Owner, readonly string[]][], fingerprint: string): Promise<Owner> {
    if (typeof fingerprint !== "string" || !fingerprint || pyLen(fingerprint) > 256) throw new MediaArtifactError("invalid admission fingerprint");
    const key = this.admissionKey(commandId, destination), owner = new Owner("admission", key, destination.root, destination.sessionId);
    const binding = { commandId, destination: destination.token(), sources: sources.map(([s, ids]): [string, string[]] => [s.token(), [...ids]]), fingerprint };
    return this.transaction((db) => {
      this.pruneReceipts(db);
      const prior = db.admissions[key];
      if (prior) { if (!pyEquals(prior.binding, binding)) throw new MediaArtifactError("conflicting media admission"); return owner; }
      const issued = commandIssued(commandId);
      if (issued !== null && issued <= (db.retiredCommandBefore ?? 0)) throw new MediaArtifactError("media command receipt has retired");
      if (Object.keys(db.admissions).length >= MAX_RECORDS) throw new MediaArtifactError("media admission budget exceeded");
      const records = sources.flatMap(([source, ids]) => ids.map((id) => this.owned(db, source, id)));
      this.quota(db, owner, records);
      for (const r of records) if (!r.owners.includes(owner.token())) r.owners.push(owner.token());
      db.admissions[key] = { binding, ids: records.map((r) => r.id), status: "reserved", target: null }; this.save(db); return owner;
    });
  }
  finalizeAdmission(commandId: string, destination: Owner, target: Owner): Promise<MediaRef[]> {
    const key = this.admissionKey(commandId, destination), owner = new Owner("admission", key, destination.root, destination.sessionId);
    if (!["queue", "steering", "message", "fork"].includes(target.kind) || target.root !== destination.root || target.sessionId !== destination.sessionId) throw new MediaArtifactError("invalid admission destination");
    return this.transaction((db) => {
      const a = db.admissions[key]; if (!a) throw new MediaArtifactError("missing media admission");
      if (a.status === "finalized") { if (a.target !== target.token()) throw new MediaArtifactError("conflicting media finalization"); return a.ids.map((id) => this.ref(this.owned(db, target, id))); }
      const records = a.ids.map((id) => this.owned(db, owner, id)); this.quota(db, target, records);
      for (const r of records) { if (!r.owners.includes(target.token())) r.owners.push(target.token()); r.owners.splice(r.owners.indexOf(owner.token()), 1); }
      a.status = "finalized"; a.target = target.token(); this.save(db); return records.map((r) => this.ref(r));
    });
  }
  pruneReceipts(db: MediaDb): void {
    const cutoff = Date.now() - 86400000;
    let retired = db.retiredCommandBefore ?? 0;
    if (!Number.isInteger(retired) || retired < 0) throw new MediaArtifactError("invalid media retirement boundary");
    const removed: string[] = [];
    for (const [key, receipt] of Object.entries(db.admissions)) {
      const issued = commandIssued(receipt.binding.commandId);
      if (receipt.status !== "finalized" || issued === null || issued > cutoff) continue;
      const records = receipt.ids.map((id) => db.artifacts[id]);
      if (records.every((r) => r && r.owners.includes(receipt.target!)) || records.every((r) => !r)) { removed.push(key); retired = Math.max(retired, issued); }
    }
    if (removed.length) { for (const key of removed) delete db.admissions[key]; db.retiredCommandBefore = retired; this.save(db); }
  }
  collect(db: MediaDb): { removedBlobs: number; retainedArtifacts: number; retainedAdmissions: number } {
    const names = readdirSync(this.blobs);
    if (names.length > MAX_RECORDS * 2) throw new MediaArtifactError("media cleanup scan budget exceeded");
    for (const name of names) { const s = lstatSync(join(this.blobs, name)); if (!s.isFile() || s.nlink !== 1 || s.isSymbolicLink() || !(/^[a-f0-9]{48}\.bin$/.test(name) || name.startsWith(".import-"))) throw new MediaArtifactError("invalid orphan media file"); }
    this.pruneReceipts(db);
    const dead = Object.keys(db.artifacts).filter((id) => db.artifacts[id]!.owners.length === 0);
    for (const id of dead) delete db.artifacts[id];
    if (dead.length) this.save(db);
    let removedBlobs = 0;
    for (const name of names) { if (name.endsWith(".bin") && db.artifacts[name.slice(0, -4)]) continue; unlinkSync(join(this.blobs, name)); removedBlobs++; }
    if (removedBlobs) fsyncDirectory(this.blobs);
    return { removedBlobs, retainedArtifacts: Object.keys(db.artifacts).length, retainedAdmissions: Object.keys(db.admissions).length };
  }
  reconcile() { return this.transaction((db) => this.collect(db)); }
}
