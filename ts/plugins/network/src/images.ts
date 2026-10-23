/**
 * `tooling.image_search`: one Brave Image Search compatible request whose
 * result URLs keep only public-HTTPS metadata. Image content is never
 * fetched; each distinct host is resolved once, at most 20 hosts within 15 s.
 */
import { isDict, isPyIntValue, pyJsonLoads, pyLen, pySlice, pyStrip } from "@xueness/contracts";
import { NetworkError, type Row } from "./errors.ts";
import type { Net } from "./net.ts";
import { fetchPage, resolvePublic } from "./transport.ts";
import { parseHttpsUrl, queryNames, unquote, urlencode, urlsplit } from "./urls.ts";
import { resolveImageSearchConfig, type Env } from "./settings.ts";

export const MAX_IMAGE_RESULTS = 10;
export const MAX_IMAGE_ROWS_TO_CHECK = 20;
export const MAX_IMAGE_DNS_HOSTS = 20;
export const IMAGE_URL_VALIDATION_MS = 15_000;
const SENSITIVE = new Set(["key", "token", "auth", "authorization", "signature", "sig", "secret", "password", "credential"]);
const PY_SPACE = /[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

export const invalidImageQuery = (): NetworkError => new NetworkError("invalid_query", false, "图片搜索内容必须是 1 到 400 个字符且不超过 50 个词，请缩短后重试。");
/** The tool's query check: 1-400 characters, at most 50 whitespace-separated words. */
export function imageQueryOk(query: unknown): query is string {
  return typeof query === "string" && !!pyStrip(query) && pyLen(query) <= 400 && pyStrip(query).split(PY_SPACE).length <= 50;
}

interface Budget { cache: Map<string, string | null>; deadline: number; exhausted: boolean; truncated: boolean; now: () => number }

async function checkedImageUrl(net: Net, value: unknown, doh: string, key: string, budget: Budget, signal?: AbortSignal): Promise<string | null> {
  if (typeof value !== "string" || !value || pyLen(value) > 4096) return null;
  if (key && (value.includes(key) || unquote(value).includes(key))) return null;
  let names: string[];
  try { names = queryNames(urlsplit(value).query); } catch { return null; }
  if (names.some((name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[._-]+/).some((part) => SENSITIVE.has(part)))) return null;
  let host: string;
  try { host = parseHttpsUrl(value, true).host; } catch (error) { if (error instanceof NetworkError) return null; throw error; }
  if (!budget.cache.has(host)) {
    if (budget.exhausted || budget.cache.size >= MAX_IMAGE_DNS_HOSTS || budget.now() >= budget.deadline) { budget.exhausted = budget.truncated = true; return null; }
    budget.cache.set(host, null);
    try {
      const [, source] = await resolvePublic(net, host, doh, signal);
      if (budget.now() >= budget.deadline) budget.exhausted = budget.truncated = true; else budget.cache.set(host, source);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      if (budget.now() >= budget.deadline) budget.exhausted = budget.truncated = true;
    }
  }
  return budget.cache.get(host) === null ? null : value;
}

const dimension = (...values: unknown[]): unknown => values.find((value) => isPyIntValue(value) && Number(value) > 0 && Number(value) <= 100_000) ?? null;
const dictAt = (row: Row, key: string): Row => isDict(row[key]) ? row[key] as Row : {};
const at = (row: Row, key: string): unknown => Object.hasOwn(row, key) ? row[key] : null;

/** `_image_search_payload`. */
export async function imageSearchPayload(net: Net, result: Row, key: string, query: string, doh: string, options: { now?: () => number; signal?: AbortSignal } = {}): Promise<Row> {
  let payload: unknown;
  try { payload = pyJsonLoads(result.output as string, { lossless: true }); } catch { throw new NetworkError("image_search_response_invalid", false, "图片搜索服务返回了无效 JSON，请检查服务是否兼容 Brave Image Search。"); }
  if (!isDict(payload) || !Array.isArray(payload.results)) throw new NetworkError("image_search_response_invalid", false, "图片搜索服务返回格式无效，请检查 Brave Image Search 兼容配置。");
  const now = options.now ?? (() => performance.now());
  const budget: Budget = { cache: new Map(), deadline: now() + IMAGE_URL_VALIDATION_MS, exhausted: false, truncated: false, now };
  const output: Row[] = [];
  const raw = payload.results as unknown[], rows = raw.slice(0, MAX_IMAGE_ROWS_TO_CHECK);
  let truncated = raw.length > rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    if (budget.exhausted) { truncated = true; break; }
    const item = rows[index];
    if (!isDict(item)) continue;
    const properties = dictAt(item, "properties"), thumbnail = dictAt(item, "thumbnail");
    const check = (value: unknown): Promise<string | null> => checkedImageUrl(net, value, doh, key, budget, options.signal);
    const imageUrl = await check(at(properties, "url"));
    if (!imageUrl) continue;
    const sourceUrl = await check(at(item, "url"));
    const thumbnailUrl = await check(at(thumbnail, "src"));
    const title = typeof item.title === "string" ? pySlice(item.title, 300) : "";
    if (key && title.includes(key)) continue;
    output.push({ title, imageUrl, sourceUrl, thumbnailUrl, width: dimension(at(properties, "width"), at(thumbnail, "width")), height: dimension(at(properties, "height"), at(thumbnail, "height")), urlCheck: "https_public_dns_only" });
    if (output.length >= MAX_IMAGE_RESULTS) { truncated = truncated || index + 1 < rows.length; break; }
  }
  truncated = truncated || budget.truncated;
  const dnsSource = result.dnsSource ?? "system";
  return { ok: true, query, sourceType: "image_search_service", untrusted: true, output, truncated, dnsSource,
    provenance: { kind: "image_search_service", urlsVerified: false, urlCheck: "https_public_dns_only", mediaFetched: false, dnsSource },
    notice: "图片及来源地址仅通过 HTTPS 和公网 DNS 检查；Xueness 未获取图片内容。" };
}

/** `tooling.image_search`. */
export async function imageSearch(net: Net, stateDir: string, env: Env, query: unknown, options: { now?: () => number; signal?: AbortSignal } = {}): Promise<Row> {
  if (!imageQueryOk(query)) throw invalidImageQuery();
  const [endpoint, key, doh] = resolveImageSearchConfig(stateDir, env);
  const url = endpoint + "?" + urlencode([["q", query], ["count", 10], ["safesearch", "strict"]]);
  const result = await fetchPage(net, url, { headers: { "X-Subscription-Token": key, Accept: "application/json" }, maxChars: 1_000_000, dohEndpoint: doh, ...(options.signal ? { signal: options.signal } : {}) });
  return imageSearchPayload(net, result, key, query, doh, options);
}
