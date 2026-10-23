/**
 * `hooks` trust/workspace and `mcp` / `mcp-check` (Python `hooks_cli`,
 * `mcp/command_cli` and `mcp/operator_cli`). MCP connections are explicit:
 * each check starts and closes its own client.
 */
import { join } from "node:path";
import { isDict } from "@xueness/contracts";
import { canonicalWorkspace, discover, featureStatus, grantTrust, revokeTrust, setFeature, statusDocument, TRUST_FILENAME } from "@xueness/plugin-hooks";
import { checkServer, loadServers } from "@xueness/plugin-mcp";
import { isLink, jsonEntries, readJsonObject, resourceKindDir } from "@xueness/sessions";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, out, workspacePath } from "./host.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const HOOKS_USAGE = "Usage:\n  xueness hooks trust status [--workspace PATH] [--json]\n  xueness hooks trust review [--workspace PATH] [--json]\n  xueness hooks trust grant --workspace PATH (--hook-digest <sha256> ... | --all-current --bundle-digest <sha256>)\n  xueness hooks trust revoke --workspace PATH (--hook-digest <sha256> ... | --all)\n  xueness hooks workspace on|off|show [--json]\n";
const MAX_STATUS_PROBES = 8, TARGET_MAX = 200;
const USAGE_ZH = "用法: /mcp list | status [id] | connect <id> | disconnect <id>", USAGE_EN = "Usage: /mcp list | status [id] | connect <id> | disconnect <id>";
const LABELS = {
  zh: { servers: "MCP 服务器", enabled: "已启用", disabled: "已停用", empty: "未配置 MCP 服务器。可在设置页添加，或用 xueness resources create mcp <id> --body-file <config.json>。", hint: "实时连接状态与工具: /mcp status；显式连接: /mcp connect <id>；断开: /mcp disconnect <id>", connected: "已连接", failed: "连接失败", protocol: "协议", tools: "工具", not_found: "未找到已启用的 MCP 服务器: %s", unknown: "未知子命令: %s", released: "已断开并释放连接。", no_persistent: "未持有常驻连接。Xueness 的 MCP 连接按运行轮创建，随每轮结束自动关闭；下一轮将按当前配置重新连接。", truncated: "(一次最多检查 %d 个已启用服务器，其余用 /mcp status <id> 单独查看)" },
  en: { servers: "MCP servers", enabled: "enabled", disabled: "disabled", empty: "No MCP servers configured. Add one in the settings page, or xueness resources create mcp <id> --body-file <config.json>.", hint: "Live connection status and tools: /mcp status; connect: /mcp connect <id>; disconnect: /mcp disconnect <id>", connected: "connected", failed: "connection failed", protocol: "protocol", tools: "tools", not_found: "enabled MCP server not found: %s", unknown: "unknown subcommand: %s", released: "Disconnected and released.", no_persistent: "No persistent connection is held. Xueness scopes MCP connections to a single run and closes them with it; the next run reconnects from the current configuration.", truncated: "(at most %d enabled servers are probed per call; check the rest with /mcp status <id>)" },
};
const labels = (language: unknown) => language === "en" ? LABELS.en : LABELS.zh;
const fill = (template: string, value: unknown): string => template.replace(/%[sd]/, String(value));

