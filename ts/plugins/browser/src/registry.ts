/**
 * One worker per state directory (Python `_BROKERS` under `_BROKERS_LOCK`).
 * Every TS session environment shares it, as every Python request thread did.
 * `shutdown` is what plugin disable, profile clear/import and server exit call;
 * `heldElsewhere` reports a live Chromium on the profile that this process does not own
 * (the Python backend's side-panel tabs), so a run can stay with that owner.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, openSync, closeSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BrowserWorker, managedProfile, type WorkerSpawn } from "./worker.ts";
import { browserStateKey, browserTabKeys, clearBrowserTabs } from "./tabs-state.ts";

interface Entry { worker: BrowserWorker | null; lock: Promise<unknown> }
const entries = new Map<string, Entry>();
/** Re-entrant like Python's `RLock`: a tab action holds it across `workerFor`. */
const holders = new AsyncLocalStorage<Set<Entry>>();

function entryOf(stateDir: string): Entry {
  const key = browserStateKey(stateDir);
  let entry = entries.get(key);
  if (!entry) { entry = { worker: null, lock: Promise.resolve() }; entries.set(key, entry); }
  return entry;
}
function locked<T>(entry: Entry, body: () => Promise<T>): Promise<T> {
  if (holders.getStore()?.has(entry)) return body();
  const held = holders.getStore();
  const run = entry.lock.catch(() => {}).then(() => {
    const next = new Set(held);
    next.add(entry);
    return holders.run(next, body);
  });
  entry.lock = run;
  return run;
}

/** Serialize profile clear, import and tab mutations with worker start/stop. */
export function withBrowserLock<T>(stateDir: string, body: () => Promise<T>): Promise<T> {
  return locked(entryOf(stateDir), body);
}

export interface StartOptions { env?: NodeJS.ProcessEnv; bridge?: string; startTimeoutMs?: number; callTimeoutMs?: number }

/** `_broker`: the running worker, or a fresh one after the old one stopped. */
export function workerFor(stateDir: string, root: string, spawn: WorkerSpawn, options: StartOptions = {}): Promise<BrowserWorker> {
  const entry = entryOf(stateDir);
  return locked(entry, async () => {
    if (entry.worker?.running) return entry.worker;
    if (entry.worker) { const old = entry.worker; entry.worker = null; await old.close(); }
    entry.worker = await BrowserWorker.start(stateDir, root, spawn, options);
    return entry.worker;
  });
}

/** The live worker without starting one (closing a page must never launch a browser). */
export function currentWorker(stateDir: string): BrowserWorker | null {
  const worker = entries.get(browserStateKey(stateDir))?.worker ?? null;
  return worker?.running ? worker : null;
}

async function stopOne(stateDir: string): Promise<void> {
  const entry = entryOf(stateDir);
  await locked(entry, async () => {
    // Drop page ids before the process that owned them exits (Python `clear_state` inside `shutdown`).
    clearBrowserTabs(stateDir);
    const worker = entry.worker; entry.worker = null;
    if (worker) { await worker.idle(); await worker.close(); }
  });
}

/** Stop this process's worker for one state directory (or all), after calls in flight settle. */
export async function shutdown(stateDir?: string): Promise<void> {
  if (stateDir === undefined) {
    const keys = new Set<string>([...entries.keys(), ...browserTabKeys()]);
    await Promise.all([...keys].map((key) => stopOne(key)));
    clearBrowserTabs();
    return;
  }
  await stopOne(stateDir);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** Chromium's profile singleton is held by a live process this registry did not start. */
export function heldElsewhere(stateDir: string): boolean {
  if (currentWorker(stateDir)) return false;
  let profile: string;
  try { profile = managedProfile(stateDir); } catch { return false; }
  if (process.platform === "win32") {
    // Chromium keeps `lockfile` open without sharing while the profile is in use.
    const lock = join(profile, "lockfile");
    if (!existsSync(lock)) return false;
    try { closeSync(openSync(lock, "r+")); return false; } catch (error) { return ["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""); }
  }
  // POSIX: SingletonLock is a symlink to "<hostname>-<pid>".
  let target: string;
  try { target = readlinkSync(join(profile, "SingletonLock")); } catch { return false; }
  const dash = target.lastIndexOf("-"), pid = Number(target.slice(dash + 1));
  if (dash <= 0 || !Number.isSafeInteger(pid) || pid <= 0) return false;
  return target.slice(0, dash) === hostname() && alive(pid);
}
