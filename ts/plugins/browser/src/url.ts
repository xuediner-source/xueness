/**
 * Python's navigate pre-check, `urllib.parse.urlsplit` semantics (CPython 3.11):
 * scheme `https`, a hostname, no user or password, at most 4096 characters.
 * The worker checks the URL again (WHATWG parsing plus public-address DNS);
 * this is the same early refusal Python makes before the worker sees anything.
 */
import { pyLen } from "@xueness/contracts";

const C0_OR_SPACE = /^[\x00-\x20]+/;
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;

function ipv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/** `ipaddress.IPv6Address(...)` accepts the text (`_split_scope_id`, `_ip_int_from_string`). */
function ipv6(text: string): boolean {
  const percent = text.indexOf("%");
  let address = text;
  if (percent >= 0) { const scope = text.slice(percent + 1); if (!scope || scope.includes("%")) return false; address = text.slice(0, percent); }
  const parts = address.split(":");
  if (parts.length < 3) return false;
  if (parts[parts.length - 1]!.includes(".")) { if (!ipv4(parts.pop()!)) return false; parts.push("0", "0"); }
  if (parts.length > 9) return false;
  let skip = -1;
  for (let index = 1; index < parts.length - 1; index += 1) if (!parts[index]) { if (skip >= 0) return false; skip = index; }
  let hi: number, lo: number;
  if (skip >= 0) {
    hi = skip; lo = parts.length - skip - 1;
    if (!parts[0]) { hi -= 1; if (hi) return false; }
    if (!parts[parts.length - 1]) { lo -= 1; if (lo) return false; }
    if (8 - (hi + lo) < 1) return false;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
    hi = parts.length; lo = 0;
  }
  return [...parts.slice(0, hi), ...(lo ? parts.slice(-lo) : [])].every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group));
}

/** `_check_bracketed_netloc`. */
function bracketedOk(netloc: string): boolean {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostAndPort.indexOf("[");
  if (open < 0) return true;
  if (open > 0) return false;
  const bracketed = hostAndPort.slice(open + 1), close = bracketed.indexOf("]");
  const host = close < 0 ? bracketed : bracketed.slice(0, close), port = close < 0 ? "" : bracketed.slice(close + 1);
  if (port && !port.startsWith(":")) return false;
  // `\Av[a-fA-F0-9]+\..+\z`: `.` stops at a newline.
  if (host.startsWith("v")) return /^v[a-fA-F0-9]+\.[^\n]+$/.test(host);
  return !!host && !ipv4(host) && ipv6(host);
}

/** `_checknetloc`: NFKC must not introduce URL delimiters. */
function netlocOk(netloc: string): boolean {
  if (/^[\x00-\x7f]*$/.test(netloc)) return true;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  return n === normalized || ![..."/?#@:"].some((c) => normalized.includes(c));
}

/** True when Python's `_call` would let this navigate URL through to the worker. */
export function publicHttpsShape(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url = value.replace(C0_OR_SPACE, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url[0]!) && SCHEME_CHARS.test(url.slice(0, colon))) { scheme = url.slice(0, colon).toLowerCase(); url = url.slice(colon + 1); }
  let netloc = "";
  if (url.startsWith("//")) {
    let end = url.length;
    for (const c of "/?#") { const at = url.indexOf(c, 2); if (at >= 0) end = Math.min(end, at); }
    netloc = url.slice(2, end);
    if (netloc.includes("[") !== netloc.includes("]")) return false;
    if (netloc.includes("[") && !bracketedOk(netloc)) return false;
  }
  if (!netlocOk(netloc)) return false;
  const at = netloc.lastIndexOf("@");
  const userinfo = at >= 0 ? netloc.slice(0, at) : null, hostinfo = netloc.slice(at + 1);
  let user = "", password = "";
  if (userinfo !== null) { const split = userinfo.indexOf(":"); user = split >= 0 ? userinfo.slice(0, split) : userinfo; password = split >= 0 ? userinfo.slice(split + 1) : ""; }
  const open = hostinfo.indexOf("[");
  let host: string;
  if (open >= 0) { const bracketed = hostinfo.slice(open + 1), close = bracketed.indexOf("]"); host = close < 0 ? bracketed : bracketed.slice(0, close); }
  else { const split = hostinfo.indexOf(":"); host = split >= 0 ? hostinfo.slice(0, split) : hostinfo; }
  return scheme === "https" && !!host && !user && !password && pyLen(value) <= 4096;
}
