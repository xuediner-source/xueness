/**
 * F09.02 — selective pre-turn recall over the F09.01 manifest.
 *
 * `createMemoryRecall(memoryRoot, cwd)` owns one index and answers one question
 * per turn — "which stored memories are relevant to this query?" — without ever
 * putting the whole store into the request:
 *
 *  - turn 前 recall: `recall(query)` is called before the turn runs and returns
 *    only what the lexical scorer ranks relevant (`relevanceScorer`), bounded by
 *    the manifest's selection caps;
 *  - incremental refresh: each call stat-probes the track files first
 *    (`indexStale`) and rebuilds only when a track actually changed on disk;
 *  - explicit fallback: when the index cannot be built at all (`ok: false`),
 *    recall degrades to the whole-track loader (`loadMemory`) and reports the
 *    failure — it never throws, so an index problem can never interrupt the
 *    user's task.
 *
 * Every selected candidate carries its entry's `[track #n @version]`
 * provenance, so a hit is always traceable back to its track file; `manifest`
 * rides along as the source/version summary without any bodies.
 */
import { loadMemory, pyResolve, UNTRUSTED_PREAMBLE } from "./memory.ts";
import {
  buildMemoryIndex, indexStale, manifestOf, selectCandidates,
  type IndexedMemoryEntry, type MemoryCandidate, type MemoryIndex, type MemoryManifest,
} from "./memory-index.ts";
import type { SelectionLimits } from "./memory-index.ts";

/** Header of the selective recall block (the whole-track loader keeps its own). */
export const RECALL_HEADER = "## Relevant cross-session memories (selected by index)";
/** Provenance tag appended to every recalled body: `[<track> #<entry> @<version>]`. */
export const RECALL_TAG = (candidate: MemoryCandidate): string =>
  `[${candidate.entry.track} #${candidate.entry.source.entry} @${candidate.entry.version}]`;

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Query/entry tokens: Unicode letter-or-number runs, case-folded. */
export function tokenize(text: string): string[] {
  return String(text).toLowerCase().match(TOKEN) ?? [];
}

/**
 * Lexical relevance over indexed entries: the score is the number of distinct
 * query tokens present in the entry, so covering more of the query always
 * outranks repeating one term, and ties fall through to `selectCandidates`'s
 * id ordering. No token overlap means score 0 — the entry is irrelevant and
 * never selected.
 */
export function relevanceScorer(query: string): (entry: IndexedMemoryEntry) => number {
  const wanted = tokenize(query);
  return (entry) => {
    const present = new Set(tokenize(entry.body));
    let score = 0;
    for (const token of wanted) if (present.has(token)) score += 1;
    return score;
  };
}

export type MemoryRecallMode = "selective" | "fallback" | "none";

export interface MemoryRecallResult {
  /** `selective`: index hits; `fallback`: index failed, whole track loaded; `none`: nothing relevant. */
  readonly mode: MemoryRecallMode;
  /** Ready-to-inject block (untrusted preamble + bullets); "" in `none` mode, so nothing irrelevant is resident. */
  readonly text: string;
  readonly candidates: readonly MemoryCandidate[];
  /** Source/version summary of the index this recall used; bodies never ride along. */
  readonly manifest: MemoryManifest;
  /** True when this call detected a stale fingerprint and rebuilt the index. */
  readonly refreshed: boolean;
  /** The index failure that forced `fallback`; null otherwise. */
  readonly failure: string | null;
}

export interface MemoryRecall extends SelectionLimits {
  /** Pre-turn recall for one query; never throws. */
  recall(query: string): MemoryRecallResult;
  /** True when the on-disk fingerprint no longer matches the cached index. */
  stale(): boolean;
  /** The cached index as of the last recall (the next recall refreshes lazily). */
  snapshot(): MemoryIndex;
}

/** Bullets for the selected candidates, each closed by its provenance tag. */
export function renderRecall(candidates: readonly MemoryCandidate[], manifest: MemoryManifest): string {
  if (!candidates.length) return "";
  const head = `${RECALL_HEADER}\n${candidates.length} of ${manifest.totalEntries} indexed entries (index ${manifest.version.slice(0, 24)}…).`;
  const bullets = candidates.map((candidate) => {
    const body = candidate.entry.body.replace(/\n+/gu, "\n  ");
    return `- ${body}\n  ${RECALL_TAG(candidate)}`;
  });
  return [head, ...bullets].join("\n");
}

/**
 * One recall engine per project (`cwd` fixes the key track). The first recall
 * builds the index; later ones stat-probe and rebuild only on change.
 */
export function createMemoryRecall(memoryRoot: string, cwd: string, limits: SelectionLimits = {}): MemoryRecall {
  const root = pyResolve(String(memoryRoot));
  let index = buildMemoryIndex(root, String(cwd));
  return {
    snapshot: () => index,
    stale: () => indexStale(index, root),
    recall(query: string): MemoryRecallResult {
      let refreshed = false;
      if (indexStale(index, root)) { index = buildMemoryIndex(root, String(cwd)); refreshed = true; }
      const manifest = manifestOf(index);
      if (!index.ok) {
        const text = loadMemory(root, String(cwd));
        return { mode: text ? "fallback" : "none", text, candidates: [], manifest, refreshed, failure: index.failure };
      }
      const candidates = selectCandidates(index, relevanceScorer(query), limits);
      if (!candidates.length) return { mode: "none", text: "", candidates, manifest, refreshed, failure: null };
      return { mode: "selective", text: `${UNTRUSTED_PREAMBLE}\n\n${renderRecall(candidates, manifest)}`, candidates, manifest, refreshed, failure: null };
    },
  };
}
