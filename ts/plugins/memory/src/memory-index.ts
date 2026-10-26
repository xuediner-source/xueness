/**
 * F09.01 — hierarchical memory manifest/index over the curated tracks.
 *
 * `buildMemoryIndex` walks the three curated tracks (MEMORY.md / USER.md /
 * projects/<hash>/KEY.md) and turns each `\n§\n` entry into an indexed record
 * with a stable id, a traceable source (track file + entry position) and a
 * content version (sha256[:16]). The index is the manifest: `manifestOf`
 * projects it to a compact source/version summary with no bodies, so a request
 * can carry provenance without carrying every memory's text.
 *
 * `selectCandidates` reduces an index to a bounded candidate set: only entries
 * the caller's scorer ranks above zero, at most `maxEntries` of them and at
 * most `maxChars` code points of body text in total. Nothing here ever throws:
 * an unresolvable root yields `{ ok: false, failure }` and the caller falls
 * back to the whole-track loader, exactly as an unreadable track reads empty.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { pyLen } from "@xueness/contracts";
import { clip, entryBodies, pyResolve, safeRead, trackPaths, TRACK_NAMES, type TrackName } from "./memory.ts";

/** Per-entry body cap while indexing (code points, like the track budgets). */
export const INDEX_ENTRY_MAX_CHARS = 800;
/** Per-track cap on indexed entries; the long tail is unreachable by selection anyway. */
export const INDEX_TRACK_MAX_ENTRIES = 200;
/** Default selection caps: a candidate set stays a summary, not a dump. */
export const SELECT_MAX_ENTRIES = 12;
export const SELECT_MAX_CHARS = 3000;

const sha = (value: string): string => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const versionOf = (body: string): string => sha(body).slice(0, 16);

export interface IndexedMemoryEntry {
  /** Stable `track:<sha16>` id; re-indexing an unchanged entry keeps it. */
  readonly id: string;
  readonly track: TrackName;
  readonly body: string;
  readonly chars: number;
  /** Where this memory came from: the track file plus the entry's 0-based position in it. */
  readonly source: { readonly file: string; readonly entry: number };
  /** Content version: first 16 hex of sha256(body); changes iff the body changed. */
  readonly version: string;
}

export interface MemoryTrackIndex {
  readonly track: TrackName;
  readonly file: string;
  /** Stat fingerprint of the track file (`ino:size:mtimeNs`, or "missing"). */
  readonly version: string;
  readonly entries: readonly IndexedMemoryEntry[];
}

export interface MemoryIndex {
  readonly root: string;
  readonly cwd: string;
  /** Fingerprint of all three track files; differs iff any track changed on disk. */
  readonly version: string;
  readonly tracks: Readonly<Record<TrackName, MemoryTrackIndex>>;
  /** Every indexed entry, track order then entry position (deterministic). */
  readonly entries: readonly IndexedMemoryEntry[];
  readonly generatedAt: string;
  /** False only when the root itself cannot be resolved/stat-ed; tracks that read empty are not failures. */
  readonly ok: boolean;
  readonly failure: string | null;
}

/** Stat fingerprint of one file, Python-side stable across reads; "missing" when absent. */
export function fileVersion(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return "missing";
  }
}

/** Cheap staleness probe: the combined fingerprint, without reading any body. */
export function indexVersion(memoryRoot: string, cwd: string): string {
  const root = pyResolve(String(memoryRoot));
  return TRACK_NAMES.map((track) => `${track}=${fileVersion(trackPaths(root, String(cwd))[track])}`).join("|");
}

/**
 * True when the on-disk stat fingerprint no longer matches the indexed one
 * (incremental refresh trigger). Only the per-track stat versions are compared
 * — `index.version` additionally folds in entry counts/hashes, so comparing
 * against it directly would flag every probe stale.
 */
export function indexStale(index: MemoryIndex, memoryRoot: string): boolean {
  const onDisk = indexVersion(memoryRoot, index.cwd);
  const indexed = TRACK_NAMES.map((track) => `${track}=${index.tracks[track].version}`).join("|");
  return onDisk !== indexed;
}

/**
 * Build the index for one project. Entry bodies reuse the loader's head
 * stripping (ids, dates, git/branch prefixes, frontmatter), so what is indexed
 * is exactly what the whole-track render would have shown.
 */
