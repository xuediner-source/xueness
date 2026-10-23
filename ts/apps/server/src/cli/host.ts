/**
 * The CLI's in-process host: the same feature APIs the web front door serves,
 * built once per invocation without a listener, a scheduler or a Python
 * backend (`xueness.cli` calls the plugin functions directly).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@xueness/contracts";
import { NativeFileLocks, SessionStore } from "@xueness/sessions";
import { createSessionsStore } from '@xueness/plugin-sessions';
import { createApplicationApi, type ApplicationApi, type ApplicationApiOptions } from "../application-api.ts";
import { effectivePlugins } from "../plugin-state.ts";
import { CliExit, pyRepr, type Args, type Parser } from "./argparse.ts";
import { out, err, endCliOutput } from "./output.ts";
export { out, err } from "./output.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
export type Reply = [number, any];

/** `str(Path(raw))`: repeated and trailing separators and `.` segments dropped. */
export function pyPath(raw: unknown): string {
  const text = String(raw), absolute = text.startsWith("/");
  const joined = text.split("/").filter((part) => part && part !== ".").join("/");
  return absolute ? "/" + joined : joined || ".";
}
/** `_workspace(value)`: `Path(value).expanduser()`, or the current directory. */
export function workspacePath(value: unknown): string {
  if (value === null || value === undefined) return process.cwd();
  const text = String(value);
  return pyPath(text === "~" || text.startsWith("~/") ? (process.env.HOME ?? "") + text.slice(1) : text);
}
/** `json.dumps(value, ensure_ascii=False[, indent])`. */
export const dumps = (value: unknown, indent?: number): string => pyJsonDumps(value, indent === undefined ? {} : { indent });
const ERRNO: Record<string, [number, string]> = { ENOENT: [2, "No such file or directory"], EACCES: [13, "Permission denied"], EISDIR: [21, "Is a directory"], ENOTDIR: [20, "Not a directory"], ELOOP: [40, "Too many levels of symbolic links"], EPERM: [1, "Operation not permitted"] };
/** `str(OSError)` for a failed file operation: `[Errno 2] No such file or directory: 'path'`. */
export function osErrorText(error: unknown, path: string): string {
  const known = ERRNO[(error as { code?: string })?.code ?? ""];
  return known ? `[Errno ${known[0]}] ${known[1]}: ${pyRepr(path)}` : errorText(error);
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const allowRealDefault = (): boolean => process.env.XUENESS_ALLOW_REAL === undefined || ["1", "true", "yes", "on"].includes(process.env.XUENESS_ALLOW_REAL.trim().toLowerCase());

export class Cli {
  readonly args: Args;
  readonly parser: Parser;
  readonly projectRoot: string;
  readonly state: string;
  readonly language: "zh" | "en";
  /** `str(args.state)`: the path as given (Python prints it unresolved). */
  readonly stateText: string;
  /** Host options a command sets before the first `host()` call (the app server's roots). */
  overrides: Partial<ApplicationApiOptions> = {};
  #host: Promise<ApplicationApi> | null = null;
  #store: SessionStore | null = null;
  #locks: NativeFileLocks | null = null;

  constructor(args: Args, parser: Parser, projectRoot = PROJECT_ROOT) {
    this.args = args;
    this.parser = parser;
    this.projectRoot = projectRoot;
    this.state = resolve(String(args.state));
    this.stateText = pyPath(args.state);
    this.language = args.language === "en" ? "en" : "zh";
  }

  /** The parser of the running subcommand (argparse errors name it). */
  get sub(): Parser { return this.parser; }
  error(message: string): never { endCliOutput(); return this.parser.error(message); }
  enabled(id: string): boolean { return effectivePlugins(this.projectRoot, this.state)(id); }
  zh(zh: string, en: string): string { return this.language === "en" ? en : zh; }

  /** The application APIs; `agent` options apply only to the first call. */
  host(agent?: ApplicationApiOptions["agent"]): Promise<ApplicationApi> {
    this.#host ??= createApplicationApi({ projectRoot: this.projectRoot, stateDir: this.state, webRuns: join(this.projectRoot, ".web-runs"), cwd: process.cwd(),
      allowReal: allowRealDefault(), scheduler: false, ...this.overrides, ...(agent ? { agent } : {}) });
    return this.#host;
  }

  /** A session store; the host's when it is built, so leases are shared. */
  async store(): Promise<SessionStore> {
    if (this.#host) return (await this.#host).store;
    this.#locks ??= new NativeFileLocks();
    this.#store ??= createSessionsStore(this.state, { locks: this.#locks, enabled: id => this.enabled(id) });
    return this.#store;
  }

  /** One API call through the feature owners, as the front door would route it. */
  async api(method: string, path: string, data: Record<string, unknown> = {}, query: Record<string, string[]> = {}): Promise<Reply> {
    const host = await this.host();
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const reply = await host.dispatch(method, parts, query, data);
    return reply === null ? [404, { error: "not found" }] : [reply[0], reply[1]];
  }

  /** Print an API reply as indented JSON, or `ERROR (status): error` (exit 1). */
  report([status, payload]: Reply): number {
    if (status >= 400) { err(`ERROR (${status}): ${payload?.error ?? "unknown"}`); return 1; }
    out(dumps(payload, 2));
    return 0;
  }

  async close(): Promise<void> {
    if (this.#host) await (await this.#host).close();
    else await this.#locks?.close();
  }
}

export function exitWith(code: number): never { throw new CliExit(code); }
