/**
 * The unified hook lifecycle surface (F07.03): the trust boundary between
 * trusted plugin hooks and workspace scripts, and the configuration summary
 * the UI reads.
 *
 * Three families share one runner, each behind its own gate:
 * - user hooks (`<state>/resources/hooks`) — operator-written, always run;
 * - plugin hooks — contributed in-process by a bundled plugin the host
 *   registered; trusted because the plugin shipped with the product, and
 *   gated by `<state>/hook-boundary.json` (`trustedPlugins: ["*"]` or an
 *   explicit id list; `[]` disables them all);
 * - workspace hooks — scripts inside the opened workspace; never trusted by
 *   origin, only per-declaration digest grants bound to a configuration
 *   revision (`revision.ts`), so a config change invalidates old grants.
 */
import { join } from "node:path";
import { isDict, isPyIntValue, pyJsonLoads } from "@xueness/contracts";
import { isLink, lexists, readCapped, utf8 } from "./files.ts";
import { isHookEvent, loadUserHooks, type Row } from "./load.ts";
import { authorizationRevision } from "./revision.ts";
import { featureStatus, statusDocument } from "./trust.ts";
import { canonicalWorkspace } from "./workspace.ts";

export const BOUNDARY_FILENAME = "hook-boundary.json";
export const BOUNDARY_MAX_BYTES = 4096;
export const BOUNDARY_SCHEMA_VERSION = 1;
export const MAX_BOUNDARY_PLUGINS = 64;
const PLUGIN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface HookBoundary { status: "ok" | "absent" | "corrupt"; trustedPlugins: string[]; trustsAll: boolean }

/** The explicit trusted-plugin boundary; absent means every bundled plugin (the `"*"` default). */
export function loadBoundary(stateDir: string): HookBoundary {
  const path = join(stateDir, BOUNDARY_FILENAME);
  if (!lexists(path)) return { status: "absent", trustedPlugins: ["*"], trustsAll: true };
  if (isLink(path)) return { status: "corrupt", trustedPlugins: [], trustsAll: false };
  const raw = readCapped(path, BOUNDARY_MAX_BYTES);
  const text = raw === null || raw.length > BOUNDARY_MAX_BYTES ? null : utf8(raw);
  if (text === null) return { status: "corrupt", trustedPlugins: [], trustsAll: false };
  let document: unknown;
  try { document = pyJsonLoads(text, { lossless: true }); } catch { return { status: "corrupt", trustedPlugins: [], trustsAll: false }; }
  if (!isDict(document) || Object.keys(document).length !== 2 || !isPyIntValue(document.schemaVersion) || Number(document.schemaVersion) !== BOUNDARY_SCHEMA_VERSION || !Array.isArray(document.trustedPlugins)) {
    return { status: "corrupt", trustedPlugins: [], trustsAll: false };
  }
  const ids = document.trustedPlugins.filter((id): id is string => typeof id === "string" && (id === "*" || PLUGIN_ID.test(id)));
  if (ids.length !== document.trustedPlugins.length || ids.length > MAX_BOUNDARY_PLUGINS || new Set(ids).size !== ids.length) {
    return { status: "corrupt", trustedPlugins: [], trustsAll: false };
  }
  return { status: "ok", trustedPlugins: ids, trustsAll: ids.includes("*") };
}

/** Whether the boundary admits hooks contributed by `plugin`. A corrupt boundary trusts no plugin. */
export function pluginTrusted(boundary: HookBoundary, plugin: string): boolean {
  if (boundary.status === "corrupt") return false;
  return boundary.trustsAll || boundary.trustedPlugins.includes(plugin);
}

export interface PluginHookContribution { plugin: string; rows: readonly Row[] }
export interface PluginHookView { plugin: string; id: string; event: string; admitted: boolean; reason: string }

/** The runner rows for trusted plugin contributions, and why each refusal happened. */
export function pluginHookRows(contributions: readonly PluginHookContribution[], boundary: HookBoundary): { hooks: Row[]; views: PluginHookView[] } {
  const hooks: Row[] = []; const views: PluginHookView[] = [];
  for (const { plugin, rows } of contributions) {
    const trusted = PLUGIN_ID.test(plugin) && pluginTrusted(boundary, plugin);
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id : "";
      const event = typeof row?.event === "string" ? row.event : "";
      if (!id || !isHookEvent(event) || typeof row.command !== "string" || !row.command) {
        views.push({ plugin, id, event, admitted: false, reason: "plugin_hook_invalid" });
        continue;
      }
      if (!trusted) { views.push({ plugin, id, event, admitted: false, reason: "plugin_not_trusted" }); continue; }
      const hook: Row = { id: `plugin:${plugin}:${id}`, event, command: row.command, source: "plugin", plugin };
      if (typeof row.matcher === "string" && row.matcher) hook.matcher = row.matcher;
      if (Array.isArray(row.args) && row.args.length) hook.args = [...row.args] as unknown[];
      if (typeof row.timeout === "number" && row.timeout > 0) hook.timeout = row.timeout;
      if (row.pipeline === true) hook.pipeline = true;
      hooks.push(hook);
      views.push({ plugin, id, event, admitted: true, reason: "plugin_trusted" });
    }
  }
  return { hooks, views };
}

export interface SummaryOptions { contributions?: readonly PluginHookContribution[] }

/**
 * The UI-facing configuration summary (F07.03): every hook family, the trust
 * boundary, the authorization revision and the derived UI state in one
 * document. Read-only; granting stays with the CLI and settings HTTP.
 */
export function configSummary(stateDir: string, root: unknown, options: SummaryOptions = {}): Row {
  const workspace = canonicalWorkspace(root);
  const feature = featureStatus(stateDir);
  const boundary = loadBoundary(stateDir);
  const plugin = pluginHookRows(options.contributions ?? [], boundary);
  const user = loadUserHooks(stateDir);
  const document = statusDocument(stateDir, root);
  const items = Array.isArray(document.items) ? document.items as Row[] : [];
  const enabled = items.filter((item) => item.enabled !== false);
  const counts = { trusted: enabled.filter((item) => item.trustState === "trusted").length,
    pending: enabled.filter((item) => item.trustState === "pending_trust").length,
    stale: enabled.filter((item) => item.trustState === "stale_trust").length };
  const uiState = !feature.enabled ? "feature_disabled" : workspace === null ? "no_workspace"
    : document.reason === "trust_store_corrupt" ? "trust_store_corrupt"
    : counts.stale ? "stale_trust" : counts.pending ? "pending_trust"
    : counts.trusted ? "trusted" : document.reason === "no_workspace_hooks" ? "no_workspace_hooks" : "no_enabled_hooks";
  return {
    workspace, featureEnabled: feature.enabled, featureStatus: feature.status,
    boundary: { status: boundary.status, trustedPlugins: boundary.trustedPlugins, workspaceScripts: "digest" },
    authorizationRevision: document.authorizationRevision ?? null,
    userHooks: user.map((row) => ({ id: row.id, event: row.event, enabled: row.enabled !== false })),
    pluginHooks: plugin.views,
    workspaceHooks: document,
    ui: { state: uiState, ...counts, pluginHooksAdmitted: plugin.views.filter((view) => view.admitted).length },
  };
}
