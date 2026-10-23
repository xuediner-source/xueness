/** Plugin catalog data: the bundled manifests, shipped as JSON in `ts/catalog` (and `dist/catalog`). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_IDS, HttpFamilyIndex, pyJsonLoads, type HttpFamilyManifest } from "@xueness/contracts";

export const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "catalog");

/** The shipped manifest text for `id`, or null when the plugin has none. */
function manifestText(id: string): string | null {
  try { return readFileSync(join(CATALOG_DIR, id + ".json"), "utf8"); }
  catch { return null; }
}

export function loadManifests(_projectRoot?: string): HttpFamilyManifest[] {
  const manifests: HttpFamilyManifest[] = [];
  for (const id of BUNDLED_PLUGIN_IDS) {
    const text = manifestText(id);
    // A plugin without a manifest owns no routes.
    if (text !== null) try { manifests.push(JSON.parse(text) as HttpFamilyManifest); } catch { /* unreadable: no routes */ }
  }
  return manifests;
}

/** The shipped manifests by id, decoded as Python's `json.loads` keeps them (integral floats, key order). */
export function loadCatalogManifests(_projectRoot?: string): Map<string, Record<string, unknown>> {
  const manifests = new Map<string, Record<string, unknown>>();
  for (const id of BUNDLED_PLUGIN_IDS) {
    const text = manifestText(id);
    if (text === null) continue;
    try {
      const value = pyJsonLoads(text, { lossless: true });
      if (value !== null && typeof value === "object" && !Array.isArray(value)) manifests.set(id, value as Record<string, unknown>);
    } catch { /* unreadable: no catalog row fields */ }
  }
  return manifests;
}

/** Manifest route families and their owning plugins, for the front door's status. */
export function routeFamilies(projectRoot: string): Record<string, string> {
  return Object.fromEntries(new HttpFamilyIndex(loadManifests(projectRoot)).families().map(({ pattern, owner }) => [pattern, owner]));
}
