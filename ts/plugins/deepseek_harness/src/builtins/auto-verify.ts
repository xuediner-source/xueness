/**
 * H02.01 — built-in acceptance gate runner for the DeepSeek harness.
 *
 * After an edit the harness runs the configured gates (typecheck, tests,
 * lint, ...) and, when one fails, returns compressed diagnostics instead of
 * the raw command output. Everything that observes time or processes is
 * injected, so the compression and selection rules are pure and the module
 * stays testable without spawning anything; `spawnGateRunner` is the
 * production runner the H01 adapter hands in.
 */
import { spawn } from "node:child_process";

/** ANSI escapes (CSI sequences, OSC strings, single-character Fe), stripped before compression. */
const ANSI = /[\u001b\u009b](?:\[[0-9;:]*[A-Za-z]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** One acceptance gate: a command plus the workspace paths that trigger it. */
export interface GateDefinition {
  /** Stable gate name used in summaries and diagnostics. */
  readonly name: string;
  /** Command line to run; `command[0]` is the program. */
  readonly command: readonly string[];
  /**
   * Workspace-relative paths (files or directory prefixes) that trigger the
   * gate. A gate without `watch` always runs.
   */
  readonly watch?: readonly string[];
  /** Per-gate timeout in milliseconds; defaults to the runner's. */
  readonly timeoutMs?: number;
}

/** Result of executing one gate command. */
export interface GateRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Executes a gate command; `spawnGateRunner` is the production implementation. */
export type GateRunner = (gate: GateDefinition, cwd: string, timeoutMs: number) => Promise<GateRun>;

/** One gate's outcome inside a verify pass. */
export interface GateOutcome {
  readonly gate: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Compressed diagnostics for a failed gate; `null` when it passed. */
  readonly diagnostics: string | null;
}

/** The result of one `verify` pass over the selected gates. */
export interface VerifySummary {
  readonly passed: boolean;
  /** Outcomes in gate definition order. */
  readonly outcomes: readonly GateOutcome[];
  /** `passed/outcomes passed`, plus the failed gate names. */
  readonly summary: string;
}

export interface CompressionLimits {
  /** Leading lines kept when output is longer than head + tail. */
  readonly headLines: number;
  /** Trailing lines kept when output is longer than head + tail. */
  readonly tailLines: number;
  /** Hard cap on the compressed text's byte length. */
  readonly maxBytes: number;
}

export const DEFAULT_COMPRESSION: Readonly<CompressionLimits> = { headLines: 15, tailLines: 25, maxBytes: 4000 };

export interface AutoVerifyOptions {
  /** Gate definitions, validated once when the runner is created. */
  readonly gates: readonly GateDefinition[];
  /** Working directory the gate commands run in. */
  readonly cwd?: string;
  /** Command executor; defaults to `spawnGateRunner`. */
  readonly run?: GateRunner;
  /** Timeout for gates without their own `timeoutMs`. */
  readonly defaultTimeoutMs?: number;
  /** Stop at the first failed gate instead of running all selected gates. */
  readonly stopOnFirstFailure?: boolean;
  readonly limits?: CompressionLimits;
  /** Clock used for durations, so summaries stay deterministic in tests. */
  readonly now?: () => number;
}

/** Strip ANSI escapes, normalise line endings and trim line tails. */
export function normalizeOutput(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(ANSI, "")
    .split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n").replace(/^\n+|\n+$/gu, "");
}

/**
 * Collapse runs of at least three identical consecutive lines into the line
 * plus a `… repeated N times` marker, keeping the compressed output faithful
 * about how much was skipped.
 */
function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const repeat = end - index;
    out.push(line);
    if (repeat >= 3) out.push(`  … repeated ${repeat} times`);
    index = end;
  }
  return out;
}

/**
 * Compress command output: strip escapes, collapse repeated lines, keep head
 * and tail around an omission marker, and cap the byte length. Deterministic:
 * the same input always compresses to the same text.
 */
export function compressOutput(text: string, limits: CompressionLimits = DEFAULT_COMPRESSION): string {
  const normalized = normalizeOutput(text);
  if (!normalized) return "";
  const lines = collapseRepeats(normalized.split("\n"));
  const keep = limits.headLines + limits.tailLines;
  let compressed: string;
  if (lines.length > keep) {
    const omitted = lines.length - keep;
    compressed = [...lines.slice(0, limits.headLines), `… ${omitted} lines omitted …`, ...lines.slice(lines.length - limits.tailLines)].join("\n");
  } else {
    compressed = lines.join("\n");
  }
  const bytes = Buffer.byteLength(compressed, "utf8");
  if (bytes <= limits.maxBytes) return compressed;
  // A raw byte slice can land inside a multi-byte code point and leave a
  // replacement character in the diagnostics, so cut on character boundaries
  // and let the marker report the true byte count that was dropped.
  let budget = Math.max(0, limits.maxBytes - 64);
  let cut = "";
  for (const char of compressed) {
    const size = Buffer.byteLength(char, "utf8");
    if (size > budget) break;
    budget -= size;
    cut += char;
  }
  const newline = cut.lastIndexOf("\n");
  if (newline >= cut.length / 2) cut = cut.slice(0, newline);
  return `${cut}\n… truncated ${bytes - Buffer.byteLength(cut, "utf8")} bytes …`;
}

