/** Read-only health report. The CLI stays on Python until the TS CLI round. */
import { closeSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { isLink, mkstemp, writeAll } from "@xueness/sessions";
import type { CatalogRow } from "./report.ts";

const SYSTEM: Record<string, string> = { win32: "Windows", linux: "Linux", darwin: "Darwin" };

export interface DoctorOptions {
  stateDir: string;
  workspace?: string;
  catalog?: () => readonly CatalogRow[];
  ping?: () => Promise<{ ok: boolean; error?: string; models?: number | null }> | { ok: boolean; error?: string; models?: number | null };
  env?: NodeJS.ProcessEnv;
  version?: string;
}

function probe(directory: string): { path: string; exists: boolean; writable: boolean; symlink: boolean; freeBytes: number | null } {
  const path = resolve(directory);
  const result = { path, exists: false, writable: false, symlink: false, freeBytes: null as number | null };
  if (isLink(path)) { result.symlink = true; return result; }
  try { result.exists = statSync(path).isDirectory(); } catch { return result; }
  if (!result.exists) return result;
  try {
    const disk = statfsSync(path);
    result.freeBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch { /* free space is optional */ }
  let temporary: { fd: number; path: string } | null = null;
  try {
    temporary = mkstemp(path, ".xueness-doctor-");
    writeAll(temporary.fd, Buffer.from("ok"));
    closeSync(temporary.fd);
    unlinkSync(temporary.path);
    temporary = null;
    result.writable = true;
  } catch { result.writable = false; }
  finally {
    if (temporary) {
      try { closeSync(temporary.fd); } catch { /* already closed */ }
      try { unlinkSync(temporary.path); } catch { /* already removed */ }
    }
  }
  return result;
}

export async function doctor(options: DoctorOptions): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const catalog = options.catalog?.() ?? [];
  const blocked = catalog.filter((item) => !item.effective).map((item) => ({ id: item.id, enabled: false, blockedBy: [] as string[] }));
  const plugins = { installed: catalog.length, effective: catalog.filter((item) => item.effective).length, blocked, configurationError: null };
  const envConfigured = Boolean(env.XUENESS_API_BASE) && Boolean(env.XUENESS_MODEL);
  const model = {
    profiles: [] as unknown[],
    default: null,
    resolvable: envConfigured,
    error: envConfigured ? null : "no provider configured",
    envConfigured,
    ping: options.ping ? await options.ping() : null,
  };
  const state = probe(options.stateDir);
  const workspace = probe(options.workspace ?? process.cwd());
  const pingOk = model.ping === null || model.ping.ok === true;
  return {
    schema: "xueness.doctor.v1",
    createdAt: Date.now() / 1000,
    version: { xueness: options.version ?? "0.2.1", python: process.version, system: SYSTEM[platform()] ?? platform(), machine: arch() },
    plugins,
    storage: { stateDir: state, workspace },
    model,
    ok: Boolean(state.writable && workspace.writable && model.resolvable && pingOk && !plugins.configurationError),
  };
}
