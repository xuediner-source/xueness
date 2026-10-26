/**
 * The hook executor (Python `hooks.HookRunner`).
 *
 * - argv only, never a shell; the command runs in the session workspace;
 * - the child sees PATH and HOME (Windows also the fixed public OS
 *   variables), never the server's private environment;
 * - the event payload goes on stdin as JSON;
 * - per-hook timeout clamped by the cap, merged stdout+stderr clipped;
 * - nothing a hook does can throw into the run: every failure is exit -1.
 *
 * Exit 0 passes, 2 blocks (PreToolUse only), anything else is a warning.
 */
import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { isDict, pyJsonDumps, pyStrRepr } from "@xueness/contracts";
import type { Context } from "@xueness/kernel";
import { clip, POST_PIPELINE_EVENTS, select, strip, TOOL_EVENTS, type Row } from "./load.ts";
import { WORKSPACE_HOOK_ORIGIN, type WorkspaceHookOrigin } from "./origin.ts";

export const EXIT_BLOCK = 2;
export const DEFAULT_TIMEOUT_CAP = 30;
export const DEFAULT_OUTPUT_CAP = 2000;
const WINDOWS_ENV_KEYS = new Set(`PATH SYSTEMROOT SYSTEMDRIVE WINDIR TEMP TMP COMSPEC PATHEXT USERPROFILE APPDATA LOCALAPPDATA HOMEDRIVE HOMEPATH USERNAME USERDOMAIN COMPUTERNAME
OS NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE PROGRAMDATA ALLUSERSPROFILE PUBLIC PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 COMMONPROGRAMFILES COMMONPROGRAMFILES(X86)
COMMONPROGRAMW6432 PSMODULEPATH PSMODULEANALYSISCACHEPATH`.split(/\s+/));

export interface HookResult { id: unknown; event: string; exit_code: number; blocked: boolean; timeout: boolean; duration_ms: number; output: string }
export interface Completed { code: number; stdout: Buffer; timedOut: boolean }
/** Runs one argv; throws a NodeJS.ErrnoException when the program cannot start. */
export type Execute = (argv: readonly string[], options: { cwd: string; input: string; timeoutMs: number; signal?: AbortSignal }) => Promise<Completed>;

/** Python `{"PATH": ..., "HOME": ...}` plus `process_runtime.windows_environment` on Windows. */
export function hookEnvironment(source: NodeJS.ProcessEnv = process.env, windows = process.platform === "win32"): Record<string, string> {
  const env: Record<string, string> = { PATH: source.PATH ?? (windows ? source.Path ?? "" : ""), HOME: source.HOME ?? "" };
  if (windows) for (const [key, value] of Object.entries(source)) if (WINDOWS_ENV_KEYS.has(key.toUpperCase()) && !Object.keys(env).some((name) => name.toUpperCase() === key.toUpperCase()) && value !== undefined) env[key] = value;
  return env;
}

const TEXT = new TextDecoder("utf-8", { ignoreBOM: true });
const TEXT_SIG = new TextDecoder("utf-8");
/** `text=True` pipes: UTF-8 with replacement and universal newlines. */
export const decodeText = (raw: Buffer): string => TEXT.decode(raw).replace(/\r\n?/g, "\n");
/** `decode_subprocess_output` (timeout path): BOM-stripped UTF-8, newlines kept. */
export const decodeTimeout = (raw: Buffer): string => !raw.length ? "" : raw[0] === 0xff && raw[1] === 0xfe || raw[0] === 0xfe && raw[1] === 0xff ? new TextDecoder(raw[0] === 0xff ? "utf-16le" : "utf-16be").decode(raw.subarray(2)) : TEXT_SIG.decode(raw);

