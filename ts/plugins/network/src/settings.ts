/**
 * The read side of `bundled_plugins/network/search_settings.py`: the state
 * directory's `network/settings.json` and owner-private key files, with the
 * operator environment as fallback. `update_settings` lives in
 * `settings-write.ts` so this file stays within the line limit.
 */
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonLoads, pyStrip, pyTruthy } from "@xueness/contracts";
import { NetworkError, type Row } from "./errors.ts";
import { isGlobal, parseIp } from "./ip.ts";
import { parseHttpsUrl, urlsplit } from "./urls.ts";

export type Env = Readonly<Record<string, string | undefined>>;
export class SettingsValueError extends Error { override name = "ValueError"; }

export const PROVIDERS = ["brave", "tavily", "searxng"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const DEFAULT_ENDPOINTS: Readonly<Record<Provider, string>> = { brave: "https://api.search.brave.com/res/v1/web/search", tavily: "https://api.tavily.com/search", searxng: "" };
const DEFAULT_IMAGE_ENDPOINT = "https://api.search.brave.com/res/v1/images/search";
const MAX_SETTINGS_BYTES = 16_384;
const MAX_KEY_LENGTH = 4096;
const DOH_INVALID = (): NetworkError => new NetworkError("doh_endpoint_invalid", false, "DoH 解析服务地址无效。请清空该设置，或填写公开、无凭据的 HTTPS DNS JSON 地址。");

function networkDir(stateDir: string): string | null {
  const directory = join(stateDir, "network");
  let info;
  try { info = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new SettingsValueError("network settings path denied"); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new SettingsValueError("network settings path denied");
  return directory;
}

export function readJson(path: string): Row {
  let fd: number;
  try { if (lstatSync(path).isSymbolicLink()) throw new SettingsValueError("network settings file must not be a symlink, junction, or reparse point"); } catch (error) {
    if (error instanceof SettingsValueError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
  }
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new SettingsValueError("network settings file is unavailable");
  }
  const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
  let size = 0;
  try { for (let read = 1; read > 0 && size < buffer.length; size += read) read = readSync(fd, buffer, size, buffer.length - size, null); }
  catch { throw new SettingsValueError("network settings file is unavailable"); } finally { closeSync(fd); }
  if (size > MAX_SETTINGS_BYTES) throw new SettingsValueError("network settings file is too large");
  let value: unknown;
  try { value = pyJsonLoads(pyDecodeUtf8(buffer.subarray(0, size))); } catch { throw new SettingsValueError("network settings file is invalid"); }
  if (!isDict(value)) throw new SettingsValueError("network settings file is invalid");
  return value;
}

const fileIn = (stateDir: string, name: string): Row => { const directory = networkDir(stateDir); return directory ? readJson(join(directory, name)) : {}; };
const readSettings = (stateDir: string): Row => fileIn(stateDir, "settings.json");
const savedKeyFrom = (value: Row): string => typeof value.apiKey === "string" && Array.from(value.apiKey).length <= MAX_KEY_LENGTH ? value.apiKey : "";
function savedKey(stateDir: string, provider: Provider): string {
  if (provider === "searxng") return "";
  return savedKeyFrom(fileIn(stateDir, provider === "brave" ? "search-key.json" : "search-key-tavily.json"));
}
const savedModelKey = (stateDir: string): string => savedKeyFrom(fileIn(stateDir, "search-model-key.json"));
export const keyUsable = (value: unknown): value is string => typeof value === "string" && !!value && Array.from(value).length <= MAX_KEY_LENGTH && !/[\r\n]/.test(value);
const providerOf = (settings: Row, env: Env): unknown => pyTruthy(settings.searchProvider) ? settings.searchProvider : env.XUENESS_SEARCH_PROVIDER ?? "brave";
const isProvider = (value: unknown): value is Provider => typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);

function searchProvider(stateDir: string, env: Env): Provider {
  const provider = providerOf(readSettings(stateDir), env);
  if (!isProvider(provider)) throw new NetworkError("search_provider_invalid", false, "搜索服务类型无效，请在网络搜索设置中重新选择。");
  return provider;
}

function environmentKey(provider: Provider, env: Env): string {
  if (provider === "searxng") return "";
  const specific = env["XUENESS_" + provider.toUpperCase() + "_SEARCH_KEY"] ?? "";
  if (keyUsable(specific)) return specific;
  return (env.XUENESS_SEARCH_PROVIDER ?? "brave") === provider ? env.XUENESS_SEARCH_KEY ?? "" : "";
}

function serviceView(stateDir: string, stored: Row, provider: Provider, env: Env): Row {
  const endpoints = stored.searchEndpoints;
  let endpoint: unknown = isDict(endpoints) ? endpoints[provider] ?? null : null;
  if (typeof endpoint !== "string" || !endpoint) endpoint = providerOf(stored, env) === provider ? stored.searchEndpoint ?? null : null;
  if (typeof endpoint !== "string" || !endpoint) endpoint = (env.XUENESS_SEARCH_PROVIDER ?? "brave") === provider ? env.XUENESS_SEARCH_ENDPOINT ?? null : null;
  const chosen = (endpoint as string | null) || DEFAULT_ENDPOINTS[provider];
  const saved = savedKey(stateDir, provider), environment = environmentKey(provider, env);
  const source = keyUsable(saved) ? "saved" : keyUsable(environment) ? "environment" : "none";
  return { searchEndpoint: chosen, hasSearchKey: source !== "none", hasSavedSearchKey: keyUsable(saved), hasEnvironmentSearchKey: keyUsable(environment), searchKeySource: source, requiresSearchKey: provider !== "searxng" };
}

const dohOf = (settings: Row, env: Env): string => typeof settings.dohEndpoint === "string" ? settings.dohEndpoint : env.XUENESS_DOH_ENDPOINT ?? "";
const modeOf = (settings: Row): "service" | "model" => settings.searchMode === "model" ? "model" : "service";

/** `get_settings`: the public view (never a key). */
export function getSettings(stateDir: string, env: Env): Row {
  const stored = readSettings(stateDir);
  const provider = searchProvider(stateDir, env);
  const services = Object.fromEntries(PROVIDERS.map((name) => [name, serviceView(stateDir, stored, name, env)]));
  let image: unknown = stored.imageSearchEndpoint;
  if (typeof image !== "string" || !image) image = env.XUENESS_IMAGE_SEARCH_ENDPOINT ?? "";
  const modelKey = savedModelKey(stateDir);
  return { ...services[provider], searchProvider: provider, searchServices: services, imageSearchEndpoint: image, dohEndpoint: dohOf(stored, env), searchMode: modeOf(stored),
    searchModelEndpoint: typeof stored.searchModelEndpoint === "string" ? stored.searchModelEndpoint : "", searchModel: typeof stored.searchModel === "string" ? stored.searchModel : "",
    hasSearchModelKey: keyUsable(modelKey), hasSavedSearchModelKey: keyUsable(modelKey) };
}

/** `_valid_https_endpoint`. */
export function validEndpoint(value: unknown, doh = false): boolean {
  let host: string;
  try { host = parseHttpsUrl(value, false).host; } catch (error) { if (error instanceof NetworkError) return false; throw error; }
  if (doh && !urlsplit(value as string).path) return false;
  const normalized = host.replace(/\.+$/, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  const address = parseIp(normalized);
  return !(address && !isGlobal(address));
}

export const getSearchMode = (stateDir: string): "service" | "model" => modeOf(readSettings(stateDir));

/** `resolve_service_config`: provider, endpoint, key, DoH. */
export function resolveServiceConfig(stateDir: string, env: Env): [Provider, string, string, string] {
  const settings = readSettings(stateDir);
  const provider = searchProvider(stateDir, env);
  const endpoint = serviceView(stateDir, settings, provider, env).searchEndpoint as string;
  const doh = dohOf(settings, env);
  const saved = savedKey(stateDir, provider);
  const key = keyUsable(saved) ? saved : environmentKey(provider, env);
  if (!validEndpoint(endpoint)) throw new NetworkError("search_endpoint_invalid", false, "网页搜索服务地址无效。请在网络搜索设置中填写公开 HTTPS JSON 搜索服务地址。");
  if (provider !== "searxng" && !keyUsable(key)) throw new NetworkError("search_key_missing", false, "尚未配置网页搜索密钥。请在设置的网络搜索页保存服务密钥，或由管理员设置 XUENESS_SEARCH_KEY。");
  if (doh && !validEndpoint(doh, true)) throw DOH_INVALID();
  return [provider, endpoint, key, doh];
}

/** `resolve_image_search_config`: endpoint, Brave key, DoH. */
export function resolveImageSearchConfig(stateDir: string, env: Env): [string, string, string] {
  const settings = readSettings(stateDir);
  let configured: unknown = settings.imageSearchEndpoint;
  if (typeof configured !== "string" || !configured) configured = env.XUENESS_IMAGE_SEARCH_ENDPOINT ?? "";
  const isConfigured = typeof configured === "string" && !!pyStrip(configured);
  if (modeOf(settings) === "model" && !isConfigured) throw new NetworkError("image_search_unsupported", false, "当前搜索模型模式没有配置真实图片搜索服务。请在网络搜索设置中填写图片搜索 HTTPS 地址；搜索模型不会生成或伪造图片搜索结果。");
  const endpoint = isConfigured ? pyStrip(configured as string) : DEFAULT_IMAGE_ENDPOINT;
  if (!validEndpoint(endpoint)) throw new NetworkError("image_search_endpoint_invalid", false, "图片搜索服务地址无效。请在网络搜索设置中填写公开 HTTPS Brave Image Search 兼容地址。");
  const saved = savedKey(stateDir, "brave");
  const key = keyUsable(saved) ? saved : environmentKey("brave", env);
  if (!keyUsable(key)) throw new NetworkError("image_search_key_missing", false, "尚未配置图片搜索服务密钥。请在网络搜索设置中保存服务密钥，或由管理员设置 XUENESS_SEARCH_KEY。");
  const doh = dohOf(settings, env);
  if (doh && !validEndpoint(doh, true)) throw DOH_INVALID();
  return [endpoint, key, doh];
}

/** `resolve_search_model_config`: endpoint, model, key, DoH. */
export function resolveSearchModelConfig(stateDir: string, env: Env): [string, string, string, string] {
  const settings = readSettings(stateDir);
  const endpoint = Object.hasOwn(settings, "searchModelEndpoint") ? settings.searchModelEndpoint : "";
  const model = Object.hasOwn(settings, "searchModel") ? settings.searchModel : "";
  const key = savedModelKey(stateDir);
  const doh = dohOf(settings, env);
  if (typeof endpoint !== "string" || !validEndpoint(endpoint)) throw new NetworkError("search_model_endpoint_invalid", false, "搜索模型接口地址无效。请填写公开 HTTPS OpenAI-compatible Chat Completions 地址；暂不支持本机或私网模型地址。");
  if (typeof model !== "string" || !pyStrip(model) || Array.from(model).length > 200 || /[\x00-\x1f]/.test(model)) throw new NetworkError("search_model_missing", false, "尚未填写搜索模型名称。请在网络搜索设置中填写服务商提供的 model ID。");
  if (!key || Array.from(key).length > MAX_KEY_LENGTH || /[\r\n]/.test(key)) throw new NetworkError("search_model_key_missing", false, "尚未配置搜索模型密钥。请在网络搜索设置中保存独立的搜索模型 API 密钥。");
  if (doh && !validEndpoint(doh, true)) throw DOH_INVALID();
  return [endpoint, pyStrip(model), key, doh];
}