/** Whether an edited path is inside a watched prefix (or the watch is empty). */
const watched = (gate: GateDefinition, edited: readonly string[]): boolean => {
  const watch = gate.watch ?? [];
  if (watch.length === 0) return true;
  const normalized = watch.map((prefix) => prefix.replace(/^\.\//u, "").replace(/\/+$/u, ""));
  return edited.some((path) => normalized.some((prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`)));
};

function validateGates(gates: readonly GateDefinition[]): void {
  for (const gate of gates) {
    if (!gate.name.trim()) throw new Error("auto-verify: every gate needs a non-empty name");
    if (gate.command.length === 0 || gate.command.some((part) => !part.trim())) {
      throw new Error(`auto-verify: gate ${gate.name} needs a non-empty command`);
    }
    if (gate.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0)) {
      throw new Error(`auto-verify: gate ${gate.name} needs a positive integer timeoutMs`);
    }
  }
}

const gateDiagnostics = (gate: GateDefinition, run: GateRun, limits: CompressionLimits): string => {
  const parts: string[] = [`gate ${gate.name} failed${run.timedOut ? ` (timed out after signal)` : ` (exit ${run.exitCode ?? "null"})`}`];
  const output = run.stderr.trim() ? `${run.stderr}\n${run.stdout}` : run.stdout;
  const compressed = compressOutput(output, limits);
  if (compressed) parts.push(compressed);
  return parts.join("\n");
};

export interface AutoVerify {
  /** The validated gate table, in definition order. */
  readonly gates: readonly GateDefinition[];
  /**
   * Run the gates selected by `edited` (all gates when no path matches a
   * watch) sequentially and return one summary with compressed diagnostics.
   */
  verify(edited?: readonly string[]): Promise<VerifySummary>;
}

export function createAutoVerify(options: AutoVerifyOptions): AutoVerify {
  validateGates(options.gates);
  const cwd = options.cwd ?? ".";
  const runner = options.run ?? spawnGateRunner;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const limits = options.limits ?? DEFAULT_COMPRESSION;
  const now = options.now ?? Date.now;
  const stopOnFirstFailure = options.stopOnFirstFailure ?? false;

  const summarize = (outcomes: readonly GateOutcome[]): string => {
    const passed = outcomes.filter((outcome) => outcome.passed).length;
    const failed = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.gate);
    const head = outcomes.length === 0 ? "no gates selected" : `${passed}/${outcomes.length} gates passed`;
    return failed.length ? `${head}; failed: ${failed.join(", ")}` : head;
  };

  return {
    gates: options.gates,
    async verify(edited): Promise<VerifySummary> {
      const paths = edited?.map((path) => path.replace(/^\.\//u, "")) ?? [];
      const selected = options.gates.filter((gate) => paths.length === 0 || watched(gate, paths));
      const outcomes: GateOutcome[] = [];
      for (const gate of selected) {
        if (stopOnFirstFailure && outcomes.some((outcome) => !outcome.passed)) break;
        const started = now();
        let run: GateRun;
        try {
          run = await runner(gate, cwd, gate.timeoutMs ?? defaultTimeoutMs);
        } catch (error) {
          run = { exitCode: null, stdout: "", stderr: `${(error as Error).message}`, timedOut: false };
        }
        const passed = run.exitCode === 0 && !run.timedOut;
        outcomes.push({
          gate: gate.name,
          passed,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          durationMs: Math.max(0, now() - started),
          diagnostics: passed ? null : gateDiagnostics(gate, run, limits),
        });
      }
      return { passed: outcomes.every((outcome) => outcome.passed), outcomes, summary: summarize(outcomes) };
    },
  };
}

export interface SpawnOptions {
  /** Environment merged over `process.env`; `PATH` lookups need the rest. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Production gate runner: spawns the command, captures both streams and
 * kills the process on timeout (exit code null, `timedOut` true). Declared
 * under the plugin's `exec` capability.
 */
export function spawnGateRunner(gate: GateDefinition, cwd: string, timeoutMs: number, spawnOptions: SpawnOptions = {}): Promise<GateRun> {
  const [program, ...args] = gate.command as [string, ...string[]];
  const child = spawn(program, args, { cwd, env: { ...process.env, ...spawnOptions.env } });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { stderr += `${error.message}\n`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}
