import { isAbsolute } from "node:path";
import { pyStrip, PyValueError } from "@xueness/contracts";
import { realish, type Session, type SessionStore } from "@xueness/sessions";
import { validateWorkspace } from "./queue-http.ts";
import type { SessionCommandsOptions } from "./queue-types.ts";
import type { SessionReply, SessionRequest } from "./http-api.ts";
import { reindexJsonSessions, sqliteSessionStorageEnabled, type SessionStorageEnvironment } from "./session-storage.ts";
import { SqliteSessionLibrary } from "./sqlite-library.ts";

type Dict = Record<string, unknown>;

export const SESSION_STORAGE_ROUTES = [
  "GET /api/sessions/storage",
  "POST /api/sessions/storage/reindex",
  "GET /api/sessions/storage/list",
] as const;

export interface SessionStorageApiOptions {
  store: SessionStore;
  stateDir: string;
  webRuns: string;
  projectDir: string;
  enabled: (id: string) => boolean;
  allowedRoots?: () => readonly string[];
  validateWorkspace?: (session: Session) => void | Promise<void>;
  env?: SessionStorageEnvironment;
}

function exactRoute(method: string, parts: readonly string[]): boolean {
  return parts[0] === "api" && parts[1] === "sessions" && parts[2] === "storage" && (
    parts.length === 3 && method === "GET" ||
    parts.length === 4 && parts[3] === "reindex" && method === "POST" ||
    parts.length === 4 && parts[3] === "list" && method === "GET"
  );
}

function queryString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return null;
}

function allowedRoots(options: SessionStorageApiOptions): string[] {
  return [...new Set([options.webRuns, options.projectDir, ...(options.allowedRoots?.() ?? [])].map(realish))];
}

async function visibleRoots(options: SessionStorageApiOptions): Promise<string[]> {
  const visible: string[] = [];
  for (const root of allowedRoots(options)) {
    try { visible.push(await checkRoot(options, root)); } catch { /* only authorized roots contribute to the count */ }
  }
  return [...new Set(visible)];
}

async function checkRoot(options: SessionStorageApiOptions, root: string): Promise<string> {
  if (!root || !isAbsolute(root) || pyStrip(root).length > 4096) throw new PyValueError("workspace root not permitted");
  const context: SessionCommandsOptions = {
    store: options.store,
    stateDir: options.stateDir,
    webRuns: options.webRuns,
    projectDir: options.projectDir,
    enabled: options.enabled,
    allowedRoots: options.allowedRoots,
    validateWorkspace: options.validateWorkspace,
  };
  await validateWorkspace(context, { root });
  return realish(root);
}

export function createSessionStorageApi(options: SessionStorageApiOptions) {
  if (realish(options.stateDir) !== options.store.directory) throw new PyValueError("session storage state directory does not match the journal store");
  const library = new SqliteSessionLibrary(options.store.directory);
  return {
    routes: SESSION_STORAGE_ROUTES,
    owns: exactRoute,
    async dispatch(method: string, parts: string[], query: Dict, _data: unknown, _request?: SessionRequest): Promise<SessionReply | null> {
      if (!exactRoute(method, parts)) return null;
      if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      const storageEnabled = sqliteSessionStorageEnabled({ env: options.env, enabled: options.enabled });
      if (parts.length === 3) {
        if (!storageEnabled) return [200, { enabled: false, count: null }];
        try { return [200, { enabled: true, count: library.countRoots(await visibleRoots(options)) }]; }
        catch { return [500, { error: "cannot read SQLite session library" }]; }
      }
      if (!storageEnabled) return [404, { error: "SQLite session library is disabled", code: "session_sqlite_disabled" }];
      if (parts[3] === "reindex") {
        try {
          await reindexJsonSessions(options.store, { validate: async (session) => { await checkRoot(options, typeof session.root === "string" ? session.root : ""); } });
          return [200, { ok: true }];
        } catch { return [500, { error: "cannot reindex sessions into SQLite" }]; }
      }
      const rawRoot = queryString(query.root);
      if (rawRoot === null) return [400, { error: "root is required" }];
      const rootText = pyStrip(rawRoot);
      let root: string;
      try { root = await checkRoot(options, rootText); }
      catch { return [400, { error: "workspace root not permitted", code: "workspace_not_permitted" }]; }
      const rawLimit = queryString(query.limit);
      if (query.limit !== undefined && rawLimit === null) return [400, { error: "limit must be a single integer" }];
      const limit = rawLimit === null || rawLimit === "" ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return [400, { error: "limit must be an integer from 1 to 500" }];
      try {
        const sessions = library.list(root, limit).map(({ id, root: savedRoot, title, task, status, history_revision, history_hash, updated_at }) => ({
          id, root: savedRoot, title, task, status,
          history_revision,
          history_hash, updated_at,
        }));
        return [200, { root, sessions }];
      } catch { return [500, { error: "cannot query SQLite session library" }]; }
    },
  };
}
