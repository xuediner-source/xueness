import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@xueness/kernel";
import { responseFor } from "./elicitation-protocol.ts";
import { McpClient, type McpClientActivity } from "./client.ts";
import type { Row } from "./names.ts";

export type McpActivityPhase = "connected" | "disconnected" | "tools_changed" | "resources_changed" | "resource_updated" | "cancelled" | "failed";
export interface McpActivityEvent { type: "mcp_activity"; phase: McpActivityPhase; serverId: string; connectionId?: string; toolCount?: number }
export type McpRuntimeServerStatus = "connecting" | "connected" | "disconnected" | "failed";
export interface McpRuntimeServerSnapshot {
  serverId: string;
  connectionId: string;
  status: McpRuntimeServerStatus;
  toolCount: number;
  resourcesChangedCount: number;
  resourceUpdatedCount: number;
}
export interface McpRuntimeSnapshot { servers: McpRuntimeServerSnapshot[] }
export interface McpRuntimePort {
  /** Metadata only: no server config, credentials, tool names/schemas, resource URI or content. */
  snapshot(): McpRuntimeSnapshot;
  /** The first subscriber receives the bounded pre-run queue before later activity. */
  onActivity(listener: (event: McpActivityEvent) => void): () => void;
}
export interface McpRuntimeBinding { current?: McpRuntimePort }

export interface McpConnectionLease {
  readonly client: McpClient;
  readonly connectionId: string;
  readonly tools: readonly Row[];
  markConnected(tools: readonly Row[]): void;
  markFailed(): void;
  release(): Promise<void>;
}

interface Entry extends McpRuntimeServerSnapshot {
  client: McpClient;
  key: string;
  refs: number;
  closed: boolean;
  ready: Promise<boolean>;
  tools: Row[];
  closeTimer?: NodeJS.Timeout;
  removeClientActivity: () => void;
}

const EVENT_LIMIT = 100;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Row)[key])]));
  }
  return value;
}

function serverFingerprint(server: Row): string {
  return createHash("sha256").update(JSON.stringify(stable(server))).digest("hex");
}

function ownerOf(server: Row, fallback: string): string {
  const audience = server._elicitation_session;
  return audience && typeof audience === "object" && typeof (audience as Row).id === "string" ? String((audience as Row).id) : fallback;
}

export interface McpConnectionPoolOptions {
  idleGraceMs?: number;
  onActivity?: (event: McpActivityEvent) => void;
}

/** Per-plugin-activation connection pool; keys include session owner, cwd and all server config. */
export class McpConnectionPool implements McpRuntimePort {
  readonly #ctx: Context;
  readonly #idleGraceMs: number;
  readonly #externalActivity?: (event: McpActivityEvent) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #latest = new Map<string, McpRuntimeServerSnapshot>();
  readonly #listeners = new Set<(event: McpActivityEvent) => void>();
  readonly #pending: McpActivityEvent[] = [];
  readonly #runOwner = randomUUID();
  #closed = false;

  constructor(ctx: Context, options: McpConnectionPoolOptions = {}) {
    this.#ctx = ctx;
    this.#idleGraceMs = Math.max(0, options.idleGraceMs ?? 0);
    this.#externalActivity = options.onActivity;
  }

