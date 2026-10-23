/**
 * GET/POST /api/sessions/<id>/elicitation (Python `elicitation.dispatch`).
 * Other session paths, including tasks and workflows, stay unowned.
 */
import { isDict } from "@xueness/contracts";
import { deleteElicitationPublic, pendingPublic, resolveElicitation } from "./elicitation-protocol.ts";

export interface ElicitationHttpOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
const SESSION = /^[0-9a-f]{32}$/;
const MAX_WAIT = 20_000;
const watchers = new Map<string, number>();

function waitMs(query: Query): number {
  const raw = query.wait;
  if (raw === undefined) return 0;
  if (raw.length !== 1) throw new Error("invalid elicitation wait");
  const value = raw[0] ?? "";
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > MAX_WAIT) throw new Error("invalid elicitation wait");
  return Number(value);
}

function unavailable(enabled: (id: string) => boolean): string | null {
  if (!enabled("mcp")) return "mcp";
  if (!enabled("sessions")) return "sessions";
  return null;
}

function disabled(plugin: string): Reply {
  return [403, { error: `plugin disabled or dependency unavailable: ${plugin}`, plugin }];
}

function watcherKey(stateDir: string | null, sessionId: string): string {
  return `${stateDir ?? ""}\0${sessionId}`;
}

function acquire(stateDir: string | null, sessionId: string): string | null {
  const key = watcherKey(stateDir, sessionId);
  const total = [...watchers.values()].reduce((sum, count) => sum + count, 0);
  const count = watchers.get(key) ?? 0;
  if (total >= 32 || count >= 2) return null;
  watchers.set(key, count + 1);
  return key;
}

function release(key: string): void {
  const count = watchers.get(key) ?? 0;
  if (count <= 1) watchers.delete(key);
  else watchers.set(key, count - 1);
}

async function waitFor(stateDir: string | null, sessionId: string, ms: number, enabled: (id: string) => boolean): Promise<Reply | RowWait> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const plugin = unavailable(enabled);
    if (plugin) return disabled(plugin);
    const found = pendingPublic(sessionId, stateDir);
    if (found) return { pending: found };
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
  const plugin = unavailable(enabled);
  if (plugin) return disabled(plugin);
  return { pending: pendingPublic(sessionId, stateDir) };
}

type RowWait = { pending: Record<string, unknown> | null };

export function createElicitationHttp(o: ElicitationHttpOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "elicitation";
  return {
    routes: ["GET /api/sessions/:id/elicitation", "POST /api/sessions/:id/elicitation"],
    owns,
    async dispatch(method: string, parts: string[], query: Query, data: unknown): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!SESSION.test(parts[2] ?? "")) return [404, { error: "session not found" }];
      const verb = method.toUpperCase();
      if (verb === "GET") {
        let ms = 0;
        try { ms = waitMs(query); } catch (error) { return [400, { error: error instanceof Error ? error.message : "invalid elicitation wait" }]; }
        if (ms) {
          const plugin = unavailable(o.enabled);
          if (plugin) return disabled(plugin);
        }
        let pub = pendingPublic(parts[2]!, o.stateDir);
        if (!pub && ms) {
          const watcher = acquire(o.stateDir, parts[2]!);
          if (watcher) {
            try {
              const waited = await waitFor(o.stateDir, parts[2]!, ms, o.enabled);
              if (Array.isArray(waited)) return waited;
              pub = waited.pending;
            } finally { release(watcher); }
          } else pub = pendingPublic(parts[2]!, o.stateDir);
        }
        if (!pub) deleteElicitationPublic(o.stateDir, parts[2]!);
        return [200, { pending: pub }];
      }
      if (verb !== "POST") return [405, { error: "method not allowed" }];
      if (!isDict(data)) return [400, { error: "invalid elicitation response" }];
      const outcome = resolveElicitation(parts[2]!, data.id, data.action, data.content, o.stateDir);
      if (outcome === "ok") return [200, { ok: true, action: data.action }];
      if (outcome === "missing") return [409, { error: "no elicitation is waiting" }];
      if (outcome === "mismatch") return [409, { error: "elicitation request mismatch" }];
      const body: Record<string, unknown> = { error: "invalid elicitation content", code: outcome[1] };
      if (typeof outcome[2] === "string") body.field = outcome[2];
      return [400, body];
    },
  };
}
