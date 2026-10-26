/**
 * Extensions HTTP: validate, then profiles, then marketplace, then resource CRUD.
 *
 * `fetchUrl` must be the network plugin's public-HTTPS fetch. This package does
 * not import that plugin and does not call global fetch. When
 * `XUENESS_MARKETPLACE_URL` is set and `fetchUrl` is absent, dispatch throws
 * `NetworkError` (Python's fetch failure is not a ValueError, so the host
 * answers 500). `sync_services` runs in Python after the apply body is built;
 * the host owns that side effect. State writes here are in-process.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import { resourceDispatch } from "@xueness/sessions";
import { optionalArtifactByPackage, optionalAsset } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { dispatchMarketplace, NetworkError, type FetchUrlResult } from "./marketplace.ts";
import { dispatchProfiles } from "./profiles.ts";
import { dispatchValidate, type ExtensionsReply } from "./validate.ts";
import { marketplaceCatalog } from "./marketplace.ts";
import { fetchOfficialArtifact, removeOfficialArtifact, type ArtifactDownload } from "./official-install.ts";
import { installAll } from "./sdk.ts";
import { readState, writeState } from "./runtime.ts";
import { uninstallPackage } from "./components.ts";

export { loadManifests as loadDataManifests } from "./sdk.ts";
export { profileCommand, updatePackages, validatePath } from "./cli.ts";
export {
  COMPONENT_KINDS, componentOwner, componentOwners, componentSummary, componentsDigest, effectiveComponents, uninstallPackage,
  type ActiveComponent, type ComponentDeclaration, type ComponentKind, type ComponentOwnership, type ComponentPackage, type ComponentsField, type UninstallResult,
} from "./components.ts";
export {
  EXAMPLE_PACKAGE, SDK_API_VERSION, compatVerdict, contributionIssues, describePackage, validateContributionFields,
  type ContributionIssue, type PackageDescription, type PluginPackageDocument, type SdkCompatibility,
} from "./contribution.ts";
export { activationPlan, catalogItems, dispatchPluginCatalog, ownsPluginCatalog, setPluginEnabled, UI_FIELDS, type PluginCatalogOptions, type UiDeclarations } from "./catalog.ts";

export interface ExtensionsHttpOptions {
  stateDir: string;
  enabled: boolean | ((id: string) => boolean);
  env?: NodeJS.ProcessEnv;
  /** Sync, or a promise. A marketplace URL is fetched once per request, then replayed. */
  fetchUrl?: (url: string) => FetchUrlResult | Promise<FetchUrlResult>;
  downloadArtifact?: ArtifactDownload;
  optionalChanged?(id: string): Promise<void>;
}

export const EXTENSIONS_ROUTES = [
  "GET /api/plugins/marketplace",
  "POST /api/plugins/marketplace/:id/install",
  "POST /api/plugins/marketplace/:id/update",
  "POST /api/plugins/marketplace/:id/uninstall",
  "POST /api/plugins/marketplace/validate",
  "GET /api/plugins/profiles",
  "POST /api/plugins/profiles/apply",
  "GET /api/resources/plugins",
  "POST /api/resources/plugins",
  "PUT /api/resources/plugins",
  "PATCH /api/resources/plugins/:id",
  "DELETE /api/resources/plugins/:id",
];

const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts.length >= 3
  && (parts[1] === "plugins" && (parts[2] === "marketplace" || parts[2] === "profiles") || parts[1] === "resources" && parts[2] === "plugins");

