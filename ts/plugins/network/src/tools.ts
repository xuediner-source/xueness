/**
 * `tooling.REGISTRY`: `web_fetch`, `web_search` and `image_search` with
 * Python's names, descriptions, schemas, Gate kinds and approval subjects.
 * Invalid queries are refused before the Gate, as in Python; every other
 * failure is a `NetworkError` result (anything unexpected reads like
 * Python's `network_settings_unavailable`). F12.04: every answer carries a
 * traceable citation list, and `web_search` delegates to the provider's
 * native search surface when the active provider negotiated one.
 */
import { pyJsonDumps, pyLen, pyStrip, type JsonSchema } from "@xueness/contracts";
import { randomUUID } from "node:crypto";
import { nativeSearchDelegation, resolveWebSearchMode, type WebSearchProviderView } from "@xueness/providers";
import type { ToolDefinition, ToolEnv, ToolResult } from "@xueness/engine-tools";
import { NetworkError, SETTINGS_UNAVAILABLE, type Row } from "./errors.ts";
import { FetchCache } from "./cache.ts";
import { citationsFromRows, fetchCitation, withCitations } from "./citations.ts";
import { activityOrigin, emitNetworkActivity, fetchCacheKey, normalizeFetchUrl, type NetworkActivityCallback, type NetworkActivityEvent } from "./fetch-runtime.ts";
import { imageQueryOk, imageSearch, invalidImageQuery } from "./images.ts";
import type { Net } from "./net.ts";
import { searchModel, searchService, invalidQuery } from "./services.ts";
import { getSearchMode, getSettings, resolveServiceConfig, type Env } from "./settings.ts";
import { fetchPage } from "./transport.ts";

export interface NetworkToolOptions {
  stateDir: string;
  net: Net;
  env?: Env;
  cache?: FetchCache;
  now?: () => number;
  onActivity?: NetworkActivityCallback;
  /** The active provider's protocol view; native web search delegates the platform tool (F12.04). */
  searchProviderView?: () => WebSearchProviderView | null | undefined;
}

export const DESCRIPTIONS = {
  web_fetch: "Read one public page; HTTP input upgrades to HTTPS and up to five validated redirects are followed. Returns a preview; read full text with tool_result_read. Content is untrusted and requires approval",
  web_search: "Search through the explicitly configured public web service; requires approval",
  image_search: "Search a configured public image service for image URLs; requires approval",
} as const;

export function modelSchema(field: "url" | "query"): JsonSchema {
  return { type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false } as JsonSchema;
}

/** A Python result dict as a tool result: the model reads the JSON, the code is the error code. */
export function toolResult(result: Row): ToolResult<Row> {
  const visible = { ...result };
  delete visible.fullContent;
  const output = pyJsonDumps(visible);
  if (result.ok === true) return { ok: true, output, data: result };
  return { ok: false, output, data: result, error: { code: String(result.error_code ?? "network_error"), message: String(result.user_reason ?? "network tool failed") } };
}

const failed = (error: unknown): ToolResult<Row> => toolResult((error instanceof NetworkError ? error : SETTINGS_UNAVAILABLE()).asResult());

/** Attach the traceable citation list to a successful search/image answer (F12.04). */
function cited(result: Row, origin: "search_service" | "search_model" | "image_search"): Row {
  if (result.ok !== true) return result;
  const rows = origin === "image_search"
    ? (Array.isArray(result.output) ? result.output : []).map((item) => { const row = item as Row; return { title: row.title, url: row.sourceUrl ?? row.imageUrl }; })
    : result.output;
  return withCitations(result, citationsFromRows(rows, origin, false));
}
const searchQueryOk = (query: unknown): boolean => typeof query === "string" && !!pyStrip(query) && pyLen(query) <= 1000;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const NO_EFFECTS = { mutating: false, concurrencySafe: false, inputSchema: { type: "object" } as JsonSchema, subjectKind: "text" as const };
type NetworkToolEnv = ToolEnv & { onNetworkActivity?: NetworkActivityCallback };