/** A child process in its own scope: the whole tree ends on timeout. */
export function scopedExecute(ctx: () => Context | null): Execute {
  return async (argv, options) => {
    const parent = ctx();
    if (!parent) throw Object.assign(new Error("hooks plugin is not active"), { code: "EINACTIVE" });
    if (options.signal?.aborted) throw Object.assign(new Error("hook execution cancelled"), { code: "ECANCELED" });
    const scope = parent.fork("hook");
    try {
      const child = scope.spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: hookEnvironment(), stdio: ["pipe", "pipe", "pipe"], killGraceMs: 0 });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stdin?.on("error", () => {});
      const cancel = (): void => { void scope.dispose().catch(() => {}); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      let timer: NodeJS.Timeout | undefined;
      const outcome = await new Promise<{ code: number; timedOut: boolean }>((resolve, reject) => {
        child.once("error", (error) => { if (child.pid === undefined) reject(error); });
        child.once("close", (code, signal) => resolve({ code: code ?? -((signal && osConstants.signals[signal]) || 1), timedOut: false }));
        timer = setTimeout(() => { resolve({ code: -1, timedOut: true }); }, options.timeoutMs);
        child.stdin?.end(options.input, "utf8");
      }).finally(() => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); });
      return { ...outcome, stdout: Buffer.concat(chunks) };
    } finally { await scope.dispose().catch(() => {}); }
  };
}

const typeName = (value: unknown): string => value === null ? "NoneType" : typeof value === "boolean" ? "bool" : typeof value === "number" ? Number.isInteger(value) ? "int" : "float" : Array.isArray(value) ? "list" : isDict(value) ? "dict" : typeof value;
const FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.|inf(?:inity)?|nan)$/i;
/** Python `float(value)`; null where it raises. */
function pyFloat(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const text = strip(value);
  if (!FLOAT.test(text)) return null;
  const lower = text.toLowerCase().replace(/_/g, "");
  if (lower.endsWith("nan")) return Number.NaN;
  if (lower.includes("inf")) return lower.startsWith("-") ? -Infinity : Infinity;
  return Number(lower);
}
const pyTruthy = (value: unknown): boolean => !(value === undefined || value === null || value === false || value === 0 || value === "" || Array.isArray(value) && !value.length || isDict(value) && !Object.keys(value).length);

function spawnFailure(error: unknown, command: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return `FileNotFoundError: [Errno 2] No such file or directory: ${pyStrRepr(command)}`;
  if (code === "EACCES") return `PermissionError: [Errno 13] Permission denied: ${pyStrRepr(command)}`;
  if (code === "ENOTDIR") return `NotADirectoryError: [Errno 20] Not a directory: ${pyStrRepr(command)}`;
  return `OSError: ${typeof code === "string" ? code : error instanceof Error ? error.message : String(error)}`;
}

export interface FireOptions {
  pipeline?: boolean;
  alias?: string | null;
  signal?: AbortSignal;
  shouldRun?: () => boolean;
  admitWorkspaceHook?: (origin: WorkspaceHookOrigin) => boolean;
  /**
   * F07.02: the matcher subjects for this firing. `undefined` keeps the
   * default (the tool name for tool events, none otherwise); an array matches
   * those values (SessionStart matches its `source`); `null` skips the
   * matcher entirely, as upstream does for UserPromptSubmit and Stop.
   */
  subjects?: readonly string[] | null;
}

export class HookRunner {
  readonly hooks: Row[];
  readonly root: string | null;
  readonly enabled: boolean;
  readonly timeoutCap: number;
  readonly outputCap: number;
  readonly #execute: Execute;

  constructor(hooks: readonly unknown[], root: string | null, execute: Execute, options: { enabled?: boolean; timeoutCap?: number; outputCap?: number } = {}) {
    this.hooks = hooks.filter(isDict);
    this.root = root;
    this.enabled = options.enabled ?? true;
    this.timeoutCap = options.timeoutCap ?? DEFAULT_TIMEOUT_CAP;
    this.outputCap = options.outputCap ?? DEFAULT_OUTPUT_CAP;
    this.#execute = execute;
  }

  get active(): boolean { return this.enabled && this.hooks.length > 0; }

