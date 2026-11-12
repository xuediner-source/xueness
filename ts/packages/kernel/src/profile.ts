/**
 * Profiles compose plugins into a product. `full` and `lite` are profiles;
 * a profile can extend others, replace a plugin's config, or disable it.
 */
import type { Plugin } from "./plugin.ts";

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

