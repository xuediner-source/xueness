/**
 * F07.05 component packages and lifecycle (`components` of a data manifest).
 *
 * A component package is still data: a manifest may declare declarative
 * components grouped by kind (`skills`, `commands`, `hooks`, `mcp`). Each
 * component is `{ id, description?, alwaysLoad? }`; `alwaysLoad` marks a
 * component the host registers as soon as its owner plugin is effective,
 * while the default `false` keeps it discoverable but lazily bound. Nothing
 * here imports or executes: component entries only name and describe.
 *
 * Lifecycle: install (marketplace, forced disabled), upgrade (newer version),
 * uninstall (refused while the package is enabled). Ownership: every
 * registered component maps back to the plugin that owns it, and a component
 * id claimed twice is a conflict the panel can show.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, PyValueError } from "@xueness/contracts";
import { isLink, jsonEntries, readJsonObject, resourceKindDir, validResourceId } from "@xueness/sessions";
import { digest, loadManifests, validateDataManifest, type DataManifest } from "./sdk.ts";

export const COMPONENT_KINDS = ["skills", "commands", "hooks", "mcp"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(COMPONENT_KINDS);
const MAX_COMPONENTS_PER_KIND = 64;
const MAX_DESCRIPTION = 200;

export interface ComponentDeclaration {
  kind: ComponentKind;
  id: string;
  description: string;
  alwaysLoad: boolean;
}

export interface ComponentIssue {
  path: string;
  message: string;
}

export type ComponentsField = Partial<Record<ComponentKind, readonly unknown[]>>;

/** Validate a manifest's `components` object. Returns the normalized set plus issues. */
export function validateComponents(value: unknown, manifestId = "<manifest>"): [ComponentDeclaration[], ComponentIssue[]] {
  const issues: ComponentIssue[] = [];
  const components: ComponentDeclaration[] = [];
  if (value === undefined || value === null) return [components, issues];
  if (!isDict(value)) return [components, [{ path: `${manifestId}/components`, message: "components must be an object keyed by kind" }]];
  const seen = new Set<string>();
  for (const kind of Object.keys(value).sort()) {
    if (!KIND_SET.has(kind)) {
      issues.push({ path: `${manifestId}/components/${kind}`, message: `unknown component kind: ${kind}` });
      continue;
    }
    const entries = value[kind];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries) || entries.length > MAX_COMPONENTS_PER_KIND) {
      issues.push({ path: `${manifestId}/components/${kind}`, message: `components.${kind} must be an array of at most ${MAX_COMPONENTS_PER_KIND} entries` });
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const at = `${manifestId}/components/${kind}/${index}`;
      if (!isDict(entry)) {
        issues.push({ path: at, message: "component entry must be an object" });
        continue;
      }
      const id = entry.id;
      if (!validResourceId(id)) {
        issues.push({ path: `${at}/id`, message: "component id must be a lowercase resource id" });
        continue;
      }
      const description = entry.description === undefined ? "" : entry.description;
      if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
        issues.push({ path: `${at}/description`, message: `description must be a string of at most ${MAX_DESCRIPTION} characters` });
        continue;
      }
      const alwaysLoad = entry.alwaysLoad === undefined ? false : entry.alwaysLoad;
      if (typeof alwaysLoad !== "boolean") {
        issues.push({ path: `${at}/alwaysLoad`, message: "alwaysLoad must be a boolean" });
        continue;
      }
      if (seen.has(`${kind}/${id}`)) {
        issues.push({ path: at, message: `duplicate component: ${kind}/${id}` });
        continue;
      }
      seen.add(`${kind}/${id}`);
      components.push({ kind: kind as ComponentKind, id, description, alwaysLoad });
    }
  }
  return [components, issues];
}

export interface ComponentPackage extends DataManifest {
  components: ComponentDeclaration[];
}

/** Installed data manifests that declare components, id ascending. */
export function loadComponentPackages(stateDir: string): ComponentPackage[] {
  const packages: ComponentPackage[] = [];
  for (const manifest of loadManifests(stateDir)) {
    const [components] = validateComponents(rawComponents(stateDir, manifest.id));
    packages.push({ ...manifest, components });
  }
  return packages;
}

function rawComponents(stateDir: string, id: string): unknown {
  const path = join(pluginsDirectory(stateDir), `${id}.json`);
  if (!existsSync(path) || isLink(path)) return undefined;
  const item = readJsonObject(path);
  return item === null ? undefined : item.components;
}

function pluginsDirectory(stateDir: string): string {
  return resourceKindDir(stateDir, "plugins");
}

