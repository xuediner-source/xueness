/** Native JSON-RPC stdio host: legacy v1 methods and negotiated v2 projections. */
import { realpathSync, statSync } from "node:fs";
import { parse, resolve } from "node:path";
import { randomBytes } from 'node:crypto';
import { deriveEvents, headSeq, isDict, pageEvents, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pyExceptionName } from '@xueness/sessions';
import { AppProtocolError as Refused, AppProtocolDeferredReply, AppProtocolSubscriptions, createAppProtocolCore, createAppProtocolGoals, createAppProtocolMemory, createAppProtocolControls, createAppProtocolMedia, type AppProtocolPort } from '@xueness/plugin-remote';
import { FRONT_DOOR_VERSION } from "../front-door.ts";
import { allowRealDefault, type Cli, workspacePath } from "./host.ts";
import { serveAppServerInput } from './app-server-input.ts';

type Row = Record<string, any>;
type Reply = [number, any];
const PROTOCOL_NAME = "xueness.app-server.v1", MAX_FRAME_BYTES = 1024 * 1024, POLL_MS = 50, EVENT_LIMIT = 200;
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603, REFUSED = -32000;
const STATUS_TO_CODE: Record<number, number> = { 400: INVALID_PARAMS, 403: REFUSED, 404: REFUSED, 405: REFUSED, 409: REFUSED, 500: INTERNAL_ERROR, 501: REFUSED, 503: REFUSED };
const METHOD_STATUS: Record<number, string> = { [PARSE_ERROR]: "Parse error", [INVALID_REQUEST]: "Invalid Request", [METHOD_NOT_FOUND]: "Method not found", [INVALID_PARAMS]: "Invalid params", [INTERNAL_ERROR]: "Internal error", [REFUSED]: "Refused by Xueness" };
const TURN_KEYS = new Set(["sessionId", "text", "modelSelection", "mode", "permissionMode", "steps", "maxChars", "maxTokens", "maxWallSeconds", "runtimeProfile", "browser", "disallowTools", "continueQueue", "acknowledgeYolo"]);
const TURN_FIELDS: [string, string][] = [["mode", "mode"], ["permissionMode", "permission_mode"], ["acknowledgeYolo", "acknowledge_yolo"], ["steps", "steps"], ["maxChars", "max_chars"], ["maxTokens", "max_tokens"], ["maxWallSeconds", "max_wall_seconds"], ["runtimeProfile", "runtime_profile"], ["browser", "browser"], ["disallowTools", "disallow_tools"], ["continueQueue", "continue_queue"]];
const MODEL_KEYS: Record<string, string> = { providerId: "provider_id", provider_id: "provider_id", model: "model", reasoningEffort: "reasoning_effort", reasoning_effort: "reasoning_effort", selection: "selection", saveDefault: "save_default", source: "source" };
const TEXT_SELECTION = new Set(["provider_id", "model", "reasoning_effort", "selection"]);
const PERMISSION_MODES = ["build", "edit", "yolo", "plan", "guarded"];
const SID = /^[0-9a-f]{32}$/;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const sid = (params: Row): string => {
  const value = params.sessionId ?? params.sid;
  if (typeof value !== "string" || !SID.test(value)) throw new Refused("sessionId must be a 32-character session id", INVALID_PARAMS, { sessionId: typeof value === "string" ? value : null });
  return value;
};
function rejectUnknown(params: Row, allowed: Set<string>): void {
  const unknown = Object.keys(params).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw new Refused("unexpected keys: " + unknown.join(", "), INVALID_PARAMS, { keys: unknown });
}
function cleanSelection(raw: Row): Row {
  const result: Row = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = MODEL_KEYS[key];
    if (target === undefined || target === "save_default") continue;
    if (value !== null && typeof value !== "string") throw new Refused("model selection values must be strings or null", INVALID_PARAMS);
    result[target] = typeof value === "string" ? value.trim() : value;
    if (TEXT_SELECTION.has(target) && result[target] === "") result[target] = null;
  }
  return result;
}
function selectionParam(params: Row): Row {
  const raw = params.modelSelection;
  if (raw === undefined || raw === null) return {};
  if (!isDict(raw)) throw new Refused("modelSelection must be an object", INVALID_PARAMS);
  rejectUnknown(raw, new Set(["providerId", "provider_id", "model", "reasoningEffort", "reasoning_effort"]));
  return cleanSelection(raw);
}
function modelBody(params: Row): Row {
  const body = cleanSelection(Object.fromEntries(Object.entries(params).filter(([key]) => key in MODEL_KEYS)));
  if (Object.hasOwn(params, "saveDefault")) {
    const value = params.saveDefault;
    if (value !== null && value !== false && value !== true) throw new Refused("saveDefault must be a boolean", INVALID_PARAMS);
    if (value === true) body.save_default = true;
  }
  if (!["provider_id", "model", "reasoning_effort", "selection"].some((key) => Object.hasOwn(body, key))) throw new Refused("nothing to change: provide providerId, model, selection or reasoningEffort", INVALID_PARAMS);
  return body;
}

