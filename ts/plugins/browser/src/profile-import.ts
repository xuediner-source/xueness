/**
 * Copy one closed Chrome profile into `<state>/browser-profile`
 * (`profiles.import_chrome`). The source is only read. `Local State` keeps
 * `os_crypt` and drops account lists. A failed swap puts the old profile back.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserStateKey } from "./tabs-state.ts";
import { managedProfile } from "./worker.ts";
import { MAX_COPY_BYTES, MAX_LOCAL_STATE_BYTES, PROFILE_ID, ProfileError, exists, isLink } from "./profile-error.ts";
import { chromeProfiles, chromeRunning, defaultChromeRoot } from "./profile-chrome.ts";
import { fileRecords, readSourceFile, sameSnapshot, snapshotSources } from "./profile-source.ts";

const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;

export interface ImportHooks {
  recheck(): void;
  /** Override discovery in tests. `null` means there is no Chrome directory. */
  chromeRoot?: string | null;
  chromeRunning?(): boolean;
}

function destination(stateDir: string): string {
  try { return managedProfile(stateDir); } catch (error) {
    if (error instanceof Error && (error.message === "profile_invalid" || error.message === "browser profile path is unsafe")) throw new ProfileError("profile_invalid");
    throw error;
  }
}

function removeStage(path: string, state: string): void {
  if (isLink(path)) throw new ProfileError("profile_invalid");
  if (dirname(realpathSync(path)) !== state) throw new ProfileError("profile_invalid");
  rmSync(path, { recursive: true, force: true });
}

function writePrivate(path: string, data: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function running(hooks: ImportHooks, root: string | null): boolean {
  return hooks.chromeRunning ? hooks.chromeRunning() : chromeRunning(root);
}

/** `import_chrome`. `chromeRoot === null` skips the real user-data directory. */
export function importChrome(stateDir: string, profileId: string, hooks: ImportHooks): Record<string, unknown> {
  if (!PROFILE_ID.test(profileId)) throw new ProfileError("profile_not_found");
  const root = hooks.chromeRoot === undefined ? defaultChromeRoot() : hooks.chromeRoot;
  if (running(hooks, root)) throw new ProfileError("close_chrome");
  if (!root || !chromeProfiles(root).some((row) => row.id === profileId)) throw new ProfileError("profile_not_found");
  if (isLink(stateDir)) throw new ProfileError("profile_invalid");
  mkdirSync(stateDir, { recursive: true });
  const state = browserStateKey(stateDir);
  let target = destination(state);
  const stage = join(state, "browser-import-" + randomBytes(8).toString("hex"));
  mkdirSync(stage, { recursive: false, mode: 0o700 });
  let old: string | null = null;
  try {
    if (process.platform !== "win32") chmodSync(stage, 0o700);
    const snapshot = snapshotSources(root, profileId);
    let total = 0;
    const local = snapshot.get("Local State");
    if (local) {
      const raw = readSourceFile(root, ["Local State"], Math.min(MAX_LOCAL_STATE_BYTES, MAX_COPY_BYTES), local.sig);
      total += raw.length;
      let value: unknown;
      try { value = JSON.parse(raw.toString("utf8")); } catch { throw new ProfileError("source_invalid"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProfileError("source_invalid");
      const safe: Record<string, unknown> = { profile: { last_used: "Default" } };
      const crypt = (value as { os_crypt?: unknown }).os_crypt;
      if (crypt && typeof crypt === "object" && !Array.isArray(crypt)) safe.os_crypt = crypt;
      writePrivate(join(stage, "Local State"), Buffer.from(JSON.stringify(safe)));
    }
    for (const [key, sig] of fileRecords(snapshot, profileId)) {
      const parts = key.split("/");
      const data = readSourceFile(root, parts, MAX_COPY_BYTES - total, sig);
      total += data.length;
      const file = join(stage, "Default", ...parts.slice(1));
      mkdirSync(dirname(file), { recursive: true });
      writePrivate(file, data);
    }
    mkdirSync(join(stage, "Default"), { recursive: true });
    hooks.recheck();
    let again;
    try { again = snapshotSources(root, profileId); } catch (error) {
      if (error instanceof ProfileError && error.message === "source_invalid") throw error;
      throw new ProfileError("source_busy");
    }
    if (!sameSnapshot(snapshot, again)) throw new ProfileError("source_busy");
    hooks.recheck();
    if (running(hooks, root)) throw new ProfileError("close_chrome");
    target = destination(state);
    if (exists(target)) {
      if (process.platform !== "win32") chmodSync(target, 0o700);
      old = join(state, "browser-import-old-" + randomBytes(16).toString("hex"));
      if (dirname(old) !== state) throw new ProfileError("profile_invalid");
      renameSync(target, old);
    }
    try { renameSync(stage, target); } catch (error) {
      if (old) { try { renameSync(old, target); } catch { /* the original rename is what the caller sees */ } old = null; }
      throw error;
    }
    let cleanupPending = false;
    if (old) {
      try { removeStage(old, state); old = null; } catch { cleanupPending = true; }
    }
    return { ok: true, profilePresent: true, loginMayRequireSignIn: true, cleanupPending };
  } finally {
    if (exists(stage)) { try { removeStage(stage, state); } catch { /* a leftover stage is not the managed profile */ } }
  }
}
