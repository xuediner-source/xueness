import { isDict, isPyIntValue, pyLen, PyValueError } from "@xueness/contracts";
import { apply, scan, type Session } from "@xueness/sessions";
import { IMAGE_MIMES, MAX_IMAGE_BYTES, type MediaRef } from "./media-db.ts";
import { Owner } from "./media-owner.ts";
type Row = Record<string, unknown>;
export function messageOwner(session: Session, message: Row): Owner {
  if (typeof message._message_id !== "string" || !/^[0-9a-f]{32}$/.test(message._message_id)) throw new PyValueError("invalid media message identity");
  return new Owner("message", message._message_id, String(session.root), String(session.id));
}
export function messageRefs(message: Row): MediaRef[] {
  const refs = message._media_refs ?? [];
  if (!Array.isArray(refs) || refs.length > 8) throw new PyValueError("invalid message media");
  for (const r of refs) if (!isDict(r) || Object.keys(r).sort().join(",") !== "id,mimeType,name,sha256,size" || typeof r.id !== "string" || !/^[0-9a-f]{48}$/.test(r.id) || typeof r.name !== "string" || pyLen(r.name) > 255 || typeof r.mimeType !== "string" || !IMAGE_MIMES.has(r.mimeType) || !isPyIntValue(r.size) || Number(r.size) <= 0 || Number(r.size) > MAX_IMAGE_BYTES || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) throw new PyValueError("invalid message media reference");
  return refs.map((r) => ({ ...r })) as MediaRef[];
}
export function retainedOwners(session: Session, histories: readonly string[], backups: readonly Session[]): Owner[] {
  const owners = new Map<string, Owner>();
  const collect = (state: unknown) => {
    if (!isDict(state) || state.id !== session.id || state.root !== session.root) throw new PyValueError("retained media session scope mismatch");
    for (const key of ["messages", "archived_messages"]) for (const message of (state[key] ?? []) as unknown[]) if (isDict(message) && messageRefs(message).length) { const owner = messageOwner(session, message); owners.set(owner.token(), owner); }
  };
  collect(session); for (const s of backups) collect(s);
  for (const path of histories) { let state: unknown = {}; for (const r of scan(path).records) { state = apply(state, r.operations); collect(state); } }
  return [...owners.values()];
}
