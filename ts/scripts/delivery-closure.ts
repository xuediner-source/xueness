/**
 * F14.05: close the discrepancy ledger (docs/audits/20261024/gap-register.json)
 * and verify the complete delivery. Production gate, not a report generator
 * only: it refuses to count an item as complete while its status still carries
 * pending/open/external markers, requires every counted item to reference
 * evidence that exists on disk, and re-derives the delivery manifest from the
 * working tree so the published tree and complete-project-manifest.json agree.
 *
 *   node ts/scripts/delivery-closure.ts [--root <dir>] [--write <report.json>]
 *
 * Exit 0 when every gate holds; exit 1 with a violation list otherwise.
 * The report path (when --write points inside the root) is excluded from the
 * manifest consistency scan for the same reason the manifest excludes itself.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compare, scan, type ManifestFile } from "./project-manifest.ts";

export const CLOSURE_SCHEMA = "xueness.delivery-closure.v1";
export const REPORT_BASENAME = "delivery-closure-report.json";
const LEDGER_REL = "docs/audits/20261024/gap-register.json";
const MANIFEST_REL = "complete-project-manifest.json";
/** Status words that keep an item out of the completed column; ledger verdicts must stay conservative. */
const PENDING_WORDS = ["pending", "external", "unverified", "deferred", "blocked", "waiting"];
const OPEN_WORDS = ["open", "todo", "planned", "not_started"];

export interface LedgerItem {
  id: string;
  rounds?: string;
  evidence?: string;
  status?: string;
  [key: string]: unknown;
}

export type Verdict = "complete" | "external_pending" | "open";

/** Complete only for an explicit `closed…` or `aligned` status with no pending/open qualifier left in it. */
export function verdictFromStatus(status: string | undefined): Verdict {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "open";
  const pending = PENDING_WORDS.some((word) => s.includes(word));
  const open = OPEN_WORDS.some((word) => s.includes(word));
  if (pending) return "external_pending";
  if (open) return "open";
  return s.startsWith("closed") || s.includes("aligned") ? "complete" : "open";
}

/** Split the ledger's `；`/`;`/` + `-separated evidence field into trimmed references. */
export function splitEvidence(evidence: string | undefined): string[] {
  return (evidence ?? "").split(/[；;]|\s\+\s/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Strip `path:line`/`path:line:col` anchors so evidence refs can be resolved on disk. */
export function evidencePath(ref: string): string {
  return ref.replace(/:[0-9]+(?::[0-9]+)?$/, "").trim();
}

export interface EvidenceCheck {
  id: string;
  verdict: Verdict;
  evidenceRefs: string[];
  missingEvidence: string[];
  /** True when status language claims closure but evidence cannot be located — the F14.05 hard violation. */
  countedWithoutEvidence: boolean;
}

/**
 * Resolve one evidence reference against the repo root. Ledger refs are either
 * root-relative (F*.md result files, ts/ sources), bare audit filenames that
 * live next to the ledger, or — after a `src + test` pair — relative to the
 * directory of the reference resolved just before them.
 */
export function evidenceExists(ref: string, root: string, ledgerDir: string, hintDirs: readonly string[] = []): boolean {
  const rel = evidencePath(ref);
  if (!rel || rel.includes("://")) return false;
  // Evidence must be a real file: a directory (or a dangling path) proves nothing about closure.
  const isFile = (path: string): boolean => {
    try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
  };
  if (isFile(join(root, rel)) || isFile(join(ledgerDir, rel))) return true;
  return hintDirs.some((dir) => isFile(join(dir, rel)));
}

/** Directory hints propagated from already-resolved refs, so `src + test` pairs both resolve. */
export function resolveEvidenceDirs(refs: readonly string[], root: string, ledgerDir: string): string[] {
  const hints: string[] = [];
  for (const ref of refs) {
    const rel = evidencePath(ref);
    if (!rel || rel.includes("://")) continue;
    const base = existsSync(join(root, rel)) ? join(root, rel) : existsSync(join(ledgerDir, rel)) ? join(ledgerDir, rel) : undefined;
    if (base) { hints.push(join(base, ".."), join(base, "..", "..")); }
  }
  return hints;
}

/** Close the ledger: verdict per item plus the "counted complete without evidence" violation list. */
export function closeLedger(items: readonly LedgerItem[], root: string, ledgerDir: string): {
  checks: EvidenceCheck[];
  violations: string[];
} {
  const checks: EvidenceCheck[] = [];
  const violations: string[] = [];
  for (const item of items) {
    const refs = splitEvidence(item.evidence);
    const hints = resolveEvidenceDirs(refs, root, ledgerDir);
    const missing = refs.filter((ref) => !evidenceExists(ref, root, ledgerDir, hints));
    const verdict = verdictFromStatus(item.status);
    const countedWithoutEvidence = verdict === "complete" && (refs.length === 0 || missing.length > 0);
    if (countedWithoutEvidence) {
      violations.push(`${item.id}: status "${item.status}" counts as complete but evidence missing: ${missing.length ? missing.join(", ") : "(none referenced)"}`);
    }
    checks.push({ id: item.id, verdict, evidenceRefs: refs, missingEvidence: missing, countedWithoutEvidence });
  }
  return { checks, violations };
}

export interface ManifestCheck {
  consistent: boolean;
  changed: string[];
  added: string[];
  removed: string[];
  manifestCount: number;
  treeCount: number;
}

/**
 * GitHub-tree ↔ delivery-manifest consistency: rescan the tree with the
 * manifest's own exclusions (plus the closure report) and demand zero drift.
 */
export function checkManifest(root: string, extraExclusions: readonly string[] = []): ManifestCheck {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_REL), "utf8"));
  const exclusions = [...manifest.exclusions, ...extraExclusions];
  const tree = scan(root, exclusions);
  /** The closure report is excluded from both sides, so folding it into the manifest later cannot fake drift. */
  const tracked = (manifest.files as ManifestFile[]).filter((file) => !extraExclusions.includes(file.path));
  const { changed, added, removed } = compare(tracked, tree);
  return {
    consistent: changed.length === 0 && added.length === 0 && removed.length === 0,
    changed, added, removed,
    manifestCount: tracked.length,
    treeCount: tree.length,
  };
}