export function buildMemoryIndex(memoryRoot: string, cwd: string): MemoryIndex {
  const generatedAt = new Date().toISOString();
  let root: string;
  try {
    root = pyResolve(String(memoryRoot));
    statSync(root);
  } catch (error) {
    const tracks = emptyTracks(String(memoryRoot), String(cwd));
    return {
      root: String(memoryRoot), cwd: String(cwd), version: fingerprint(tracks),
      tracks, entries: [], generatedAt,
      ok: false, failure: `memory root is unavailable: ${(error as Error).message}`,
    };
  }
  const paths = trackPaths(root, String(cwd));
  const tracks = {} as Record<TrackName, MemoryTrackIndex>;
  const entries: IndexedMemoryEntry[] = [];
  for (const track of TRACK_NAMES) {
    const file = paths[track];
    const bodies = entryBodies(safeRead(file, root)).slice(0, INDEX_TRACK_MAX_ENTRIES);
    const indexed = bodies.map((body, entry) => {
      const clipped = clip(body, INDEX_ENTRY_MAX_CHARS);
      const record: IndexedMemoryEntry = {
        id: `${track}:${sha(clipped).slice(0, 16)}`, track, body: clipped, chars: pyLen(clipped),
        source: { file, entry }, version: versionOf(clipped),
      };
      return record;
    });
    tracks[track] = { track, file, version: fileVersion(file), entries: indexed };
    entries.push(...indexed);
  }
  return { root, cwd: String(cwd), version: fingerprint(tracks), tracks, entries, generatedAt, ok: true, failure: null };
}

function emptyTracks(root: string, cwd: string): Record<TrackName, MemoryTrackIndex> {
  const paths = trackPaths(pyResolve(root), cwd);
  const tracks = {} as Record<TrackName, MemoryTrackIndex>;
  for (const track of TRACK_NAMES) {
    const file = paths[track];
    tracks[track] = { track, file, version: fileVersion(file), entries: [] };
  }
  return tracks;
}

const fingerprint = (tracks: Readonly<Record<TrackName, MemoryTrackIndex>>): string =>
  TRACK_NAMES.map((track) => `${track}=${tracks[track].version}:${tracks[track].entries.length}:${tracks[track].entries.at(-1)?.version ?? ""}`).join("|");

export interface SelectionLimits { maxEntries?: number; maxChars?: number }

export interface MemoryCandidate {
  readonly entry: IndexedMemoryEntry;
  readonly score: number;
}

/**
 * Reduce an index to a bounded candidate set. Entries with `score(entry) <= 0`
 * are irrelevant and dropped; the rest are ranked (score desc, then id asc for
 * determinism) and cut at `maxEntries` (default 12) and `maxChars` total body
 * code points (default 3000). Each candidate keeps its entry's source and
 * version, so whatever is selected stays traceable to its track file.
 */
export function selectCandidates(index: MemoryIndex, score: (entry: IndexedMemoryEntry) => number, limits: SelectionLimits = {}): MemoryCandidate[] {
  const maxEntries = limits.maxEntries ?? SELECT_MAX_ENTRIES;
  const maxChars = limits.maxChars ?? SELECT_MAX_CHARS;
  const ranked = index.entries
    .map((entry): MemoryCandidate => ({ entry, score: score(entry) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0));
  const selected: MemoryCandidate[] = [];
  let chars = 0;
  for (const candidate of ranked) {
    // Both caps are hard: a candidate that does not fit the remaining body
    // budget is skipped, never admitted as an over-budget first hit.
    if (selected.length >= maxEntries || chars + candidate.entry.chars > maxChars) continue;
    selected.push(candidate);
    chars += candidate.entry.chars;
  }
  return selected;
}

export interface TrackManifest {
  readonly track: TrackName;
  readonly file: string;
  readonly version: string;
  readonly entries: number;
  readonly chars: number;
}

export interface MemoryManifest {
  readonly root: string;
  readonly cwd: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly failure: string | null;
  readonly totalEntries: number;
  readonly tracks: readonly TrackManifest[];
}

/** Provenance-only projection of an index: sources, versions and sizes, never bodies. */
export function manifestOf(index: MemoryIndex): MemoryManifest {
  return {
    root: index.root, cwd: index.cwd, version: index.version, generatedAt: index.generatedAt,
    ok: index.ok, failure: index.failure, totalEntries: index.entries.length,
    tracks: TRACK_NAMES.map((track) => {
      const view = index.tracks[track];
      return { track, file: view.file, version: view.version, entries: view.entries.length, chars: view.entries.reduce((sum, entry) => sum + entry.chars, 0) };
    }),
  };
}
