import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import type { BrowserApi, BrowserResult, BrowserTab } from './browserSessionRegistry';

/** No retry, reconnect, local fallback or nonce rewriting at this boundary. */
export function createRemoteBrowserTransport(adapter: RemoteSessionAdapter, workspace: string): BrowserApi {
  const pages = new Map<string, string>();
  const retired = new Set<string>();
  let unresolvedOpen = false;
  const request = (method: string, params: Record<string, unknown>, enabled: () => boolean = () => true) => {
    if (adapter.owner.capabilities.browserTabs !== true) throw new Error('Remote browser capability unavailable');
    return adapter.request('browser/' + method, params, undefined, ['close', 'cancel-open'].includes(method) ? () => true : () => enabled() && (typeof params.pageId !== 'string' || !retired.has(params.pageId)));
  };
  const descriptor = (value: unknown): BrowserTab => {
    const r = value as Partial<BrowserTab> | null;
    if (!r || typeof r.pageId !== 'string' || !/^[a-f0-9]{32}$/u.test(r.pageId)
      || r.workspaceId !== adapter.owner.workspaceIdentity || typeof r.sessionId !== 'string'
      || !/^[A-Za-z0-9_-]{1,160}$/u.test(r.sessionId) || typeof r.title !== 'string'
      || r.title.length > 500 || typeof r.url !== 'string' || r.url.length > 4096) throw new Error('Invalid remote browser binding');
    pages.set(r.pageId, r.sessionId);
    return { pageId: r.pageId, sessionId: r.sessionId, workspaceId: workspace, title: r.title, url: r.url };
  };
  const target = (pageId: string) => {
    const sessionId = pages.get(pageId);
    if (!sessionId) throw new Error('Unknown remote browser tab');
    return {pageId, sessionId};
  };
  return {
    remote: true,
    list: async enabled => {
      const result = await request('list', {}, enabled) as {tabs?: unknown[]};
      if (!result || !Array.isArray(result.tabs) || result.tabs.length > 8) throw new Error('Invalid remote browser inventory');
      const tabs = result.tabs.map(descriptor);
      if (new Set(tabs.map(tab => tab.pageId)).size !== tabs.length) throw new Error('Duplicate remote browser identity');
      return {tabs};
    },
    open: async (sessionId, enabled) => {
      if (unresolvedOpen) throw new Error('The previous browser opening is unconfirmed; reconnect explicitly before opening another tab');
      const openId = crypto.randomUUID().replaceAll('-', '');
      unresolvedOpen = true;
      try {
        const tab = descriptor(await request('open', {sessionId, openId}, enabled));
        if (tab.sessionId !== sessionId) throw new Error('Remote browser session changed');
        unresolvedOpen = false;
        return tab;
      } catch (error) {
        if (error && typeof error === 'object' && 'requestNotSent' in error && error.requestNotSent === true) unresolvedOpen = false;
        else {
          try {
            const result = await request('cancel-open', {sessionId, openId}) as {cancelled?: boolean; openId?: string};
            if (result?.cancelled === true && result.openId === openId) unresolvedOpen = false;
          } catch { /* Keep the original uncertain opening fenced until teardown. */ }
        }
        throw error;
      }
    },
    action: async (pageId, payload, enabled) => await request('action', {...target(pageId), payload}, enabled) as BrowserResult,
    cancel: async (pageId, payload, enabled) => await request('cancel', {...target(pageId), payload}, enabled) as {cancelled?: boolean; error?: string},
    close: async pageId => { retired.add(pageId); return request('close', target(pageId)); },
  };
}
