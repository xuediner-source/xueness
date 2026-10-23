/** Model operations share the exact session-owned HTTP/service execution path. */
import type { JsonSchema } from '@xueness/contracts';
import type { ToolDefinition } from '@xueness/engine-tools';
import type { DynamicWorkflowService } from './dynamic-service.ts';
import type { Row } from './plan.ts';

const string: JsonSchema = { type: 'string', minLength: 1 };
const id: JsonSchema = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const source: JsonSchema = { type: 'string', minLength: 1, maxLength: 32000 };
const limit: JsonSchema = { type: 'integer', minimum: 1, maximum: 8 };
const schema = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
interface Options { service(): DynamicWorkflowService | undefined; session(): Row | null }
export function dynamicWorkflowTools(options: Options): ToolDefinition[] {
  const bound = (): { service: DynamicWorkflowService; sid: string } => {
    const service = options.service(), session = options.session();
    if (!service || typeof session?.id !== 'string') throw new TypeError('dynamic script workflow execution is unavailable in this host');
    return { service, sid: session.id };
  };
  const tool = (name: string, description: string, inputSchema: JsonSchema, exec: boolean, run: (service: DynamicWorkflowService, sid: string, input: Row) => Promise<unknown>): ToolDefinition<Row> => ({
    name, description, inputSchema, gate: exec ? 'exec' : 'planning', mutating: exec, concurrencySafe: false,
    requires: { fs: { read: ['state', 'workspace'], write: ['state'] }, ...name === 'workflow_script_run' ? { exec: ['*'] } : {} },
    subject: input => JSON.stringify(input),
    async run(input) { const { service, sid } = bound(); const data = await run(service, sid, input); return { ok: true, output: JSON.stringify(data), data }; },
  });
  return [
    tool('workflow_script_create', 'Compile a native TypeScript workflow subset and save a draft without execution. Supports agent.ask<T>, loops, Promise.all, files reads, report and hole. Inspect the returned digest before running.',
      schema({ source, name: string, maxConcurrency: limit, writable: { type: 'boolean' } }, ['source']), false,
      (service, sid, input) => service.create(sid, input.source as string, input)),
    tool('workflow_script_run', 'Start or explicitly resume the exact reviewed script digest in the background. Requires approval and explicit allowReal for actors; existing host/model permissions still apply.',
      schema({ runId: id, digest: string, allowReal: { type: 'boolean' } }, ['runId', 'digest']), true,
      (service, sid, input) => service.start(sid, input.runId as string, { digest: input.digest as string, confirmed: true, allowReal: input.allowReal === true })),
    tool('workflow_script_status', 'Read a script run, node results, pending questions and metadata events of this session.', schema({ runId: id }, ['runId']), false,
      (service, sid, input) => service.get(sid, input.runId as string)),
    tool('workflow_script_list', 'List native script runs owned by this session.', schema({}, []), false,
      (service, sid) => service.list(sid)),
    tool('workflow_script_cancel', 'Cancel a native script run and drain its actors without replaying completed work.', schema({ runId: id }, ['runId']), true,
      (service, sid, input) => service.cancel(sid, input.runId as string)),
    tool('workflow_script_concurrency', 'Change this script run concurrency from 1 to 8; actor asks remain FIFO.', schema({ runId: id, maxConcurrency: limit }, ['runId', 'maxConcurrency']), true,
      (service, sid, input) => service.concurrency(sid, input.runId as string, input.maxConcurrency as number)),
    tool('workflow_script_resolve', 'Resolve a pending hole with JSON data, or an actor question with a text answer. Leaves the run paused until explicitly resumed.',
      schema({ runId: id, nodeId: string, answer: {} }, ['runId', 'nodeId', 'answer']), true,
      (service, sid, input) => service.resolve(sid, input.runId as string, input.nodeId as string, input.answer)),
    tool('workflow_script_amend', 'Create a new reviewed draft from a settled run and edited source. Only matching readonly results in an unchanged workspace may be imported.',
      schema({ runId: id, source }, ['runId', 'source']), false,
      (service, sid, input) => service.amend(sid, input.runId as string, input.source as string)),
  ];
}
