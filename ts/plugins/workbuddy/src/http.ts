/** WorkBuddy pool status and plugin-owned account management routes. */
import { WorkbuddyAccountNotFoundError, WorkbuddyCredentialError } from "./accounts.ts";

type Dict = Record<string, unknown>;
type Reply = [number, Dict];

export const WORKBUDDY_ROUTES = [
  "GET /api/workbuddy/status",
  "GET /api/workbuddy/accounts",
  "POST /api/workbuddy/accounts",
  "DELETE /api/workbuddy/accounts/:id",
];

export function ownsWorkbuddyRoute(method: string, parts: readonly string[]): boolean {
  if (parts[0] !== "api" || parts[1] !== "workbuddy") return false;
  if (method === "GET" && parts.length === 3) return parts[2] === "status" || parts[2] === "accounts";
  if (method === "POST" && parts.length === 3) return parts[2] === "accounts";
  return method === "DELETE" && parts.length === 4 && parts[2] === "accounts";
}

export interface WorkbuddyHttpOptions {
  enabled: () => boolean;
  status: () => Promise<Dict | null>;
  accounts: () => Promise<Dict>;
  addAccount: (credentials: unknown) => Promise<Dict>;
  deleteAccount: (id: string) => Promise<Dict>;
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createWorkbuddyHttp(options: WorkbuddyHttpOptions) {
  return {
    routes: WORKBUDDY_ROUTES,
    owns: ownsWorkbuddyRoute,
    async dispatch(method: string, parts: readonly string[], _query: Record<string, unknown> = {}, data: unknown = null): Promise<Reply | null> {
      if (!ownsWorkbuddyRoute(method, parts)) return null;
      if (!options.enabled()) return [403, { error: "plugin disabled or dependency unavailable: workbuddy", plugin: "workbuddy" }];
      if (parts[2] === "status") {
        const value = await options.status();
        if (value === null) return [503, { error: "the WorkBuddy gateway is not answering", plugin: "workbuddy" }];
        return [200, { ok: true, ...value }];
      }
      if (parts[2] === "accounts" && method === "GET") return [200, await options.accounts()];
      try {
        if (parts[2] === "accounts" && method === "POST") {
          if (!isDict(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, "credentials")) {
            return [400, { error: "expected credentials object" }];
          }
          return [200, await options.addAccount(data.credentials)];
        }
        if (parts[2] === "accounts" && method === "DELETE") return [200, await options.deleteAccount(parts[3] ?? "")];
      } catch (error) {
        if (error instanceof WorkbuddyCredentialError) return [400, { error: "invalid WorkBuddy credentials" }];
        if (error instanceof WorkbuddyAccountNotFoundError) return [404, { error: "WorkBuddy account not found" }];
        throw error;
      }
      return [405, { error: "method not allowed" }];
    },
  };
}
