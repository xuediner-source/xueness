/**
 * MCP OAuth authorization-code/PKCE (Python `bundled_plugins/mcp/oauth.py`).
 *
 * Tokens stay in `<state>/mcp-oauth/<id>.json`. Status never returns them.
 * The one-time verifier is consumed before the token POST.
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";
import { mergeOauthConfig, revokeToken, type ResolvedOauth } from "./oauth-discovery.ts";
import type { Row } from "./names.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const locks = new Map<string, Promise<void>>();

function refuse(message: string): never {
  throw new Error(message);
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  if (typeof value === "number") return value !== 0;
  return true;
}

/** `urllib.parse.quote_plus` (UTF-8, no safe characters, space as `+`). */
function quotePlus(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

function urlencode(params: readonly (readonly [string, string])[]): string {
  return params.map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join("&");
}

function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function oauthPath(state: string, sid: string): string {
  if (!ID.test(sid)) refuse("invalid OAuth server id");
  if (isLink(state)) refuse("OAuth state root cannot be a symlink, junction, or reparse point");
  const directory = join(state, "mcp-oauth");
  if (isLink(directory)) refuse("OAuth directory cannot be a symlink, junction, or reparse point");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (isLink(directory)) refuse("OAuth directory cannot be a symlink, junction, or reparse point");
  const path = join(directory, `${sid}.json`);
  if (isLink(path)) refuse("OAuth state cannot be a symlink, junction, or reparse point");
  return path;
}

function writePrivate(path: string, item: Row): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkstemp(parent, ".resource-");
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

function readOauth(state: string, sid: string): Row {
  let raw: Buffer;
  try { raw = readFileSync(oauthPath(state, sid)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  if (raw.length > 32768) refuse("OAuth state too large");
  const row = pyJsonLoads(pyDecodeUtf8(raw));
  if (!isDict(row)) refuse("invalid OAuth state");
  return row;
}

async function locked<T>(state: string, body: () => Promise<T>): Promise<T> {
  const previous = locks.get(state) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(state, tail);
  await previous.catch(() => {});
  try { return await body(); }
  finally { release(); if (locks.get(state) === tail) locks.delete(state); }
}

export function oauthStatus(state: string, sid: string): Row {
  const row = readOauth(state, sid);
  const pendingUntil = typeof row.pending_until === "number" ? row.pending_until : 0;
  return { authorized: pyTruthy(row.access_token), expiresAt: "expires_at" in row ? row.expires_at : null, pending: pendingUntil > Date.now() / 1000 };
}

export async function oauthBegin(state: string, server: Row): Promise<Row> {
  const config = mergeOauthConfig(state, server);
  const sid = server.id;
  if (typeof sid !== "string") refuse("invalid OAuth server id");
  const verifier = tokenUrlsafe(48);
  const nonce = tokenUrlsafe(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await locked(state, async () => { writePrivate(oauthPath(state, sid), { verifier, state: nonce, pending_until: Date.now() / 1000 + 600 }); });
  if (typeof server.url !== "string") refuse("invalid OAuth endpoint");
  const params: (readonly [string, string])[] = [
    ["response_type", "code"], ["client_id", config.clientId], ["redirect_uri", config.redirectUri],
    ["code_challenge", challenge], ["code_challenge_method", "S256"], ["state", nonce], ["resource", server.url],
  ];
  if (config.scope) params.push(["scope", config.scope.slice(0, 2000)]);
  return { authorizationUrl: `${config.authorizationEndpoint}?${urlencode(params)}`, state: nonce, expiresIn: 600 };
}

async function tokenPost(config: ResolvedOauth, params: (readonly [string, string])[]): Promise<Row> {
  try {
    const response = await fetch(config.tokenEndpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: urlencode(params),
    });
    if (!response.ok) refuse("OAuth token exchange failed (details suppressed)");
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 32768) refuse("OAuth response too large");
    const row = pyJsonLoads(pyDecodeUtf8(raw));
    if (!isDict(row)) refuse("invalid OAuth token");
    const token = row.access_token;
    const kind = row.token_type === undefined ? "Bearer" : row.token_type;
    if (typeof token !== "string" || !token || token.length > 16000 || token.includes("\r") || token.includes("\n") || String(kind).toLowerCase() !== "bearer") refuse("invalid OAuth token");
    const duration = row.expires_in === undefined ? 3600 : row.expires_in;
    if (typeof duration !== "number" || duration <= 0 || duration > 365 * 86400) refuse("invalid OAuth expiration");
    const refresh = row.refresh_token;
    if (refresh !== undefined && refresh !== null && (typeof refresh !== "string" || refresh.length > 16000)) refuse("invalid refresh token");
    return { access_token: token, refresh_token: typeof refresh === "string" ? refresh : null, expires_at: Date.now() / 1000 + duration };
  } catch {
    // Python `_post` turns every failure, including its own ValueError, into this one string.
    refuse("OAuth token exchange failed (details suppressed)");
  }
}

export async function oauthFinish(state: string, server: Row, code: unknown, nonce: unknown): Promise<Row> {
  const config = mergeOauthConfig(state, server);
  const sid = server.id;
  const resource = server.url;
  if (typeof sid !== "string" || typeof resource !== "string") refuse("invalid OAuth server id");
  if (typeof code !== "string" || !code || code.length > 4000 || typeof nonce !== "string") refuse("code and state required");
  await locked(state, async () => {
    const row = readOauth(state, sid);
    const pending = typeof row.pending_until === "number" ? row.pending_until : 0;
    const stored = typeof row.state === "string" ? row.state : "";
    const same = stored.length === nonce.length && timingSafeEqual(Buffer.from(stored), Buffer.from(nonce));
    if (pending < Date.now() / 1000 || !same) refuse("OAuth state expired or mismatched");
    const verifier = row.verifier;
    if (typeof verifier !== "string") refuse("OAuth state expired or mismatched");
    writePrivate(oauthPath(state, sid), {});
    const token = await tokenPost(config, [
      ["grant_type", "authorization_code"], ["code", code], ["client_id", config.clientId],
      ["redirect_uri", config.redirectUri], ["code_verifier", verifier], ["resource", resource],
    ]);
    token.revocation_endpoint = config.revocationEndpoint;
    writePrivate(oauthPath(state, sid), token);
  });
  return oauthStatus(state, sid);
}

export async function oauthBearer(state: string, server: Row): Promise<string> {
  const config = mergeOauthConfig(state, server);
  const sid = server.id;
  const resource = server.url;
  if (typeof sid !== "string" || typeof resource !== "string") refuse("OAuth authorization required");
  return locked(state, async () => {
    let row = readOauth(state, sid);
    if (typeof row.access_token !== "string" || !row.access_token) refuse("OAuth authorization required");
    const expires = typeof row.expires_at === "number" ? row.expires_at : 0;
    if (expires <= Date.now() / 1000 + 30) {
      if (typeof row.refresh_token !== "string" || !row.refresh_token) refuse("OAuth authorization expired");
      const token = await tokenPost(config, [
        ["grant_type", "refresh_token"], ["refresh_token", row.refresh_token], ["client_id", config.clientId], ["resource", resource],
      ]);
      token.refresh_token = typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : row.refresh_token;
      token.revocation_endpoint = config.revocationEndpoint;
      writePrivate(oauthPath(state, sid), token);
      row = token;
    }
    return String(row.access_token);
  });
}

/** RFC 7009 best-effort server-side revocation, then the local state is gone either way. */
export async function oauthRevoke(state: string, sid: string, server?: Row): Promise<Row> {
  await locked(state, async () => {
    const row = readOauth(state, sid);
    // Revoking the refresh token is the credential that matters; RFC 7009 lets
    // the server invalidate the derived access tokens with it.
    const token = typeof row.refresh_token === "string" && row.refresh_token ? row.refresh_token
      : typeof row.access_token === "string" && row.access_token ? row.access_token : null;
    const endpoint = typeof row.revocation_endpoint === "string" && row.revocation_endpoint
      ? row.revocation_endpoint
      : server ? mergeOauthConfig(state, { ...server, id: sid }).revocationEndpoint : null;
    if (endpoint && token) await revokeToken(endpoint, [token], clientIdOf(state, server, sid)).catch(() => {});
    writePrivate(oauthPath(state, sid), {});
  });
  return oauthStatus(state, sid);
}

function clientIdOf(state: string, server: Row | undefined, sid: string): string | null {
  if (!server) return null;
  try { return mergeOauthConfig(state, { ...server, id: sid }).clientId; } catch { return null; }
}

/** Python `mcp_http._headers`: a truthy `oauth` object replaces Authorization. */
export async function oauthAuthorization(server: Row): Promise<string | null> {
  if (!pyTruthy(server.oauth)) return null;
  if (typeof server._state_dir !== "string") refuse("OAuth authorization required");
  return `Bearer ${await oauthBearer(server._state_dir, server)}`;
}
