/** Finite event resume pages bind each continuation to an immutable prefix. */
import { deriveEvents, isDict, pyJsonDumps, pyStr, pyStrip, PyValueError } from "@xueness/contracts";
import { eventDigest, prefixHash, updateEventDigest } from "./legacy-events.ts";
import { projectSessionMessages } from "./journal-http.ts";
type Row = Record<string, any>;
export interface ResumeBase { seq: number; epoch: string; }
export class ResumeError extends PyValueError { override name = "ResumeError"; readonly status: number; readonly body: Row; constructor(message: string, snapshot?: Row) { super(message); this.status = snapshot ? 409 : 400; this.body = { error: message, errorCode: snapshot ? "sessions.event_resume.resync_required" : "xueness.error.invalid_argument", ...(snapshot ? { resync: true, ...snapshot } : {}) }; } }
function firsts(query: Row, key: string): string[] { return Object.hasOwn(query, key) ? (Array.isArray(query[key]) ? query[key] : [query[key]]).map(pyStr).filter(Boolean) : []; }
function one(query: Row, key: string): string | null { const values = firsts(query, key); if (values.some((v) => v !== values[0])) throw new ResumeError("conflicting " + key + " values"); return values[0] ?? null; }
function parts(seq: string, epoch: string): ResumeBase {
  if (!/^[0-9]+$/.test(seq)) throw new ResumeError("invalid seq"); if (!/^[0-9a-f]{64}$/.test(epoch)) throw new ResumeError("invalid logEpoch");
  if (seq.length > 4300 || BigInt(seq) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ResumeError("seq too large"); return { seq: Number(seq), epoch };
}
export function requestedResumeBase(query: Row, lastId = ""): ResumeBase | null {
  const epochs = [...firsts(query, "log_epoch"), ...firsts(query, "logEpoch")], seqs = firsts(query, "seq"), header = pyStrip(lastId);
  if (!epochs.length && !seqs.length && !header) return null;
  if (!!epochs.length !== !!seqs.length) throw new ResumeError("logEpoch and seq are required together");
  if (epochs.some((v) => v !== epochs[0])) throw new ResumeError("conflicting logEpoch values"); if (seqs.some((v) => v !== seqs[0])) throw new ResumeError("conflicting seq values");
  const queryBase = epochs.length ? parts(seqs[0]!, epochs[0]!) : null; let headerBase: ResumeBase | null = null;
  if (header) { const match = /^([0-9]+)\.([0-9a-f]{64})$/.exec(header); if (!match) throw new ResumeError("invalid Last-Event-ID"); headerBase = parts(match[1]!, match[2]!); }
  if (queryBase && headerBase && (queryBase.epoch !== headerBase.epoch || queryBase.seq !== headerBase.seq)) throw new ResumeError("conflicting resume base"); return queryBase ?? headerBase;
}
export function requestedResumeProfile(query: Row): string { const value = one(query, "profile") ?? "replayable"; if (!["replayable", "continuous"].includes(value)) throw new ResumeError("invalid profile"); return value; }
export function requestedResumeLimit(query: Row, snapshot: boolean): number {
  const text = one(query, "limit"); if (text === null) return snapshot ? 60 : 200; if (!/^[0-9]+$/.test(text)) throw new ResumeError("invalid limit"); if (text.length > 4300) throw new ResumeError("invalid limit"); return Math.max(1, Number(BigInt(text) > 500n ? 500n : BigInt(text)));
}
export function resumePage(s: Row, base: ResumeBase | null, limit: number, profile: string): Row {
  if (!["replayable", "continuous"].includes(profile)) throw new ResumeError("invalid profile"); if (!Number.isInteger(limit) || limit < 1) throw new ResumeError("invalid limit"); limit = Math.min(limit, 500);
  const projected = projectSessionMessages(s), events = deriveEvents(projected), head = events.length;
  const envelope = (window: Row[], next: number, from: number, mode: string, more: boolean, gap: boolean): Row => ({ schema: "xueness.events.resume.v1", sessionId: pyStr(s.id ?? ""), resumeMode: mode, deliveryProfile: profile, logEpoch: prefixHash(s, events, next, "events-resume-v1"), originEpoch: prefixHash(s, events, 0, "events-resume-v1"), seq: next, nextCursor: next, head, fromSeq: from, hasMore: more, gapBefore: gap, status: s.status ?? null, steps: s.steps ?? 0, mode: s.mode || "", events: window.filter((e) => profile !== "replayable" || e.type !== "session.status") });
  const snapshot = (): Row => { const window = events.slice(-limit), from = window.length ? window[0]!.seq - 1 : 0; return envelope(window, head, from, "snapshot", false, from > 0); };
  if (!base) return snapshot();
  if (base.seq > head) throw new ResumeError("seq ahead of session head", snapshot());
  if (base.epoch !== prefixHash(s, events, base.seq, "events-resume-v1")) throw new ResumeError("logEpoch does not match the event prefix", snapshot());
  const remaining = events.filter((e) => e.seq > base.seq), window = remaining.slice(0, limit), next = window.at(-1)?.seq ?? base.seq;
  return envelope(window, next, base.seq, "resume", remaining.length > window.length, false);
}
export function resumeSse(s: Row, envelope: Row): Buffer {
  const wanted = new Set((envelope.events as Row[]).filter((e) => Object.hasOwn(e, "seq")).map((e) => e.seq)), chunks: string[] = [], hash = eventDigest(s, "events-resume-v1"), max = Math.max(0, ...wanted);
  for (const e of deriveEvents(projectSessionMessages(s))) { if (e.seq > max) break; if (e.seq > 1) updateEventDigest(hash, e); if (wanted.has(e.seq)) chunks.push(`id: ${e.seq}.${hash.copy().digest("hex")}`, `event: ${e.type ?? "message"}`, "data: " + pyJsonDumps(e), ""); }
  const meta = Object.fromEntries(["schema", "sessionId", "resumeMode", "deliveryProfile", "logEpoch", "originEpoch", "seq", "nextCursor", "head", "fromSeq", "hasMore", "gapBefore", "status", "steps", "mode"].map((key) => [key, envelope[key]]));
  chunks.push(`id: ${envelope.nextCursor}.${envelope.logEpoch}`, "event: resume.cursor", "data: " + pyJsonDumps(meta), ""); return Buffer.from(chunks.join("\n") + "\n");
}
