/**
 * F07.01 — upstream-aligned source display and workspace switching on top of
 * the layered loader (`runtime-config.ts`).
 *
 * - `LAYER_SCOPES` names every Xueness layer with the upstream
 *   system/user/project/env/cli scope, so the HTTP view can show where each
 *   effective value came from in upstream vocabulary.
 * - `runtimeConfigOverrideMatrix` turns a load result into the override
 *   matrix: every effective leaf with its winning layer, and per MCP server
 *   the chain of layers that defined it (winner last).
 * - `LayeredRuntimeConfig` reads the non-workspace layers once; `switchRoot`
 *   re-applies only the workspace layer onto that cached base, exactly like a
 *   multi-root client hopping between open roots.
 */
import { isDict } from "@xueness/contracts";
import { loadRuntimeConfig, readRuntimeConfigUserPatch, type RuntimeConfigLayer, type RuntimeConfigLoadOptions, type RuntimeConfigLoadResult, type RuntimeConfigPatch } from "./runtime-config.ts";

/** Merge order, lowest priority first. */
export const LAYER_ORDER: readonly RuntimeConfigLayer[] = Object.freeze(["defaults", "userDefaults", "state", "workspace", "environment", "overrides"]);
/** The upstream scope each Xueness layer plays in the system/user/project/env/CLI hierarchy. */
export type RuntimeConfigScope = "system" | "user" | "project" | "env" | "cli";
export const LAYER_SCOPES: Readonly<Record<RuntimeConfigLayer, RuntimeConfigScope>> = Object.freeze({
  defaults: "system", userDefaults: "user", state: "user", workspace: "project", environment: "env", overrides: "cli",
});

export interface OverrideMatrixValue { pointer: string; source: RuntimeConfigLayer; scope: RuntimeConfigScope }
export interface McpServerOverride { name: string; source: RuntimeConfigLayer; scope: RuntimeConfigScope; overrides: RuntimeConfigLayer[] }
export interface RuntimeConfigOverrideMatrix {
  layers: { source: RuntimeConfigLayer; scope: RuntimeConfigScope; present: boolean }[];
  values: OverrideMatrixValue[];
  mcpServers: McpServerOverride[];
}

/** Every effective leaf with its winning layer and upstream scope, layers low→high then pointer. */
export function runtimeConfigOverrideMatrix(result: RuntimeConfigLoadResult): RuntimeConfigOverrideMatrix {
  const rank = (layer: RuntimeConfigLayer): number => LAYER_ORDER.indexOf(layer);
  const layers = LAYER_ORDER.map((source) => ({ source, scope: LAYER_SCOPES[source], present: result.sources.includes(source) }));
  const values = Object.entries(result.provenance)
    .map(([pointer, source]) => ({ pointer, source, scope: LAYER_SCOPES[source] }))
    .sort((a, b) => rank(a.source) - rank(b.source) || (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
  const names = new Set<string>();
  for (const layer of LAYER_ORDER) {
    const servers = result.layerPatches[layer]?.mcp?.servers;
    if (servers) for (const name of Object.keys(servers)) names.add(name);
  }
  const mcpServers: McpServerOverride[] = [...names].sort().map((name) => {
    const chain = LAYER_ORDER.filter((layer) => isDict(result.layerPatches[layer]?.mcp?.servers?.[name]));
    const source = chain[chain.length - 1] ?? "defaults";
    return { name, source, scope: LAYER_SCOPES[source], overrides: chain.slice(0, -1) };
  });
  return { layers, values, mcpServers };
}

export interface LayeredRuntimeConfigSnapshot extends RuntimeConfigLoadResult {
  matrix: RuntimeConfigOverrideMatrix;
}

/** Loads the base (non-workspace) layers once; only the workspace layer follows the root. */
export class LayeredRuntimeConfig {
  readonly #options: Omit<RuntimeConfigLoadOptions, "root">;
  readonly #statePatch: RuntimeConfigPatch | null;
  #root: string | null;

  constructor(options: Omit<RuntimeConfigLoadOptions, "root">, root: string | null = null) {
    this.#options = options;
    this.#statePatch = options.statePatch !== undefined ? options.statePatch
      : (stored => stored.valid && stored.patch ? stored.patch : null)(readRuntimeConfigUserPatch(options.stateDir));
    this.#root = root;
  }

  get root(): string | null { return this.#root; }

  /** A full load result for `root` (the current root when omitted), reusing the cached base layers. */
  snapshot(root?: string | null): LayeredRuntimeConfigSnapshot {
    const next = root === undefined ? this.#root : root;
    this.#root = next;
    const result = loadRuntimeConfig({ ...this.#options, root: next ?? undefined, statePatch: this.#statePatch });
    return { ...result, matrix: runtimeConfigOverrideMatrix(result) };
  }

  /** Switch the multi-root client to another root: only the workspace layer is re-applied. */
  switchRoot(root: string | null): LayeredRuntimeConfigSnapshot { return this.snapshot(root); }
}
