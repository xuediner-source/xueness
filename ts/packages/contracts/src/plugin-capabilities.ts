/**
 * Capability declarations for plugin manifests (apiVersion 2).
 *
 * A capability is a power that reaches outside the plugin itself. A manifest
 * declares what its plugin needs; the host grants a set of powers; a plugin
 * loads only when every declared power is granted. Deny by default, twice,
 * as `plugin_sdk.py` does for data manifests.
 *
 *   fs.read, fs.write   roots: workspace, state (Xueness data), temp, home, any
 *   net.connect         hosts: "*", "loopback", "example.com", "*.example.com", each with an optional ":port"
 *   net.listen          "loopback" or "any"
 *   exec                program names ("git", "node") or "*" for any program
 *   secrets             secret names ("providers.openai"), "providers.*" or "*"
 *
 * Writing a root implies reading it. `exec: ["*"]` can do whatever a shell
 * can, so a UI should present it as full access.
 */
import type { SchemaIssue } from "./json-schema.ts";

export const FS_ROOTS = ["workspace", "state", "temp", "home", "any"] as const;
export type FsRoot = (typeof FS_ROOTS)[number];
export const LISTEN_SCOPES = ["loopback", "any"] as const;
export type ListenScope = (typeof LISTEN_SCOPES)[number];

export interface CapabilityDeclaration {
  fs?: { read?: readonly FsRoot[]; write?: readonly FsRoot[] };
  net?: { connect?: readonly string[]; listen?: readonly ListenScope[] };
  exec?: readonly string[];
  secrets?: readonly string[];
}

/** Normalised capabilities: every list present, unique and sorted; written roots are also read roots. */
export interface Capabilities {
  fs: { read: FsRoot[]; write: FsRoot[] };
  net: { connect: string[]; listen: ListenScope[] };
  exec: string[];
  secrets: string[];
}

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST_PATTERN = new RegExp(`^(?:\\*|loopback|(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*)(?::([0-9]{1,5}))?$`);
const PROGRAM_PATTERN = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._+-]*)$/;
const SECRET_PATTERN = /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?)$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHost(value: string): boolean {
  const match = HOST_PATTERN.exec(value);
  if (!match) return false;
  const port = match[1] === undefined ? 1 : Number(match[1]);
  return port >= 1 && port <= 65535 && !(match[1] ?? "").startsWith("0");
}

function checkList(value: unknown, path: string, valid: (item: string) => boolean, what: string, issues: SchemaIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !valid(item)) issues.push({ path: `${path}/${index}`, message: `is not a valid ${what}` });
    else if (seen.has(item)) issues.push({ path: `${path}/${index}`, message: `duplicates ${JSON.stringify(item)}` });
    else seen.add(item);
  });
}

function checkGroup(value: unknown, path: string, members: Record<string, [(item: string) => boolean, string]>, issues: SchemaIssue[]): void {
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const member = members[key];
    if (member) checkList(item, `${path}/${key}`, member[0], member[1], issues);
    else issues.push({ path: `${path}/${key}`, message: "is not a known capability" });
  }
}

const isRoot = (item: string): boolean => (FS_ROOTS as readonly string[]).includes(item);
const isListen = (item: string): boolean => (LISTEN_SCOPES as readonly string[]).includes(item);

