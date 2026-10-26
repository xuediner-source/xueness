/**
 * Dashboard projection for dynamic workflow runs (F10.05): the panel state a
 * frontend renders. The snapshot is a *projection*, never a second store —
 * run status comes from the durable run records, artifact rows from the
 * artifact manifests on disk (metadata only, bodies stay by reference), and
 * stream rows from the durable stream tails. Anything the run record carries
 * inline that is actually large is elided to its size, so the panel can never
 * be talked into shipping a body.
 */
import { pyJsonDumps } from "@xueness/contracts";
import type { DynamicArtifactRef, DynamicArtifactStore } from "./dynamic-artifacts.ts";
import type { DynamicStreamBroker } from "./dynamic-streams.ts";
import type { DynamicNode, DynamicRunStatus, DynamicWorkflowRun } from "./dynamic-types.ts";

/** A panel never renders more than this many nodes/artifacts/streams per run. */
export const DASHBOARD_MAX_NODES = 200;
export const DASHBOARD_MAX_ARTIFACTS = 50;
export const DASHBOARD_MAX_STREAMS = 20;
/** Inline values above this many canonical characters are elided in a snapshot. */
export const DASHBOARD_INLINE_MAX_CHARS = 2048;

export interface DashboardNodeRow {
  id: string;
  kind: DynamicNode["kind"];
  status: DynamicNode["status"];
  error?: string;
  awaiting?: string;
}

export interface DashboardStreamRow {
  name: string;
  lastSeq: number;
  lastAt: string | null;
  settled: boolean;
}

export type DashboardResult =
  | { kind: "none" }
  | { kind: "inline"; value: unknown }
  | { kind: "artifact-ref"; ref: DynamicArtifactRef }
  | { kind: "elided"; chars: number };

export interface DashboardRunRow {
  id: string;
  name: string;
  status: DynamicRunStatus;
  phase: string | null;
  inFlight: boolean;
  createdAt: string;
  updatedAt: string;
  importedFrom: string | null;
  progress: { completed: number; failed: number; awaitingUser: number; active: number; total: number };
  nodes: DashboardNodeRow[];
  truncated: { nodes: boolean; artifacts: boolean; streams: boolean };
  artifacts: DynamicArtifactRef[];
  streams: DashboardStreamRow[];
  result: DashboardResult;
  error: string | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  totals: { runs: number; inFlight: number; awaitingUser: number; settled: number; artifacts: number };
  runs: DashboardRunRow[];
}

export interface DashboardSources {
  artifacts: DynamicArtifactStore;
  streams: DynamicStreamBroker;
}

const IN_FLIGHT: ReadonlySet<DynamicRunStatus> = new Set(["queued", "running"]);

function resultSummary(run: DynamicWorkflowRun): DashboardResult {
  if (run.result === undefined) return { kind: "none" };
  const ref = run.result as Partial<DynamicArtifactRef>;
  if (typeof ref === "object" && ref !== null && typeof ref.$artifact === "string") {
    return { kind: "artifact-ref", ref: ref as DynamicArtifactRef };
  }
  const chars = pyJsonDumps(run.result).length;
  if (chars > DASHBOARD_INLINE_MAX_CHARS) return { kind: "elided", chars };
  return { kind: "inline", value: run.result };
}

function nodeRow(node: DynamicNode): DashboardNodeRow {
  const row: DashboardNodeRow = { id: node.id, kind: node.kind, status: node.status };
  if (node.error !== undefined) row.error = node.error;
  if (node.question !== undefined) row.awaiting = node.question;
  return row;
}

function progressOf(nodes: DynamicNode[]): DashboardRunRow["progress"] {
  const progress = { completed: 0, failed: 0, awaitingUser: 0, active: 0, total: nodes.length };
  for (const node of nodes) {
    if (node.status === "completed") progress.completed += 1;
    else if (node.status === "failed") progress.failed += 1;
    else if (node.status === "awaiting_user") progress.awaitingUser += 1;
    else progress.active += 1;
  }
  return progress;
}

