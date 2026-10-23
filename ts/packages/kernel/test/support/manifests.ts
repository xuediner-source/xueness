/** Small builders for apiVersion 2 manifests and bundled plugins in kernel tests. */
import type { BundledPlugin, Context, Plugin } from "@xueness/kernel";

export type ManifestFields = Record<string, unknown>;

export function manifestOf(id: string, fields: ManifestFields = {}): ManifestFields {
  return { apiVersion: 2, id, name: id, description: `${id} test plugin`, version: "1.0.0", defaultEnabled: true, ...fields };
}

/** A bundled plugin whose code agrees with its manifest (same id, same inject). */
export function bundle(id: string, fields: ManifestFields, apply: (ctx: Context, config: any) => void | Promise<void> = () => {}, code: Partial<Plugin<any>> = {}): BundledPlugin {
  const manifest = manifestOf(id, fields);
  const plugin: Plugin<any> = { name: id, ...(manifest.inject ? { inject: manifest.inject as Plugin["inject"] } : {}), apply, ...code };
  return { manifest, plugin };
}
