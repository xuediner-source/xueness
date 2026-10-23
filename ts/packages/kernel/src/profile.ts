/**
 * Profiles compose plugins into a product. `full` and `lite` are profiles;
 * a profile can extend others, replace a plugin's config, or disable it.
 */
import type { Context } from "./context.ts";
import type { Plugin, PluginHandle } from "./plugin.ts";

export interface ProfileEntry<C = unknown> {
  plugin: Plugin<C>;
  config?: C;
  enabled?: boolean;
}

export interface Profile {
  name: string;
  extends?: readonly Profile[];
  plugins?: readonly ProfileEntry<never>[] | readonly ProfileEntry[];
  /** Plugin names removed from everything this profile extends. */
  disable?: readonly string[];
}

/**
 * Flatten a profile: bases first, in order; a later entry for the same plugin
 * replaces the earlier one in place; disabled entries are dropped.
 */
export function resolveProfile(profile: Profile, seen: Set<string> = new Set()): ProfileEntry[] {
  if (seen.has(profile.name)) throw new Error(`profile cycle at ${profile.name}`);
  const visiting = new Set(seen).add(profile.name);
  const merged = new Map<string, ProfileEntry>();
  for (const base of profile.extends ?? []) {
    for (const entry of resolveProfile(base, visiting)) merged.set(entry.plugin.name, entry);
  }
  for (const entry of (profile.plugins ?? []) as readonly ProfileEntry[]) merged.set(entry.plugin.name, entry);
  for (const name of profile.disable ?? []) merged.delete(name);
  return [...merged.values()].filter((entry) => entry.enabled !== false);
}

/** Load every plugin of a profile and wait until each has settled. */
export async function applyProfile(ctx: Context, profile: Profile): Promise<Map<string, PluginHandle>> {
  const handles = new Map<string, PluginHandle>();
  for (const entry of resolveProfile(profile)) handles.set(entry.plugin.name, ctx.plugin(entry.plugin, entry.config));
  await Promise.all([...handles.values()].map((handle) => handle.ready()));
  // A plugin may become ready only after a later one provided its service.
  await Promise.all([...handles.values()].map((handle) => handle.ready()));
  return handles;
}
