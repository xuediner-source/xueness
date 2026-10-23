/** Chrome user-data discovery (`chrome_root`, `chrome_profiles`, `chrome_running`). */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pySlice, pyStrip } from "@xueness/contracts";
import { MAX_COPY_FILES, MAX_LOCAL_STATE_BYTES, PROFILE_ID, ProfileError, isLink } from "./profile-error.ts";
import { checkedDirectory, readSourceFile } from "./profile-source.ts";

export function defaultChromeRoot(): string | null {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? join(local, "Google", "Chrome", "User Data") : null;
  }
  const home = homedir();
  return process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
}

function cleanName(name: string, fallback: string): string {
  const cleaned = pySlice(pyStrip(name.replace(/[\u0000-\u001f\u007f]/g, "")), 80);
  return cleaned || fallback;
}

/** At most 50 profile directories named `Default` or `Profile N`, labels from `Local State` when it parses. */
export function chromeProfiles(root: string | null): { id: string; name: string }[] {
  const checked = checkedDirectory(root);
  if (!checked) return [];
  let names: Record<string, unknown> = {};
  const local = join(checked, "Local State");
  if (existsOrLink(local)) {
    try {
      const value = JSON.parse(readSourceFile(checked, ["Local State"], MAX_LOCAL_STATE_BYTES).toString("utf8")) as unknown;
      const info = value && typeof value === "object" && !Array.isArray(value) ? (value as { profile?: { info_cache?: unknown } }).profile?.info_cache : {};
      names = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, unknown> : {};
    } catch { names = {}; }
  }
  const rows: { id: string; name: string }[] = [];
  let visited = 0;
  for (const entry of readdirSync(checked, { withFileTypes: true })) {
    visited += 1;
    if (visited > MAX_COPY_FILES) throw new ProfileError("profile_too_large");
    if (!PROFILE_ID.test(entry.name)) continue;
    const path = join(checked, entry.name);
    let info;
    try { info = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const label = names[entry.name];
    const raw = label && typeof label === "object" && !Array.isArray(label) ? (label as { name?: unknown }).name : undefined;
    rows.push({ id: entry.name, name: typeof raw === "string" ? cleanName(raw, entry.name) : entry.name });
  }
  return rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).slice(0, 50);
}

function existsOrLink(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const row: string[] = [];
    let index = 0;
    while (index < line.length) {
      if (line[index] === '"') {
        let cursor = index + 1, value = "";
        while (cursor < line.length) {
          if (line[cursor] === '"') { if (line[cursor + 1] === '"') { value += '"'; cursor += 2; continue; } cursor += 1; break; }
          value += line[cursor]; cursor += 1;
        }
        row.push(value); index = line[cursor] === "," ? cursor + 1 : cursor;
      } else {
        const comma = line.indexOf(",", index);
        if (comma < 0) { row.push(line.slice(index)); break; }
        row.push(line.slice(index, comma)); index = comma + 1;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** True when Chrome is open. A failed process listing is `source_busy`, not "closed". */
export function chromeRunning(root: string | null = defaultChromeRoot()): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new ProfileError("source_busy");
    return csvRows(result.stdout ?? "").some((row) => row[0]?.toLowerCase() === "chrome.exe");
  }
  if (root) {
    try { if (isLink(join(root, "SingletonLock"))) return true; } catch { throw new ProfileError("source_busy"); }
  }
  const result = spawnSync("pgrep", ["-x", process.platform === "darwin" ? "Google Chrome" : "chrome"], { timeout: 5_000, windowsHide: true });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new ProfileError("source_busy");
}
