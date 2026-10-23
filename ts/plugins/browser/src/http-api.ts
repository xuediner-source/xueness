/**
 * Browser HTTP that Python `plugin.dispatch` splits across tabs, profiles and
 * settings. A disabled browser plugin is refused here, before any of those
 * handlers, the same way `plugin_runtime.dispatch_http` refuses the family.
 */
import { isDict } from "@xueness/contracts";
import { dispatchProfiles } from "./profile-api.ts";
import { dispatchSettings } from "./http-settings.ts";
import { dispatchTabs } from "./tabs-api.ts";
import type { RuntimeInfo } from "./runtime-probe.ts";
import type { WorkerSpawn } from "./worker.ts";

type Row = Record<string, unknown>;
export type BrowserReply = [number, Row];

export interface BrowserHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** Python `ctx['running']`: any member blocks clear and import. */
  running: { readonly size: number };
  /** A desktop token is present. Import also needs the desktop plugin. */
  desktop: boolean;
  projectDir?: string;
  webRuns?: string;
  workspaceRoots?: readonly string[];
  loadSession?(stateDir: string, id: string): Row;
  /** Replaces the live `bridge.mjs --probe`. */
  runtime?(): RuntimeInfo;
  spawn?: WorkerSpawn;
  bridge?: string;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  callTimeoutMs?: number;
  /** `undefined` discovers Chrome. `null` is a host with no Chrome directory. */
  chromeRoot?: string | null;
  chromeRunning?(): boolean;
  /** Monotonic milliseconds, overridable so approval expiry can be tested. */
  now?(): number;
}

export interface BrowserHttp {
  owns(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: readonly string[], data: unknown): Promise<BrowserReply | null>;
}

const DISABLED: BrowserReply = [403, { error: "plugin disabled or dependency unavailable: browser", plugin: "browser" }];

/** Tabs claim every deeper path (Python returns 405 / 404 itself). The other two families are exact. */
export function ownsBrowserRoute(parts: readonly string[]): boolean {
  if (parts[0] !== "api" || parts[1] !== "browser") return false;
  if (parts[2] === "tabs") return parts.length >= 3;
  return (parts[2] === "runtime" || parts[2] === "data" || parts[2] === "profiles") && parts.length === 3;
}

export function createBrowserHttp(options: BrowserHttpOptions): BrowserHttp {
  return {
    owns(_method, parts) { return ownsBrowserRoute(parts); },
    async dispatch(method, parts, data) {
      if (!ownsBrowserRoute(parts)) return null;
      if (!options.enabled("browser")) return DISABLED;
      const body = isDict(data) ? data : {};
      if (parts[2] === "tabs") return dispatchTabs(options, method, parts, body);
      if (parts[2] === "profiles") return dispatchProfiles(options, method, body);
      return dispatchSettings(options, method, parts, body);
    },
  };
}
