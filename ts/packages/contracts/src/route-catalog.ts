/**
 * HTTP route ownership by plugin manifest family (ported from
 * `plugin_runtime.build_http_family_index` and `route_owner`). The migration's
 * Python/TypeScript strangler table was removed with the Python backend.
 *
 * Patterns are path data relative to `/api`. A literal segment must match and
 * `*` matches exactly one segment. The longest declared pattern wins; between
 * equal lengths the first declared (manifest order) wins.
 */

export interface HttpFamilyManifest {
  id: string;
  httpFamilies?: readonly string[];
}

export class HttpFamilyIndex {
  readonly #entries: Array<{ pattern: readonly string[]; owner: string }> = [];

  constructor(manifests: Iterable<HttpFamilyManifest>) {
    const seen = new Map<string, string>();
    for (const manifest of manifests) {
      for (const entry of manifest.httpFamilies ?? []) {
        const previous = seen.get(entry);
        if (previous !== undefined && previous !== manifest.id) {
          throw new Error(`http family ${entry} is owned by ${previous} and ${manifest.id}`);
        }
        if (previous === undefined) this.#entries.push({ pattern: entry.split("/"), owner: manifest.id });
        seen.set(entry, manifest.id);
      }
    }
  }

  /** Owning plugin id for split path segments (`["api", "sessions", ...]`). */
  owner(parts: readonly string[]): string | null {
    if (parts.length < 2 || parts[0] !== "api") return null;
    const path = parts.slice(1);
    let owner: string | null = null;
    let depth = 0;
    for (const { pattern, owner: candidate } of this.#entries) {
      if (pattern.length <= depth || pattern.length > path.length) continue;
      if (pattern.every((segment, index) => segment === "*" || segment === path[index])) {
        owner = candidate;
        depth = pattern.length;
      }
    }
    return owner;
  }

  families(): Array<{ pattern: string; owner: string }> {
    return this.#entries.map(({ pattern, owner }) => ({ pattern: pattern.join("/"), owner }));
  }
}

/** Split a URL path the way the Python handler does (empty segments dropped). */
export function pathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** Bundled plugin ids in `plugin_runtime.PLUGIN_IDS` order (manifest order matters for ties). */
export const BUNDLED_PLUGIN_IDS = Object.freeze([
  "sessions", "files", "shell", "planning", "providers", "memory", "settings", "usage", "git", "workflows",
  "terminal", "office", "commands", "skills", "hooks", "mcp", "subagents", "network", "automation", "extensions",
  "diagnostics", "browser", "remote", "bots", "onboarding", "updates", "desktop", "tools", "subscriptions", "model_monitor",
  "workbuddy", "native_ops", "batch_calls", "os_cua", "deepseek_harness",
] as const);