/** Shape problems of a `capabilities` declaration; empty when it is usable. */
export function capabilityIssues(value: unknown, path = "/capabilities"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObject(value)) return [{ path, message: "must be an object" }];
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}/${key}`;
    if (key === "fs") checkGroup(item, at, { read: [isRoot, "file root"], write: [isRoot, "file root"] }, issues);
    else if (key === "net") checkGroup(item, at, { connect: [validHost, "host pattern"], listen: [isListen, "listen scope"] }, issues);
    else if (key === "exec") checkList(item, at, (name) => PROGRAM_PATTERN.test(name), "program name", issues);
    else if (key === "secrets") checkList(item, at, (name) => SECRET_PATTERN.test(name), "secret pattern", issues);
    else issues.push({ path: at, message: "is not a known capability" });
  }
  return issues;
}

function normalList<T extends string>(items: readonly T[] | undefined, wildcard: T): T[] {
  const unique = [...new Set(items ?? [])].sort();
  return unique.includes(wildcard) ? [wildcard] : unique;
}

/** Normalise a declaration that passed `capabilityIssues`. */
export function normalizeCapabilities(declaration: CapabilityDeclaration = {}): Capabilities {
  const write = normalList(declaration.fs?.write, "any");
  return {
    fs: { read: normalList([...(declaration.fs?.read ?? []), ...write], "any"), write },
    net: { connect: normalList(declaration.net?.connect, "*"), listen: normalList(declaration.net?.listen, "any") },
    exec: normalList(declaration.exec, "*"),
    secrets: normalList(declaration.secrets, "*"),
  };
}

/** Stable one-line tokens (`fs.write:workspace`, `exec:*`); a written root's read is implied. */
export function capabilityTokens(caps: Capabilities): string[] {
  return [
    ...caps.fs.read.filter((root) => !caps.fs.write.includes(root)).map((root) => `fs.read:${root}`),
    ...caps.fs.write.map((root) => `fs.write:${root}`),
    ...caps.net.connect.map((host) => `net.connect:${host}`),
    ...caps.net.listen.map((scope) => `net.listen:${scope}`),
    ...caps.exec.map((name) => `exec:${name}`),
    ...caps.secrets.map((name) => `secrets:${name}`),
  ];
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

function splitHost(pattern: string): { host: string; port: number | null } {
  const at = pattern.lastIndexOf(":");
  return at < 0 ? { host: pattern, port: null } : { host: pattern.slice(0, at), port: Number(pattern.slice(at + 1)) };
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*" || pattern === host) return true;
  if (pattern === "loopback") return isLoopbackHost(host);
  return pattern.startsWith("*.") && host.endsWith(pattern.slice(1));
}

/** Whether a granted host pattern covers a declared one. */
function hostPatternCovers(granted: string, declared: string): boolean {
  const g = splitHost(granted);
  const d = splitHost(declared);
  if (g.port !== null && g.port !== d.port) return false;
  if (d.host === "*") return g.host === "*";
  if (d.host === "loopback") return g.host === "*" || g.host === "loopback";
  return hostMatches(g.host, d.host);
}

function secretMatches(pattern: string, name: string): boolean {
  return pattern === "*" || pattern === name || (pattern.endsWith(".*") && name.startsWith(pattern.slice(0, -1)));
}

/** Whether `granted` covers one token produced by `capabilityTokens`. */
export function covers(granted: Capabilities, token: string): boolean {
  const at = token.indexOf(":");
  const kind = token.slice(0, at);
  const value = token.slice(at + 1);
  switch (kind) {
    case "fs.read": return granted.fs.read.includes("any") || granted.fs.read.includes(value as FsRoot);
    case "fs.write": return granted.fs.write.includes("any") || granted.fs.write.includes(value as FsRoot);
    case "net.connect": return granted.net.connect.some((pattern) => hostPatternCovers(pattern, value));
    case "net.listen": return granted.net.listen.includes("any") || granted.net.listen.includes(value as ListenScope);
    case "exec": return granted.exec.includes("*") || granted.exec.includes(value);
    case "secrets": return granted.secrets.some((pattern) => secretMatches(pattern, value));
    default: return false;
  }
}

/** Declared powers that `granted` does not cover, as tokens; empty means the plugin may load. */
export function missingGrants(declared: Capabilities, granted: Capabilities): string[] {
  return capabilityTokens(declared).filter((token) => !covers(granted, token));
}

/** Runtime check for an outgoing connection. */
export function hostAllowed(caps: Capabilities, host: string, port: number): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  return caps.net.connect.some((pattern) => {
    const { host: name, port: only } = splitHost(pattern);
    return (only === null || only === port) && hostMatches(name, bare);
  });
}

/** Runtime check for a listening socket bound to `host`. */
export function listenAllowed(caps: Capabilities, host: string): boolean {
  return caps.net.listen.includes("any") || (caps.net.listen.includes("loopback") && isLoopbackHost(host));
}

/** Program name used by `exec` patterns: the file's base name without a Windows executable suffix. */
export function programName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
}

export function programAllowed(caps: Capabilities, file: string): boolean {
  const name = programName(file);
  return caps.exec.some((pattern) => pattern === "*" || pattern.toLowerCase() === name);
}

export function secretAllowed(caps: Capabilities, name: string): boolean {
  return caps.secrets.some((pattern) => secretMatches(pattern, name));
}

/** Every power: what the kernel itself runs with. A fresh object each call. */
export function allCapabilities(): Capabilities {
  return normalizeCapabilities({ fs: { write: ["any"] }, net: { connect: ["*"], listen: ["any"] }, exec: ["*"], secrets: ["*"] });
}
