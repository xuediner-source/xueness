/**
 * The network plugin on TS (Python `bundled_plugins/network`): approval-gated
 * `web_fetch`, `web_search` and `image_search` over the same pinned-address
 * HTTPS transport, reading and writing the same `network/` settings and key
 * files. `createNetworkHttp` serves `/api/network/settings` and
 * `/api/network/diagnostics`.
 */
import { definePlugin, type BundledPlugin, type Context } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { FetchCache } from "./cache.ts";
import { nodeNet, type Net } from "./net.ts";
import { networkTools } from "./tools.ts";
import type { Env } from "./settings.ts";
import type { NetworkActivityCallback } from "./fetch-runtime.ts";

export { NetworkError, SETTINGS_UNAVAILABLE } from "./errors.ts";
export { FetchCache, CACHE_MAX_BYTES, CACHE_TTL_MS } from "./cache.ts";
export { htmlText, unescape } from "./html.ts";
export { idnaEncode, punycode } from "./idna.ts";
export { fakeIpOnly, ipText, isGlobal, parseIp } from "./ip.ts";
export { failureKind, nodeNet, type HttpExchange, type HttpResponse, type Net, type NodeNetOptions } from "./net.ts";
export { checkedPublic, fetchPage, postJson, resolvePublic, systemAddresses, MAX_REDIRECTS } from "./transport.ts";
export { activityOrigin, emitNetworkActivity, fetchCacheKey, networkActivityExtension, normalizeFetchUrl,
  type NetworkActivityCallback, type NetworkActivityEnvironment, type NetworkActivityEvent, type NetworkActivityExtension } from "./fetch-runtime.ts";
export { parseHttpsUrl, queryNames, quotePlus, unquote, urlencode, urlsplit } from "./urls.ts";
export { getSettings, resolveImageSearchConfig, resolveSearchModelConfig, resolveServiceConfig, validEndpoint, getSearchMode } from "./settings.ts";
export { normalize, searchModel, searchService } from "./services.ts";
export { imageQueryOk, imageSearch, imageSearchPayload } from "./images.ts";
export { citationLines, citationsFromRows, extractCitations, fetchCitation, withCitations, MAX_CITATIONS, type SourceCitation } from "./citations.ts";
export { DESCRIPTIONS, modelSchema, networkTools, toolResult } from "./tools.ts";
export { createNetworkHttp, NETWORK_HTTP_ROUTES, type NetworkHttp, type NetworkHttpOptions } from "./http.ts";

export interface NetworkOptions { stateDir: string; net?: Net; env?: Env; now?: () => number; onActivity?: NetworkActivityCallback; searchProviderView?: () => import("@xueness/providers").WebSearchProviderView | null | undefined }

/** Every connection the plugin makes is to port 443 and passes its own `net.connect` grant first. */
function guarded(ctx: Context, net: Net): Net {
  return { lookup: (host) => net.lookup(host), request: (exchange) => { ctx.guard.connect(exchange.host, 443); return net.request(exchange); } };
}

export function createNetwork(options: NetworkOptions): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "network", apply(ctx) {
    const cache = new FetchCache();
    for (const tool of networkTools({ stateDir: options.stateDir, net: guarded(ctx, options.net ?? nodeNet()), cache,
      ...(options.env ? { env: options.env } : {}), ...(options.now ? { now: options.now } : {}), ...(options.onActivity ? { onActivity: options.onActivity } : {}),
      ...(options.searchProviderView ? { searchProviderView: options.searchProviderView } : {}) })) ctx.tool(tool);
    ctx.effect(() => () => cache.clear());
  } }) };
}

export const network = createNetwork({ stateDir: "." });
export const networkPlugin = network.plugin;
