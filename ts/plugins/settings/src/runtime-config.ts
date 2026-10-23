/** Data-only runtime configuration layers and workspace trust records. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkstemp, replaceFile, writeAll } from "@xueness/sessions";
import { resolveStrict } from "./paths.ts";
import { within } from "./workspaces.ts";

export interface RuntimeConfigPatch {
  plugins?: Record<string, Record<string, unknown>>;
  mcp?: { servers?: Record<string, Record<string, unknown>> };
}

export type RuntimeConfigLayer = "defaults" | "userDefaults" | "state" | "workspace" | "environment" | "overrides";
export type WorkspaceConfigStatus = "absent" | "pending" | "trusted" | "invalid";
export interface RuntimeConfigDiagnostic { source: string; code: string }
export interface RuntimeWorkspaceConfig {
  root: string | null;
  path: string | null;
  digest: string | null;
  status: WorkspaceConfigStatus;
}
export interface RuntimeConfigLoadResult {
  config: RuntimeConfigPatch;
  workspaceCandidate?: RuntimeConfigPatch;
  sources: RuntimeConfigLayer[];
  provenance: Record<string, RuntimeConfigLayer>;
  diagnostics: RuntimeConfigDiagnostic[];
  workspace: RuntimeWorkspaceConfig;
}
export interface RuntimeConfigLoadOptions {
  stateDir: string;
  root?: string;
  defaults?: RuntimeConfigPatch;
  userDefaults?: RuntimeConfigPatch;
  env?: NodeJS.ProcessEnv;
  overrides?: RuntimeConfigPatch;
  validate?: (patch: RuntimeConfigPatch) => void;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PATCH_KEYS = new Set(["plugins", "mcp"]);
const TRUST_FILE = "runtime-config-trust.json";
const USER_FILE = "runtime-config.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (!isRecord(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_KEYS.has(key) && child !== undefined) clean[key] = cleanValue(child);
  }
  return clean;
}

/** Validate only the public patch shape; nested shell/MCP fields are host-owned. */
export function normalizeRuntimeConfigPatch(value: unknown): RuntimeConfigPatch | null {
  if (!isRecord(value)) return null;
  const clean = cleanValue(value) as Record<string, unknown>;
  if (Object.keys(clean).some((key) => !PATCH_KEYS.has(key))) return null;
  if (Object.hasOwn(clean, "plugins")) {
    if (!isRecord(clean.plugins)) return null;
    for (const plugin of Object.values(clean.plugins)) if (!isRecord(plugin)) return null;
  }
  if (Object.hasOwn(clean, "mcp")) {
    if (!isRecord(clean.mcp) || Object.keys(clean.mcp).some((key) => key !== "servers")) return null;
    if (Object.hasOwn(clean.mcp, "servers")) {
      if (!isRecord(clean.mcp.servers)) return null;
      for (const server of Object.values(clean.mcp.servers)) if (!isRecord(server)) return null;
    }
  }
  return clean as RuntimeConfigPatch;
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cleanValue(value) as Record<string, unknown>;
}

function eraseProvenance(provenance: Record<string, RuntimeConfigLayer>, path: string): void {
  for (const key of Object.keys(provenance)) if (key === path || key.startsWith(`${path}/`)) delete provenance[key];
}

function pointerPart(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }

function markLeaves(value: unknown, path: string, source: RuntimeConfigLayer, provenance: Record<string, RuntimeConfigLayer>): void {
  if (isRecord(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) markLeaves(child, `${path}/${pointerPart(key)}`, source, provenance);
  } else provenance[path] = source;
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>, path: string, source: RuntimeConfigLayer,
  provenance: Record<string, RuntimeConfigLayer>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const itemPath = `${path}/${pointerPart(key)}`;
    if (isRecord(value)) {
      if (!isRecord(target[key])) {
        eraseProvenance(provenance, itemPath);
        target[key] = {};
      }
      mergeInto(target[key] as Record<string, unknown>, value, itemPath, source, provenance);
      if (!Object.keys(value).length) provenance[itemPath] = source;
    } else {
      eraseProvenance(provenance, itemPath);
      target[key] = cleanValue(value);
      markLeaves(value, itemPath, source, provenance);
    }
  }
}

