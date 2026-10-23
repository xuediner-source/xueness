/**
 * Workspace walk shared by glob and grep.
 *
 * Breadth-first with a moving head index (no O(n) queue shifts), entries
 * sorted per directory, .gitignore / .ignore / .git/info/exclude honoured at
 * every level (plus .gitignore files above the root up to the repository
 * top), VCS and dependency directories skipped, symlinked directories never
 * followed, and an entry budget so a huge tree cannot stall a turn.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IgnoreMatcher, parseIgnoreFile, type IgnoreRule } from "./ignore.ts";

/** Never useful to search: version-control internals. */
export const VCS_DIRS: ReadonlySet<string> = new Set([".git", ".hg", ".svn"]);
/** Skipped below the walk root unless the caller opts out. */
export const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "__pycache__", ".venv", "venv", ".xueness", ".mypy_cache", ".pytest_cache", ".tox", ".ruff_cache",
]);
export const WALK_MAX_ENTRIES = 200_000;
const ANCESTOR_LIMIT = 64;

export interface WalkFile {
  /** Path relative to the walk root, with forward slashes. */
  path: string;
  absolute: string;
}

export interface WalkOptions {
  /** Honour .gitignore, .ignore and .git/info/exclude (default true). */
  respectIgnore?: boolean;
  /** Skip DEFAULT_EXCLUDED_DIRS below the root (default true). */
  skipDefaultExcludes?: boolean;
  maxEntries?: number;
  signal?: AbortSignal;
}

export interface WalkResult {
  files: WalkFile[];
  /** True when the entry budget ran out before the walk finished. */
  truncated: boolean;
  visitedEntries: number;
}

async function readRules(path: string): Promise<IgnoreRule[]> {
  try {
    return parseIgnoreFile(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function directoryRules(dir: string, hasGitDir: boolean): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  if (hasGitDir) rules.push(...await readRules(join(dir, ".git", "info", "exclude")));
  rules.push(...await readRules(join(dir, ".gitignore")));
  rules.push(...await readRules(join(dir, ".ignore")));
  return rules;
}

/** Rules from directories above `root`, up to the enclosing repository top. */
async function ancestorMatcher(root: string): Promise<IgnoreMatcher> {
  const chain: string[] = [];
  let current = root;
  for (let depth = 0; depth < ANCESTOR_LIMIT; depth += 1) {
    if (await exists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) return new IgnoreMatcher();
    chain.push(basename(current));
    current = parent;
    if (depth === ANCESTOR_LIMIT - 1) return new IgnoreMatcher();
  }
  if (!chain.length) return new IgnoreMatcher();
  let matcher = new IgnoreMatcher();
  let dir = current;
  for (let index = chain.length; index > 0; index -= 1) {
    const prefix = chain.slice(0, index).reverse().join("/");
    const rules = await directoryRules(dir, dir === current && await isDirectory(join(dir, ".git")));
    matcher = matcher.withAncestor(prefix, rules);
    dir = join(dir, chain[index - 1] as string);
  }
  return matcher;
}

function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

interface Pending {
  dir: string;
  rel: string;
  matcher: IgnoreMatcher;
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const respect = options.respectIgnore ?? true;
  const skipDefault = options.skipDefaultExcludes ?? true;
  const budget = options.maxEntries ?? WALK_MAX_ENTRIES;
  let queue: Pending[] = [{ dir: root, rel: "", matcher: respect ? await ancestorMatcher(root) : new IgnoreMatcher() }];
  const files: WalkFile[] = [];
  let visited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    options.signal?.throwIfAborted();
    if (head > 4096 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    const { dir, rel, matcher: inherited } = queue[head] as Pending;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort(byName);
    const hasGitDir = entries.some((entry) => entry.name === ".git" && entry.isDirectory());
    const matcher = respect ? inherited.with(rel, await directoryRules(dir, hasGitDir)) : inherited;
    for (const entry of entries) {
      visited += 1;
      if (visited > budget) return { files, truncated: true, visitedEntries: visited - 1 };
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      let directory = entry.isDirectory();
      let file = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(absolute).catch(() => null);
        if (!target || target.isDirectory()) continue;
        directory = false;
        file = target.isFile();
      }
      if (directory) {
        if (VCS_DIRS.has(entry.name) || (skipDefault && DEFAULT_EXCLUDED_DIRS.has(entry.name))) continue;
        if (respect && matcher.ignoresEntry(path, true)) continue;
        queue.push({ dir: absolute, rel: path, matcher });
      } else if (file) {
        if (respect && matcher.ignoresEntry(path, false)) continue;
        files.push({ path, absolute });
      }
    }
  }
  return { files, truncated: false, visitedEntries: visited };
}
