/**
 * Trusted marketplace catalog and install (`bundled_plugins/extensions/marketplace.py`).
 *
 * With no `XUENESS_MARKETPLACE_URL`, the catalog is the four built-in adapters
 * plus the subscriptions, model-monitor and WorkBuddy snapshots. A URL is fetched only
 * through the injected `fetchUrl` (the network plugin's public-HTTPS fetch).
 * Install writes the manifest disabled and never imports it.
 */
import { isDict, pyJsonLoads, pyStr, pyTypeName, PyAttributeError, PyValueError } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError } from "@xueness/sessions";
import { uninstallPackage } from "./components.ts";
import { digest, installAll, loadManifests, validateDataManifest, type InstallResult } from "./sdk.ts";
import type { ExtensionsReply } from "./validate.ts";

/** Python `NetworkError`: marketplace does not turn this into a 400. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

export interface FetchUrlResult {
  output: string;
  truncated: boolean;
}

/** Bundled package snapshots for optional integrations. */
export const SUBSCRIPTIONS_PACKAGE_ID = "xueness-subscriptions";
export const MONITOR_PACKAGE_ID = "xueness-model-monitor";
export const WORKBUDDY_PACKAGE_ID = "xueness-workbuddy";
export const SUBSCRIPTIONS_MARKET_MANIFEST = { id: SUBSCRIPTIONS_PACKAGE_ID, version: "1.0.0", apiVersion: 1, builtin: "subscriptions", capabilities: [] as string[], enabled: false };
export const MONITOR_MARKET_MANIFEST = { id: MONITOR_PACKAGE_ID, version: "1.0.0", apiVersion: 1, builtin: "model_monitor", capabilities: [] as string[], enabled: false };
export const WORKBUDDY_MARKET_MANIFEST = { id: WORKBUDDY_PACKAGE_ID, version: "1.0.0", apiVersion: 1, builtin: "workbuddy", capabilities: [] as string[], enabled: false };

const KINDS = ["skills", "hooks", "mcp", "subagents"];

export interface MarketplaceOptions {
  env?: NodeJS.ProcessEnv;
  fetchUrl?: (url: string) => FetchUrlResult;
}

function builtinRow(kind: string): Record<string, unknown> {
  const id = `xueness-${kind}`;
  return {
    id,
    name: kind.slice(0, 1).toUpperCase() + kind.slice(1),
    description: `Trusted ${kind} capability adapter`,
    manifest: { id, version: "1.0.0", apiVersion: 1, builtin: kind, capabilities: [], enabled: false },
  };
}

function packageRow(id: string, name: string, description: string, manifest: Record<string, unknown>): Record<string, unknown> {
  return { id, name, description, manifest: structuredClone(manifest), source: "bundled" };
}

function remoteItems(url: string, fetchUrl: MarketplaceOptions["fetchUrl"]): unknown {
  // The host passes the network plugin's public-HTTPS fetch. A missing fetcher
  // is a NetworkError, which marketplace does not turn into a 400.
  if (!fetchUrl) throw new NetworkError("marketplace fetch unavailable");
  const raw = fetchUrl(url);
  if (!raw || typeof raw.output !== "string") throw new PyAttributeError(`'${pyTypeName(raw)}' object has no attribute 'get'`);
  if (raw.truncated) throw new PyValueError("marketplace catalog too large");
  const parsed = pyJsonLoads(raw.output, { lossless: true });
  if (!isDict(parsed)) throw new PyAttributeError(`'${pyTypeName(parsed)}' object has no attribute 'get'`);
  return parsed.items;
}

function loadRows(url: string, fetchUrl: MarketplaceOptions["fetchUrl"]): unknown[] {
  const rows = url ? remoteItems(url, fetchUrl) : KINDS.map(builtinRow);
  if (!Array.isArray(rows) || rows.length > 100) throw new PyValueError("invalid marketplace catalog");
  const kept = rows.filter((row) => !isDict(row) || row.id !== SUBSCRIPTIONS_PACKAGE_ID);
  kept.push(packageRow(SUBSCRIPTIONS_PACKAGE_ID, "订阅中心", "可选安装。通过账号授权或登录凭证接入 Claude、Codex 等订阅账号，查询真实额度并用于会话。", SUBSCRIPTIONS_MARKET_MANIFEST));
  const withoutMonitor = kept.filter((row) => !isDict(row) || row.id !== MONITOR_PACKAGE_ID);
  withoutMonitor.push(packageRow(MONITOR_PACKAGE_ID, "返回模型监测", "可选安装。随会话显示请求型号与上游返回型号，判断一致或不同；不自动发送额外请求。", MONITOR_MARKET_MANIFEST));
  const withoutWorkbuddy = withoutMonitor.filter((row) => !isDict(row) || row.id !== WORKBUDDY_PACKAGE_ID);
  withoutWorkbuddy.push(packageRow(WORKBUDDY_PACKAGE_ID, "WorkBuddy 号池", "可选安装的本机号池网关。请自备认证文件并放入 state/workbuddy/auths；安装后还需在插件管理中启用。", WORKBUDDY_MARKET_MANIFEST));
  return withoutWorkbuddy;
}