/** Deep object merge; arrays and scalar values replace their previous value. */
export function mergeRuntimeConfigPatches(...patches: readonly RuntimeConfigPatch[]): RuntimeConfigPatch {
  const result: Record<string, unknown> = {};
  const provenance: Record<string, RuntimeConfigLayer> = {};
  for (const patch of patches) {
    const safe = normalizeRuntimeConfigPatch(patch);
    if (safe) mergeInto(result, safe as Record<string, unknown>, "", "overrides", provenance);
  }
  return result as RuntimeConfigPatch;
}

export interface RuntimeConfigUserPatchRead { present: boolean; valid: boolean; patch: RuntimeConfigPatch | null }
function regularFileState(path: string): "absent" | "regular" | "invalid" {
  try { return lstatSync(path).isFile() ? "regular" : "invalid"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid"; }
}

function parseStoredPatch(path: string): RuntimeConfigUserPatchRead {
  const kind = regularFileState(path);
  if (kind === "absent") return { present: false, valid: true, patch: null };
  if (kind !== "regular") return { present: true, valid: false, patch: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const patch = normalizeRuntimeConfigPatch(parsed);
    return patch ? { present: true, valid: true, patch } : { present: true, valid: false, patch: null };
  } catch { return { present: true, valid: false, patch: null }; }
}

/** Read the persisted user patch for the settings API's partial update. */
export function readRuntimeConfigUserPatch(stateDir: string): RuntimeConfigUserPatchRead {
  return parseStoredPatch(join(stateDir, USER_FILE));
}

interface TrustDocument { entries: { root: string; digest: string }[] }
function readTrust(stateDir: string): { entries: TrustDocument["entries"]; valid: boolean } {
  const path = join(stateDir, TRUST_FILE), kind = regularFileState(path);
  if (kind === "absent") return { entries: [], valid: true };
  if (kind !== "regular") return { entries: [], valid: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return { entries: [], valid: false };
    const entries = parsed.entries.filter((entry): entry is { root: string; digest: string } =>
      isRecord(entry) && typeof entry.root === "string" && /^[a-f0-9]{64}$/u.test(String(entry.digest)) && typeof entry.digest === "string");
    return { entries, valid: entries.length === parsed.entries.length };
  } catch { return { entries: [], valid: false }; }
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
interface WorkspaceSnapshot {
  workspace: RuntimeWorkspaceConfig;
  patch: RuntimeConfigPatch | null;
  hooks: boolean;
  valid: boolean;
  bytes?: Buffer;
}

function workspaceSnapshot(rootInput: string | undefined): WorkspaceSnapshot {
  if (rootInput === undefined || !rootInput.trim()) {
    return { workspace: { root: null, path: null, digest: null, status: "absent" }, patch: null, hooks: false, valid: true };
  }
  let root: string;
  try {
    root = resolveStrict(rootInput);
    if (!statSync(root).isDirectory()) throw new TypeError("root is not a directory");
  } catch {
    return { workspace: { root: null, path: null, digest: null, status: "invalid" }, patch: null, hooks: false, valid: false };
  }
  const path = join(root, ".xueness", "config.json");
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspace: { root, path, digest: null, status: "absent" }, patch: null, hooks: false, valid: true };
    return { workspace: { root, path, digest: null, status: "invalid" }, patch: null, hooks: false, valid: false };
  }
  let hooks = false;
  try {
    const canonicalFile = resolveStrict(path);
    if (!statSync(canonicalFile).isFile() || !within(canonicalFile, root)) throw new TypeError("invalid workspace config path");
    const bytes = readFileSync(canonicalFile), fileDigest = digest(bytes);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new TypeError("workspace config must be an object");
    hooks = Object.hasOwn(parsed, "hooks");
    const document = { ...parsed };
    delete document.hooks;
    const patch = normalizeRuntimeConfigPatch(document);
    if (!patch) throw new TypeError("workspace config has an invalid shape");
    return { workspace: { root, path: canonicalFile, digest: fileDigest, status: "pending" }, patch, hooks, valid: true, bytes };
  } catch {
    return { workspace: { root, path, digest: null, status: "invalid" }, patch: null, hooks, valid: false };
  }
}

function sourceDiagnostic(diagnostics: RuntimeConfigDiagnostic[], source: string, code: string): void {
  diagnostics.push({ source, code });
}

function parseEnvPatch(raw: string): RuntimeConfigPatch | null {
  try { return normalizeRuntimeConfigPatch(JSON.parse(raw) as unknown); }
  catch { return null; }
}

