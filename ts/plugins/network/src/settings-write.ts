/**
 * `search_settings.update_settings`: validate a partial update and persist
 * `network/settings.json` plus owner-private key files. The returned view
 * never includes a credential. Key order in the JSON matches CPython.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDict, pyJsonDumps, pyLen, pyStrip, pyTruthy } from "@xueness/contracts";
import { protectPrivateFile } from "@xueness/sessions";
import type { Row } from "./errors.ts";
import { DEFAULT_ENDPOINTS, getSettings, PROVIDERS, readJson, SettingsValueError, validEndpoint, type Env, type Provider } from "./settings.ts";

const MAX_KEY_LENGTH = 4096;
const ALLOWED = new Set(["searchProvider", "searchEndpoint", "imageSearchEndpoint", "dohEndpoint", "searchMode", "searchKey", "clearSearchKey", "searchModelEndpoint", "searchModel", "searchModelKey", "clearSearchModelKey"]);
const COPIED = ["searchProvider", "searchEndpoint", "imageSearchEndpoint", "dohEndpoint", "searchMode", "searchModelEndpoint", "searchModel"] as const;
const UPDATED = ["imageSearchEndpoint", "dohEndpoint", "searchMode", "searchModelEndpoint", "searchModel"] as const;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const isProvider = (value: unknown): value is Provider => typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
const providerOf = (settings: Row, env: Env): unknown => pyTruthy(settings.searchProvider) ? settings.searchProvider : env.XUENESS_SEARCH_PROVIDER ?? "brave";

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function validateEndpoint(value: unknown, doh: boolean): string {
  if (typeof value !== "string" || !pyStrip(value) || pyLen(value) > 2048) throw new SettingsValueError("请填写 HTTPS 服务地址。");
  const endpoint = pyStrip(value);
  if (!validEndpoint(endpoint, doh)) throw new SettingsValueError(doh ? "DoH 地址必须是无凭据、无查询参数的 HTTPS DNS JSON 服务地址，端口只能为 443。" : "搜索地址必须是无凭据、无查询参数的 HTTPS 服务地址，端口只能为 443。");
  return endpoint;
}

function optionalEndpoint(value: unknown, typeMessage: string, doh: boolean): string {
  if (typeof value !== "string") throw new SettingsValueError(typeMessage);
  return pyStrip(value) ? validateEndpoint(value, doh) : "";
}

/** Reject unknown fields before any directory is created, in Python's order. */
function normalized(data: Row): Row {
  if (Object.keys(data).some((key) => !ALLOWED.has(key))) throw new SettingsValueError("包含不支持的网络搜索设置字段。");
  if (Object.hasOwn(data, "clearSearchKey") && typeof data.clearSearchKey !== "boolean") throw new SettingsValueError("clearSearchKey 必须是布尔值。");
  if (Object.hasOwn(data, "clearSearchModelKey") && typeof data.clearSearchModelKey !== "boolean") throw new SettingsValueError("clearSearchModelKey 必须是布尔值。");
  for (const field of ["searchKey", "searchModelKey"] as const) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field];
    if (typeof value !== "string") throw new SettingsValueError("API 密钥必须是文本。");
    if (pyLen(value) > MAX_KEY_LENGTH || /[\r\n]/.test(value)) throw new SettingsValueError("API 密钥格式无效或超过长度限制。");
  }
  if (Object.hasOwn(data, "searchMode") && data.searchMode !== "service" && data.searchMode !== "model") throw new SettingsValueError("searchMode 必须是 service 或 model。");
  if (Object.hasOwn(data, "searchProvider") && !isProvider(data.searchProvider)) throw new SettingsValueError("搜索服务必须是 brave、tavily 或 searxng。");
  let next: Row = { ...data };
  if (Object.hasOwn(data, "searchEndpoint")) next = { ...next, searchEndpoint: validateEndpoint(data.searchEndpoint, false) };
  if (Object.hasOwn(data, "imageSearchEndpoint")) next = { ...next, imageSearchEndpoint: optionalEndpoint(data.imageSearchEndpoint, "图片搜索服务地址必须是文本。", false) };
  if (Object.hasOwn(data, "searchModelEndpoint")) next = { ...next, searchModelEndpoint: optionalEndpoint(data.searchModelEndpoint, "搜索模型接口地址必须是文本。", false) };
  if (Object.hasOwn(data, "searchModel")) {
    const model = data.searchModel;
    if (typeof model !== "string" || pyLen(model) > 200 || /[\u0000-\u001f]/.test(model)) throw new SettingsValueError("搜索模型名称格式无效。");
    next = { ...next, searchModel: pyStrip(model) };
  }
  if (Object.hasOwn(data, "dohEndpoint")) next = { ...next, dohEndpoint: optionalEndpoint(data.dohEndpoint, "DoH 服务地址必须是文本。", true) };
  return next;
}

