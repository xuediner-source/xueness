/**
 * Read a version 1 bundled manifest (`xueness/bundled_plugins/<id>/manifest.json`)
 * as a version 2 document, to port plugins and to list Python-owned plugins
 * next to TypeScript ones. Validate the result with `validateManifest`.
 *
 * Version 1 names three powers; they map to the closest version 2 grants.
 * Version 1 tools are bare names: their Gate kind and flags come from
 * `facts` (the Python tool registry). A tool without facts is assumed to be
 * the most guarded kind (mutating, serial, gate "unknown") and is listed in
 * `assumed`, so nothing silently becomes auto-approved.
 */
import type { SchemaIssue } from "./json-schema.ts";
import type { CapabilityDeclaration, FsRoot } from "./plugin-capabilities.ts";
import { MANIFEST_API_VERSION } from "./plugin-manifest.ts";

export const V1_CAPABILITIES: Readonly<Record<string, CapabilityDeclaration>> = Object.freeze({
  "filesystem-write": { fs: { write: ["workspace"] } },
  command: { exec: ["*"] },
  network: { net: { connect: ["*"] } },
});

export interface ToolFacts {
  gate: string;
  mutating: boolean;
  concurrencySafe?: boolean;
}

export interface UpgradeResult {
  document: Record<string, unknown> | null;
  /** Tools that had no facts and got the guarded defaults. */
  assumed: string[];
  issues: SchemaIssue[];
}

function merge(target: { fs: { write: FsRoot[] }; net: { connect: string[] }; exec: string[] }, extra: CapabilityDeclaration): void {
  target.fs.write.push(...(extra.fs?.write ?? []));
  target.net.connect.push(...(extra.net?.connect ?? []));
  target.exec.push(...(extra.exec ?? []));
}

function declaration(merged: { fs: { write: FsRoot[] }; net: { connect: string[] }; exec: string[] }): CapabilityDeclaration {
  const result: { fs?: { write: FsRoot[] }; net?: { connect: string[] }; exec?: string[] } = {};
  if (merged.fs.write.length) result.fs = { write: [...new Set(merged.fs.write)] };
  if (merged.net.connect.length) result.net = { connect: [...new Set(merged.net.connect)] };
  if (merged.exec.length) result.exec = [...new Set(merged.exec)];
  return result;
}

export function upgradeManifestV1(v1: unknown, facts: Readonly<Record<string, ToolFacts>> = {}): UpgradeResult {
  if (typeof v1 !== "object" || v1 === null || Array.isArray(v1)) {
    return { document: null, assumed: [], issues: [{ path: "", message: "manifest must be a JSON object" }] };
  }
  const source = v1 as Record<string, unknown>;
  const issues: SchemaIssue[] = [];
  if (source.apiVersion !== 1) issues.push({ path: "/apiVersion", message: "must be 1" });
  const merged = { fs: { write: [] as FsRoot[] }, net: { connect: [] as string[] }, exec: [] as string[] };
  const powers = source.capabilities ?? [];
  if (!Array.isArray(powers)) issues.push({ path: "/capabilities", message: "must be an array of names" });
  else powers.forEach((name, index) => {
    const mapped = typeof name === "string" && Object.hasOwn(V1_CAPABILITIES, name) ? V1_CAPABILITIES[name] : undefined;
    if (mapped) merge(merged, mapped);
    else issues.push({ path: `/capabilities/${index}`, message: "is not a version 1 capability" });
  });
  const names = source.tools ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) issues.push({ path: "/tools", message: "must be an array of names" });
  if (issues.length) return { document: null, assumed: [], issues };
  const assumed: string[] = [];
  const tools = (names as string[]).map((name) => {
    const known = Object.hasOwn(facts, name) ? facts[name] : undefined;
    if (!known) assumed.push(name);
    const fact = known ?? { gate: "unknown", mutating: true, concurrencySafe: false };
    return { name, gate: fact.gate, mutating: fact.mutating, concurrencySafe: fact.concurrencySafe ?? false };
  });
  const document: Record<string, unknown> = { ...source, apiVersion: MANIFEST_API_VERSION, capabilities: declaration(merged), tools };
  return { document, assumed, issues };
}
