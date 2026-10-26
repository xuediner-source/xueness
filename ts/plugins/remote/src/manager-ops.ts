/** Scoped remote RPC, including one-shot fragment reconstruction. No SSH. */
import { createHash } from "node:crypto";
import { isDict, pyDecodeUtf8, pyJsonLoads, pyLen } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { RemoteValueError } from "./manager.ts";
import { TransportError } from "./client.ts";

export const REQUIRED_METHODS = Object.freeze(["sessions/index", "command/execute", "command/query", "conversation/snapshot", "conversation/resume", "session/read", "response/read"]);
const REQUIRED = new Set<string>(REQUIRED_METHODS);
export const ALLOWED_METHODS = Object.freeze([
  "browser/cancel-open", "browser/list", "browser/open", "browser/action", "browser/cancel", "browser/close",
  "terminal/cancel-open", "terminal/list", "terminal/open", "terminal/read", "terminal/input", "terminal/resize", "terminal/close",
  "sessions/index", "workspace/index", "conversation/snapshot", "conversation/resume", "command/execute", "command/query",
  "composer/prepare", "composer/catalog", "media/begin", "media/chunk", "media/commit", "media/abort", "media/status", "media/release",
  "session/read", "sessions/events", "response/read", "question/read", "question/answer", "question/query",
  "withdrawal/list", "withdrawal/get", "withdrawal/dismiss", "guidance/query", "guidance/read", "guidance/send", "guidance/cancel", "guidance/promote",
  "media/restore", "media/preview", "media/restore-status", "media/restore-abort", "media/restore-epoch", "history/fork-boundaries",
  'conversation/rowsRange', 'history/rewind-targets', 'history/rewind', 'files/rewind-preview', 'files/rewind',
  "connection/flow", ...["conversation", "controller", "workflow"].flatMap((kind) => ["subscribe", "resync", "unsubscribe"].map((op) => `${kind}/${op}`)),
  ...['list', 'get', 'events', 'create', 'start', 'resume', 'cancel', 'recover', 'concurrency', 'resolve', 'amend', 'compile'].map((op) => 'workflow/' + op),
  ...['read', 'set', 'pause', 'resume', 'clear', 'budget'].map(op => 'goal/' + op),
  ...['list', 'propose', 'get', 'diff', 'start', 'cancel', 'apply', 'revert'].map(op => 'memory/dream/' + op),
]);
const ALLOWED = new Set<string>(ALLOWED_METHODS);
const FRAGMENT = new Set(["browser/action", "conversation/snapshot", "conversation/resume", 'conversation/rowsRange', 'workflow/get', 'workflow/events', "session/read", "history/fork-boundaries", "composer/catalog", "question/read", "withdrawal/list", "withdrawal/get", "guidance/read", "guidance/send", "guidance/promote", "media/restore", "media/preview", "media/restore-status"]);
const CEILINGS: readonly [string, number][] = [["maxFrameBytes", 1024 * 1024], ["maxChunkBytes", 256 * 1024], ["maxResponseBytes", 32 * 1024 * 1024], ["responseTransferTtlSeconds", 60], ["maxMediaFiles", 8], ["maxMediaFileBytes", 20 * 1024 * 1024], ["maxMediaSelectionBytes", 64 * 1024 * 1024]];
const WINDOWS_REMOTE_ERROR = "remote Windows hosts are not supported (system=windows): commands are quoted for a POSIX shell and cannot be run safely on cmd or PowerShell";

export interface LiveClient {
  alive: boolean;
  close(): void;
  request(method: string, params: Record<string, unknown>, opts?: { requestId?: unknown; timeout?: number; cancel?: { isSet(): boolean } | null }): unknown;
}

export interface LiveItem {
  connectionId: string;
  digest: string;
  generation: string;
  state: string;
  workspaceIdentity: string | null;
  capabilities: Record<string, unknown>;
  limits: Record<string, number>;
  index: unknown;
  methods: unknown[];
  client: LiveClient | null;
  /** Negotiated app-server protocol (1 or 2); 2 enables the projection subscription path. */
  protocolVersion: number;
  maxSubscriptions: number;
  /** v2 projection driver; null until a v2 connection is established. */
  subscriber: import('./projection-subscriber.ts').ProjectionDriver | null;
}

export interface RequestHost {
  connections: Map<string, LiveItem>;
  row(connectionId: string, expectedDigest: string): void;
  enabled(pluginId: string): boolean;
  call(client: LiveClient, method: string, params: Record<string, unknown>, opts: { requestId?: unknown; timeout: number; cancel?: { isSet(): boolean } | null }): Promise<unknown>;
}

