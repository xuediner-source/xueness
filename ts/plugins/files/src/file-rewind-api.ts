import { isDict } from '@xueness/contracts';
import { isPyOSError, isPyValueError, pyExceptionName, type Session, type SessionStore } from '@xueness/sessions';
import { applyFileRewind, FileRewindError, previewFileRewind } from './file-rewind.ts';
type Row = Record<string, unknown>;
type Reply = [number, unknown];
export interface FileRewindOptions {
  store: SessionStore; stateDir: string; enabled(id: string): boolean;
  validateSession(session: Session): Promise<void>; revision(session: Session): string;
  onApplied?(session: Session, result: Row): void;
}
export function createFileRewindApi(o: FileRewindOptions) {
  const owns = (_method: string, parts: readonly string[]) => parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && /^[0-9a-f]{32}$/.test(parts[2] ?? '') && parts[3] === 'file-rewind';
  return { owns, routes: ['GET /api/sessions/:id/file-rewind', 'POST /api/sessions/:id/file-rewind'],
    async dispatch(method: string, parts: string[], query: Row, data: unknown): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!['GET', 'POST'].includes(method)) return [405, { error: 'method not allowed' }];
      if (!o.enabled('sessions') || !o.enabled('files')) return [403, { error: 'sessions and files must be enabled' }];
      const sid = parts[2]!; let held: Awaited<ReturnType<SessionStore['lease']>> | undefined;
      try {
        if (method === 'POST') held = await o.store.lease(sid);
        const session = await o.store.load(sid); await o.validateSession(session);
        if (session.remote_connection) return [409, { error: 'Remote file rewind is unavailable' }];
        const body = method === 'POST' && isDict(data) ? data : query;
        const messageId = Array.isArray(body.messageId) ? body.messageId[0] : body.messageId;
        if (typeof messageId !== 'string') return [400, { error: 'messageId is required' }];
        const revision = o.revision(session);
        if (method === 'GET') return [200, { ...await previewFileRewind(o.stateDir, session, messageId), revision }];
        if (body.confirmed !== true) return [400, { error: 'confirmed: true is required to apply the previewed file rewind' }];
        if (body.revision !== revision) return [409, { error: 'session changed; request a new preview' }];
        if (session.permission_mode === 'plan' || session.mode === 'plan') return [403, { error: 'File rewind is unavailable in plan mode' }];
        const result = await applyFileRewind(o.store, o.stateDir, session, messageId);
        o.onApplied?.(session, result);
        return [200, result];
      } catch (error) {
        if (error instanceof FileRewindError) return [error.status, { error: error.message }];
        if (pyExceptionName(error) === 'BlockingIOError') return [409, { error: 'session is running' }];
        if (isPyValueError(error)) return [400, { error: (error as Error).message }];
        if (isPyOSError(error)) return [404, { error: 'session or file history unavailable' }];
        throw error;
      } finally { await held?.release(); }
    },
  };
}