export function createExtensionsHttp(options: ExtensionsHttpOptions) {
  const enabledNow = (): boolean => (typeof options.enabled === "function" ? options.enabled("extensions") === true : options.enabled === true);
  const installing = new Set<string>();
  return {
    routes: EXTENSIONS_ROUTES,
    owns,
    asset: (name: string): Buffer | null => optionalAsset(options.stateDir, name),
    /** Resource documents and marketplace bodies keep Python's numbers (`1.0`). */
    lossless: (method: string, parts: readonly string[]): boolean => owns(method, parts) && (parts[1] === "resources" || (parts[1] === "plugins" && parts[2] === "marketplace" && method === "POST")),
    async dispatch(method: string, parts: string[], _query: Record<string, readonly string[] | undefined>, data: unknown): Promise<ExtensionsReply | null> {
      if (!owns(method, parts)) return null;
      if (!enabledNow()) return [403, { error: "plugin disabled or dependency unavailable: extensions", plugin: "extensions" }];
      const validated = dispatchValidate(method, parts, data);
      if (validated) return validated;
      const profiles = dispatchProfiles(method, parts, data, options.stateDir);
      if (profiles) return profiles;
      const env = options.env ?? process.env;
      const marketUrl = env.XUENESS_MARKETPLACE_URL ?? "";
      let fetchUrl: ((url: string) => FetchUrlResult) | undefined;
      if (parts[1] === "plugins" && parts[2] === "marketplace" && options.fetchUrl && marketUrl) {
        const loaded = await options.fetchUrl(marketUrl);
        fetchUrl = (url) => { if (url !== marketUrl) throw new NetworkError("marketplace fetch unavailable"); return loaded; };
      } else if (options.fetchUrl) {
        const given = options.fetchUrl;
        fetchUrl = (url) => {
          const value = given(url);
          if (value instanceof Promise) throw new NetworkError("marketplace fetch unavailable");
          return value;
        };
      }
      const marketOptions = { env, ...(fetchUrl ? { fetchUrl } : {}) };
      const artifact = parts[1] === "plugins" && parts[2] === "marketplace" && parts.length === 5 ? optionalArtifactByPackage(parts[3] ?? "") : null;
      if (artifact && method === "POST" && ["install", "update", "uninstall"].includes(parts[4]!)) {
        if (installing.has(artifact.id)) return [409, { error: "This plugin already has an operation in progress" }];
        installing.add(artifact.id);
        try {
          if (parts[4] === "uninstall") {
            const state = readState(options.stateDir); state.enabled[artifact.id] = false; writeState(options.stateDir, state.enabled, state.profile);
            await options.optionalChanged?.(artifact.id);
            const removed = uninstallPackage(options.stateDir, artifact.packageId);
            if (!removed.ok) return [400, { error: removed.error }];
            removeOfficialArtifact(options.stateDir, artifact.packageId);
            return [200, { ...removed, marketplace: marketplaceCatalog(options.stateDir, marketOptions) }];
          }
          const item = marketplaceCatalog(options.stateDir, marketOptions).find(row => row.id === artifact.packageId);
          if (!item || !data || typeof data !== "object" || (data as Record<string, unknown>).sha256 !== artifact.sha256) return [400, { error: "Catalog changed; review this plugin again" }];
          if (Boolean(item.installedVersion) !== (parts[4] === "update")) return [400, { error: "Refresh the catalog before installing" }];
          if (item.installedVersion === artifact.version) return [400, { error: "No newer plugin version available" }];
          await fetchOfficialArtifact(options.stateDir, artifact.packageId, options.downloadArtifact);
          const state = readState(options.stateDir); state.enabled[artifact.id] = false; writeState(options.stateDir, state.enabled, state.profile);
          const installed = installAll(options.stateDir, [{ ...(item.manifest as Record<string, unknown>), enabled: false }]);
          if (!installed.ok) throw new Error("Plugin manifest could not be saved");
          await options.optionalChanged?.(artifact.id);
          return [200, { ...installed, marketplace: marketplaceCatalog(options.stateDir, marketOptions) }];
        } catch (error) { return [400, { error: error instanceof Error ? error.message : "Plugin download failed" }]; }
        finally { installing.delete(artifact.id); }
      }
      const market = dispatchMarketplace(method, parts, data, options.stateDir, marketOptions);
      if (market) return market;
      if (parts[1] === "resources" && parts[2] === "plugins") return resourceDispatch(options.stateDir, method, parts, data);
      return null;
    },
  };
}

export const extensions: BundledPlugin = { manifest, plugin: definePlugin({ name: "extensions", apply() {} }) };
