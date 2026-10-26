/**
 * H12.03 — Trajectory replay scrubber.
 *
 * Turns an H02.06 JSONL trajectory into a list of deterministic replay
 * frames — one per recorded event — and exposes the scrubber controls the
 * renderer needs: seek to an arbitrary position, step forward/back one
 * frame, jump between decision points, and reset to the start. Every frame
 * is a pure snapshot of the state the harness had recorded at that point
 * (session metadata, current round, workspace files with accepted patches
 * applied), so seeking, stepping and scrubbing always agree: the state at
 * cursor N is `frames[N]` no matter how the cursor got there.
 *
 * Pure view model — no DOM, no timers; the renderer renders snapshots.
 */

import { parseSolverPatch, type SolverPatch } from "../../../../plugins/deepseek_harness/src/builtins/critic-solver.ts";
import { parseTrajectory, type AnyTrajectoryEvent, type ExchangeEvent, type SessionEvent, type VerdictEvent } from "../../../../plugins/deepseek_harness/src/builtins/trajectory-recorder.ts";

/** One recorded event kind, as condensed for the replay timeline. */
export type ReplayFrameKind = "session" | "exchange" | "verdict";

/** A solver proposal seen in the timeline but not yet verdicted. */
export interface PendingProposal {
  round: number;
  path: string | null;
  summary: string | null;
}

/**
 * Immutable replay state at one timeline position. `files` is the workspace
 * snapshot with every accepted-so-far patch applied; treat it as read-only.
 */
export interface ReplayFrame {
  /** Position of the frame in the timeline (0-based). */
  index: number;
  kind: ReplayFrameKind;
  at: string;
  session: string | null;
  task: string | null;
  solverModel: string | null;
  criticModel: string | null;
  /** Round of the exchange/verdict at this position, null before any. */
  round: number | null;
  /** Role of the exchange at this position ("solver"/"critic"/...). */
  role: string | null;
  /** Critic verdict of the event at this position (verdict frames only). */
  verdict: "accept" | "reject" | null;
  /** Most recent verdict seen at or before this frame. */
  lastVerdict: "accept" | "reject" | null;
  /** Distinct rounds with a recorded accept verdict, ascending. */
  acceptedRounds: number[];
  /** Distinct rounds with a recorded reject verdict, ascending. */
  rejectedRounds: number[];
  /** Latest solver proposal not yet covered by a verdict frame. */
  pendingProposal: PendingProposal | null;
  files: Record<string, string>;
  /** True when this frame is a decision point (solver proposal or verdict). */
  decisionPoint: boolean;
}

export interface ReplayOptions {
  /** H02.06 JSONL trajectory text. */
  trajectory: string;
  /** Baseline workspace contents patches apply to, by path. */
  files?: Record<string, string>;
}

const ascending = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b);

/**
 * Replay the whole trajectory into per-event frames. Frame N reflects
 * events 0..N applied in recording order: session metadata fills in from
 * the session event, solver proposals are remembered per round, and an
 * accept verdict writes that round's proposal content into the workspace
 * snapshot from then on.
 */
export function buildReplayFrames(options: ReplayOptions): ReplayFrame[] {
  const events = parseTrajectory(options.trajectory);
  const frames: ReplayFrame[] = [];
  const proposals = new Map<number, SolverPatch | null>();
  const accepted = new Set<number>();
  const rejected = new Set<number>();
  let session: string | null = null;
  let task: string | null = null;
  let solverModel: string | null = null;
  let criticModel: string | null = null;
  let round: number | null = null;
  let role: string | null = null;
  let verdict: "accept" | "reject" | null = null;
  let lastVerdict: "accept" | "reject" | null = null;
  let pendingProposal: PendingProposal | null = null;
  let files = { ...options.files };
  events.forEach((event: AnyTrajectoryEvent, index) => {
    if (event.type === "session") {
      const sessionEvent = event as SessionEvent;
      session = sessionEvent.session;
      task = sessionEvent.task;
      solverModel = sessionEvent.solverModel;
      criticModel = sessionEvent.criticModel;
      round = null;
      role = null;
      verdict = null;
    } else if (event.type === "exchange") {
      const exchange = event as ExchangeEvent;
      // A torn line can survive `parseTrajectory` with fields missing; an
      // exchange that carries no usable round cannot be pinned to one.
      round = Number.isInteger(exchange.round) ? exchange.round : null;
      role = typeof exchange.role === "string" ? exchange.role : null;
      verdict = null;
      if (role === "solver" && round !== null) {
        const patch = parseSolverPatch(exchange.response ?? "");
        proposals.set(round, patch);
        pendingProposal = patch ? { round, path: patch.path, summary: patch.summary } : { round, path: null, summary: null };
      }
    } else {
      const verdictEvent = event as VerdictEvent;
      round = Number.isInteger(verdictEvent.round) ? verdictEvent.round : null;
      role = null;
      // `parseTrajectory` only checks `type`, so an unrecorded/garbled verdict
      // must not be guessed: it stays null and decides nothing.
      verdict = verdictEvent.verdict === "accept" || verdictEvent.verdict === "reject" ? verdictEvent.verdict : null;
      if (verdict !== null && round !== null) {
        lastVerdict = verdict;
        if (verdict === "accept") {
          accepted.add(round);
          const patch = proposals.get(round) ?? null;
          if (patch && patch.content !== null) files = { ...files, [patch.path]: patch.content };
        } else {
          rejected.add(round);
        }
        pendingProposal = null;
      }
    }
    frames.push({
      index,
      kind: event.type,
      at: event.at,
      session,
      task,
      solverModel,
      criticModel,
      round,
      role,
      verdict,
      lastVerdict,
      acceptedRounds: ascending(accepted),
      rejectedRounds: ascending(rejected),
      pendingProposal,
      files,
      decisionPoint: event.type === "verdict" || (event.type === "exchange" && (event as ExchangeEvent).role === "solver"),
    });
  });
  return frames;
}

