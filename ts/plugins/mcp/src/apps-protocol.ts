/**
 * MCP Apps UI host (C-ADJ-03). Servers that opt in (`apps: true`) may register an
 * app view: a `ui://` resource descriptor plus app-provided tool names. The host
 * tracks one connection per session+server with a monotonically increasing
 * generation: every reconnect invalidates earlier generations, so an app frame
 * left over from a dropped connection can never reach into the new session.
 */
import { isDict } from "@xueness/contracts";
import { resolve } from "node:path";
import type { Row } from "./names.ts";

export const APPS_CAPABILITY = "apps";
export const APPS_WAIT_MS = 10_000;
const MAX_NAME = 64;
const MAX_TOOLS = 64;
const SESSION = /^[0-9a-f]{32}$/;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRINTABLE = (value: string): boolean => [...value].every((char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) < 127);

export type AppsConnectionStatus = "connecting" | "connected" | "closed";
export interface AppsUiResource { uri: string; iframeUrl: string | null; version: string | null }
export interface AppsConnectionSnapshot {
  serverId: string; connectionId: string; generation: number; appId: string; appName: string;
  status: AppsConnectionStatus; connectedAt: number | null; uiResource: string | null; iframeUrl: string | null; tools: string[];
}
export interface AppsGuard { connectionId: string; generation: number }
export type AppsWaitResult = { ok: true; snapshot: AppsConnectionSnapshot } | { ok: false; reason: "no_connection" | "stale" | "closed" | "timeout" };

interface AppsEntry extends AppsConnectionSnapshot {
  resource: AppsUiResource | null;
  waiters: Set<() => void>;
}

const registry = new Map<string, AppsEntry>();

export function appsEnabled(server: unknown): boolean {
  return isDict(server) && server.apps === true;
}

export function appsClientCapabilities(server: unknown): Row {
  return appsEnabled(server) ? { [APPS_CAPABILITY]: {} } : {};
}

/** `ui://<app>[/path]`: printable, bounded, no whitespace. */
export function isAppsUiUri(uri: unknown): boolean {
  if (typeof uri !== "string" || !uri.startsWith("ui://")) return false;
  const rest = uri.slice(5);
  return !!rest && rest.length <= 200 && PRINTABLE(rest);
}

function stateKey(stateDir: string | null): string {
  if (stateDir === null) return "";
  try {
    const abs = resolve(stateDir);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  } catch { return String(stateDir); }
}

function entryKey(stateDir: string | null, sessionId: string, serverId: string): string {
  return `${stateKey(stateDir)}\0${sessionId}\0${serverId}`;
}

function sessionContext(server: Row): { sessionId: string; stateDir: string | null } | null {
  const session = server._elicitation_session;
  const stateDir = typeof server._state_dir === "string" ? server._state_dir : null;
  if (!isDict(session) || typeof session.id !== "string" || !SESSION.test(session.id) || stateDir === null) return null;
  return { sessionId: session.id, stateDir };
}

function snapshotOf(entry: AppsEntry): AppsConnectionSnapshot {
  return {
    serverId: entry.serverId, connectionId: entry.connectionId, generation: entry.generation,
    appId: entry.appId, appName: entry.appName, status: entry.status, connectedAt: entry.connectedAt,
    uiResource: entry.uiResource, iframeUrl: entry.iframeUrl, tools: [...entry.tools],
  };
}

function wakeAll(entry: AppsEntry): void {
  for (const wake of [...entry.waiters]) { entry.waiters.delete(wake); try { wake(); } catch { /* wake failures are isolated */ } }
}

function guardOk(entry: AppsEntry, guard: AppsGuard): boolean {
  return entry.connectionId === guard.connectionId && entry.generation === guard.generation;
}

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > limit) return null;
  const cleaned = [...value].filter((char) => char >= " " && char !== "\u007f").join("").trim();
  return cleaned.slice(0, limit) || null;
}

/** `https:` app frames only; a loopback `http:` origin stays allowed for local apps. */
function frameUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2048 || !PRINTABLE(value)) return null;
  if (value.startsWith("https://")) return value;
  const match = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[/:]|$)/.exec(value);
  return match ? value : null;
}

export interface AppsConnectParams { appId: string; appName: string; iframeUrl: string | null; resource: AppsUiResource | null; tools: string[] }

