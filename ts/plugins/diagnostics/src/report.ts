/** Redacted diagnostic export (`diagnostics.plugin.report`). Read-only. */
import { readdirSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isLink } from "@xueness/sessions";

const SYSTEM: Record<string, string> = { win32: "Windows", linux: "Linux", darwin: "Darwin" };
const GROUPS = ["sessions", "workflows", "resources", "mcp-oauth"] as const;

export interface CatalogRow { id: string; effective: boolean; version?: string | null }

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..`) && !isAbsolute(rel));
}

function scan(root: string, directory: string, jsonOnly: boolean): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  let seen = 0;
  const walk = (dir: string, recursive: boolean): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (seen >= 10_000) return;
      seen += 1;
      if (jsonOnly && !name.endsWith(".json")) continue;
      const path = join(dir, name);
      if (isLink(path)) continue;
      let info;
      try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) {
        if (recursive) walk(path, true);
        continue;
      }
      if (!info.isFile() || !contained(root, resolve(path))) continue;
      files += 1;
      bytes += info.size;
    }
  };
  if (!isLink(directory)) {
    try { if (statSync(directory).isDirectory()) walk(directory, !jsonOnly); } catch { /* missing group */ }
  }
  return { files, bytes };
}

export async function diagnosticReport(options: {
  stateDir: string;
  store: { list(): unknown };
  catalog?: () => readonly CatalogRow[];
  now?: () => number;
}): Promise<Record<string, unknown>> {
  const root = resolve(options.stateDir);
  const storage: Record<string, { files: number; bytes: number }> = {};
  for (const group of GROUPS) storage[group] = scan(root, group === "sessions" ? root : join(root, group), group === "sessions");
  const listed = await Promise.resolve(options.store.list());
  const sessions: Record<string, number> = {};
  if (Array.isArray(listed)) {
    for (const row of listed) {
      if (row === null || typeof row !== "object") continue;
      const status = (row as { status?: unknown }).status;
      const key = typeof status === "string" ? status : "unknown";
      sessions[key] = (sessions[key] ?? 0) + 1;
    }
  }
  return {
    schema: "xueness.diagnostics.v1",
    createdAt: (options.now ?? (() => Date.now() / 1000))(),
    runtime: { python: process.version, system: SYSTEM[platform()] ?? platform(), machine: arch() },
    plugins: (options.catalog?.() ?? []).map((item) => ({ id: item.id, effective: item.effective, version: item.version ?? null })),
    sessions,
    storage,
    redacted: true,
  };
}
