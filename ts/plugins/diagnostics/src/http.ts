/** `/api/diagnostics`. The whole prefix is owned. Cleanup never touches sessions. */
import { isDict, isPyIntValue } from "@xueness/contracts";
import { removeSettledLogs } from "./cleanup.ts";
import { runtimeSnapshot } from "./metrics.ts";
import { diagnosticReport, type CatalogRow } from "./report.ts";

export const DIAGNOSTICS_ROUTES = ["GET /api/diagnostics", "GET /api/diagnostics/runtime", "POST /api/diagnostics/cleanup"] as const;

export interface DiagnosticsHttpOptions {
  stateDir: string;
  enabled: boolean | ((id: string) => boolean);
  store: { list(): unknown };
  catalog?: () => readonly CatalogRow[];
  now?: () => number;
}

const on = (enabled: DiagnosticsHttpOptions["enabled"]): boolean => typeof enabled === "function" ? enabled("diagnostics") : enabled;
const disabled = (): [number, { error: string; plugin: string }] => [403, { error: "plugin disabled or dependency unavailable: diagnostics", plugin: "diagnostics" }];
const method = (): [number, { error: string }] => [405, { error: "method not allowed" }];

function prefix(parts: readonly string[]): boolean {
  return parts[0] === "api" && parts[1] === "diagnostics";
}

export function createDiagnosticsHttp(options: DiagnosticsHttpOptions) {
  return {
    routes: DIAGNOSTICS_ROUTES,
    owns: (_method: string, parts: readonly string[]): boolean => prefix(parts),
    async dispatch(methodName: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): Promise<[number, unknown] | null> {
      if (!prefix(parts)) return null;
      if (!on(options.enabled)) return disabled();
      if (parts.length === 3 && parts[2] === "runtime") {
        if (methodName !== "GET") return method();
        return [200, runtimeSnapshot(options.stateDir)];
      }
      if (methodName === "GET" && (parts.length === 2 || (parts.length === 3 && (parts[2] === "export" || parts[2] === "storage")))) {
        return [200, await diagnosticReport(options)];
      }
      if (methodName === "POST" && parts.length === 3 && parts[2] === "cleanup") {
        if (data == null || typeof data !== "object") {
          const error = new Error("attribute");
          error.name = "AttributeError";
          throw error;
        }
        const days = isDict(data) ? data.olderThanDays : undefined;
        if (!isDict(data) || data.confirmed !== true || !isPyIntValue(days) || typeof days !== "number" || days < 1 || days > 3650) {
          return [400, { error: "confirmed cutoff required" }];
        }
        return [200, { removedLogs: await removeSettledLogs(options.stateDir, days, options.now?.()) }];
      }
      return method();
    },
  };
}
