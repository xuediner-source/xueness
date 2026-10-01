/** Workspace picker and default-root client. The host remains the source of truth for path authorization. */
import { get, post } from "./xuenessApi";

export type WorkspaceRoot = { path: string; label: string };
export type RecentWorkspaceDirectory = { path: string; label: string; lastUsed: string | number };
export type WorkspacePickerEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  isSymlink?: boolean;
};
export type WorkspacePicker = {
  path: string | null;
  parent: string | null;
  entries: WorkspacePickerEntry[];
  truncated: boolean;
};
export type WorkspaceCatalog = {
  defaultRoot: string | null;
  allowedRoots: WorkspaceRoot[];
  recentDirectories: RecentWorkspaceDirectory[];
  picker: WorkspacePicker;
};

export type NativeWorkspacePicker = { available: boolean; platform: string };
export type NativeWorkspaceSelection = { cancelled: true } | { cancelled?: false; root: string };

export function loadNativeWorkspacePicker(): Promise<NativeWorkspacePicker> {
  return get<NativeWorkspacePicker>("/api/workspaces/native-picker");
}

/** The selected path comes from the OS dialog, never from client-side directory grants. */
export function chooseNativeWorkspace(initialRoot?: string | null): Promise<NativeWorkspaceSelection> {
  return post<NativeWorkspaceSelection>("/api/workspaces/native-picker", initialRoot ? { initialRoot } : {});
}

export async function loadWorkspaceCatalog(path?: string): Promise<WorkspaceCatalog> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  const suffix = query.size ? `?${query.toString()}` : "";
  return get<WorkspaceCatalog>(`/api/workspaces${suffix}`);
}

export async function saveDefaultWorkspaceRoot(root: string): Promise<{ root: string }> {
  const result = await post<{ root?: unknown; defaultRoot?: unknown }>("/api/workspaces/default", { root });
  const savedRoot = typeof result.root === "string"
    ? result.root
    : typeof result.defaultRoot === "string"
      ? result.defaultRoot
      : null;
  if (!savedRoot) throw new Error("Workspace default response did not include the saved root");
  return { root: savedRoot };
}

export async function confirmWorkspaceRoot(root: string): Promise<{ root: string }> {
  return post<{ root: string }>("/api/workspaces/confirm", { root });
}

/** Create one child directory using the existing jailed directory endpoint. */
export async function createWorkspaceDirectory(path: string, name: string): Promise<{ path: string }> {
  return post<{ path: string }>("/api/directory", { path, name });
}

function normalizedPath(path: string): string | null {
  const value = path.trim();
  if (!value || value.includes("\0")) return null;
  const slash = value.replace(/\\/g, "/");
  if (!slash.startsWith("/") && !/^[A-Za-z]:\//.test(slash)) return null;
  if (slash.split("/").some((part) => part === "." || part === "..")) return null;
  const compact = slash.replace(/\/{2,}/g, "/");
  return compact.length > 1 ? compact.replace(/\/$/, "") : compact;
}

/** Lightweight input-shape check; the host decides whether the path is authorized. */
export function isAbsoluteWorkspacePath(path: string): boolean {
  const value = path.trim();
  return value.length > 0 && value.length <= 4096 && (
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
  );
}

/** Lexical preflight only; confirmWorkspaceRoot performs the authoritative host-side check. */
export function isPathWithinAllowedRoot(candidate: string, allowedRoot: string): boolean {
  const path = normalizedPath(candidate);
  const root = normalizedPath(allowedRoot);
  if (!path || !root) return false;
  const insensitive = /^[A-Za-z]:\//.test(root);
  const value = insensitive ? path.toLowerCase() : path;
  const base = insensitive ? root.toLowerCase() : root;
  return value === base || value.startsWith(`${base.replace(/\/$/, "")}/`);
}

export function isWorkspacePathAllowed(candidate: string, allowedRoots: readonly WorkspaceRoot[]): boolean {
  return allowedRoots.some((root) => isPathWithinAllowedRoot(candidate, root.path));
}

/** Build navigable breadcrumbs only from the host-declared allowed roots. */
export function workspaceBreadcrumbs(
  currentPath: string | null,
  allowedRoots: readonly WorkspaceRoot[],
): WorkspaceRoot[] {
  if (!currentPath) return [];
  const matching = allowedRoots
    .filter((root) => isPathWithinAllowedRoot(currentPath, root.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!matching) return [];
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const root = normalize(matching.path);
  const current = normalize(currentPath);
  const remainder = current.slice(root.length).split("/").filter(Boolean);
  const crumbs: WorkspaceRoot[] = [{ path: matching.path, label: matching.label }];
  let next = matching.path;
  for (const segment of remainder) {
    const separator = next.endsWith("/") || next.endsWith("\\") ? "" : next.includes("\\") && !next.includes("/") ? "\\" : "/";
    next = `${next}${separator}${segment}`;
    crumbs.push({ path: next, label: segment });
  }
  return crumbs;
}