export interface RequestOptions {
  expectedGeneration: string;
  expectedDigest: string;
  requestId?: unknown;
  timeout?: unknown;
  cancel?: { isSet(): boolean } | null;
}

export function validatedLimits(raw: unknown): Record<string, number> {
  if (!isDict(raw)) return {};
  const limits: Record<string, number> = {};
  for (const [key, cap] of CEILINGS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) limits[key] = Math.min(value, cap);
  }
  return limits;
}

export function requirePosix(row: object): void {
  const system = Object.hasOwn(row, "system") ? (row as { system?: unknown }).system : "posix";
  if (system === "windows") throw new RemoteValueError(WINDOWS_REMOTE_ERROR);
  if (system !== "posix") throw new RemoteValueError("invalid remote system");
}

const SUBSCRIPTION_METHODS = Object.freeze(["connection/flow", ...["conversation", "controller", "workflow"].flatMap((kind) => ["subscribe", "resync", "unsubscribe"].map((op) => `${kind}/${op}`))]);

/** Negotiated protocol facts the manager relies on after `initialize`. */
export interface HelloFacts {
  protocolVersion: number;
  workspaceIdentity: string;
  capabilities: Record<string, unknown>;
  methods: unknown[];
  limits?: unknown;
  maxSubscriptions: number;
}

export function acceptHello(hello: unknown): hello is HelloFacts {
  if (!isDict(hello)) return false;
  const version = hello.protocolVersion;
  if (version !== 1 && version !== 2) return false;
  if (hello.protocolName !== `xueness.app-server.v${version}`) return false;
  const identity = hello.workspaceIdentity;
  const caps = hello.capabilities;
  if (typeof identity !== "string" || pyLen(identity) < 1 || pyLen(identity) > 4096 || !isDict(caps)) return false;
  if (!caps.durableCommands || !caps.conversationResume || caps.responseFragments !== true) return false;
  const methods = hello.methods;
  if (!Array.isArray(methods) || !REQUIRED_METHODS.every((method) => methods.includes(method))) return false;
  if (version === 1) return true;
  // v2 must actually offer the projection subscription path, not just the name.
  if (caps.projectionSubscriptions !== true) return false;
  const maxSubscriptions = hello.maxSubscriptions;
  if (typeof maxSubscriptions !== "number" || !Number.isInteger(maxSubscriptions) || maxSubscriptions < 1) return false;
  return SUBSCRIPTION_METHODS.every((method) => methods.includes(method));
}

export function acceptIndex(index: unknown, identity: string): boolean {
  return isDict(index) && index.workspaceIdentity === identity && Array.isArray(index.sessions) && index.sessions.length <= 10000;
}

export function hasRequiredMethods(methods: unknown): boolean {
  return Array.isArray(methods) && [...REQUIRED].every((method) => methods.includes(method));
}

function valueOrOs(error: unknown): boolean {
  if (error instanceof RemoteValueError || isPyValueError(error) || isPyOSError(error)) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "JSONDecodeError" || name === "UnicodeError" || name === "UnicodeDecodeError" || name === "PermissionError";
}

function terminalCleanup(method: string, params: unknown): boolean {
  return method === "terminal/list" && isDict(params) && typeof params.cleanupOpenId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(params.cleanupOpenId);
}

function now(): number {
  return performance.now() / 1000;
}

