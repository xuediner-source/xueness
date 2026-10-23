/**
 * `bundled_plugins/network/transport.py`: every connection goes to an address
 * that passed an all-record public-IP check, TLS still verifies the requested
 * host, a configured DoH resolver is used only when the system answer is
 * FakeIP (198.18.0.0/15) alone, nothing follows redirects, bodies are capped.
 */
import { pyDecodeUtf8, pyJsonDumps, pyJsonLoads, pySlice, isDict, isPyIntValue, pyLen } from "@xueness/contracts";
import { NetworkError, type Row } from "./errors.ts";
import { equalsInt, fakeIpOnly, ipText, isGlobal, parseIp } from "./ip.ts";
import { failureKind, type Net, type HttpResponse } from "./net.ts";
import { parseHttpsUrl, urlencode } from "./urls.ts";
import { htmlText } from "./html.ts";
import { activityOrigin, emitNetworkActivity, normalizeFetchUrl, type NetworkActivityCallback } from "./fetch-runtime.ts";

export const MAX_BYTES = 1_000_000;
export const MAX_MODEL_REQUEST_BYTES = 65_536;
export const MAX_MODEL_RESPONSE_BYTES = 512_000;
export const MAX_DOH_BYTES = 65_536;
export const MAX_DNS_ANSWERS = 32;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DNS_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 5;
const LOSSLESS = { lossless: true } as const;

const err = (code: string, retryable: boolean, reason: string, status: number | null = null): NetworkError => new NetworkError(code, retryable, reason, status);
const temporary = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;
const mediaType = (value: string): string => value.split(";", 1)[0]!.trim().toLowerCase();

/** `_system_addresses`. */
export async function systemAddresses(net: Net, host: string): Promise<string[]> {
  let records: string[];
  try { records = await net.lookup(host); } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    if (code === "EAI_AGAIN" || code === "EAI_MEMORY" || code === "EAI_SYSTEM") throw err("dns_resolution_temporary", true, "系统 DNS 暂时无法解析目标域名，请检查网络后重试。");
    if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "EAI_NODATA") throw err("dns_name_not_found", false, "系统 DNS 没有该域名的地址记录，请检查网址或 DNS 配置。");
    if (code.startsWith("EAI_")) throw err("dns_resolution_failed", false, "系统 DNS 无法解析目标域名，请检查网址或 DNS 配置。");
    throw err("dns_resolution_failed", true, "系统 DNS 查询暂时失败，请检查网络后重试。");
  }
  const addresses = [...new Set(records.map((address) => address.split("%", 1)[0]!))].sort();
  if (!addresses.length) throw err("dns_resolution_failed", true, "系统 DNS 没有返回目标地址，请检查域名后重试。");
  return addresses;
}

/** `_checked_public_addresses`. */
export function checkedPublic(addresses: readonly unknown[]): string[] {
  if (!addresses.length || addresses.length > MAX_DNS_ANSWERS) throw err("dns_answer_invalid", false, "目标 DNS 应答为空或记录过多，已停止连接；请检查域名配置。");
  const parsed: string[] = [];
  for (const raw of addresses) {
    const address = parseIp(raw);
    if (!address) throw err("dns_answer_invalid", false, "目标 DNS 返回了无法识别的地址，已停止连接。");
    if (!isGlobal(address)) throw err("ssrf_blocked", false, "目标解析到非公网地址，已按 SSRF 安全规则阻止请求。请改用公开网站；只有确认代理使用 FakeIP 时，才配置公开 DoH 解析服务。");
    parsed.push(ipText(address));
  }
  return [...new Set(parsed)].sort();
}

function exchangeFailure(error: unknown, texts: { timeout: NetworkError; certificate: NetworkError; tls: NetworkError; other: NetworkError }): NetworkError {
  if (error instanceof NetworkError) return error;
  return texts[failureKind(error)];
}

