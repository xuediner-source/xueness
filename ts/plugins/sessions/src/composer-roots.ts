/**
 * Composer request scope (Python `composer_api` helpers): permitted workspace
 * roots, bounded session snapshots, printable labels and the directories the
 * file catalogue and selections never cross.
 */
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pyCasefold, pyLen, pySlice, pyStrip, PyValueError } from "@xueness/contracts";
import { realish, type Session, type SessionStore } from "@xueness/sessions";
import { AttachmentFiles } from "./attachment-fs.ts";

export class ComposerError extends PyValueError {
  override name = "ComposerError";
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const SID_RE = /^[0-9a-f]{32}$/;
export const IGNORED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".state", ".web-runs"]);

export interface ComposerScope {
  store: SessionStore;
  stateDir: string;
  webRuns: string;
  projectDir: string;
  enabled(id: string): boolean;
  /** `workspaces_api.allowed_roots`: canonical permitted bases. */
  allowedRoots(): readonly string[];
  /** `workspaces_api.get_default_root`; throws when none is usable. */
  defaultRoot(): string;
  /** `Path.expanduser`, as the settings plugin applies it. */
  expandUser?(path: string): string;
}

export function requireEnabled(o: Pick<ComposerScope, "enabled">, id: string): void {
  if (!o.enabled(id)) throw new ComposerError(403, "plugin disabled or dependency unavailable: " + id);
}
/** `Path.is_relative_to` on canonical paths. */
export function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
export const parts = (base: string, target: string): string[] => relative(base, target).split(sep).filter(Boolean);
export const isolatedRoots = (o: Pick<ComposerScope, "webRuns">): string[] => [realish(o.webRuns), realish("/tmp")];
const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** `_safe_label`: printable, stripped and bounded, else the fallback. */
export function safeLabel(value: unknown, fallback: string, limit = 160): string {
  const text = [...pyStrip(typeof value === "string" ? value : fallback)].filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127).join("");
  return pySlice(text, limit) || pySlice(fallback, limit);
}
/** `_one_query`: `parse_qs` drops blank values; the first remaining one. */
export function oneQuery(query: Record<string, unknown>, key: string): string | null {
  const values = Object.hasOwn(query, key) ? query[key] : null;
  if (Array.isArray(values)) return values.find((value) => typeof value === "string" && value !== "") ?? null;
  return typeof values === "string" && values ? values : null;
}

/** `_resolve_root`: an absolute, canonical directory inside a permitted base. */
export function resolveRoot(o: ComposerScope, value: unknown, requireDirectory = true): string {
  const denied = (): ComposerError => new ComposerError(400, "workspace root not permitted");
  if (typeof value !== "string" || !value || pyLen(value) > 4096) throw denied();
  const candidate = o.expandUser ? o.expandUser(value) : value;
  if (!isAbsolute(candidate) || candidate.includes("\0")) throw denied();
  let resolved: string;
  try { resolved = realish(candidate); } catch { throw denied(); }
  if (!o.allowedRoots().some((base) => within(realish(base), resolved))) throw denied();
  if (requireDirectory && !isDirectory(resolved)) throw denied();
  return resolved;
}

/** `_read_session`: a bounded, non-link snapshot whose id matches, else `null`. */
export function readSession(o: ComposerScope, sid: unknown): Session | null {
  if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
  return new AttachmentFiles({ store: o.store, stateDir: o.stateDir, webRuns: o.webRuns, projectDir: o.projectDir, enabled: o.enabled }).session(sid);
}

/** `_request_root`: the session's root, an explicit root, or the default root. */
export function requestRoot(o: ComposerScope, value: unknown, sid: unknown): string {
  if (sid !== null && sid !== undefined) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) throw new ComposerError(404, "session not found");
    const session = readSession(o, sid);
    if (!session || typeof session.root !== "string") throw new ComposerError(404, "session not found");
    return resolveRoot(o, session.root);
  }
  if (value !== null && value !== undefined) return resolveRoot(o, value);
  try { return resolveRoot(o, o.defaultRoot()); } catch { throw new ComposerError(400, "workspace root not permitted"); }
}

export const hasIgnoredComponent = (names: readonly string[]): boolean => names.some((name) => IGNORED_DIRS.has(pyCasefold(name)));
/** `_root_crosses_ignored_directory`: the root itself sits under an ignored directory of a base. */
export function rootCrossesIgnored(o: ComposerScope, root: string): boolean {
  return o.allowedRoots().some((base) => within(base, root) && hasIgnoredComponent(parts(base, root)));
}
/** `_ignored_file_selection`: the resolved selection passes through an ignored directory. */
export function ignoredFileSelection(root: string, name: string): boolean {
  try {
    const base = realish(root), target = realish(resolve(base, name));
    return within(base, target) && hasIgnoredComponent(parts(base, target));
  } catch { return false; }
}
