/**
 * Hooks HTTP surface (Python `trust_api.dispatch` plus `resources.dispatch`
 * for kind `hooks`). `GET /api/resources/hooks/trust` is the read-only trust
 * document; other methods on the family are the JSON store. `trust` is not a
 * resource id on GET.
 */
import { isAbsolute, join, relative } from "node:path";
import { realish, resourceDispatch } from "@xueness/sessions";
import { statusDocument } from "./trust.ts";

export interface HooksHttpOptions {
  stateDir: string | null;
  webRuns: string;
  projectDir: string;
  enabled(id: string): boolean;
  /** `workspaces_api.allowed_roots`: operator-declared and remembered workspace roots. */
  allowedRoots(): readonly string[];
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
export const HOOKS_ROUTES = ["GET /api/resources/hooks", "POST /api/resources/hooks", "PUT /api/resources/hooks", "PATCH /api/resources/hooks/:id", "DELETE /api/resources/hooks/:id", "GET /api/resources/hooks/trust"];

/** `parse_qs` drops blank values: the first non-blank one, or "". */
export const queryValue = (query: Query, name: string): string => (Object.hasOwn(query, name) ? query[name] ?? [] : []).find((value) => value !== "") ?? "";

/** `web._allowed_root`: relative roots live under web runs; the target must sit inside a permitted base. */
export function fencedRoot(value: string, o: { webRuns: string; projectDir: string; allowedRoots(): readonly string[] }): string {
  if (value.includes("\0")) throw new Error("embedded null byte");
  const target = realish(isAbsolute(value) ? value : join(realish(o.webRuns), value));
  const roots = [o.webRuns, o.projectDir, ...o.allowedRoots()].map((root) => realish(root));
  if (!roots.some((root) => { const rel = relative(root, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new Error("workspace root not permitted");
  return target;
}

const disabled = (): Reply => [403, { error: "plugin disabled or dependency unavailable: hooks", plugin: "hooks" }];
const verb = (method: string): string => method.toUpperCase();

export function createHooksHttp(o: HooksHttpOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "hooks"
    && (p.length === 4 && p[3] === "trust" && verb(method) === "GET" || p.length === 3 && ["GET", "POST", "PUT"].includes(verb(method)) || p.length === 4 && ["PATCH", "DELETE"].includes(verb(method)));
  const trust = (query: Query): Reply => {
    if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
    const raw = queryValue(query, "root");
    if (!raw) return [400, { error: "root query parameter is required" }];
    let root: string;
    try { root = fencedRoot(raw, o); } catch { return [400, { error: "workspace root not permitted" }]; }
    try {
      const stateDir = realish(o.stateDir);
      return [200, { ...statusDocument(stateDir, root), stateDir }];
    } catch { return [500, { error: "workspace hooks could not be read" }]; }
  };
  return {
    routes: HOOKS_ROUTES,
    owns,
    /** Stored hook documents keep Python's exact numbers. The trust GET does not. */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p) && !(p.length === 4 && p[3] === "trust"),
    dispatch(method: string, p: string[], query: Query, data: unknown): Reply | null {
      if (!owns(method, p)) return null;
      if (!o.enabled("hooks")) return disabled();
      if (p.length === 4 && p[3] === "trust") return trust(query);
      if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