  /** Python `_timeout_for`, in seconds. */
  timeoutFor(hook: Row): number {
    let cap = pyFloat(this.timeoutCap) ?? DEFAULT_TIMEOUT_CAP;
    if (!(cap > 0)) cap = DEFAULT_TIMEOUT_CAP;
    let seconds = pyTruthy(hook.timeout) ? pyFloat(hook.timeout) ?? cap : cap;
    if (Number.isNaN(seconds) || seconds <= 0) seconds = cap;
    return Math.min(seconds, cap);
  }

  async run(hook: Row, event: string, payload: Row, signal?: AbortSignal): Promise<HookResult> {
    const result: HookResult = { id: hook.id ?? null, event, exit_code: -1, blocked: false, timeout: false, duration_ms: 0, output: "" };
    const started = performance.now();
    const elapsed = (): number => Math.floor(performance.now() - started);
    const command = hook.command;
    const extra = Array.isArray(hook.args) ? hook.args : [];
    const root = this.root;
    let isDir = false;
    try { isDir = root !== null && statSync(root).isDirectory(); } catch { isDir = false; }
    if (!isDir) { result.output = "invalid working directory; hook not executed"; result.duration_ms = elapsed(); return result; }
    const bad = [command, ...extra].find((part) => typeof part !== "string");
    if (bad !== undefined) { result.output = clip(`TypeError: expected str, bytes or os.PathLike object, not ${typeName(bad)}`, this.outputCap); result.duration_ms = elapsed(); return result; }
    try {
      const completed = await this.#execute([command as string, ...extra as string[]], { cwd: root!, input: pyJsonDumps(payload, { ensureAscii: true }), timeoutMs: this.timeoutFor(hook) * 1000, signal });
      if (completed.timedOut) { result.timeout = true; result.exit_code = -1; result.output = clip(decodeTimeout(completed.stdout), this.outputCap); }
      else { result.exit_code = completed.code; result.output = clip(decodeText(completed.stdout), this.outputCap); }
    } catch (error) {
      result.exit_code = -1;
      result.output = clip(spawnFailure(error, command as string), this.outputCap);
    }
    result.duration_ms = elapsed();
    result.blocked = result.exit_code === EXIT_BLOCK && !result.timeout;
    return result;
  }

  matches(event: string, subjects: readonly string[] = []): Row[] {
    return this.enabled ? select(this.hooks, event, subjects) : [];
  }

  /** Python `fire`: every selected hook, one after another; [] when disabled or unmatched. */
  async fire(event: string, payload: unknown, options: FireOptions = {}): Promise<HookResult[]> {
    let matches: Row[];
    if (options.subjects === null) {
      matches = this.enabled ? this.hooks.filter((hook) => isDict(hook) && hook.event === event) : [];
    } else {
      const subjects: string[] = [];
      if (options.subjects !== undefined) subjects.push(...options.subjects);
      else if (isDict(payload) && TOOL_EVENTS.includes(event)) {
        const name = payload.tool_name || payload.tool;
        subjects.push(typeof name === "string" ? name : "");
        if (options.alias && options.alias !== subjects[0]) subjects.push(options.alias);
      }
      matches = this.matches(event, subjects);
    }
    if (POST_PIPELINE_EVENTS.includes(event)) matches = matches.filter((hook) => pyTruthy(hook.pipeline) === (options.pipeline ?? false));
    if (!matches.length) return [];
    // F07.02 wire protocol: every stdin payload names its event, whatever the caller passed in.
    const data: Row = isDict(payload) ? { ...payload, hook_event_name: event } : { payload, hook_event_name: event };
    const results: HookResult[] = [];
    for (const hook of matches) {
      if (options.signal?.aborted || options.shouldRun?.() === false) break;
      const origin = (hook as Row & { [WORKSPACE_HOOK_ORIGIN]?: WorkspaceHookOrigin })[WORKSPACE_HOOK_ORIGIN];
      if (origin && options.admitWorkspaceHook?.(origin) !== true) continue;
      results.push(await this.run(hook, event, data, options.signal));
    }
    return results;
  }
}
