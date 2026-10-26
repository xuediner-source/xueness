/**
 * F14.01 three-platform production entry acceptance.
 *
 * Builds the Windows/Linux/macOS × cli/server/desktop/remote results matrix
 * from evidence that was actually produced on the platform it claims. The
 * two invariants this module enforces structurally:
 *
 *  1. An entry can only be `accepted` on a platform when a real build (exit
 *     code 0 plus artifacts) and at least one passing key link were recorded
 *     on that same platform — evidence from another host can never promote a
 *     cell (no extrapolating the installed Windows build to Linux/macOS).
 *  2. Anything not executed is explicitly `not_run` with a blocker; the
 *     summary carries category counts only, never pass/coverage rates.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export const ENTRY_ACCEPTANCE_SCHEMA = "xueness.entry-acceptance.v1";

export const ENTRY_PLATFORMS = ["windows", "linux", "macos"] as const;
export type EntryPlatform = (typeof ENTRY_PLATFORMS)[number];

export const PRODUCTION_ENTRIES = ["cli", "server", "desktop", "remote"] as const;
export type ProductionEntry = (typeof PRODUCTION_ENTRIES)[number];

export type EntryVerdict = "accepted" | "not_accepted" | "not_run";

const NODE_PLATFORMS: Readonly<Record<string, EntryPlatform>> = { win32: "windows", linux: "linux", darwin: "macos" };

/** Native platform of the current host, or null when it is not a supported target. */
export function entryPlatformOf(nodePlatform: NodeJS.Platform | string = platform()): EntryPlatform | null {
  return NODE_PLATFORMS[nodePlatform] ?? null;
}

export interface BuildEvidence {
  /** The command that produced the build, exactly as executed. */
  command: string;
  exitCode: number;
  artifacts: readonly string[];
  /** Platform the build actually ran on; must equal the cell platform. */
  ranOn: EntryPlatform;
}

export interface KeyLinkEvidence {
  /** Named production chain, e.g. "server boots and answers /api/health". */
  name: string;
  ok: boolean;
  detail: string;
}

/** What a probe actually observed for one (platform, entry) cell. */
export interface EntryProbe {
  build?: BuildEvidence;
  keyLinks?: readonly KeyLinkEvidence[];
  /** Why nothing was executed, when the probe never ran on that platform. */
  blocker?: string;
}

export interface EntryCellRecord {
  platform: EntryPlatform;
  entry: ProductionEntry;
  verdict: EntryVerdict;
  /** Why the verdict is what it is; always non-empty for not_accepted. */
  reasons: readonly string[];
  build?: BuildEvidence;
  keyLinks?: readonly KeyLinkEvidence[];
  /** Required for not_run: the concrete reason nothing was executed. */
  blocker?: string;
  recordedAt: string;
}

export interface EntryAcceptanceMatrix {
  schema: typeof ENTRY_ACCEPTANCE_SCHEMA;
  round: string;
  host: { platform: EntryPlatform | null; node: string };
  recordedAt: string;
  cells: readonly EntryCellRecord[];
  /** Category counts only; aggregates as rates are refused by validation. */
  summary: { accepted: number; not_accepted: number; not_run: number };
}

