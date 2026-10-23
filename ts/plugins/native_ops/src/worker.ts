import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Context } from "@xueness/kernel";
import { failure, isInside, resolveWorkspacePath, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import { NATIVE_OPS_MUTATIONS, type NativeOpsRawName, type NativeWorkerResult } from "./types.ts";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 131_072;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const STDERR_BYTES = 16 * 1024;
const MAX_TRACK_BYTES = 32 * 1024 * 1024;
const activeWorkers = new Set<ChildProcess>();

export function activeNativeWorkerCount(): number { return activeWorkers.size; }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function workerAsset(): string {
  const target = process.platform === "win32" && process.arch === "x64" ? "win32-x64/dsh-ops-worker.exe"
    : process.platform === "linux" && process.arch === "x64" ? "linux-x64/dsh-ops-worker"
      : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64/dsh-ops-worker" : null;
  if (!target) throw new Error("unsupported native worker platform");
  return fileURLToPath(new URL(`../assets/runtime/${target}`, import.meta.url));
}

async function workspaceArgument(raw: unknown, cwd: string, rootReal: string): Promise<string> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new TypeError("path must be a non-empty workspace path");
  const lexicalRoot = resolve(cwd);
  const lexical = resolve(cwd, raw);
  if (!isInside(lexicalRoot, lexical)) throw Object.assign(new Error("path is outside the worker workspace"), { code: "path_outside_workspace" });
  const checked = await resolveWorkspacePath(raw, cwd, [cwd]);
  if (!isInside(rootReal, checked.absolute)) throw Object.assign(new Error("path is outside the worker workspace"), { code: "path_outside_workspace" });
  // Keep model-selected linked components in the pathname so the Rust worker's
  // component-by-component no-follow traversal can reject them.
  return resolve(rootReal, relative(lexicalRoot, lexical));
}

async function workerArguments(rawName: NativeOpsRawName, input: Record<string, unknown>, env: ToolEnv): Promise<Record<string, unknown>> {
  const rootReal = await realpath(env.cwd);
  const args: Record<string, unknown> = { ...input };
  if (["glob", "grep", "replace"].includes(rawName) && typeof args.path !== "string") args.path = ".";
  if (typeof args.path === "string") args.path = await workspaceArgument(args.path, env.cwd, rootReal);
  if (typeof args.to === "string") args.to = await workspaceArgument(args.to, env.cwd, rootReal);
  if (Array.isArray(args.files)) {
    args.files = await Promise.all(args.files.map(async (value) => {
      if (!isRecord(value)) return value;
      return { ...value, path: await workspaceArgument(value.path, env.cwd, rootReal) };
    }));
  }
  return args;
}

function outcome(value: NativeWorkerResult): ToolResult<NativeWorkerResult> {
  const output = JSON.stringify(value);
  const nativeError = isRecord(value.error) ? value.error : null;
  const failedItems = Array.isArray(value.items) && value.items.some((item) =>
    isRecord(item) && (item.status === "error" || item.status === "rejected" || isRecord(item.error)));
  if (value.status === "completed" && !nativeError && value.failed !== 0 && value.failed !== undefined) {
    // Some worker operations can include a bounded subset plus per-item errors.
    return { ok: false, output, data: value, error: { code: "NATIVE_PARTIAL_RESULT", message: "Native worker returned failed items." } };
  }
  if (value.status === "completed" && !nativeError && !failedItems) return { ok: true, output, data: value };
  const code = typeof nativeError?.code === "string" ? nativeError.code
    : value.status === "partial" || failedItems ? "NATIVE_PARTIAL_RESULT" : "NATIVE_OPERATION_FAILED";
  const message = typeof nativeError?.message === "string" ? nativeError.message
    : typeof value.nextAction === "string" ? value.nextAction : `Native worker returned status ${String(value.status ?? "unknown")}.`;
  return { ok: false, output, data: value, error: { code, message } };
}

function workerFailure(code: string, message: string, data?: unknown): ToolResult {
  const result: ToolResult = failure(code, message);
  if (data !== undefined) result.data = data;
  return result;
}

function limitedEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return {};
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return { SystemRoot: systemRoot, WINDIR: systemRoot };
}

async function recordOneRead(env: ToolEnv, path: unknown, digest: unknown, size: unknown): Promise<void> {
  if (typeof path !== "string" || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_TRACK_BYTES) return;
  try {
    const target = await resolveWorkspacePath(path, env.cwd, [env.cwd]);
    const info = await stat(target.absolute);
    if (!info.isFile() || info.size !== size) return;
    const bytes = await readFile(target.absolute);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== size || hash !== digest) return;
    env.tracker.restore(target.absolute, { mtimeMs: info.mtimeMs, size, sha256: digest, partial: false });
  } catch { /* An optional observation never changes the worker result. */ }
}

