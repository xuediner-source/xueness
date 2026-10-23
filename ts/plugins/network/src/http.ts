/**
 * `settings_api.dispatch` for `/api/network/settings` and
 * `/api/network/diagnostics`. Every other path is unowned (`owns` is false).
 */
import { isDict, pyGet } from "@xueness/contracts";
import { NetworkError, type Row } from "./errors.ts";
import { nodeNet, type Net } from "./net.ts";
import { searchModel, searchService } from "./services.ts";
import { getSettings, resolveServiceConfig, SettingsValueError, type Env } from "./settings.ts";
import { updateSettings } from "./settings-write.ts";
import { resolvePublic } from "./transport.ts";
import { parseHttpsUrl } from "./urls.ts";

export const NETWORK_HTTP_ROUTES = ["GET /api/network/settings", "POST /api/network/settings", "POST /api/network/diagnostics"] as const;
const DNS_OK = "目标 DNS 解析正常；未连接搜索服务或模型接口。";
const SEARCH_SERVICE_OK = "搜索服务已响应一次诊断请求。";
const SEARCH_MODEL_OK = "搜索模型接口返回了有效结构化结果；这不能证明模型具有联网搜索能力。";
const DIAGNOSTIC_QUERY = "xueness network service diagnostic";
const READ_FAILED = "网络工具设置无法读取，请检查本地设置文件权限。";
const SAVE_FAILED = "无法保存网络工具设置，请检查本地目录权限。";
const DIAGNOSTIC_SETTINGS = "网络工具设置无法读取。请检查设置文件权限，或重新保存网络搜索配置。";

export interface NetworkHttpOptions {
  stateDir: string;
  /** Boolean, or the host `enabled(id)` predicate. */
  enabled: boolean | ((id: string) => boolean);
  env?: Env;
  /** Tests inject a resolver that never touches the public network. */
  net?: Net;
}
export interface NetworkHttp {
  routes: readonly string[];
  owns(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: readonly string[], query: Readonly<Record<string, unknown>>, data: unknown): Promise<[number, Row] | null>;
}

const pluginOn = (enabled: NetworkHttpOptions["enabled"]): boolean => typeof enabled === "function" ? enabled("network") : enabled;
const isOsError = (error: unknown): boolean => error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && /^E[A-Z0-9]+$/.test((error as NodeJS.ErrnoException).code!);

function settingsResponse(stateDir: string, env: Env, verb: string, data: unknown): [number, Row] {
  if (verb === "GET") {
    try { return [200, { settings: getSettings(stateDir, env) }]; }
    catch (error) { if (error instanceof SettingsValueError || isOsError(error)) return [500, { error: READ_FAILED }]; throw error; }
  }
  if (verb === "POST") {
    try { return [200, { settings: updateSettings(stateDir, data, env) }]; }
    catch (error) {
      if (error instanceof SettingsValueError) return [400, { error: error.message }];
      if (isOsError(error)) return [400, { error: SAVE_FAILED }];
      throw error;
    }
  }
  return [405, { error: "仅支持 GET 和 POST。" }];
}

async function probeDns(net: Net, endpoint: unknown, doh: string): Promise<Row> {
  const { host } = parseHttpsUrl(endpoint, false);
  const [addresses, dnsSource] = await resolvePublic(net, host, doh);
  return { host, addressCount: addresses.length, dnsSource };
}

async function diagnose(stateDir: string, env: Env, net: Net, data: unknown): Promise<[number, Row]> {
  if (!isDict(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, "operation")) return [400, { error: "请提供 operation: dns 或 search。" }];
  const operation = data.operation;
  if (operation !== "dns" && operation !== "search") return [400, { error: "operation 必须是 dns 或 search。" }];
  try {
    const values = getSettings(stateDir, env);
    if (operation === "dns") {
      const endpoint = values.searchMode === "model" ? values.searchModelEndpoint : values.searchEndpoint;
      const doh = typeof values.dohEndpoint === "string" && values.dohEndpoint ? values.dohEndpoint : "";
      const result = await probeDns(net, endpoint, doh);
      return [200, { ok: true, operation: "dns", host: result.host, addressCount: result.addressCount, dnsSource: result.dnsSource, message: DNS_OK }];
    }
    const model = values.searchMode === "model";
    let result: Row;
    if (model) result = await searchModel(net, stateDir, env, DIAGNOSTIC_QUERY);
    else { const [provider, endpoint, key, doh] = resolveServiceConfig(stateDir, env); result = await searchService(net, provider, endpoint, key, doh, DIAGNOSTIC_QUERY); }
    return [200, { ok: true, operation: "search", dnsSource: pyGet(result, "dnsSource", "system"), sourceType: pyGet(result, "sourceType", "search_model"), message: model ? SEARCH_MODEL_OK : SEARCH_SERVICE_OK }];
  } catch (error) {
    if (error instanceof NetworkError) return [200, { operation, ...error.asResult() }];
    if (error instanceof SettingsValueError || isOsError(error)) return [200, { operation, ...new NetworkError("network_settings_unavailable", false, DIAGNOSTIC_SETTINGS).asResult() }];
    throw error;
  }
}

export function createNetworkHttp(options: NetworkHttpOptions): NetworkHttp {
  const env = options.env ?? process.env;
  const net = options.net ?? nodeNet();
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 3 && parts[0] === "api" && parts[1] === "network" && (parts[2] === "settings" || parts[2] === "diagnostics");
  return { routes: NETWORK_HTTP_ROUTES, owns, async dispatch(method, parts, _query, data) {
    if (!owns(method, parts)) return null;
    if (!pluginOn(options.enabled)) return [403, { error: "plugin disabled or dependency unavailable: network", plugin: "network" }];
    const verb = (method || "").toUpperCase();
    if (parts[2] === "settings") return settingsResponse(options.stateDir, env, verb, data);
    if (verb !== "POST") return [405, { error: "仅支持 POST。" }];
    return diagnose(options.stateDir, env, net, data);
  } };
}
