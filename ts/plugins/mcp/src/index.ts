/** MCP tools, lifecycle and metadata runtime for one plugin activation. */
import { isDict, pyJsonDumps, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin, type Context } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { McpClient } from "./client.ts";
import { responseFor } from "./elicitation-protocol.ts";
import { CATALOG_CHARS, clipChars, mcpSubject, parseNamespaced, sanitizeNamePart, toolSchema, type Row } from "./names.ts";
import { McpConnectionPool, type McpActivityEvent, type McpConnectionLease, type McpRuntimeBinding } from "./runtime.ts";

export * from "./names.ts";
export * from "./resources-http.ts";
export * from "./runtime.ts";
export { mcpRuntimeExtension } from "./runtime-extension.ts";
export { validateRuntimeMcpServers, mergeRuntimeMcpServers } from "./config.ts";
export { createMcpRuntimeApi } from "./runtime-api.ts";
export { checkServer, createMcpOpsHttp, loadServers } from "./mcp-ops-http.ts";
export { createElicitationHttp } from "./elicitation-http.ts";
export { resetElicitationState } from "./elicitation-protocol.ts";

const failure = (code: string, message: string): ToolResult<never> => ({ ok: false, output: message, error: { code, message } });
export { McpClient, kindOf } from "./client.ts";
export { childEnvironment } from "./stdio.ts";
export { checkedUrl, authHeaders, sseEvents } from "./http.ts";
export { isServerRequest, serverRequestReply, versionLadder, handshakeOf, timeoutMs, SUPPORTED_PROTOCOL_VERSIONS, McpCancelledError } from "./rpc.ts";

export interface McpRun {
  servers: readonly Row[];
  cwd: string;
}

type ResourceKind = "resources" | "prompts";
type Special = { kind: ResourceKind; operation: "list" | "read" | "subscribe" | "unsubscribe" };
interface Bound {
  lease: McpConnectionLease;
  client: McpClient;
  server: Row;
  names: Map<string, string>;
  specials: Map<string, Special>;
  registered: Set<string>;
  disposers: Map<string, () => Promise<void>>;
  refresh: Promise<void>;
  removeActivity: () => void;
}

const VALIDATION_SCHEMA: JsonSchema = { type: "object" };

function specialSchema(serverId: string, kind: ResourceKind, operation: Special["operation"]): Row {
  const properties = operation === "list" ? {} : { key: { type: "string" }, ...(kind === "prompts" && operation === "read" ? { arguments: { type: "object" } } : {}) };
  const description = operation === "subscribe" || operation === "unsubscribe" ? `Manage untrusted MCP ${kind} subscription; exact approval required` : `Read untrusted MCP ${kind} ${operation}; exact approval required`;
  return toolSchema(serverId, { name: `_xueness_${kind}_${operation}`, description, inputSchema: { type: "object", properties, required: operation === "list" ? [] : ["key"] } });
}

export function serverTools(server: Row, tools: readonly Row[], capabilities: Row, call: (name: string, input: Row, signal?: AbortSignal) => Promise<ToolResult>): ToolDefinition[] {
  const id = String(server.id);
  const schemas = tools.map((tool) => toolSchema(id, tool));
  for (const kind of ["resources", "prompts"] as const) {
    if (!(kind in capabilities)) continue;
    const operations: Special["operation"][] = kind === "resources" && isDict(capabilities.resources) && capabilities.resources.subscribe === true
      ? ["list", "read", "subscribe", "unsubscribe"] : ["list", "read"];
    for (const operation of operations) {
      const schema = specialSchema(id, kind, operation);
      const name = (schema.function as Row).name;
      if (!schemas.some((row) => (row.function as Row).name === name)) schemas.push(schema);
    }
  }
  return schemas.map((schema) => {
    const fn = schema.function as Row;
    const name = String(fn.name);
    return {
      name, description: String(fn.description), inputSchema: VALIDATION_SCHEMA, modelSchema: fn.parameters as JsonSchema,
      gate: "mcp", mutating: true, concurrencySafe: false, requires: {}, subjectKind: "text",
      subject: (input: Row) => mcpSubject(name, input),
      run: (input: Row, env) => call(name, input, env.signal),
    } satisfies ToolDefinition<Row> as ToolDefinition;
  });
}

const failed = (message: string): ToolResult => ({ ...failure("mcp_error", message), user_reason: "MCP 调用失败。" });
const cancelled = (name: string): ToolResult => failure("cancelled", `${name} cancelled`);

