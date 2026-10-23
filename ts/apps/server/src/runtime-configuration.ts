/** Host assembly for data-only configuration; validation remains with the owning plugins. */
import { formatSchemaIssues, validateSchema, type JsonSchema } from "@xueness/contracts";
import { loadRuntimeConfig, type RuntimeConfigPatch, type RuntimeConfigLoadResult } from "@xueness/plugin-settings";
import { loadShellConfig, shellConfig } from "@xueness/plugin-shell";
import { validateRuntimeMcpServers } from "@xueness/plugin-mcp";
import shellManifest from "../../../plugins/shell/manifest.json" with { type: "json" };

export function validateAgentRuntimeConfig(patch: RuntimeConfigPatch): void {
  for (const [id, config] of Object.entries(patch.plugins ?? {})) {
    if (id !== "shell") throw new TypeError("runtime configuration supports the shell plugin only");
    const issues = validateSchema(shellManifest.config.schema as JsonSchema, config);
    if (issues.length) throw new TypeError(formatSchemaIssues(issues));
  }
  if (patch.mcp?.servers !== undefined) validateRuntimeMcpServers(patch.mcp.servers);
}

export function legacyRuntimeConfig(stateDir: string): RuntimeConfigPatch {
  return { plugins: { shell: loadShellConfig(stateDir) as unknown as Record<string, unknown> } };
}

export function loadAgentRuntimeConfig(options: {
  stateDir: string; root: string; enabled(id: string): boolean; env?: NodeJS.ProcessEnv;
  pluginConfig?: Record<string, Record<string, unknown>>;
}): RuntimeConfigLoadResult {
  const userDefaults = legacyRuntimeConfig(options.stateDir);
  const loaded = options.enabled("settings") ? loadRuntimeConfig({ stateDir: options.stateDir, root: options.root, userDefaults,
    ...(options.env ? { env: options.env } : {}), validate: validateAgentRuntimeConfig }) : { config: userDefaults, sources: ["userDefaults"] as import("@xueness/plugin-settings").RuntimeConfigLayer[], provenance: {}, diagnostics: [], workspace: { root: null, path: null, digest: null, status: "absent" as const } };
  // Settings owns the new layers; the shell plugin's established state remains available on its own.
  const config = options.enabled("settings") ? loaded.config : userDefaults;
  if (options.pluginConfig) config.plugins = { ...config.plugins, ...options.pluginConfig };
  config.plugins = { ...config.plugins, shell: shellConfig(config.plugins?.shell) as unknown as Record<string, unknown> };
  return { ...loaded, config };
}
