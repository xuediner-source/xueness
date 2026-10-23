/**
 * Which MCP servers a run would connect (Python `mcp.load`) and whether the
 * TypeScript plugin can serve them. Read-only: links are refused, one broken
 * entry only costs that entry, servers come back id ascending.
 *
 * OAuth bearer and elicitation are served here. The Python executor keeps a
 * run when ids repeat, when an entry cannot be read in full, or when a plugin
 * manifest that names mcp cannot be read.
 * A readable manifest is `plugin_sdk.plan`: a refusal drops the servers
 * (Python would not activate mcp either) and an acceptance leaves them native.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonLoads } from "@xueness/contracts";
import { validName, mergeRuntimeMcpServers } from "@xueness/plugin-mcp";
import { readRegularBeneath } from "@xueness/sessions";
import { planPlugins } from "./mcp-plan.ts";

type Row = Record<string, unknown>;
const MAX_ENTRY = 1024 * 1024;
const HTTP_TRANSPORTS = new Set(["http", "streamable-http", "sse"]);

/** `configured`: a run with `allow_mcp` has MCP work to do (a server, or an entry too large to judge). */
export interface McpServers { servers: Row[]; configured: boolean; native: boolean; reasons: string[] }

function isLinkOrJunction(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** `*.json` entry names as Python's `sorted(dir.glob("*.json"))` sees them (pathlib matches dotfiles too). */
function jsonEntries(directory: string): string[] | null {
  if (isLinkOrJunction(directory)) return null;
  let names: string[];
  try { names = readdirSync(directory); } catch { return null; }
  const windows = process.platform === "win32";
  return names.filter((name) => (windows ? name.toLowerCase().endsWith(".json") : name.endsWith(".json")) && !name.includes("/") && !name.includes("\\"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readEntry(stateDir: string, relative: string): { item: Row | null; partial: boolean } {
  let read: { raw: Buffer; size: number } | null;
  try { read = readRegularBeneath(stateDir, relative, MAX_ENTRY); } catch { return { item: null, partial: false }; }
  if (!read) return { item: null, partial: false };
  if (read.size > read.raw.length) return { item: null, partial: true };
  try {
    const value = pyJsonLoads(pyDecodeUtf8(read.raw));
    return { item: isDict(value) ? value : null, partial: false };
  } catch { return { item: null, partial: false }; }
}

/** `partial` when a plugin manifest cannot be read in full; `present` when one names mcp. */
function manifestGate(stateDir: string): "partial" | "present" | "absent" {
  if (isLinkOrJunction(join(stateDir, "resources"))) return "absent";
  const names = jsonEntries(join(stateDir, "resources", "plugins")) ?? [];
  let present = false;
  for (const name of names) {
    const { item, partial } = readEntry(stateDir, `resources/plugins/${name}`);
    if (partial) return "partial";
    if (item?.builtin === "mcp") present = true;
  }
  return present ? "present" : "absent";
}

/** Grants from a run request (`grant_plugin_capability` / `grantPluginCapability`). */
export function pluginGrants(request: { grant_plugin_capability?: unknown; grantPluginCapability?: unknown }): string[] {
  const raw = request.grant_plugin_capability ?? request.grantPluginCapability;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

export function loadMcpServers(stateDir: string, grants: readonly unknown[] = [], patches: Record<string, Row> = {}, cwd = process.cwd()): McpServers {
  const reasons: string[] = [];
  if (isLinkOrJunction(join(stateDir, "resources"))) return { servers: [], configured: false, native: true, reasons };
  const names = jsonEntries(join(stateDir, "resources", "mcp")) ?? [];
  const servers: Row[] = [];
  for (const name of names) {
    const { item, partial } = readEntry(stateDir, `resources/mcp/${name}`);
    if (partial) { reasons.push("entry too large"); continue; }
    if (!item || !validName(item.id) || item.enabled === false) continue;
    const command = item.command;
    if (!(typeof command === "string" && command.trim()) && !(HTTP_TRANSPORTS.has(String(item.transport)) && typeof item.url === "string")) continue;
    servers.push({ ...item, id: item.id });
  }
  servers.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const ids = servers.map((server) => String(server.id));
  if (new Set(ids).size !== ids.length) reasons.push("duplicate server id");
  for (const server of servers) {
    const stdio = !HTTP_TRANSPORTS.has(String(server.transport));
    if (stdio && Array.isArray(server.args) && server.args.some((part) => typeof part !== "string")) reasons.push(`${server.id}: non-string args`);
  }
  let admitted = mergeRuntimeMcpServers(servers, patches, cwd);
  if (admitted.length) {
    const gate = manifestGate(stateDir);
    if (gate === "partial") reasons.push("plugin manifest governs mcp");
    else if (gate === "present" && !planPlugins(stateDir, ["mcp"], grants).load.includes("mcp")) admitted = [];
  }
  return { servers: admitted, configured: admitted.length > 0 || reasons.includes("entry too large"), native: !reasons.length, reasons };
}