export interface ComponentOwnership {
  key: string;
  kind: ComponentKind;
  id: string;
  owner: string;
  /** The bundled adapter whose panel lists this component (`manifest.builtin`). */
  adapter: string;
  description: string;
  alwaysLoad: boolean;
  enabled: boolean;
  version: string;
}

/** The ownership registry: one row per declared component, `kind/id` ascending. */
export function componentOwners(stateDir: string): { rows: ComponentOwnership[]; conflicts: Map<string, string[]> } {
  const rows: ComponentOwnership[] = [];
  const claims = new Map<string, string[]>();
  for (const pkg of loadComponentPackages(stateDir)) {
    for (const component of pkg.components) {
      const key = `${component.kind}/${component.id}`;
      claims.set(key, [...(claims.get(key) ?? []), pkg.id].sort());
      rows.push({
        key,
        kind: component.kind,
        id: component.id,
        owner: pkg.id,
        adapter: pkg.builtin,
        description: component.description,
        alwaysLoad: component.alwaysLoad,
        enabled: pkg.enabled,
        version: pkg.version,
      });
    }
  }
  rows.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const conflicts = new Map<string, string[]>([...claims].filter(([, owners]) => owners.length > 1));
  return { rows, conflicts };
}

export interface EffectiveSlice {
  id: string;
  effective: boolean;
}

export interface ActiveComponent {
  kind: ComponentKind;
  id: string;
  owner: string;
  loadPolicy: "always" | "on-demand";
}

/**
 * Components a host may register: only those whose owning plugin is
 * effective. A disabled or dependency-blocked plugin contributes nothing, so
 * no new task can reach its components; `alwaysLoad` decides eager vs lazy.
 */
export function effectiveComponents(stateDir: string, slices: readonly EffectiveSlice[]): ActiveComponent[] {
  const effective = new Set(slices.filter((slice) => slice.effective).map((slice) => slice.id));
  const active: ActiveComponent[] = [];
  for (const pkg of loadComponentPackages(stateDir)) {
    if (!pkg.enabled || !effective.has(pkg.builtin)) continue;
    for (const component of pkg.components) {
      active.push({ kind: component.kind, id: component.id, owner: pkg.id, loadPolicy: component.alwaysLoad ? "always" : "on-demand" });
    }
  }
  return active.sort((left, right) => (left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : left.kind < right.kind ? -1 : 1));
}

export interface UninstallResult {
  ok: boolean;
  removed: string | null;
  error?: string;
}

/** `uninstall`: remove an installed data package. Refused while enabled. */
export function uninstallPackage(stateDir: string, id: string): UninstallResult {
  if (!validResourceId(id)) return { ok: false, removed: null, error: "invalid plugin id" };
  const manifest = loadManifests(stateDir).find((item) => item.id === id);
  if (!manifest) return { ok: false, removed: null, error: "no installed package with this id" };
  if (manifest.enabled) return { ok: false, removed: null, error: "disable the package before uninstalling it" };
  const path = join(pluginsDirectory(stateDir), `${id}.json`);
  if (isLink(path) || !existsSync(path)) return { ok: false, removed: null, error: "installed manifest is missing or is a symlink" };
  try {
    unlinkSync(path);
  } catch (error) {
    return { ok: false, removed: null, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, removed: id };
}

/** Components summary for one catalog row: counts, alwaysLoad ids and conflicts. */
export function componentSummary(stateDir: string, pluginId: string): Record<string, unknown> {
  const owners = componentOwners(stateDir);
  const mine = owners.rows.filter((row) => row.adapter === pluginId || row.owner === pluginId);
  const byKind: Record<string, string[]> = {};
  for (const row of mine) byKind[row.kind] = [...(byKind[row.kind] ?? []), row.id];
  const conflicts = owners.conflicts.size > 0
    ? [...owners.conflicts.entries()].filter(([, ids]) => ids.some((id) => id === pluginId || owners.rows.some((row) => row.owner === id && row.adapter === pluginId))).map(([key]) => key)
    : [];
  return {
    total: mine.length,
    byKind,
    alwaysLoad: mine.filter((row) => row.alwaysLoad).map((row) => row.key),
    conflicts,
  };
}

/** Guard for panel queries: a component key exists and names its owner. */
export function componentOwner(stateDir: string, kind: string, id: string): string | null {
  if (!KIND_SET.has(kind)) throw new PyValueError("unknown component kind: " + kind);
  const owners = componentOwners(stateDir);
  return owners.rows.find((row) => row.kind === kind && row.id === id)?.owner ?? null;
}

/** Digest of the components block alone, so upgrades can be compared per field. */
export function componentsDigest(components: readonly ComponentDeclaration[]): string {
  return digest(components.map(({ kind, id, description, alwaysLoad }) => ({ kind, id, description, alwaysLoad })));
}