export async function performRequest(host: RequestHost, connectionId: string, method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
  if (!ALLOWED.has(method)) throw new RemoteValueError("remote method not allowed");
  if (method.startsWith("browser/") && method !== "browser/close" && method !== "browser/cancel-open" && !host.enabled("browser")) throw new TransportError("browser plugin unavailable");
  if (method.startsWith("terminal/") && method !== "terminal/close" && method !== "terminal/cancel-open" && !terminalCleanup(method, params) && !host.enabled("terminal")) throw new TransportError("terminal plugin unavailable");
  if (params != null && !isDict(params)) throw new RemoteValueError("params must be an object");
  host.row(connectionId, opts.expectedDigest);
  const item = host.connections.get(connectionId);
  if (!item || item.generation !== opts.expectedGeneration || item.digest !== opts.expectedDigest || item.state !== "connected" || !item.client || !item.client.alive) throw new TransportError("remote connection unavailable");
  if (!Array.isArray(item.methods) || !item.methods.includes(method)) throw new TransportError("remote capability unavailable");
  const identity = item.workspaceIdentity;
  const payload: Record<string, unknown> = { ...(isDict(params) ? params : {}) };
  if (Object.hasOwn(payload, "workspaceIdentity") && payload.workspaceIdentity !== identity) throw new RemoteValueError("workspace identity mismatch");
  payload.workspaceIdentity = identity;
  const client = item.client;
  const timeout = opts.timeout ?? 30;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new RemoteValueError("invalid request timeout");
  const deadline = now() + Math.min(timeout, 120);
  let dispatched = false;
  const check = (): number => {
    if (opts.cancel?.isSet()) throw new TransportError("request cancelled; outcome may be unknown");
    try { host.row(connectionId, opts.expectedDigest); } catch (error) {
      if (!valueOrOs(error)) throw error;
      if (dispatched) throw new TransportError("connection configuration changed; outcome may be unknown");
      throw error;
    }
    if (host.connections.get(connectionId) !== item || item.state !== "connected" || item.generation !== opts.expectedGeneration || item.digest !== opts.expectedDigest || item.workspaceIdentity !== identity || !client.alive) throw new TransportError("connection superseded; outcome may be unknown");
    const remaining = deadline - now();
    if (remaining <= 0) throw new TransportError("response deadline exceeded; request a fresh snapshot");
    return remaining;
  };
  const remaining = check();
  dispatched = true;
  let result = await host.call(client, method, payload, { requestId: opts.requestId, timeout: remaining, cancel: opts.cancel });
  check();
  if (isDict(result) && result.schema === "xueness.remote-fragment.v1") {
    result = await readFragments(host, client, item, method, payload, identity, result, opts.cancel ?? null, check);
    check();
  }
  return result;
}

async function readFragments(host: RequestHost, client: LiveClient, item: LiveItem, method: string, payload: Record<string, unknown>, identity: string | null, result: Record<string, unknown>, cancel: { isSet(): boolean } | null, check: () => number): Promise<unknown> {
  if (!FRAGMENT.has(method)) throw new TransportError("fragment response not permitted for this method");
  if (!Array.isArray(item.methods) || !item.methods.includes("response/read") || item.capabilities.responseFragments !== true) throw new TransportError("fragment capability unavailable");
  const token = result.transferId;
  const size = result.byteLength;
  const chunk = result.chunkBytes;
  const total = result.totalChunks;
  const digest = result.sha256;
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token) || typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > 32 * 1024 * 1024 || typeof chunk !== "number" || !Number.isInteger(chunk) || chunk <= 0 || chunk > 256 * 1024 || typeof total !== "number" || !Number.isInteger(total) || total !== Math.floor((size + chunk - 1) / chunk) || total > 128 || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || typeof payload.sessionId !== "string") throw new TransportError("invalid response transfer declaration");
  const raw = Buffer.allocUnsafe(size);
  let offset = 0;
  for (let index = 0; index < total; index += 1) {
    const part = await host.call(client, "response/read", { workspaceIdentity: identity, sessionId: payload.sessionId, transferId: token, chunkIndex: index }, { timeout: check(), cancel });
    check();
    const expected = Math.min(chunk, size - index * chunk);
    if (!isDict(part) || part.transferId !== token || typeof part.chunkIndex !== "number" || !Number.isInteger(part.chunkIndex) || part.chunkIndex !== index || typeof part.data !== "string" || pyLen(part.data) !== 4 * Math.floor((expected + 2) / 3)) throw new TransportError("invalid response fragment");
    let decoded: Buffer;
    try { decoded = decodeBase64(part.data); } catch { throw new TransportError("invalid response fragment encoding"); }
    if (decoded.length !== expected) throw new TransportError("response fragment length mismatch");
    decoded.copy(raw, offset);
    offset += decoded.length;
  }
  if (offset !== size || createHash("sha256").update(raw).digest("hex") !== digest) throw new TransportError("response transfer checksum mismatch");
  let parsed: unknown;
  try { parsed = pyJsonLoads(pyDecodeUtf8(raw)); } catch { throw new TransportError("invalid reconstructed response"); }
  if (!isDict(parsed)) throw new TransportError("invalid reconstructed response");
  return parsed;
}

function decodeBase64(data: string): Buffer {
  if (data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.replace(/=+$/, "")) || (data.match(/=/g)?.length ?? 0) > 2 || /=./.test(data)) throw new Error("bad base64");
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decoded = Buffer.from(data, "base64");
  if (decoded.length !== data.length / 4 * 3 - pad) throw new Error("bad base64");
  return decoded;
}
