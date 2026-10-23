/**
 * `search_services.py` (Brave, Tavily and SearXNG behind one result shape)
 * and `search_model.py` (an OpenAI-compatible model whose sources are labelled
 * unverified).
 */
import { isDict, JsonFloat, pyJsonLoads, pySlice, pyStr, pyStrip, pyLen } from "@xueness/contracts";
import { NetworkError, type Row } from "./errors.ts";
import { isGlobal, parseIp } from "./ip.ts";
import type { Net } from "./net.ts";
import { fetchPage, postJson } from "./transport.ts";
import { parseHttpsUrl, unquote, urlencode } from "./urls.ts";
import { resolveSearchModelConfig, type Env, type Provider } from "./settings.ts";

export const MAX_RESULTS = 5;
const LOSSLESS = { lossless: true } as const;
const invalidResults = (): NetworkError => new NetworkError("search_response_invalid", false, "搜索服务未返回有效的结果列表。请检查服务类型和接口地址；SearXNG 实例需要启用 JSON 输出。");
export const invalidQuery = (): NetworkError => new NetworkError("invalid_query", false, "搜索内容必须是 1 到 1000 个字符，请缩短后重试。");
const get = (row: Row, key: string, fallback: unknown): unknown => Object.hasOwn(row, key) ? row[key] : fallback;

function httpsShape(url: string): string | null {
  try { return parseHttpsUrl(url, true).host; } catch (error) { if (error instanceof NetworkError) return null; throw error; }
}

/** `search_services.normalize`. */
export function normalize(payload: unknown, provider: string, query: string, key = "", dnsSource = "system"): Row {
  if (!isDict(payload)) throw invalidResults();
  let rows: unknown;
  if (provider === "brave" && Object.hasOwn(payload, "web")) rows = isDict(payload.web) ? get(payload.web, "results", null) : null;
  else rows = get(payload, "results", null);
  if (!Array.isArray(rows)) throw invalidResults();
  const output: Row[] = [];
  for (const item of rows.slice(0, 100)) {
    if (!isDict(item)) continue;
    const url = get(item, "url", null);
    if (typeof url !== "string" || pyLen(url) > 4096 || httpsShape(url) === null) continue;
    const row = { title: pySlice(pyStr(get(item, "title", "")), 300), url, description: pySlice(pyStr(get(item, provider === "brave" ? "description" : "content", "")), 1000) };
    if (key && Object.values(row).some((value) => unquote(value).includes(key))) continue;
    output.push(row);
    if (output.length >= MAX_RESULTS) break;
  }
  const result: Row = { ok: true, query, sourceType: "search_service", searchProvider: provider, untrusted: true, output, dnsSource,
    provenance: { kind: "search_service", provider, urlsVerified: false, dnsSource } };
  const credits = isDict(payload.usage) ? get(payload.usage, "credits", null) : null;
  const numeric = typeof credits === "number" ? credits : credits instanceof JsonFloat ? credits.value : null;
  if (provider === "tavily" && numeric !== null && numeric >= 0 && numeric <= 100) result.usage = { credits };
  return result;
}

/** `search_services.search`. */
export async function searchService(net: Net, provider: Provider, endpoint: string, key: string, doh: string, query: unknown, signal?: AbortSignal): Promise<Row> {
  if (typeof query !== "string" || !pyStrip(query) || pyLen(query) > 1000) throw invalidQuery();
  query = pyStrip(query);
  let payload: unknown, dnsSource: string;
  try {
    if (provider === "tavily") {
      [payload, dnsSource] = await postJson(net, endpoint, { query, search_depth: "basic", max_results: MAX_RESULTS, topic: "general", include_answer: false, include_raw_content: false,
        include_images: false, auto_parameters: false, include_usage: true }, { Authorization: "Bearer " + key }, { dohEndpoint: doh, ...(signal ? { signal } : {}) });
    } else {
      const params: [string, string | number][] = [["q", query as string], provider === "searxng" ? ["format", "json"] : ["count", MAX_RESULTS]];
      const headers: Record<string, string> = { Accept: "application/json" };
      if (provider === "brave") headers["X-Subscription-Token"] = key;
      const response = await fetchPage(net, endpoint + "?" + urlencode(params), { headers, maxChars: 1_000_000, dohEndpoint: doh, ...(signal ? { signal } : {}) });
      try { payload = pyJsonLoads(response.output as string, LOSSLESS); } catch { throw invalidResults(); }
      dnsSource = String(response.dnsSource ?? "system");
    }
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      throw new NetworkError("search_access_denied", false, provider === "searxng" ? "SearXNG 拒绝了请求，请确认实例允许 JSON 搜索接口。" : "搜索服务密钥无效或没有访问权限，请检查当前服务的密钥。", error.httpStatus);
    }
    if (provider === "tavily" && (error.httpStatus === 432 || error.httpStatus === 433)) {
      throw new NetworkError("search_quota_exhausted", false, "Tavily 搜索额度已用完或达到用量上限。请等待额度重置或切换搜索服务。", error.httpStatus);
    }
    if (error.code.startsWith("search_model_")) throw invalidResults();
    throw error;
  }
  return normalize(payload, provider, query as string, key, dnsSource);
}

