/**
 * H05.03 — Critic review drawer view model.
 * H05.04 — Review drawer <-> trajectory replay linkage.
 *
 * Pure view model for the desktop renderer's review drawer: it turns a
 * `CriticSolverResult` (H02.05) into per-round views with a Solver/Critic
 * line diff against the workspace baseline, and exposes one-key
 * accept/reject decisions that apply the accepted patch immutably.
 *
 * H05.04 adds the trajectory side: `summarizeTrajectory` condenses an
 * H02.06 JSONL trajectory into a replay timeline, and the drawer maps a
 * timeline event back to the round whose patch decision produced it, so
 * replay can locate a patch decision in the drawer. No DOM access — the
 * renderer only renders this model.
 */

import type { CriticReview, CriticSolverResult, SolverPatch } from "../../../../plugins/deepseek_harness/src/builtins/critic-solver.ts";
import { analyzeTrajectory, parseTrajectory } from "../../../../plugins/deepseek_harness/src/builtins/trajectory-recorder.ts";

/** One rendered diff row: baseline line ("del"), proposed line ("add") or both ("context"). */
export interface DiffRow {
  kind: "add" | "del" | "context";
  text: string;
}

export interface DiffStat {
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * Line-level diff of baseline vs proposal (LCS). An empty proposal string
 * against a non-empty baseline is a deletion-only diff; two empty sides
 * diff to nothing.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ kind: "del", text: a[i]! });
  for (; j < b.length; j += 1) rows.push({ kind: "add", text: b[j]! });
  return rows;
}

export const diffStat = (rows: DiffRow[]): DiffStat => {
  const stat: DiffStat = { added: 0, removed: 0, unchanged: 0 };
  for (const row of rows) {
    if (row.kind === "add") stat.added += 1;
    else if (row.kind === "del") stat.removed += 1;
    else stat.unchanged += 1;
  }
  return stat;
};

/** What the drawer decided about the proposal under review. */
export type DrawerDecisionKind = "accepted" | "rejected";

export interface DrawerDecision {
  kind: DrawerDecisionKind;
  /** Round whose patch was accepted (rejection records the round shown). */
  round: number;
  patch: SolverPatch | null;
  at: string;
}

/** Per-round drawer view: the Solver proposal, the Critic review, the diff. */
export interface ReviewRoundView {
  round: number;
  patch: SolverPatch | null;
  review: CriticReview;
  /** Diff of `files[patch.path]` vs `patch.content`; empty for explanation-only rounds. */
  diff: DiffRow[];
  diffStat: DiffStat;
}

export interface CriticReviewDrawerOptions {
  task: string;
  result: CriticSolverResult;
  /** Baseline workspace contents the patch applies to, by path. */
  files: Record<string, string>;
  /** H02.06 JSONL trajectory backing replay linkage; optional. */
  trajectory?: string;
  now?: () => Date;
}

/**
 * View model of the review drawer. Selection, decisions and file
 * application are all in-memory and immutable from the outside; the
 * renderer renders snapshots, it never mutates the model state directly.
 */
export class CriticReviewDrawer {
  readonly task: string;
  readonly verdict: CriticSolverResult["verdict"];
  readonly exhausted: boolean;
  readonly rounds: ReviewRoundView[];
  private readonly files: Record<string, string>;
  private readonly now: () => Date;
  private selectedRound: number;
  private decisionRecord: DrawerDecision | null = null;

  constructor(options: CriticReviewDrawerOptions) {
    if (!options.task.trim()) throw new Error("review drawer requires a non-empty task");
    this.task = options.task;
    this.verdict = options.result.verdict;
    this.exhausted = options.result.exhausted;
    this.files = { ...options.files };
    this.now = options.now ?? ((): Date => new Date());
    this.rounds = options.result.rounds.map((round) => {
      const before = round.patch ? (this.files[round.patch.path] ?? "") : "";
      const after = round.patch?.content ?? "";
      const diff = round.patch?.content === null || !round.patch ? [] : diffLines(before, after);
      return { round: round.round, patch: round.patch, review: round.review, diff, diffStat: diffStat(diff) };
    });
    const last = this.rounds.at(-1);
    this.selectedRound = last ? last.round : 0;
  }

  /** Currently displayed round view, or null for an empty result. */
  get activeRound(): ReviewRoundView | null {
    return this.rounds.find((view) => view.round === this.selectedRound) ?? null;
  }

  /** The decision taken, or null while the drawer is still pending. */
  get decision(): DrawerDecision | null {
    return this.decisionRecord;
  }

  get pending(): boolean {
    return this.decisionRecord === null;
  }

  /** Select a round for display; unknown rounds leave the selection unchanged and return null. */
  selectRound(round: number): ReviewRoundView | null {
    if (!this.rounds.some((view) => view.round === round)) return null;
    this.selectedRound = round;
    return this.activeRound;
  }