/** SHA-256 checksums of the delivery artifacts the handover pins. */
export function checksums(root: string, relPaths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of relPaths) {
    const bytes = readFileSync(join(root, rel));
    out[rel] = createHash("sha256").update(bytes).digest("hex");
  }
  return out;
}

export const CHECKSUM_ARTIFACTS = [
  MANIFEST_REL,
  LEDGER_REL,
  "docs/audits/20261024/public-capability-contracts.json",
  "docs/audits/20261024/upstream-engine-delta.json",
  "docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.json",
  "ts/package.json",
  "README.md",
];

export interface ClosureReport {
  schema: string;
  task: string;
  date: string;
  ledger: {
    total: number;
    complete: number;
    externalPending: number;
    open: number;
    items: EvidenceCheck[];
  };
  /** 外部待决：never counted as complete; each entry keeps its rounds for the handover. */
  remainingExternal: Array<{ id: string; rounds: string; status: string }>;
  ledgerViolations: string[];
  manifest: ManifestCheck;
  checksums: Record<string, string>;
  gates: { ledgerEvidence: boolean; manifestConsistency: boolean; noExternalCountedComplete: boolean };
  pass: boolean;
}

export function buildClosureReport(root: string, now = new Date()): ClosureReport {
  const ledger = JSON.parse(readFileSync(join(root, LEDGER_REL), "utf8"));
  const ledgerDir = join(root, LEDGER_REL, "..");
  const items = ledger.items as LedgerItem[];
  const { checks, violations } = closeLedger(items, root, ledgerDir);
  const manifest = checkManifest(root, [REPORT_BASENAME]);
  const remainingExternal = items
    .map((item, index) => ({ item, verdict: checks[index]!.verdict }))
    .filter(({ verdict }) => verdict !== "complete")
    .map(({ item, verdict }) => ({ id: item.id, rounds: item.rounds ?? "", status: `${item.status ?? ""} [${verdict}]`.trim() }));
  const externalCountedComplete = checks.filter((check) => check.verdict !== "complete" && check.countedWithoutEvidence).length;
  const gates = {
    ledgerEvidence: violations.length === 0,
    manifestConsistency: manifest.consistent,
    noExternalCountedComplete: externalCountedComplete === 0,
  };
  return {
    schema: CLOSURE_SCHEMA,
    task: "F14.05",
    date: now.toISOString().slice(0, 10),
    ledger: {
      total: checks.length,
      complete: checks.filter((check) => check.verdict === "complete").length,
      externalPending: checks.filter((check) => check.verdict === "external_pending").length,
      open: checks.filter((check) => check.verdict === "open").length,
      items: checks,
    },
    remainingExternal,
    ledgerViolations: violations,
    manifest,
    checksums: checksums(root, CHECKSUM_ARTIFACTS),
    gates,
    pass: gates.ledgerEvidence && gates.manifestConsistency && gates.noExternalCountedComplete,
  };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { root: { type: "string" }, write: { type: "string" } } });
  const root = values.root ?? join(import.meta.dirname, "..", "..");
  const report = buildClosureReport(root);
  const summary = [
    `ledger: ${report.ledger.total} items — ${report.ledger.complete} complete, ${report.ledger.externalPending} external_pending, ${report.ledger.open} open`,
    `remaining external/pending (never counted complete): ${report.remainingExternal.map((item) => item.id).join(", ") || "(none)"}`,
    `manifest: ${report.manifest.consistent ? "consistent" : "DRIFT"} (changed ${report.manifest.changed.length}, added ${report.manifest.added.length}, removed ${report.manifest.removed.length})`,
    `gates: ledgerEvidence=${report.gates.ledgerEvidence} manifestConsistency=${report.gates.manifestConsistency} noExternalCountedComplete=${report.gates.noExternalCountedComplete}`,
  ];
  for (const line of summary) console.log(line);
  for (const violation of report.ledgerViolations) console.log(`  VIOLATION ${violation}`);
  for (const drift of [...report.manifest.changed, ...report.manifest.added, ...report.manifest.removed].slice(0, 20)) console.log(`  DRIFT ${drift}`);
  const body = JSON.stringify(report, null, 2) + "\n";
  if (values.write) {
    writeFileSync(values.write, body);
    console.log(`written ${values.write}`);
  } else console.log(body);
  if (!report.pass) process.exit(1);
}
