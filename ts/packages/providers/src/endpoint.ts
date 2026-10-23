/**
 * Endpoint validation, ported from the provider constructors.
 *
 * Python validates `XUENESS_API_BASE` with `urllib.parse.urlparse` and
 * `ipaddress`: HTTPS only, or plain HTTP to a loopback IP *literal* after an
 * explicit opt-in. Hostnames such as `localhost` and numeric tricks such as
 * `2130706433` are not literals. The checks here follow those modules'
 * rules so a base URL accepted by one backend is accepted by the other.
 */
import { PyValueError, pyStrip } from "@xueness/contracts";

export const LOOPBACK_HTTP_ENV = "XUENESS_ALLOW_LOOPBACK_HTTP";

export interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  username: string | null;
  password: string | null;
  /** Lower-cased like Python's `hostname`; null when empty. */
  hostname: string | null;
  port: string | null;
}

const C0_OR_SPACE = /^[\x00-\x20]+/;
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** IPv4 dotted decimal under `ipaddress.IPv4Address` rules (no leading zeros). */
export function parseIPv4(text: string): number | null {
  const octets = text.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/.test(octet) || (octet !== "0" && octet.startsWith("0"))) return null;
    const number = Number(octet);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value;
}

/** IPv6 under `ipaddress.IPv6Address` rules, returning the 128-bit value. */
export function parseIPv6(input: string): bigint | null {
  if (input.includes("/")) return null;
  const percent = input.indexOf("%");
  let text = input;
  if (percent >= 0) {
    const scope = input.slice(percent + 1);
    if (!scope || scope.includes("%")) return null;
    text = input.slice(0, percent);
  }
  if (!text || text.length > 45) return null;
  const parts = text.split(":");
  if (parts.length < 3) return null;
  if ((parts.at(-1) as string).includes(".")) {
    const ipv4 = parseIPv4(parts.pop() as string);
    if (ipv4 === null) return null;
    parts.push(((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16));
  }
  if (parts.length > 9) return null;
  let skip: number | null = null;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (!parts[index]) {
      if (skip !== null) return null;
      skip = index;
    }
  }
  let high: number;
  let low: number;
  let skipped: number;
  if (skip !== null) {
    high = skip;
    low = parts.length - skip - 1;
    if (!parts[0] && --high) return null;
    if (!parts.at(-1) && --low) return null;
    skipped = 8 - (high + low);
    if (skipped < 1) return null;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts.at(-1)) return null;
    high = parts.length;
    low = 0;
    skipped = 0;
  }
  let value = 0n;
  const hextet = (part: string): bigint | null => (/^[0-9a-fA-F]{1,4}$/.test(part) ? BigInt(`0x${part}`) : null);
  for (let index = 0; index < high; index += 1) {
    const piece = hextet(parts[index] as string);
    if (piece === null) return null;
    value = (value << 16n) | piece;
  }
  value <<= 16n * BigInt(skipped);
  for (let index = parts.length - low; index < parts.length; index += 1) {
    const piece = hextet(parts[index] as string);
    if (piece === null) return null;
    value = (value << 16n) | piece;
  }
  return value;
}

/** `ipaddress.ip_address(host)` succeeds. */
export function isIpLiteral(hostname: string): boolean {
  return (!hostname.includes("/") && parseIPv4(hostname) !== null) || parseIPv6(hostname) !== null;
}

/** `_is_loopback_literal`: 127/8, ::1 and ::ffff:127/8 literals only. */
export function isLoopbackLiteral(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const ipv4 = hostname.includes("/") ? null : parseIPv4(hostname);
  if (ipv4 !== null) return ipv4 >>> 24 === 127;
  const ipv6 = parseIPv6(hostname);
  if (ipv6 === null) return false;
  if (ipv6 === 1n) return true;
  return ipv6 >> 32n === 0xffffn && Number((ipv6 >> 24n) & 0xffn) === 127;
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(hostname)) throw new PyValueError("IPvFuture address is invalid");
    return;
  }
  if (parseIPv6(hostname) !== null) return;
  if (!hostname.includes("/") && parseIPv4(hostname) !== null) throw new PyValueError("An IPv4 address cannot be in brackets");
  throw new PyValueError(`'${hostname}' does not appear to be an IPv4 or IPv6 address`);
}

