/** Closed-prefix forks copy transcript and media authority, never live execution state. */
import { existsSync, statSync } from "node:fs";
import { isDict, isPyIntValue, pyDeepCopy, pyEncodeUtf8, pyEquals, pyJsonDumps, pyStrip, pySubstring, pyTruthy, uuid4Hex } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, realish, SYSTEM_PROMPT, type Session } from "@xueness/sessions";
import type { SessionsApiOptions, SessionReply } from "./http-api.ts";
import { canonicalForkMessage, ForkError, forkTruncation, MAX_PREFIX_BYTES, readForkSnapshot, validForkText, type Row } from "./fork-common.ts";
import { forkBoundaries } from "./fork-boundaries.ts";
import { applyCanonicalIntent, LineageSidecar, validateHistoryCommandId } from "./lineage.ts";
import { validateTitle } from "./session-management.ts";
import { pendingDenials } from "./public-session.ts";
import { messageOwner, messageRefs } from "./media-history.ts";
import { MediaArtifactStore } from "./media-store.ts";
import { validateWorkspace } from "./queue-http.ts";
export { applyConversationRewind } from "./rewind.ts";
export { sessionsStableBoundariesExtension } from "./stable-boundaries.ts";

function modelConfig(source: Row): Row {
  const out: Row = {}, selection = source.model_selection;
  if (selection != null) {
    if (!isDict(selection) || Object.keys(selection).some((k) => !["provider_id", "model", "reasoning_effort"].includes(k)) || Object.values(selection).some((v) => v !== null && !validForkText(v, 256))) throw new ForkError("session model selection is invalid");
    out.model_selection = { ...selection };
  }
  if (source.runtime_profile != null) { if (!["standard", "lightweight"].includes(source.runtime_profile)) throw new ForkError("session runtime profile is invalid"); out.runtime_profile = source.runtime_profile; }
  return out;
}
export async function makeFork(options: SessionsApiOptions, source: Row, revision: string, boundary: Row, title?: string, checkpoint?: Row): Promise<Row> {
  const copied: Row[] = [], mediaPairs: [Row, Row][] = [], referenced = new Set<string>(), toolIds = new Set<string>(), callIds = new Map<string, string>(), turns = new Map<string, string>();
  let turn = 0;
  for (const raw of source.messages.slice(0, boundary.endIndex + 1)) {
    const clean = canonicalForkMessage(raw); if (clean.role === "system") continue;
    const sourceTurn = typeof clean._turn_id === "string" ? clean._turn_id : null;
    const localInput = clean.role === "user" && !["guide", "background_notice", "summary"].includes(String(clean._input_kind));
    if (localInput) { turn += 1; if (sourceTurn) turns.set(sourceTurn, `turn-${turn}`); }
    else if (sourceTurn && !turns.has(sourceTurn)) turns.set(sourceTurn, `turn-${Math.max(1, turn)}`);
    clean._turn_id = sourceTurn ? turns.get(sourceTurn) ?? `turn-${Math.max(1, turn)}` : `turn-${Math.max(1, turn)}`;
    clean._message_id = uuid4Hex();
    for (const call of clean.tool_calls ?? []) { const old = call.id, mapped = uuid4Hex(); callIds.set(old, mapped); call.id = mapped; referenced.add(old); }
    if (clean.role === "tool") { const old = clean.tool_call_id; const mapped = callIds.get(old); if (!mapped) throw new ForkError("selected boundary has an unpaired tool result"); clean.tool_call_id = mapped; toolIds.add(old); }
    copied.push(clean); if (messageRefs(clean).length) mediaPairs.push([raw, clean]);
  }
  const selectedResults: Row = Object.create(null);
  for (const oldId of toolIds) { if (!isDict(source.results?.[oldId])) throw new ForkError("selected boundary has an unpaired tool result"); selectedResults[callIds.get(oldId)!] = pyDeepCopy(source.results[oldId]); }
  if (referenced.size !== toolIds.size || [...referenced].some((id) => !toolIds.has(id))) throw new ForkError("selected boundary contains a partial tool call");
  const system = { role: "system", content: SYSTEM_PROMPT, _message_id: uuid4Hex(), _turn_id: "turn-1" }; const messages = [system, ...copied];
  if (pyEncodeUtf8(pyJsonDumps(messages, { ensureAscii: false, separators: [",", ":"] })).length > MAX_PREFIX_BYTES) throw new ForkError("selected transcript exceeds fork size limit", 413);
  if (pendingDenials({ messages, results: selectedResults }).length) throw new ForkError("selected boundary contains pending approvals");
  const [truncated, reason] = forkTruncation(source, source.messages), cleanTitle = validateTitle(title === undefined ? pySubstring("Fork: " + pyStrip(source.title || source.task), 0, 120) : title);
  const id = uuid4Hex(), parent: Row = { sourceId: source.id, sourceRevision: revision, turn: boundary.turn, endIndex: boundary.endIndex, historyTruncated: truncated, truncationReason: reason };
  if (checkpoint) { parent.checkpointId = checkpoint.checkpointId; parent.checkpointTurn = checkpoint.turn; }
  const child: Session = { id, task: source.task, title: cleanTitle, root: realish(source.root), status: "pending", messages, results: selectedResults, compactions: [], archived_messages: [], steps: 0, completion: null, todos: [], pending_question: null, fork_parent: parent, ...modelConfig(source) };
  const marker = copied.findLast((m) => ["user", "assistant"].includes(m.role)); if (typeof marker?._message_id === "string") child.fork_marker_message_id = marker._message_id;
  let media: MediaArtifactStore | undefined;
  for (const [raw, m] of mediaPairs) {
    const refs = messageRefs(m); if (!refs.length) continue;
    media ??= new MediaArtifactStore(options.stateDir); const old = messageOwner(source, raw), target = messageOwner(child, m);
    for (const ref of refs) if (!pyEquals(await media.describe(old, ref.id), ref)) throw new ForkError("saved media metadata changed");
    await media.adopt(old, target, refs.map((ref) => ref.id));
  }
  await options.store.save(child);
  const remap = Object.fromEntries([...callIds].slice(0, 64));
  const mediaRefCount = mediaPairs.reduce((count, [, clean]) => count + messageRefs(clean).length, 0);
  const context = { messages: messages.length, toolCalls: referenced.size, toolResults: toolIds.size, mediaRefsAdopted: mediaRefCount, toolCallRemap: remap };
  return { session: { id, status: "pending", root: child.root, title: cleanTitle }, sourceId: source.id, boundary: { turn: boundary.turn, preview: boundary.preview }, historyTruncated: truncated, truncationReason: reason, forkParent: { ...parent }, context };
}
export const FORK_ROUTES = ["GET /api/sessions/:id/fork-boundaries", "POST /api/sessions/:id/fork", "POST /api/sessions/:id/fork-from-checkpoint", "GET /api/sessions/:id/lineage"];
export function createForkApi(options: SessionsApiOptions) {
  const owns = (method: string, p: readonly string[]) => p[0] === "api" && p[1] === "sessions" && p.length === 4 && (method === "GET" && ["fork-boundaries", "lineage"].includes(p[3]!) || method === "POST" && ["fork", "fork-from-checkpoint"].includes(p[3]!));
  return { routes: FORK_ROUTES, owns,
    async dispatch(method: string, p: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!owns(method, p)) return null;
      if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      const sid = p[2]!; if (!/^[0-9a-f]{32}$/.test(sid)) return [404, { error: "session not found" }];
      const checkpoint = p[3] === "fork-from-checkpoint", allowed = checkpoint ? ["checkpoint", "latest", "turn", "title", "commandId"] : ["boundary", "revision", "title", "commandId"];
      if (method === "POST" && (!isDict(data) || Object.keys(data).some((k) => !allowed.includes(k)) || !checkpoint && !["boundary", "revision"].every((k) => Object.hasOwn(data, k)) || isDict(data) && Object.hasOwn(data, "title") && typeof data.title !== "string")) return [400, { error: checkpoint ? "expected checkpoint or latest, and optional title" : "expected boundary, revision, and optional title" }];
      const body = isDict(data) ? data : {};
      try {
        if (method === "GET" && p[3] === "lineage") {
          try { await options.store.load(sid); } catch { return [404, { error: "session not found" }]; }
          return [200, { id: sid, lineage: [...new LineageSidecar(options.store.directory).readRecord(sid).lineage].reverse() }];
        }
        if (method === "POST") {
          if (body.title !== undefined) { try { validateTitle(body.title); } catch (e) { throw new ForkError((e as Error).message); } }
          if (!checkpoint && (typeof body.revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.revision))) throw new ForkError("invalid session revision");
          if (!checkpoint && !validForkText(body.boundary, 80)) throw new ForkError("invalid fork boundary token");
          if (checkpoint) { if (body.checkpoint != null && pyTruthy(body.latest)) throw new ForkError("choose either a checkpoint id or --latest, not both"); if (body.checkpoint != null && !validForkText(body.checkpoint, 32)) throw new ForkError("invalid checkpoint id"); if (body.turn != null && (!isPyIntValue(body.turn) || Number(body.turn) < 1)) throw new ForkError("turn must be a positive integer"); }
          if (body.commandId !== undefined) { try { validateHistoryCommandId(body.commandId); } catch { throw new ForkError("commandId must be c_<epoch-ms>_<uuid>"); } }
        }
        if (options.running?.has(sid)) throw new ForkError("session run already in progress", 409);
        const execute = async (): Promise<{ status: number; result: Row }> => {
          const lease = await options.store.lease(sid);
          try {
            if (options.running?.has(sid)) throw new ForkError("session run already in progress", 409);
            const [source, revision] = readForkSnapshot(options.store, sid); if (pyTruthy(source.streaming)) throw new ForkError("session has an active or interrupted stream", 409);
            if (!checkpoint) { try { await validateWorkspace(options, source); } catch { throw new ForkError("session workspace is no longer permitted", 403); } }
            if (!existsSync(source.root) || !statSync(source.root).isDirectory()) throw new ForkError("session workspace is unavailable", 409);
            if (method === "POST" && !checkpoint && revision !== body.revision) throw new ForkError("session changed; refresh fork boundaries", 409);
            const index = forkBoundaries(source, revision); if (method === "GET") return { status: 200, result: index };
            let boundary: Row | undefined, linked: Row | undefined;
            if (checkpoint) {
              const records = Array.isArray(source.turn_checkpoints) ? source.turn_checkpoints.filter((r: unknown) => isDict(r) && pyTruthy(r.checkpointId)) : [];
              let chosen: Row | undefined;
              if (body.turn != null) { chosen = records.find((r: Row) => pyEquals(r.turn, body.turn)); if (!chosen) throw new ForkError("requested turn has no workspace checkpoint", 409); }
              else { if (!records.length) throw new ForkError("该会话没有可用的轮次检查点", 409); chosen = pyTruthy(body.latest) || body.checkpoint == null ? records.at(-1) : records.find((r: Row) => r.checkpointId === body.checkpoint); if (!chosen) throw new ForkError("未知的轮次检查点", 404); }
              if (typeof chosen.checkpointId !== "string" || !/^[0-9a-f]{32}$/.test(chosen.checkpointId)) throw new ForkError("checkpoint record is invalid", 409);
              if (!isPyIntValue(chosen.turn) || Number(chosen.turn) < 2) throw new ForkError("that checkpoint has no earlier turn to fork from", 409);
              boundary = index.boundaries.find((r: Row) => r.turn === Number(chosen.turn) - 1); if (!boundary) throw new ForkError("the turn before that checkpoint is not a safe closed boundary", 409);
              linked = { checkpointId: chosen.checkpointId, turn: chosen.turn };
            } else { boundary = index.boundaries.find((r: Row) => r.token === body.boundary); if (!boundary) throw new ForkError("fork boundary is no longer safe or was not offered", 409); }
            const result = await makeFork(options, source, revision, boundary!, body.title as string | undefined, linked); if (linked) result.checkpoint = linked; return { status: 201, result };
          } catch (e) { if (e instanceof ForkError) return { status: e.status, result: { error: e.message } }; throw e; }
          finally { await lease.release(); }
        };
        if (method === "GET") { const done = await execute(); return [done.status, done.result]; }
        const { commandId, ...payload } = body;
        if (typeof commandId !== "string") { const done = await execute(); return [done.status, done.result]; }
        const outcome = await applyCanonicalIntent(new LineageSidecar(options.store.directory), sid, { commandId, intent: "fork", payload }, execute,
          (result) => ({ parentRevision: result.forkParent?.sourceRevision, childSessionId: result.session?.id, boundaryTurn: result.boundary?.turn, checkpointId: result.forkParent?.checkpointId, context: result.context }));
        return outcome.reply;
      } catch (e) {
        if (e instanceof ForkError) return [e.status, { error: e.message }];
        if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }];
        if (isPyOSError(e) || isPyValueError(e)) return [500, { error: method === "GET" ? "cannot read fork boundaries" : checkpoint ? "cannot fork session from checkpoint" : "cannot fork session" }];
        throw e;
      }
    } };
}
