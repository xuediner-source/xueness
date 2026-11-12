import { accessSync, constants } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@xueness/kernel";
import { runHelper, type HelperProcess, type HelperRequest } from "./helper.ts";
import { unwiredAdapter, type OsAdapterPort, type OsSnapshot, type OsWindow, type ScreenCapture } from "./platform.ts";

const HELPER = fileURLToPath(new URL("../native/xueness-os-cua", import.meta.url));
const PROCESS: HelperProcess = { command: HELPER, args: [], env: {}, label: "macOS", timeoutMs: 12_000 };

export function createMacOsAdapter(ctx: Context, enabled: () => boolean): OsAdapterPort {
  const unavailable = unwiredAdapter(process.platform);
  if (process.platform !== "darwin") return unavailable;
  if (Number(release().split(".")[0]) < 23) return { ...unavailable, unavailableReason: "macOS 14 or later is required" };
  try { accessSync(HELPER, constants.X_OK); }
  catch { return { ...unavailable, unavailableReason: "the packaged macOS helper is missing" }; }
  const run = <T>(request: HelperRequest, signal?: AbortSignal): Promise<T> => runHelper<T>(ctx, PROCESS, request, enabled, signal);
  return {
    platform: "darwin",
    available: true,
    listWindows: (signal) => run<OsWindow[]>({ command: "windows" }, signal),
    captureScreen: (options, signal) => run<ScreenCapture>({ command: "screenshot", ...options }, signal),
    inspectWindow: (windowId, signal) => run<OsSnapshot>({ command: "snapshot", windowId }, signal),
    performInput: (action, signal) => run<{ applied: boolean }>({ command: "input", action }, signal),
  };
}
