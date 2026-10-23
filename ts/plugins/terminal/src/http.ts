/** `/api/terminals`. A session that carries `remote_connection` never opens a local terminal. */
import { isDict, isPyIntValue } from "@xueness/contracts";
import { Broker } from "./broker.ts";
import { availableShells, resolveShell } from "./shells.ts";

export const TERMINAL_ROUTES = ["GET /api/terminals", "POST /api/terminals", "GET /api/terminals/shells"] as const;

export interface TerminalHttpOptions {
  enabled: boolean | ((id: string) => boolean);
  store: { load(sid: string): unknown };
  allowedRoot: (root: string) => string;
  defaultShell?: () => unknown;
  broker?: Broker;
}

function bad(error: unknown): boolean {
  return error instanceof Error && (error.name === "ValueError" || error.name === "TypeError" || "code" in error);
}

export function createTerminalHttp(options: TerminalHttpOptions) {
  const broker = options.broker ?? new Broker();
  const enabled = (): boolean => typeof options.enabled === "function" ? options.enabled("terminal") : options.enabled;
  const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "terminals";
  return {
    routes: TERMINAL_ROUTES,
    broker,
    owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: unknown): Promise<[number, unknown] | null> {
      if (!owns(method, parts)) return null;
      if (!enabled()) return [403, { error: "plugin disabled or dependency unavailable: terminal", plugin: "terminal" }];
      try {
        if (parts.length === 3 && parts[2] === "shells" && method === "GET") return [200, { shells: availableShells() }];
        if (parts.length === 2 && method === "POST") {
          if (!isDict(data) || data.open !== true) {
            const error = new Error("explicit shell opening is required");
            error.name = "ValueError";
            throw error;
          }
          const session = await Promise.resolve(options.store.load(String(data.session_id)));
          if (!isDict(session)) throw Object.assign(new Error("session"), { name: "ValueError" });
          if (Object.hasOwn(session, "remote_connection")) return [409, { error: "remote terminals require a scoped remote adapter", error_code: "remote_terminal_unavailable" }];
          const root = options.allowedRoot(String(session.root));
          const term = broker.open(root, String(session.id), resolveShell(options.defaultShell?.()));
          return [200, { id: term.id, session_id: session.id }];
        }
        if (parts.length === 2 && method === "GET") return [200, { terminals: broker.list().map((item) => ({ id: item.id, session_id: item.sessionId, closed: item.closed })) }];
        const term = parts.length >= 3 ? broker.get(String(parts[2])) : undefined;
        if (!term) return [404, { error: "terminal not found" }];
        if (method === "GET" && parts.length === 3) {
          const raw = Object.hasOwn(query, "cursor") ? query.cursor?.[0] : "0";
          if (raw === undefined || !/^\d+$/.test(raw)) {
            const error = new Error("invalid cursor");
            error.name = "ValueError";
            throw error;
          }
          const cursor = Number(raw);
          if (!isPyIntValue(cursor) || cursor < 0) throw Object.assign(new Error("invalid cursor"), { name: "ValueError" });
          return [200, term.read(cursor)];
        }
        if (method === "POST" && parts.length === 4) {
          if (!isDict(data)) throw Object.assign(new Error("body"), { name: "TypeError" });
          if (parts[3] === "input") term.write(data.text);
          else if (parts[3] === "resize") term.resize(data.cols, data.rows);
          else if (parts[3] === "close") term.close();
          else return [404, { error: "terminal operation not found" }];
          return [200, { ok: true }];
        }
        return [405, { error: "method not allowed" }];
      } catch (error) {
        if (bad(error)) return [400, { error: "invalid terminal operation or unavailable workspace" }];
        throw error;
      }
    },
  };
}
