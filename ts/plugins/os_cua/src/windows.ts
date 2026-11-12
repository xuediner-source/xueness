/**
 * Windows adapter for OS Computer Use.
 *
 * The helper is a script bundled with this plugin and run by Windows PowerShell, which ships with every
 * supported Windows; end users need no compiler or extra runtime. It lists top-level windows, captures the
 * primary screen or one window, reads a window's UI Automation tree (names and roles, never field values),
 * and sends one bounded input action to a window it first brings to the front. Windows needs no permission
 * grant for these, but it does not let a normal process drive a window that runs as administrator or the
 * secure desktop; the helper reports that as a refusal.
 */
import { accessSync, constants } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@xueness/kernel";
import { runHelper, type HelperProcess, type HelperRequest } from "./helper.ts";
import { unwiredAdapter, type OsAdapterPort, type OsSnapshot, type OsWindow, type ScreenCapture } from "./platform.ts";

const SCRIPT = fileURLToPath(new URL("../native/windows-worker.ps1", import.meta.url));

function helperProcess(): HelperProcess | null {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (!root) return null;
  const shell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try { accessSync(shell, constants.X_OK); accessSync(SCRIPT, constants.R_OK); } catch { return null; }
  // Nothing is inherited. PowerShell and the .NET compiler it uses for the helper's interop need these few.
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "ProgramData", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.PATH = [join(root, "System32"), root, join(root, "System32", "WindowsPowerShell", "v1.0")].join(";");
  return {
    command: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], env, label: "Windows",
    // Each call compiles the interop layer first, which takes a second or two.
    timeoutMs: 20_000,
  };
}

export function createWindowsAdapter(ctx: Context, enabled: () => boolean): OsAdapterPort {
  const unavailable = unwiredAdapter(process.platform);
  if (process.platform !== "win32") return unavailable;
  if (Number(release().split(".")[0]) < 10) return { ...unavailable, unavailableReason: "Windows 10 or later is required" };
  const helper = helperProcess();
  if (!helper) return { ...unavailable, unavailableReason: "Windows PowerShell or the packaged Windows helper is missing" };
  const run = <T>(request: HelperRequest, signal?: AbortSignal): Promise<T> => runHelper<T>(ctx, helper, request, enabled, signal);
  return {
    platform: "win32",
    available: true,
    listWindows: (signal) => run<OsWindow[]>({ command: "windows" }, signal),
    captureScreen: (options, signal) => run<ScreenCapture>({ command: "screenshot", ...options }, signal),
    inspectWindow: (windowId, signal) => run<OsSnapshot>({ command: "snapshot", windowId }, signal),
    performInput: (action, signal) => run<{ applied: boolean }>({ command: "input", action }, signal),
  };
}