  /**
   * One-key accept: apply the displayed round's patch (falling back to the
   * final proposal when the shown round is explanation-only). Idempotent —
   * after any decision the first decision stands and is returned.
   */
  accept(): DrawerDecision {
    if (this.decisionRecord) return this.decisionRecord;
    const shown = this.activeRound;
    const patch = shown?.patch ?? null;
    const target = patch?.content === null || !patch ? this.rounds.at(-1)?.patch ?? null : patch;
    const round = shown?.round ?? this.rounds.at(-1)?.round ?? 0;
    this.decisionRecord = { kind: "accepted", round, patch: target, at: this.now().toISOString() };
    return this.decisionRecord;
  }

  /** One-key reject: dismiss the proposal. Idempotent like `accept`. */
  reject(): DrawerDecision {
    if (this.decisionRecord) return this.decisionRecord;
    const shown = this.activeRound;
    this.decisionRecord = {
      kind: "rejected",
      round: shown?.round ?? this.rounds.at(-1)?.round ?? 0,
      patch: shown?.patch ?? null,
      at: this.now().toISOString(),
    };
    return this.decisionRecord;
  }

  /**
   * Workspace snapshot with the accepted patch applied. Before a decision
   * (or for a reject / explanation-only accept) it is an unchanged copy.
   */
  appliedFiles(): Record<string, string> {
    const merged = { ...this.files };
    const decision = this.decisionRecord;
    if (decision?.kind === "accepted" && decision.patch?.content !== null && decision.patch) {
      merged[decision.patch.path] = decision.patch.content;
    }
    return merged;
  }
}

/** H05.04 — one replay timeline entry derived from a trajectory event. */
export interface TrajectoryTimelineItem {
  /** Position of the event in the parsed trajectory. */
  index: number;
  type: "session" | "exchange" | "verdict";
  at: string;
  round: number | null;
  role: string | null;
  modelId: string | null;
  callIndex: number | null;
  verdict: "accept" | "reject" | null;
  path: string | null;
}

export interface TrajectorySummary {
  session: string | null;
  task: string | null;
  solverModel: string | null;
  criticModel: string | null;
  exchanges: number;
  /** Distinct round numbers seen in exchange/verdict events, ascending. */
  rounds: number[];
  /** Overall KV prefix-cache hit rate from `analyzeTrajectory`. */
  hitRate: number;
  timeline: TrajectoryTimelineItem[];
}

/** Condense an H02.06 JSONL trajectory into the summary the drawer replays. */
export function summarizeTrajectory(text: string): TrajectorySummary {
  const events = parseTrajectory(text);
  const timeline: TrajectoryTimelineItem[] = [];
  const roundSet = new Set<number>();
  let session: string | null = null;
  let task: string | null = null;
  let solverModel: string | null = null;
  let criticModel: string | null = null;
  let exchanges = 0;
  events.forEach((event, index) => {
    if (event.type === "session") {
      session = event.session;
      task = event.task;
      solverModel = event.solverModel;
      criticModel = event.criticModel;
      timeline.push({ index, type: "session", at: event.at, round: null, role: null, modelId: null, callIndex: null, verdict: null, path: null });
    } else if (event.type === "exchange") {
      exchanges += 1;
      roundSet.add(event.round);
      timeline.push({ index, type: "exchange", at: event.at, round: event.round, role: event.role, modelId: event.modelId, callIndex: event.callIndex, verdict: null, path: null });
    } else {
      roundSet.add(event.round);
      timeline.push({ index, type: "verdict", at: event.at, round: event.round, role: null, modelId: null, callIndex: null, verdict: event.verdict, path: event.path });
    }
  });
  return {
    session,
    task,
    solverModel,
    criticModel,
    exchanges,
    rounds: [...roundSet].sort((a, b) => a - b),
    hitRate: analyzeTrajectory(text).hitRate,
    timeline,
  };
}

/** H05.04 — where a trajectory event lands in the drawer. */
export interface PatchDecisionLocation {
  round: number;
  /** Critic verdict recorded for that round in the drawer result. */
  verdict: "accept" | "reject";
  path: string | null;
  patch: SolverPatch | null;
  review: CriticReview | null;
  diff: DiffRow[] | null;
}

export interface TrajectoryLinkedDrawerOptions extends CriticReviewDrawerOptions {
  trajectory: string;
}

/**
 * H05.04 — a `CriticReviewDrawer` wired to a trajectory summary. Replay
 * navigation (`focus`) maps timeline events to the round — and thus the
 * patch decision — that produced them, selecting it in the drawer.
 */
export class TrajectoryLinkedDrawer extends CriticReviewDrawer {
  readonly summary: TrajectorySummary;

  constructor(options: TrajectoryLinkedDrawerOptions) {
    super(options);
    this.summary = summarizeTrajectory(options.trajectory);
  }

  /** Locate a patch decision by round, independent of the replay timeline. */
  locateDecision(round: number): PatchDecisionLocation | null {
    const view = this.rounds.find((item) => item.round === round);
    if (!view) return null;
    return {
      round,
      verdict: view.review.verdict,
      path: view.patch?.path ?? null,
      patch: view.patch,
      review: view.review,
      diff: view.patch?.content === null || !view.patch ? null : view.diff,
    };
  }

