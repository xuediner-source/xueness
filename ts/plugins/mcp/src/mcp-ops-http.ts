/**
 * MCP OAuth, resource/prompt catalog routes and POST /api/mcp/check (Python
 * `lifecycle.dispatch`, and `operations_api` + `diagnostics.check_mcp`).
 * Catalog requests start the configured server once per confirmed request.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDict } from "@xueness/contracts";
import { Context } from "@xueness/kernel";
import { isLink, pyCodeCompare, readJsonObject, resourceKindDir } from "@xueness/sessions";
import { McpClient } from "./client.ts";
import { validName, type Row } from "./names.ts";
import { oauthBegin, oauthFinish, oauthRevoke, oauthStatus } from "./oauth.ts";

export interface McpOpsOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
  projectDir: string;
  webRuns: string;
  allowedRoots(): readonly string[];
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
const HTTP = new Set(["http", "streamable-http", "sse"]);

function suppressed(): Reply {
  return [400, { error: "MCP request failed (details suppressed)" }];
}

export function loadServers(stateDir: string): Row[] {
  let directory: string;
  try { directory = resourceKindDir(stateDir, "mcp"); } catch { return []; }
  if (isLink(directory)) return [];
  try { if (!statSync(directory).isDirectory()) return []; } catch { return []; }
  const windows = process.platform === "win32";
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const servers: Row[] = [];
  for (const name of names.filter((item) => (windows ? item.toLowerCase().endsWith(".json") : item.endsWith(".json"))).sort(pyCodeCompare)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = readJsonObject(path);
    if (!item || !validName(item.id) || item.enabled === false) continue;
    const command = item.command;
    if (!(typeof command === "string" && command.trim()) && !(HTTP.has(String(item.transport)) && typeof item.url === "string")) continue;
    servers.push({ ...item, id: item.id });
  }
  return servers.sort((left, right) => pyCodeCompare(String(left.id), String(right.id)));
}

function fencedRoot(value: unknown, roots: readonly string[]): string {
  if (typeof value !== "string" || !value) throw new TypeError("workspace root is required");
  const target = resolve(value);
  const allowed = roots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw new TypeError("workspace root not permitted");
  return target;
}

export async function checkServer(stateDir: string, serverId: unknown, root: string): Promise<Row> {
  const server = loadServers(stateDir).find((item) => item.id === serverId);
  if (!server) throw new TypeError("enabled MCP server not found");
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-mcp-check-"));
  let ctx: Context | null = null;
  let client: McpClient | null = null;
  try {
    ctx = Context.create({ roots: { workspace: [root], state: stateDir, temp: artifacts } });
    client = new McpClient(ctx, { ...server, _state_dir: stateDir }, root);
    await client.start();
    if (client.error) return { ok: false, id: serverId, error: "connection failed" };
    const tools = await client.listTools();
    return {
      ok: !client.error, id: serverId, protocol: client.negotiatedVersion,
      tools: tools.map((tool) => typeof tool.name === "string" ? tool.name : ""),
      error: client.error ? "tool discovery failed" : null,
    };
  } finally {
    await client?.close().catch(() => {});
    await ctx?.dispose().catch(() => {});
    rmSync(artifacts, { recursive: true, force: true });
  }
}

const CATALOG = new Set(["resources", "prompts"]);
/** Python `lifecycle.dispatch` catalog branch: one confirmed connection per request. */
async function catalogRequest(stateDir: string, server: Row, cwd: string, kind: "resources" | "prompts", read: boolean, body: Row): Promise<Row> {
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-mcp-catalog-"));
  let ctx: Context | null = null;
  let client: McpClient | null = null;
  try {
    ctx = Context.create({ roots: { workspace: [cwd], state: stateDir, temp: artifacts } });
    client = new McpClient(ctx, { ...server, _state_dir: stateDir }, cwd);
    if (!await client.start() || client.error) throw new Error("MCP connection failed");
    return read ? { result: await client.read(kind, body.key, body.arguments) } : { [kind]: await client.catalog(kind) };
  } finally {
    await client?.close().catch(() => {});
    await ctx?.dispose().catch(() => {});
    rmSync(artifacts, { recursive: true, force: true });
  }
}

export function createMcpOpsHttp(o: McpOpsOptions) {
  const owns = (method: string, parts: readonly string[]): boolean => {
    void method;
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "mcp" && parts[2] === "check") return true;
    if ((parts.length === 4 || parts.length === 5) && parts[0] === "api" && parts[1] === "mcp" && CATALOG.has(parts[3] ?? "") && (parts.length === 4 || parts[4] === "read")) return true;
    return (parts.length === 4 || parts.length === 5) && parts[0] === "api" && parts[1] === "mcp" && parts[3] === "oauth";
  };
  return {
    routes: ["GET /api/mcp/:id/oauth", "POST /api/mcp/:id/oauth/start", "POST /api/mcp/:id/oauth/finish", "POST /api/mcp/:id/oauth/revoke", "POST /api/mcp/check", "POST /api/mcp/:id/resources", "POST /api/mcp/:id/prompts", "POST /api/mcp/:id/resources/read", "POST /api/mcp/:id/prompts/read"],
    owns,
    async dispatch(method: string, parts: string[], _query: Query, data: unknown): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!o.enabled("mcp")) return [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }];
      const verb = method.toUpperCase();
      if (parts.length === 3) {
        try {
          if (verb !== "POST") return [405, { error: "method not allowed" }];
          // A non-mapping body is Python's AttributeError on `data.get` (500), not the approval 400.
          if (!isDict(data)) throw new Error("attribute");
          if (data.connect !== true) return [400, { error: "explicit connect approval required" }];
          if (o.stateDir === null) throw new TypeError("state_dir missing");
          const root = fencedRoot(data.root, [o.webRuns, o.projectDir, ...o.allowedRoots()]);
          return [200, await checkServer(o.stateDir, data.id, root)];
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) return [400, { error: "invalid operation, plan, approval or workspace" }];
          throw error;
        }
      }
      if (o.stateDir === null) return suppressed();
      const server = loadServers(o.stateDir).find((item) => item.id === parts[2]);
      if (!server) return [404, { error: "MCP server not found" }];
      try {
        if (CATALOG.has(parts[3]!) && verb === "POST") {
          // Starting a configured process/server is an explicit operator act; a non-mapping body is suppressed like Python's AttributeError.
          if (!isDict(data)) return suppressed();
          if (data.confirmed !== true) return [400, { error: "confirm MCP request first" }];
          return [200, await catalogRequest(o.stateDir, server, o.projectDir, parts[3] as "resources" | "prompts", parts.length === 5, data)];
        }
        if (parts[3] === "oauth" && parts.length === 4 && verb === "GET") return [200, oauthStatus(o.stateDir, String(server.id))];
        if (parts.length === 5 && verb === "POST" && parts[4] === "start") return [200, await oauthBegin(o.stateDir, server)];
        if (parts.length === 5 && verb === "POST" && parts[4] === "finish") {
          const body = isDict(data) ? data : {};
          return [200, await oauthFinish(o.stateDir, server, body.code, body.state)];
        }
        if (parts.length === 5 && verb === "POST" && parts[4] === "revoke") return [200, await oauthRevoke(o.stateDir, String(server.id))];
        return [405, { error: "method not allowed" }];
      } catch { return suppressed(); }
    },
  };
}
