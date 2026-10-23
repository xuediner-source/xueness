/**
 * `remote_exec` SSH path. The remote command is one ssh argument, quoted like
 * `shlex.quote` / `shlex.join` (ASCII `\w`). It is never passed to a local shell.
 *
 * The saved row is re-read under an in-process mutex before the operator
 * command. This is not Python's cross-process `_config_lock` flock: another
 * process can still replace the file. The mutex is not held across SSH.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { pyLen, pySubstring } from "@xueness/contracts";
import {
  FEATURE_ID,
  PROBE_COMMAND,
  PROBE_TIMEOUT_SECONDS,
  clientUnavailableResult,
  commandTimeoutResult,
  decide,
  enabled,
  timeoutResult,
  type Row,
} from "./handshake.ts";
import { digest, loadConnections, posixOrThrow, sshArgv, sshEnv, type RemoteConnection } from "./store.ts";

export const COMMAND_TIMEOUT_SECONDS = 40;
const OUTPUT_LIMIT = 16_000;
const ARG_LIMIT = 16_000;
const ARG_COUNT = 128;
const CAPTURE_BYTES = 300_000;

export class RemoteValueError extends Error {
  override name = "ValueError";
}

/** Local ssh wait expired. `stdout` / `stderr` are the partial streams. */
export class SshTimeoutError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(stdout = "", stderr = "") {
    super("ssh timed out");
    this.name = "TimeoutExpired";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class SshClientUnavailableError extends Error {
  override name = "OSError";
  constructor() {
    super("ssh client unavailable");
  }
}

export interface SshCompleted {
  returncode: number | null;
  stdout: string;
  stderr: string;
}

export interface SshSpec {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  windowsHide: true;
}

export type SshRunner = (spec: SshSpec) => Promise<SshCompleted>;

export interface RemoteExecArgs {
  connection: string;
  connection_digest: string;
  argv: string[];
}

/** `shlex.quote`: empty is `''`; safe ASCII words stay bare; otherwise single quotes. */
const SAFE_WORD = /^[\w@%+=:,./-]+$/;

export function posixQuote(text: string): string {
  if (text === "") return "''";
  if (SAFE_WORD.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** `cd -- <quoted directory> && exec <shlex.join(argv)>`. */
export function remoteCommand(directory: string, argv: readonly string[]): string {
  return `cd -- ${posixQuote(directory)} && exec ${argv.map(posixQuote).join(" ")}`;
}

const tails = new Map<string, Promise<void>>();

async function withConnectionLock<T>(stateDir: string, body: () => T): Promise<T> {
  const previous = tails.get(stateDir) ?? Promise.resolve();
  const run = previous.then(body, body);
  tails.set(stateDir, run.then(() => undefined, () => undefined));
  return run;
}

function validArgv(argv: unknown): argv is string[] {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= ARG_COUNT
    && argv.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0") && pyLen(item) <= ARG_LIMIT);
}

/**
 * Python `_exec` checks before Gate: load, POSIX system, argv, digest.
 * The command string is built only after those checks.
 */
export function prepareRemote(stateDir: string, args: RemoteExecArgs): { row: RemoteConnection; command: string } {
  const row = loadConnections(stateDir).find((item) => item.id === args.connection);
  if (!row) throw new RemoteValueError("connection unavailable");
  posixOrThrow(row);
  if (!validArgv(args.argv)) throw new RemoteValueError("literal argv required");
  if (args.connection_digest !== digest(row)) throw new RemoteValueError("connection changed; inspect configuration again");
  return { row, command: remoteCommand(row.directory ?? ".", args.argv) };
}

function rowStillSaved(stateDir: string, row: RemoteConnection): boolean {
  try {
    const current = loadConnections(stateDir).find((item) => item.id === row.id);
    return current !== undefined && digest(current) === digest(row);
  } catch {
    return false;
  }
}

/** `{ok, exit_code, output}` like `_command_result`. Output is at most 16000 code points. */
export function commandResult(proc: { returncode: number | null; stdout?: unknown; stderr?: unknown }): Row {
  const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
  const stderr = typeof proc.stderr === "string" ? proc.stderr : "";
  return { ok: proc.returncode === 0, exit_code: proc.returncode, output: pySubstring(stdout + stderr, 0, OUTPUT_LIMIT) };
}

function collect(stream: NodeJS.ReadableStream | null): { text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (size >= CAPTURE_BYTES) return;
    const part = buffer.byteLength > CAPTURE_BYTES - size ? buffer.subarray(0, CAPTURE_BYTES - size) : buffer;
    chunks.push(part);
    size += part.byteLength;
  });
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

/** ssh argv from `sshArgv`, no local shell, no inherited console (`windowsHide`). */
function spawnSsh(spec: SshSpec): Promise<SshCompleted> {
  return new Promise((resolve, reject) => {
    if (!spec.argv.length || !spec.argv[0]) {
      reject(new SshClientUnavailableError());
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new SshClientUnavailableError());
      return;
    }
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    let done = false;
    let timed = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = (finish: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      finish();
    };
    const timer = setTimeout(() => {
      timed = true;
      child.kill("SIGKILL");
      grace = setTimeout(() => stop(() => reject(new SshTimeoutError(stdout.text(), stderr.text()))), 1000);
    }, spec.timeoutSeconds * 1000);
    child.once("error", () => stop(() => reject(new SshClientUnavailableError())));
    child.once("close", (code) => stop(() => {
      if (timed) reject(new SshTimeoutError(stdout.text(), stderr.text()));
      else resolve({ returncode: code, stdout: stdout.text(), stderr: stderr.text() });
    }));
  });
}

function probeRefused(error: unknown): Row | null {
  if (error instanceof SshTimeoutError) return timeoutResult(error);
  if (error instanceof SshClientUnavailableError) return clientUnavailableResult();
  return null;
}

/**
 * Load, refuse Windows, check the digest, then ssh.
 * When the handshake flag is on, the probe runs first and a refusal does not send `argv`.
 */
export async function runRemoteExec(stateDir: string, root: string, args: RemoteExecArgs, runner: SshRunner = spawnSsh): Promise<Row> {
  const prepared = await withConnectionLock(stateDir, () => prepareRemote(stateDir, args));
  const invoke = (remote: string, timeoutSeconds: number): Promise<SshCompleted> => runner({
    argv: sshArgv(prepared.row, remote),
    cwd: root,
    env: sshEnv(),
    timeoutSeconds,
    windowsHide: true,
  });
  if (!enabled(stateDir)) return invoke(prepared.command, COMMAND_TIMEOUT_SECONDS).then(commandResult);
  let probe: SshCompleted;
  try {
    probe = await invoke(PROBE_COMMAND, PROBE_TIMEOUT_SECONDS);
  } catch (error) {
    const refused = probeRefused(error);
    if (refused) return refused;
    throw error;
  }
  const decision = decide(probe.returncode, probe.stdout, probe.stderr);
  if (!decision.accepted) return decision.result;
  const still = await withConnectionLock(stateDir, () => rowStillSaved(stateDir, prepared.row));
  if (!still) throw new RemoteValueError("connection changed; inspect configuration again");
  try {
    const proc = await invoke(prepared.command, COMMAND_TIMEOUT_SECONDS);
    return { ...commandResult(proc), executed: true, feature: FEATURE_ID, handshake: decision.hello };
  } catch (error) {
    if (error instanceof SshTimeoutError) return commandTimeoutResult(error, decision.hello);
    if (error instanceof SshClientUnavailableError) {
      const result = clientUnavailableResult();
      result.handshake = decision.hello;
      return result;
    }
    throw error;
  }
}
