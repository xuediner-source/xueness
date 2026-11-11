import { accessSync, constants } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@xueness/kernel";
import { unwiredAdapter, type OsAdapterPort, type OsInputAction, type OsSnapshot, type OsWindow, type ScreenCapture } from "./platform.ts";
import { MAX_PNG_BASE64 } from "./tools.ts";

const HELPER = fileURLToPath(new URL("../native/xueness-os-cua", import.meta.url));
const MAX_REPLY = MAX_PNG_BASE64 + 4096;
const TIMEOUT_MS = 12_000;

type Request = { command: "windows" } | { command: "screenshot" | "snapshot"; windowId?: string } | { command: "input"; action: OsInputAction };
type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

let busy = false;
const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const stopError = (request: Request, code: string, message: string): Error => request.command === "input"
  ? error("os_cua_input_unknown", message + " Observe the window again before retrying input.")
  : error(code, message);

async function runHelper<T>(ctx: Context, request: Request, enabled: () => boolean, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted || ctx.signal.aborted || !enabled()) throw error("cancelled", "OS Computer Use is stopped.");
  if (busy) throw error("os_cua_busy", "Another OS Computer Use action is running. Observe the window before retrying.");
  busy = true;
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = ctx.spawn(HELPER, [], { env: {}, stdio: ["pipe", "pipe", "ignore"], killGraceMs: 100 });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stopped: Error | undefined;
      let spawned = false;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (code: string, message: string): void => {
        if (stopped) return;
        stopped = stopError(request, code, message);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 150);
        killTimer.unref();
      };
      const cancel = (): void => stop("cancelled", "OS Computer Use was cancelled.");
      const pluginSignal = ctx.signal;
      signal?.addEventListener("abort", cancel, { once: true });
      pluginSignal.addEventListener("abort", cancel, { once: true });
      const deadline = setTimeout(() => stop("os_cua_timeout", "The macOS helper timed out."), TIMEOUT_MS);
      const watch = setInterval(() => { if (!enabled()) cancel(); }, 100);
      deadline.unref();
      watch.unref();
      child.once("spawn", () => { spawned = true; });
      child.on("error", () => {
        stopped ??= spawned
          ? stopError(request, "os_cua_helper_failed", "The macOS helper stopped unexpectedly.")
          : error("os_cua_unavailable", "Could not start the bundled macOS helper.");
      });
      child.stdin?.on("error", () => stop("os_cua_helper_failed", "The macOS helper did not accept the action."));
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > MAX_REPLY) stop("os_cua_result_limit", "The macOS helper exceeded its reply limit.");
        else chunks.push(chunk);
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        clearInterval(watch);
        signal?.removeEventListener("abort", cancel);
        pluginSignal.removeEventListener("abort", cancel);
        if (stopped) { reject(stopped); return; }
        try {
          if (code !== 0) throw new Error("helper exit");
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Reply<T>;
          if (reply.ok === true && reply.value !== undefined) resolve(reply.value);
          else if (reply.ok === false && /^os_cua_[a-z_]+$/.test(reply.code) && typeof reply.message === "string") reject(error(reply.code, reply.message));
          else throw new Error("helper reply");
        } catch {
          reject(stopError(request, "os_cua_helper_failed", "The macOS helper did not return a settled result."));
        }
      });
      if (signal?.aborted || pluginSignal.aborted || !enabled()) cancel();
      else child.stdin?.end(JSON.stringify(request), "utf8");
    });
  } finally {
    busy = false;
  }
}

export function createMacOsAdapter(ctx: Context, enabled: () => boolean): OsAdapterPort {
  const unavailable = unwiredAdapter(process.platform);
  if (process.platform !== "darwin") return unavailable;
  if (Number(release().split(".")[0]) < 23) return { ...unavailable, unavailableReason: "macOS 14 or later is required" };
  try { accessSync(HELPER, constants.X_OK); }
  catch { return { ...unavailable, unavailableReason: "the packaged macOS helper is missing" }; }
  return {
    platform: "darwin",
    available: true,
    listWindows: (signal) => runHelper<OsWindow[]>(ctx, { command: "windows" }, enabled, signal),
    captureScreen: (options, signal) => runHelper<ScreenCapture>(ctx, { command: "screenshot", ...options }, enabled, signal),
    inspectWindow: (windowId, signal) => runHelper<OsSnapshot>(ctx, { command: "snapshot", windowId }, enabled, signal),
    performInput: (action, signal) => runHelper<{ applied: boolean }>(ctx, { command: "input", action }, enabled, signal),
  };
}
