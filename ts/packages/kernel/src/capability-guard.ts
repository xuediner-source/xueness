/**
 * Run-time enforcement of granted capabilities.
 *
 * Every power the kernel hands out (paths, processes, listening sockets,
 * requests, secrets) is checked here first. Guards nest: a narrowed guard
 * also asks its parent, so a context can only ever lose powers.
 */
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  allCapabilities, hostAllowed, listenAllowed, missingGrants, normalizeCapabilities, programAllowed, programName, secretAllowed,
  type Capabilities, type CapabilityDeclaration, type FsRoot,
} from "@xueness/contracts";

export interface FsRootPaths {
  /** Workspace roots the user opened. */
  workspace: readonly string[];
  /** Xueness data directory (sessions, settings, command output); none means no "state" root. */
  state?: string | null;
  temp?: string;
  home?: string;
}

export class CapabilityDeniedError extends Error {
  override name = "CapabilityDeniedError";
  readonly code = "capability_denied";
  readonly owner: string;
  readonly capability: string;

  constructor(owner: string, capability: string, subject = "") {
    super(`${owner} is not granted ${capability}${subject ? ` (${subject})` : ""}`);
    this.owner = owner;
    this.capability = capability;
  }
}

/** Normalised capabilities are also declarations, so both forms are accepted. */
function normalized(value: CapabilityDeclaration | Capabilities): Capabilities {
  return normalizeCapabilities(value);
}

/** Real path of the deepest existing ancestor joined with the missing rest (symlinks cannot escape a root). */
function realish(path: string): string {
  const missing: string[] = [];
  for (let current = path; ;) {
    try {
      const real = realpathSync.native(current);
      return missing.length ? resolve(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rootPaths(root: FsRoot, roots: FsRootPaths): readonly string[] {
  switch (root) {
    case "workspace": return roots.workspace;
    case "state": return roots.state ? [roots.state] : [];
    case "temp": return [roots.temp ?? tmpdir()];
    case "home": return [roots.home ?? homedir()];
    default: return [];
  }
}

export class CapabilityGuard {
  readonly owner: string;
  readonly capabilities: Capabilities;
  readonly #parent: CapabilityGuard | null;
  readonly #roots: () => FsRootPaths;

  private constructor(owner: string, capabilities: Capabilities, roots: () => FsRootPaths, parent: CapabilityGuard | null) {
    this.owner = owner;
    this.capabilities = capabilities;
    this.#roots = roots;
    this.#parent = parent;
  }

  /** The kernel's own guard: every power, with these file roots. */
  static root(roots: FsRootPaths | (() => FsRootPaths) = { workspace: [process.cwd()] }): CapabilityGuard {
    return new CapabilityGuard("kernel", allCapabilities(), typeof roots === "function" ? roots : () => roots, null);
  }

  /** A guard that allows only what both this guard and `capabilities` allow. */
  narrow(owner: string, capabilities: CapabilityDeclaration | Capabilities): CapabilityGuard {
    return new CapabilityGuard(owner, normalized(capabilities), this.#roots, this);
  }

  get roots(): FsRootPaths {
    return this.#roots();
  }

  /** Powers of `requirement` that this guard or an ancestor does not grant, as tokens. */
  missing(requirement: CapabilityDeclaration | Capabilities): string[] {
    const wanted = normalized(requirement);
    const own = missingGrants(wanted, this.capabilities);
    return [...new Set([...(this.#parent?.missing(wanted) ?? []), ...own])];
  }

  /** Resolve `path` (symlinks included) and require `mode` access to a root containing it. */
  path(mode: "read" | "write", path: string): string {
    if (typeof path !== "string" || !path || path.includes("\0")) throw new TypeError("invalid path");
    const absolute = realish(resolve(path));
    this.#checkPath(mode, absolute, path);
    return absolute;
  }

  program(file: string): void {
    this.#parent?.program(file);
    if (!programAllowed(this.capabilities, file)) throw new CapabilityDeniedError(this.owner, "exec", programName(file));
  }

  connect(host: string, port: number): void {
    this.#parent?.connect(host, port);
    if (!hostAllowed(this.capabilities, host, port)) throw new CapabilityDeniedError(this.owner, "net.connect", `${host}:${port}`);
  }

  listen(host: string): void {
    this.#parent?.listen(host);
    if (!listenAllowed(this.capabilities, host)) throw new CapabilityDeniedError(this.owner, "net.listen", host);
  }

  secret(name: string): void {
    this.#parent?.secret(name);
    if (!secretAllowed(this.capabilities, name)) throw new CapabilityDeniedError(this.owner, "secrets", name);
  }

  #checkPath(mode: "read" | "write", absolute: string, shown: string): void {
    if (this.#parent) this.#parent.#checkPath(mode, absolute, shown);
    const granted = mode === "write" ? this.capabilities.fs.write : this.capabilities.fs.read;
    if (granted.includes("any")) return;
    const roots = this.#roots();
    for (const root of granted) {
      if (rootPaths(root, roots).some((base) => inside(realish(resolve(base)), absolute))) return;
    }
    throw new CapabilityDeniedError(this.owner, `fs.${mode}`, shown);
  }
}