function checkNetloc(netloc: string): void {
  if (/[[\]]/.test(netloc) && !(netloc.includes("[") && netloc.includes("]"))) throw new PyValueError("Invalid IPv6 URL");
  if (netloc.includes("[") && netloc.includes("]")) {
    const hostPort = netloc.slice(netloc.lastIndexOf("@") + 1);
    const open = hostPort.indexOf("[");
    if (open >= 0) {
      if (open > 0) throw new PyValueError("Invalid IPv6 URL");
      const rest = hostPort.slice(open + 1);
      const close = rest.indexOf("]");
      const host = close >= 0 ? rest.slice(0, close) : rest;
      const port = close >= 0 ? rest.slice(close + 1) : "";
      if (port && !port.startsWith(":")) throw new PyValueError("Invalid IPv6 URL");
      checkBracketedHost(host);
    } else {
      // Brackets only in the userinfo still validate the host, as Python does.
      checkBracketedHost(hostPort.includes(":") ? hostPort.slice(0, hostPort.indexOf(":")) : hostPort);
    }
  }
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const stripped = netloc.replace(/[@:#?]/g, "");
  const normalized = stripped.normalize("NFKC");
  if (stripped === normalized) return;
  for (const char of "/?#@:") {
    if (normalized.includes(char)) throw new PyValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

/** `urllib.parse.urlsplit` plus the `username` / `password` / `hostname` / `port` properties. */
export function pyUrlSplit(input: string): SplitUrl {
  let url = input.replace(C0_OR_SPACE, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const delimiter of "/?#") {
      const found = url.indexOf(delimiter, 2);
      if (found >= 0) end = Math.min(end, found);
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
  }
  checkNetloc(netloc);
  const hash = url.indexOf("#");
  if (hash >= 0) [url, fragment] = [url.slice(0, hash), url.slice(hash + 1)];
  const question = url.indexOf("?");
  if (question >= 0) [url, query] = [url.slice(0, question), url.slice(question + 1)];
  const at = netloc.lastIndexOf("@");
  let username: string | null = null;
  let password: string | null = null;
  if (at >= 0) {
    const userinfo = netloc.slice(0, at);
    const split = userinfo.indexOf(":");
    username = split >= 0 ? userinfo.slice(0, split) : userinfo;
    password = split >= 0 ? userinfo.slice(split + 1) : null;
  }
  const hostinfo = netloc.slice(at + 1);
  let host: string;
  let port: string;
  const open = hostinfo.indexOf("[");
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf("]");
    host = close >= 0 ? bracketed.slice(0, close) : bracketed;
    const after = close >= 0 ? bracketed.slice(close + 1) : "";
    port = after.includes(":") ? after.slice(after.indexOf(":") + 1) : "";
  } else {
    const split = hostinfo.indexOf(":");
    host = split >= 0 ? hostinfo.slice(0, split) : hostinfo;
    port = split >= 0 ? hostinfo.slice(split + 1) : "";
  }
  let hostname: string | null = null;
  if (host) {
    const zone = host.indexOf("%");
    hostname = zone >= 0 ? host.slice(0, zone).toLowerCase() + host.slice(zone) : host.toLowerCase();
  }
  return { scheme, netloc, path: url, query, fragment, username, password, hostname, port: port || null };
}

/** `_loopback_http_enabled`: an explicit flag wins, else the environment opt-in. */
export function loopbackHttpEnabled(explicit: boolean | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (explicit !== null && explicit !== undefined) return Boolean(explicit);
  return ["1", "true", "yes", "on"].includes(pyStrip(env[LOOPBACK_HTTP_ENV] ?? "").toLowerCase());
}

/** A provider configuration problem (Python's `ValueError` from the constructor). */
export class ProviderConfigError extends PyValueError {}