interface Turn { sid: string; cursor: number; stop: boolean; done: Promise<void> }

export class AppServer {
  readonly cli: Cli;
  readonly write: (text: string) => Promise<void>;
  readonly log: (message: string) => void;
  readonly turns = new Map<string, Turn>();
  stopping = false;
  protocolVersion = 1;
  private initialized = false;
  private writes = Promise.resolve();
  private shutdownTask: Promise<Row> | null = null;
  private readonly commands = new Map<Promise<Reply>, string>();
  private readonly core: ReturnType<typeof createAppProtocolCore>;
  private readonly subscriptions: AppProtocolSubscriptions;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly closed = new AbortController();
  readonly connectionId = randomBytes(16).toString('hex');
  readonly workspaceIdentity: string;
  readonly methods: Record<string, (params: Row) => Promise<unknown>>;

  constructor(cli: Cli, write: (text: string) => Promise<void>, log: (message: string) => void, workspaceIdentity = realpathSync(process.cwd())) {
    this.cli = cli; this.write = write; this.log = log;
    this.workspaceIdentity = workspaceIdentity;
    const port: AppProtocolPort = { workspaceIdentity, ask: (m, p, d, q) => this.ask(m, p, d, q),
      enabled: (id) => this.cli.enabled(id), authorize: async (id) => {
        if (!this.cli.enabled('sessions')) throw new Refused('sessions plugin unavailable', REFUSED, { status: 403 });
        let session: Row;
        try { session = await (await this.cli.store()).load(id) as Row; }
        catch (error) { if (pyExceptionName(error) === 'FileNotFoundError') throw new Refused('session not found', REFUSED, { status: 404 }); throw error; }
        if (session.remote_connection || typeof session.root !== 'string' || realpathSync(session.root) !== workspaceIdentity) throw new Refused('session belongs to another workspace', REFUSED, { status: 403 });
      } };
    this.core = createAppProtocolCore(port);
    this.subscriptions = new AppProtocolSubscriptions({ port, version: () => this.protocolVersion, notify: (m, p) => this.notify(m, p), wrap: (m, s, r) => this.core.transfers.wrap(m, s, r) as Row });
    this.methods = {
      ...this.core.methods, ...createAppProtocolGoals(port), ...createAppProtocolMemory(port), ...createAppProtocolControls(port), ...createAppProtocolMedia(port), ...this.subscriptions.methods,
      initialize: (p) => this.initialize(p),
      "session/list": async (p) => {
        if (p.archived !== undefined && p.archived !== null && typeof p.archived !== "boolean") throw new Refused("archived must be a boolean", INVALID_PARAMS);
        return this.ask("GET", p.archived ? "/api/sessions/archived" : "/api/sessions");
      },
      "session/get": async (p) => this.ask("GET", "/api/sessions/" + sid(p)),
      "session/create": (p) => this.create(p),
      "session/setModel": async (p) => {
        rejectUnknown(p, new Set(["sessionId", "providerId", "provider_id", "model", "selection", "reasoningEffort", "reasoning_effort", "saveDefault", "source"]));
        return this.ask("POST", `/api/sessions/${sid(p)}/model`, modelBody(p));
      },
      "session/setEffort": async (p) => {
        rejectUnknown(p, new Set(["sessionId", "reasoningEffort", "reasoning_effort", "saveDefault", "source"]));
        const effort = p.reasoningEffort ?? p.reasoning_effort;
        if (typeof effort !== "string" || !effort.trim()) throw new Refused("reasoningEffort must be a level string", INVALID_PARAMS);
        return this.ask("POST", `/api/sessions/${sid(p)}/model`, modelBody({ ...p, reasoningEffort: effort.trim() }));
      },
      "turn/start": (p) => this.turnStart(p),
      "turn/cancel": async (p) => {
        const id = sid(p), result = await this.ask("POST", `/api/sessions/${id}/stop`);
        const turn = this.turns.get(id);
        if (turn) turn.stop = true;
        return result;
      },
      shutdown: () => this.shutdown(),
      exit: () => this.shutdown(),
    };
    this.watchdog = setInterval(() => { if (!this.stopping && !this.ownerEnabled()) void this.shutdown().catch((e) => this.log(String(e))); }, 250); this.watchdog.unref();
  }

