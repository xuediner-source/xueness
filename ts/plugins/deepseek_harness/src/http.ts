/**
 * `/api/deepseek_harness`: the imported harness library (H01.07). The whole
 * prefix is owned; every route answers `disabled` while the plugin is off.
 *
 *   GET  /api/deepseek_harness           library rows, verify report, limits
 *   POST /api/deepseek_harness/preview   { manifest, files?, fileName? } → what importing would do
 *   POST /api/deepseek_harness/import    { manifest, files?, fileName?, replace? }
 *   POST /api/deepseek_harness/remove    { id }
 *
 * Bodies carry text the person picked locally; the server never fetches a
 * package, and nothing from one is executed. Validation results, refusals
 * included, answer 200 with `ok`; 403/404/405 are for the route itself.
 */
import { importPackage, listLibrary, previewImport, removePackage } from "./library.ts";

export const HARNESS_ROUTES = ["GET /api/deepseek_harness", "POST /api/deepseek_harness/preview", "POST /api/deepseek_harness/import", "POST /api/deepseek_harness/remove"] as const;

export interface HarnessHttpOptions {
  stateDir: string;
  enabled: (id: string) => boolean;
  now?: () => string;
}

type Reply = [number, unknown];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const prefix = (parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "deepseek_harness";

export function createHarnessHttp(options: HarnessHttpOptions) {
  return {
    routes: HARNESS_ROUTES,
    owns: (_method: string, parts: readonly string[]): boolean => prefix(parts),
    dispatch(method: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): Reply | null {
      if (!prefix(parts)) return null;
      if (!options.enabled("deepseek_harness")) return [403, { error: "plugin disabled or dependency unavailable: deepseek_harness", plugin: "deepseek_harness" }];
      if (parts.length === 2) return method === "GET" ? [200, listLibrary(options.stateDir)] : [405, { error: "method not allowed" }];
      if (parts.length !== 3 || method !== "POST") return [405, { error: "method not allowed" }];
      const body = isObject(data) ? data : {};
      const action = parts[2];
      const result = action === "preview" ? previewImport(options.stateDir, body)
        : action === "import" ? importPackage(options.stateDir, body, options.now)
        : action === "remove" ? removePackage(options.stateDir, body.id)
        : null;
      if (result === null) return [404, { error: "harness operation not found" }];
      // A refused import is an answer, not a transport failure: `ok: false` keeps its
      // code and issues (the front door replaces 4xx bodies with a generic envelope).
      return [200, result];
    },
  };
}
