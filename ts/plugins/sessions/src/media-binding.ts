import { isDict, pyDeepCopy, pyEquals, PyValueError } from "@xueness/contracts";
import { markBoundMediaMessage, transferToolMedia, validMediaSignature, type MediaBinding, type MediaProvider, type RequestMedia } from "@xueness/providers";
import type { Session } from "@xueness/sessions";
import { IMAGE_MIMES, MAX_IMAGE_BYTES, MAX_SELECTION, MAX_SELECTION_BYTES, type MediaRef } from "./media-db.ts";
import { Owner } from "./media-owner.ts";
import { MediaArtifactStore } from "./media-store.ts";
type Dict = Record<string, unknown>;

/** Prepare exact journal objects; a cloned message never conveys attachment authority. */
export async function bindMediaPrompt(store: MediaArtifactStore, session: Session, selected: readonly Dict[], enabled: (id: string) => boolean): Promise<{ messages: Dict[]; media: MediaBinding; release(): Promise<void> }> {
  const accepted = new Set(Array.isArray(session.messages) ? session.messages : []);
  const messages: Dict[] = [];
  const bindings = new Map<Dict, { refs: MediaRef[]; attachments: Dict[] }>();
  const pins: { release(): Promise<void> }[] = [];
  let live = true;
  const release = async () => { live = false; const closing = pins.splice(0); for (const pin of closing.reverse()) await pin.release(); bindings.clear(); };
  try {
    for (const source of selected) {
      const item = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("_")));
      messages.push(item); transferToolMedia(source, item);
      if (!source._media_refs || Array.isArray(source._media_refs) && source._media_refs.length === 0) continue;
      if (source.role !== "user" || !accepted.has(source)) throw new PyValueError("media message is not an accepted journal member");
      if (typeof source._message_id !== "string" || !source._message_id) throw new PyValueError("media message identity is missing");
      markBoundMediaMessage(item);
      for (const id of ["providers", "sessions"]) if (!enabled(id)) throw new PyValueError("plugin disabled: " + id);
      const refs = pyDeepCopy(source._media_refs) as MediaRef[];
      if (!Array.isArray(refs) || !refs.length || refs.length > MAX_SELECTION) throw new PyValueError("invalid trusted media selection");
      if (refs.some((r) => !isDict(r) || !Number.isInteger(r.size) || r.size <= 0 || r.size > MAX_IMAGE_BYTES)) throw new PyValueError("invalid trusted media reference");
      if (refs.reduce((n, r) => n + r.size, 0) > MAX_SELECTION_BYTES) throw new PyValueError("trusted media selection budget exceeded");
      const owner = new Owner("message", source._message_id, String(session.root), String(session.id));
      if (source._media_admission) await recoverMediaMessage(store, session, source, refs, owner);
      const pin = await store.pin(owner, refs.map((r) => r.id), owner.key); pins.push(pin);
      const attachments: Dict[] = [];
      for (const ref of refs) {
        const actual = await store.describe(pin.owner, ref.id);
        if (!pyEquals(actual, ref) || !IMAGE_MIMES.has(actual.mimeType)) throw new PyValueError("trusted media reference metadata mismatch");
        const raw = await store.resolve(pin.owner, ref.id);
        if (!validMediaSignature(raw, actual.mimeType)) throw new PyValueError("trusted media signature mismatch");
        attachments.push({ mimeType: actual.mimeType, data: raw.toString("base64") });
      }
      bindings.set(item, { refs, attachments });
    }
    const media: MediaBinding = { resolve(message: Dict, provider: MediaProvider, request: RequestMedia): Dict[] {
      const entry = bindings.get(message);
      if (!live) throw new PyValueError("media references require an authorized invocation");
      if (!entry) { if (message._media_refs) throw new PyValueError("media references require an authorized invocation"); return []; }
      for (const id of ["providers", "sessions"]) if (!enabled(id)) throw new PyValueError("plugin disabled: " + id);
      const size = entry.refs.reduce((n, r) => n + r.size, 0);
      if (request.total + size > MAX_SELECTION_BYTES || request.count + entry.refs.length > 32) throw new PyValueError("provider request media budget exceeded");
      if (!provider.capabilities.has("image")) throw new PyValueError("selected model does not declare image input support");
      request.account(entry.attachments); return entry.attachments;
    } };
    return { messages, media, release };
  } catch (error) { await release(); throw error; }
}
async function recoverMediaMessage(store: MediaArtifactStore, session: Session, message: Dict, refs: MediaRef[], owner: Owner): Promise<void> {
  try { if ((await Promise.all(refs.map((r) => store.describe(owner, r.id)))).every((r, i) => pyEquals(r, refs[i]))) return; } catch { /* Resume only from durable acceptance metadata. */ }
  const receipt = message._media_admission;
  if (!isDict(receipt) || !isDict(receipt.destination)) throw new PyValueError("media reference unavailable in this scope");
  const d = receipt.destination;
  const destination = new Owner(String(d.kind), String(d.key), String(d.root), d.session_id as string | null);
  if (destination.root !== owner.root || destination.sessionId !== owner.sessionId) throw new PyValueError("media recovery scope changed");
  if (!pyEquals(await store.finalizeAdmission(String(receipt.command_id), destination, owner), refs)) throw new PyValueError("media recovery references changed");
}