  send(payload: Row): Promise<void> {
    let frame = pyJsonDumps(payload, { separators: [",", ":"] }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      const replaced = Object.hasOwn(payload, "id") ? { jsonrpc: "2.0", id: payload.id, error: { code: REFUSED, message: "response exceeds frame limit", data: { reasonCode: "frame_too_large" } } }
        : { jsonrpc: "2.0", method: "transport/resyncRequired", params: { reason: "frame_too_large" } };
      frame = pyJsonDumps(replaced, { separators: [",", ":"] }) + "\n";
    }
    const pending = this.writes.then(() => this.write(frame));
    this.writes = pending.catch(() => {}); return pending;
  }
  error(id: unknown, code: number, message: string, data: Row | null = null): Promise<void> {
    return this.send({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data && Object.keys(data).length ? { data } : {}) } });
  }
  notify(method: string, params: Row): Promise<void> { return this.send({ jsonrpc: "2.0", method, params }); }

  ownerEnabled(): boolean { try { return this.cli.enabled("remote"); } catch { return false; } }

  async call(method: string, path: string, data: Row = {}, query: Record<string, string[]> = {}): Promise<Reply> {
    if (!(method === "POST" && path.endsWith("/stop")) && !this.ownerEnabled()) return [403, { error: "plugin disabled or dependency unavailable: remote", plugin: "remote" }];
    if (this.stopping && method === 'POST' && (path.endsWith('/run') || path.endsWith('/commands') && data.type === 'run')) return [409, { error: 'connection is closing; run was not admitted' }];
    const host = await this.cli.host();
    const request = host.dispatch(method, path.split("/").filter(Boolean), query, data).then((reply): Reply => reply === null ? [404, { error: 'no such route: ' + path }] : [reply[0], reply[1]]);
    const match = /^\/api\/sessions\/([0-9a-f]{32})\/commands$/.exec(path);
    if (method === 'POST' && match && data.type === 'run') this.commands.set(request, match[1]!);
    const reply = await request.finally(() => this.commands.delete(request));
    return reply === null ? [404, { error: "no such route: " + path }] : [reply[0], reply[1]];
  }
  async ask(method: string, path: string, data?: Row, query?: Record<string, string[]>): Promise<Row> {
    const [status, payload] = await this.call(method, path, data, query);
    if (status >= 400) {
      const body = isDict(payload) ? payload : {};
      throw new Refused(String(body.error || `route returned ${status}`), STATUS_TO_CODE[status] ?? REFUSED, { status, ...body });
    }
    return isDict(payload) ? payload : { value: payload };
  }

  async initialize(params: Row): Promise<Row> {
    const version = params.protocolVersion ?? 1;
    if (![1, 2].includes(version) || this.initialized && version !== this.protocolVersion) throw new Refused("unsupported protocol version or connection already initialized", INVALID_PARAMS);
    this.protocolVersion = version; this.initialized = true;
    const [, catalog] = await this.call("GET", "/api/plugins");
    const plugins = (Array.isArray(catalog?.plugins) ? catalog.plugins as Row[] : []).map((item) => ({ id: item.id, enabled: item.enabled, effective: item.effective, blockedBy: item.blockedBy ?? [], features: (item.features ?? []).map((feature: Row) => feature.id) }));
    const name = version === 1 ? PROTOCOL_NAME : 'xueness.app-server.v2';
    return { protocolName: name, protocol: name, protocolVersion: version, connectionId: this.connectionId, workspaceIdentity: this.workspaceIdentity, xuenessVersion: FRONT_DOOR_VERSION, serverInfo: { name: "xueness-app-server", transport: "stdio" },
      capabilities: { browserTabs: false, interactiveTerminals: false, durableCommands: true, conversationResume: true, stagedMedia: true, preparedMedia: true, responseFragments: true, questionControls: true, withdrawalRecovery: true, guidanceControls: true, historyMedia: true, modelCatalog: true, historyFork: true, legacyWritesIdempotent: false, projectionSubscriptions: version === 2, workflowControls: true, concurrentRequests: true, streamingNotifications: true, runtimeModelSwitch: true, networkListener: false, hostOriginCsrf: false, trustModel: "only the parent process that started this server is trusted; over stdio there is no Host/Origin/CSRF layer" },
      limits: { maxFrameBytes: MAX_FRAME_BYTES, maxChunkBytes: 256 * 1024, maxResponseBytes: 32 * 1024 * 1024, responseTransferTtlSeconds: 60, maxMediaFiles: 8, maxMediaFileBytes: 20 * 1024 * 1024, maxMediaSelectionBytes: 64 * 1024 * 1024, notificationMethods: ["session/event", "turn/started", "turn/finished"] },
      projectionVersion: 1, commandReceiptRetentionSeconds: 86400, maxSubscriptions: version === 2 ? 16 : 0, maxConcurrentRequests: 16, reservedControlRequests: 8,
      methods: Object.keys(this.methods).filter((m) => version === 2 || !/\/(?:subscribe|resync|unsubscribe)$/.test(m) && m !== 'connection/flow').sort(), plugins };
  }

  async create(params: Row): Promise<Row> {
    rejectUnknown(params, new Set(["task", "root", "modelSelection"]));
    if (typeof params.task !== "string" || !params.task.trim()) throw new Refused("task must be a non-empty string", INVALID_PARAMS);
    const body: Row = { task: params.task.trim() };
    if (params.root !== undefined && params.root !== null) {
      if (typeof params.root !== "string") throw new Refused("root must be a string", INVALID_PARAMS);
      body.root = params.root;
    }
    const selection = selectionParam(params);
    if (Object.keys(selection).length) body.model_selection = selection;
    return this.ask("POST", "/api/sessions", body);
  }

  async headCursor(id: string): Promise<number> {
    try { return headSeq(deriveEvents(await (await this.cli.store()).load(id) as Row)); } catch { return 0; }
  }
  async pump(id: string, cursor: number): Promise<number> {
    let envelope: Row;
    try {
      const session = await (await this.cli.store()).load(id) as Row;
      envelope = pageEvents(session, deriveEvents(session), cursor, EVENT_LIMIT) as Row;
    } catch (error) { this.log("app-server: event derivation failed: " + (error instanceof Error ? error.message : String(error))); return cursor; }
    for (const event of envelope.events as Row[]) await this.notify("session/event", { sessionId: id, event });
    return Number(envelope.nextCursor);
  }

  async turnStart(params: Row): Promise<Row> {
    rejectUnknown(params, TURN_KEYS);
    const mode = params.permissionMode;
    if (mode !== undefined && mode !== null && !PERMISSION_MODES.includes(mode)) throw new Refused("permissionMode must be one of: " + PERMISSION_MODES.join(", "), INVALID_PARAMS, { permissionMode: mode });
    if (Object.hasOwn(params, "acknowledgeYolo") && typeof params.acknowledgeYolo !== "boolean") throw new Refused("acknowledgeYolo must be a boolean", INVALID_PARAMS, { acknowledgeYolo: params.acknowledgeYolo });
    if (params.acknowledgeYolo === true && mode !== "yolo") throw new Refused("acknowledgeYolo requires permissionMode=yolo", INVALID_PARAMS, { acknowledgeYolo: true });
    const id = sid(params), selection = selectionParam(params);
    const body: Row = Object.keys(selection).length ? { model_selection: selection } : {};
    for (const [source, target] of TURN_FIELDS) if (Object.hasOwn(params, source)) body[target] = params[source];
    const text = params.text;
    if (text !== undefined && text !== null && typeof text !== "string") throw new Refused("text must be a string", INVALID_PARAMS);
    if (typeof text === "string" && text.trim()) await this.ask("POST", `/api/sessions/${id}/messages`, { text, ...(Object.keys(selection).length ? { model_selection: selection } : {}) });
    if (this.turns.has(id)) throw new Refused("session run already in progress", REFUSED, { status: 409, sessionId: id });
    const startedAt = await this.headCursor(id);
    const turn: Turn = { sid: id, cursor: startedAt, stop: false, done: Promise.resolve() };
    this.turns.set(id, turn);
    turn.done = new Promise<void>((done) => setImmediate(done)).then(() => this.runTurn(turn, body, startedAt)).catch((error) => {
      this.turns.delete(id); this.log('app-server: turn transport ended: ' + String(error)); void this.shutdown().catch((e) => this.log(String(e)));
    });
    return { sessionId: id, accepted: true, cursor: startedAt };
  }

  async runTurn(turn: Turn, body: Row, startedAt: number): Promise<void> {
    await this.notify("turn/started", { sessionId: turn.sid, cursor: startedAt });
    let settled = false;
    const outcome = this.call("POST", `/api/sessions/${turn.sid}/run`, body).then((reply) => ({ reply }), (failure: unknown) => ({ failure })).finally(() => { settled = true; });
    while (!settled && !turn.stop) { await sleep(POLL_MS); turn.cursor = await this.pump(turn.sid, turn.cursor); }
    const result: { reply?: Reply; failure?: unknown } = await outcome;
    turn.cursor = await this.pump(turn.sid, turn.cursor);
    if (this.turns.get(turn.sid) === turn) this.turns.delete(turn.sid);
    if (result.failure !== undefined || !result.reply) {
      const message = result.failure instanceof Error ? result.failure.message : result.failure !== undefined ? String(result.failure) : "turn produced no response";
      await this.notify("turn/finished", { sessionId: turn.sid, ok: false, cursor: turn.cursor, error: { code: INTERNAL_ERROR, message } });
      return;
    }
    const [status, payload] = result.reply;
    const finished: Row = { sessionId: turn.sid, ok: status < 400, cursor: turn.cursor, status, result: payload };
    if (status >= 400) finished.error = { code: STATUS_TO_CODE[status] ?? REFUSED, message: String((isDict(payload) ? payload.error : null) || `route returned ${status}`) };
    await this.notify("turn/finished", finished);
  }

  shutdown(): Promise<Row> {
    return this.shutdownTask ??= this.closeOwned().finally(() => this.closed.abort());
  }
  private async closeOwned(): Promise<Row> {
    this.stopping = true; clearInterval(this.watchdog); this.subscriptions.close(); this.core.close();
    const turns = [...this.turns.values()], commands = [...this.commands], ids = [...new Set([...turns.map((t) => t.sid), ...commands.map(([, id]) => id)])];
    for (const id of ids) await this.call('POST', `/api/sessions/${id}/stop`).catch(() => null);
    for (const turn of turns) turn.stop = true;
    const host = await this.cli.host();
    await host.dynamicWorkflows.close(); await host.agent.dispose();
    await Promise.allSettled([...turns.map((turn) => turn.done), ...commands.map(([request]) => request)]);
    return { ok: true, stoppedTurns: ids };
  }

  async handleLine(line: Buffer): Promise<void> {
    let message: unknown;
    try { message = pyJsonLoads(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { await this.error(null, PARSE_ERROR, METHOD_STATUS[PARSE_ERROR]!, { reason: "frame is not valid JSON" }); return; }
    if (!isDict(message)) { await this.error(null, INVALID_REQUEST, METHOD_STATUS[INVALID_REQUEST]!, { reason: "expected a JSON-RPC request object" }); return; }
    const id = message.id ?? null;
    if (id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) { await this.error(null, INVALID_REQUEST, METHOD_STATUS[INVALID_REQUEST]!, { reason: "id must be a string or number" }); return; }
    if (typeof id === "string" && Buffer.byteLength(id) > 1024) { await this.error(null, INVALID_REQUEST, "request id exceeds limit"); return; }
    if (message.jsonrpc !== "2.0") { await this.error(id, INVALID_REQUEST, METHOD_STATUS[INVALID_REQUEST]!, { reason: 'jsonrpc must be "2.0"' }); return; }
    const method = message.method;
    if (typeof method !== "string" || !method) { await this.error(id, INVALID_REQUEST, METHOD_STATUS[INVALID_REQUEST]!, { reason: "method must be a non-empty string" }); return; }
    const params = message.params ?? {};
    if (!isDict(params)) { await this.error(id, INVALID_PARAMS, METHOD_STATUS[INVALID_PARAMS]!, { reason: "params must be an object" }); return; }
    const handler = Object.hasOwn(this.methods, method) ? this.methods[method] : undefined;
    if (!handler) { await this.error(id, METHOD_NOT_FOUND, METHOD_STATUS[METHOD_NOT_FOUND]!, { method, known: Object.keys(this.methods).sort() }); return; }
    if (id === null && /\/(?:subscribe|resync)$/.test(method)) { await this.error(null, INVALID_REQUEST, 'subscription requests require an id'); return; }
    if (!["shutdown", "exit", "turn/cancel"].includes(method) && (this.stopping || !this.ownerEnabled())) {
      if (!this.stopping) await this.shutdown();
      await this.error(id, REFUSED, "plugin disabled or dependency unavailable: remote", { status: 403, plugin: "remote" });
      return;
    }
    let result: unknown;
    try {
      result = await handler(params);
      if (!(result instanceof AppProtocolDeferredReply) && typeof params.sessionId === 'string') result = this.core.transfers.wrap(method, params.sessionId, result);
    }
    catch (error) {
      if (error instanceof Refused) { await this.error(id, error.code, error.message, error.data); return; }
      this.log(`app-server: ${method} raised ${error instanceof Error ? error.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`);
      await this.error(id, INTERNAL_ERROR, METHOD_STATUS[INTERNAL_ERROR]!, { exception: error instanceof Error ? error.name : "Error" });
      return;
    }
    const deferred = result instanceof AppProtocolDeferredReply ? result : null;
    if (id !== null) await this.send({ jsonrpc: "2.0", id, result: deferred ? deferred.result : result });
    if (deferred) await deferred.afterResponse();
  }

  /** Initialization is a barrier; long runs leave reserved capacity for control. */
  serve(): Promise<number> {
    return serveAppServerInput({ input: process.stdin, handle: (line) => this.handleLine(line), error: (id, code, message, data) => this.error(id, code, message, data), shutdown: () => this.shutdown(), stopping: () => this.stopping, closed: this.closed.signal });
  }
}

/** `app_server.run`: refuse without the remote plugin or with a bad root, then serve until EOF or shutdown. */
export async function appServer(cli: Cli): Promise<number> {
  const log = (message: string): void => { process.stderr.write(message.endsWith("\n") ? message : message + "\n"); };
  if (!cli.enabled("remote")) { log("app-server refused to start: the remote plugin (and therefore remote.app_server) is not enabled. Enable it with `xueness plugins enable remote` first."); return 2; }
  const a = cli.args, roots: string[] = [];
  for (const value of a.workspace_root as string[]) {
    let root: string;
    try { root = realpathSync(workspacePath(value)); } catch { log(`app-server refused to start: --workspace-root must name an existing directory: ${value}`); return 2; }
    if (!statSync(root).isDirectory()) { log(`app-server refused to start: --workspace-root must name a directory, not a file: ${value}`); return 2; }
    if (parse(root).root === root) { log(`app-server refused to start: --workspace-root is too broad; choose a project directory: ${value}`); return 2; }
    roots.push(root);
  }
  cli.overrides = { workspaceRoots: roots, allowReal: a.allow_real ?? allowRealDefault(), ...(a.web_runs != null ? { webRuns: resolve(workspacePath(a.web_runs)) } : {}) };
  // Frames own stdout; anything else a feature prints goes to stderr (Python `redirect_stdout`).
  const stdout = process.stdout.write.bind(process.stdout), original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const workspaceIdentity = roots[0] ?? realpathSync(process.cwd());
  if (!roots.length) roots.push(workspaceIdentity);
  try { return await new AppServer(cli, (text) => new Promise<void>((done, reject) => { stdout(text, (error) => error ? reject(error) : done()); }), log, workspaceIdentity).serve(); }
  finally { process.stdout.write = original; }
}