  /**
   * Jump from a replay timeline item to the patch decision it belongs to:
   * exchange/verdict events select and return their round's decision,
   * session events have no round and return null.
   */
  focus(item: TrajectoryTimelineItem): PatchDecisionLocation | null {
    if (item.round === null) return null;
    if (!this.selectRound(item.round)) return null;
    return this.locateDecision(item.round);
  }

  /** Replay timeline filtered to entries that carry a patch decision. */
  decisionPoints(): TrajectoryTimelineItem[] {
    return this.summary.timeline.filter((item) => item.round !== null && (item.type === "verdict" || item.role === "solver"));
  }
}

/**
 * H12.04 — Visual states of the drawer surface: what the renderer should
 * paint while a review is being fetched, once it is interactive, when the
 * critic produced nothing to show, and when loading failed.
 */
export type CriticDrawerVisualState = "idle" | "loading" | "ready" | "empty" | "error";

export interface CriticDrawerStatus {
  state: CriticDrawerVisualState;
  message: string;
  /** True when calling `refresh()` again can move the drawer forward. */
  retryable: boolean;
}

export interface CriticDrawerControllerOptions {
  task: string;
  /** Baseline workspace contents, by path; forwarded to the drawer. */
  files?: Record<string, string>;
  /** H02.06 JSONL trajectory; forwarded when present. */
  trajectory?: string;
  /** Fetches the review result to display; may reject. */
  load: () => Promise<CriticSolverResult>;
  now?: () => Date;
}

const statusMessage = (state: CriticDrawerVisualState, detail: string | null): CriticDrawerStatus => ({
  state,
  message:
    state === "idle" ? "No critic review loaded yet."
      : state === "loading" ? "Loading critic review…"
        : state === "ready" ? "Critic review ready."
          : state === "empty" ? "Critic finished without review rounds."
            : detail ?? "Failed to load critic review.",
  retryable: state === "empty" || state === "error",
});

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || "Failed to load critic review.";
};

/**
 * H12.04 — Loads review results for the drawer and tracks the visual state
 * around that load. Pure orchestration: no timers, no DOM; `refresh` is
 * awaited by the caller (or driven by the renderer's event loop). The last
 * successfully loaded drawer stays available while a reload is in flight or
 * after a failure, so a transient error never blanks an open review.
 */
export class CriticDrawerController {
  readonly task: string;
  private readonly files: Record<string, string>;
  private readonly trajectory: string | undefined;
  private readonly now: (() => Date) | undefined;
  private readonly loadResult: () => Promise<CriticSolverResult>;
  private stateRecord: CriticDrawerVisualState = "idle";
  private drawerRecord: CriticReviewDrawer | null = null;
  private errorRecord: string | null = null;
  private attemptsRecord = 0;
  private inflight: Promise<CriticReviewDrawer | null> | null = null;

  constructor(options: CriticDrawerControllerOptions) {
    if (!options.task.trim()) throw new Error("review drawer requires a non-empty task");
    this.task = options.task;
    this.files = { ...options.files };
    this.trajectory = options.trajectory;
    this.now = options.now;
    this.loadResult = options.load;
  }

  get state(): CriticDrawerVisualState {
    return this.stateRecord;
  }

  /** Paint-ready status for the current state. */
  get status(): CriticDrawerStatus {
    return statusMessage(this.stateRecord, this.errorRecord);
  }

  /** Last successfully loaded drawer, or null before the first success. */
  get drawer(): CriticReviewDrawer | null {
    return this.drawerRecord;
  }

  /** Message of the last failed load, or null. */
  get error(): string | null {
    return this.errorRecord;
  }

  /** Completed load attempts, successful or not. */
  get attempts(): number {
    return this.attemptsRecord;
  }

  /**
   * (Re)load the review. Concurrent calls share one in-flight load. On
   * success the drawer is rebuilt (empty result → "empty" state); on
   * rejection the state becomes "error" with the failure message and any
   * previously loaded drawer is retained.
   */
  refresh(): Promise<CriticReviewDrawer | null> {
    if (this.inflight) return this.inflight;
    this.attemptsRecord += 1;
    this.stateRecord = "loading";
    this.errorRecord = null;
    // The loader is invoked synchronously (so concurrent callers observe a
    // single in-flight load), but a synchronous throw must fail the refresh
    // like a rejected promise would — otherwise the drawer stays stuck
    // painting "loading" and the rejection escapes the caller's await.
    let pending: Promise<CriticSolverResult>;
    try {
      pending = Promise.resolve(this.loadResult());
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.inflight = pending
      .then((result) => {
        const drawer = new CriticReviewDrawer({ task: this.task, result, files: this.files, trajectory: this.trajectory, now: this.now });
        this.drawerRecord = drawer;
        this.stateRecord = drawer.rounds.length > 0 ? "ready" : "empty";
        return drawer;
      })
      .catch((error: unknown) => {
        this.errorRecord = errorText(error);
        this.stateRecord = "error";
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