export function loadRuntimeConfig(options: RuntimeConfigLoadOptions): RuntimeConfigLoadResult {
  const diagnostics: RuntimeConfigDiagnostic[] = [], sources: RuntimeConfigLayer[] = [], provenance: Record<string, RuntimeConfigLayer> = {};
  const config: Record<string, unknown> = {};
  const add = (source: RuntimeConfigLayer, input: unknown): void => {
    const patch = normalizeRuntimeConfigPatch(input);
    if (!patch) { sourceDiagnostic(diagnostics, source, "invalid_shape"); return; }
    try { options.validate?.(patch); } catch { sourceDiagnostic(diagnostics, source, "validation_rejected"); return; }
    mergeInto(config, patch as Record<string, unknown>, "", source, provenance);
    sources.push(source);
  };

  add("defaults", options.defaults ?? {});
  add("userDefaults", options.userDefaults ?? {});

  const stored = readRuntimeConfigUserPatch(options.stateDir);
  if (!stored.valid) sourceDiagnostic(diagnostics, "state", "invalid_file");
  else if (stored.patch) add("state", stored.patch);

  let workspace: WorkspaceSnapshot = workspaceSnapshot(options.root);
  let workspaceCandidate: RuntimeConfigPatch | undefined;
  if (workspace.hooks) sourceDiagnostic(diagnostics, "workspace", "workspace_hooks_separate_trust");
  if (!workspace.valid) sourceDiagnostic(diagnostics, "workspace", "invalid_file");
  else if (workspace.patch) {
    const trust = readTrust(options.stateDir);
    if (!trust.valid) sourceDiagnostic(diagnostics, "workspace", "trust_file_invalid");
    const trusted = workspace.workspace.root !== null && workspace.workspace.digest !== null && trust.entries.some((entry) =>
      entry.root === workspace.workspace.root && entry.digest === workspace.workspace.digest);
    if (trusted) {
      workspace.workspace.status = "trusted";
      add("workspace", workspace.patch);
    } else {
      workspace.workspace.status = "pending";
      workspaceCandidate = workspace.patch;
      sourceDiagnostic(diagnostics, "workspace", "workspace_pending");
    }
  }

  const env = options.env ?? process.env;
  if (env.XUENESS_RUNTIME_CONFIG !== undefined) {
    const patch = parseEnvPatch(env.XUENESS_RUNTIME_CONFIG);
    if (!patch) sourceDiagnostic(diagnostics, "environment", "invalid_json_or_shape");
    else add("environment", patch);
  }
  add("overrides", options.overrides ?? {});
  return { config: config as RuntimeConfigPatch, workspaceCandidate, sources, provenance, diagnostics, workspace: workspace.workspace };
}

function writePrivateAtomic(path: string, value: unknown, beforeRename?: () => void): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const kind = regularFileState(path);
  if (kind === "invalid") throw new TypeError("runtime config target must be a regular file");
  const temp = mkstemp(parent, ".runtime-config-");
  let fd: number | null = temp.fd;
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (regularFileState(path) === "invalid") throw new TypeError("runtime config target must be a regular file");
    beforeRename?.();
    replaceFile(temp.path, path);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
}

/** Store the exact root and current project file digest as an explicit allow record. */
export function decideWorkspaceConfigTrust(stateDir: string, root: string, expectedDigest: string, decision: "allow" | "revoke"): RuntimeConfigLoadResult["workspace"] {
  const current = workspaceSnapshot(root);
  if (!current.valid || current.workspace.root !== root || current.workspace.digest !== expectedDigest || !current.bytes) throw new Error("workspace config changed");
  const path = join(stateDir, TRUST_FILE), currentTrust = readTrust(stateDir);
  const entries = currentTrust.valid ? currentTrust.entries : [];
  const filtered = entries.filter((entry) => !(entry.root === root && entry.digest === expectedDigest));
  if (decision === "allow") filtered.push({ root, digest: expectedDigest });
  writePrivateAtomic(path, { entries: filtered }, () => {
    const latest = workspaceSnapshot(root);
    if (!latest.valid || latest.workspace.root !== root || latest.workspace.digest !== expectedDigest) throw new Error("workspace config changed");
  });
  return { ...current.workspace, status: decision === "allow" ? "trusted" : "pending" };
}

/** Persist the merged state-directory user layer with mode 0600 and atomic rename. */
export function saveRuntimeConfigUserPatch(stateDir: string, patch: RuntimeConfigPatch): void {
  writePrivateAtomic(join(stateDir, USER_FILE), patch);
}
