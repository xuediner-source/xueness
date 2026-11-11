/**
 * The MCP server definitions type for the host's general package import surface.
 *
 * An `.mcp.json` / `mcp.json` file lists servers under `mcpServers`. A server
 * definition names a command to start or a URL to call, so importing must
 * not make one live: every imported server is stored in this plugin's own
 * resource store switched off, tagged with the file it came from, and the
 * person reviews and enables each one on the MCP page. Nothing is started,
 * connected or checked by importing.
 *
 * Header values are credentials and are not imported; this plugin reads
 * credentials from environment variables named in `headersEnv`.
 *
 * The shape matches the import registry's importer contract structurally;
 * this plugin does not depend on the plugin that owns the registry.
 */
import { isDict } from "@xueness/contracts";
import { resourceDispatch } from "@xueness/sessions";
import { validateRuntimeMcpServers } from "./config.ts";
import { validName, type Row } from "./names.ts";

const TYPE = "mcp-servers";
const MAX_MANIFEST_BYTES = 256 * 1024, MAX_SERVERS = 32;
const refuse = (code: string, message: string, extra: Row = {}): Row => ({ ok: false, error: { code, message, ...extra } });
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const tagOf = (id: string): string => `${TYPE}:${id}`;

interface Parsed { id: string; fileName: string; servers: Row[]; skipped: { name: string; reason: string }[]; droppedHeaders: number }

function document(body: Row): Row | null {
  const text = body.manifest;
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return null;
  try { const value = JSON.parse(text.replace(/^﻿/, "")) as unknown; return isDict(value) && isDict(value.mcpServers) ? value : null; } catch { return null; }
}

function parse(body: Row): Parsed | Row {
  const value = document(body);
  if (!value) return refuse("invalid_manifest", "the file must be a JSON object with an mcpServers object, at most 256 KB");
  const fileName = typeof body.fileName === "string" ? body.fileName.replace(/\\/g, "/") : "";
  const id = slug(typeof body.id === "string" && body.id ? body.id : fileName.split("/").at(-2) ?? "") || "mcp-servers";
  const servers: Row[] = [], skipped: Parsed["skipped"] = [];
  let droppedHeaders = 0;
  for (const [name, raw] of Object.entries(value.mcpServers as Row).slice(0, MAX_SERVERS)) {
    if (!validName(name) || !isDict(raw)) { skipped.push({ name: name.slice(0, 80), reason: "invalid_name" }); continue; }
    const row: Row = {};
    for (const field of ["command", "args", "cwd", "env", "url", "headersEnv", "timeout", "timeoutMs"]) if (raw[field] !== undefined) row[field] = raw[field];
    const transport = raw.transport ?? raw.type ?? (typeof raw.url === "string" ? "http" : "stdio");
    row.transport = transport;
    if (raw.headers !== undefined) droppedHeaders += 1;
    try {
      validateRuntimeMcpServers({ [name]: row });
      if (transport === "stdio" ? typeof row.command !== "string" : typeof row.url !== "string") throw new TypeError("incomplete");
    } catch { skipped.push({ name, reason: "invalid_definition" }); continue; }
    servers.push({ ...row, id: name });
  }
  if (!servers.length) return refuse("invalid_manifest", "the file defines no usable MCP server", { issues: skipped.map(item => ({ path: item.name, message: item.reason })) });
  return { id, fileName, servers, skipped, droppedHeaders };
}

/** What starting or calling this server would do, shown before anything is saved; environment values are never shown. */
function row(server: Row): Row {
  const env = isDict(server.env) ? Object.keys(server.env) : [];
  const line = server.transport === "stdio" ? [server.command, ...(Array.isArray(server.args) ? server.args : [])].join(" ") : String(server.url ?? "");
  return { name: String(server.id), body: line.slice(0, 600), chips: [{ text: String(server.transport) }, ...(server.enabled === true ? [{ text: "已启用" }] : []), ...(env.length ? [{ text: `env: ${env.join(", ")}`.slice(0, 120) }] : [])] };
}

const view = (id: string, servers: readonly Row[]) => ({ id, version: "", name: id, description: "", author: "", facts: [],
  counts: [{ label: "MCP 服务器", count: servers.length }], sections: [{ title: "MCP 服务器", rows: servers.map(row) }] });