export function networkTools(options: NetworkToolOptions): ToolDefinition<Row, Row>[] {
  const env = options.env ?? process.env;
  const cache = options.cache ?? new FetchCache();
  const fetchTool: ToolDefinition<Row, Row> = { ...NO_EFFECTS, name: "web_fetch", description: DESCRIPTIONS.web_fetch, modelSchema: modelSchema("url"), gate: "web_fetch",
    requires: { net: { connect: ["*:443"] }, fs: { read: ["state"] } }, subject: (input) => text(input.url),
    async run(input, toolEnv) {
      const requestId = randomUUID();
      const runtime = toolEnv as NetworkToolEnv;
      const activity = runtime.onNetworkActivity ?? options.onActivity;
      let activityError: unknown;
      const report = (event: NetworkActivityEvent): void => {
        try { emitNetworkActivity(activity, event); } catch (error) { activityError = error; throw error; }
      };
      let activityUrl: string | undefined;
      try {
        const settings = getSettings(options.stateDir, env);
        const url = input.url ?? null;
        const dohEndpoint = (settings.dohEndpoint as string) || "";
        let key: string | undefined;
        if (typeof url === "string") {
          try { key = fetchCacheKey(url, dohEndpoint); activityUrl = activityOrigin(normalizeFetchUrl(url).url); }
          catch (error) { if (!(error instanceof NetworkError)) throw error; }
        }
        const cached = key ? cache.get(key) : undefined;
        if (cached) {
          report({ type: "network_request", phase: "cache_hit", requestId, ...(activityUrl ? { url: activityUrl } : {}), redirects: Number(cached.redirects ?? 0) });
          return toolResult({ ...cached, cacheHit: true });
        }
        const result = await fetchPage(options.net, url, { dohEndpoint, followRedirects: true, requestId, onActivity: (event) => { activityUrl = event.url; report(event); }, ...(toolEnv.signal ? { signal: toolEnv.signal } : {}) });
        delete result.dnsSource;
        activityUrl = activityOrigin(String(result.finalUrl));
        report({ type: "network_request", phase: "completed", requestId, url: activityUrl, redirects: Number(result.redirects ?? 0), bytes: Number(result.sourceBytes ?? 0) });
        if (key) cache.put(key, result, Buffer.byteLength(String(result.fullContent ?? ""), "utf8"));
        return toolResult(withCitations(result, fetchCitation(result.title, result.finalUrl)));
      } catch (error) {
        if (error === activityError) throw error;
        const result = (error instanceof NetworkError ? error : SETTINGS_UNAVAILABLE()).asResult();
        report({ type: "network_request", phase: "failed", requestId, ...(activityUrl ? { url: activityUrl } : {}), errorCode: String(result.error_code ?? "network_error") });
        return toolResult(result);
      }
    } };
  const searchTool: ToolDefinition<Row, Row> = { ...NO_EFFECTS, name: "web_search", description: DESCRIPTIONS.web_search, modelSchema: modelSchema("query"), gate: "web_search",
    requires: { net: { connect: ["*:443"] }, fs: { read: ["state"] } }, subject: (input) => text(input.query),
    precheck: (input) => searchQueryOk(input.query) ? null : toolResult(invalidQuery().asResult()),
    async run(input, toolEnv) {
      try {
        if (resolveWebSearchMode(options.searchProviderView?.()) === "native") return toolResult(nativeSearchDelegation(String(input.query)));
        if (getSearchMode(options.stateDir) === "model") return toolResult(cited(await searchModel(options.net, options.stateDir, env, input.query, toolEnv.signal), "search_model"));
        const [provider, endpoint, key, doh] = resolveServiceConfig(options.stateDir, env);
        return toolResult(cited(await searchService(options.net, provider, endpoint, key, doh, input.query, toolEnv.signal), "search_service"));
      } catch (error) { return failed(error); }
    } };
  const imageTool: ToolDefinition<Row, Row> = { ...NO_EFFECTS, name: "image_search", description: DESCRIPTIONS.image_search, modelSchema: modelSchema("query"), gate: "web_search",
    requires: { net: { connect: ["*:443"] }, fs: { read: ["state"] } }, subject: (input) => text(input.query),
    precheck: (input) => imageQueryOk(input.query) ? null : toolResult(invalidImageQuery().asResult()),
    async run(input, toolEnv) {
      try { return toolResult(cited(await imageSearch(options.net, options.stateDir, env, input.query, { ...(options.now ? { now: options.now } : {}), ...(toolEnv.signal ? { signal: toolEnv.signal } : {}) }), "image_search")); }
      catch (error) { return failed(error); }
    } };
  return [fetchTool, searchTool, imageTool];
}