export function createMcp(options: { run(): McpRun | null; binding?: McpRuntimeBinding; onActivity?: (event: McpActivityEvent) => void }): BundledPlugin {
  return {
    manifest,
    plugin: definePlugin({
      name: "mcp",
      async apply(ctx) {
        const run = options.run();
        if (!run) return;
        const pool = new McpConnectionPool(ctx, { idleGraceMs: 0, onActivity: options.onActivity });
        const binding = options.binding;
        if (binding) binding.current = pool;
        const bound = new Map<string, Bound>();
        let unloading = false;
        const cleanup = async (): Promise<void> => {
          unloading = true;
          for (const entry of bound.values()) entry.removeActivity();
          await Promise.all([...bound.values()].map(async (entry) => {
            await unregister(entry);
            await entry.lease.release();
          }));
          bound.clear();
          await pool.close();
          if (binding?.current === pool) delete binding.current;
        };
        // Register before tools so unloading first unregisters/drains calls, then closes connections.
        ctx.scope.add(cleanup);

        const register = async (entry: Bound, tools: readonly Row[]): Promise<void> => {
          await unregister(entry);
          if (unloading || !ctx.scope.active) return;
          for (const definition of serverTools(entry.server, tools, entry.client.capabilities, call)) {
            try {
              const dispose = ctx.tool(definition);
              entry.disposers.set(definition.name, dispose);
              entry.registered.add(definition.name);
              const raw = tools.find((tool) => typeof tool.name === "string" && definition.name === `mcp__${String(entry.server.id)}__${sanitizeNamePart(tool.name)}`);
              if (raw) entry.names.set(definition.name, String(raw.name));
              else if (definition.name.startsWith(`mcp__${String(entry.server.id)}___xueness_`)) {
                const suffix = definition.name.slice(`mcp__${String(entry.server.id)}___xueness_`.length);
                const match = suffix.match(/^(resources|prompts)_(list|read|subscribe|unsubscribe)$/);
                if (match) entry.specials.set(definition.name, { kind: match[1] as ResourceKind, operation: match[2] as Special["operation"] });
              }
            } catch { /* a conflicting sanitized name keeps the first registration */ }
          }
        };

        const call = async (name: string, input: Row, signal?: AbortSignal): Promise<ToolResult> => {
          const parsed = parseNamespaced(name);
          const entry = parsed ? bound.get(parsed[0]) : undefined;
          if (!parsed || !entry || unloading) return failed(parsed ? "mcp server not connected" : "unknown mcp tool");
          if (signal?.aborted) return cancelled(name);
          try {
            if (!entry.client.active) {
              if (!await entry.client.start()) { entry.lease.markFailed(); return failed("mcp tool unavailable after reconnect"); }
              const fresh = await entry.client.listTools();
              entry.lease.markConnected(fresh);
              await register(entry, fresh);
              const target = entry.names.get(name) ?? parsed[1];
              if (!entry.client.active || (!fresh.some((tool) => tool.name === target) && !entry.specials.has(name))) return failed("mcp tool unavailable after reconnect");
            }
            const special = entry.specials.get(name);
            if (special) {
              if (special.operation === "subscribe") await entry.client.subscribeResource(input.key, signal);
              else if (special.operation === "unsubscribe") await entry.client.unsubscribeResource(input.key, signal);
              else {
                const result = special.operation === "list" ? await entry.client.catalog(special.kind, signal) : { result: await entry.client.read(special.kind, input.key, input.arguments, signal) };
                const content = clipChars(pyJsonDumps(special.operation === "list" ? result : (result as Row).result, { ensureAscii: false }), CATALOG_CHARS);
                return { ok: true, output: content, data: { server: parsed[0], untrusted: true } };
              }
              return { ok: true, output: `MCP resource ${special.operation} request completed.`, data: { server: parsed[0], untrusted: true } };
            }
            const outcome = await entry.client.callTool(entry.names.get(name) ?? parsed[1], input, signal);
            if (outcome.cancelled) return cancelled(name);
            if (outcome.ok) return { ok: true, output: outcome.text, data: { server: parsed[0] } };
            return outcome.toolError
              ? { ok: false, output: `MCP tool returned an error:\n${outcome.error ?? ""}`, error: { code: "mcp_tool_error", message: outcome.error ?? "" }, data: { server: parsed[0] } }
              : failed(outcome.error ?? "mcp call failed");
          } catch (error) {
            if (signal?.aborted || error instanceof Error && error.name === "McpCancelledError") return cancelled(name);
            return failed("mcp call failed");
          }
        };

        const unregister = async (entry: Bound): Promise<void> => {
          for (const registered of entry.registered) {
            entry.names.delete(registered);
            entry.specials.delete(registered);
          }
          entry.registered.clear();
          await Promise.all([...entry.disposers.values()].map((dispose) => dispose().catch(() => {})));
          entry.disposers.clear();
        };

        const refreshTools = (entry: Bound): void => {
          entry.refresh = entry.refresh.then(async () => {
            if (unloading || !ctx.scope.active) return;
            let tools = await entry.client.listTools();
            for (let attempt = 0; entry.client.toolsDirty && attempt < 4; attempt += 1) tools = await entry.client.listTools();
            if (!entry.client.active) { entry.lease.markFailed(); await unregister(entry); return; }
            entry.lease.markConnected(tools);
            await register(entry, tools);
          }).catch(() => {});
        };

        for (const server of run.servers) {
          const lease = await pool.acquire(server, run.cwd);
          if (!lease) continue;
          const entry: Bound = {
            lease, client: lease.client, server, names: new Map(), specials: new Map(), registered: new Set(), disposers: new Map(),
            refresh: Promise.resolve(), removeActivity: () => {},
          };
          bound.set(String(server.id), entry);
          entry.removeActivity = entry.client.onActivity((event) => {
            if (event !== "tools_changed" || unloading) return;
            refreshTools(entry);
          });
          await register(entry, lease.tools);
          if (entry.client.toolsDirty) refreshTools(entry);
        }
      },
    }),
  };
}

export const mcp: BundledPlugin = createMcp({ run: () => null });
