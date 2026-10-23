/**
 * MCP resource store only (Python `resources.dispatch` for kind `mcp`).
 * OAuth and `/api/mcp/check` are a separate handler. Elicitation, catalogs
 * and `/api/workflows` stay unowned here.
 */
import { realish, resourceDispatch } from "@xueness/sessions";

export interface McpResourcesHttpOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
export const MCP_RESOURCE_ROUTES = ["GET /api/resources/mcp", "POST /api/resources/mcp", "PUT /api/resources/mcp", "PATCH /api/resources/mcp/:id", "DELETE /api/resources/mcp/:id"];
const verb = (method: string): string => method.toUpperCase();

export function createMcpResourcesHttp(o: McpResourcesHttpOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "mcp"
    && (p.length === 3 && ["GET", "POST", "PUT"].includes(verb(method)) || p.length === 4 && ["PATCH", "DELETE"].includes(verb(method)));
  return {
    routes: MCP_RESOURCE_ROUTES,
    owns,
    /** Stored server documents keep Python's exact numbers. */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p),
    dispatch(method: string, p: string[], _query: Query, data: unknown): Reply | null {
      if (!owns(method, p)) return null;
      if (!o.enabled("mcp")) return [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }];
      if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
