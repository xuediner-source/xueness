/**
 * `/api/remote` (Python `remote/plugin.py` dispatch and `connection_api.py`):
 * saved SSH connection CRUD plus the live connection lifecycle. Saves take the
 * shared `.plugin-state.lock` when the host supplies its native lock provider.
 */
import { isDict, pyEncodeUtf8, pyInt, pyJsonDumps } from "@xueness/contracts";
import { isPyOSError, isPyValueError, type FileLockProvider } from "@xueness/sessions";
import { RemoteError, TransportError } from "./client.ts";
import { registerEnabled } from "./connection-state.ts";
import { getManager, RemoteKeyError, RemoteValueError, type RemoteManager } from "./manager.ts";
import { digest, keepSavedSystem, loadConnections, persisted, saveConnections, validateConnection } from "./store.ts";

type Row = Record<string, unknown>;
type Reply = [number, unknown];
export const REMOTE_ROUTES = ["GET /api/remote", "POST /api/remote", "DELETE /api/remote/<id>", "GET /api/remote/active", "GET /api/remote/operations/<requestId>",
  "POST /api/remote/operations/<requestId>/cancel", "POST /api/remote/<id>/connect", "POST /api/remote/<id>/reconnect", "POST /api/remote/<id>/disconnect",
  "POST /api/remote/<id>/request", "GET /api/remote/<id>/sessions"] as const;

export interface RemoteHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
  projectDir?: string;
  /** The host's native flock provider; Python CLI saves take the same lock file. */
  locks?: FileLockProvider;
}
export interface RemoteContext { stateDir: string; projectDir?: string; remote_connections?: RemoteManager }

/** `GET /api/remote` rows: the stored record plus its digest. Load errors propagate. */
export function publicConnections(stateDir: string): Row[] {
  return loadConnections(stateDir).map((row) => ({ ...persisted(row), digest: digest(row) }));
}

const loadFailure = (error: unknown): boolean => isPyValueError(error) || isPyOSError(error) || error instanceof RemoteValueError || error instanceof Error && ["PyJsonDecodeError", "JSONDecodeError", "UnicodeDecodeError", "PermissionError"].includes(error.name) || !!(error as NodeJS.ErrnoException | null)?.code;

async function underLock<T>(options: RemoteHttpOptions, body: () => T): Promise<T> {
  const handle = await options.locks?.acquire(options.stateDir, ".plugin-state.lock", 30);
  try { return body(); } finally { handle?.release(); }
}

function one(query: Record<string, unknown>, key: string): unknown {
  const value = query[key];
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

/** `connection_api.dispatch`; `null` when the path is a saved-connection route. */
async function lifecycle(manager: () => RemoteManager, method: string, tail: readonly string[], query: Record<string, unknown>, data: unknown): Promise<Reply | null> {
  if (!tail.length || tail.length === 1 && tail[0] !== "active" && tail[0] !== "operations") return null;
  const live = manager();
  if (method === "GET" && tail.length === 1 && tail[0] === "active") return [200, { connections: live.active() }];
  if (tail.length === 2 && tail[0] === "operations" && method === "GET") return [200, live.operation(tail[1]!)];
  if (tail.length === 3 && tail[0] === "operations" && tail[2] === "cancel" && method === "POST") return [200, live.cancel(tail[1]!)];
  if (tail.length === 2 && method === "POST") {
    const [cid, action] = tail as [string, string];
    const limit = action === "request" ? 768 * 1024 : 4096;
    if (!isDict(data) || pyEncodeUtf8(pyJsonDumps(data)).length > limit) throw new RemoteValueError("invalid operation body");
    const keys = Object.keys(data);
    if (action === "request") {
      const required = ["expectedGeneration", "expectedDigest", "method", "params"];
      if (!required.every((key) => Object.hasOwn(data, key)) || keys.some((key) => !required.includes(key) && key !== "requestId")) throw new RemoteValueError("invalid request fields");
      if (typeof data.method !== "string" || !isDict(data.params)) throw new RemoteValueError("invalid request method or params");
      if (typeof data.expectedGeneration !== "string" || typeof data.expectedDigest !== "string") throw new RemoteValueError("connection scope required");
      return [200, await live.request(cid, data.method, data.params, { expectedGeneration: data.expectedGeneration, expectedDigest: data.expectedDigest, requestId: data.requestId ?? null })];
    }
    if (action === "connect" || action === "reconnect") {
      const allowed = ["requestId", "expectedDigest", ...action === "reconnect" ? ["expectedGeneration"] : []];
      if (keys.length !== allowed.length || !allowed.every((key) => Object.hasOwn(data, key))) throw new RemoteValueError("invalid operation fields");
      return [202, live.connect(cid, data.expectedDigest as string, data.requestId, { reconnect: action === "reconnect", expectedGeneration: data.expectedGeneration ?? null })];
    }
    if (action === "disconnect") {
      if (keys.length !== 1 || !Object.hasOwn(data, "expectedGeneration")) throw new RemoteValueError("expectedGeneration required");
      return [200, live.disconnect(cid, data.expectedGeneration as string)];
    }
  }
  if (tail.length === 2 && tail[1] === "sessions" && method === "GET") {
    const pagination: Record<string, number> = {};
    for (const [key, fallback] of [["offset", 0], ["limit", 100]] as const) {
      const raw = one(query, key);
      if (raw === undefined || raw === null) pagination[key] = fallback;
      else if (typeof raw !== "string" || !/^\p{Nd}+$/u.test(raw)) throw new RemoteValueError("invalid pagination");
      else pagination[key] = pyInt(raw);
    }
    if (pagination.offset! < 0 || !(pagination.limit! >= 1 && pagination.limit! <= 100)) throw new RemoteValueError("invalid pagination");
    return [200, await live.request(tail[0]!, "sessions/index", pagination, { expectedGeneration: one(query, "expectedGeneration") as string, expectedDigest: one(query, "expectedDigest") as string })];
  }
  return [405, { error: "method not allowed" }];
}

/** RemoteError carries the JSON-RPC error; a 409 tells the client it may start a new identity. */
function refused(error: RemoteError): Reply {
  const rpc = isDict(error.error) ? error.error : {};
  const detail = isDict(rpc.data) ? rpc.data : {};
  let status = detail.status;
  if (detail.reasonCode === "command_unknown") status = 503;
  else if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) status = rpc.code === -32600 || rpc.code === -32601 || rpc.code === -32602 ? 409 : 503;
  return [status as number, { error: "remote request refused", rpcError: error.error }];
}