export function register(sub: Sub): void {
  const hooks = sub.add("hooks", "workspace hook discovery, review and digest trust").subparsers("hooks_action", true);
  const verbs = hooks.add("trust", "review and grant workspace hook trust").subparsers("trust_action");
  for (const [verb, help] of [["status", "trust state for one workspace"], ["review", "every declaration with its trust state"]] as const) {
    verbs.add(verb, help).add("--workspace", { default: null, help: "workspace to inspect (default: current directory)" }).add("--json", { action: "store_true", help: "machine-readable output on stdout" });
  }
  const common = (parser: Parser): Parser => parser.add("--workspace", { required: true, help: "workspace the records belong to" }).add("--json", { action: "store_true", help: "machine-readable output on stdout" });
  const grant = common(verbs.add("grant", "trust specific declarations by digest"));
  grant.add("--hook-digest", { action: "append", default: [], metavar: "SHA256", help: "declaration digest to trust (repeatable)" });
  grant.add("--all-current", { action: "store_true", help: "trust every currently enabled declaration" });
  grant.add("--bundle-digest", { default: null, metavar: "SHA256", help: "bundle digest captured at review time; refuses on mismatch" });
  const revoke = common(verbs.add("revoke", "drop trust records for one workspace"));
  revoke.add("--hook-digest", { action: "append", default: [], metavar: "SHA256", help: "declaration digest to revoke (repeatable)" });
  revoke.add("--all", { action: "store_true", help: "revoke every record for this workspace" });
  hooks.add("workspace", "enable or disable workspace hooks (default: off)").add("toggle", { choices: ["on", "off", "show"] }).add("--json", { action: "store_true" });
  sub.add("mcp-check", "explicitly connect to an enabled MCP server and list tools").add("id").add("--root", { default: process.cwd() });
  const mcp = sub.add("mcp", "list configured MCP servers and connect or disconnect explicitly").subparsers("mcp_action");
  for (const [name, help] of [["list", "configured servers and their transport/target"], ["status", "explicit bounded connection check (starts the server)"], ["connect", "explicitly connect to one enabled server and list tools"], ["disconnect", "release one server's pooled client, if any"]] as const) {
    const action = mcp.add(name, help);
    if (name !== "list") action.add("id", { ...(name === "status" ? { nargs: "?" as const } : {}), help: "one enabled server id (status default: every enabled server)" });
    action.add("--root", { default: null, help: "workspace used as the stdio server cwd (default: current directory)" }).add("--json", { action: "store_true", help: "machine-readable output on stdout" });
  }
}

export async function execute(cli: Cli): Promise<number | null> {
  const a = cli.args;
  if (a.cmd === "hooks") {
    try {
      if (a.hooks_action === "trust") {
        const verb = a.trust_action ?? "status";
        if (verb === "status" || verb === "review") return emit(cli, statusDocument(cli.state, workspacePath(a.workspace)));
        if (verb === "grant") return grant(cli);
        if (verb === "revoke") return revoke(cli);
      }
      if (a.hooks_action === "workspace") return workspaceToggle(cli);
    } catch (error) { return fail(cli, error instanceof Error ? error.message : String(error)); }
    err(HOOKS_USAGE);
    return 1;
  }
  if (a.cmd === "mcp-check") {
    try { out(dumps(await checkServer(cli.state, a.id, String(a.root)), 2)); return 0; }
    catch (error) { err("ERROR: " + (error instanceof Error ? error.message : String(error))); return 1; }
  }
  if (a.cmd !== "mcp") return null;
  const action = a.mcp_action ?? "list";
  let result: Row;
  try { result = await mcpRun(cli.state, a.id ? `${action} ${a.id}` : action, a.root ?? null, cli.language); }
  catch (error) { err("ERROR: " + (error instanceof Error ? error.message : String(error))); return 1; }
  if (a.json) { out(dumps(result.document ?? result.text, 2)); return 0; }
  out(result.text);
  const results = isDict(result.document) ? result.document.results : null;
  if ((result.action === "status" || result.action === "connect") && isDict(result.document)) return Array.isArray(results) && results.length && results.every((item: Row) => item.ok) ? 0 : 1;
  return 0;
}

function emit(cli: Cli, document: Row): number {
  out(cli.args.json ? dumps(document, 2) : formatStatus(document));
  return 0;
}

function fail(cli: Cli, reason: string): number {
  if (cli.args.json) out(dumps({ accepted: false, reason }));
  else err("ERROR: " + reason);
  return 1;
}

