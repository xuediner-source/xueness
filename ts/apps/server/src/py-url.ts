/**
 * The parts of Python 3.13's `ipaddress` and `urllib.parse.urlsplit` that the
 * loopback guards depend on, ported rule for rule so the TypeScript front
 * door accepts and refuses exactly the Host/Origin values the Python backend
 * does (differential tests compare both on generated input).
 */

const HEX = /^[0-9A-Fa-f]{1,4}$/;
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** `ipaddress.IPv4Address` parsing: four decimal octets, no leading zeros. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!part || !/^[0-9]+$/.test(part) || part.length > 3) return null;
    if (part !== "0" && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** `ipaddress.IPv6Address` parsing without scope ids: eight 16-bit hextets. */
export function parseIPv6(text: string): number[] | null {
  if (!text || text.includes("%") || text.includes("/")) return null;
  const parts = text.split(":");
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1] as string;
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    parts.pop();
    parts.push(((v4[0] as number) * 256 + (v4[1] as number)).toString(16), ((v4[2] as number) * 256 + (v4[3] as number)).toString(16));
  }
  if (parts.length > 9) return null;
  let skip: number | null = null;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (!parts[index]) {
      if (skip !== null) return null;
      skip = index;
    }
  }
  let hi: number;
  let lo: number;
  if (skip !== null) {
    hi = skip;
    lo = parts.length - skip - 1;
    if (!parts[0]) {
      hi -= 1;
      if (hi) return null;
    }
    if (!parts[parts.length - 1]) {
      lo -= 1;
      if (lo) return null;
    }
    if (8 - (hi + lo) < 1) return null;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return null;
    hi = parts.length;
    lo = 0;
  }
  const hextets: number[] = [];
  for (let index = 0; index < hi; index += 1) {
    const part = parts[index] as string;
    if (!HEX.test(part)) return null;
    hextets.push(parseInt(part, 16));
  }
  for (let index = 0; index < 8 - hi - lo; index += 1) hextets.push(0);
  for (let index = parts.length - lo; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (!HEX.test(part)) return null;
    hextets.push(parseInt(part, 16));
  }
  return hextets;
}

/**
 * `ipaddress.ip_address(text).is_loopback`. IPv4-mapped addresses delegate to
 * the IPv4 rule, as in CPython 3.13 and the maintained 3.9–3.12 patch releases
 * (checked on 3.9.25 and 3.13.14; older patch releases answer False).
 */
export function isLoopbackAddress(text: string): boolean {
  const v4 = parseIPv4(text);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(text);
  if (!v6) return false;
  if (v6.slice(0, 5).every((part) => part === 0) && v6[5] === 0xffff) return (v6[6] as number) >> 8 === 127;
  return v6.slice(0, 7).every((part) => part === 0) && v6[7] === 1;
}

export interface NetlocInfo {
  /** Lowercased host (zone id kept as is), or null when empty. */
  hostname: string | null;
  /** Raw port text, or null when absent or empty. */
  port: string | null;
  hasUserinfo: boolean;
}

/** `_check_bracketed_host`: IPvFuture syntax or an IPv6 (never IPv4) address. */
function bracketedHostOk(host: string): boolean {
  if (host.startsWith("v")) return /^v[a-fA-F0-9]+\..+$/s.test(host);
  const zone = host.indexOf("%");
  if (zone !== -1) {
    const scope = host.slice(zone + 1);
    return !!scope && !scope.includes("%") && parseIPv6(host.slice(0, zone)) !== null;
  }
  return parseIPv6(host) !== null && parseIPv4(host) === null;
}

/** Netloc validation and `_hostinfo`/`_userinfo` splitting; null where Python raises ValueError. */
export function parseNetloc(netloc: string): NetlocInfo | null {
  const open = netloc.includes("[");
  if (open !== netloc.includes("]")) return null;
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const bracket = hostinfo.indexOf("[");
  let host: string;
  let port: string;
  if (bracket !== -1) {
    const inner = hostinfo.slice(bracket + 1);
    const close = inner.indexOf("]");
    host = close === -1 ? inner : inner.slice(0, close);
    const rest = close === -1 ? "" : inner.slice(close + 1);
    if (open && (bracket > 0 || (rest && !rest.startsWith(":")) || !bracketedHostOk(host))) return null;
    const colon = rest.indexOf(":");
    port = colon === -1 ? "" : rest.slice(colon + 1);
  } else {
    const colon = hostinfo.indexOf(":");
    host = colon === -1 ? hostinfo : hostinfo.slice(0, colon);
    port = colon === -1 ? "" : hostinfo.slice(colon + 1);
    if (open && !bracketedHostOk(host)) return null;
  }
  let hostname: string | null = null;
  if (host) {
    const zone = host.indexOf("%");
    hostname = zone === -1 ? host.toLowerCase() : host.slice(0, zone).toLowerCase() + host.slice(zone);
  }
  return { hostname, port: port || null, hasUserinfo: netloc.includes("@") };
}

/** `SplitResult.port`: ASCII digits in 0..65535, otherwise ValueError (null here). */
export function parsePort(port: string): number | null {
  if (!/^[0-9]+$/.test(port)) return null;
  const value = Number(port);
  return value <= 65535 ? value : null;
}

/** `urlsplit(url)` scheme and netloc, after the caller's own stripping. */
export function splitSchemeNetloc(url: string): { scheme: string; netloc: string } {
  let rest = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(rest) && SCHEME_CHARS.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  if (!rest.startsWith("//")) return { scheme, netloc: "" };
  const end = rest.slice(2).search(/[/?#]/);
  return { scheme, netloc: end === -1 ? rest.slice(2) : rest.slice(2, 2 + end) };
}

const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

/**
 * The path and query the Python handler routes on: http.server collapses a
 * leading `//` to `/` (gh-87389), then `urllib.parse.urlparse(self.path)`,
 * whose `;params` on the last segment are not part of the path.
 */
export function requestPath(target: string): { path: string; query: string } {
  let url = target.startsWith("//") ? `/${target.replace(/^\/+/, "")}` : target;
  url = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    const end = url.slice(2).search(/[/?#]/);
    url = end === -1 ? "" : url.slice(2 + end);
  }
  const hash = url.indexOf("#");
  if (hash !== -1) url = url.slice(0, hash);
  let query = "";
  const question = url.indexOf("?");
  if (question !== -1) {
    query = url.slice(question + 1);
    url = url.slice(0, question);
  }
  if (USES_PARAMS.has(scheme) && url.includes(";")) {
    const semicolon = url.includes("/") ? url.indexOf(";", url.lastIndexOf("/")) : url.indexOf(";");
    if (semicolon !== -1) url = url.slice(0, semicolon);
  }
  return { path: url, query };
}
