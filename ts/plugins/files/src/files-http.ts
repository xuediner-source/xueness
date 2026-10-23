/**
 * Files HTTP surface: directory browsing plus session file list and preview.
 *
 * Python `http_routes.handle_GET` owns only GET `/api/sessions/<sid>/files`
 * and GET `/api/sessions/<sid>/file` for a lowercase 32-hex id. Other verbs
 * return null (not 405) so the front door proxies them. Directory GET and
 * POST are owned; other directory verbs are not. `/api/home` is not owned.
 */
import { isPyOSError, isPyValueError, pyExceptionName } from "@xueness/sessions";
import { dispatchDirectory, type DirectoryHttpOptions, type DirectoryReply } from "./directory-http.ts";
import { BINARY_PREVIEW_SUFFIXES, previewSuffix, workspaceBinaryPreview, workspaceFiles, workspacePreview, type OfficePreview } from "./preview.ts";

const SID = /^[0-9a-f]{32}$/u;
export const FILES_HTTP_ROUTES = Object.freeze([
  "GET /api/system",
  "GET /api/directory",
  "POST /api/directory",
  "GET /api/sessions/:id/files",
  "GET /api/sessions/:id/file",
]);

export interface LoadedSession { id: string; root: string }
export interface FilesHttpOptions extends DirectoryHttpOptions {
  enabled?: (id: string) => boolean;
  /** `None` (and `OSError` / `ValueError` from `store.load`) is 404. */
  loadSession?: (sid: string) => Promise<LoadedSession | null> | LoadedSession | null;
  store?: { load(sid: string): Promise<LoadedSession> };
  officePreview?: OfficePreview;
}

type Reply = DirectoryReply;

function verbOf(method: string): string {
  return typeof method === "string" ? method.toUpperCase() : "";
}

/** True only for routes this plugin answers. Unsupported verbs are not owned. */
export function ownsFilesRoute(method: string, parts: readonly string[]): boolean {
  const verb = verbOf(method);
  if (parts[0] !== "api") return false;
  if (parts.length === 2 && parts[1] === "system") return verb === "GET";
  if (parts.length === 2 && parts[1] === "directory") return verb === "GET" || verb === "POST";
  return verb === "GET" && parts.length === 4 && parts[1] === "sessions" && SID.test(parts[2] ?? "") && (parts[3] === "files" || parts[3] === "file");
}

function disabled(): Reply {
  return [403, { error: "plugin disabled or dependency unavailable: files", plugin: "files" }];
}

function queryFirst(query: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!query || typeof query !== "object" || !Object.hasOwn(query, key)) return null;
  const value = query[key];
  return Array.isArray(value) ? value.length ? value[0] : null : value;
}

function previewFailure(error: unknown): Reply {
  // PermissionError is an OSError; it must win so a jail miss is not "cannot preview".
  if (pyExceptionName(error) === "PermissionError") return [400, { error: "path outside workspace" }];
  if (isPyOSError(error) || isPyValueError(error)) return [400, { error: "cannot preview file" }];
  throw error;
}

export function createFilesHttp(options: FilesHttpOptions = {}) {
  const enabled = options.enabled ?? (() => true);
  const owns = (method: string, parts: readonly string[]): boolean => ownsFilesRoute(method, parts);

  async function load(sid: string): Promise<LoadedSession | null> {
    if (!options.loadSession && !options.store) throw new Error("files HTTP has no session loader");
    try {
      const session = options.loadSession ? await options.loadSession(sid) : await options.store!.load(sid);
      return session ?? null;
    } catch (error) {
      if (isPyOSError(error) || isPyValueError(error)) return null;
      throw error;
    }
  }

  async function sessionRoute(parts: readonly string[], query: Record<string, unknown> | null): Promise<Reply> {
    const session = await load(parts[2]!);
    if (!session) return [404, { error: "session not found" }];
    if (parts[3] === "files") {
      try { return [200, { id: session.id, ...workspaceFiles(session.root) }]; } catch (error) {
        if (isPyOSError(error) || isPyValueError(error)) return [400, { error: "cannot list workspace" }];
        throw error;
      }
    }
    const relative = queryFirst(query, "path");
    const path = typeof relative === "string" ? relative : "";
    try {
      const preview = previewSuffix(path) in BINARY_PREVIEW_SUFFIXES
        ? workspaceBinaryPreview(session.root, path, options.officePreview)
        : workspacePreview(session.root, path);
      return [200, { id: session.id, ...preview }];
    } catch (error) {
      return previewFailure(error);
    }
  }

  return {
    routes: FILES_HTTP_ROUTES,
    owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown> | null = null, data: unknown = null): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!enabled("files")) return disabled();
      if (parts[1] === "sessions") return sessionRoute(parts, query);
      return dispatchDirectory(method, parts, query, data, options);
    },
  };
}
