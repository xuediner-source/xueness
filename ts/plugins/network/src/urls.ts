/**
 * `urllib.parse.urlsplit` (CPython 3.11) for the inputs `_parse_https_url`
 * lets through (no whitespace or controls), `urlencode`, and the network
 * plugin's own HTTPS checks with their Python texts.
 */
import { idnaEncode } from "./idna.ts";
import { parseIp } from "./ip.ts";
import { NetworkError } from "./errors.ts";

export class UrlValueError extends Error { override name = "ValueError"; }

export interface SplitUrl { scheme: string; netloc: string; path: string; query: string; fragment: string; hostname: string | null; port: string | null }

function hostinfo(netloc: string): [string, string | null] {
  const info = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = info.indexOf("[");
  let host: string, port: string;
  if (open >= 0) {
    const bracketed = info.slice(open + 1), close = bracketed.indexOf("]");
    host = close < 0 ? bracketed : bracketed.slice(0, close);
    const rest = close < 0 ? "" : bracketed.slice(close + 1), colon = rest.indexOf(":");
    port = colon < 0 ? "" : rest.slice(colon + 1);
  } else { const colon = info.indexOf(":"); host = colon < 0 ? info : info.slice(0, colon); port = colon < 0 ? "" : info.slice(colon + 1); }
  return [host, port || null];
}

function checkBracketedNetloc(netloc: string): void {
  const info = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = info.indexOf("[");
  let host: string;
  if (open >= 0) {
    if (open > 0) throw new UrlValueError("Invalid IPv6 URL");
    const bracketed = info.slice(open + 1), close = bracketed.indexOf("]");
    host = close < 0 ? bracketed : bracketed.slice(0, close);
    const port = close < 0 ? "" : bracketed.slice(close + 1);
    if (port && !port.startsWith(":")) throw new UrlValueError("Invalid IPv6 URL");
  } else { const colon = info.indexOf(":"); host = colon < 0 ? info : info.slice(0, colon); }
  if (host.startsWith("v")) { if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(host)) throw new UrlValueError("IPvFuture address is invalid"); return; }
  const ip = parseIp(host);
  if (!ip) throw new UrlValueError("does not appear to be an IPv4 or IPv6 address");
  if (ip.version === 4) throw new UrlValueError("An IPv4 address cannot be in brackets");
}

function checkNetloc(netloc: string): void {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  if (n !== normalized && [..."/?#@:"].some((c) => normalized.includes(c))) throw new UrlValueError("netloc contains invalid characters under NFKC normalization");
}

/** `urlsplit(url)`. */
export function urlsplit(url: string): SplitUrl {
  url = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "", netloc = "", query = "", fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && /^[A-Za-z0-9+\-.]*$/.test(url.slice(0, colon))) { scheme = url.slice(0, colon).toLowerCase(); url = url.slice(colon + 1); }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const c of "/?#") { const index = url.indexOf(c, 2); if (index >= 0) end = Math.min(end, index); }
    netloc = url.slice(2, end); url = url.slice(end);
    if (netloc.includes("[") !== netloc.includes("]")) throw new UrlValueError("Invalid IPv6 URL");
    if (netloc.includes("[")) checkBracketedNetloc(netloc);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) { fragment = url.slice(hash + 1); url = url.slice(0, hash); }
  const question = url.indexOf("?");
  if (question >= 0) { query = url.slice(question + 1); url = url.slice(0, question); }
  checkNetloc(netloc);
  const [host, port] = hostinfo(netloc);
  let hostname: string | null = null;
  if (host) { const percent = host.indexOf("%"); hostname = percent < 0 ? host.toLowerCase() : host.slice(0, percent).toLowerCase() + host.slice(percent); }
  return { scheme, netloc, path: url, query, fragment, hostname, port };
}

/** `SplitResult.port`. */
export function splitPort(parsed: SplitUrl): number | null {
  if (parsed.port === null) return null;
  if (!/^[0-9]+$/.test(parsed.port)) throw new UrlValueError("Port could not be cast to integer value");
  const port = Number(parsed.port);
  if (port > 65535) throw new UrlValueError("Port out of range 0-65535");
  return port;
}

