/** HTTP adapter for conversation rewind, composed by the sessions fork API. */
import { isPyOSError, isPyValueError, pyExceptionName, type Session } from '@xueness/sessions';
import type { SessionsApiOptions, SessionReply } from './http-api.ts';
import { validateWorkspace } from './queue-http.ts';
import { applyConversationRewind, conversationRewindTargets, RewindError } from './rewind.ts';
import { messageRevision } from './journal-http.ts';
import type { Row } from './fork-common.ts';
import { createSessionRuntimeEventLog } from './runtime-event-log.ts';

const SID = /^[0-9a-f]{32}$/;
export const REWIND_ROUTES = ['GET /api/sessions/:id/rewind-targets', 'POST /api/sessions/:id/rewind'];
export function ownsRewindRoute(method: string, parts: readonly string[]): boolean {
  return parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && SID.test(parts[2] ?? '')
    && (method === 'GET' && parts[3] === 'rewind-targets' || method === 'POST' && parts[3] === 'rewind');
}

export function createRewindApi(options: SessionsApiOptions) {
  const workspace = async (session: Session): Promise<void> => {
    try { await validateWorkspace(options, session as Row); }
    catch { throw new RewindError('session workspace is no longer permitted', 403); }
  };
  return { routes: REWIND_ROUTES, owns: ownsRewindRoute,
    async dispatch(method: string, parts: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!ownsRewindRoute(method, parts)) return null;
      if (!options.enabled('sessions')) return [403, { error: 'plugin disabled or dependency unavailable: sessions', plugin: 'sessions', code: 'plugin_disabled' }];
      const sid = parts[2]!;
      if (options.running?.has(sid)) return [409, { error: 'session run already in progress' }];
      if (method === 'POST') {
        try {
          const result = await applyConversationRewind(options.store, sid, data, async (session) => {
            if (options.running?.has(sid)) throw new RewindError('session run already in progress', 409);
            await workspace(session);
          }, (_session, rewind) => {
            createSessionRuntimeEventLog(options.stateDir, sid).append({ type: 'HistoryReset', payload: {
              reason: 'conversation_rewind', generation: rewind.generation, revision: rewind.revision,
              removedMessageIds: rewind.removedMessageIds,
            } });
          });
          return [200, result];
        } catch (error) {
          if (error instanceof RewindError) return [error.status, { error: error.message }];
          if (pyExceptionName(error) === 'BlockingIOError') return [409, { error: 'session is in use by another process' }];
          if (isPyOSError(error) || isPyValueError(error)) return [500, { error: 'cannot rewind session' }];
          throw error;
        }
      }
      let lease: Awaited<ReturnType<SessionsApiOptions['store']['lease']>>;
      try { lease = await options.store.lease(sid); }
      catch (error) { if (pyExceptionName(error) === 'BlockingIOError') return [409, { error: 'session is in use by another process' }]; throw error; }
      try {
        if (options.running?.has(sid)) return [409, { error: 'session run already in progress' }];
        let session: Session;
        try { session = await options.store.load(sid); }
        catch (error) { if (isPyOSError(error) || isPyValueError(error)) return [404, { error: 'session not found' }]; throw error; }
        try { await workspace(session); }
        catch (error) { if (error instanceof RewindError) return [error.status, { error: error.message }]; throw error; }
        const revision = messageRevision(session);
        return [200, { id: sid, revision, targets: conversationRewindTargets(session) }];
      } finally { await lease.release(); }
    } };
}