export function createRemoteHttp(options: RemoteHttpOptions) {
  const { stateDir } = options;
  const ctx: RemoteContext = { stateDir, ...options.projectDir ? { projectDir: options.projectDir } : {} };
  const unregister = registerEnabled(stateDir, options.enabled);
  const manager = (): RemoteManager => getManager(ctx);
  async function saved(method: string, parts: readonly string[], data: unknown): Promise<Reply> {
    try {
      if (parts.length === 2 && method === "GET") return [200, { connections: publicConnections(stateDir) }];
      if (parts.length === 2 && method === "POST") {
        let row = validateConnection(data);
        const systemMentioned = isDict(data) && Object.hasOwn(data, "system");
        const previous = await underLock(options, () => {
          const existing = loadConnections(stateDir);
          const before = existing.find((item) => item.id === row.id);
          row = keepSavedSystem(row, before, systemMentioned);
          const rows = existing.filter((item) => item.id !== row.id);
          if (rows.length >= 100) throw new RemoteValueError("remote connections capped at 100");
          saveConnections(stateDir, [...rows, row]);
          return before;
        });
        if (ctx.remote_connections && (previous === undefined || digest(previous) !== digest(row))) ctx.remote_connections.invalidate(row.id);
        return [200, { connection: persisted(row) }];
      }
      if (parts.length === 3 && method === "DELETE") {
        const id = parts[2]!;
        await underLock(options, () => saveConnections(stateDir, loadConnections(stateDir).filter((item) => item.id !== id)));
        ctx.remote_connections?.invalidate(id);
        return [200, { deleted: id }];
      }
      return [405, { error: "method not allowed" }];
    } catch (error) {
      if (loadFailure(error)) return [400, { error: "invalid remote connection" }];
      throw error;
    }
  }
  return {
    routes: REMOTE_ROUTES,
    context: ctx,
    owns: (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "remote",
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown): Promise<Reply | null> {
      if (parts[0] !== "api" || parts[1] !== "remote") return null;
      if (!options.enabled("remote")) return [403, { error: "plugin disabled or dependency unavailable: remote", plugin: "remote", code: "plugin_disabled" }];
      try {
        const live = await lifecycle(manager, method, parts.slice(2), query, data);
        if (live !== null) return live;
      } catch (error) {
        if (error instanceof RemoteError) return refused(error);
        if (error instanceof RemoteKeyError) return [404, { error: "operation unavailable" }];
        if (error instanceof RemoteValueError || isPyValueError(error)) return [409, { error: (error as Error).message }];
        if (error instanceof TransportError || isPyOSError(error)) return [503, { error: "remote connection unavailable" }];
        throw error;
      }
      return saved(method, parts, data);
    },
    close(): void {
      const live = ctx.remote_connections as { close?: () => void } | undefined;
      live?.close?.();
      delete ctx.remote_connections;
      unregister();
    },
  };
}
