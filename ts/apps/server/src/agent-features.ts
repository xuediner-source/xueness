/** Product capabilities a run needs; the agent service refuses runs needing one it lacks. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonDumps, pyJsonLoads, pyLen } from "@xueness/contracts";
import type { AgentProvider, Row } from "@xueness/agent";
import { readRegularBeneath, type Session } from "@xueness/sessions";
import { loadMcpServers, pluginGrants } from "./mcp-servers.ts";
import { explicitOutputPaths, OFFICE_SUFFIXES, publicGoal, requestsFileOutput } from "@xueness/plugin-planning";
import { extname } from "node:path";

export interface FeatureSelection { stateDir: string; enabled(id: string): boolean; settings: Row; provider?: AgentProvider; extra?: readonly string[] }
function populated(directory: string): boolean { try { return readdirSync(directory).length > 0; } catch { return false; } }
function resources(state: string, kind: string): Row[] {
  let names: string[]; try { names = readdirSync(join(state, "resources", kind)).filter((name) => name.endsWith(".json")); } catch { return []; }
  const rows: Row[] = [];
  for (const name of names) {
    const read = readRegularBeneath(state, `resources/${kind}/${name}`, 128 * 1024); if (!read) continue;
    if (read.size > read.raw.length) { rows.push({ _unknown: true }); continue; }
    try { const item = pyJsonLoads(pyDecodeUtf8(read.raw)); if (isDict(item) && item.enabled !== false && typeof item.id === "string" && item.id.trim()) rows.push(item); } catch { /* Python skips malformed resource rows */ }
  }
  return rows;
}
function configuredHooks(state: string, root: string, legacy: boolean): boolean {
  const events = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"]);
  if (resources(state, "hooks").some((row) => row._unknown || events.has(String(row.event)) && typeof row.command === "string" && !!row.command.trim() && (legacy || row.pipeline === true))) return true;
  const read = readRegularBeneath(state, "workspace-hooks.json", 4096);
  if (!read || read.size > read.raw.length) return false;
  try {
    const feature = pyJsonLoads(pyDecodeUtf8(read.raw));
    return isDict(feature) && Object.keys(feature).join(",") === "enabled" && feature.enabled === true
      && [join(root, ".xueness", "hooks.json"), join(root, ".zcode", "config.json")].some(existsSync);
  } catch { return false; }
}
export function configuredAgentFeatures(session: Session, request: Row, options: FeatureSelection): string[] {
  const needed = new Set(options.extra ?? []);
  if ((request.permission_mode ?? request.permissionMode ?? session.permission_mode) === 'guarded') needed.add('planning.guarded');
  const enabled = (id: string): boolean => { try { return options.enabled(id); } catch { return false; } };
  const general = isDict(options.settings.general) ? options.settings.general : {};
  if (enabled("hooks") && configuredHooks(options.stateDir, String(session.root), !!(request.allow_hooks || request.allowHooks))) needed.add("hooks.commands");
  if (enabled("mcp") && (request.allow_mcp || request.allowMcp)) {
    // The TS mcp plugin serves the admitted servers; rejected entries are skipped (mcp-servers.ts).
    const mcp = loadMcpServers(options.stateDir, pluginGrants(request));
    if (mcp.configured) needed.add("mcp.connections");
  }
  if (enabled("subagents") && (request.allow_subagents || request.allowSubagents)) needed.add("subagents.tasks");
  if (session.remote_connection || request.remote) needed.add("remote.execution");
  if (enabled("planning") && publicGoal(session)) needed.add("planning.goal_driver");
  if (enabled("planning")) {
    const latest = (Array.isArray(session.messages) ? session.messages : []).filter(isDict).findLast((row) => row.role === "user")?.content;
    const task = String(session.task ?? "") + "\n" + (typeof latest === "string" ? latest : "");
    if (requestsFileOutput(task) || Array.isArray(session.delivery_requirements) && session.delivery_requirements.length) needed.add("planning.delivery");
    const paths = [...explicitOutputPaths(task), ...(Array.isArray(session.delivery_requirements) ? session.delivery_requirements.filter(isDict).flatMap((item) => typeof item.path === "string" ? [item.path] : []) : [])];
    if (enabled("office") && paths.some((path) => OFFICE_SUFFIXES.has(extname(path).toLowerCase()))) needed.add("office.delivery");
  }
  if (enabled("memory") && general.memoryEnabled !== false && process.env.XUENESS_MEMORY_ROOT?.trim()) needed.add("memory.context");
  if (enabled("skills") && (request.skill_catalog === true || session.skill_catalog === true || populated(join(options.stateDir, "resources", "skills"))
    || populated(join(options.stateDir, "skills")) || populated(join(String(session.root), ".xueness", "skills")) || populated(join(String(session.root), ".zcode", "skills")))) needed.add("skills.context");
  if (enabled("files")) {
    const root = resolve(String(session.root));
    const directories = new Set([root]);
    const results = isDict(session.results) ? Object.values(session.results) : [];
    for (const result of results) {
      if (!isDict(result) || result.ok !== true) continue;
      const data = isDict(result.data) ? result.data : result;
      if (typeof data.path !== "string") continue;
      let directory = dirname(resolve(root, data.path));
      while (!relative(root, directory).startsWith("..") && !isAbsolute(relative(root, directory))) {
        directories.add(directory); if (directory === root) break; directory = dirname(directory);
      }
    }
    if ([...directories].some((directory) => existsSync(join(directory, "AGENTS.md")))) needed.add("files.workspace_instructions");
  }
  if (enabled("providers") && !(isDict(session.semantic_compaction) && session.semantic_compaction.enabled === false)) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const users = messages.filter((row) => isDict(row) && row.role === "user" && !row._semantic_summary && row._input_kind !== "guide");
    let limit = Number(request.max_chars ?? request.maxChars ?? 24000);
    const tokens = request.max_tokens ?? request.maxTokens;
    if (typeof tokens === "number" && tokens > 0) limit = Math.min(limit, tokens * 2);
    const provider = options.provider;
    if (provider?.contextWindow) limit = Math.min(limit, Math.max(256, (provider.contextWindow - (provider.maxOutputTokens || Math.min(2048, Math.floor(provider.contextWindow / 4))) - 512) * 2));
    if (users.length >= 2 && pyLen(pyJsonDumps(messages, { separators: [",", ":"] })) > limit) needed.add("providers.semantic_compaction");
  }
  return [...needed];
}