export class EntryAcceptanceError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid entry acceptance matrix: ${problems.join("; ")}`);
    this.name = "EntryAcceptanceError";
    this.problems = problems;
  }
}

/**
 * Turns one probe into a verdict. Absence of a probe, of build evidence, or
 * of key links is never silence: it lands in not_run/not_accepted with the
 * reason recorded.
 */
export function assessEntry(
  cellPlatform: EntryPlatform,
  entry: ProductionEntry,
  probe: EntryProbe | undefined,
  now: () => Date = () => new Date(),
): EntryCellRecord {
  const recordedAt = now().toISOString();
  if (!probe || (!probe.build && !probe.keyLinks && !probe.blocker)) {
    return { platform: cellPlatform, entry, verdict: "not_run", reasons: [], blocker: probe?.blocker ?? `no ${entry} probe executed on ${cellPlatform}`, recordedAt };
  }
  if (!probe.blocker && !probe.build) {
    return { platform: cellPlatform, entry, verdict: "not_run", reasons: [], blocker: `no build evidence for ${entry} on ${cellPlatform}`, recordedAt };
  }
  if (probe.blocker) {
    return { platform: cellPlatform, entry, verdict: "not_run", reasons: [], blocker: probe.blocker, recordedAt };
  }
  const reasons: string[] = [];
  const build = probe.build as BuildEvidence;
  if (build.exitCode !== 0) reasons.push(`build failed with exit code ${build.exitCode}`);
  if (build.artifacts.length === 0) reasons.push("build produced no artifacts");
  if (build.ranOn !== cellPlatform) reasons.push(`evidence produced on ${build.ranOn}; cross-platform evidence is not acceptance`);
  const keyLinks = probe.keyLinks ?? [];
  if (keyLinks.length === 0) reasons.push("no key-link evidence recorded");
  const failed = keyLinks.filter((link) => !link.ok).map((link) => link.name);
  if (failed.length > 0) reasons.push(`key links failed: ${failed.join(", ")}`);
  const accepted = reasons.length === 0;
  return {
    platform: cellPlatform, entry,
    verdict: accepted ? "accepted" : "not_accepted",
    reasons: accepted ? ["real build and all key links passed on this platform"] : reasons,
    build, keyLinks: keyLinks.length > 0 ? keyLinks : undefined,
    recordedAt,
  };
}

export interface EntryAcceptanceInput {
  round: string;
  /** Probes keyed by "<platform>:<entry>"; cells without a probe are not_run. */
  probes?: Readonly<Partial<Record<`${EntryPlatform}:${ProductionEntry}`, EntryProbe>>>;
  now?: () => Date;
  nodeVersion?: string;
}

/** Builds the full 12-cell matrix, validating completeness before returning. */
export function buildEntryAcceptanceMatrix(input: EntryAcceptanceInput): EntryAcceptanceMatrix {
  const now = input.now ?? (() => new Date());
  const probes = input.probes ?? {};
  const cells: EntryCellRecord[] = [];
  for (const cellPlatform of ENTRY_PLATFORMS) {
    for (const entry of PRODUCTION_ENTRIES) {
      cells.push(assessEntry(cellPlatform, entry, probes[`${cellPlatform}:${entry}`], now));
    }
  }
  const matrix: EntryAcceptanceMatrix = {
    schema: ENTRY_ACCEPTANCE_SCHEMA,
    round: input.round,
    host: { platform: entryPlatformOf(), node: input.nodeVersion ?? process.version },
    recordedAt: now().toISOString(),
    cells,
    summary: {
      accepted: cells.filter((cell) => cell.verdict === "accepted").length,
      not_accepted: cells.filter((cell) => cell.verdict === "not_accepted").length,
      not_run: cells.filter((cell) => cell.verdict === "not_run").length,
    },
  };
  const problems = validateEntryAcceptance(matrix);
  if (problems.length > 0) throw new EntryAcceptanceError(problems);
  return matrix;
}

const RATE_FIELD = /rate|coverage|percent|progress/i;

/**
 * Structural validation for a matrix (also applied to files on load):
 * complete 12-cell coverage, verdict/blocker pairing, platform-matched
 * evidence, and no aggregate-rate fields smuggled in anywhere.
 */
export function validateEntryAcceptance(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["not an object"];
  const matrix = value as Record<string, unknown>;
  if (matrix.schema !== ENTRY_ACCEPTANCE_SCHEMA) problems.push(`schema must be ${ENTRY_ACCEPTANCE_SCHEMA}`);
  if (typeof matrix.round !== "string" || matrix.round.length === 0) problems.push("round is required");
  if (typeof matrix.recordedAt !== "string" || Number.isNaN(Date.parse(matrix.recordedAt))) problems.push("recordedAt must be an ISO-8601 date");
  for (const key of Object.keys(matrix)) {
    if (RATE_FIELD.test(key)) problems.push(`aggregate-rate field ${key} is not allowed`);
  }
  if (!Array.isArray(matrix.cells)) return [...problems, "cells must be an array"];
  const summary = matrix.summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== "object") {
    problems.push("summary with category counts is required");
  } else {
    const allowed = new Set(["accepted", "not_accepted", "not_run"]);
    for (const key of Object.keys(summary)) {
      if (!allowed.has(key)) problems.push(`summary.${key} is not a category count`);
      else if (typeof summary[key] !== "number") problems.push(`summary.${key} must be a count`);
    }
    for (const key of allowed) if (!(key in summary)) problems.push(`summary.${key} is required`);
  }
  const seen = new Set<string>();
  const cells = matrix.cells as unknown[];
  for (const [index, raw] of cells.entries()) {
    const where = `cells[${index}]`;
    if (typeof raw !== "object" || raw === null) { problems.push(`${where}: not an object`); continue; }
    const cell = raw as Record<string, unknown>;
    const id = `${cell.platform}:${cell.entry}`;
    if (!(ENTRY_PLATFORMS as readonly string[]).includes(cell.platform as string)) problems.push(`${where}: unknown platform ${JSON.stringify(cell.platform)}`);
    if (!(PRODUCTION_ENTRIES as readonly string[]).includes(cell.entry as string)) problems.push(`${where}: unknown entry ${JSON.stringify(cell.entry)}`);
    if (seen.has(id)) problems.push(`${where}: duplicate cell ${id}`);
    seen.add(id);
    if (cell.verdict !== "accepted" && cell.verdict !== "not_accepted" && cell.verdict !== "not_run") problems.push(`${where}: verdict must be accepted/not_accepted/not_run`);
    if (cell.verdict === "not_run" && (typeof cell.blocker !== "string" || cell.blocker.length === 0)) problems.push(`${where}: not_run requires a blocker`);
    if (cell.verdict === "not_accepted" && (!Array.isArray(cell.reasons) || cell.reasons.length === 0)) problems.push(`${where}: not_accepted requires reasons`);
    if (cell.verdict === "accepted") {
      const build = cell.build as BuildEvidence | undefined;
      if (!build || typeof build.command !== "string" || build.command.length === 0) problems.push(`${where}: accepted requires a real build command`);
      else {
        if (build.exitCode !== 0) problems.push(`${where}: accepted but build exit code is ${build.exitCode}`);
        if (!Array.isArray(build.artifacts) || build.artifacts.length === 0) problems.push(`${where}: accepted requires build artifacts`);
        if (build.ranOn !== cell.platform) problems.push(`${where}: accepted but build ran on ${build.ranOn}`);
      }
      const links = cell.keyLinks as KeyLinkEvidence[] | undefined;
      if (!Array.isArray(links) || links.length === 0 || links.some((link) => !link.ok)) problems.push(`${where}: accepted requires passing key links`);
    }
    for (const key of Object.keys(cell)) {
      if (RATE_FIELD.test(key)) problems.push(`${where}: aggregate-rate field ${key} is not allowed`);
    }
  }
  for (const cellPlatform of ENTRY_PLATFORMS) {
    for (const entry of PRODUCTION_ENTRIES) {
      if (!seen.has(`${cellPlatform}:${entry}`)) problems.push(`missing cell ${cellPlatform}:${entry}`);
    }
  }
  // Summary counts must be derived from the cells: a hand-edited file could otherwise
  // report more `accepted` cells than it actually carries evidence for.
  if (summary && typeof summary === "object") {
    for (const verdict of ["accepted", "not_accepted", "not_run"] as const) {
      const actual = cells.filter((raw) => typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).verdict === verdict).length;
      if (typeof summary[verdict] === "number" && summary[verdict] !== actual) {
        problems.push(`summary.${verdict} is ${summary[verdict]} but ${actual} cell(s) have that verdict`);
      }
    }
  }
  return problems;
}

/** Persists a matrix under `<stateDir>/acceptance/` and refuses invalid ones. */
export function saveEntryAcceptance(matrix: EntryAcceptanceMatrix, stateDir: string): string {
  const problems = validateEntryAcceptance(matrix);
  if (problems.length > 0) throw new EntryAcceptanceError(problems);
  const directory = join(stateDir, "acceptance");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${matrix.recordedAt.slice(0, 10)}-${matrix.round}.json`);
  writeFileSync(file, `${JSON.stringify(matrix, null, 2)}\n`);
  return file;
}

/** Loads and validates a matrix file; invalid files throw instead of loading. */
export function loadEntryAcceptance(path: string): EntryAcceptanceMatrix {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`unreadable or invalid JSON: ${(error as Error).message}`);
    throw new EntryAcceptanceError(problems);
  }
  const validation = validateEntryAcceptance(parsed);
  if (validation.length > 0) throw new EntryAcceptanceError(validation);
  return parsed as EntryAcceptanceMatrix;
}
