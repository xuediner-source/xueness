/**
 * The same-machine folder chooser: the native-picker half of Python
 * `bundled_plugins/settings/workspaces_api.py`.
 *
 * Only macOS has one (`osascript` and `choose folder`). The chosen path is
 * validated again after the dialog closes and only then becomes a persistent
 * grant in `settings.workspace.selectedRoots`, the one way a browser client
 * can widen the workspace allowlist. Dialogs are serialized; no settings write
 * is in progress while one waits for the operator.
 */
import { spawn } from "node:child_process";
import { pyLen, PyValueError } from "@xueness/contracts";
import { isAbsolutePath, isDirectory, platformFamily, purePath, resolveStrict, which, writable } from "./paths.ts";
import { updateSettings } from "./store.ts";
import { isTooBroadNativeRoot, MAX_SELECTED_ROOTS, recentWithDirectory, workspaceSection, type Workspaces } from "./workspaces.ts";

export const PICKER_CANCELLED = "__XUENESS_NATIVE_PICKER_CANCELLED__";
export const PICKER_TIMEOUT_MS = 600_000;

// The initial location is passed as osascript's argv, never interpolated into
// this program, so quotes and AppleScript syntax in a name never become code.
export const MACOS_PICKER_SCRIPT = `on run argv
    try
        if (count of argv) > 0 then
            set initialLocation to POSIX file (item 1 of argv) as alias
            set selectedFolder to choose folder with prompt "Choose a project folder" default location initialLocation
        else
            set selectedFolder to choose folder with prompt "Choose a project folder"
        end if
        return POSIX path of selectedFolder
    on error errorMessage number errorNumber
        if errorNumber is -128 then
            return "${PICKER_CANCELLED}"
        end if
        error errorMessage number errorNumber
    end try
end run`;

/** Python `NotImplementedError` from `_choose_native_directory` (HTTP 501). */
export class PickerUnavailable extends Error { override name = "NotImplementedError"; }
/** Python `RuntimeError("native directory picker failed")` (HTTP 500). */
export class PickerFailed extends Error { override name = "RuntimeError"; }

export interface PickerCapability { available: boolean; platform: string }
/** Opens a chooser at `initialRoot`; resolves to the chosen path, or null when cancelled. */
export type DirectoryChooser = (initialRoot: string | null) => Promise<string | null>;

/** `native_picker_capability`: describes support without opening a dialog. */
export function nativePickerCapability(platform: unknown = platformFamily()): PickerCapability {
  const name = typeof platform === "string" && platform ? platform : "unknown";
  return { available: name === "macos" && !!which("osascript"), platform: name };
}

let dialogs: Promise<unknown> = Promise.resolve();

function osascript(args: readonly string[]): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(which("osascript") ?? "osascript", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new PickerFailed("native directory picker failed")); }, PICKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new PickerFailed("native directory picker failed")); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks) }); });
  });
}

/** `_choose_native_directory`: the macOS chooser's POSIX path, or null on cancel. */
export const chooseNativeDirectory: DirectoryChooser = async (initialRoot) => {
  if (!nativePickerCapability().available) throw new PickerUnavailable("native directory picker is unavailable");
  const args = ["-e", MACOS_PICKER_SCRIPT, ...initialRoot === null ? [] : [initialRoot]];
  const run = dialogs.then(() => osascript(args));
  dialogs = run.catch(() => undefined);
  const completed = await run;
  if (completed.code !== 0) throw new PickerFailed("native directory picker failed");
  // `text=True` decodes UTF-8 with replacement and translates newlines.
  let output = completed.stdout.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // osascript appends one terminator; a name ending in a newline keeps its own.
  if (output.endsWith("\n")) output = output.slice(0, -1);
  return output === PICKER_CANCELLED ? null : output;
};

/** `_validate_native_selection`: an OS-returned directory, checked before it becomes a grant. */
export function validateNativeSelection(value: unknown): string {
  if (typeof value !== "string" || !value || pyLen(value) > 4096 || value.includes("\0")) throw new PyValueError("native picker did not return a valid directory");
  if (!isAbsolutePath(value)) throw new PyValueError("native picker did not return an absolute directory");
  let selected: string;
  try { selected = resolveStrict(value); } catch { throw new PyValueError("selected directory is no longer available"); }
  if (!isDirectory(selected)) throw new PyValueError("selected path is not a directory");
  if (isTooBroadNativeRoot(selected)) throw new PyValueError("choose a project directory, not a broad system location");
  if (!writable(selected)) throw new PyValueError("selected directory is not writable");
  return selected;
}

/** `_register_native_selection`: persist the validated choice as an explicit grant. */
export function registerNativeSelection(workspaces: Workspaces, selected: string): void {
  const current = workspaces.selectedRoots();
  if (!current.includes(selected) && current.length >= MAX_SELECTED_ROOTS) throw new PyValueError("native workspace limit reached");
  updateSettings(workspaces.options.stateDir, (settings) => {
    const config = workspaceSection(settings);
    const rows = Array.isArray(config.selectedRoots) ? config.selectedRoots : [];
    const canonical: string[] = [];
    for (const raw of rows.slice(0, MAX_SELECTED_ROOTS)) {
      if (typeof raw !== "string") continue;
      try {
        const resolved = resolveStrict(raw);
        if (!isAbsolutePath(raw) || purePath(raw) !== resolved || !isDirectory(resolved) || isTooBroadNativeRoot(resolved)) continue;
        if (!canonical.includes(resolved)) canonical.push(resolved);
      } catch { /* a vanished grant is dropped */ }
    }
    if (!canonical.includes(selected)) {
      if (canonical.length >= MAX_SELECTED_ROOTS) throw new PyValueError("native workspace limit reached");
      canonical.push(selected);
    }
    config.selectedRoots = canonical;
    config.recentDirectories = recentWithDirectory(config.recentDirectories ?? [], selected);
    settings.workspace = config;
  });
}
