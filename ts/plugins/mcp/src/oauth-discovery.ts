/**
 * MCP OAuth 2.1 discovery and dynamic registration (F06.04), plus the token
 * lifecycle helpers the oauth module reuses.
 *
 * Standard interactions: RFC 9728 Protected Resource Metadata
 * (`/.well-known/oauth-protected-resource`) points at authorization servers;
 * RFC 8414 AS Metadata carries the authorization/token/revocation endpoints;
 * RFC 7591 dynamic registration issues a public client id when none is
 * configured; RFC 7009 revocation runs best-effort server-side before the
 * local state is cleared, so a revoked server keeps no usable session.
 * Endpoint URLs are https, with plain http allowed only to loopback (the
 * compatibility port for isolated servers). Discovered endpoints and any
 * registered client credentials live in `<state>/mcp-oauth/<id>.discovery.json`
 * (mode 0600, state dir — secrets never touch the project package); tokens
 * themselves still live in `<state>/mcp-oauth/<id>.json` via `oauth.ts`.
 * `mergeOauthConfig` never touches the network: `oauthBegin`/`oauthFinish`/
 * `oauthBearer` resolve from static config plus that cache only, so the
 * Python-parity begin behavior (same refusals, same messages) is preserved.
 */
import { closeSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { isLoopbackLiteral, pyUrlSplit } from "@xueness/providers";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";
import type { Row } from "./names.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DOCUMENT = 131_072;
const DEFAULT_REDIRECT_URI = "http://127.0.0.1/callback";
const CLIENT_NAME = "xueness-mcp";
/** Python `oauth.LOOPBACK`: the exact redirect hosts plain http accepts. */
const LOOPBACK_NAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DiscoverOptions { fetchImpl?: typeof fetch; timeoutMs?: number }
export interface DiscoveredOauth {
  authorizationServers: string[];
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  registrationEndpoint: string | null;
  scopesSupported: string[] | null;
}
export interface ResolvedOauth {
  clientId: string;
  clientSecret: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scope?: string;
  revocationEndpoint: string | null;
  registrationEndpoint: string | null;
  authorizationServers: string[];
}
export interface DiscoverySummary {
  authorizationServers: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  registrationEndpoint: string | null;
  registered: boolean;
  alreadyConfigured: boolean;
}

function refuse(message: string): never {
  throw new Error(message);
}

/** https, or http to a loopback host; no credentials, query or fragment. */
export function validEndpointUrl(url: unknown): string {
  if (typeof url !== "string" || url.length > 4096) refuse("invalid OAuth endpoint");
  const parts = pyUrlSplit(url);
  const loopback = parts.hostname !== null && (isLoopbackLiteral(parts.hostname) || LOOPBACK_NAMES.has(parts.hostname));
  if (!parts.hostname || parts.username || parts.password || parts.query || parts.fragment) refuse("invalid OAuth endpoint");
  if (parts.scheme !== "https" && !(parts.scheme === "http" && loopback)) refuse("invalid OAuth endpoint");
  return url;
}

/** RFC 9728/8414: the well-known path is inserted between host and path. */
export function wellKnownUrl(baseUrl: string, suffix: string): string {
  const parts = pyUrlSplit(validEndpointUrl(baseUrl));
  const path = (parts.path ?? "").replace(/\/+$/, "");
  const wellKnown = path ? `/.well-known/${suffix}${path}` : `/.well-known/${suffix}`;
  const port = parts.port !== null ? `:${parts.port}` : "";
  return `${parts.scheme}://${parts.hostname}${port}${wellKnown}`;
}

/** One metadata attempt; every transport/status/format failure is `null` so the caller can try the next well-known location. */
async function tryFetchJson(url: string, init: RequestInit, options: DiscoverOptions): Promise<Row | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), ...init }).catch(() => null);
  if (response === null || !response.ok) return null;
  const bytes = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
  const raw = Buffer.from(bytes);
  if (raw.length > MAX_DOCUMENT) return null;
  try { const row = pyJsonLoads(pyDecodeUtf8(raw)); return isDict(row) ? row : null; } catch { return null; }
}

/**
 * RFC 8414 inserts the well-known path between host and path; the current MCP
 * authorization spec serves both documents at the server root. Both generations
 * are probed, path-inserted first, deduplicated for path-less origins.
 */
function wellKnownCandidates(baseUrl: string, suffix: string): string[] {
  const parts = pyUrlSplit(validEndpointUrl(baseUrl));
  const path = (parts.path ?? "").replace(/\/+$/, "");
  const port = parts.port !== null ? `:${parts.port}` : "";
  const origin = `${parts.scheme}://${parts.hostname}${port}`;
  return path ? [`${origin}/.well-known/${suffix}${path}`, `${origin}/.well-known/${suffix}`] : [`${origin}/.well-known/${suffix}`];
}

