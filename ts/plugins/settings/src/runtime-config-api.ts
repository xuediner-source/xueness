/** HTTP view and settings-gated routes for runtime configuration and project trust. */
import { statSync } from "node:fs";
import { resolveStrict } from "./paths.ts";
import { runtimeConfigOverrideMatrix } from "./layers.ts";
import {
  decideWorkspaceConfigTrust, loadRuntimeConfig, mergeRuntimeConfigPatches, normalizeRuntimeConfigPatch,
  readRuntimeConfigUserPatch, saveRuntimeConfigUserPatch,
  type RuntimeConfigDiagnostic, type RuntimeConfigLoadOptions, type RuntimeConfigLoadResult, type RuntimeConfigPatch,
} from "./runtime-config.ts";

export const RUNTIME_CONFIG_ROUTES: readonly string[] = Object.freeze([
  "GET /api/runtime-config", "POST /api/runtime-config", "POST /api/runtime-config/trust",
]);

export interface RuntimeConfigApiOptions extends Omit<RuntimeConfigLoadOptions, "root"> {
  enabled(id: string): boolean;
  resolveRoot(root: string | undefined): string | null | Promise<string | null>;
}

type Reply = [number, unknown];
const SECRET_KEY = /(?:secret|token|password|api[-_]?key|authorization)/iu;
const REDACTED = "[redacted]";

function redact(value: unknown, key = "", mcpEnv = false): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (mcpEnv) {
    if (Array.isArray(value)) return value.map(() => REDACTED);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) output[childKey] = redact(child, childKey);
    return output;
  }
  return value;
}

/** Redact sensitive field values and every MCP server environment value for HTTP. */
function redactPatch(patch: RuntimeConfigPatch): RuntimeConfigPatch {
  const config = redact(patch) as RuntimeConfigPatch;
  const servers = patch.mcp?.servers;
  if (servers && config.mcp?.servers) {
    for (const [name, server] of Object.entries(servers)) {
      if (Object.hasOwn(server, "env") && config.mcp.servers[name]) config.mcp.servers[name]!.env = redact(server.env, "", true);
    }
  }
  return config;
}

export function runtimeConfigHttpView(result: RuntimeConfigLoadResult): Record<string, unknown> {
  const diagnostics: RuntimeConfigDiagnostic[] = result.diagnostics.map(({ source, code }) => ({ source, code }));
  return {
    config: redactPatch(result.config),
    ...(result.workspaceCandidate === undefined ? {} : { workspaceCandidate: redactPatch(result.workspaceCandidate) }),
    sources: [...result.sources], provenance: { ...result.provenance }, diagnostics, workspace: { ...result.workspace },
    matrix: runtimeConfigOverrideMatrix(result),
  };
}

function queryRoot(query: unknown): { valid: boolean; root?: string } {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return { valid: true };
  const value = (query as Record<string, unknown>).root;
  if (value === undefined) return { valid: true };
  if (typeof value === "string") return { valid: true, root: value || undefined };
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return { valid: true, root: value[0] };
  return { valid: false };
}

async function authorizedRoot(options: RuntimeConfigApiOptions, requested?: string): Promise<{ ok: boolean; root: string | undefined }> {
  try {
    const allowed = await options.resolveRoot(requested);
    if (allowed === null) return { ok: requested === undefined, root: undefined };
    const canonical = resolveStrict(allowed);
    if (!statSync(canonical).isDirectory()) return { ok: false, root: undefined };
    if (requested !== undefined && resolveStrict(requested) !== canonical) return { ok: false, root: undefined };
    return { ok: true, root: canonical };
  } catch { return { ok: false, root: undefined }; }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function enabled(options: RuntimeConfigApiOptions): boolean {
  try { return options.enabled("settings"); } catch { return false; }
}

export function createRuntimeConfigApi(options: RuntimeConfigApiOptions) {
  const ownsPath = (_method: string, parts: readonly string[]): boolean =>
    parts[0] === "api" && parts[1] === "runtime-config" && (parts.length === 2 || parts.length === 3 && parts[2] === "trust");
  const owns = (method: string, parts: readonly string[]): boolean => ownsPath(method, parts);

  return {
    routes: RUNTIME_CONFIG_ROUTES,
    owns,
    lossless: owns,
    async dispatch(method: string, parts: readonly string[], query: unknown, data: unknown): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!enabled(options)) return [403, { error: "plugin disabled: settings", plugin: "settings" }];
      const trustRoute = parts.length === 3;
      if (trustRoute && method !== "POST" || !trustRoute && method !== "GET" && method !== "POST") return [405, { error: "method not allowed" }];

      if (method === "GET") {
        const parsedRoot = queryRoot(query);
        if (!parsedRoot.valid) return [400, { error: "root must be a single string" }];
        const resolved = await authorizedRoot(options, parsedRoot.root);
        if (!resolved.ok) return [403, { error: "workspace root is not authorized" }];
        return [200, runtimeConfigHttpView(loadRuntimeConfig({ ...options, root: resolved.root }))];
      }

      if (trustRoute) {
        if (data === null || typeof data !== "object" || Array.isArray(data) || !exactKeys(data as Record<string, unknown>, ["root", "digest", "decision", "confirmed"])) {
          return [400, { error: "expected root, digest, decision and confirmed" }];
        }
        const body = data as Record<string, unknown>;
        if (typeof body.root !== "string" || !/^[a-f0-9]{64}$/u.test(String(body.digest)) || typeof body.digest !== "string" ||
            body.decision !== "allow" && body.decision !== "revoke" || body.confirmed !== true) {
          return [400, { error: "invalid workspace trust decision" }];
        }
        const resolved = await authorizedRoot(options, body.root);
        if (!resolved.ok || !resolved.root) return [403, { error: "workspace root is not authorized" }];
        try {
          const workspace = decideWorkspaceConfigTrust(options.stateDir, resolved.root, body.digest, body.decision);
          return [200, { workspace }];
        } catch { return [409, { error: "workspace config changed or is unavailable" }]; }
      }

      if (data === null || typeof data !== "object" || Array.isArray(data) || !exactKeys(data as Record<string, unknown>, ["config"])) {
        return [400, { error: "expected config" }];
      }
      const patch = normalizeRuntimeConfigPatch((data as Record<string, unknown>).config);
      if (!patch) return [400, { error: "invalid runtime config shape" }];
      let stored = readRuntimeConfigUserPatch(options.stateDir);
      if (!stored.valid) return [409, { error: "stored runtime config is invalid" }];
      const nextPatch = mergeRuntimeConfigPatches(stored.patch ?? {}, patch);
      try { options.validate?.(nextPatch); } catch { return [400, { error: "runtime config validation failed" }]; }
      try { saveRuntimeConfigUserPatch(options.stateDir, nextPatch); }
      catch { return [500, { error: "cannot save runtime config" }]; }
      const currentRoot = await authorizedRoot(options);
      return [200, runtimeConfigHttpView(loadRuntimeConfig({ ...options, root: currentRoot.root }))];
    },
  };
}
