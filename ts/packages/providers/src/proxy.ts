/**
 * Environment proxies for remote HTTPS endpoints, after `urllib.request`.
 *
 * Python's default opener honours `<scheme>_proxy` variables (lower-case
 * wins) and `no_proxy`; literal loopback endpoints never use a proxy. An
 * HTTPS request through an HTTP proxy is a `CONNECT` tunnel; credentials in
 * the proxy URL become `Proxy-Authorization: Basic ...` on the tunnel only.
 * Windows registry and macOS system proxy settings are not read here.
 */
import { pyStrip } from "@xueness/contracts";

/** `urllib.parse.unquote`: lenient percent-decoding, invalid UTF-8 replaced. */
export function pyUnquote(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replaceAll("%", ""), "hex");
    return new TextDecoder("utf-8").decode(bytes);
  });
}

/** `getproxies_environment()`. */
export function environmentProxies(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const proxies = new Map<string, string>();
  const entries: [string, string, string][] = [];
  for (const [name, value = ""] of Object.entries(env)) {
    if (name.length > 5 && name[name.length - 6] === "_" && name.slice(-5).toLowerCase() === "proxy") {
      const proxyName = name.slice(0, -6).toLowerCase();
      entries.push([name, value, proxyName]);
      if (value) proxies.set(proxyName, value);
    }
  }
  if (Object.hasOwn(env, "REQUEST_METHOD")) proxies.delete("http");
  for (const [name, value, proxyName] of entries) {
    if (name.endsWith("_proxy")) {
      if (value) proxies.set(proxyName, value);
      else proxies.delete(proxyName);
    }
  }
  return proxies;
}

/** `proxy_bypass_environment(host, proxies)`; `host` may carry a port. */
export function proxyBypass(hostInput: string, proxies: Map<string, string>): boolean {
  const noProxy = proxies.get("no");
  if (noProxy === undefined) return false;
  if (noProxy === "*") return true;
  const host = hostInput.toLowerCase();
  const port = /^(.*):([0-9]*)$/s.exec(host);
  const hostOnly = port && port[2] ? (port[1] as string) : host;
  for (const raw of noProxy.split(",")) {
    let name = pyStrip(raw);
    if (!name) continue;
    name = name.replace(/^\.+/, "").toLowerCase();
    if (hostOnly === name || host === name) return true;
    name = `.${name}`;
    if (hostOnly.endsWith(name) || host.endsWith(name)) return true;
  }
  return false;
}

export interface ProxyTarget {
  host: string;
  port: number;
  authorization: string | null;
}

/** `_parse_proxy` followed by `HTTPSConnection._get_hostport` (default port 443). */
export function parseProxy(proxy: string): ProxyTarget {
  const typed = /^([^/:]+):(.*)$/s.exec(proxy);
  const rest = typed ? (typed[2] as string) : proxy;
  let authority: string;
  if (!rest.startsWith("/")) authority = proxy;
  else {
    if (!rest.startsWith("//")) throw new Error(`proxy URL with no authority: ${proxy}`);
    const at = rest.indexOf("@");
    const end = at >= 0 ? rest.indexOf("/", at) : rest.indexOf("/", 2);
    authority = rest.slice(2, end === -1 ? undefined : end);
  }
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : null;
  const hostPort = pyUnquote(authority.slice(at + 1));
  let authorization: string | null = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(":");
    const user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const password = colon >= 0 ? userinfo.slice(colon + 1) : null;
    if (user && password) {
      const pair = `${pyUnquote(user)}:${pyUnquote(password)}`;
      authorization = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
    }
  }
  let host = hostPort;
  let port = 443;
  const colon = host.lastIndexOf(":");
  if (colon > host.lastIndexOf("]")) {
    const text = host.slice(colon + 1);
    if (text !== "") {
      if (!/^[0-9]+$/.test(text)) throw new Error(`nonnumeric port: '${text}'`);
      port = Number(text);
    }
    host = host.slice(0, colon);
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host, port, authorization };
}

/** The proxy for an HTTPS request to `netloc` (host[:port]), or null. */
export function httpsProxyFor(netloc: string, env: NodeJS.ProcessEnv = process.env): ProxyTarget | null {
  const proxies = environmentProxies(env);
  const proxy = proxies.get("https");
  if (proxy === undefined || (netloc && proxyBypass(netloc, proxies))) return null;
  return parseProxy(proxy);
}
