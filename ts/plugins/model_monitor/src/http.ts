/** `/api/model_monitor`. The kernel 403 is reproduced here because the front door does not emit it. */
import { isDict, numericValue } from "@xueness/contracts";
import { clearObservations, readObservations } from "./records.ts";

export const MODEL_MONITOR_ROUTES = ["GET /api/model_monitor", "POST /api/model_monitor/clear"] as const;
const SESSION = /^[0-9a-f]{32}$/;

export interface ModelMonitorHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
}

const disabled = (): [number, { error: string; plugin: string }] => [403, { error: "plugin disabled or dependency unavailable: model_monitor", plugin: "model_monitor" }];
const unavailable = (): [number, { error: string }] => [400, { error: "model monitoring records unavailable" }];

/** Python `{confirmed: True}` uses `==`, so `1` and `1.0` also pass. */
function confirmed(data: unknown): boolean {
  if (!isDict(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, "confirmed")) return false;
  const value = data.confirmed;
  return value === true || (typeof value === "number" && value === 1) || numericValue(value) === 1 && typeof value !== "boolean";
}

export function createModelMonitorHttp(options: ModelMonitorHttpOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "model_monitor";
  return {
    routes: MODEL_MONITOR_ROUTES,
    owns,
    dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: unknown): [number, unknown] | null {
      if (!owns(method, parts)) return null;
      if (!options.enabled("model_monitor")) return disabled();
      try {
        if (method === "GET" && parts.length === 2) {
          const sessionId = Object.hasOwn(query, "session_id") ? query.session_id?.[0] : undefined;
          if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION.test(sessionId))) return [400, { error: "invalid session id" }];
          return [200, { observations: readObservations(options.stateDir, sessionId) }];
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "clear") {
          if (!confirmed(data)) return [400, { error: "confirm clearing local monitoring records" }];
          clearObservations(options.stateDir);
          return [200, { cleared: true, observations: [] }];
        }
        return [405, { error: "method not allowed" }];
      } catch (error) {
        if (error instanceof Error && (error.name === "ValueError" || error.name === "SyntaxError" || (error as NodeJS.ErrnoException).code)) return unavailable();
        if (error instanceof SyntaxError) return unavailable();
        return unavailable();
      }
    },
  };
}