/** One run's panel row: durable record state plus disk-backed artifact/stream facts. */
export function dashboardRun(run: DynamicWorkflowRun, sources: DashboardSources): DashboardRunRow {
  const nodes = Object.values(run.nodes).sort((left, right) =>
    left.siteId.localeCompare(right.siteId) || left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  let artifacts: DynamicArtifactRef[] = [];
  try { artifacts = sources.artifacts.manifest(run.id); } catch { /* A run with no artifact directory shows none. */ }
  let streamNames: string[] = [];
  try { streamNames = sources.streams.names(run.id); } catch { /* Likewise for streams. */ }
  const streams: DashboardStreamRow[] = [];
  for (const name of streamNames.slice(0, DASHBOARD_MAX_STREAMS)) {
    const settled = sources.streams.future(run.id, name) !== null;
    const tail = sources.streams.read(run.id, name, 0);
    const last = tail.events.at(-1);
    streams.push({ name, lastSeq: tail.lastSeq, lastAt: last?.at ?? null, settled });
  }
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    phase: run.phase ?? null,
    inFlight: IN_FLIGHT.has(run.status),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    importedFrom: run.importedFrom ?? null,
    progress: progressOf(nodes),
    nodes: nodes.slice(0, DASHBOARD_MAX_NODES).map(nodeRow),
    truncated: {
      nodes: nodes.length > DASHBOARD_MAX_NODES,
      artifacts: artifacts.length > DASHBOARD_MAX_ARTIFACTS,
      streams: streamNames.length > DASHBOARD_MAX_STREAMS,
    },
    artifacts: artifacts.slice(0, DASHBOARD_MAX_ARTIFACTS),
    streams,
    result: resultSummary(run),
    error: run.error ?? null,
  };
}

/** The whole panel: every scoped run, newest update first, plus totals. */
export function dashboardSnapshot(runs: readonly DynamicWorkflowRun[], sources: DashboardSources): DashboardSnapshot {
  const rows = [...runs]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    .map((run) => dashboardRun(run, sources));
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      runs: rows.length,
      inFlight: rows.filter((row) => row.inFlight).length,
      awaitingUser: rows.filter((row) => row.status === "awaiting_user").length,
      settled: rows.filter((row) => ["completed", "failed", "cancelled"].includes(row.status)).length,
      artifacts: rows.reduce((sum, row) => sum + row.artifacts.length, 0),
    },
    runs: rows,
  };
}

const GLYPH: Readonly<Record<string, string>> = {
  draft: "·", queued: "…", running: "▶", paused: "‖", awaiting_user: "?",
  completed: "✔", failed: "✖", cancelled: "■", interrupted: "✂",
};

function refLine(ref: DynamicArtifactRef): string {
  return `  [artifact ${ref.$artifact.slice(0, 12)}… ${ref.chars} chars @${ref.nodeId}]`;
}

/** Deterministic text rendering of a snapshot, for terminals and tests. */
export function renderDashboard(snapshot: DashboardSnapshot): string {
  const lines: string[] = [];
  const totals = snapshot.totals;
  lines.push(`workflow dashboard — ${totals.runs} runs (${totals.inFlight} in flight, ${totals.awaitingUser} awaiting user, ${totals.settled} settled, ${totals.artifacts} artifacts)`);
  if (!snapshot.runs.length) lines.push("  (no runs)");
  for (const run of snapshot.runs) {
    const glyph = GLYPH[run.status] ?? "?";
    const progress = run.progress;
    lines.push(`${glyph} ${run.name} [${run.id.slice(0, 8)}] ${run.status}${run.phase === null ? "" : ` @${run.phase}`} — ${progress.completed}/${progress.total} done, ${progress.failed} failed, ${progress.awaitingUser} awaiting`);
    if (run.error !== null) lines.push(`  error: ${run.error}`);
    for (const stream of run.streams) {
      lines.push(`  ~${stream.name}#${stream.lastSeq}${stream.settled ? " (settled)" : ""}${stream.lastAt === null ? "" : ` @${stream.lastAt}`}`);
    }
    for (const artifact of run.artifacts) lines.push(refLine(artifact));
    if (run.result.kind === "artifact-ref") lines.push(refLine(run.result.ref));
    else if (run.result.kind === "elided") lines.push(`  result: (elided ${run.result.chars} chars)`);
    else if (run.result.kind === "inline") lines.push(`  result: ${JSON.stringify(run.result.value)}`);
    if (run.truncated.nodes || run.truncated.artifacts || run.truncated.streams) lines.push("  …(truncated)");
  }
  return lines.join("\n");
}
