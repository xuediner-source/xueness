import { createHash } from "node:crypto";
import { pyEquals, pyJsonDumps, PyValueError, uuid4Hex } from "@xueness/contracts";
import type { SessionStore } from "@xueness/sessions";
import { Owner } from "./media-owner.ts";
import { MediaArtifactStore } from "./media-store.ts";
import { ACTIVE, type Row } from "./queue-types.ts";
export const mediaRefs = (prepared?: Row | null): Row[] => prepared?.metadata?.media_refs ?? [];
export const ownerRow = (owner: Owner): Row => ({ kind: owner.kind, key: owner.key, root: owner.root, session_id: owner.sessionId });
export const rowOwner = (row: Row): Owner => new Owner(row.kind, row.key, row.root, row.session_id ?? null);
export interface QueueMediaContext { stateDir: string; command?: { id: string; fingerprint: string }; enabled?: (id: string) => boolean; }
export class QueueMedia {
  readonly store: SessionStore;
  readonly context: QueueMediaContext | undefined;
  readonly kind: string;
  constructor(store: SessionStore, kind: string, context?: QueueMediaContext) { this.store = store; this.kind = kind; this.context = context; }
  itemId(sid: string, prepared?: Row | null, requestId?: string | null): string {
    if (!mediaRefs(prepared).length) return uuid4Hex();
    const id = this.context?.command?.id || requestId;
    if (!id) throw new PyValueError("prepared media requires a stable command envelope");
    return createHash("sha256").update(pyJsonDumps([this.kind, sid, id], { ensureAscii: true })).digest("hex").slice(0, 32);
  }
  async reserve(sid: string, item: Row, session?: Row): Promise<void> {
    const prepared = item.prepared ?? {};
    if (!mediaRefs(prepared).length) return;
    if (!this.context) throw new PyValueError("media queue requires an authorized context");
    if (this.context.enabled && !this.context.enabled("sessions")) throw new PyValueError("sessions plugin unavailable");
    session ??= await this.store.load(sid);
    const target = new Owner(this.kind, item.id, session.root, sid);
    const command = this.context.command ?? { id: item.submission?.id, fingerprint: item.submission?.fingerprint };
    if (!command.id) throw new PyValueError("prepared media requires a stable command envelope");
    const sources: [Owner, string[]][] = (prepared.media_sources ?? []).map((r: Row) => [rowOwner(r.owner), r.ids]);
    if (sources.some(([s]) => s.sessionId !== null && s.sessionId !== sid || s.root !== target.root)) throw new PyValueError("prepared media source scope changed");
    if (!pyEquals(sources.flatMap(([, ids]) => ids), mediaRefs(prepared).map((r) => r.id))) throw new PyValueError("prepared media source binding unavailable");
    await new MediaArtifactStore(this.context.stateDir).reserveAdmission(command.id, target, sources, command.fingerprint);
    prepared.media_admission = { command_id: command.id, destination: ownerRow(target) };
    item._media_owner = ownerRow(target);
  }
  async finalize(sid: string, item: Row, session?: Row): Promise<void> {
    if (!item._media_owner) return;
    if (!this.context) throw new PyValueError("media queue requires an authorized context");
    const owner = rowOwner(item._media_owner); session ??= await this.store.load(sid);
    if (owner.kind !== this.kind || owner.key !== item.id || owner.sessionId !== sid || owner.root !== new Owner(this.kind, item.id, session.root, sid).root) throw new PyValueError("media queue scope mismatch");
    const prepared = item.prepared ?? {}, refs = mediaRefs(prepared);
    if (!refs.length) return;
    if (!prepared.media_admission || !pyEquals(prepared.media_admission.destination, ownerRow(owner))) throw new PyValueError("prepared media destination changed");
    const media = new MediaArtifactStore(this.context.stateDir);
    try { if ((await Promise.all(refs.map((r) => media.describe(owner, r.id)))).every((ref, i) => pyEquals(ref, refs[i]))) return; } catch (e) { if (!(e instanceof PyValueError)) throw e; }
    try { await media.finalizeAdmission(prepared.media_admission.command_id, owner, owner); }
    catch (e) { throw new Error("media acceptance finalization requires recovery", { cause: e }); }
  }
  async releaseSettled(sid: string, before: Row[], after: Row[]): Promise<void> {
    if (!this.context) return;
    const remaining = new Set(after.filter((r) => ACTIVE.has(r.status)).map((r) => r.id));
    for (const item of before) if (ACTIVE.has(item.status) && !remaining.has(item.id) && item._media_owner) {
      await this.finalize(sid, item);
      await new MediaArtifactStore(this.context.stateDir).release(rowOwner(item._media_owner));
    }
  }
}
