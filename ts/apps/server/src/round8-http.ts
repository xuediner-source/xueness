/**
 * Round-8 owners: the kernel plugin manager, `GET /api/plugins` and
 * `POST /api/plugins/<id>` (Python `plugin_runtime.dispatch_http`), and
 * `GET /api/visualizations?path=<absolute>[&title=]` (TS only): a fragment in
 * a session's visualization directory rendered by the bundled visualize skill.
 * Only `<state>/visualizations/<session id>/<name>.html` is served, real paths
 * included; the page is sandboxed by its CSP header even when opened directly.
 *
 * Catalog rows are the shipped manifests with the frontend declarations of
 * the TS manifests; toggles take the shared `.plugin-state.lock`. Sub-families
 * a manifest claims (`plugins/marketplace`, `plugins/profiles`) stay with their
 * owners. Python applies a switch to its own services at its next request
 * (`sync_services` runs in every request guard).
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { dispatchPluginCatalog, ownsPluginCatalog, UI_FIELDS, type PluginCatalogOptions, type UiDeclarations } from "@xueness/plugin-extensions";
import { BUNDLED_SKILLS_DIR, renderVisualizationFile, VISUALIZE_SKILL, VisualizationSourceError } from "@xueness/plugin-skills";
import type { FileLockProvider } from "@xueness/sessions";
import { BUNDLED_TS_PLUGINS } from "./bundled-plugins.ts";
import { loadCatalogManifests, loadManifests } from "./manifests.ts";

type Reply = [number, unknown, string?, Record<string, string>?] | null;

export interface Round8Options {
  projectRoot: string;
  stateDir: string;
  locks?: FileLockProvider;
  /** Effective plugins; omitted means all enabled. */
  enabled?(id: string): boolean;
  /** The visualize skill directory; defaults to the bundled one. */
  visualizeSkill?: string;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
export const VISUALIZATION_HEADERS: Readonly<Record<string, string>> = Object.freeze({ "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'", "Referrer-Policy": "no-referrer" });

/** `GET /api/visualizations`: 400 without an absolute path, 404 outside a session's visualization directory, 422 for a refused fragment. */
export function visualizationReply(stateDir: string, skillDir: string, query: Record<string, string[]>): Reply {
  const path = query.path?.[0];
  if (typeof path !== "string" || !path || !isAbsolute(path) || path.includes("\0")) return [400, { error: "path must be an absolute visualization file path" }];
  let segments: string[];
  try { segments = relative(realpathSync(join(stateDir, "visualizations")), realpathSync(path)).split(sep); } catch { return [404, { error: "visualization not found" }]; }
  if (segments.length !== 2 || !SESSION_ID.test(segments[0]!) || !segments[1]!.endsWith(".html")) return [404, { error: "visualization not found" }];
  try {
    return [200, Buffer.from(renderVisualizationFile(skillDir, path, query.title?.[0] ?? null), "utf8"), "text/html; charset=utf-8", { ...VISUALIZATION_HEADERS }];
  } catch (error) {
    if (error instanceof VisualizationSourceError) return [422, { error: error.message }];
    throw error;
  }
}

/** `panels`, `frontendModules` and `desktopModules` of each TS manifest, by plugin id. */
export function frontendDeclarations(): Map<string, UiDeclarations> {
  const declarations = new Map<string, UiDeclarations>();
  for (const { manifest } of BUNDLED_TS_PLUGINS) {
    const document = manifest as Record<string, unknown>;
    if (typeof document.id !== "string") continue;
    const ui: UiDeclarations = {};
    for (const key of UI_FIELDS) {
      const value = document[key];
      if (Array.isArray(value)) ui[key] = value.filter((item): item is string => typeof item === "string");
    }
    declarations.set(document.id, ui);
  }
  return declarations;
}

/** `_plugin_owned_segments`: second `/api/plugins` segments a manifest's `httpFamilies` claim. */
export function pluginOwnedSegments(projectRoot: string): Set<string> {
  const segments = new Set<string>();
  for (const manifest of loadManifests(projectRoot)) {
    for (const family of manifest.httpFamilies ?? []) {
      const pattern = String(family).split("/").filter(Boolean);
      if (pattern.length > 1 && pattern[0] === "plugins") segments.add(pattern[1]!);
    }
  }
  return segments;
}

export function createRound8(options: Round8Options) {
  let manifests: Map<string, Record<string, unknown>> | null = null;
  const catalog: PluginCatalogOptions = {
    stateDir: options.stateDir,
    manifests: () => manifests ??= loadCatalogManifests(options.projectRoot),
    ui: frontendDeclarations(),
    ownedSegments: pluginOwnedSegments(options.projectRoot),
    ...(options.locks ? { locks: options.locks } : {}),
  };
  const visualizations = (parts: readonly string[]): boolean => parts.length === 2 && parts[0] === "api" && parts[1] === "visualizations";
  const owns = (_method: string, parts: readonly string[]): boolean => ownsPluginCatalog(catalog, parts) || visualizations(parts);
  return {
    routes: ["GET /api/plugins", "POST /api/plugins/:id", "GET /api/visualizations"],
    owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: Record<string, unknown>): Promise<Reply> {
      if (ownsPluginCatalog(catalog, parts)) return dispatchPluginCatalog(catalog, method, parts, data);
      if (visualizations(parts)) {
        if (method.toUpperCase() !== "GET") return [405, { error: "method not allowed" }];
        if (options.enabled && !options.enabled("skills")) return [403, { error: "plugin disabled or dependency unavailable: skills", plugin: "skills" }];
        return visualizationReply(options.stateDir, options.visualizeSkill ?? join(BUNDLED_SKILLS_DIR, VISUALIZE_SKILL), query);
      }
      return null;
    },
  };
}
