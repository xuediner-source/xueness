/**
 * H02.02 — stack-trace compression and the bounded self-repair loop.
 *
 * `compressStackTrace` turns a raw error stack into a bounded, deterministic
 * excerpt: the message, the outermost user frames, internal frames folded
 * into omission markers, and workspace paths relativised. `runSelfRepairLoop`
 * pairs that with the H02.01 verify pass: after each failed gate round it
 * hands the compressed diagnostics to a repair callback and re-verifies, at
 * most `maxAttempts` times, so the loop always terminates.
 */
import { compressOutput, DEFAULT_COMPRESSION, type CompressionLimits } from "./auto-verify.ts";

/** One parsed stack frame, already classified. */
interface Frame {
  readonly text: string;
  readonly internal: boolean;
}

/** A stack line is a frame when it starts (after indentation) with `at `. */
const isFrame = (line: string): boolean => /^\s*at\s/u.test(line);

/** Node internals, third-party packages and erasable dist output are noise for repair. */
const isInternal = (line: string): boolean =>
  line.includes("node_modules/") || line.includes("(node:") || line.includes("node:internal") || /\/dist\/[a-z]/iu.test(line);

export interface StackOptions {
  /** Maximum user (non-internal) frames kept. */
  readonly maxFrames?: number;
  /** Workspace root stripped from file paths, when known. */
  readonly cwd?: string;
  /** Hard cap on the compressed stack's byte length. */
  readonly limits?: CompressionLimits;
}

export interface CompressedStack {
  /** The stack text that was compressed. */
  readonly raw: string;
  /** Deterministic compressed excerpt: message plus bounded frames. */
  readonly compressed: string;
  /** Internal (node_modules / node:) frames dropped from the excerpt. */
  readonly internalFramesDropped: number;
  /** User frames kept in the excerpt. */
  readonly userFramesKept: number;
  /** True when the input did not look like a stack trace at all. */
  readonly notAStack: boolean;
}

/** Normalise one frame's file paths against the workspace root. */
function relativise(line: string, cwd: string | undefined): string {
  if (!cwd) return line;
  return line.split(cwd.endsWith("/") ? cwd : `${cwd}/`).join("");
}

/**
 * Compress an `Error.stack` string. The leading non-`at` lines (the error
 * message chain) are kept via `compressOutput`; frames are then classified,
 * internal runs folded into `… N internal frames omitted`, and at most
 * `maxFrames` user frames kept behind `… M more frames`. Non-stack input is
 * returned compressed as-is with `notAStack: true`.
 */
export function compressStackTrace(stack: string, options: StackOptions = {}): CompressedStack {
  const maxFrames = options.maxFrames ?? 8;
  const raw = stack;
  const lines = stack.split("\n").map((line) => line.replace(/\r$/u, ""));
  const hasFrames = lines.some((line) => isFrame(line));
  if (!hasFrames) {
    return { raw, compressed: compressOutput(lines.join("\n"), options.limits ?? DEFAULT_COMPRESSION), internalFramesDropped: 0, userFramesKept: 0, notAStack: true };
  }
  const header: string[] = [];
  const frames: Frame[] = [];
  for (const line of lines) {
    if (frames.length === 0 && !isFrame(line)) header.push(line);
    else if (isFrame(line)) frames.push({ text: relativise(line, options.cwd).trim(), internal: isInternal(line) });
  }
  const out: string[] = [...header];
  let internalDropped = 0;
  let userKept = 0;
  let userSeen = 0;
  let runOfInternal = 0;
  const flushInternal = (): void => {
    if (runOfInternal > 0) {
      out.push(`    … ${runOfInternal} internal frames omitted …`);
      runOfInternal = 0;
    }
  };
  for (const frame of frames) {
    if (frame.internal) {
      internalDropped += 1;
      runOfInternal += 1;
      continue;
    }
    userSeen += 1;
    if (userSeen > maxFrames) continue;
    flushInternal();
    userKept += 1;
    out.push(frame.text);
  }
  flushInternal();
  if (userSeen > userKept) out.push(`    … ${userSeen - userKept} more frames …`);
  return {
    raw,
    compressed: compressOutput(out.join("\n"), options.limits ?? DEFAULT_COMPRESSION),
    internalFramesDropped: internalDropped,
    userFramesKept: userKept,
    notAStack: false,
  };
}

