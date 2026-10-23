/** One MCP connection shared by the plugin runtime and short lived catalog operations. */
import { isDict } from "@xueness/contracts";
import type { Context } from "@xueness/kernel";
import { HttpTransport, SseTransport } from "./http.ts";
import { callResultText, type Row } from "./names.ts";
import { CLIENT_INFO, handshakeOf, HTTP_PROTOCOL_VERSION, McpCancelledError, McpServerError, McpTransportError, timeoutMs, versionLadder, type ServerAnswer } from "./rpc.ts";
import { StdioTransport, type Transport } from "./stdio.ts";

const PAGE_LIMIT = 50;
const ITEM_LIMIT = 1000;
const RESOURCE_SIGNAL_LIMIT = 32;

export type Kind = "stdio" | "http" | "sse";
export type McpClientActivity = "disconnected" | "tools_changed" | "resources_changed" | "resource_updated" | "cancelled";
export function kindOf(server: Row): Kind {
  return server.transport === "sse" ? "sse" : server.transport === "http" || server.transport === "streamable-http" ? "http" : "stdio";
}

/** `toolError`: the server ran the tool and said it failed (`isError`), not a transport failure. */
export interface CallOutcome { ok: boolean; text: string; error: string | null; toolError: boolean; cancelled?: boolean }
export interface ResourceSignalMetadata { type: "resources_changed" | "resource_updated"; observedAt: number }

const metadata = (error: unknown): string => error instanceof McpTransportError || error instanceof McpServerError ? error.message : `${error instanceof Error ? error.name : "Error"}: MCP request failed`;

export class McpClient {
  readonly server: Row;
  readonly kind: Kind;
  readonly timeoutMs: number;
  readonly #transport: Transport;
  readonly #activity = new Set<(event: McpClientActivity) => void>();
  readonly #resourceSignals: ResourceSignalMetadata[] = [];
  #starting: Promise<boolean> | null = null;
  #resourcesChangedCount = 0;
  #resourceUpdatedCount = 0;
  #toolListRevision = 0;
  #toolsDirty = false;
  error: string | null = null;
  /** Copied onto the channel after every `open`, which replaces that channel. */
  answerServer: ServerAnswer | null = null;
  negotiatedVersion: string | null = null;
  serverInfo: Row = {};
  capabilities: Row = {};
  tools: Row[] = [];

  constructor(ctx: Context, server: Row, cwd: string) {
    this.server = server;
    this.kind = kindOf(server);
    this.timeoutMs = timeoutMs(server);
    this.#transport = this.kind === "stdio" ? new StdioTransport(ctx, server, cwd) : this.kind === "http" ? new HttpTransport(ctx, server, this.timeoutMs) : new SseTransport(ctx, server, this.timeoutMs);
    this.#installChannel();
  }