const SYSTEM_PROMPT = "Find useful sources for the user's query. If this endpoint has an enabled web search capability, use it; if it does not, do not invent source claims. Return only one JSON object with this shape: {\"summary\": string, \"sources\": [{\"title\": string, \"url\": string, \"snippet\": string}]}. Sources must be URLs you can provide; an empty sources array is better than invented URLs. Keep summary concise.";
const modelInvalid = (reason: string): NetworkError => new NetworkError("search_model_response_invalid", false, reason);

function content(response: Row): string {
  const choices = get(response, "choices", null);
  if (!Array.isArray(choices) || !choices.length || !isDict(choices[0])) throw modelInvalid("搜索模型响应中没有 OpenAI-compatible assistant message。");
  const message = get(choices[0], "message", null);
  if (!isDict(message) || typeof message.content !== "string") throw modelInvalid("搜索模型没有返回 JSON assistant 内容；不会把自由文本当成搜索结果。");
  return message.content;
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || pyLen(value) > 4096) return null;
  const host = httpsShape(value);
  if (host === null) return null;
  const address = parseIp(host);
  return address && !isGlobal(address) ? null : value;
}

/** `search_model.search`. */
export async function searchModel(net: Net, stateDir: string, env: Env, query: unknown, signal?: AbortSignal): Promise<Row> {
  if (typeof query !== "string" || !pyStrip(query) || pyLen(query) > 1000) throw invalidQuery();
  const [endpoint, model, key, doh] = resolveSearchModelConfig(stateDir, env);
  if (/[\r\n]/.test(key)) throw new NetworkError("search_model_key_invalid", false, "搜索模型密钥格式无效，请重新保存密钥。");
  const payload = { model, temperature: 0, max_tokens: 1200, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: pyStrip(query) }] };
  const [response, dnsSource] = await postJson(net, endpoint, payload, { Authorization: "Bearer " + key }, { dohEndpoint: doh, ...(signal ? { signal } : {}) });
  let decoded: unknown;
  const text = content(response);
  try { decoded = pyJsonLoads(text, LOSSLESS); } catch { throw modelInvalid("搜索模型没有返回所需 JSON 结果；不会把自由文本当成已验证网页搜索。"); }
  if (!isDict(decoded) || !Array.isArray(get(decoded, "sources", null))) throw modelInvalid("搜索模型 JSON 必须包含 sources 数组；请检查模型是否遵循输出格式。");
  let summary = get(decoded, "summary", "");
  if (typeof summary !== "string") summary = "";
  if ((summary as string).includes(key)) summary = "[已隐藏包含密钥的模型输出]";
  const output: Row[] = [];
  for (const item of (decoded.sources as unknown[]).slice(0, 20)) {
    if (!isDict(item)) continue;
    const url = sourceUrl(get(item, "url", null));
    if (!url) continue;
    const title = pySlice(pyStr(get(item, "title", "")), 300), description = pySlice(pyStr(get(item, "snippet", "")), 1000);
    if ([url, title, description].some((value) => key && value.includes(key))) continue;
    output.push({ title, url, description, verified: false, urlCheck: "https_syntax_only" });
    if (output.length >= MAX_RESULTS) break;
  }
  return { ok: true, query: pyStrip(query), sourceType: "search_model", dnsSource, untrusted: true, summary: pySlice(summary as string, 1200), output,
    provenance: { kind: "search_model", model, networkAccess: "unverified", urlsVerified: false, dnsSource },
    notice: "搜索摘要和来源由模型生成；Xueness 未验证模型是否访问互联网或这些网页。网址仅做 HTTPS 结构检查。" };
}
