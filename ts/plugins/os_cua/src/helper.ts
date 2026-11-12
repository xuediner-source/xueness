/**
 * One desktop action through a platform helper process: the request goes in on stdin as JSON, one settled
 * JSON reply comes back on stdout, and the process exits. Shared by the macOS and Windows adapters so
 * cancellation, the reply limit, the deadline and the "input outcome unknown" rule are the same on both.
 */
import type { Context } from "@xueness/kernel";
import type { OsInputAction } from "./platform.ts";
import { MAX_PNG_BASE64 } from "./tools.ts";

const MAX_REPLY = MAX_PNG_BASE64 + 4096;

export type HelperRequest = { command: "windows" } | { command: "screenshot" | "snapshot"; windowId?: string } | { command: "input"; action: OsInputAction };
type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
export interface HelperProcess {
  /** Executable and arguments of the bundled helper. */
  command: string;
  args: readonly string[];
  /** The helper's whole environment; nothing is inherited. */
  env: Record<string, string>;
  /** Platform name used in messages, such as "macOS". */
  label: string;
  timeoutMs: number;
}

let busy = false;
export const helperError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
/** Once an input action may have reached the desktop, any failure means "unknown": never retry blindly. */
const stopError = (request: HelperRequest, code: string, message: string): Error => request.command === "input"
  ? helperError("os_cua_input_unknown", message + " Observe the window again before retrying input.")
  : helperError(code, message);

export async function runHelper<T>(ctx: Context, helper: HelperProcess, request: HelperRequest, enabled: () => boolean, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted || ctx.signal.aborted || !enabled()) throw helperError("cancelled", "OS Computer Use is stopped.");
  if (busy) throw helperError("os_cua_busy", "Another OS Computer Use action is running. Observe the window before retrying.");
  busy = true;
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = ctx.spawn(helper.command, [...helper.args], { env: helper.env, stdio: ["pipe", "pipe", "ignore"], killGraceMs: 100 });
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
      const deadline = setTimeout(() => stop("os_cua_timeout", `The ${helper.label} helper timed out.`), helper.timeoutMs);
      const watch = setInterval(() => { if (!enabled()) cancel(); }, 100);
      deadline.unref();
      watch.unref();
      child.once("spawn", () => { spawned = true; });
      child.on("error", () => {
        stopped ??= spawned
          ? stopError(request, "os_cua_helper_failed", `The ${helper.label} helper stopped unexpectedly.`)
          : helperError("os_cua_unavailable", `Could not start the bundled ${helper.label} helper.`);
      });
      child.stdin?.on("error", () => stop("os_cua_helper_failed", `The ${helper.label} helper did not accept the action.`));
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > MAX_REPLY) stop("os_cua_result_limit", `The ${helper.label} helper exceeded its reply limit.`);
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
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "")) as Reply<T>;
          if (reply.ok === true && reply.value !== undefined) resolve(reply.value);
          else if (reply.ok === false && /^os_cua_[a-z_]+$/.test(reply.code) && typeof reply.message === "string") reject(helperError(reply.code, reply.message));
          else throw new Error("helper reply");
        } catch {
          reject(stopError(request, "os_cua_helper_failed", `The ${helper.label} helper did not return a settled result.`));
        }
      });
      if (signal?.aborted || pluginSignal.aborted || !enabled()) cancel();
      else child.stdin?.end(JSON.stringify(request), "utf8");
    });
  } finally {
    busy = false;
  }
}
