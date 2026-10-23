/**
 * HTTP surface of the settings plugin: Python `bundled_plugins/settings/plugin.py`
 * `dispatch` (workspaces first, then the settings store).
 *
 *   GET  /api/settings, GET|POST /api/settings/<section>
 *   GET  /api/workspaces                  summary, allowlist, recents, picker level
 *   POST /api/workspaces/default|confirm  {root}
 *   GET|POST /api/workspaces/native-picker  same-machine folder chooser
 *
 * The front door keeps the transport guards (Host, Origin, CSRF, framing);
 * `loopback` is the real peer of the request. In desktop mode the Electron
 * host owns the folder dialog, so the native-picker route stays with the
 * Python desktop host until the desktop family moves.
 */
import { isDict } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { chooseNativeDirectory, nativePickerCapability, PickerFailed, PickerUnavailable, registerNativeSelection, validateNativeSelection, type DirectoryChooser, type PickerCapability } from "./native-picker.ts";
import { dispatchSettings, type Reply } from "./store.ts";
import { Workspaces, type WorkspaceOptions } from "./workspaces.ts";

const PICKER_ROUTES = ["GET /api/workspaces/native-picker", "POST /api/workspaces/native-picker"];
export const SETTINGS_ROUTES: readonly string[] = Object.freeze(["GET /api/settings", "GET /api/settings/:section", "POST /api/settings/:section",
  "GET /api/workspaces", "POST /api/workspaces/default", "POST /api/workspaces/confirm", ...PICKER_ROUTES]);
/** The methods Python's handler routes to plugin dispatch (`do_GET` ... `do_PUT`). */
const API_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

export interface SettingsApiOptions extends WorkspaceOptions {
  /** Desktop host: the native-picker route is answered by the desktop host. */
  desktop?: boolean;
  /** Replaces the macOS chooser and its probe (tests, other hosts). */
  chooser?: DirectoryChooser;
  capability?: () => PickerCapability;
}
export interface SettingsRequest { loopback?: boolean }

const methodNotAllowed = (): Reply => [405, { error: "method not allowed" }];
const valueError = (error: unknown): Reply => {
  if (isPyValueError(error)) return [400, { error: (error as Error).message }];
  throw error;
};

export function createSettingsApi(options: SettingsApiOptions) {
  const workspaces = new Workspaces(options);
  const capability = options.capability ?? (() => nativePickerCapability());
  const chooser = options.chooser ?? chooseNativeDirectory;
  const picker = (parts: readonly string[]): boolean => parts.length === 3 && parts[2] === "native-picker";
  const owns = (method: string, parts: readonly string[]): boolean => {
    if (parts[0] !== "api" || !API_METHODS.has(method)) return false;
    if (parts[1] === "settings") return parts.length === 2 ? method === "GET" : parts.length === 3 && (method === "GET" || method === "POST");
    // A desktop host without a dialog relay leaves the picker route unanswered.
    return parts[1] === "workspaces" && !(options.desktop === true && !options.chooser && picker(parts));
  };

  async function nativePicker(method: string, data: unknown, loopback: boolean): Promise<Reply> {
    const offered = capability();
    // The dialog belongs to the server's desktop; a remote client is never offered it.
    if (method === "GET") return [200, loopback ? offered : { ...offered, available: false }];
    if (method !== "POST") return methodNotAllowed();
    if (!loopback) return [403, { error: "native directory picker is local-only" }];
    if (!offered.available) return [501, { error: "native directory picker is unavailable", ...offered }];
    const keys = isDict(data) ? Object.keys(data) : null;
    if (!keys || keys.length > 1 || keys.length === 1 && keys[0] !== "initialRoot") return [400, { error: "expected an optional initialRoot" }];
    let initialRoot: string | null = null;
    if (keys.length) {
      try { initialRoot = workspaces.resolveAllowed((data as Record<string, unknown>).initialRoot, true); } catch (error) { return valueError(error); }
    } else {
      // No usable default is fine: the chooser opens at its usual location.
      try { initialRoot = workspaces.defaultRoot(); } catch (error) { if (!isPyValueError(error)) throw error; }
    }
    let selected: string | null;
    try { selected = await chooser(initialRoot); } catch (error) {
      if (error instanceof PickerUnavailable) return [501, { error: "native directory picker is unavailable", ...offered }];
      if (error instanceof PickerFailed) return [500, { error: "native directory picker failed" }];
      throw error;
    }
    // A dialog can outlive a plugin toggle; never grant after the owners went away.
    if (!workspaces.access()) return [403, { error: "directory picker plugin was disabled" }];
    if (selected === null) return [200, { cancelled: true }];
    try {
      const root = validateNativeSelection(selected);
      registerNativeSelection(workspaces, root);
      return [200, { root }];
    } catch (error) {
      if (isPyOSError(error)) return [500, { error: "cannot save workspace preference" }];
      return valueError(error);
    }
  }

  async function workspaceRoute(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown, loopback: boolean): Promise<Reply> {
    if (!workspaces.access()) return [403, { error: "workspace settings require enabled settings and sessions plugins" }];
    if (picker(parts)) return nativePicker(method, data, loopback);
    if (parts.length === 2) {
      if (method !== "GET") return methodNotAllowed();
      try { return [200, workspaces.summary(query)]; } catch (error) {
        if (isPyOSError(error)) return [500, { error: "workspace settings unavailable" }];
        return valueError(error);
      }
    }
    if (parts.length !== 3 || parts[2] !== "default" && parts[2] !== "confirm") return [404, { error: "workspace route not found" }];
    if (method !== "POST") return methodNotAllowed();
    if (!isDict(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, "root")) return [400, { error: "expected root" }];
    let root: string;
    try { root = workspaces.resolveAllowed(data.root, true); } catch (error) { return valueError(error); }
    try {
      // Confirmation records use only; it never widens the allowlist.
      if (parts[2] === "default") {
        workspaces.saveDefault(root);
        return [200, { root, ...workspaces.summary({}) }];
      }
      workspaces.remember(root);
      return [200, { root }];
    } catch (error) {
      if (isPyOSError(error)) return [500, { error: "cannot save workspace preference" }];
      throw error;
    }
  }

  return {
    workspaces,
    routes: options.desktop === true && !options.chooser ? SETTINGS_ROUTES.filter((route) => !PICKER_ROUTES.includes(route)) : SETTINGS_ROUTES,
    owns,
    /** Bodies keep integral floats and large integers, as Python's `json.loads` does. */
    lossless: owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown, request: SettingsRequest = {}): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("settings")) return [403, { error: "plugin disabled or dependency unavailable: settings", plugin: "settings", code: "plugin_disabled" }];
      if (parts[1] === "settings") return dispatchSettings(method, parts, data, options.stateDir);
      return workspaceRoute(method, parts, query, data, request.loopback === true);
    },
  };
}
