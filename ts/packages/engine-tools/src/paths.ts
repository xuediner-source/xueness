/**
 * Workspace path policy. Tool paths resolve against the working directory
 * and must stay inside one of the workspace roots, symlinks included.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const fullAccessRoots = new WeakSet<readonly string[]>();
/** A host-issued capability; JSON and workspace configuration cannot forge it. */
export function unrestrictedWorkspaceRoots(roots: readonly string[]): readonly string[] {
  const scope = [...roots]; fullAccessRoots.add(scope); return scope;
}
export function hasUnrestrictedWorkspaceAccess(roots: readonly string[]): boolean { return fullAccessRoots.has(roots); }

export class PathOutsideWorkspaceError extends Error {
  override name = "PathOutsideWorkspaceError";
  readonly code = "path_outside_workspace";
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Real path of the deepest existing ancestor joined with the missing rest. */
async function realish(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? resolve(real, ...missing.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** Absolute real path used for I/O. */
  absolute: string;
  /** Path relative to the containing root, with forward slashes, for display. */
  display: string;
}

export async function resolveWorkspacePath(input: string, cwd: string, roots: readonly string[]): Promise<ResolvedPath> {
  if (typeof input !== "string" || !input.trim()) throw new TypeError("path is required");
  if (input.includes("\0")) throw new TypeError("invalid path: contains NUL");
  const absolute = await realish(resolve(cwd, input));
  for (const root of roots) {
    const realRoot = await realish(resolve(root));
    if (within(realRoot, absolute)) {
      return { absolute, display: relative(realRoot, absolute).split(sep).join("/") || "." };
    }
  }
  if (fullAccessRoots.has(roots)) return { absolute, display: absolute };
  throw new PathOutsideWorkspaceError(`path is outside the workspace: ${input}`);
}
