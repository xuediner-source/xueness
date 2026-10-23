import { parseHttpsUrl } from "./urls.ts";

export interface NetworkActivityEvent extends Record<string, unknown> {
  type: "network_request";
  phase: "started" | "redirected" | "completed" | "failed" | "cache_hit";
  requestId: string;
  url?: string;
  redirects?: number;
  bytes?: number;
  errorCode?: string;
}
export type NetworkActivityCallback = (event: NetworkActivityEvent) => void;
export interface NetworkActivityEnvironment { onNetworkActivity?: NetworkActivityCallback }

type ActivityContext = { emit(event: NetworkActivityEvent): void };
export interface NetworkActivityExtension {
  readonly id: "network";
  readonly capabilities: readonly ["network.fetch_runtime"];
  beforeRun(context: ActivityContext): void;
  close(context: ActivityContext): void;
}

/** Update the active tool environment only for the lifetime of a network-enabled run. */
export function networkActivityExtension(env: NetworkActivityEnvironment): NetworkActivityExtension {
  let previous: NetworkActivityCallback | undefined;
  let installed: NetworkActivityCallback | undefined;
  return {
    id: "network",
    capabilities: ["network.fetch_runtime"],
    beforeRun(context) {
      previous = env.onNetworkActivity;
      installed = (event) => context.emit(event);
      env.onNetworkActivity = installed;
    },
    close() {
      if (installed && env.onNetworkActivity === installed) {
        if (previous) env.onNetworkActivity = previous;
        else delete env.onNetworkActivity;
      }
      installed = undefined;
      previous = undefined;
    },
  };
}

export function emitNetworkActivity(callback: NetworkActivityCallback | undefined, event: NetworkActivityEvent): void {
  callback?.(event);
}

function upgradeHttp(url: unknown): unknown {
  return typeof url === "string" && /^http:\/\//i.test(url) ? url.replace(/^http:/i, "https:") : url;
}

export interface NormalizedFetchUrl { url: string; host: string; path: string }
export function normalizeFetchUrl(value: unknown): NormalizedFetchUrl {
  const input = upgradeHttp(value);
  parseHttpsUrl(input, true);
  let parsedUrl: URL;
  try { parsedUrl = new URL(input as string); } catch { throw new TypeError("invalid fetch URL"); }
  const url = parsedUrl.href;
  const checked = parseHttpsUrl(url, true);
  return { url, host: checked.host, path: (parsedUrl.pathname || "/") + parsedUrl.search };
}

/** Cache identity includes canonical URL and DoH configuration, never DNS answers. */
export function fetchCacheKey(url: unknown, dohEndpoint: string): string {
  const normalized = normalizeFetchUrl(url);
  let doh = "";
  if (dohEndpoint) {
    parseHttpsUrl(dohEndpoint, false);
    doh = new URL(dohEndpoint).href;
  }
  return JSON.stringify([normalized.url, doh]);
}

/** Activity URLs expose the validated host only; path and query can contain secrets. */
export function activityOrigin(url: string): string {
  const { host } = parseHttpsUrl(url, true);
  return `https://${host.includes(":") ? `[${host}]` : host}/`;
}
