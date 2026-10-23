/**
 * Workspace preferences and host-authorized roots: a port of Python
 * `bundled_plugins/settings/workspaces_api.py` (everything except the HTTP
 * routes and the native dialog, which live in `http-api.ts` and
 * `native-picker.ts`).
 *
 * The allowlist is the operator's roots (`XUENESS_WORKSPACE_ROOTS`,
 * `--workspace-root`), the project directory, the web-runs directory and the
 * directories a same-machine native folder chooser explicitly granted
 * (`settings.workspace.selectedRoots`). Recents and the default never widen it.
 */
import { delimiter, dirname, basename, resolve } from "node:path";
import { isDict, pyLen, pyStrip, pyTruthy, pyUtcNow, PyValueError } from "@xueness/contracts";
import { isPyValueError } from "@xueness/sessions";
import { expandUser, isAbsolutePath, isDirectory, isMount, label, purePath, resolveLoose, resolveStrict, shlexQuote, tempDir, WINDOWS, writable } from "./paths.ts";
import { loadSettings, updateSettings, type Settings } from "./store.ts";

export const MAX_RECENT = 10;
export const MAX_SELECTED_ROOTS = 100;
const SECTION = "workspace";
const SESSION_DIR = /^[0-9a-f]{32}$/u;
const WINDOWS_FIRST_LEVEL_SYSTEM_DIRS = ["Users", "ProgramData", "PerfLogs"];

/** One level listing, as `files.directory_api.list_level` returns it (injected by the host). */
export type ListLevel = (roots: readonly string[], path: string, includeHidden: boolean, maxEntries: number, includeFiles: boolean) => {
  path: string; entries: readonly { name: string; path: string; type: string; isSymbolicLink?: boolean }[]; truncated?: boolean;
};

export interface WorkspaceOptions {
  stateDir: string;
  projectDir: string;
  webRuns: string;
  /** `ctx["workspace_roots"]`: declared once at startup (see `declaredWorkspaceRoots`). */
  declaredRoots: readonly string[];
  enabled(id: string): boolean;
  listLevel: ListLevel;
  /** `ctx["max_entries"]` (`XUENESS_BROWSE_MAX_ENTRIES`, default 1000). */
  maxEntries?: number;
}

export interface WorkspaceSummary {
  defaultRoot: string;
  allowedRoots: { path: string; label: string }[];
  recentDirectories: { path: string; label: string; lastUsed: string }[];
  picker: { path: string; parent: string | null; entries: { name: string; path: string; type: string; isSymlink: boolean }[]; truncated: boolean };
}

const fsRoot = (): string => resolveLoose(WINDOWS ? "\\" : "/");
const broadTemp = (): string => resolveLoose("/tmp");
const same = (a: string, b: string): boolean => WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
const rethrowUnlessValueError = (error: unknown): void => { if (!isPyValueError(error)) throw error; };

/** `PurePath.is_relative_to` (equality included) for canonical paths. */
export function within(path: string, root: string): boolean {
  if (same(path, root)) return true;
  const base = root.endsWith(WINDOWS ? "\\" : "/") ? root : root + (WINDOWS ? "\\" : "/");
  return WINDOWS ? path.toLowerCase().startsWith(base.toLowerCase()) : path.startsWith(base);
}

/** `web._declared_workspace_roots(additional)`: existing narrow directories, deduplicated. */
export function declaredWorkspaceRoots(additional: readonly string[] = [], env = process.env.XUENESS_WORKSPACE_ROOTS ?? "", cwd = process.cwd()): string[] {
  const roots: string[] = [];
  for (const value of [...env.split(delimiter), ...additional]) {
    if (!pyStrip(value)) continue;
    try {
      const root = resolveStrict(resolve(cwd, expandUser(value)));
      if (!isDirectory(root) || same(root, fsRoot()) || same(root, broadTemp())) continue;
      if (!roots.includes(root)) roots.push(root);
    } catch { /* missing or unreadable roots are skipped */ }
  }
  return roots;
}

/** `is_windows_first_level_system_dir`: `C:\Users`, `C:\ProgramData`, `C:\PerfLogs`. */
export function isWindowsFirstLevelSystemDir(path: string): boolean {
  const drive = /^[A-Za-z]:[\\/]/u.exec(path)?.[0];
  if (!drive) return false;
  const lowered = path.replaceAll("/", "\\").toLowerCase();
  return WINDOWS_FIRST_LEVEL_SYSTEM_DIRS.some((name) => lowered === (drive.replaceAll("/", "\\") + name).toLowerCase());
}

