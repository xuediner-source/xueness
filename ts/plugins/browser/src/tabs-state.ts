/**
 * Side-panel tab table (Python `tabs_api._STATES`). Keyed by the same
 * realpath as the worker registry. `shutdown` drops it so a cleared or
 * imported profile cannot keep an old page id or approval.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface TabReceipt { approvalId: string; action: string; approved: boolean; executed: boolean; ok?: boolean }
export interface TabPending { approvalId: string; subject: string; expiresAt: number }
export interface BrowserTab {
  pageId: string; workspaceId: string; sessionId: string; title: string; url: string;
  pending?: TabPending; receipts?: TabReceipt[];
}

const tabs = new Map<string, Map<string, BrowserTab>>();

/** Same directory identity the worker registry uses for its lock. */
export function browserStateKey(stateDir: string): string {
  try { return realpathSync(stateDir); } catch { return resolve(stateDir); }
}

export function browserTabKeys(): string[] { return [...tabs.keys()]; }

export function tabsFor(stateDir: string): Map<string, BrowserTab> {
  const key = browserStateKey(stateDir);
  let table = tabs.get(key);
  if (!table) { table = new Map(); tabs.set(key, table); }
  return table;
}

/** `clear_state`: one directory, or every directory when `shutdown()` is global. */
export function clearBrowserTabs(stateDir?: string): void {
  if (stateDir === undefined) { tabs.clear(); return; }
  tabs.delete(browserStateKey(stateDir));
}