export function mcpPackageImporter(options: { stateDir: string }) {
  const stored = (): Row[] => {
    const reply = resourceDispatch(options.stateDir, "GET", ["api", "resources", "mcp"], {});
    return reply && reply[0] === 200 && Array.isArray(reply[1].items) ? reply[1].items.filter(isDict) : [];
  };
  const mine = (id: string): Row[] => stored().filter(item => item.sourcePackage === tagOf(id));
  return {
    type: TYPE, owner: "mcp", name: "MCP 服务器定义", nameEn: "MCP server definitions", manifestNames: [".mcp.json", "mcp.json"],
    detect: (body: Row): boolean => document(body) !== null,
    list(): Row[] {
      const groups = new Map<string, Row[]>();
      for (const item of stored()) {
        if (typeof item.sourcePackage !== "string" || !item.sourcePackage.startsWith(TYPE + ":")) continue;
        const id = item.sourcePackage.slice(TYPE.length + 1);
        groups.set(id, [...(groups.get(id) ?? []), item]);
      }
      return [...groups].sort(([a], [b]) => a < b ? -1 : 1).map(([id, servers]) => ({ ...view(id, servers), status: "ok", fileName: typeof servers[0]!.sourceFile === "string" ? servers[0]!.sourceFile : "" }));
    },
    preview(body: Row): Row {
      const parsed = parse(body);
      if (!("servers" in parsed)) return parsed;
      const { id, servers, skipped, droppedHeaders } = parsed as Parsed;
      const existing = new Map(stored().map(item => [String(item.id), item]));
      const taken = servers.filter(server => { const found = existing.get(String(server.id)); return found && found.sourcePackage !== tagOf(id); }).map(server => String(server.id));
      return { ok: true, preview: { ...view(id, servers), replaces: mine(id).length ? "" : null, missing: [], blocked: taken.length === servers.length, notes: [
        { tone: "warn", text: "导入的服务器默认关闭，不会启动或连接。请在 MCP 服务器页面逐个检查命令后再启用。" },
        ...(taken.length ? [{ tone: "danger", text: "已有同名的 MCP 服务器，不会覆盖：{0}", args: [taken.join("、")] }] : []),
        ...(skipped.length ? [{ tone: "warn", text: "有 {0} 个定义无效，已跳过：{1}", args: [String(skipped.length), skipped.map(item => item.name).join("、")] }] : []),
        ...(droppedHeaders ? [{ tone: "warn", text: "有 {0} 个服务器带有请求头凭据，不会导入；请改用环境变量（headersEnv）。", args: [String(droppedHeaders)] }] : []),
      ] } };
    },
    install(body: Row): Row {
      const parsed = parse(body);
      if (!("servers" in parsed)) return parsed;
      const { id, fileName, servers } = parsed as Parsed;
      const previous = mine(id);
      if (previous.length && body.replace !== true) return refuse("already_imported", `MCP definitions ${id} are already imported`);
      const existing = new Map(stored().map(item => [String(item.id), item]));
      const written: Row[] = [];
      for (const server of servers) {
        const found = existing.get(String(server.id));
        if (found && found.sourcePackage !== tagOf(id)) continue;
        // A replaced definition is switched off again: the command may have changed.
        const reply = resourceDispatch(options.stateDir, "POST", ["api", "resources", "mcp"], { ...server, enabled: false, sourcePackage: tagOf(id), sourceFile: fileName.slice(0, 300) });
        if (reply && reply[0] === 200) written.push({ ...server, enabled: false });
      }
      if (!written.length) return refuse("install_failed", "no server could be saved; servers with the same names already exist");
      for (const old of previous) if (!written.some(server => server.id === old.id)) resourceDispatch(options.stateDir, "DELETE", ["api", "resources", "mcp", String(old.id)], {});
      return { ok: true, item: { ...view(id, written), status: "ok", fileName } };
    },
    remove(id: unknown): Row {
      const servers = typeof id === "string" ? mine(id) : [];
      if (!servers.length) return refuse("not_found", `MCP definitions ${String(id)} are not imported`);
      for (const server of servers) resourceDispatch(options.stateDir, "DELETE", ["api", "resources", "mcp", String(server.id)], {});
      return { ok: true };
    },
  };
}