  get active(): boolean { return this.#transport.active; }
  get toolsDirty(): boolean { return this.#toolsDirty; }
  get toolListRevision(): number { return this.#toolListRevision; }
  get resourcesChangedCount(): number { return this.#resourcesChangedCount; }
  get resourceUpdatedCount(): number { return this.#resourceUpdatedCount; }
  get resourceSignals(): readonly ResourceSignalMetadata[] { return this.#resourceSignals.map((event) => ({ ...event })); }

  onActivity(listener: (event: McpClientActivity) => void): () => void {
    this.#activity.add(listener);
    return () => this.#activity.delete(listener);
  }

  #emit(event: McpClientActivity): void {
    for (const listener of this.#activity) { try { listener(event); } catch { /* observers cannot break an MCP response */ } }
  }

  #recordResourceSignal(type: ResourceSignalMetadata["type"]): void {
    if (type === "resources_changed") this.#resourcesChangedCount = Math.min(Number.MAX_SAFE_INTEGER, this.#resourcesChangedCount + 1);
    else this.#resourceUpdatedCount = Math.min(Number.MAX_SAFE_INTEGER, this.#resourceUpdatedCount + 1);
    this.#resourceSignals.push({ type, observedAt: Date.now() });
    if (this.#resourceSignals.length > RESOURCE_SIGNAL_LIMIT) this.#resourceSignals.shift();
    this.#emit(type);
  }

  #installChannel(): void {
    const channel = this.#transport.channel;
    channel.answerServer = this.answerServer;
    channel.notificationHandler = (message) => {
      if (message.method === "notifications/tools/list_changed") {
        this.#toolsDirty = true;
        this.#toolListRevision = Math.min(Number.MAX_SAFE_INTEGER, this.#toolListRevision + 1);
        this.#emit("tools_changed");
      } else if (message.method === "notifications/resources/list_changed") this.#recordResourceSignal("resources_changed");
      else if (message.method === "notifications/resources/updated") this.#recordResourceSignal("resource_updated");
    };
    channel.onClosed = () => this.#emit("disconnected");
  }

  /** Connect and finish `initialize`. Concurrent callers share this handshake. */
  start(): Promise<boolean> {
    if (this.#starting) return this.#starting;
    const pending = this.#start();
    this.#starting = pending;
    void pending.finally(() => { if (this.#starting === pending) this.#starting = null; }).catch(() => {});
    return pending;
  }

  async #start(): Promise<boolean> {
    this.error = null;
    this.negotiatedVersion = null;
    this.serverInfo = {};
    this.capabilities = {};
    const ladder = this.kind === "stdio" ? versionLadder(this.server) : versionLadder(this.server, HTTP_PROTOCOL_VERSION).slice(0, 1);
    for (let index = 0; index < ladder.length; index += 1) {
      try {
        await this.#transport.open();
        this.#installChannel();
        const capabilities = this.answerServer && this.server.elicitation === true ? { elicitation: {} } : {};
        const result = await this.#transport.channel.request("initialize", { protocolVersion: ladder[index], capabilities, clientInfo: { ...CLIENT_INFO } }, this.timeoutMs);
        const handshake = handshakeOf(result);
        if ("error" in handshake) throw new McpTransportError(handshake.error);
        this.negotiatedVersion = handshake.version;
        this.serverInfo = handshake.info;
        this.capabilities = handshake.capabilities;
        const transport = this.#transport as Transport & { protocolVersion?: string | null; markStarted?(): void };
        if ("protocolVersion" in transport) transport.protocolVersion = handshake.version;
        await this.#transport.channel.notify("notifications/initialized");
        transport.markStarted?.();
        return true;
      } catch (error) {
        await this.#transport.close();
        this.error = this.kind === "stdio" ? metadata(error) : this.kind === "http" ? "HTTP MCP initialization failed (details suppressed)" : "SSE MCP initialization failed";
        if (!(error instanceof McpServerError) || index + 1 >= ladder.length) return false;
      }
    }
    return false;
  }

  async #request(method: string, params: Row, signal?: AbortSignal): Promise<Row> {
    if (signal?.aborted) {
      this.#emit("cancelled");
      throw new McpCancelledError(Promise.resolve());
    }
    try { return await this.#transport.channel.request(method, params, this.timeoutMs, undefined, signal); }
    catch (error) {
      if (error instanceof McpCancelledError || signal?.aborted) {
        this.#emit("cancelled");
        if (this.kind !== "stdio") {
          const notification = error instanceof McpCancelledError ? error.notification : Promise.resolve();
          void notification.finally(() => this.#transport.close()).catch(() => {});
        }
        throw error instanceof McpCancelledError ? error : new McpCancelledError(Promise.resolve());
      }
      if (error instanceof McpServerError && this.kind === "stdio") throw error;
      await this.#transport.close();
      if (error instanceof McpServerError) throw new McpTransportError("HTTP MCP server rejected request");
      throw error;
    }
  }

  async #pages(method: string, field: string, signal?: AbortSignal): Promise<Row[]> {
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      const result = await this.#request(method, cursor ? { cursor } : {}, signal);
      const items = result[field];
      if (!Array.isArray(items) || items.some((item) => !isDict(item))) throw new McpTransportError(`invalid MCP ${field} list`);
      rows.push(...items as Row[]);
      if (rows.length > ITEM_LIMIT) throw new McpTransportError(`MCP ${field} catalog too large`);
      const next = result.nextCursor;
      if (next === undefined || next === null) return rows;
      if (typeof next !== "string" || !next || seen.has(next)) throw new McpTransportError("invalid MCP pagination");
      seen.add(next);
      cursor = next;
    }
    throw new McpTransportError("MCP catalog page limit");
  }

  async listTools(): Promise<Row[]> {
    const revision = this.#toolListRevision;
    try {
      this.tools = await this.#pages("tools/list", "tools");
      this.#toolsDirty = this.#toolListRevision !== revision;
      return this.tools;
    } catch (error) {
      this.error = this.kind === "stdio" ? metadata(error) : "HTTP MCP tool discovery failed";
      if (this.kind !== "stdio" && !(error instanceof McpCancelledError)) await this.#transport.close();
      return [];
    }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<CallOutcome> {
    if (signal?.aborted) return { ok: false, text: "", error: "cancelled", toolError: false, cancelled: true };
    let result: Row;
    try { result = await this.#request("tools/call", { name, arguments: isDict(args) ? args : {} }, signal); }
    catch (error) {
      if (error instanceof McpCancelledError || signal?.aborted) return { ok: false, text: "", error: "cancelled", toolError: false, cancelled: true };
      this.error = metadata(error);
      if (error instanceof McpTransportError && this.kind === "stdio") await this.#transport.close();
      return { ok: false, text: "", error: this.error, toolError: false };
    }
    const { ok, text } = callResultText(result);
    return ok ? { ok, text, error: null, toolError: false } : { ok, text: "", error: text, toolError: true };
  }

  async catalog(kind: "resources" | "prompts", signal?: AbortSignal): Promise<Row[]> {
    return await this.#pages(`${kind}/list`, kind, signal);
  }

  read(kind: "resources" | "prompts", key: unknown, args?: unknown, signal?: AbortSignal): Promise<Row> {
    if (typeof key !== "string" || !key || [...key].length > 4096) return Promise.reject(new TypeError("invalid MCP resource or prompt key"));
    return this.#request(kind === "resources" ? "resources/read" : "prompts/get", kind === "resources" ? { uri: key } : { name: key, arguments: isDict(args) ? args : {} }, signal);
  }

  subscribeResource(uri: unknown, signal?: AbortSignal): Promise<Row> {
    if (typeof uri !== "string" || !uri || [...uri].length > 4096) return Promise.reject(new TypeError("invalid MCP resource key"));
    if (!isDict(this.capabilities.resources) || this.capabilities.resources.subscribe !== true) return Promise.reject(new McpServerError("resource subscriptions are not supported"));
    return this.#request("resources/subscribe", { uri }, signal);
  }

  unsubscribeResource(uri: unknown, signal?: AbortSignal): Promise<Row> {
    if (typeof uri !== "string" || !uri || [...uri].length > 4096) return Promise.reject(new TypeError("invalid MCP resource key"));
    if (!isDict(this.capabilities.resources) || this.capabilities.resources.subscribe !== true) return Promise.reject(new McpServerError("resource subscriptions are not supported"));
    return this.#request("resources/unsubscribe", { uri }, signal);
  }

  close(): Promise<void> { return this.#transport.close(); }
}
