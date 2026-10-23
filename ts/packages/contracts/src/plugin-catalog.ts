/**
 * Rules across a set of manifests, as in `tools/check_plugin_architecture.py`:
 * one owner per service, route family, command, resource, UI module and tool
 * name (tool families such as `mcp__*` included), dependencies that exist,
 * and no dependency cycles.
 */
import type { SchemaIssue } from "./json-schema.ts";
import { overlaps, type PluginManifest } from "./plugin-manifest.ts";

export interface CatalogIssue extends SchemaIssue {
  plugin: string;
}

const OWNED = ["provides", "httpFamilies", "commands", "resources", "frontendModules", "desktopModules"] as const;

type Node = Pick<PluginManifest, "id" | "dependencies">;

/**
 * Dependencies first, otherwise in the given order. Plugins on a dependency
 * cycle are reported as `cyclic`; plugins that only depend on a cycle are in
 * neither list. Unknown dependencies do not affect the order.
 */
export function dependencyOrder(manifests: readonly Node[]): { order: string[]; cyclic: string[] } {
  const known = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const order: string[] = [];
  const placed = new Set<string>();
  for (let progress = true; progress;) {
    progress = false;
    for (const manifest of manifests) {
      if (placed.has(manifest.id) || !manifest.dependencies.every((dep) => placed.has(dep) || !known.has(dep))) continue;
      order.push(manifest.id);
      placed.add(manifest.id);
      progress = true;
    }
  }
  const reaches = (from: string, target: string, seen: Set<string>): boolean =>
    (known.get(from)?.dependencies ?? []).some((dep) => dep === target || (known.has(dep) && !seen.has(dep) && (seen.add(dep), reaches(dep, target, seen))));
  const cyclic = manifests.filter((manifest) => !placed.has(manifest.id) && reaches(manifest.id, manifest.id, new Set())).map((manifest) => manifest.id);
  return { order, cyclic };
}

export function catalogIssues(manifests: readonly PluginManifest[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const ids = new Set<string>();
  const owners = new Map<string, Map<string, string>>(OWNED.map((field) => [field, new Map()]));
  const tools: Array<{ name: string; plugin: string }> = [];
  for (const manifest of manifests) {
    const plugin = manifest.id;
    if (ids.has(plugin)) issues.push({ plugin, path: "/id", message: "duplicates another plugin" });
    ids.add(plugin);
    for (const field of OWNED) {
      const claimed = owners.get(field) as Map<string, string>;
      manifest[field].forEach((value, index) => {
        const previous = claimed.get(value);
        if (previous !== undefined && previous !== plugin) issues.push({ plugin, path: `/${field}/${index}`, message: `is also declared by ${previous}` });
        else claimed.set(value, plugin);
      });
    }
    manifest.tools.forEach((tool, index) => {
      const clash = tools.find((other) => other.plugin !== plugin && overlaps(other.name, tool.name));
      if (clash) issues.push({ plugin, path: `/tools/${index}/name`, message: `overlaps tool ${clash.name} of ${clash.plugin}` });
      tools.push({ name: tool.name, plugin });
    });
  }
  for (const manifest of manifests) {
    manifest.dependencies.forEach((dep, index) => {
      if (!ids.has(dep)) issues.push({ plugin: manifest.id, path: `/dependencies/${index}`, message: "names an unknown plugin" });
    });
  }
  for (const plugin of dependencyOrder(manifests).cyclic) issues.push({ plugin, path: "/dependencies", message: "is part of a dependency cycle" });
  return issues;
}
