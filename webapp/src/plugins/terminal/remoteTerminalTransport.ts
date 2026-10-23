import type { TerminalApi } from './terminalSessionRegistry';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';

/** Never routes a remote terminal ID through the local terminal broker. */
export function createRemoteTerminalTransport(adapter: Pick<RemoteSessionAdapter, 'request'>, enabled: () => boolean = () => true, storage?: Pick<Storage, 'getItem' | 'setItem'>): TerminalApi {
  const sessions = new Map<string, string>();
  const retired = new Set<string>();
  const openingIds = new Map<string, string>();
  const pending = new Map<string, string>();
  try {
    const saved = JSON.parse(storage?.getItem('cleanup') || '[]');
    if (Array.isArray(saved)) for (const row of saved.slice(0, 128)) {
      if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row[0]) && typeof row[1] === 'string' && row[1].length > 0 && row[1].length <= 256) pending.set(row[0], row[1]);
    }
  } catch { /* In-memory cleanup remains available. */ }
  const savePending = () => { try { storage?.setItem('cleanup', JSON.stringify([...pending])); } catch { /* Keep in memory. */ } };
  const forget = (openId: string) => { pending.delete(openId); savePending(); };
  const lookup = async (openId: string, sessionId: string) => {
    const result = await adapter.request('terminal/list', { cleanupOpenId: openId }, undefined, () => true) as { terminals?: {id: string; session_id: string; openId?: string}[] };
    if (!Array.isArray(result?.terminals) || result.terminals.length > 1 || result.terminals.some(t => !t || t.openId !== openId || t.session_id !== sessionId || !/^[a-f0-9]{32}$/.test(t.id))) throw new Error('Invalid remote terminal cleanup receipt');
    return result.terminals[0];
  };
  const request = (method: string, params: Record<string, unknown>, signal?: AbortSignal, current: () => boolean = () => true) => adapter.request('terminal/' + method, params, signal, method === 'close' ? () => true : () => enabled() && current() && (typeof params.terminalId !== 'string' || !retired.has(params.terminalId)));
  const target = (id: string) => {
    const sessionId = sessions.get(id);
    if (!sessionId) throw new Error('Remote terminal owner is unavailable');
    return { sessionId, terminalId: id };
  };
  return {
    hasPendingCleanup: () => pending.size > 0,
    async reconcilePending() {
      for (const [openId, sessionId] of [...pending]) {
        const result = await adapter.request('terminal/cancel-open', { sessionId, openId }, undefined, () => true) as {ok?: boolean; cancelled?: boolean; openId?: string; sessionId?: string};
        if (result?.ok !== true || result.cancelled !== true || result.openId !== openId || result.sessionId !== sessionId) throw new Error('Remote terminal cleanup is unconfirmed');
        forget(openId);
      }
    },
    async list() {
      const value = await request('list', {}) as { terminals: (Awaited<ReturnType<TerminalApi['list']>>['terminals'][number] & { openId: string })[] };
      if (!value || !Array.isArray(value.terminals) || value.terminals.length > 4
        || value.terminals.some(t => !t || typeof t.id !== 'string' || !/^[a-f0-9]{32}$/.test(t.id)
          || typeof t.session_id !== 'string' || !t.session_id || typeof t.closed !== 'boolean' || typeof t.openId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(t.openId))) throw new Error('Invalid remote terminal listing');
      for (const row of value.terminals) { sessions.set(row.id, row.session_id); openingIds.set(row.id, row.openId); }
      return value;
    },
    async open(sessionId, current = () => true) {
      if (pending.size >= 128) throw new Error('Resolve pending remote terminal cleanup before opening another terminal');
      const openId = crypto.randomUUID();
      pending.set(openId, sessionId); savePending();
      let value: { id: string; session_id: string };
      try { value = await request('open', { sessionId, open: true, openId }, undefined, current) as typeof value; }
      catch (error) {
        if (error && typeof error === 'object' && 'requestNotSent' in error && error.requestNotSent === true) { forget(openId); throw error; }
        // A response can disappear after spawning. Discover only this exact
        // explicit opening; never retry a shell creation or adopt another tab.
        let recovered: typeof value | undefined;
        try {
          recovered = await lookup(openId, sessionId);
        } catch { /* Preserve the original unknown outcome. */ }
        if (!recovered) throw error;
        value = recovered;
      }
      if (!value || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || value.session_id !== sessionId) throw new Error('Invalid remote terminal owner');
      sessions.set(value.id, sessionId);
      openingIds.set(value.id, openId);
      forget(openId);
      return value;
    },
    async poll(id, cursor, signal) {
      const value = await request('read', { ...target(id), cursor }, signal) as Awaited<ReturnType<TerminalApi['poll']>> & {id: string; session_id: string};
      if (!value || value.id !== id || value.session_id !== target(id).sessionId || typeof value.data !== 'string'
        || value.data.length > 87384 || typeof value.closed !== 'boolean' || typeof value.truncated !== 'boolean') throw new Error('Invalid remote terminal output');
      return value;
    },
    input: (id, text) => request('input', { ...target(id), text }),
    resize: (id, cols, rows) => request('resize', { ...target(id), cols, rows }),
    async close(id) {
      retired.add(id);
      const params = target(id), openId = openingIds.get(id);
      if (!openId) throw new Error('Remote terminal cleanup identity is unavailable');
      pending.set(openId, params.sessionId); savePending();
      const result = await request('close', params) as {ok?: boolean};
      if (result?.ok !== true) throw new Error('Remote terminal close is unconfirmed');
      forget(openId);
      return result;
    },
  };
}
