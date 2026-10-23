import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyEquals, pyStrip, PyValueError, uuid4Hex } from "@xueness/contracts";
import { realish, type Session } from "@xueness/sessions";
import { appendUserTurn } from "@xueness/agent";
import { Owner } from "./media-owner.ts";
import { mediaRefs } from "./queue-media.ts";
import { requestedSelection, selectionRecord } from "./run-validation.ts";
import { applySubmittedGoal, bindMediaMessage, bindPreparedSelection, consumeInput, expandedTurn, finalizePreparedMedia, recordPreparedCommands, reservePreparedMedia, safeInputContext, trustedRemote, type PreparedInputOptions } from "./prepared-input.ts";
import { MediaArtifactStore } from "./media-store.ts";
type Row = Record<string, any>;
export async function createAcceptedSession(o: PreparedInputOptions, data: Row, initialRoot: string, command?: { id: string; fingerprint: string }): Promise<Session> {
  let selection = requestedSelection(data), root = initialRoot, prepared: Row | null = null, remote: unknown = null;
  if (Object.hasOwn(data, "prepared_token")) {
    try { prepared = await consumeInput(o, data.prepared_token, root); }
    catch (e) {
      if (data.root == null && root !== realish(o.webRuns)) { root = realish(o.webRuns); prepared = await consumeInput(o, data.prepared_token, root); }
      else throw e;
    }
    selection = bindPreparedSelection(selection, prepared); remote = await trustedRemote(o, prepared);
  }
  if (Object.keys(selection).length) { o.resolveSelection?.(selection); selection = selectionRecord(selection); }
  await applySubmittedGoal(o, {}, prepared, pyStrip(data.task));
  const sid = mediaRefs(prepared).length ? uuid4Hex() : null;
  const isolated = data.root == null && root === realish(o.webRuns);
  const destination = sid ? new Owner("message", sid, isolated ? join(root, sid) : root, sid) : null;
  if (destination) await reservePreparedMedia(o, prepared, destination, command);
  mkdirSync(root, { recursive: true });
  const session = await o.store.new(pyStrip(data.task), root, sid ? { sessionId: sid } : {});
  if (isolated) { root = join(root, String(session.id)); mkdirSync(root, { recursive: true }); session.root = root; await o.store.save(session); }
  if (Object.keys(selection).length) session.model_selection = selection;
  if (prepared) {
    (session.messages as Row[])[1]!.content = prepared.text;
    if (remote !== null) session.remote_connection = remote;
    safeInputContext(session, prepared); recordPreparedCommands(session, prepared);
    await applySubmittedGoal(o, session, prepared, pyStrip(data.task));
  }
  await o.store.save(session);
  if (destination) await finalizePreparedMedia(o, prepared, destination, bindMediaMessage(session, prepared!));
  return session;
}
/** Caller holds the session run lease; accepted media pins precede publication. */
export async function appendAcceptedTurn(o: PreparedInputOptions, session: Session, text: string, data: Row, command?: { id: string; fingerprint: string }): Promise<Session> {
  if (!Object.hasOwn(data, "prepared_token")) {
    const expanded = await expandedTurn(o, text, String(session.root));
    await appendUserTurn(session, o.store, text, { persist: false });
    (session.messages as Row[]).at(-1)!.content = expanded.text;
    if (expanded.invocation) recordPreparedCommands(session, { metadata: { commandInvocations: [expanded.invocation] } });
    await o.store.save(session); return session;
  }
  const prepared = await consumeInput(o, data.prepared_token, realish(String(session.root)));
  const selection = bindPreparedSelection(requestedSelection(data), prepared);
  if (Object.keys(selection).length) { o.resolveSelection?.(selection); session.model_selection = selectionRecord(selection); }
  const remote = await trustedRemote(o, prepared);
  const current = session.remote_connection;
  if (current != null) {
    if (!isDict(current) || typeof current.id !== "string" || typeof current.digest !== "string") throw new PyValueError("saved remote session selection is invalid; start a new session");
    if (!o.checkRemote) throw new PyValueError("remote plugin disabled or unavailable");
    await o.checkRemote(current);
    if (!pyEquals(remote, current)) throw new PyValueError("remote session selection changed; prepare the next turn for the same connection");
  } else if (remote !== null) session.remote_connection = remote;
  await appendUserTurn(session, o.store, text, { persist: false });
  (session.messages as Row[]).at(-1)!.content = prepared.text;
  safeInputContext(session, prepared);
  const target = bindMediaMessage(session, prepared);
  await reservePreparedMedia(o, prepared, target, command);
  bindMediaMessage(session, prepared);
  recordPreparedCommands(session, prepared);
  await applySubmittedGoal(o, session, prepared, text);
  await o.store.save(session);
  await finalizePreparedMedia(o, prepared, target, target);
  return session;
}
/** QueueRun calls this under its existing runner lease after media finalization. */
export async function appendAcceptedQueuedTurn(o: PreparedInputOptions, session: Session, item: Row): Promise<void> {
  const p = item.prepared;
  const expanded = p ? null : await expandedTurn(o, item.text, String(session.root));
  await appendUserTurn(session, o.store, item.text, { queueMessageId: item.id, persist: false });
  const message = (session.messages as Row[]).at(-1)!;
  message.content = p ? p.text : expanded!.text;
  if (p) {
    safeInputContext(session, p);
    const target = bindMediaMessage(session, p);
    if (mediaRefs(p).length) await new MediaArtifactStore(o.stateDir).adopt(new Owner("queue", item.id, String(session.root), String(session.id)), target, mediaRefs(p).map((r) => r.id));
    recordPreparedCommands(session, p); await applySubmittedGoal(o, session, p, item.text);
  } else if (expanded?.invocation) recordPreparedCommands(session, { metadata: { commandInvocations: [expanded.invocation] } });
  await o.store.save(session);
}