/** `marketplace.catalog`. Throws `PyValueError` on a bad listing and `NetworkError` when fetch is missing. */
export function marketplaceCatalog(stateDir: string, options: MarketplaceOptions = {}): Record<string, unknown>[] {
  const env = options.env ?? process.env;
  const url = env.XUENESS_MARKETPLACE_URL ?? "";
  const rows = loadRows(url, options.fetchUrl);
  const installed = new Map(loadManifests(stateDir).map((item) => [item.id, item]));
  const output: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isDict(row)) throw new PyValueError("invalid marketplace item");
    const [manifest, errors] = validateDataManifest(row.manifest);
    if (errors.length || !manifest || row.id !== manifest.id || seen.has(manifest.id)) throw new PyValueError("invalid marketplace manifest");
    seen.add(manifest.id);
    const itemDigest = digest(row.manifest);
    const declared = Object.hasOwn(row, "sha256") ? row.sha256 : itemDigest;
    if (declared !== itemDigest) throw new PyValueError("marketplace digest mismatch");
    const current = installed.get(manifest.id);
    const reserved = manifest.id === SUBSCRIPTIONS_PACKAGE_ID || manifest.id === MONITOR_PACKAGE_ID || manifest.id === WORKBUDDY_PACKAGE_ID;
    output.push({
      id: manifest.id,
      name: pyStr(row.name ?? manifest.id).slice(0, 120),
      description: pyStr(row.description ?? "").slice(0, 500),
      version: manifest.version,
      sha256: itemDigest,
      installedVersion: current ? current.version : null,
      manifest: row.manifest,
      source: reserved ? (row.source ?? null) : (url || "bundled"),
    });
  }
  return output;
}

function versionParts(value: string): number[] {
  return value.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new PyValueError("invalid version");
    return Number(part);
  });
}

function versionAtMost(left: string, right: string): boolean {
  const a = versionParts(left);
  const b = versionParts(right);
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) if (a[index] !== b[index]) return a[index]! < b[index]!;
  return a.length <= b.length;
}

/** `marketplace.install`. The written manifest is forced `enabled: false`. */
export function installPackage(stateDir: string, id: string, expected: unknown, update: boolean, options: MarketplaceOptions = {}): InstallResult {
  const item = marketplaceCatalog(stateDir, options).find((row) => row.id === id);
  if (!item || expected !== item.sha256) throw new PyValueError("catalog changed; review the package again");
  const installed = item.installedVersion;
  if (Boolean(installed) !== update) throw new PyValueError("use update for an installed package");
  if (update && versionAtMost(String(item.version), String(installed))) throw new PyValueError("no newer version available");
  const manifest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.manifest as Record<string, unknown>)) if (key !== "enabled") manifest[key] = value;
  manifest.enabled = false;
  const result = installAll(stateDir, [manifest]);
  if (!result.ok) throw new PyValueError("manifest installation failed");
  return result;
}

const caught = (error: unknown): boolean => isPyValueError(error) || isPyOSError(error) || isPyKeyError(error);

/** Marketplace routes. Unknown paths under the prefix are 405, not "not mine". */
export function dispatchMarketplace(method: string, parts: readonly string[], data: unknown, stateDir: string, options: MarketplaceOptions = {}): ExtensionsReply | null {
  if (parts[0] !== "api" || parts[1] !== "plugins" || parts[2] !== "marketplace") return null;
  try {
    if (parts.length === 3 && method === "GET") return [200, { marketplace: marketplaceCatalog(stateDir, options) }];
    if (parts.length === 5 && method === "POST" && parts[4] === "uninstall") {
      const result = uninstallPackage(stateDir, parts[3] ?? "");
      if (!result.ok) return [400, { error: result.error ?? "uninstall failed" }];
      return [200, { ...result, marketplace: marketplaceCatalog(stateDir, options) }];
    }
    if (parts.length === 5 && method === "POST" && (parts[4] === "install" || parts[4] === "update")) {
      if (!isDict(data)) throw new PyAttributeError(`'${pyTypeName(data)}' object has no attribute 'get'`);
      const result = installPackage(stateDir, parts[3] ?? "", data.sha256, parts[4] === "update", options);
      return [200, { ...result, marketplace: marketplaceCatalog(stateDir, options) }];
    }
    return [405, { error: "method not allowed" }];
  } catch (error) {
    if (caught(error)) return [400, { error: "marketplace validation or installation failed" }];
    throw error;
  }
}
