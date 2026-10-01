/**
 * Xueness workspace data layer: the remaining backend surfaces the native UI
 * needs (directory browsing, providers, usage, memory tracks, all settings).
 *
 * Thin Result-typed wrapper over `xuenessApi`, which already owns the transport
 * (CSRF, same-origin, non-2xx -> throw). Nothing here builds a URL by hand: the
 * point of routing every call through one client is that a header or path fix
 * lands once.
 *
 * The workbench needs failures to be *visible*, so each call reports
 * `{ok:false, error}` instead of degrading to an empty result the way
 * a fallback wrapper would. A panel showing "nothing here" while the server is
 * down is lying about state.
 *
 * Contract: docs/xueness-batch6.md (frozen). Exported types and signatures are
 * the interface the panels build against.
 */
import type { Result } from "./xuenessWorkbench";

export type DirectoryEntry = { name: string; path: string; isDir: boolean; size: number };

export type XuenessDirectoryListing = {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
};

export type ProviderSummary = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  protocol?: "openai" | "anthropic";
  capabilities?: string[];
  reasoningLevels?: string[];
};

export type UsageSummary = import("./xuenessApi").UsageSummary;

export type MemoryTrack = {
  name: "memory" | "user" | "key";
  path: string;
  bytes: number;
  present: boolean;
};

export type SettingsMap = Record<string, unknown>;

// -- implementation (workspace data lane) ------------------------------------

import {
  createDirectory,
  getMemoryTracks,
  getSettings,
  getSystemHome,
  getUsage,
  listDirectory,
  listProviders,
} from "./xuenessApi";

/** Normalise any thrown value into the error text the Result contract carries. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reason a user-scoped resource cannot be written, from a capability payload.
 * Fail-soft: anything unrecognised yields "" rather than a made-up reason.
 */
export function userScopeReason(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const reason = (value as { userScopeReason?: unknown }).userScopeReason;
  return typeof reason === "string" ? reason : "";
}

export async function loadHome(): Promise<Result<string>> {
  try {
    const payload = await getSystemHome();
    return { ok: true, value: payload.homedir };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadDirectory(
  path: string,
  includeHidden = true,
): Promise<Result<XuenessDirectoryListing>> {
  try {
    // The workspace file tree shows files alongside directories, so includeFiles
    // is always on (see xuenessApi.listDirectory: the default picker semantics
    // walk directories only).
    const listing = await listDirectory(path, includeHidden, true);
    const entries: DirectoryEntry[] = listing.entries.map((entry) => {
      // The transport does not carry a size field today (backend sends
      // name/path/type/hidden/isSymbolicLink); default to 0 instead of inventing
      // one, but stay forward-compatible if it ever appears.
      const raw = entry as { size?: unknown };
      return {
        name: entry.name,
        path: entry.path,
        isDir: entry.type === "directory",
        size: typeof raw.size === "number" ? raw.size : 0,
      };
    });
    return {
      ok: true,
      value: { path: listing.path, entries, truncated: listing.truncated === true },
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function createFolder(path: string, name: string): Promise<Result<string>> {
  try {
    const payload = await createDirectory(path, name);
    return { ok: true, value: payload.path };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadProviders(): Promise<Result<ProviderSummary[]>> {
  try {
    const payload = await listProviders();
    return { ok: true, value: payload.providers };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadUsage(range = "7d"): Promise<Result<UsageSummary>> {
  try {
    const payload = await getUsage(range);
    return { ok: true, value: payload };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadMemoryTracks(): Promise<Result<MemoryTrack[]>> {
  try {
    const payload = await getMemoryTracks();
    return { ok: true, value: payload.tracks };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** The five settings sections, merged in contract order (later wins). */
const SETTINGS_SECTIONS = ["general", "appearance", "shortcuts", "browser", "agent"] as const;

export async function loadAllSettings(defaults: SettingsMap): Promise<Result<SettingsMap>> {
  try {
    // getSettings throws on non-2xx / non-JSON; that is the failure path below.
    const sections = await getSettings();
    const merged: SettingsMap = { ...defaults };
    for (const section of SETTINGS_SECTIONS) {
      const values = sections[section];
      // Fail-soft: a missing or malformed section is skipped, never invented.
      if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
      Object.assign(merged, values);
    }
    return { ok: true, value: merged };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}
