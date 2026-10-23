/**
 * The browser plugin on TS (Python `bundled_plugins/browser/plugin.py`): six
 * exactly approved tools over one persistent Playwright worker per state
 * directory, running the same `bridge.mjs`. Disabling the plugin or closing
 * the host stops the worker. `createBrowserHttp` answers the side-panel tabs,
 * runtime, data and Chrome profile routes.
 */
import { definePlugin, type BundledPlugin, type Context } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { browserTools } from "./tools.ts";
import { shutdown, workerFor, type StartOptions } from "./registry.ts";
import type { WorkerSpawn } from "./worker.ts";

export { formatSnapshot, MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_NAME, MAX_SNAPSHOT_NODES, MAX_SNAPSHOT_SCAN } from "./snapshot.ts";
export { browserTools, browserSubject, checkArguments, shapeResult, toolDescription, schemaOf, b64Valid, ACTIONS, MAX_SCREENSHOT_PNG, type BrowserAction } from "./tools.ts";
export { publicHttpsShape } from "./url.ts";
export { BrowserWorker, BRIDGE, managedProfile, prepareProfile, workerCommand, workerEnvironment, MAX_REQUEST, MAX_RESPONSE, type WorkerSpawn } from "./worker.ts";
export { currentWorker, heldElsewhere, shutdown as shutdownBrowser, withBrowserLock, workerFor } from "./registry.ts";
export { createBrowserHttp, ownsBrowserRoute, type BrowserHttp, type BrowserHttpOptions, type BrowserReply } from "./http-api.ts";

export interface BrowserOptions extends StartOptions {
  stateDir: string;
  /** Tests replace the scoped spawn; production uses the plugin's own `ctx.spawn`. */
  spawn?: WorkerSpawn;
}

/** A worker scope per process tree: the scope's end kills the whole group. */
function scopedSpawn(ctx: Context): WorkerSpawn {
  return (file, args, options) => {
    const scope = ctx.fork("browser-worker");
    try {
      const child = scope.spawn(file, args, { ...options, stdio: ["pipe", "pipe", "ignore"], killGraceMs: 1000 });
      return { child, release: () => scope.dispose() };
    } catch (error) { void scope.dispose(); throw error; }
  };
}

export function createBrowser(options: BrowserOptions): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "browser", apply(ctx) {
    const spawn = options.spawn ?? scopedSpawn(ctx);
    for (const tool of browserTools({ worker: (root) => workerFor(options.stateDir, root, spawn, options) })) ctx.tool(tool);
    // `activate`: disabling the feature stops the state directory's worker.
    ctx.effect(() => () => shutdown(options.stateDir));
  } }) };
}

export const browser = createBrowser({ stateDir: "." });
export const browserPlugin = browser.plugin;