/** `_is_too_broad_native_root`: filesystem and system anchors are never granted. */
export function isTooBroadNativeRoot(path: string): boolean {
  try {
    const home = resolveStrict(expandUser("~")), temporary = resolveStrict(tempDir());
    if ([fsRoot(), broadTemp(), temporary, home].some((item) => same(item, path))) return true;
    if (WINDOWS) {
      const system = Object.entries(process.env).filter(([key, value]) => ["SYSTEMROOT", "PROGRAMFILES", "PROGRAMFILES(X86)"].includes(key.toUpperCase()) && value).map(([, value]) => resolveLoose(value!));
      if (same(path, /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]?/u.exec(path)?.[0] ?? "") || system.some((item) => same(item, path)) || isWindowsFirstLevelSystemDir(path)) return true;
    } else if (path.split("/").filter(Boolean).length + 1 <= 2) return true;
    return isMount(path);
  } catch {
    return true;
  }
}

/** `_recent_with_directory`: the used directory first, then at most nine older rows. */
export function recentWithDirectory(recent: unknown, path: string): unknown[] {
  const rows = Array.isArray(recent) ? recent : [];
  const updated: unknown[] = [{ path, lastUsed: pyUtcNow().replace("+00:00", "Z") }];
  for (const item of rows) {
    if (isDict(item) && typeof item.path === "string" && item.path !== path) updated.push(item);
    if (updated.length >= MAX_RECENT) break;
  }
  return updated;
}

/** The workspace section a mutation edits in place (`settings.get("workspace", {})`). */
export function workspaceSection(settings: Settings): Record<string, unknown> {
  const config = settings[SECTION];
  return isDict(config) ? config : {};
}

export class Workspaces {
  readonly options: WorkspaceOptions;
  constructor(options: WorkspaceOptions) { this.options = options; }

  /** `_plugin_access`: workspace preferences need both owning plugins enabled. */
  access(): boolean {
    try { return this.options.enabled("settings") && this.options.enabled("sessions"); } catch { return false; }
  }

  config(): Record<string, unknown> { return workspaceSection(loadSettings(this.options.stateDir)); }

  /** `selected_roots`: canonical, live, narrow roots previously returned by the OS chooser. */
  selectedRoots(): string[] {
    if (!this.access()) return [];
    const rows = Object.hasOwn(this.config(), "selectedRoots") ? this.config().selectedRoots : [];
    if (!Array.isArray(rows)) return [];
    const roots: string[] = [];
    for (const raw of rows.slice(0, MAX_SELECTED_ROOTS)) {
      if (typeof raw !== "string" || !raw || pyLen(raw) > 4096 || !isAbsolutePath(raw)) continue;
      try {
        const resolved = resolveStrict(raw);
        // A saved grant is already canonical; a later symlinked ancestor never widens it.
        if (resolved !== purePath(raw) || !isDirectory(resolved) || isTooBroadNativeRoot(resolved)) continue;
        if (!roots.includes(resolved)) roots.push(resolved);
      } catch { /* a vanished grant is ignored */ }
    }
    return roots;
  }

  /** `allowed_roots`: canonical workspace roots, including native-chooser grants unless `selected` is false. */
  allowedRoots(selected = true): string[] {
    const result: string[] = [];
    for (const value of [...this.options.declaredRoots, this.options.projectDir, this.options.webRuns, ...selected ? this.selectedRoots() : []]) {
      try {
        const root = resolveStrict(expandUser(value));
        if (!isDirectory(root) || same(root, broadTemp()) || same(root, fsRoot())) continue;
        if (!result.includes(root)) result.push(root);
      } catch { /* unusable roots are skipped */ }
    }
    return result;
  }

  /** `_resolve_allowed`: an existing directory inside the allowlist, or a `ValueError`. */
  resolveAllowed(value: unknown, needWritable = false, roots: readonly string[] = this.allowedRoots()): string {
    if (typeof value !== "string" || !pyStrip(value) || pyLen(value) > 4096) throw new PyValueError("workspace root must be an allowed existing directory");
    const path = expandUser(value);
    if (!isAbsolutePath(path)) throw new PyValueError("workspace root must be an absolute path");
    let resolved: string;
    try { resolved = resolveStrict(path); } catch { throw new PyValueError("workspace root must be an allowed existing directory"); }
    if (!roots.some((root) => within(resolved, root))) {
      if (same(resolved, broadTemp()) || same(resolved, fsRoot())) throw new PyValueError("workspace root is too broad; choose an existing project directory");
      throw new PyValueError(`workspace root is outside the configured workspace roots; restart Xueness Web with --workspace-root ${shlexQuote(resolved)} to allow this existing directory`);
    }
    if (!isDirectory(resolved)) throw new PyValueError("workspace root must be a directory");
    if (needWritable && !writable(resolved)) throw new PyValueError("workspace root is not writable");
    return resolved;
  }

