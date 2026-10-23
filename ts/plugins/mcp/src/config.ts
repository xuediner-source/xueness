/** Layered configuration validation and adaptation to the existing MCP server format. */
import { resolve } from "node:path";
import { isDict } from "@xueness/contracts";
import { checkedUrl } from "./http.ts";
import { validName, type Row } from "./names.ts";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./rpc.ts";

const FIELDS = new Set(["id", "enabled", "type", "transport", "command", "args", "cwd", "env", "url", "headersEnv", "timeout", "timeoutMs", "protocolVersion", "elicitation", "allowLoopbackHttp", "oauth", "isolation"]);
const TRANSPORTS = new Set(["stdio", "http", "streamable-http", "sse"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fail(field: string): never { throw new TypeError(`invalid MCP runtime configuration: ${field}`); }

function stringMap(value: unknown, field: string, headers = false): void {
  if (!isDict(value)) fail(field);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || (headers ? !["authorization", "x-api-key"].includes(key.toLowerCase()) || !ENV_NAME.test(entry) : !ENV_NAME.test(key))) fail(field);
  }
}

/** Validate patches as well as complete servers; required executable fields are checked after merging. */
export function validateRuntimeMcpServers(value: unknown): asserts value is Record<string, Row> {
  if (!isDict(value)) fail("servers");
  for (const [id, row] of Object.entries(value)) {
    if (!validName(id) || !isDict(row)) fail("server name or object");
    if (Object.keys(row).some(key => !FIELDS.has(key))) fail(`${id}: unsupported field`);
    if (row.id !== undefined && row.id !== id) fail(`${id}: id`);
    for (const field of ["enabled", "elicitation", "allowLoopbackHttp"] as const) if (row[field] !== undefined && typeof row[field] !== "boolean") fail(`${id}: ${field}`);
    for (const field of ["type", "transport"] as const) if (row[field] !== undefined && !TRANSPORTS.has(String(row[field]))) fail(`${id}: ${field}`);
    if (row.type !== undefined && row.transport !== undefined && row.type !== row.transport) fail(`${id}: transport conflict`);
    for (const field of ["command", "cwd", "url"] as const) if (row[field] !== undefined && (typeof row[field] !== "string" || !(row[field] as string).trim() || (row[field] as string).includes("\0"))) fail(`${id}: ${field}`);
    if (row.args !== undefined && (!Array.isArray(row.args) || row.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) fail(`${id}: args`);
    if (row.env !== undefined) stringMap(row.env, `${id}: env`);
    if (row.headersEnv !== undefined) stringMap(row.headersEnv, `${id}: headersEnv`, true);
    for (const field of ["timeout", "timeoutMs"] as const) if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isFinite(row[field]) || Number(row[field]) <= 0)) fail(`${id}: ${field}`);
    if (row.protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(row.protocolVersion))) fail(`${id}: protocolVersion`);
    if (row.isolation !== undefined && row.isolation !== "session") fail(`${id}: only session isolation is supported`);
    if (row.oauth !== undefined && !isDict(row.oauth)) fail(`${id}: oauth`);
    if (row.url !== undefined) checkedUrl(row);
  }
}

function merge(left: Row, right: Row): Row {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) result[key] = isDict(value) && isDict(result[key]) ? merge(result[key] as Row, value) : structuredClone(value);
  return result;
}

/** User resources remain the lower layer; explicit disabled entries remove that server for this run. */
export function mergeRuntimeMcpServers(base: readonly Row[], patches: Record<string, Row>, cwd: string): Row[] {
  validateRuntimeMcpServers(patches);
  const rows = new Map(base.map(row => [String(row.id), { ...row }]));
  for (const [id, patch] of Object.entries(patches)) {
    const normalized: Row = { ...patch, id };
    if (normalized.type !== undefined) { normalized.transport = normalized.type; delete normalized.type; }
    rows.set(id, merge(rows.get(id) ?? {}, normalized));
  }
  const result: Row[] = [];
  for (const [id, row] of rows) {
    if (row.enabled === false) continue;
    if (Object.hasOwn(patches, id)) {
      const transport = row.transport ?? row.type ?? "stdio";
      row.transport = transport; delete row.type;
      if (transport === "stdio") {
        if (typeof row.command !== "string" || !row.command.trim()) fail(`${id}: command required`);
        if (typeof row.cwd === "string") row.cwd = resolve(cwd, row.cwd);
      } else if (typeof row.url !== "string") fail(`${id}: url required`);
      if (row.timeoutMs !== undefined) { row.timeout = Number(row.timeoutMs) / 1000; delete row.timeoutMs; }
    }
    result.push(row);
  }
  return result.sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
}
