/**
 * Request guards, ported from `xueness/web.py` (`_loopback_host`,
 * `_parse_authority`, `_origin_authority`, `_host_ok`, `_origin_ok`,
 * `_fetch_site_ok`, and the desktop-token and CSRF checks in `_guard`).
 *
 * Header values come from `req.headersDistinct`, so a repeated Host, Origin,
 * Referer or token header is seen and refused exactly as Python refuses it.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { pyStrip } from "@xueness/contracts";
import { isLoopbackAddress, parseNetloc, parsePort, splitSchemeNetloc } from "./py-url.ts";

export type Authority = readonly [hostname: string, port: number];
export type HeaderValues = Record<string, readonly string[] | undefined>;

const ALLOWED_FETCH_SITES = new Set(["none", "same-origin"]);

function hasControl(text: string): boolean {
  return /[\x00-\x1f\x7f]/.test(text);
}

export function loopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.toLowerCase() === "localhost") return true;
  return isLoopbackAddress(hostname);
}

/** A loopback `Host` value as (hostname, port); port 80 when absent. */
export function parseAuthority(raw: string): Authority | null {
  const value = pyStrip(raw ?? "");
  if (!value || /[ /\\?#@\t\r\n%]/.test(value) || hasControl(value)) return null;
  const info = parseNetloc(value);
  if (!info?.hostname || info.hasUserinfo) return null;
  const hostname = info.hostname.toLowerCase();
  if (!loopbackHost(hostname)) return null;
  const hasPort = value.startsWith("[") ? value.slice(value.indexOf("]") + 1).startsWith(":") : value.includes(":");
  if (!hasPort) return [hostname, 80];
  if (info.port === null) return null;
  const port = parsePort(info.port);
  return port !== null && port >= 1 ? [hostname, port] : null;
}

/** A loopback Origin/Referer as (hostname, port), or null when it is not usable. */
export function originAuthority(raw: string): Authority | null {
  if (!raw || hasControl(raw)) return null;
  const { scheme, netloc } = splitSchemeNetloc(pyStrip(raw));
  if (scheme !== "http" && scheme !== "https") return null;
  const info = parseNetloc(netloc);
  if (!info?.hostname || info.hasUserinfo || info.hostname.includes("%")) return null;
  if (!loopbackHost(info.hostname)) return null;
  if (info.port === null) return [info.hostname.toLowerCase(), scheme === "https" ? 443 : 80];
  const port = parsePort(info.port);
  return port !== null && port >= 1 ? [info.hostname.toLowerCase(), port] : null;
}

function values(headers: HeaderValues, name: string): readonly string[] {
  return headers[name.toLowerCase()] ?? [];
}

export function hostOk(headers: HeaderValues): boolean {
  const hosts = values(headers, "host");
  return hosts.length === 1 && parseAuthority(hosts[0] as string) !== null;
}

export function originOk(headers: HeaderValues): boolean {
  const hosts = values(headers, "host");
  if (hosts.length !== 1) return false;
  const expected = parseAuthority(hosts[0] as string);
  if (!expected) return false;
  for (const name of ["origin", "referer"]) {
    const found = values(headers, name);
    if (found.length > 1) return false;
    if (!found.length || !found[0]) continue;
    const actual = originAuthority(found[0]);
    if (!actual || actual[0] !== expected[0] || actual[1] !== expected[1]) return false;
  }
  return true;
}

export function fetchSiteOk(headers: HeaderValues): boolean {
  const found = values(headers, "sec-fetch-site");
  if (!found.length) return true;
  if (found.length !== 1) return false;
  return ALLOWED_FETCH_SITES.has(pyStrip(found[0] as string).toLowerCase());
}

/** Constant-time comparison of one presented header against the secret. */
export function tokenMatches(presented: readonly string[], secret: string): boolean {
  if (presented.length !== 1 || !presented[0]) return false;
  const a = Buffer.from(presented[0], "latin1");
  const b = Buffer.from(secret, "latin1");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GuardFailure {
  status: 403;
  payload: { error: string; code: string };
}

export interface GuardOptions {
  desktopToken?: string | null;
  csrfToken?: string | null;
}

/** The `_guard` checks in Python's order; null when the request may proceed. */
export function checkRequest(headers: HeaderValues | IncomingHttpHeaders, options: GuardOptions = {}): GuardFailure | null {
  const distinct = headers as HeaderValues;
  if (options.desktopToken && !tokenMatches(values(distinct, "x-xueness-desktop-token"), options.desktopToken)) {
    return { status: 403, payload: { error: "desktop host authentication required", code: "desktop_auth_required" } };
  }
  if (!hostOk(distinct) || !originOk(distinct) || !fetchSiteOk(distinct)) {
    return { status: 403, payload: { error: "host not permitted", code: "host_not_permitted" } };
  }
  if (options.csrfToken !== undefined && !tokenMatches(values(distinct, "x-csrf-token"), options.csrfToken ?? "")) {
    return { status: 403, payload: { error: "csrf token required", code: "csrf_required" } };
  }
  return null;
}
