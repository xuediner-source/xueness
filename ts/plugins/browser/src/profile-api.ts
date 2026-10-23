/** `profiles.dispatch`: desktop-only list and confirmed import. */
import { shutdown, withBrowserLock } from "./registry.ts";
import { ProfileError, isErrno } from "./profile-error.ts";
import { chromeProfiles, defaultChromeRoot } from "./profile-chrome.ts";
import { importChrome } from "./profile-import.ts";
import type { BrowserHttpOptions } from "./http-api.ts";

type Row = Record<string, unknown>;
type Reply = [number, Row];

function exact(body: Row, keys: readonly string[]): boolean {
  const got = Object.keys(body);
  return got.length === keys.length && keys.every((key) => got.includes(key));
}

function refused(error: unknown): Reply {
  if (error instanceof ProfileError) {
    const busy = error.message === "close_chrome" || error.message === "source_busy" || error.message === "tasks_running";
    return [busy ? 409 : 400, { error: error.message }];
  }
  if (isErrno(error)) return [409, { error: "source_busy" }];
  throw error;
}

/** GET lists fixture or host profiles. POST copies one after confirmation, unless a task is running. */
export async function dispatchProfiles(options: BrowserHttpOptions, method: string, body: Row): Promise<Reply> {
  const allowed = options.desktop && options.enabled("desktop");
  if (!allowed) return [403, { error: "desktop_required" }];
  const root = options.chromeRoot === undefined ? defaultChromeRoot() : options.chromeRoot;
  if (method === "GET") {
    try { return [200, { profiles: chromeProfiles(root) }]; } catch (error) {
      if (error instanceof ProfileError || isErrno(error)) return [400, { error: "source_invalid" }];
      throw error;
    }
  }
  if (method !== "POST") return [405, { error: "method not allowed" }];
  if (!exact(body, ["profileId", "confirmed"]) || body.confirmed !== true) return [400, { error: "confirmation_required" }];
  return withBrowserLock(options.stateDir, async () => {
    if (options.running.size > 0) return [409, { error: "tasks_running" }];
    const recheck = (): void => {
      if (!options.enabled("browser") || !options.enabled("desktop")) throw new ProfileError("plugin_disabled");
    };
    try {
      recheck();
      await shutdown(options.stateDir);
      const profileId = body.profileId;
      if (typeof profileId !== "string") throw new ProfileError("profile_not_found");
      return [200, importChrome(options.stateDir, profileId, { recheck, chromeRoot: options.chromeRoot, ...(options.chromeRunning ? { chromeRunning: options.chromeRunning } : {}) })];
    } catch (error) { return refused(error); }
  });
}