/** Validate an `apps/connect` payload. `[params, null]` or `[null, code]`. */
export function validateAppsConnect(params: unknown): [AppsConnectParams | null, string | null] {
  if (!isDict(params)) return [null, "invalid_params"];
  const appId = params.appId;
  if (typeof appId !== "string" || !APP_ID.test(appId)) return [null, "invalid_app_id"];
  const appName = cleanText(params.name, 120) ?? appId;
  const iframeUrl = params.iframeUrl === undefined || params.iframeUrl === null ? null : frameUrl(params.iframeUrl);
  if (iframeUrl === null && params.iframeUrl !== undefined && params.iframeUrl !== null) return [null, "invalid_iframe_url"];
  let resource: AppsUiResource | null = null;
  if (params.resource !== undefined && params.resource !== null) {
    if (!isDict(params.resource) || !isAppsUiUri(params.resource.uri)) return [null, "invalid_resource_uri"];
    const frame = params.resource.iframeUrl === undefined ? iframeUrl : frameUrl(params.resource.iframeUrl);
    if (frame === null) return [null, "invalid_iframe_url"];
    resource = { uri: params.resource.uri as string, iframeUrl: frame, version: cleanText(params.resource.version, 64) };
  }
  const tools: string[] = [];
  if (params.tools !== undefined && params.tools !== null) {
    if (!Array.isArray(params.tools) || params.tools.length > MAX_TOOLS) return [null, "invalid_tools"];
    for (const tool of params.tools) {
      if (typeof tool !== "string" || !tool || tool.length > MAX_NAME || !PRINTABLE(tool) || tools.includes(tool)) return [null, "invalid_tools"];
      tools.push(tool);
    }
  }
  return [{ appId, appName, iframeUrl, resource, tools }, null];
}

/** Register (or re-register after a reconnect) one app connection; the generation always advances. */
export function appsConnect(stateDir: string | null, sessionId: string, serverId: string, connectionId: string, params: AppsConnectParams): AppsConnectionSnapshot {
  const key = entryKey(stateDir, sessionId, serverId);
  const previous = registry.get(key);
  const generation = (previous?.generation ?? 0) + 1;
  const entry: AppsEntry = {
    serverId: serverId.slice(0, MAX_NAME), connectionId, generation, appId: params.appId, appName: params.appName,
    status: "connecting", connectedAt: null,
    uiResource: params.resource?.uri ?? null, iframeUrl: params.resource?.iframeUrl ?? params.iframeUrl,
    resource: params.resource, tools: [...params.tools], waiters: new Set(),
  };
  registry.set(key, entry);
  if (previous) wakeAll(previous);
  return snapshotOf(entry);
}

/** The app frame reports it finished initializing; a stale generation is refused. */
export function appsReady(stateDir: string | null, sessionId: string, serverId: string, guard: AppsGuard): AppsWaitResult {
  const entry = registry.get(entryKey(stateDir, sessionId, serverId));
  if (!entry) return { ok: false, reason: "no_connection" };
  if (!guardOk(entry, guard)) return { ok: false, reason: "stale" };
  if (entry.status === "closed") return { ok: false, reason: "closed" };
  entry.status = "connected";
  entry.connectedAt = Math.trunc(Date.now() / 1000);
  wakeAll(entry);
  return { ok: true, snapshot: snapshotOf(entry) };
}

/** Close the current connection. A disconnect from an older connection must not clobber the new one. */
export function appsDisconnect(stateDir: string | null, sessionId: string, serverId: string, connectionId?: string): AppsConnectionSnapshot | null {
  const entry = registry.get(entryKey(stateDir, sessionId, serverId));
  if (!entry) return null;
  if (connectionId !== undefined && entry.connectionId !== connectionId) return snapshotOf(entry);
  entry.status = "closed";
  wakeAll(entry);
  return snapshotOf(entry);
}

export function appsSnapshot(stateDir: string | null, sessionId: string, serverId: string): AppsConnectionSnapshot | null {
  const entry = registry.get(entryKey(stateDir, sessionId, serverId));
  return entry ? snapshotOf(entry) : null;
}

/** Apps tools are visible to the session only while their connection is live. */
export function appsToolsVisible(snapshot: AppsConnectionSnapshot | null): string[] {
  return snapshot && snapshot.status === "connected" ? [...snapshot.tools] : [];
}

/**
 * 3.16.2 `waitForAppConnection`: park until the app frame finished initializing,
 * re-validating the lease (`connectionId`) and the connection generation both
 * before parking and after every wake.
 */
