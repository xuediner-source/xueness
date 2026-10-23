/** Existing session authorization plus native script-workflow operations. */
import { isDict, PyValueError } from '@xueness/contracts';
import { compileDynamicWorkflow } from './dynamic-compile.ts';
import { DynamicServiceError, type DynamicWorkflowService } from './dynamic-service.ts';

const BASE = '/api/sessions/:id/workflow-scripts';
export const DYNAMIC_WORKFLOW_ROUTES = [
  `GET ${BASE}`, `POST ${BASE}`, `POST ${BASE}/compile`, `GET ${BASE}/:runId`, `GET ${BASE}/:runId/events`,
  ...['start', 'resume', 'cancel', 'concurrency', 'resolve', 'amend', 'recover'].map(op => `POST ${BASE}/:runId/${op}`),
];
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
};
export function createDynamicWorkflowApi(service: DynamicWorkflowService) {
  const owns = (_method: string, parts: readonly string[]) => parts[0] === 'api' && parts[1] === 'sessions' && /^[a-f0-9]{32}$/.test(parts[2] ?? '') && parts[3] === 'workflow-scripts';
  return { routes: DYNAMIC_WORKFLOW_ROUTES, owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown> = {}, data: unknown = {}): Promise<[number, unknown] | null> {
      if (!owns(method, parts)) return null;
      const sid = parts[2]!, id = parts[4]!, op = parts[5], body = isDict(data) ? data : {};
      try {
        if (parts.length === 4) {
          if (method === 'GET') return [200, { runs: await service.list(sid) }];
          if (method === 'POST') {
            if (body.writable !== undefined && typeof body.writable !== 'boolean') throw new TypeError('writable must be a boolean');
            return [200, await service.create(sid, text(body.source, 'source'), {
              ...body.name === undefined ? {} : { name: text(body.name, 'name') },
              ...body.maxConcurrency === undefined ? {} : { maxConcurrency: body.maxConcurrency as number },
              ...body.writable === undefined ? {} : { writable: body.writable as boolean },
            })];
          }
          return [405, { error: 'method not allowed' }];
        }
        if (parts.length === 5 && id === 'compile' && method === 'POST') {
          // list checks the same owner and plugin gates, without making a run.
          await service.list(sid);
          const compiled = compileDynamicWorkflow(text(body.source, 'source'));
          return [200, { ok: !compiled.diagnostics.length, diagnostics: compiled.diagnostics, sites: compiled.sites, schemas: Object.fromEntries(compiled.schemas) }];
        }
        if (!/^[a-f0-9]{32}$/.test(id)) return [404, { error: 'workflow not found' }];
        if (parts.length === 5 && method === 'GET') return [200, await service.get(sid, id)];
        if (parts.length === 6 && op === 'events' && method === 'GET') {
          const run = await service.get(sid, id), after = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
          if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('afterSeq must be a non-negative integer');
          const oldestSeq = run.events[0]?.seq ?? 0;
          return [200, { runId: id, status: run.status, oldestSeq, gap: after > 0 && after < oldestSeq - 1, events: run.events.filter(event => event.seq > after) }];
        }
        if (parts.length !== 6 || method !== 'POST') return [405, { error: 'method not allowed' }];
        if (op === 'start' || op === 'resume') {
          if (body.allowReal !== undefined && typeof body.allowReal !== 'boolean') throw new TypeError('allowReal must be a boolean');
          return [200, await service.start(sid, id, { digest: text(body.digest, 'digest'), confirmed: body.confirmed === true, allowReal: body.allowReal === true })];
        }
        if (op === 'cancel') return [200, await service.cancel(sid, id)];
        if (op === 'recover') return [200, await service.recover(sid, id)];
        if (op === 'concurrency') return [200, await service.concurrency(sid, id, body.maxConcurrency as number)];
        if (op === 'amend') return [200, await service.amend(sid, id, text(body.source, 'source'))];
        if (op === 'resolve') return [200, await service.resolve(sid, id, text(body.nodeId, 'nodeId'), body.answer)];
        return [404, { error: 'workflow operation not found' }];
      } catch (error) {
        if (error instanceof DynamicServiceError) return [error.status, { error: error.message }];
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [404, { error: 'workflow or session not found' }];
        if (error instanceof TypeError || error instanceof PyValueError || (error instanceof Error && 'diagnostics' in error)) {
          return [400, { error: error.message, ...'diagnostics' in error ? { diagnostics: error.diagnostics } : {} }];
        }
        throw error;
      }
    },
  };
}