function endpointsFrom(metadata: Row): Pick<DiscoveredOauth, "authorizationEndpoint" | "tokenEndpoint" | "revocationEndpoint" | "registrationEndpoint" | "scopesSupported"> {
  const optional = (value: unknown): string | null => value === undefined || value === null ? null : validEndpointUrl(value);
  const scopes = Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.every((scope) => typeof scope === "string")
    ? metadata.scopes_supported as string[] : null;
  return {
    authorizationEndpoint: validEndpointUrl(metadata.authorization_endpoint),
    tokenEndpoint: validEndpointUrl(metadata.token_endpoint),
    revocationEndpoint: optional(metadata.revocation_endpoint),
    registrationEndpoint: optional(metadata.registration_endpoint),
    scopesSupported: scopes,
  };
}

/**
 * RFC 9728 then RFC 8414. A protected-resource document that parsed but names no
 * authorization servers fails closed; when neither well-known location is
 * usable the server itself is assumed to be its own authorization server (the
 * current MCP spec's compatibility port). The first authorization server whose
 * metadata parses wins; a parsed-but-invalid document refuses immediately.
 */
export async function discoverOauthEndpoints(serverUrl: string, options: DiscoverOptions = {}): Promise<DiscoveredOauth> {
  const resourceUrl = validEndpointUrl(serverUrl);
  const init = { method: "GET", headers: { Accept: "application/json" } } as const;
  let resource: Row | null = null;
  for (const candidate of wellKnownCandidates(resourceUrl, "oauth-protected-resource")) {
    resource = await tryFetchJson(candidate, init, options);
    if (resource !== null) break;
  }
  let issuers: string[];
  if (resource !== null) {
    const servers = resource.authorization_servers;
    if (!Array.isArray(servers) || !servers.length || !servers.every((issuer) => typeof issuer === "string")) refuse("OAuth discovery failed (details suppressed)");
    issuers = servers as string[];
  } else {
    issuers = [resourceUrl];
  }
  for (const issuer of issuers) {
    const base = validEndpointUrl(issuer);
    for (const candidate of wellKnownCandidates(base, "oauth-authorization-server")) {
      const metadata = await tryFetchJson(candidate, init, options);
      if (metadata !== null) return { authorizationServers: issuers, issuer: base, ...endpointsFrom(metadata) };
    }
  }
  refuse("OAuth discovery failed (details suppressed)");
}

/** RFC 7591 dynamic registration for a public (no-secret) client. */
export async function registerOAuthClient(registrationEndpoint: string, redirectUri: string, options: DiscoverOptions = {}): Promise<{ clientId: string; clientSecret: string | null }> {
  const body = pyJsonDumps({
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const row = await tryFetchJson(validEndpointUrl(registrationEndpoint), {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body,
  }, options);
  if (row === null) refuse("OAuth registration failed (details suppressed)");
  const clientId = row.client_id;
  if (typeof clientId !== "string" || !clientId || clientId.length > 500) refuse("OAuth registration failed (details suppressed)");
  const secret = row.client_secret;
  if (secret !== undefined && secret !== null && (typeof secret !== "string" || secret.length > 16000 || secret.includes("\r") || secret.includes("\n"))) refuse("OAuth registration failed (details suppressed)");
  return { clientId, clientSecret: typeof secret === "string" ? secret : null };
}

/** RFC 7009: best-effort; every failure is suppressed so the local clear still happens. */
export async function revokeToken(endpoint: string, tokens: readonly string[], clientId: string | null, options: DiscoverOptions = {}): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const target = validEndpointUrl(endpoint);
  for (const token of tokens) {
    const params = new URLSearchParams({ token });
    if (clientId) params.set("client_id", clientId);
    await doFetch(target, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    }).then((response) => response.body?.cancel().catch(() => {})).catch(() => {});
  }
}