/** A thrown value as message plus compressed stack, safe for any input. */
export function describeError(error: unknown, options: StackOptions = {}): { message: string; stack: CompressedStack | null } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack ? compressStackTrace(error.stack, options) : null };
  }
  return { message: String(error), stack: null };
}

/** What the repair callback learns about one failed verify round. */
export interface RepairFeedback {
  /** 1-based attempt number that just failed. */
  readonly attempt: number;
  /** The verify summary line from H02.01. */
  readonly summary: string;
  /** Compressed diagnostics of the failed gates, already bounded. */
  readonly diagnostics: string | null;
}

export interface SelfRepairOptions {
  /** One verify pass; `passed` true means the gates are green. */
  readonly verify: () => Promise<{ readonly passed: boolean; readonly summary: string; readonly diagnostics: string | null }>;
  /**
   * Apply one repair from the feedback and describe it (for the history), or
   * return `null`/`undefined` to give up. Throwing counts as a failed repair
   * attempt and the loop continues until the attempts are exhausted.
   */
  readonly repair: (feedback: RepairFeedback) => Promise<string | null | undefined> | string | null | undefined;
  /** Maximum verify→repair rounds; at least 1. */
  readonly maxAttempts?: number;
}

/** One recorded attempt: what the gates said and what the repair did. */
export interface RepairAttempt {
  readonly attempt: number;
  readonly passed: boolean;
  readonly summary: string;
  readonly diagnostics: string | null;
  /** Repair description, `null` when the callback gave up or threw. */
  readonly repair: string | null;
  /** The callback's error, when it threw. */
  readonly error: string | null;
}

export interface SelfRepairResult {
  /** `passed` (green within the attempts), `exhausted` or `gave_up`. */
  readonly status: "passed" | "exhausted" | "gave_up";
  /** Verify rounds used (the passing round included). */
  readonly attempts: number;
  readonly history: readonly RepairAttempt[];
}

/**
 * The bounded self-repair loop: verify, repair from compressed diagnostics,
 * re-verify, at most `maxAttempts` rounds. Every path terminates — the loop
 * is a plain bounded `for`, a `null` repair ends it as `gave_up`, and the
 * last failed round ends it as `exhausted`.
 */
export async function runSelfRepairLoop(options: SelfRepairOptions): Promise<SelfRepairResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`self-repair: maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  const history: RepairAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const round = await options.verify();
    const failed = round.diagnostics ?? null;
    if (round.passed) {
      history.push({ attempt, passed: true, summary: round.summary, diagnostics: failed, repair: null, error: null });
      return { status: "passed", attempts: attempt, history };
    }
    if (attempt === maxAttempts) {
      history.push({ attempt, passed: false, summary: round.summary, diagnostics: failed, repair: null, error: null });
      return { status: "exhausted", attempts: attempt, history };
    }
    let repair: string | null = null;
    let error: string | null = null;
    try {
      const described = await options.repair({ attempt, summary: round.summary, diagnostics: failed });
      repair = described ?? null;
    } catch (cause) {
      error = describeError(cause).message;
    }
    history.push({ attempt, passed: false, summary: round.summary, diagnostics: failed, repair, error });
    // A declined repair ends the loop; a thrown one is a failed attempt, and the budget still bounds it.
    if (repair === null && error === null) return { status: "gave_up", attempts: attempt, history };
  }
  // Unreachable: the loop returns from every branch on its last iteration.
  return { status: "exhausted", attempts: maxAttempts, history };
}