function ensureNetworkDir(stateDir: string): string {
  const directory = join(stateDir, "network");
  if (isLink(directory)) throw new SettingsValueError("network settings path denied");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (isLink(directory) || !lstatSync(directory).isDirectory()) throw new SettingsValueError("network settings path denied");
  try { chmodSync(directory, 0o700); } catch { /* Windows keeps the directory ACL; Python ignores chmod failure. */ }
  return directory;
}

function writeAll(fd: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(fd, payload, offset, payload.length - offset);
    if (written <= 0) throw Object.assign(new Error("network settings write failed"), { code: "EIO" });
    offset += written;
  }
}

function mkstemp(directory: string): { fd: number; path: string } {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let name = ".network-";
    for (const byte of randomBytes(8)) name += alphabet[byte % alphabet.length]!;
    const path = join(directory, name);
    try { return { fd: openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600), path }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw Object.assign(new Error("No usable temporary file name found"), { code: "EEXIST" });
}

function replaceFile(source: string, destination: string): void {
  const deadline = Date.now() + 500;
  for (;;) {
    try { renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code) || Date.now() >= deadline) throw error;
      const until = Date.now() + 10;
      while (Date.now() < until) { /* Python retries brief Windows sharing collisions. */ }
    }
  }
}

/** `json.dump(..., ensure_ascii=False, separators=(",", ":"))` via a private temp file. */
function writeJson(path: string, value: Row): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (isLink(parent) || isLink(path)) throw new SettingsValueError("network settings path denied");
  const temporary = mkstemp(parent);
  let fd: number | null = temporary.fd;
  try {
    try { protectPrivateFile(temporary.fd); }
    catch (error) { try { closeSync(temporary.fd); } catch { /* already closed */ } fd = null; throw error; }
    writeAll(temporary.fd, Buffer.from(pyJsonDumps(value, { ensureAscii: false, separators: [",", ":"] }), "utf8"));
    fsyncSync(temporary.fd); closeSync(temporary.fd); fd = null;
    replaceFile(temporary.path, path);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    if (existsSync(temporary.path)) { try { unlinkSync(temporary.path); } catch { /* replace already consumed it */ } }
  }
}

function endpointMap(current: Row): Row {
  const probed = Object.hasOwn(current, "searchEndpoints") ? current.searchEndpoints : {};
  if (!isDict(probed)) return {};
  const endpoints: Row = {};
  for (const name of Object.keys(probed)) {
    const value = probed[name];
    if (isProvider(name) && typeof value === "string") endpoints[name] = value;
  }
  return endpoints;
}

function secretFile(provider: Provider): string {
  return provider === "brave" ? "search-key.json" : "search-key-tavily.json";
}

function removeSecret(path: string): void {
  if (isLink(path)) throw new SettingsValueError("network credential path denied");
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function storeSecret(path: string, apiKey: string): void {
  if (isLink(path)) throw new SettingsValueError("network credential path denied");
  writeJson(path, { apiKey });
}

/** `update_settings`. `env` is Python's `os.environ` for the provider fallback. */
export function updateSettings(stateDir: string, data: unknown, env: Env = process.env): Row {
  if (!isDict(data)) throw new SettingsValueError("请求内容必须是对象。");
  const next = normalized(data);
  const directory = ensureNetworkDir(stateDir);
  const current = readJson(join(directory, "settings.json"));
  const settings: Row = {};
  for (const key of COPIED) if (typeof current[key] === "string") settings[key] = current[key];
  const oldProvider = providerOf(current, env);
  const provider = Object.hasOwn(data, "searchProvider") ? data.searchProvider : oldProvider;
  if (!isProvider(provider)) throw new SettingsValueError("搜索服务类型无效，请重新选择。");
  const endpoints = endpointMap(current);
  if (isProvider(oldProvider) && typeof current.searchEndpoint === "string" && !Object.hasOwn(endpoints, oldProvider)) endpoints[oldProvider] = current.searchEndpoint;
  if (Object.hasOwn(data, "searchEndpoint")) endpoints[provider] = next.searchEndpoint;
  settings.searchProvider = provider;
  settings.searchEndpoints = endpoints;
  const chosen = endpoints[provider];
  settings.searchEndpoint = typeof chosen === "string" && chosen ? chosen : DEFAULT_ENDPOINTS[provider];
  for (const field of UPDATED) if (Object.hasOwn(data, field)) settings[field] = next[field];
  writeJson(join(directory, "settings.json"), settings);
  if (data.clearSearchKey === true && provider !== "searxng") removeSecret(join(directory, secretFile(provider)));
  else if (typeof data.searchKey === "string" && pyTruthy(data.searchKey) && provider !== "searxng") storeSecret(join(directory, secretFile(provider)), data.searchKey);
  if (data.clearSearchModelKey === true) removeSecret(join(directory, "search-model-key.json"));
  else if (typeof data.searchModelKey === "string" && pyTruthy(data.searchModelKey)) storeSecret(join(directory, "search-model-key.json"), data.searchModelKey);
  return getSettings(stateDir, env);
}
