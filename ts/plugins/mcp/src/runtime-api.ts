/** Read-only view of the current run's connection metadata, without opening a server. */
import { isPyOSError, isPyValueError, type Session, type SessionStore } from "@xueness/sessions";

export interface McpRuntimeApiOptions {
  store: Pick<SessionStore, "load">;
  enabled(id: string): boolean;
  validateSession(session: Session): Promise<void>;
  snapshot(sessionId: string): unknown;
}

export function createMcpRuntimeApi(options: McpRuntimeApiOptions) {
  const owns = (_method: string, parts: readonly string[]) => parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && /^[0-9a-f]{32}$/.test(parts[2] ?? "") && parts[3] === "mcp-runtime";
  return {
    owns, routes: ["GET /api/sessions/:id/mcp-runtime"],
    async dispatch(method: string, parts: string[]): Promise<[number, unknown] | null> {
      if (!owns(method, parts)) return null;
      if (method !== "GET") return [405, { error: "method not allowed" }];
      if (!options.enabled("mcp") || !options.enabled("sessions")) return [403, { error: "mcp and sessions must be enabled" }];
      try {
        const session = await options.store.load(parts[2]!);
        await options.validateSession(session);
        return [200, await options.snapshot(String(session.id)) ?? { servers: [], active: false }];
      } catch (error) {
        if (isPyValueError(error)) return [403, { error: "workspace not permitted" }];
        if (isPyOSError(error)) return [404, { error: "session not found" }];
        throw error;
      }
    },
  };
}