  /** `get_default_root`: the saved default while its plugins are enabled, then the project, then the first writable root. */
  defaultRoot(roots: readonly string[] = this.allowedRoots()): string {
    if (!roots.length) throw new PyValueError("no configured workspace roots are available");
    if (this.access()) {
      const configured = this.config().defaultRoot;
      if (configured !== undefined && configured !== null) {
        try { return this.resolveAllowed(configured, true, roots); } catch (error) { rethrowUnlessValueError(error); }
      }
    }
    try { return this.resolveAllowed(this.options.projectDir, true, roots); } catch (error) { rethrowUnlessValueError(error); }
    return roots.find((root) => writable(root)) ?? roots[0]!;
  }

  /** `_is_isolated_session_root`: generated `web-runs/<session id>` directories are never recents. */
  isolated(path: string): boolean {
    try { return same(dirname(path), resolveStrict(this.options.webRuns)) && SESSION_DIR.test(basename(path)); } catch { return false; }
  }

  recentRows(roots: readonly string[] = this.allowedRoots()): WorkspaceSummary["recentDirectories"] {
    const recent = this.config().recentDirectories ?? [];
    if (!Array.isArray(recent)) return [];
    const rows: WorkspaceSummary["recentDirectories"] = [];
    for (const item of recent.slice(0, 100)) {
      if (!isDict(item) || typeof item.path !== "string") continue;
      let path: string;
      try { path = this.resolveAllowed(item.path, false, roots); } catch (error) { rethrowUnlessValueError(error); continue; }
      if (this.isolated(path) || rows.some((row) => row.path === path)) continue;
      rows.push({ path, label: label(path), lastUsed: typeof item.lastUsed === "string" ? item.lastUsed : "" });
      if (rows.length >= MAX_RECENT) break;
    }
    return rows;
  }

  /** `remember_directory`: record a successful use without changing the allowlist. */
  remember(value: unknown): void {
    if (!this.access()) return;
    let path: string;
    try { path = this.resolveAllowed(value); } catch (error) { rethrowUnlessValueError(error); return; }
    if (this.isolated(path)) return;
    updateSettings(this.options.stateDir, (settings) => {
      const config = workspaceSection(settings);
      config.recentDirectories = recentWithDirectory(config.recentDirectories ?? [], path);
      settings[SECTION] = config;
    });
  }

  /** `POST /api/workspaces/default`: save the default and record it as recent. */
  saveDefault(root: string): void {
    updateSettings(this.options.stateDir, (settings) => {
      const config = workspaceSection(settings);
      config.defaultRoot = root;
      config.recentDirectories = recentWithDirectory(config.recentDirectories ?? [], root);
      settings[SECTION] = config;
    });
  }

  /** `_picker`: one level of the requested (or default) directory, fenced to the allowlist. */
  picker(query: Record<string, unknown>, defaultRoot: string, roots: readonly string[] = this.allowedRoots()): WorkspaceSummary["picker"] {
    let value = query.path;
    if (Array.isArray(value)) value = value.length ? value[0] : null;
    const target = value === undefined || value === null || value === "" ? defaultRoot : this.resolveAllowed(value, false, roots);
    let hidden = query.includeHidden ?? false;
    if (Array.isArray(hidden)) hidden = hidden.length ? hidden[0] : false;
    if (typeof hidden === "string") hidden = ["1", "true", "yes", "on"].includes(pyStrip(hidden).toLowerCase());
    const listing = this.options.listLevel(roots, target, pyTruthy(hidden), this.options.maxEntries || 1000, true);
    const entries: WorkspaceSummary["picker"]["entries"] = [];
    for (const item of listing.entries) {
      try { if (!roots.some((root) => within(resolveStrict(item.path), root))) continue; } catch { continue; }
      entries.push({ name: item.name, path: item.path, type: item.type, isSymlink: item.isSymbolicLink === true });
    }
    const current = listing.path, parentPath = dirname(current);
    const parent = parentPath !== current && roots.some((root) => within(parentPath, root)) ? parentPath : null;
    return { path: current, parent, entries, truncated: !!listing.truncated };
  }

  /** `_summary`: the payload of `GET /api/workspaces`. */
  summary(query: Record<string, unknown>): WorkspaceSummary {
    const roots = this.allowedRoots();
    const defaultRoot = this.defaultRoot(roots);
    return { defaultRoot, allowedRoots: roots.map((root) => ({ path: root, label: label(root) })), recentDirectories: this.recentRows(roots), picker: this.picker(query, defaultRoot, roots) };
  }
}