/** `_doh_addresses`. */
async function dohAddresses(net: Net, host: string, endpoint: string, signal?: AbortSignal): Promise<string[]> {
  const { parsed, host: resolverHost } = parseHttpsUrl(endpoint, false);
  const resolverIp = checkedPublic(await systemAddresses(net, resolverHost))[0]!;
  const basePath = parsed.path || "/dns-query";
  const found: string[] = [];
  for (const recordType of ["A", "AAAA"] as const) {
    const path = basePath + "?" + urlencode([["name", host], ["type", recordType]]);
    let raw: Buffer;
    let response: HttpResponse | null = null;
    try {
      response = await net.request({ host: resolverHost, address: resolverIp, method: "GET", path, headers: { Accept: "application/dns-json", "User-Agent": "Xueness/1" }, timeoutMs: DNS_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      if (response.status !== 200) throw err("doh_request_failed", temporary(response.status), "配置的 DoH 服务未能完成 DNS 查询，请检查解析服务地址后重试。", response.status);
      if (mediaType(response.contentType) !== "application/dns-json") throw err("doh_response_invalid", false, "配置的 DoH 服务返回格式不受支持，请使用公开 DNS JSON-over-HTTPS 服务。");
      raw = await response.read(MAX_DOH_BYTES + 1);
      if (raw.length > MAX_DOH_BYTES) throw err("doh_response_invalid", false, "配置的 DoH 服务返回内容过大，已停止查询。");
    } catch (error) {
      const failed = err("doh_request_failed", true, "连接配置的 DoH 服务暂时失败，请检查网络后重试。");
      throw exchangeFailure(error, { timeout: err("doh_timeout", true, "配置的 DoH 服务响应超时，请检查服务地址或稍后重试。"), certificate: failed, tls: failed, other: failed });
    } finally { response?.close(); }
    let payload: unknown;
    try { payload = pyJsonLoads(pyDecodeUtf8(raw), LOSSLESS); } catch { throw err("doh_response_invalid", false, "配置的 DoH 服务返回了无效 JSON，应更换解析服务。"); }
    if (!isDict(payload) || !isPyIntValue(payload.Status)) throw err("doh_response_invalid", false, "配置的 DoH 服务返回了无效 DNS 状态码，请检查解析服务配置。");
    const status = Number(payload.Status);
    if (status !== 0) {
      if (status === 3) throw err("dns_name_not_found", false, "DoH 服务确认该域名不存在，请检查网址或 DNS 配置。");
      if (status === 2) throw err("doh_lookup_failed", true, "配置的 DoH 服务暂时无法完成 DNS 查询，请检查网络后重试。");
      throw err("doh_lookup_failed", false, "配置的 DoH 服务拒绝或无法解析此 DNS 查询，请检查域名和服务配置。");
    }
    const answers = Object.hasOwn(payload, "Answer") ? payload.Answer : [];
    if (!Array.isArray(answers) || answers.length > MAX_DNS_ANSWERS) throw err("doh_response_invalid", false, "配置的 DoH 服务返回了无效或过多的 DNS 记录。");
    const expected = recordType === "A" ? 1 : 28;
    for (const item of answers) {
      if (!isDict(item) || !equalsInt(item.type ?? null, expected)) continue;
      const ip = parseIp(Object.hasOwn(item, "data") ? item.data : null);
      if (!ip) throw err("doh_response_invalid", false, "配置的 DoH 服务返回了无效地址，已停止连接。");
      found.push(ipText(ip));
    }
  }
  return checkedPublic(found);
}

/** `resolve_public`: the validated address set and where it came from. */
export async function resolvePublic(net: Net, host: string, dohEndpoint = "", signal?: AbortSignal): Promise<[string[], "system" | "configured_doh"]> {
  const addresses = await systemAddresses(net, host);
  if (fakeIpOnly(addresses)) {
    if (!dohEndpoint) throw err("fakeip_dns_blocked", false, "系统 DNS 返回了 FakeIP 地址，已阻止请求。若代理使用 FakeIP，可在网络工具设置中明确填写公开 DoH HTTPS 解析服务；否则请调整代理的 DNS 模式。");
    return [await dohAddresses(net, host, dohEndpoint, signal), "configured_doh"];
  }
  return [checkedPublic(addresses), "system"];
}

const ACCEPTED = new Set(["text/html", "text/plain", "application/json", "application/xhtml+xml"]);
const LENIENT = new TextDecoder("utf-8", { ignoreBOM: true });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function requestBudget(signal?: AbortSignal): { signal: AbortSignal; wait<T>(operation: () => Promise<T>): Promise<T>; remaining(): number; close(): void } {
  const controller = new AbortController();
  const deadline = performance.now() + REQUEST_TIMEOUT_MS;
  let timedOut = false, cancelled = false;
  const abortForCaller = (): void => { cancelled = true; controller.abort(); };
  if (signal?.aborted) abortForCaller();
  else signal?.addEventListener("abort", abortForCaller, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const failure = (): NetworkError => timedOut
    ? err("network_timeout", true, "连接目标服务器超时，请检查网络后重试。")
    : err("network_cancelled", false, "网络请求已取消。");
  const remaining = (): number => {
    if (controller.signal.aborted || performance.now() >= deadline) {
      if (!cancelled) { timedOut = true; controller.abort(); }
      throw failure();
    }
    return Math.max(1, Math.ceil(deadline - performance.now()));
  };
  return {
    signal: controller.signal,
    remaining,
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      remaining();
      let onAbort: (() => void) | undefined;
      const work = Promise.resolve().then(operation);
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(failure());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([work, aborted]); }
      finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
    },
    close(): void { clearTimeout(timer); signal?.removeEventListener("abort", abortForCaller); },
  };
}

function redirectTarget(current: string, location: string | undefined): ReturnType<typeof normalizeFetchUrl> {
  if (typeof location !== "string") throw err("redirect_location_missing", false, "目标服务器要求跳转但没有提供有效的 Location 地址。", 302);
  if (/[\\\x00-\x20\x7f]/.test(location)) throw err("redirect_url_invalid", false, "目标服务器提供了无效的跳转地址，已停止请求。");
  let target: URL;
  try { target = new URL(location, current); } catch { throw err("redirect_url_invalid", false, "目标服务器提供了无效的跳转地址，已停止请求。"); }
  if (target.protocol === "http:") throw err("redirect_downgrade_blocked", false, "目标服务器尝试从 HTTPS 降级到 HTTP，已按安全规则阻止跳转。");
  if (target.protocol !== "https:") throw err("redirect_url_invalid", false, "目标服务器提供了不受支持的跳转地址，已停止请求。");
  try { return normalizeFetchUrl(target.href); }
  catch (error) {
    if (error instanceof NetworkError) throw error;
    throw err("redirect_url_invalid", false, "目标服务器提供了无效的跳转地址，已停止请求。");
  }
}

/** `fetch(url, headers, max_chars, doh_endpoint=...)`. */
export async function fetchPage(net: Net, url: unknown, options: { headers?: Record<string, string>; maxChars?: number; dohEndpoint?: string; signal?: AbortSignal; requestId?: string; onActivity?: NetworkActivityCallback; followRedirects?: boolean } = {}): Promise<Row> {
  let current = normalizeFetchUrl(url);
  const originalUrl = url;
  const visited = new Set([current.url]);
  let redirects = 0;
  const budget = requestBudget(options.signal);
  let activityError: unknown;
  const reportHop = (phase: "started" | "redirected", host: string, count: number): void => {
    if (!options.requestId) return;
    try { emitNetworkActivity(options.onActivity, { type: "network_request", phase, requestId: options.requestId, url: `https://${host.includes(":") ? `[${host}]` : host}/`, redirects: count }); }
    catch (error) { activityError = error; throw error; }
  };
  try {
    for (;;) {
      const { host, path, url: hopUrl } = current;
      reportHop("started", host, redirects);
      let response: HttpResponse | null = null;
      let source: "system" | "configured_doh", raw: Buffer, kind: string;
      try {
        const [addresses, resolvedBy] = await budget.wait(() => resolvePublic(net, host, options.dohEndpoint ?? "", budget.signal));
        source = resolvedBy;
        response = await budget.wait(() => net.request({ host, address: addresses[0]!, method: "GET", path,
          headers: { Accept: "text/html, application/json, text/plain", "User-Agent": "Xueness/1", ...options.headers },
          timeoutMs: budget.remaining(), signal: budget.signal }));
        if (REDIRECTS.has(response.status)) {
          if (options.followRedirects !== true) throw err("http_permanent", false, "目标服务器拒绝了请求或要求跳转；请检查网址或服务配置。", response.status);
          if (redirects >= MAX_REDIRECTS) throw err("redirect_limit_exceeded", false, "目标页面的跳转次数超过安全上限，已停止请求。", response.status);
          const next = redirectTarget(hopUrl, response.location);
          if (visited.has(next.url)) throw err("redirect_loop", false, "目标页面形成了跳转循环，已停止请求。", response.status);
          visited.add(next.url); redirects += 1;
          reportHop("redirected", next.host, redirects);
          current = next;
          continue;
        }
        if (response.status !== 200) {
          const retry = temporary(response.status);
          throw err(retry ? "http_temporary" : "http_permanent", retry, retry ? "目标服务器暂时不可用，请稍后重试。" : "目标服务器拒绝了请求，请检查网址或服务配置。", response.status);
        }
        kind = mediaType(response.contentType);
        if (!ACCEPTED.has(kind)) throw err("unsupported_content", false, "目标返回了不支持的内容类型，请改用 HTML、纯文本或 JSON 页面。");
        raw = await budget.wait(() => response!.read(MAX_BYTES + 1));
        if (raw.length > MAX_BYTES) throw err("response_too_large", false, "目标内容超过读取上限，请选择较小的公开页面。");
      } catch (error) {
        if (error === activityError) throw error;
        throw exchangeFailure(error, {
          timeout: err("network_timeout", true, "连接目标服务器超时，请检查网络后重试。"),
          certificate: err("tls_certificate_invalid", false, "目标 HTTPS 证书无法验证，连接已停止；请检查网址或系统证书。"),
          tls: err("tls_handshake_failed", false, "目标 HTTPS 安全握手失败，连接已停止；请检查网址或系统代理配置。"),
          other: err("network_unavailable", true, "连接目标服务器暂时失败，请检查网络后重试。"),
        });
      } finally { response?.close(); }
      let text = LENIENT.decode(raw);
      if (kind === "text/html" || kind === "application/xhtml+xml") text = htmlText(text);
      const maxChars = options.maxChars ?? 16_000;
      const result: Row = { ok: true, url: originalUrl, finalUrl: hopUrl, redirects, contentType: kind, fullContent: text,
        output: pySlice(text, maxChars), truncated: pyLen(text) > maxChars, untrusted: true, dnsSource: source, sourceBytes: raw.length };
      budget.close();
      return result;
    }
  } catch (error) {
    budget.close();
    throw error;
  }
}

/** `post_json`: one bounded JSON POST to an explicitly configured public HTTPS endpoint. */
export async function postJson(net: Net, url: string, payload: Row, headers: Record<string, string>, options: { dohEndpoint?: string; signal?: AbortSignal } = {}): Promise<[Row, string]> {
  const { parsed, host } = parseHttpsUrl(url, false);
  let body: Buffer;
  const text = pyJsonDumps(payload, { separators: [",", ":"] });
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) throw err("search_model_request_invalid", false, "搜索模型请求内容无效，请检查查询后重试。");
  body = Buffer.from(text, "utf8");
  if (body.length > MAX_MODEL_REQUEST_BYTES) throw err("search_model_request_too_large", false, "搜索模型请求超过大小限制，请缩短查询内容。");
  const [addresses, source] = await resolvePublic(net, host, options.dohEndpoint ?? "", options.signal);
  let response: HttpResponse | null = null, raw: Buffer;
  try {
    response = await net.request({ host, address: addresses[0]!, method: "POST", path: parsed.path || "/", body,
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Xueness/1", ...headers }, timeoutMs: REQUEST_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) });
    if (response.status !== 200) {
      const retry = temporary(response.status);
      throw err(retry ? "http_temporary" : "http_permanent", retry, retry ? "搜索模型服务暂时不可用，请稍后重试。" : "搜索模型服务拒绝了请求或要求跳转；为保持安全，Xueness 不跟随重定向。请检查接口地址、模型 ID 和服务商权限。", response.status);
    }
    if (mediaType(response.contentType) !== "application/json") throw err("search_model_response_invalid", false, "搜索模型服务未返回 application/json 响应，请检查 OpenAI-compatible 接口地址。");
    raw = await response.read(MAX_MODEL_RESPONSE_BYTES + 1);
    if (raw.length > MAX_MODEL_RESPONSE_BYTES) throw err("search_model_response_too_large", false, "搜索模型响应超过大小限制，请限制服务端输出长度。");
  } catch (error) {
    throw exchangeFailure(error, {
      timeout: err("network_timeout", true, "连接搜索模型服务超时，请检查网络后重试。"),
      certificate: err("tls_certificate_invalid", false, "搜索模型服务的 HTTPS 证书无法验证，连接已停止。"),
      tls: err("tls_handshake_failed", false, "搜索模型服务 HTTPS 安全握手失败，连接已停止。"),
      other: err("network_unavailable", true, "连接搜索模型服务暂时失败，请检查网络后重试。"),
    });
  } finally { response?.close(); }
  let result: unknown;
  try { result = pyJsonLoads(pyDecodeUtf8(raw), LOSSLESS); } catch { throw err("search_model_response_invalid", false, "搜索模型服务返回了无效 JSON，请检查接口配置。"); }
  if (!isDict(result)) throw err("search_model_response_invalid", false, "搜索模型服务返回格式无效，请检查接口配置。");
  return [result, source];
}
