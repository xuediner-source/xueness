/**
 * Subagent resource store only (Python `resources.dispatch` for kind
 * `subagents`). `/api/sessions/<id>/tasks` is `createSubagentTasksHttp`.
 */
import { realish, resourceDispatch } from "@xueness/sessions";

export interface SubagentsResourcesHttpOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
export const SUBAGENTS_RESOURCE_ROUTES = ["GET /api/resources/subagents", "POST /api/resources/subagents", "PUT /api/resources/subagents", "PATCH /api/resources/subagents/:id", "DELETE /api/resources/subagents/:id"];
const verb = (method: string): string => method.toUpperCase();

export function createSubagentsResourcesHttp(o: SubagentsResourcesHttpOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "subagents"
    && (p.length === 3 && ["GET", "POST", "PUT"].includes(verb(method)) || p.length === 4 && ["PATCH", "DELETE"].includes(verb(method)));
  return {
    routes: SUBAGENTS_RESOURCE_ROUTES,
    owns,
    /** Stored definition documents keep Python's exact numbers. */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p),
    dispatch(method: string, p: string[], _query: Query, data: unknown): Reply | null {
      if (!owns(method, p)) return null;
      if (!o.enabled("subagents")) return [403, { error: "plugin disabled or dependency unavailable: subagents", plugin: "subagents" }];
      if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
