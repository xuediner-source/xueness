/** Feature-owned HTTP operations. Host retains framing, authentication and CSRF. */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDict, pyInt, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { historyPage, isPyOSError, isPyValueError, pyExceptionName, realish, type Session, type SessionStore } from "@xueness/sessions";
import { eventsPage, journalPage, oneQuery, sseBody, StaleJournalCursor } from "./journal-http.ts";
import { importPortable, portablePayload } from "./portable.ts";
import { listArchived, listSummaries, pinSession, renameSession, validateTitle } from "./session-management.ts";
import { publicSessionPayload, type PublicSessionOptions } from "./public-session.ts";
import { createSessionLifecycleApi } from "./lifecycle-api.ts";
import type { LifecycleOptions } from "./lifecycle-types.ts";
import { createSessionCommandsApi } from "./command-http.ts";
import { MessageQueue } from "./queue.ts";
import { pendingSnapshot } from "./steering.ts";
import { reconcileInactive } from "./queue-http.ts";
import { createSessionManagementApi } from "./management-api.ts";
import { archiveStale, markViewed } from "./read-state.ts";
import { appendAcceptedTurn, createAcceptedSession } from "./create-session.ts";
import { PreparedRefusal, type PreparedInputOptions } from "./prepared-input.ts";
import { commandAdmission } from "./session-admission.ts";
import { SESSION_ROUTES, SESSION_COMMAND_ROUTES, SESSION_LIFECYCLE_ROUTES, SESSION_MANAGEMENT_ROUTES } from "./http-routes.ts";
import { createConversationApi } from "./conversation-api.ts";
import { createMessageActionsApi } from "./message-actions.ts";
import { AttachmentFiles } from "./attachment-fs.ts";
import { preserveMessageAttachments } from "./attachment-history.ts";
import { createForkApi } from "./forking.ts";
import { createSessionEventsApi } from "./event-api.ts";
import { createSessionLiveApi } from "./live-api.ts";
import { createConversationTransportApi } from "./conversation-transport.ts";
import { createSearchApi } from "./search.ts";
import { createSessionsIndexApi } from "./sessions-index.ts";
import { createSharingApi } from "./sharing.ts";
import { createQuestionApi } from "./question-api.ts";
export { SESSION_ROUTES, SESSION_COMMAND_ROUTES, SESSION_LIFECYCLE_ROUTES, SESSION_MANAGEMENT_ROUTES } from "./http-routes.ts";
type Dict = Record<string, unknown>;
export type SessionReply = [number, unknown, string?];
export interface SessionRequest { accept?: string; lastEventId?: string; signal?: AbortSignal; command?: { id: string; fingerprint: string }; }
export interface SessionsApiOptions {
  store: SessionStore;
  stateDir: string;
  webRuns: string;
  projectDir: string;
  enabled: (id: string) => boolean;
  allowedRoots?: () => readonly string[];
  defaultRoot?: () => string;
  running?: ReadonlySet<string>;
  /** Settings owner supplies stale-archive processing before a list. */
  beforeList?: () => void | Promise<void>;
  /** Cross-feature operations are supplied only after their owning migration is ready. */
  create?: (data: Dict, root: string, command?: { id: string; fingerprint: string }) => Promise<Session>;
  consumePrepared?: (token: string, root: string) => Promise<Dict>;
  expandCommands?: PreparedInputOptions["expandCommands"];
  preparedRemote?: (prepared: Dict) => unknown | Promise<unknown>;
  checkRemote?: (remote: Dict) => unknown;
  applyGoal?: (session: Session, text: string) => void | Promise<void>;
  rememberWorkspace?: (root: string) => void | Promise<void>;
  referenceStat?: (root: string, relative: string) => number | null;
  preserveAttachments?: (session: Session, index: number, text: string) => Promise<string>;
  indexTools?: () => readonly { owner: string; name: string }[];
  indexRemoteSummary?: (session: Session) => Dict | null | Promise<Dict | null>;
  projectSession?: (session: Session) => Promise<Dict> | Dict;
  publicOptions?: PublicSessionOptions;
  lifecycle?: LifecycleOptions;
  featureApis?: readonly { routes?: readonly string[]; owns(method: string, parts: readonly string[]): boolean; dispatch(method: string, parts: string[], query: Dict, data: unknown, request?: SessionRequest): Promise<SessionReply | null> }[];
}
const SID = /^[0-9a-f]{32}$/;
export function ownsSessionRoute(method: string, parts: readonly string[]): boolean {
  if (parts[0] !== "api" || parts[1] !== "sessions") return false;
  if (parts.length === 2 && ["GET", "POST"].includes(method)) return true;
  if (parts.length === 3 && (method === "GET" && parts[2] === "archived" || method === "POST" && parts[2] === "import" || method === "PATCH" && SID.test(parts[2]!))) return true;
  return parts.length === 4 && SID.test(parts[2]!) && (method === "GET" && ["journal", "events.v1", "history", "export"].includes(parts[3]!) || method === "POST" && parts[3] === "pin");
}
export function createSessionsApi(options: SessionsApiOptions) {
  const store = options.store;
  const attachments = new AttachmentFiles(options);
  const shared = { ...options, preserveAttachments: options.preserveAttachments ?? ((s: Session, index: number, text: string) => preserveMessageAttachments(attachments, s, index, text)), running: options.running ?? options.lifecycle?.running };
  const preparedOptions: PreparedInputOptions = { ...options,
    resolveSelection(selection) {
      if (!options.lifecycle) throw new PyValueError("provider selection is unavailable");
      return options.lifecycle.resolveProvider({ providerId: selection.provider_id, model: selection.model, reasoningEffort: selection.reasoning_effort }, "");
    } };
  const queue = new MessageQueue(store, { stateDir: options.stateDir, enabled: options.enabled });
  const queueSnapshot = async (sid: string) => { await reconcileInactive(shared, queue, sid); return queue.snapshot(sid); };
  const publicOptions = options.publicOptions ?? options.lifecycle;
  const liveOptions = options.lifecycle ? { ...options.lifecycle,
    appendUserTurn: options.lifecycle.appendUserTurn ?? ((s: Session, text: string, data: Dict, command?: { id: string; fingerprint: string }) => appendAcceptedTurn(preparedOptions, s, text, data, command)),
    queueSnapshot: options.lifecycle.queueSnapshot ?? queueSnapshot, guidanceSnapshot: options.lifecycle.guidanceSnapshot ?? ((s: Session) => pendingSnapshot(s, store, options.stateDir)) } : null;
  const lifecycle = liveOptions ? createSessionLifecycleApi(liveOptions) : null;
  const commands = createSessionCommandsApi({ ...shared, supportsCommand: commandAdmission(shared), activeContext: options.lifecycle?.activeContext, consumePrepared: options.consumePrepared, preparedRemote: options.preparedRemote, requestStop: lifecycle?.requestStop,
    async executeCommand(type, payload, sid, command) {
      let result: SessionReply | null = null;
      if (type === "stop" && lifecycle) result = await lifecycle.stop(sid, payload.expected_turn_id);
      else if (type === "run" && lifecycle) result = await lifecycle.run(sid, payload, command);
      else if (type === "send" && lifecycle) result = await lifecycle.send(sid, payload, false, command);
      else result = await api.dispatch(type === "edit_message" ? "PATCH" : "POST", type === "create_session" ? ["api", "sessions"] : ["api", "sessions", sid, type === "edit_message" ? "message-actions" : ["approve", "reject", "approval"].includes(type) ? "approvals" : type], {}, ["approve", "reject"].includes(type) ? { ...payload, decision: type } : payload, { command });
      if (!result) throw new Error("session command writer unavailable");
      return result;
    } });
  const project = options.projectSession ?? (publicOptions ? (s: Session) => publicSessionPayload(s, { ...publicOptions, queueSnapshot: publicOptions.queueSnapshot ?? queueSnapshot, guidanceSnapshot: publicOptions.guidanceSnapshot ?? ((s: Session) => pendingSnapshot(s, store, options.stateDir)) }) : null);
  const conversation = project ? createConversationApi(shared, project) : null;
  const live = project ? createSessionLiveApi(shared, project) : null;
  const transport = project ? createConversationTransportApi(shared, project) : null;
  const messageActions = createMessageActionsApi(shared, preparedOptions);
  const forks = createForkApi(shared);
  const events = createSessionEventsApi(shared);
  const runtimeEvents = createSessionRuntimeEventsApi(shared), rewinds = createRewindApi(shared);
  const search = createSearchApi(shared), index = createSessionsIndexApi(shared);
  const sharing = createSharingApi(shared);
  const questions = createQuestionApi(shared);
  const features = [runtimeEvents, rewinds, commands, messageActions, forks, events, search, index, sharing, questions, createSessionManagementApi(shared), ...(conversation ? [conversation] : []), ...(live ? [live] : []), ...(transport ? [transport] : []), ...(options.featureApis ?? []), ...(lifecycle ? [lifecycle] : [])];
  const allowedRoot = (value: string): string => {
    const target = realish(isAbsolute(value) ? value : join(options.webRuns, value));
    const roots = [options.webRuns, options.projectDir, ...(options.allowedRoots?.() ?? [])].map(realish);
    if (!roots.some((root) => { const rel = relative(root, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new PyValueError("workspace root not permitted");
    return target;
  };
  const load = async (sid: string): Promise<Session | SessionReply> => {
    try { return await store.load(sid); }
    catch (error) {
      if (pyExceptionName(error) === "TimeoutError") return [409, { error: "session is in use by another process" }];
      if (isPyOSError(error) || isPyValueError(error)) return [404, { error: "session not found" }];
      throw error;
    }
  };
  const api = {
    store, lifecycle, routes: [...runtimeEvents.routes, ...rewinds.routes, ...new Set([...SESSION_ROUTES, ...SESSION_MANAGEMENT_ROUTES, ...SESSION_COMMAND_ROUTES, ...messageActions.routes, ...forks.routes, ...events.routes, ...search.routes, ...index.routes, ...sharing.routes, ...questions.routes, ...(lifecycle ? SESSION_LIFECYCLE_ROUTES : []), ...(project ? ["GET /api/sessions/:id"] : []), ...conversation?.routes ?? [], ...live?.routes ?? [], ...transport?.routes ?? [], ...(options.featureApis ?? []).flatMap((api) => api.routes ?? [])])],
    owns: (method: string, parts: readonly string[]) => ownsSessionRoute(method, parts) || features.some((api) => api.owns(method, parts)) || !!project && method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "sessions" && SID.test(parts[2] ?? ""),
    async dispatch(method: string, parts: string[], query: Dict, data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (method === "POST" && parts[3] === "messages" && isDict(data)) {
        if (Object.hasOwn(data, "prepared_token") && !options.consumePrepared && !options.lifecycle?.appendUserTurn) return null;
        if (!Object.hasOwn(data, "prepared_token") && options.enabled("commands") && !options.expandCommands && typeof data.text === "string" && /^\/[A-Za-z0-9._:-]{1,64}(?:\s|$)/.test(data.text.trim())) return null;
      }
      for (const feature of features) { const result = await feature.dispatch(method, parts, query, data, request); if (result !== null) return result; }
      const detail = method === "GET" && parts.length === 3 && SID.test(parts[2] ?? "") && !!project;
      if (!ownsSessionRoute(method, parts) && !detail) return null;
      if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      // Another process (CLI, second host) may hold the lease; the detail is read from disk.
      if (method === "GET" && parts.length === 2) {
        try {
          if (options.beforeList) await options.beforeList();
          else { const general = options.lifecycle?.settings?.().general; if (isDict(general) && general.taskAutoArchiveEnabled === true && typeof general.taskAutoArchiveOlderThanDays === "number" && [3, 7, 14, 30].includes(general.taskAutoArchiveOlderThanDays)) await archiveStale(store, general.taskAutoArchiveOlderThanDays, shared); }
          return [200, { sessions: await listSummaries(store) }];
        }
        catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot list sessions" }]; throw e; }
      }
      if (method === "GET" && parts[2] === "archived") {
        try { return [200, { sessions: listArchived(store) }]; }
        catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot list archived sessions" }]; throw e; }
      }
      if (method === "POST" && parts[2] === "import") {
        if (!isDict(data) || Object.keys(data).sort().join(",") !== "portableSession,root") return [400, { error: "expected portableSession and root" }];
        try {
          if (typeof data.root !== "string" || pyLen(data.root) > 4096) throw new PyValueError("invalid import workspace");
          return [201, { session: await importPortable(store, data.portableSession, allowedRoot(data.root)) }];
        } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [400, { error: (e as Error).message }]; throw e; }
      }
      if (method === "POST" && parts.length === 2) {
        if (!isDict(data)) return [400, { error: "body must be a JSON object" }];
        const task = data.task ?? "";
        if (typeof task !== "string" || !pyStrip(task) || pyLen(task) > 5000) return [400, { error: "task must be 1..5000 characters" }];
        if (Object.hasOwn(data, "prepared_token") && typeof data.prepared_token !== "string") return [400, { error: "prepared input invalid or expired" }];
        if (Object.hasOwn(data, "prepared_token") && !options.consumePrepared && !options.create) return null;
        if (data.root !== undefined && data.root !== null && (typeof data.root !== "string" || !pyStrip(data.root))) return [400, { error: "root must be a path string" }];
        let root: string;
        try {
          const workspace = options.lifecycle?.settings?.().workspace;
          const savedDefault = options.enabled("settings") && isDict(workspace) && typeof workspace.defaultRoot === "string" ? workspace.defaultRoot : null;
          root = data.root == null ? options.defaultRoot?.() ?? (savedDefault && existsSync(savedDefault) ? allowedRoot(savedDefault) : realish(options.projectDir)) : allowedRoot(pyStrip(data.root as string));
        }
        catch { return [400, { error: "workspace root not permitted" }]; }
        try {
          let session: Session;
          if (options.create) session = await options.create(data, root, request.command);
          else session = await createAcceptedSession(preparedOptions, data, root, request.command);
          try { await options.rememberWorkspace?.(String(session.root)); } catch { /* Auxiliary preference writes never fail session acceptance. */ }
          return [200, { id: session.id, status: session.status, root: session.root }];
        } catch (e) { if (e instanceof PreparedRefusal) return [e.status, e.body]; if (isPyValueError(e)) return [400, { error: (e as Error).message }]; if (isPyOSError(e)) return [500, { error: "cannot create session" }]; throw e; }
      }
      const sid = parts[2]!;
      if (method === "GET" && parts[3] === "export") {
        try { return [200, { portableSession: await portablePayload(store, sid) }]; }
        catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: (e as Error).message }]; throw e; }
      }
      if (method === "GET" && parts[3] === "history") {
        try { return [200, await historyPage(store, sid, pyInt((oneQuery(query, "cursor") || "0") as string), pyInt((oneQuery(query, "limit") || "100") as string))]; }
        catch (e) { if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }]; return [409, { error: "session history unavailable; reload the conversation snapshot" }]; }
      }
      if (method === "PATCH" || method === "POST" && parts[3] === "pin") {
        const pin = method === "POST";
        if (!isDict(data) || !pin && Object.keys(data).join(",") !== "title") return [400, { error: pin ? "pinned must be a boolean" : "expected title only" }];
        let title = "";
        if (pin && typeof data.pinned !== "boolean") return [400, { error: "pinned must be a boolean" }];
        if (!pin) { try { title = validateTitle(data.title); } catch (e) { return [400, { error: (e as Error).message }]; } }
        if (options.running?.has(sid)) return [409, { error: "session run already in progress" }];
        try {
          const lease = await store.lease(sid);
          try { const s = pin ? await pinSession(store, sid, data.pinned as boolean) : await renameSession(store, sid, title); return [200, pin ? { ok: true, pinned: s.pinned } : { id: sid, title: s.title || s.task }]; }
          finally { await lease.release(); }
        } catch (e) {
          const name = pyExceptionName(e);
          if (name === "FileNotFoundError") return [404, { error: "session not found" }];
          if (name === "BlockingIOError") return [409, { error: "session is in use by another process" }];
          if (pin && isPyValueError(e)) return [400, { error: (e as Error).message }];
          if (isPyOSError(e) || isPyValueError(e)) return [500, { error: pin ? "cannot pin session" : "cannot rename session" }];
          throw e;
        }
      }
      if (detail) { try { await markViewed(store, sid); } catch (e) { if (!isPyOSError(e) && !isPyValueError(e)) throw e; } }
      const session = await load(sid); if (Array.isArray(session)) return session;
      if (detail) return [200, await project!(session)];
      if (parts[3] === "events.v1") {
        const result = eventsPage(session, query);
        return result[0] === 200 && request.accept?.includes("text/event-stream") && isDict(result[1]) ? [200, Buffer.from(sseBody(result[1].events as Parameters<typeof sseBody>[0])), "text/event-stream"] : result;
      }
      try { return [200, journalPage(session, query)]; }
      catch (e) { if (e instanceof StaleJournalCursor) return [409, { error: e.message }]; if (isPyValueError(e)) return [400, { error: (e as Error).message }]; throw e; }
    },
  };
  return api;
}
import { createSessionRuntimeEventsApi } from './runtime-event-api.ts';
import { createRewindApi } from './rewind-api.ts';