export async function waitForAppConnection(stateDir: string | null, sessionId: string, serverId: string, guard: AppsGuard, timeoutMs = APPS_WAIT_MS): Promise<AppsWaitResult> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const entry = registry.get(entryKey(stateDir, sessionId, serverId));
    if (!entry) return { ok: false, reason: "no_connection" };
    if (!guardOk(entry, guard)) return { ok: false, reason: "stale" };
    if (entry.status === "connected") return { ok: true, snapshot: snapshotOf(entry) };
    if (entry.status === "closed") return { ok: false, reason: "closed" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: "timeout" };
    await new Promise<void>((wake) => {
      const timer = setTimeout(wake, Math.min(remaining, 200));
      const done = (): void => { clearTimeout(timer); entry.waiters.delete(done); wake(); };
      entry.waiters.add(done);
    });
  }
}

/** Open one `ui://` resource under the session lease and connection generation recheck. */
export function openAppsResource(stateDir: string | null, sessionId: string, uri: unknown, guard: AppsGuard): { ok: true; manifest: Row } | { ok: false; reason: string } {
  if (!isAppsUiUri(uri)) return { ok: false, reason: "invalid_uri" };
  const target = String(uri);
  const prefix = `${stateKey(stateDir)}\0${sessionId}\0`;
  // Several apps in one session may publish the same `ui://` uri: the caller's own
  // connection wins, so another server's app never shadows it as `stale`.
  let entry: AppsEntry | undefined;
  let sameUri: AppsEntry | undefined;
  for (const [key, candidate] of registry) {
    if (!key.startsWith(prefix) || candidate.resource?.uri !== target) continue;
    if (guardOk(candidate, guard)) { entry = candidate; break; }
    sameUri ??= candidate;
  }
  if (!entry) return sameUri ? { ok: false, reason: "stale" } : { ok: false, reason: "no_connection" };
  if (!entry.resource) return { ok: false, reason: "no_connection" };
  if (entry.status !== "connected") return { ok: false, reason: "not_connected" };
  return { ok: true, manifest: { uri: target, appId: entry.appId, iframeUrl: entry.resource.iframeUrl, version: entry.resource.version, tools: [...entry.tools] } };
}

/** Tool context handed to app-provided tool calls; stale generations never see the new session. */
export function appsToolContext(stateDir: string | null, sessionId: string, serverId: string, guard: AppsGuard): { ok: true; context: Row } | { ok: false; reason: string } {
  const entry = registry.get(entryKey(stateDir, sessionId, serverId));
  if (!entry) return { ok: false, reason: "no_connection" };
  if (!guardOk(entry, guard)) return { ok: false, reason: "stale" };
  if (entry.status !== "connected") return { ok: false, reason: "not_connected" };
  return { ok: true, context: { ui: { sessionId, serverId, generation: entry.generation, connectionId: entry.connectionId } } };
}

export function resetAppsState(stateDir: string | null = null): void {
  const state = stateDir === null ? null : `${stateKey(stateDir)}\0`;
  for (const [key, entry] of [...registry.entries()]) {
    if (state !== null && !key.startsWith(state)) continue;
    entry.status = "closed";
    wakeAll(entry);
    registry.delete(key);
  }
}

function rpcResult(id: unknown, result: Row): Row {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Row {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Answer one Apps server request (`apps/connect`, `apps/disconnect`); anything else is unsupported. */
export async function appsResponseFor(server: Row, message: Row, connectionId: string): Promise<Row> {
  const id = message.id;
  const method = message.method;
  if (method !== "apps/connect" && method !== "apps/disconnect") return rpcError(id, -32601, "method not found");
  if (!appsEnabled(server)) return rpcError(id, -32601, "apps host is disabled");
  const context = sessionContext(server);
  if (!context) return rpcResult(id, { accepted: false, reason: "unattended" });
  const serverId = isDict(server) && typeof server.id === "string" ? server.id.slice(0, MAX_NAME) : "";
  if (method === "apps/disconnect") {
    appsDisconnect(context.stateDir, context.sessionId, serverId, connectionId);
    return rpcResult(id, { accepted: true });
  }
  const [params, code] = validateAppsConnect(message.params);
  if (!params) return rpcResult(id, { accepted: false, reason: code ?? "invalid_params" });
  const snapshot = appsConnect(context.stateDir, context.sessionId, serverId, connectionId, params);
  return rpcResult(id, { accepted: true, generation: snapshot.generation, connectionId: snapshot.connectionId, appId: snapshot.appId });
}