function formatStatus(document: Row): string {
  const hints: Row = { pending_trust: "pending trust", trusted: "trusted", trust_store_corrupt: "trust store corrupt" };
  const lines = ["Workspace hook trust", `workspace: ${document.workspace || "(none)"}`, `feature: ${document.featureEnabled ? "enabled" : "disabled"}`, `bundle: ${document.bundleDigest || "none"}`, `trust store: ${document.trustStatus ?? "unknown"}`, `state: ${hints[document.reason] ?? (document.reason || "unknown")}`];
  const items: Row[] = document.items || [];
  if (!items.length) lines.push("No workspace hook declarations found.");
  items.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.trustState}] [${item.enabled ? "enabled" : "disabled"}] ${item.event}${item.matcher ? " / " + item.matcher : ""}`);
    lines.push("   " + item.command, `   source: ${item.sourcePath} (${item.source})`, "   digest: " + item.digest);
  });
  if (document.reason === "pending_trust") lines.push("Grant exact declarations with:", "  xueness hooks trust grant --workspace <path> --hook-digest <sha256>", "Or trust every currently enabled declaration in this exact bundle with:", "  xueness hooks trust grant --workspace <path> --all-current --bundle-digest " + document.bundleDigest);
  if (document.reason === "trust_store_corrupt") lines.push("The persistent trust store is corrupt; grant/revoke are rejected until it is repaired.", "Nothing was trusted and nothing was rewritten: " + (document.corruptPath || TRUST_FILENAME), "Recovery: repair that file by hand, restore it from backup, or remove it so a fresh store is created, then re-run grant.");
  const diagnostics: Row[] = document.diagnostics || [];
  if (diagnostics.length) {
    lines.push("", `Diagnostics (${diagnostics.length})`);
    for (const item of diagnostics) lines.push(`- [${item.severity}] ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ""}`);
  }
  return lines.join("\n");
}

function grant(cli: Cli): number {
  const a = cli.args, digests = [...new Set<string>(a.hook_digest ?? [])], allCurrent = Boolean(a.all_current);
  if (allCurrent === Boolean(digests.length)) return fail(cli, "specify exactly one of --hook-digest or --all-current");
  if (allCurrent && !a.bundle_digest) return fail(cli, "--all-current requires --bundle-digest");
  if (!featureStatus(cli.state).enabled) return fail(cli, "feature_disabled");
  const workspace = canonicalWorkspace(workspacePath(a.workspace));
  const found = discover(workspace);
  if (!found.hooks.length) return fail(cli, "no_workspace_hooks");
  if (found.bundleDigest && a.bundle_digest && a.bundle_digest !== found.bundleDigest) return fail(cli, "bundle_changed");
  let selected: Row[];
  if (allCurrent) {
    selected = found.hooks.filter((row) => row.enabled);
    if (!selected.length) return fail(cli, "no_enabled_hooks");
  } else {
    const byDigest = new Map(found.hooks.map((row) => [row.digest, row]));
    const missing = digests.filter((digest) => !byDigest.has(digest));
    if (missing.length) return fail(cli, "digest_mismatch: " + missing.join(", "));
    selected = digests.map((digest) => byDigest.get(digest)!);
  }
  const outcome = grantTrust(cli.state, String(workspace), selected);
  if (!outcome.ok) return fail(cli, String(outcome.reason));
  return emit(cli, { ...statusDocument(cli.state, a.workspace), granted: outcome.granted });
}

function revoke(cli: Cli): number {
  const a = cli.args, digests = [...new Set<string>(a.hook_digest ?? [])], all = Boolean(a.all);
  if (all === Boolean(digests.length)) return fail(cli, "specify exactly one of --hook-digest or --all");
  const workspace = canonicalWorkspace(workspacePath(a.workspace));
  const outcome = revokeTrust(cli.state, String(workspace), digests, all);
  if (!outcome.ok) return fail(cli, String(outcome.reason));
  return emit(cli, { ...statusDocument(cli.state, a.workspace), revoked: outcome.removed });
}

function workspaceToggle(cli: Cli): number {
  const toggle = cli.args.toggle ?? "show";
  if (toggle === "on" || toggle === "off") {
    try { setFeature(cli.state, toggle === "on"); } catch (error) { return fail(cli, error instanceof Error ? error.message : String(error)); }
  }
  const document = { workspace: workspacePath(null), enabled: featureStatus(cli.state).enabled };
  out(cli.args.json ? dumps(document, 2) : `Workspace hooks ${document.enabled ? "enabled" : "disabled"}`);
  return 0;
}

const transport = (server: Row): string => ["http", "streamable-http", "sse"].includes(server.transport) ? server.transport : "stdio";
function target(server: Row): string {
  if (transport(server) === "stdio") {
    const command = server.command;
    if (typeof command !== "string" || !command.trim()) return "-";
    const args = server.args;
    return Array.isArray(args) && args.length ? Array.from([command, ...args.map(String)].join(" ")).slice(0, TARGET_MAX).join("") : command;
  }
  return typeof server.url === "string" && server.url ? Array.from(server.url).slice(0, TARGET_MAX).join("") : "-";
}

/** `configured_servers`: every stored MCP item with an id, enabled or not. */
function serverRows(stateDir: string): Row[] {
  let directory: string;
  try { directory = resourceKindDir(stateDir, "mcp"); } catch { return []; }
  if (isLink(directory)) return [];
  const rows: Row[] = [];
  for (const name of jsonEntries(directory)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = readJsonObject(path);
    if (item && typeof item.id === "string" && item.id) rows.push(item);
  }
  rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return rows.map((item) => ({ id: item.id, name: typeof item.name === "string" ? item.name : null, transport: transport(item), target: target(item), enabled: item.enabled !== false, timeout: typeof item.timeout === "number" ? item.timeout : null }));
}

function formatListing(rows: Row[], language: unknown): string {
  const label = labels(language);
  if (!rows.length) return label.empty;
  const lines = [`${label.servers} (${rows.length})`];
  for (const row of rows) lines.push(`- ${row.id}${row.name ? ` (${row.name})` : ""} [${row.transport}] ${row.enabled ? label.enabled : label.disabled}: ${row.target}`);
  lines.push(label.hint);
  return lines.join("\n");
}

function formatMcpStatus(document: Row, language: unknown): string {
  const label = labels(language), lines: string[] = [];
  for (const result of document.results) {
    if (result.ok) {
      const tools: unknown[] = result.tools || [];
      lines.push(`${result.id}: ${label.connected}（${label.protocol} ${result.protocol || "-"}，${label.tools} ${tools.length}）`, "  " + (tools.length ? tools.slice(0, 32).map(String).join(", ") : "-"));
    } else lines.push(`${result.id}: ${label.failed} (${result.error || "connection failed"})`);
  }
  if (document.truncated) lines.push(fill(label.truncated, MAX_STATUS_PROBES));
  return lines.join("\n");
}

const failed = (id: string): Row => ({ id, ok: false, protocol: null, tools: [], error: "connection failed" });

/** `command_cli.run`: list, bounded status probes, one explicit connect, or a disconnect note. */
export async function mcpRun(stateDir: string, argument: string, root: string | null, language: unknown): Promise<Row> {
  const label = labels(language), text = argument.trim(), space = text.search(/\s/);
  const action = (space < 0 ? text : text.slice(0, space)).toLowerCase(), rest = space < 0 ? "" : text.slice(space + 1).trim();
  const usage = language !== "en" ? USAGE_ZH : USAGE_EN, cwd = workspacePath(root);
  if (action === "" || action === "list") {
    if (rest) throw new Error(usage);
    const rows = serverRows(stateDir);
    return { action: "list", document: rows, text: formatListing(rows, language) };
  }
  if (action === "status") {
    const servers = loadServers(stateDir);
    if (rest && !servers.some((server) => server.id === rest)) throw new Error(fill(label.not_found, rest));
    const targets = rest ? [rest] : servers.map((server) => String(server.id)).slice(0, MAX_STATUS_PROBES);
    const results: Row[] = [];
    for (const id of targets) results.push(await checkServer(stateDir, id, cwd).catch(() => failed(id)));
    const document = { probed: targets.length, truncated: !rest && servers.length > MAX_STATUS_PROBES, results };
    return { action: "status", document, text: formatMcpStatus(document, language) };
  }
  if (action === "connect") {
    if (!rest) throw new Error(usage);
    if (!loadServers(stateDir).some((server) => server.id === rest)) throw new Error(fill(label.not_found, rest));
    const checked = await checkServer(stateDir, rest, cwd).catch(() => null);
    const result = checked && Object.hasOwn(checked, "protocol") ? { id: rest, ok: checked.ok, protocol: checked.protocol ?? null, tools: checked.tools, error: checked.error } : failed(rest);
    const document = { results: [result], truncated: false };
    return { action: "connect", document, text: formatMcpStatus(document, language) };
  }
  if (action === "disconnect") {
    if (!rest) throw new Error(usage);
    const result = { id: rest, released: false, detail: label.no_persistent };
    return { action: "disconnect", document: result, text: result.detail };
  }
  throw new Error(fill(label.unknown, action));
}
