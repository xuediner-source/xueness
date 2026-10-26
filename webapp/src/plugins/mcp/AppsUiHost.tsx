import React, { useEffect, useRef, useState } from "react";
import { get, listResources, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";

/** MCP Apps UI host panel (C-ADJ-03). Mirrors the session bridge the server
 * exposes at /api/sessions/<id>/mcp-apps: the host renders the app frame for a
 * live connection, reports readiness under the connection generation it
 * rendered, and never lets a stale frame reach a newer session connection. */

export type AppsConnectionStatus = "connecting" | "connected" | "closed";
export interface AppsConnection {
  serverId: string;
  connectionId: string;
  generation: number;
  appId: string;
  appName: string;
  status: AppsConnectionStatus;
  connectedAt: number | null;
  uiResource: string | null;
  iframeUrl: string | null;
  tools: string[];
}

export const APPS_POLL_WAIT_MS = 20000;
const APPS_POLL_BASE_DELAY = 1200;
const APPS_POLL_MAX_DELAY = 10000;

const clean = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;

/** Strict parse of one connection snapshot; anything malformed reads as "no connection". */
export function parseAppsConnection(value: unknown): AppsConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const serverId = clean(row.serverId, 64);
  const connectionId = clean(row.connectionId, 128);
  const appId = clean(row.appId, 64);
  if (!serverId || !connectionId || !appId) return null;
  if (typeof row.generation !== "number" || !Number.isInteger(row.generation) || row.generation < 1 || row.generation > 2 ** 31) return null;
  if (row.status !== "connecting" && row.status !== "connected" && row.status !== "closed") return null;
  let connectedAt: number | null = null;
  if (row.connectedAt != null) {
    if (typeof row.connectedAt !== "number" || !Number.isFinite(row.connectedAt)) return null;
    connectedAt = Math.trunc(row.connectedAt);
  }
  let uiResource: string | null = null;
  if (row.uiResource != null) {
    uiResource = clean(row.uiResource, 256);
    if (!uiResource) return null;
  }
  let iframeUrl: string | null = null;
  if (row.iframeUrl != null) {
    iframeUrl = clean(row.iframeUrl, 2048);
    if (!iframeUrl) return null;
  }
  let tools: string[] = [];
  if (row.tools != null) {
    if (!Array.isArray(row.tools) || row.tools.length > 64 || row.tools.some((tool) => typeof tool !== "string" || !tool)) return null;
    tools = row.tools as string[];
  }
  return {
    serverId, connectionId, generation: row.generation, appId,
    appName: clean(row.appName, 120) ?? appId,
    status: row.status, connectedAt, uiResource, iframeUrl, tools,
  };
}

/** The GET bridge reply is `{ connection: snapshot | null }`. */
export function parseAppsBridgeReply(body: unknown): AppsConnection | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return parseAppsConnection((body as Record<string, unknown>).connection);
}

export function appsBridgePath(sessionId: string, serverId: string, waitMs = APPS_POLL_WAIT_MS): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/mcp-apps?server=${encodeURIComponent(serverId)}&wait=${waitMs}`;
}

export function appsBridgePostPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/mcp-apps`;
}

/** The host only frames https origins, or a loopback http origin for local apps. */
export function isSafeAppsFrameUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
}

export function appsReadyKey(connection: AppsConnection): string {
  return `${connection.connectionId}:${connection.generation}`;
}

/**
 * The ready report may fire once per connection generation, and it may also fire
 * for a `connecting` connection that already names its frame: the host posts
 * readiness when the frame loads, and the server only marks the connection
 * connected after that report (so waiting for `connected` first deadlocks).
 * A frame from an older generation must never report readiness for the
 * connection that replaced it, so an unchanged key yields null.
 */
export function nextReadyKey(previous: string, connection: AppsConnection | null): string | null {
  if (!connection || connection.status === "closed" || !connection.iframeUrl) return null;
  const key = appsReadyKey(connection);
  return key === previous ? null : key;
}

export function nextAppsPollDelay(failures: number): number {
  return Math.min(APPS_POLL_MAX_DELAY, APPS_POLL_BASE_DELAY * 2 ** Math.min(failures, 4));
}

export interface AppsFrameState { connected: boolean; iframeUrl: string | null }

/**
 * The frame the host mounts on its own claim. A `connecting` snapshot qualifies:
 * the frame load is the readiness report, so the host mounts before `connected`.
 * Without a claim the frame renders only for a `connected` snapshot.
 */
export function appsClaimedFrame(connection: AppsConnection | null): AppsFrameState {
  if (!connection || connection.status === "closed" || !connection.iframeUrl) return { connected: false, iframeUrl: null };
  return { connected: isSafeAppsFrameUrl(connection.iframeUrl), iframeUrl: connection.iframeUrl };
}

const unclaimedFrame = (connection: AppsConnection): AppsFrameState =>
  connection.status === "connected" ? appsClaimedFrame(connection) : { connected: false, iframeUrl: null };