function password(netloc: string): string {
  const at = netloc.lastIndexOf("@");
  if (at < 0) return "";
  const userinfo = netloc.slice(0, at), colon = userinfo.indexOf(":");
  return colon < 0 ? "" : userinfo.slice(colon + 1);
}

const invalid = (reason: string): NetworkError => new NetworkError("invalid_url", false, reason);

/** `transport._parse_https_url`: the split URL and the IDNA host. */
export function parseHttpsUrl(url: unknown, allowQuery: boolean): { parsed: SplitUrl; host: string } {
  if (typeof url !== "string" || !url || Array.from(url).length > 4096) throw invalid("网址格式无效或超过长度限制，请检查后再试。");
  if (url.includes("\\") || /[\x00-\x20\x7f]/.test(url)) throw invalid("网址不能包含空格、控制字符或反斜杠；请使用标准 HTTPS 网址。");
  let parsed: SplitUrl, port: number | null;
  try { parsed = urlsplit(url); port = splitPort(parsed); } catch (error) {
    if (error instanceof UrlValueError) throw invalid("网址中的主机名或端口无效，请填写标准 HTTPS 网址。");
    throw error;
  }
  if (parsed.scheme !== "https" || !parsed.hostname || parsed.netloc.includes("@") || password(parsed.netloc) || parsed.fragment || url.includes("#")
    || (port !== null && port !== 443) || parsed.netloc.endsWith(":") || (!allowQuery && (parsed.query || url.includes("?") || url.includes("#")))) {
    throw invalid(allowQuery ? "目标必须是 HTTPS 公网网址，不能含账号、密码、片段或非标准端口。" : "服务地址必须是无凭据、无查询参数的 HTTPS 公网网址，端口只能为 443。");
  }
  const host = parsed.hostname;
  if (host.includes("%")) throw invalid("网址不能包含带区域标识的 IP 地址。");
  if (!/^[\x00-\x7f]*$/.test(parsed.path + parsed.query)) throw invalid("网址路径和查询参数必须使用百分号编码的 ASCII 字符。");
  let ascii: string;
  try { ascii = idnaEncode(host); } catch { throw invalid("网址中的主机名无效，请检查域名。"); }
  if (!ascii || ascii.length > 253) throw invalid("网址中的主机名无效，请检查域名。");
  return { parsed, host: ascii };
}

/** `quote_plus(str(value), safe="")`; a lone surrogate raises like Python's UTF-8 encoder. */
export function quotePlus(value: string): string {
  let out = "";
  for (const char of value) {
    if (/^[A-Za-z0-9_.\-~]$/.test(char)) out += char;
    else if (char === " ") out += "+";
    else {
      const code = char.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) throw new UrlValueError("'utf-8' codec can't encode character: surrogates not allowed");
      for (const byte of Buffer.from(char, "utf8")) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** `urlencode(dict)` with str/int values. */
export function urlencode(pairs: readonly (readonly [string, string | number])[]): string {
  return pairs.map(([key, value]) => quotePlus(key) + "=" + quotePlus(String(value))).join("&");
}

/** `urllib.parse.unquote` (UTF-8, errors="replace"). */
export function unquote(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/[\x00-\x7f]+/g, (run) => {
    const bytes: number[] = [];
    for (let index = 0; index < run.length; index += 1) {
      if (run[index] === "%" && /^[0-9A-Fa-f]{2}$/.test(run.slice(index + 1, index + 3))) { bytes.push(parseInt(run.slice(index + 1, index + 3), 16)); index += 2; }
      else bytes.push(run.charCodeAt(index));
    }
    return LENIENT.decode(Uint8Array.from(bytes));
  });
}
const LENIENT = new TextDecoder("utf-8", { ignoreBOM: true });

/** The names `parse_qsl(query, keep_blank_values=True)` yields. */
export function queryNames(query: string): string[] {
  return query ? query.split("&").filter(Boolean).map((part) => unquote(part.split("=", 1)[0]!.replace(/\+/g, " "))) : [];
}