/**
 * H12.03 scrubber over precomputed replay frames. The cursor is the single
 * mutable bit; all state transitions are clamp-and-report so dragging the
 * scrubber can never desync from the recorded timeline.
 */
export class TrajectoryScrubber {
  readonly frames: ReplayFrame[];
  private cursor: number;

  constructor(options: ReplayOptions) {
    this.frames = buildReplayFrames(options);
    this.cursor = this.frames.length > 0 ? 0 : -1;
  }

  /** Number of recorded frames; 0 for an empty/blank trajectory. */
  get length(): number {
    return this.frames.length;
  }

  get empty(): boolean {
    return this.frames.length === 0;
  }

  /** Current timeline position, -1 when there is nothing to replay. */
  get position(): number {
    return this.cursor;
  }

  /** Frame at the cursor, or null for an empty timeline. */
  get current(): ReplayFrame | null {
    return this.cursor >= 0 ? (this.frames[this.cursor] ?? null) : null;
  }

  get atStart(): boolean {
    return this.cursor <= 0;
  }

  get atEnd(): boolean {
    return this.cursor >= this.frames.length - 1;
  }

  /**
   * Seek to an arbitrary timeline position. Out-of-range indexes leave the
   * cursor and state untouched and return null (mirrors drawer round
   * selection), so a stale scrubber drag cannot move the replay.
   */
  seek(index: number): ReplayFrame | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) return null;
    this.cursor = index;
    return this.current;
  }

  /**
   * Step `delta` frames from the cursor (default: one forward), clamping at
   * the timeline ends — stepping past either end parks on the boundary
   * frame rather than falling off, and an empty timeline yields null.
   */
  step(delta = 1): ReplayFrame | null {
    if (this.cursor < 0) return null;
    // A fractional/NaN delta would park the cursor between frames (and NaN
    // would poison it permanently), desyncing replay from the timeline.
    if (!Number.isInteger(delta)) return null;
    this.cursor = Math.min(Math.max(this.cursor + delta, 0), this.frames.length - 1);
    return this.current;
  }

  stepBack(): ReplayFrame | null {
    return this.step(-1);
  }

  /** Return to the first recorded frame; null for an empty timeline. */
  reset(): ReplayFrame | null {
    this.cursor = this.frames.length > 0 ? 0 : -1;
    return this.current;
  }

  /**
   * Jump to the next decision point strictly after the cursor (solver
   * proposal or verdict). Returns null and keeps the cursor when none
   * remains.
   */
  nextDecision(): ReplayFrame | null {
    return this.jumpDecision(1);
  }

  /** Jump to the previous decision point strictly before the cursor. */
  previousDecision(): ReplayFrame | null {
    return this.jumpDecision(-1);
  }

  private jumpDecision(direction: 1 | -1): ReplayFrame | null {
    for (let index = this.cursor + direction; index >= 0 && index < this.frames.length; index += direction) {
      if (this.frames[index]!.decisionPoint) {
        this.cursor = index;
        return this.frames[index]!;
      }
    }
    return null;
  }
}

/** Human-readable scrubber label for a frame, e.g. "round 2 · solver". */
export function describeFrame(frame: ReplayFrame): string {
  if (frame.kind === "session") return `session ${frame.session ?? "?"} — ${frame.task ?? "unknown task"}`;
  if (frame.kind === "verdict") return `round ${frame.round ?? "?"} · verdict ${frame.verdict ?? "?"}`;
  return `round ${frame.round ?? "?"} · ${frame.role ?? "exchange"}`;
}
