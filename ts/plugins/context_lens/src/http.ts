import { isPyOSError, isPyValueError, type SessionStore } from '@xueness/sessions';
import { projectContextLens, sessionSummary } from './projection.ts';
import type { Row } from './types.ts';

export function createContextLensHttp(o: { store: SessionStore; enabled(id: string): boolean; owners?: ReadonlyMap<string, string>; live?(sid: string): Row | null; }) {
  const owns = (_method: string, p: readonly string[]) => p[0] === 'api' && p[1] === 'context-lens';
  const active = () => o.enabled('context_lens') && o.enabled('sessions');
  const disabled = (): [number, unknown] => [403, { error: 'context_lens plugin disabled or dependency unavailable', plugin: 'context_lens' }];
  return { routes: ['GET /api/context-lens/sessions', 'GET /api/context-lens/sessions/:id'], owns,
    async dispatch(method: string, p: readonly string[]): Promise<[number, unknown] | null> {
      if (!owns(method, p)) return null;
      if (!active()) return disabled();
      if (method !== 'GET') return [405, { error: 'method not allowed' }];
      if (p[2] !== 'sessions' || ![3, 4].includes(p.length)) return [404, { error: 'route not found' }];
      if (p.length === 4) {
        if (!/^[0-9a-f]{32}$/.test(p[3]!)) return [404, { error: 'session not found' }];
        try {
          const session = o.live?.(p[3]!) ?? await o.store.load(p[3]!);
          return active() ? [200, projectContextLens(session, o.owners)] : disabled();
        } catch (error) { if (isPyOSError(error) || isPyValueError(error)) return [404, { error: 'session unavailable' }]; throw error; }
      }
      const entries = await o.store.list(), summaries = [];
      for (const row of entries) {
        if (!active()) return disabled();
        try { summaries.push(sessionSummary(o.live?.(String(row.id)) ?? await o.store.load(String(row.id)))); }
        catch (error) { if (!isPyOSError(error) && !isPyValueError(error)) throw error; }
      }
      return active() ? [200, { sessions: summaries.sort((a, b) => b.lastAt.localeCompare(a.lastAt)) }] : disabled();
    } };
}