async function recordCompleteReads(rawName: NativeOpsRawName, input: Record<string, unknown>, env: ToolEnv, value: NativeWorkerResult): Promise<void> {
  if (rawName === "inspect_local_file") {
    if ((input.offset === undefined || input.offset === 1) && input.view !== "hex" && value.complete === true) {
      await recordOneRead(env, input.path, value.revision, value.bytes);
    }
    return;
  }
  if (rawName !== "read_files" || !Array.isArray(input.files) || !Array.isArray(value.items)) return;
  for (const [index, original] of input.files.entries()) {
    const item = value.items[index];
    if (!isRecord(original) || !isRecord(item) || item.status !== "completed" || item.complete !== true
      || (original.offset !== undefined && original.offset !== 1)) continue;
    await recordOneRead(env, original.path, item.revision, item.bytes);
  }
}

async function collectWorker(ctx: Context, worker: string, payload: string, env: ToolEnv, mutating: boolean): Promise<ToolResult> {
  if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) return workerFailure("OUTPUT_LIMIT", "Native worker request exceeds 2 MiB.");
  const combinedSignal = env.signal ? AbortSignal.any([ctx.signal, env.signal]) : ctx.signal;
  if (combinedSignal.aborted) return workerFailure("cancelled", "Native worker call was cancelled.");
  let child: ChildProcess;
  try {
    child = ctx.spawn(worker, [], { cwd: env.cwd, env: limitedEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return workerFailure("executor_unavailable", "The fixed native file worker could not be started.");
  }
  activeWorkers.add(child);

  return await new Promise<ToolResult>((resolveResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimited = false;
    let cancelled = false;
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    let releaseCancel: (() => Promise<void>) | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill("SIGTERM"); } catch { /* close event settles the result */ }
      killTimer ??= setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* process already exited */ } }, 1000);
      killTimer.unref?.();
    };
    const onAbort = (): void => { cancelled = true; kill(); };
    try {
      // Scope disposers run in reverse registration order. Register after
      // ctx.spawn so this direct cancellation runs before its generic process
      // disposer, which otherwise can wait for a short worker to finish.
      releaseCancel = ctx.scope.add(() => { if (!settled) onAbort(); });
    } catch {
      onAbort();
    }
    const timeout = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    timeout.unref?.();
    combinedSignal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => { spawnError = true; });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_OUTPUT_BYTES) { outputLimited = true; kill(); return; }
      stdoutBytes += chunk.length;
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_BYTES) return;
      const keep = Buffer.from(chunk).subarray(0, STDERR_BYTES - stderrBytes);
      stderrBytes += keep.length;
      stderr.push(keep);
    });
    child.once("close", (exitCode, exitSignal) => {
      settled = true;
      void releaseCancel?.();
      activeWorkers.delete(child);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      combinedSignal.removeEventListener("abort", onAbort);
      if (cancelled) return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "cancelled",
        mutating ? "Native worker was interrupted; inspect the file before retrying." : "Native worker call was cancelled."));
      if (timedOut) return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "DEADLINE_EXCEEDED",
        mutating ? "Native worker timed out; inspect the file before retrying." : "Native worker exceeded the 30 second time limit."));
      if (outputLimited) return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "OUTPUT_LIMIT",
        mutating ? "Native worker output exceeded its limit; inspect the file before retrying." : "Native worker output exceeded 128 KiB."));
      if (spawnError || exitCode !== 0 || exitSignal) {
        return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "executor_unavailable",
          mutating ? "Native worker did not return a settled result; inspect the file before retrying." : "Native worker did not return a settled result."));
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
      catch { return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "invalid_native_result",
        mutating ? "Native worker returned invalid JSON; inspect the file before retrying." : "Native worker returned invalid JSON.")); }
      if (!isRecord(parsed)) return resolveResult(workerFailure(mutating ? "RESULT_UNKNOWN" : "invalid_native_result", "Native worker returned a non-object result."));
      resolveResult(outcome(parsed as NativeWorkerResult));
    });
    if (combinedSignal.aborted) onAbort();
    if (!cancelled) child.stdin?.end(payload, "utf8");
  });
}

export async function invokeNativeFileTool(
  ctx: Context, rawName: NativeOpsRawName, input: Record<string, unknown>, env: ToolEnv,
): Promise<ToolResult> {
  const mutating = NATIVE_OPS_MUTATIONS.has(rawName);
  try {
    if (!isAbsolute(env.cwd)) return workerFailure("invalid_argument", "The active workspace path must be absolute.");
    const args = await workerArguments(rawName, input, env);
    const request = {
      root: env.cwd,
      scope: env.owner || "session",
      tool: rawName,
      args,
      read_only: !mutating,
      write_roots: [env.cwd],
      deny_credential_names: true,
    };
    if (request.scope.length > 256) return workerFailure("invalid_argument", "The active session scope is too long.");
    const envelope = { version: 1, requestId: randomUUID(), component: "file", budget: { timeoutMs: TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES }, request };
    const result = await collectWorker(ctx, workerAsset(), JSON.stringify(envelope), env, mutating);
    if (result.ok && isRecord(result.data)) await recordCompleteReads(rawName, input, env, result.data as NativeWorkerResult);
    return result;
  } catch (error) {
    const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code) : "executor_unavailable";
    const message = error instanceof Error ? error.message : "Native worker preparation failed.";
    return workerFailure(code, message);
  }
}
