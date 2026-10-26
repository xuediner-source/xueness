/**
 * GET/POST /api/sessions/<id>/mcp-apps — the Apps UI host bridge. GET returns
 * the connection snapshot (optionally long-waited); POST carries app frame
 * events (ready / closed / open_ui / tool_context), each re-checked against
 * the connection generation so a stale frame cannot reuse a new session.
 */
import { isDict } from "@xueness/contracts";
import { appsDisconnect, appsReady, appsSnapshot, appsToolContext, openAppsResource, type AppsGuard } from "./apps-protocol.ts";
import type { Row } from "./names.ts";

export interface AppsHttpOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
const SESSION = /^[0-9a-f]{32}$/;
const MAX_WAIT = 20_000;
const BRIDGE_TYPES = new Set(["app_ready", "app_closed", "open_ui", "tool_context"]);

function waitMs(query: Query): number {
  const raw = query.wait;
  if (raw === undefined) return 0;
  if (raw.length !== 1) throw new Error("invalid apps wait");
  const value = raw[0] ?? "";
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > MAX_WAIT) throw new Error("invalid apps wait");
  return Number(value);
}

function serverOf(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  return [...value].every((char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) < 127) ? value : null;
}

function guardOf(data: Row): AppsGuard | null {
  const connectionId = data.connectionId;
  const generation = data.generation;
  if (typeof connectionId !== "string" || !connectionId || connectionId.length > 128) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 2 ** 31) return null;
  return { connectionId, generation };
}

function unavailable(enabled: (id: string) => boolean): string | null {
  if (!enabled("mcp")) return "mcp";
  if (!enabled("sessions")) return "sessions";
  return null;
}

const disabled = (plugin: string): Reply => [403, { error: `plugin disabled or dependency unavailable: ${plugin}`, plugin }];

async function waitForSnapshot(stateDir: string | null, sessionId: string, serverId: string, ms: number, enabled: (id: string) => boolean): Promise<Reply | { snapshot: ReturnType<typeof appsSnapshot> }> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const plugin = unavailable(enabled);
    if (plugin) return disabled(plugin);
    const snapshot = appsSnapshot(stateDir, sessionId, serverId);
    if (snapshot && snapshot.status !== "connecting") return { snapshot };
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
  const plugin = unavailable(enabled);
  if (plugin) return disabled(plugin);
  return { snapshot: appsSnapshot(stateDir, sessionId, serverId) };
}

export function createAppsHttp(o: AppsHttpOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "mcp-apps";
  return {
    routes: ["GET /api/sessions/:id/mcp-apps", "POST /api/sessions/:id/mcp-apps"],
    owns,
    async dispatch(method: string, parts: string[], query: Query, data: unknown): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      const sessionId = parts[2] ?? "";
      if (!SESSION.test(sessionId)) return [404, { error: "session not found" }];
      const verb = method.toUpperCase();
      const serverRaw = query.server;
      if (verb === "GET") {
        if (serverRaw === undefined || serverRaw.length !== 1) return [400, { error: "invalid apps server" }];
        const serverId = serverOf(serverRaw[0]);
        if (!serverId) return [400, { error: "invalid apps server" }];
        let ms = 0;
        try { ms = waitMs(query); } catch (error) { return [400, { error: error instanceof Error ? error.message : "invalid apps wait" }]; }
        const plugin = unavailable(o.enabled);
        if (plugin) return disabled(plugin);
        let snapshot = appsSnapshot(o.stateDir, sessionId, serverId);
        if (ms && snapshot?.status === "connecting") {
          const waited = await waitForSnapshot(o.stateDir, sessionId, serverId, ms, o.enabled);
          if (Array.isArray(waited)) return waited;
          snapshot = waited.snapshot;
        }
        return [200, { connection: snapshot }];
      }
      if (verb !== "POST") return [405, { error: "method not allowed" }];
      // Ownership gates every verb: a disabled plugin must not accept bridge state changes.
      const plugin = unavailable(o.enabled);
      if (plugin) return disabled(plugin);
      if (!isDict(data)) return [400, { error: "invalid apps bridge request" }];
      const type = data.type;
      const serverId = serverOf(data.server);
      if (typeof type !== "string" || !BRIDGE_TYPES.has(type) || !serverId) return [400, { error: "invalid apps bridge request" }];
      if (type === "app_closed") {
        const connectionId = data.connectionId;
        appsDisconnect(o.stateDir, sessionId, serverId, typeof connectionId === "string" && connectionId ? connectionId : undefined);
        return [200, { ok: true }];
      }
      const guard = guardOf(data);
      if (!guard) return [400, { error: "invalid apps bridge guard" }];
      if (type === "app_ready") {
        const result = appsReady(o.stateDir, sessionId, serverId, guard);
        return result.ok ? [200, { ok: true, connection: result.snapshot }] : [409, { error: "app connection is stale", reason: result.reason }];
      }
      if (type === "open_ui") {
        const opened = openAppsResource(o.stateDir, sessionId, data.uri, guard);
        if (opened.ok) return [200, { manifest: opened.manifest }];
        if (opened.reason === "invalid_uri") return [400, { error: "invalid apps ui uri" }];
        if (opened.reason === "no_connection") return [404, { error: "no app connection" }];
        return [409, { error: "app connection is stale", reason: opened.reason }];
      }
      const context = appsToolContext(o.stateDir, sessionId, serverId, guard);
      return context.ok ? [200, { context: context.context }] : [409, { error: "app connection is stale", reason: context.reason }];
    },
  };
}
