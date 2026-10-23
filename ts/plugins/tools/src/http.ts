/** `GET /api/tools/call-budget`. Every other tools path stays unowned. */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isDict } from "@xueness/contracts";
import { projectSession } from "./budget.ts";
import { bindPluginEnabled } from "./flags.ts";

export const TOOLS_ROUTES = ["GET /api/tools/call-budget"] as const;
const PATH = ["api", "tools", "call-budget"] as const;

export interface ToolsStore {
  pathFor?(sid: string): string;
  _path?(sid: string): string;
  load(sid: string): unknown;
}

export interface ToolsHttpOptions {
  stateDir: string;
  enabled: boolean | ((id: string) => boolean);
  store: ToolsStore | null;
  allowedRoots?: () => readonly string[];
}

function samePath(root: string, allowed: string): boolean {
  const rel = relative(resolve(allowed), root);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createToolsHttp(options: ToolsHttpOptions) {
  bindPluginEnabled((id) => id === "tools" ? (typeof options.enabled === "function" ? options.enabled(id) : options.enabled) : true);
  const enabled = (): boolean => typeof options.enabled === "function" ? options.enabled("tools") : options.enabled;
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === PATH.length && PATH.every((part, index) => parts[index] === part);
  return {
    routes: TOOLS_ROUTES,
    owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, string[]>): Promise<[number, unknown] | null> {
      if (!owns(method, parts)) return null;
      if (!enabled()) return [403, { error: "plugin disabled or dependency unavailable: tools", plugin: "tools" }];
      if (method !== "GET") return [405, { error: "method not allowed" }];
      const values = query.session;
      if (Array.isArray(values) && values.length !== 1) return [400, { error: "expected one session id" }];
      const sid = Array.isArray(values) ? values[0] : undefined;
      if (typeof sid !== "string" || !options.store) return [400, { error: "session id is required" }];
      let session: unknown;
      try {
        options.store._path?.(sid);
        options.store.pathFor?.(sid);
        session = await Promise.resolve(options.store.load(sid));
      } catch { return [404, { error: "session not found" }]; }
      try {
        const root = realpathSync(resolve(String(isDict(session) ? session.root : "")));
        const allowed = options.allowedRoots?.() ?? [];
        if (!allowed.some((item) => samePath(root, item))) return [404, { error: "session not found" }];
      } catch { return [404, { error: "session not found" }]; }
      try { return [200, projectSession(options.stateDir, session)]; }
      catch { return [503, { error: "tool call budget status unavailable" }]; }
    },
  };
}