  #activity(event: McpActivityEvent): void {
    this.#pending.push({ ...event });
    if (this.#pending.length > EVENT_LIMIT) this.#pending.shift();
    try { this.#externalActivity?.({ ...event }); } catch { /* activity observers cannot break MCP calls */ }
    for (const listener of this.#listeners) { try { listener({ ...event }); } catch { /* activity observers are isolated */ } }
  }

  onActivity(listener: (event: McpActivityEvent) => void): () => void {
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) { try { listener({ ...event }); } catch { /* ignored */ } }
    return () => this.#listeners.delete(listener);
  }

  snapshot(): McpRuntimeSnapshot {
    return { servers: [...this.#latest.values()].map((server) => ({ ...server })).sort((a, b) => a.serverId.localeCompare(b.serverId)) };
  }

  async acquire(server: Row, cwd: string): Promise<McpConnectionLease | null> {
    if (this.#closed) throw new Error("MCP connection pool is closed");
    const serverId = String(server.id);
    const owner = ownerOf(server, this.#runOwner);
    const fingerprint = serverFingerprint(server);
    const key = `${owner}\u0000${cwd}\u0000${fingerprint}`;
    let entry = this.#entries.get(key);
    if (entry) {
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      entry.closeTimer = undefined;
      entry.refs += 1;
    } else {
      const connectionId = randomUUID();
      const client = new McpClient(this.#ctx, server, cwd);
      client.answerServer = (message) => responseFor(server, message);
      const placeholder = Promise.resolve(false);
      entry = {
        serverId, connectionId, status: "connecting", toolCount: 0, resourcesChangedCount: 0, resourceUpdatedCount: 0,
        client, key, refs: 1, closed: false, ready: placeholder, tools: [], removeClientActivity: () => {},
      };
      this.#entries.set(key, entry);
      this.#latest.set(serverId, this.#snapshotOf(entry));
      entry.removeClientActivity = client.onActivity((activity) => this.#clientActivity(entry!, activity));
      const current = entry;
      entry.ready = (async () => {
        if (!await client.start() || client.error) {
          current.status = "failed";
          this.#latest.set(serverId, this.#snapshotOf(current));
          this.#activity({ type: "mcp_activity", phase: "failed", serverId, connectionId });
          return false;
        }
        current.tools = await client.listTools();
        this.#markConnected(current, current.tools);
        return true;
      })();
    }
    const current = entry;
    const connected = await current.ready;
    if (!connected) { await this.#release(current); return null; }
    let released = false;
    return {
      client: current.client,
      connectionId: current.connectionId,
      get tools() { return current.tools; },
      markConnected: (tools) => this.#markConnected(current, tools),
      markFailed: () => this.#markFailed(current),
      release: async () => { if (released) return; released = true; await this.#release(current); },
    };
  }

  #snapshotOf(entry: Entry): McpRuntimeServerSnapshot {
    return {
      serverId: entry.serverId, connectionId: entry.connectionId, status: entry.status,
      toolCount: entry.status === "connected" ? entry.toolCount : 0,
      resourcesChangedCount: entry.client.resourcesChangedCount,
      resourceUpdatedCount: entry.client.resourceUpdatedCount,
    };
  }

  #clientActivity(entry: Entry, activity: McpClientActivity): void {
    if (entry.closed) return;
    entry.resourcesChangedCount = entry.client.resourcesChangedCount;
    entry.resourceUpdatedCount = entry.client.resourceUpdatedCount;
    if (activity === "disconnected") {
      if (entry.status !== "connected") return;
      entry.status = "disconnected";
      entry.toolCount = 0;
    }
    this.#latest.set(entry.serverId, this.#snapshotOf(entry));
    const phase = activity === "disconnected" ? "disconnected" : activity;
    this.#activity({ type: "mcp_activity", phase, serverId: entry.serverId, connectionId: entry.connectionId });
  }

  #markConnected(entry: Entry, tools: readonly Row[]): void {
    if (entry.closed) return;
    const wasConnected = entry.status === "connected";
    entry.status = "connected";
    entry.tools = [...tools];
    entry.toolCount = entry.tools.length;
    entry.resourcesChangedCount = entry.client.resourcesChangedCount;
    entry.resourceUpdatedCount = entry.client.resourceUpdatedCount;
    this.#latest.set(entry.serverId, this.#snapshotOf(entry));
    if (!wasConnected) this.#activity({ type: "mcp_activity", phase: "connected", serverId: entry.serverId, connectionId: entry.connectionId, toolCount: entry.toolCount });
  }

  #markFailed(entry: Entry): void {
    if (entry.closed) return;
    entry.status = "failed";
    entry.toolCount = 0;
    this.#latest.set(entry.serverId, this.#snapshotOf(entry));
    this.#activity({ type: "mcp_activity", phase: "failed", serverId: entry.serverId, connectionId: entry.connectionId });
  }

  async #release(entry: Entry): Promise<void> {
    if (entry.closed || !this.#entries.has(entry.key)) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs) return;
    if (this.#idleGraceMs > 0 && !this.#closed) {
      entry.closeTimer = setTimeout(() => { entry.closeTimer = undefined; void this.#closeEntry(entry); }, this.#idleGraceMs);
      entry.closeTimer.unref?.();
      return;
    }
    await this.#closeEntry(entry);
  }

  async #closeEntry(entry: Entry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    entry.removeClientActivity();
    await entry.client.close().catch(() => {});
    if (entry.status === "connected" || entry.status === "connecting") {
      entry.status = "disconnected";
      entry.toolCount = 0;
      this.#latest.set(entry.serverId, this.#snapshotOf(entry));
      this.#activity({ type: "mcp_activity", phase: "disconnected", serverId: entry.serverId, connectionId: entry.connectionId });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((entry) => this.#closeEntry(entry)));
    this.#listeners.clear();
  }
}
