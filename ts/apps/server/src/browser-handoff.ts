/**
 * Browser HTTP routes (runtime, data, profiles and side-panel tabs) answered by
 * the TS browser plugin. Round 10 removed the Python backend, so no route is
 * released or forwarded any more; without a workspace fence tab opens are
 * refused by `createBrowserHttp` itself.
 */
import { isDict } from "@xueness/contracts";
import { createBrowserHttp, ownsBrowserRoute, type BrowserHttpOptions } from "@xueness/plugin-browser";

type Parts = readonly string[];

export interface BrowserHandoffOptions extends BrowserHttpOptions {}

export function createBrowserHandoff(options: BrowserHandoffOptions) {
  const http = createBrowserHttp(options);
  return {
    owns(_method: string, parts: Parts): boolean { return ownsBrowserRoute(parts); },
    dispatch(method: string, parts: Parts, data: unknown): Promise<[number, Record<string, unknown>] | null> {
      return Promise.resolve(http.dispatch(method, parts, isDict(data) ? data : {}));
    },
  };
}
