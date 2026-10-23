/** `GET /api/usage`. Anything else stays unowned so Python still sees it. */
import { buildUsage, type UsageStore } from "./build.ts";

export const USAGE_ROUTES = ["GET /api/usage"] as const;

export interface UsageHttpOptions {
  enabled: boolean | ((id: string) => boolean);
  store: UsageStore;
  now?: () => number;
}

const on = (enabled: UsageHttpOptions["enabled"], id: string): boolean => typeof enabled === "function" ? enabled(id) : enabled;
const disabled = (): [number, { error: string; plugin: string }] => [403, { error: "plugin disabled or dependency unavailable: usage", plugin: "usage" }];

export function createUsageHttp(options: UsageHttpOptions) {
  return {
    routes: USAGE_ROUTES,
    owns: (method: string, parts: readonly string[]): boolean => method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "usage",
    async dispatch(method: string, parts: readonly string[], query: Record<string, string[]>): Promise<[number, unknown] | null> {
      if (method !== "GET" || parts.length !== 2 || parts[0] !== "api" || parts[1] !== "usage") return null;
      if (!on(options.enabled, "usage")) return disabled();
      const range = query.range;
      return [200, await buildUsage({ store: options.store }, Array.isArray(range) ? range[0] : undefined, options.now?.())];
    },
  };
}
