/** Read-only, bounded binary range API for a session's authorized workspace. */
import { isPyOSError, isPyValueError, pyExceptionName, type Session, type SessionStore } from "@xueness/sessions";
import { NodeWorkspaceFileSystem } from "@xueness/engine-tools";

const SID = /^[0-9a-f]{32}$/u;
export const FILE_BYTES_DEFAULT_LIMIT = 4096;
export const FILE_BYTES_MAX_LIMIT = 65536;

type Row = Record<string, unknown>;
type Reply = [number, unknown];

export interface FileBytesOptions {
  store: Pick<SessionStore, "load">;
  enabled(id: string): boolean;
  validateSession(session: Session): Promise<void> | void;
  stateDir?: string;
}

function queryValue(query: Row | null, key: string): unknown {
  const value = query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function queryInteger(query: Row | null, key: string, fallback: number): number | null {
  const value = queryValue(query, key);
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readError(error: unknown): Reply {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "path_outside_workspace") return [400, { error: "path outside workspace" }];
  if (code === "ENOENT" || isPyOSError(error)) return [404, { error: "file not found" }];
  if (error instanceof TypeError || isPyValueError(error)) return [400, { error: error instanceof Error ? error.message : String(error) }];
  throw error;
}

export function createFileBytesApi(options: FileBytesOptions) {
  const owns = (method: string, parts: readonly string[]): boolean =>
    method.toUpperCase() === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && SID.test(parts[2] ?? "") && parts[3] === "file-bytes";

  return {
    owns,
    routes: ["GET /api/sessions/:id/file-bytes"],
    async dispatch(method: string, parts: string[], query: Row | null = null): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("files") || !options.enabled("sessions")) return [403, { error: "sessions and files must be enabled" }];
      const path = queryValue(query, "path");
      if (typeof path !== "string" || !path) return [400, { error: "path is required" }];
      const offset = queryInteger(query, "offset", 0);
      const limit = queryInteger(query, "limit", FILE_BYTES_DEFAULT_LIMIT);
      if (offset === null || offset < 0) return [400, { error: "offset must be a non-negative safe integer" }];
      if (limit === null || limit < 1 || limit > FILE_BYTES_MAX_LIMIT) return [400, { error: `limit must be between 1 and ${FILE_BYTES_MAX_LIMIT}` }];

      let session: Session;
      try {
        session = await options.store.load(parts[2]!);
      } catch (error) {
        if (isPyOSError(error) || isPyValueError(error)) return [404, { error: "session not found" }];
        throw error;
      }
      try {
        await options.validateSession(session);
      } catch (error) {
        if (isPyOSError(error) || isPyValueError(error)) return [403, { error: "workspace root not permitted" }];
        throw error;
      }
      if (session.remote_connection) return [409, { error: "Remote file bytes are unavailable" }];
      if (typeof session.root !== "string" || !session.root) return [403, { error: "workspace root not permitted" }];

      const fs = new NodeWorkspaceFileSystem({ cwd: session.root, roots: [session.root] });
      try {
        const target = await fs.stat(path);
        if (!target.info) return [404, { error: "file not found" }];
        if (!target.info.isFile()) return [400, { error: "path is not a file" }];
        const range = await fs.readBinaryRange(path, offset, limit, FILE_BYTES_MAX_LIMIT);
        return [200, {
          path: range.path,
          base64: range.bytes.toString("base64"),
          offset: range.offset,
          nextOffset: range.nextOffset,
          totalBytes: range.totalBytes,
          hash: range.sha256,
        }];
      } catch (error) {
        if (pyExceptionName(error) === "PermissionError") return [400, { error: "path outside workspace" }];
        return readError(error);
      }
    },
  };
}
