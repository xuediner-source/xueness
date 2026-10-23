/** One-shot trusted composer handoff and durable media acceptance. */
import { createHash } from "node:crypto";
import { isDict, pyEquals, pyLen, pySlice, PyValueError, uuid4Hex } from "@xueness/contracts";
import { realish, type Session, type SessionStore } from "@xueness/sessions";
import { dirname, basename } from "node:path";
import { MediaArtifactStore } from "./media-store.ts";
import { Owner } from "./media-owner.ts";
import { mediaRefs, ownerRow, rowOwner } from "./queue-media.ts";
import { requestedSelection, selectionRecord } from "./run-validation.ts";
type Row = Record<string, any>;
export interface PreparedInputOptions {
  store: SessionStore;
  stateDir: string;
  webRuns: string;
  enabled(id: string): boolean;
  consumePrepared?: (token: string, root: string) => Promise<Row>;
  preparedRemote?: (prepared: Row) => unknown | Promise<unknown>;
  /** `_remote_connection` for the saved session target (`_bind_remote_session`). */
  checkRemote?: (remote: Row) => unknown;
  applyGoal?: (session: Session, text: string) => void | Promise<void>;
  resolveSelection?: (selection: Row) => unknown;
  expandCommands?: (text: string, root: string) => Promise<{ text: string; invocation: Row | null }>;
}
export async function expandedTurn(o: PreparedInputOptions, text: string, root: string): Promise<{ text: string; invocation: Row | null }> {
  if (!o.enabled("commands") || !/^\/[A-Za-z0-9._:-]{1,64}(?:\s|$)/.test(text.trim())) return { text: text.trim(), invocation: null };
  if (!o.expandCommands) throw new PyValueError("command expansion unavailable");
  const result = await o.expandCommands(text, root);
  if (typeof result.text !== "string" || pyLen(result.text) > 8000 || !(result.invocation === null || isDict(result.invocation) && typeof result.invocation.command === "string" && typeof result.invocation.args === "string")) throw new PyValueError("command expansion unavailable");
  return result;
}
export class PreparedRefusal extends PyValueError {
  override name = "GoalRefusal";
  readonly status: number;
  readonly body: Row;
  constructor(message: string, status: number, plugin?: string) { super(message); this.status = status; this.body = { error: message, ...(plugin ? { plugin } : {}) }; }
}
export function bindPreparedSelection(selection: Row, prepared: Row): Row {
  const cached = prepared.metadata?.modelSelection;
  if (!isDict(cached) || typeof cached.provider_id !== "string" || typeof cached.model !== "string") throw new PyValueError("prepared model selection is invalid");
  const bound: Row = {};
  for (const field of ["provider_id", "model", "reasoning_effort"]) {
    const value = cached[field] ?? null;
    if (Object.hasOwn(selection, field) && !pyEquals(selection[field], value)) throw new PyValueError("prepared model selection changed; prepare the input again");
    bound[field] = value;
  }
  return bound;
}
export async function consumeInput(o: PreparedInputOptions, token: unknown, root: string): Promise<Row> {
  if (!o.enabled("sessions") || typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token) || !o.consumePrepared) throw new PyValueError("prepared input invalid or expired");
  const p = await o.consumePrepared(token, root);
  if (!isDict(p) || typeof p.text !== "string" || !isDict(p.metadata) || typeof p.goal !== "boolean") throw new PyValueError("prepared input invalid or expired");
  return p;
}
export async function trustedRemote(o: PreparedInputOptions, prepared: Row): Promise<unknown> {
  const remote = prepared.metadata?.remote;
  if (remote == null) return null;
  if (!isDict(remote) || Object.keys(remote).sort().join(",") !== "digest,id" || typeof remote.id !== "string" || typeof remote.digest !== "string" || remote.digest.length !== 64) throw new PyValueError("prepared remote selection is invalid");
  if (!o.enabled("remote") || !o.preparedRemote) throw new PyValueError("remote plugin disabled or unavailable");
  return o.preparedRemote(prepared);
}
export async function applySubmittedGoal(o: PreparedInputOptions, session: Session, prepared: Row | null, text: string): Promise<void> {
  if (prepared?.goal !== true) return;
  if (!o.enabled("planning") || !o.applyGoal) throw new PreparedRefusal("plugin disabled or dependency unavailable: planning", 403, "planning");
  try { await o.applyGoal(session, text); }
  catch (e) { if (e instanceof Error && "status" in e && Number.isInteger(e.status)) throw new PreparedRefusal(e.message, Number(e.status)); throw e; }
}
export function bindMediaMessage(session: Session, prepared: Row): Owner {
  const message = (session.messages as Row[]).findLast((m) => m.role === "user");
  if (!message) throw new PyValueError("prepared message is missing");
  message._message_id ??= uuid4Hex();
  if (mediaRefs(prepared).length) { message._media_refs = mediaRefs(prepared); if (prepared.media_admission) message._media_admission = prepared.media_admission; }
  return new Owner("message", message._message_id, String(session.root), String(session.id));
}
export function safeInputContext(session: Session, prepared: Row): void {
  bindMediaMessage(session, prepared);
  const metadata = prepared.metadata, safe: Row = {};
  for (const name of ["files", "attachments", "sessions", "skills", "plugins"]) if (Array.isArray(metadata[name])) safe[name] = metadata[name].filter(isDict).slice(0, 100).map((item: Row) => Object.fromEntries(Object.entries(item).filter(([key]) => ["id", "label", "path", "bytes", "size", "sha256", "mimeType"].includes(key))));
  if (isDict(metadata.modelSelection)) safe.modelSelection = Object.fromEntries(Object.entries(metadata.modelSelection).filter(([key, value]) => ["provider_id", "model", "protocol", "capabilities", "reasoning_effort"].includes(key) && (typeof value === "string" || value === null || Array.isArray(value))));
  if (isDict(metadata.remote) && typeof metadata.remote.id === "string" && typeof metadata.remote.digest === "string") safe.remote = { id: metadata.remote.id, digest: metadata.remote.digest };
  const message = (session.messages as Row[]).findLast((m) => m.role === "user");
  const record: Row = { user_turn: (session.messages as Row[]).filter((m) => m.role === "user").length, metadata: safe };
  if (message && typeof message.content === "string") { record.content_sha256 = createHash("sha256").update(message.content).digest("hex"); if (typeof message._message_id === "string") record.message_id = message._message_id; }
  if (typeof prepared.goal === "string" && prepared.goal.trim()) record.goal = pySlice(prepared.goal, 5000);
  ((session.input_context ??= []) as Row[]).push(record);
  const files = safe.files ?? safe.attachments ?? [];
  if (files.length) ((session.input_attachments ??= []) as Row[]).push({ user_turn: record.user_turn, files });
}
export function recordPreparedCommands(session: Session, prepared: Row): void {
  const values = prepared.metadata?.commandInvocations;
  if (!Array.isArray(values)) return;
  const log = (session.command_invocations ??= []) as Row[];
  for (const v of values) if (isDict(v) && typeof v.command === "string" && pyLen(v.command) <= 64 && typeof v.args === "string" && pyLen(v.args) <= 5000) log.push({ command: v.command, args: v.args });
  session.command_invocations = log.slice(-50);
}
export async function reservePreparedMedia(o: PreparedInputOptions, prepared: Row | null, destination: Owner, command?: { id: string; fingerprint: string }): Promise<void> {
  if (!mediaRefs(prepared).length) return;
  if (!prepared || !command) throw new PyValueError("prepared media requires a stable command envelope");
  if (!o.enabled("sessions")) throw new PyValueError("plugin disabled or dependency unavailable: sessions");
  const sources: [Owner, string[]][] = (prepared.media_sources ?? []).map((r: Row) => [rowOwner(r.owner), r.ids]);
  const webRuns = realish(o.webRuns);
  const sameRoot = (root: string): boolean => root === destination.root || root === webRuns && dirname(destination.root) === webRuns && /^[0-9a-f]{32}$/.test(basename(destination.root));
  if (sources.some(([owner]) => owner.sessionId !== null && owner.sessionId !== destination.sessionId || !sameRoot(owner.root))) throw new PyValueError("prepared media source scope changed");
  if (!pyEquals(sources.flatMap(([, ids]) => ids), mediaRefs(prepared).map((r) => r.id))) throw new PyValueError("prepared media source binding unavailable");
  await new MediaArtifactStore(o.stateDir).reserveAdmission(command.id, destination, sources, command.fingerprint);
  prepared.media_admission = { command_id: command.id, destination: ownerRow(destination) };
}
export async function finalizePreparedMedia(o: PreparedInputOptions, prepared: Row | null, destination: Owner, target: Owner): Promise<void> {
  if (!prepared || !mediaRefs(prepared).length) return;
  const receipt = prepared.media_admission;
  if (!receipt || rowOwner(receipt.destination).token() !== destination.token()) throw new PyValueError("prepared media destination changed");
  const media = new MediaArtifactStore(o.stateDir);
  try { if ((await Promise.all(mediaRefs(prepared).map((r) => media.describe(target, r.id)))).every((r, i) => pyEquals(r, mediaRefs(prepared)[i]))) return; } catch (e) { if (!(e instanceof PyValueError)) throw e; }
  try { await media.finalizeAdmission(receipt.command_id, destination, target); } catch (e) { throw new Error("media acceptance finalization requires recovery", { cause: e }); }
}
