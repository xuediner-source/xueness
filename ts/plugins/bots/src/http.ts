/** `/api/bots` (Python `bots/plugin.py` dispatch). Every refusal is the same generic 400. */
import { isPyOSError, isPyValueError, type FileLockProvider, type SessionStore } from "@xueness/sessions";
import { ChannelNotFound, poll, reply } from "./inbox.ts";
import { loadState, saveChannel } from "./store.ts";
import type { BotTransport } from "./telegram.ts";

export const BOTS_ROUTES = ["GET /api/bots", "POST /api/bots", "POST /api/bots/<id>/poll", "POST /api/bots/<id>/reply"] as const;

export interface BotsHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
  store: SessionStore;
  /** `ctx['create_roots']`: a channel workspace must sit inside one of these when any are declared. */
  createRoots?: () => readonly string[];
  env?: NodeJS.ProcessEnv;
  transport?: BotTransport;
  locks?: FileLockProvider;
}

const refusal = (error: unknown): boolean => isPyValueError(error) || isPyOSError(error) || error instanceof ChannelNotFound || !!(error as NodeJS.ErrnoException | null)?.code
  || error instanceof Error && ["KeyError", "JSONDecodeError", "PyJsonDecodeError", "UnicodeDecodeError", "PermissionError"].includes(error.name);

export function createBotsHttp(options: BotsHttpOptions) {
  const inbox = { stateDir: options.stateDir, store: options.store, ...options.env ? { env: options.env } : {}, ...options.transport ? { transport: options.transport } : {}, ...options.locks ? { locks: options.locks } : {} };
  return {
    routes: BOTS_ROUTES,
    owns: (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "bots",
    async dispatch(method: string, parts: readonly string[], _query: Record<string, unknown>, data: unknown): Promise<[number, unknown] | null> {
      if (parts[0] !== "api" || parts[1] !== "bots") return null;
      if (!options.enabled("bots")) return [403, { error: "plugin disabled or dependency unavailable: bots", plugin: "bots", code: "plugin_disabled" }];
      try {
        if (parts.length === 2 && method === "GET") return [200, loadState(options.stateDir)];
        if (parts.length === 2 && method === "POST") return [200, { channel: await saveChannel(options.stateDir, data, options.createRoots?.() ?? [], options.locks) }];
        if (parts.length === 4 && method === "POST") {
          if (parts[3] === "poll") return [200, await poll(inbox, parts[2]!)];
          if (parts[3] === "reply") return [200, await reply(inbox, parts[2]!, data)];
        }
        return [405, { error: "method not allowed" }];
      } catch (error) {
        if (refusal(error)) return [400, { error: "invalid channel or bot request failed" }];
        throw error;
      }
    },
  };
}