function discoveryPath(state: string, sid: string): string {
  if (!ID.test(sid)) refuse("invalid OAuth server id");
  const directory = join(state, "mcp-oauth");
  if (isLink(state) || isLink(directory)) refuse("OAuth directory cannot be a symlink");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${sid}.discovery.json`);
  if (isLink(path)) refuse("OAuth discovery state cannot be a symlink");
  return path;
}

function writePrivate(path: string, item: Row): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkstemp(parent, ".discovery-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(item, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally { if (exists(temp.path)) unlinkSync(temp.path); }
  try { fsyncDirectory(parent); } catch { /* a failed directory fsync does not roll the replace back */ }
}

/** The cached discovery document for one server; `{}` when never discovered. */
export function readOauthDiscovery(state: string, sid: string): Row {
  let raw: Buffer;
  try { raw = readFileSync(discoveryPath(state, sid)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  if (raw.length > 32768) refuse("OAuth discovery state too large");
  const row = pyJsonLoads(pyDecodeUtf8(raw));
  if (!isDict(row)) refuse("invalid OAuth discovery state");
  return row;
}

const stringOrNone = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const stringList = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : [];

/**
 * The effective configuration with Python's `oauth_config` semantics: static
 * fields win over the discovery cache, validation order and refusal messages
 * match (`client id`, then endpoints, then redirect), and no network or
 * registration happens here.
 */
export function mergeOauthConfig(state: string, server: Row): ResolvedOauth {
  const sid = server.id;
  if (typeof sid !== "string") refuse("invalid OAuth server id");
  const staticConfig = isDict(server.oauth) ? server.oauth : {};
  const cached = readOauthDiscovery(state, sid);
  const clientId = stringOrNone(staticConfig.clientId) ?? stringOrNone(cached.client_id);
  if (clientId === null || clientId.length > 500) refuse("OAuth client configuration required");
  const authorizationEndpoint = validEndpointUrl(stringOrNone(staticConfig.authorizationEndpoint) ?? stringOrNone(cached.authorization_endpoint));
  const tokenEndpoint = validEndpointUrl(stringOrNone(staticConfig.tokenEndpoint) ?? stringOrNone(cached.token_endpoint));
  const redirect = stringOrNone(staticConfig.redirectUri) ?? stringOrNone(cached.redirect_uri);
  if (redirect === null) refuse("invalid OAuth redirect URI");
  const parts = pyUrlSplit(redirect);
  const loopback = parts.hostname !== null && LOOPBACK_NAMES.has(parts.hostname);
  if (!parts.hostname || parts.username || parts.password || parts.fragment || parts.query || !(parts.scheme === "https" || (parts.scheme === "http" && loopback))) refuse("invalid OAuth redirect URI");
  const revocation = stringOrNone(staticConfig.revocationEndpoint) ?? stringOrNone(cached.revocation_endpoint);
  const scope = stringOrNone(staticConfig.scope);
  return {
    clientId,
    clientSecret: stringOrNone(cached.client_secret),
    authorizationEndpoint,
    tokenEndpoint,
    redirectUri: redirect,
    ...(scope ? { scope: scope.slice(0, 2000) } : {}),
    revocationEndpoint: revocation === null ? null : validEndpointUrl(revocation),
    registrationEndpoint: stringOrNone(cached.registration_endpoint),
    authorizationServers: stringList(cached.authorization_servers),
  };
}

/**
 * Run standard discovery for one server and cache the result (plus a dynamic
 * client registration when no client id is statically configured). A complete
 * static configuration short-circuits without any network traffic.
 */
export async function discoverOauth(state: string, server: Row, options: DiscoverOptions = {}): Promise<DiscoverySummary> {
  const sid = server.id;
  if (typeof sid !== "string" || !ID.test(sid)) refuse("invalid OAuth server id");
  const staticConfig = isDict(server.oauth) ? server.oauth : {};
  const cached = readOauthDiscovery(state, sid);
  const alreadyConfigured = !!(stringOrNone(staticConfig.clientId) && stringOrNone(staticConfig.authorizationEndpoint) && stringOrNone(staticConfig.tokenEndpoint));
  const redirect = stringOrNone(staticConfig.redirectUri) ?? stringOrNone(cached.redirect_uri) ?? DEFAULT_REDIRECT_URI;
  let found: DiscoveredOauth | null = null;
  if (!alreadyConfigured && (stringOrNone(cached.authorization_endpoint) === null || stringOrNone(cached.client_id) === null && stringOrNone(cached.registration_endpoint) === null)) {
    if (typeof server.url !== "string" || !server.url) refuse("OAuth discovery failed (details suppressed)");
    found = await discoverOauthEndpoints(server.url, options);
  }
  const authorizationEndpoint = stringOrNone(staticConfig.authorizationEndpoint) ?? stringOrNone(cached.authorization_endpoint) ?? found?.authorizationEndpoint ?? null;
  const tokenEndpoint = stringOrNone(staticConfig.tokenEndpoint) ?? stringOrNone(cached.token_endpoint) ?? found?.tokenEndpoint ?? null;
  if (authorizationEndpoint === null || tokenEndpoint === null) refuse("OAuth discovery failed (details suppressed)");
  const revocationEndpoint = stringOrNone(staticConfig.revocationEndpoint) ?? stringOrNone(cached.revocation_endpoint) ?? found?.revocationEndpoint ?? null;
  const registrationEndpoint = stringOrNone(cached.registration_endpoint) ?? found?.registrationEndpoint ?? null;
  const authorizationServers = stringList(cached.authorization_servers).length ? stringList(cached.authorization_servers) : found?.authorizationServers ?? [];
  let clientId = stringOrNone(staticConfig.clientId) ?? stringOrNone(cached.client_id);
  let clientSecret = stringOrNone(cached.client_secret);
  let registered = false;
  if (!clientId && registrationEndpoint) {
    const issued = await registerOAuthClient(registrationEndpoint, redirect, options);
    clientId = issued.clientId;
    clientSecret = issued.clientSecret;
    registered = true;
  }
  if (found !== null || registered) {
    writePrivate(discoveryPath(state, sid), {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      redirect_uri: redirect,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      ...(revocationEndpoint ? { revocation_endpoint: revocationEndpoint } : {}),
      ...(registrationEndpoint ? { registration_endpoint: registrationEndpoint } : {}),
      authorization_servers: authorizationServers,
    });
  }
  return { authorizationServers, authorizationEndpoint, tokenEndpoint, revocationEndpoint, registrationEndpoint, registered, alreadyConfigured };
}