export function AppsFrame({ connection, state, onLoad, onClose }: {
  connection: AppsConnection;
  state?: AppsFrameState;
  onLoad: (connection: AppsConnection) => void;
  onClose: (connection: AppsConnection) => void;
}): React.JSX.Element {
  const frame = state ?? unclaimedFrame(connection);
  if (!frame.connected || !frame.iframeUrl) {
    return <p data-testid="apps-host-status" role="status">{connection.status === "closed" ? tr("应用连接已关闭。") : `${tr("正在等待应用连接…")}（${connection.appName}）`}</p>;
  }
  return (
    <div className="xn-mcp-apps">
      <header className="xn-mcp-apps__bar">
        <strong>{connection.appName}</strong>
        <code>{connection.uiResource ?? connection.appId}</code>
        <button type="button" data-testid="apps-host-close" onClick={() => onClose(connection)}>{tr("关闭应用")}</button>
      </header>
      <iframe
        data-testid="apps-host-frame"
        title={connection.appName}
        src={frame.iframeUrl}
        sandbox="allow-scripts"
        onLoad={() => onLoad(connection)}
      />
      {connection.tools.length > 0 && (
        <ul data-testid="apps-host-tools" className="xn-mcp-apps__tools">
          {connection.tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}
        </ul>
      )}
    </div>
  );
}

export function AppsUiHost({ sessionId, serverId }: { sessionId: string; serverId: string }): React.JSX.Element | null {
  if (!sessionId || !serverId) return null;
  return <SessionAppsHost key={`${sessionId}/${serverId}`} sessionId={sessionId} serverId={serverId} />;
}

function SessionAppsHost({ sessionId, serverId }: { sessionId: string; serverId: string }): React.JSX.Element | null {
  const [connection, setConnection] = useState<AppsConnection | null>(null);
  // The frame is claimed once per connection generation, when the snapshot first
  // names a safe url — that is what lets `app_ready` fire for a `connecting` snapshot.
  const [frame, setFrame] = useState<{ key: string; url: string } | null>(null);
  const [frameOpen, setFrameOpen] = useState(true);
  const mounted = useRef(false);
  const readyKey = useRef("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A confirmed reply re-polls immediately: the server parks the GET on the
  // connection state, so the long wait itself paces an idle host. Only
  // failures back off.
  useEffect(() => {
    if (!sessionId || !serverId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const body = await get(appsBridgePath(sessionId, serverId));
        if (stopped) return;
        failures = 0;
        const next = parseAppsBridgeReply(body);
        setConnection(next);
        if (next && next.status !== "closed" && next.iframeUrl && isSafeAppsFrameUrl(next.iframeUrl)) {
          const key = appsReadyKey(next);
          const url = next.iframeUrl;
          setFrame((previous) => previous !== null && previous.key === key ? previous : { key, url });
        }
      } catch {
        if (!stopped) failures += 1;
      } finally {
        if (!stopped) {
          const delay = failures > 0 ? nextAppsPollDelay(failures) : 100;
          timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
        }
      }
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, [sessionId, serverId]);

  const reportReady = (current: AppsConnection): void => {
    const key = nextReadyKey(readyKey.current, current);
    if (key === null) return;
    readyKey.current = key;
    void post(appsBridgePostPath(sessionId), {
      type: "app_ready", server: serverId, connectionId: current.connectionId, generation: current.generation,
    }).catch(() => {
      // Allow one retry after a transient failure; the key stays claimed otherwise.
      if (readyKey.current === key) readyKey.current = "";
    });
  };

  const closeFrame = (current: AppsConnection): void => {
    setFrameOpen(false);
    setFrame(null);
    void post(appsBridgePostPath(sessionId), {
      type: "app_closed", server: serverId, connectionId: current.connectionId,
    }).catch(() => undefined);
  };

  if (!connection) return null;
  if (connection.status === "closed" || !frameOpen) {
    return <p data-testid="apps-host-closed" role="status">{tr("应用连接已关闭。")}</p>;
  }
  return <AppsFrame connection={connection} state={frame === null ? { connected: false, iframeUrl: null } : { connected: true, iframeUrl: frame.url }} onLoad={reportReady} onClose={closeFrame} />;
}

/** Server documents opt into the Apps host with `apps: true`, top level or under `extra`.
 * Malformed rows are skipped: one bad document must not hide the other app hosts. */
export function appsServerIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const extra = row.extra;
    const extraApps = !!extra && typeof extra === "object" && !Array.isArray(extra)
      && (extra as Record<string, unknown>).apps === true;
    if (row.apps !== true && !extraApps) continue;
    const id = clean(row.id, 64);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const APPS_SERVERS_REFRESH_MS = 30_000;

/** Session-scoped Apps host entry: discover apps-enabled servers, then host one
 * app view per server. Renders nothing until a server actually connects, so
 * sessions without Apps stay visually unchanged. */
export function McpAppsHost({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [serverIds, setServerIds] = useState<string[]>([]);
  useEffect(() => {
    if (!sessionId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      if (stopped) return;
      try {
        const response = await listResources("mcp");
        if (!stopped) setServerIds(appsServerIds(response.items));
      } catch { /* keep the last known list; the next refresh retries */ }
      if (!stopped) timer = setTimeout(() => { timer = undefined; void load(); }, APPS_SERVERS_REFRESH_MS);
    };
    void load();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, [sessionId]);
  if (!sessionId || serverIds.length === 0) return null;
  return <>{serverIds.map(id => <AppsUiHost key={id} sessionId={sessionId} serverId={id} />)}</>;
}
