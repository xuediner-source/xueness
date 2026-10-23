/** `runtime.browser_runtime`: the same `bridge.mjs --probe` the worker uses. No page is opened. */
import { spawnSync } from "node:child_process";
import { workerCommand, workerEnvironment } from "./worker.ts";

export interface RuntimeInfo { available: boolean; browser: string | null; reason: string | null }
const BROWSERS = new Set(["Chrome", "Edge", "Chromium"]);
const MISSING: RuntimeInfo = { available: false, browser: null, reason: "runtime_missing" };

export function browserRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeInfo {
  try {
    const [file, args] = workerCommand("--probe", env);
    const result = spawnSync(file, args, { env: workerEnvironment(env), encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.error) return MISSING;
    let value: unknown = {};
    if (typeof result.stdout === "string" && result.stdout.length < 4096) { try { value = JSON.parse(result.stdout); } catch { value = {}; } }
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    const row = value as Record<string, unknown>;
    if (result.status === 0 && row.available === true && typeof row.browser === "string" && BROWSERS.has(row.browser)) return { available: true, browser: row.browser, reason: null };
    if (row.reason === "browser_missing" || row.reason === "driver_missing") return { available: false, browser: null, reason: row.reason };
  } catch { /* timeout or a missing runtime */ }
  return MISSING;
}
