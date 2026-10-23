/** Assembly of native workflow actors and read-only workspace operations. */
import { join } from 'node:path';
import { appendUserTurn, answerSession, type AgentProvider, type Row } from '@xueness/agent';
import { formatSchemaIssues, validateSchema } from '@xueness/contracts';
import { createToolEnv, decodeText, detectEncoding, globTool, NodeWorkspaceFileSystem, runTool } from '@xueness/engine-tools';
import { createSessionsStore } from '@xueness/plugin-sessions';
import type { DynamicAskRequest, DynamicNode, DynamicWorkflowDriver, DynamicWorkflowRun } from '@xueness/plugin-workflows';
import type { SessionStore } from '@xueness/sessions';
import { createActorHost } from './workflow-actors.ts';

interface Options {
  stateDir: string;
  store: SessionStore;
  enabled(id: string): boolean;
  resolveProvider?(providerId: string | null, model: string | null): AgentProvider;
}
const actorDirectory = (state: string, run: DynamicWorkflowRun) => join(state, 'dynamic-workflows', run.id + '-sessions');
function promptFor(request: DynamicAskRequest): string {
  const persona = request.actor.persona.system ? `Actor persona:\n${request.actor.persona.system}\n\n` : '';
  const schema = request.schema ? '\n\nReturn only a JSON value conforming to this schema. Do not wrap it in Markdown:\n' + JSON.stringify(request.schema) : '';
  const prompt = persona + request.instructions + schema;
  if (Array.from(prompt).length > 5000) throw new TypeError('actor instructions and result schema exceed the existing 5000 character turn limit');
  return prompt;
}

export function createDynamicWorkflowDriver(options: Options): DynamicWorkflowDriver & { answer(run: DynamicWorkflowRun, node: DynamicNode, answer: string): Promise<void> } {
  const host = createActorHost({ stateDir: options.stateDir, enabled: options.enabled, ...options.resolveProvider ? { resolveProvider: options.resolveProvider } : {} });
  return {
    async ask(request) {
      const { run, actor, node, signal } = request;
      if (!run.allowReal || !options.enabled('providers') || !options.enabled('workflows')) return { status: 'paused', question: 'model execution is disabled' };
      const parent = await options.store.load(run.parentSessionId);
      const sessions = actorDirectory(options.stateDir, run);
      const store = createSessionsStore(sessions, { enabled: options.enabled });
      const prompt = promptFor(request);
      const existing = actor.sessionId ?? null;
      const sid = await host.ensureSession(prompt, run.root, existing, sessions);
      request.rememberSession(sid);
      let session = await store.load(sid);
      if (session.dynamic_workflow_node_id !== node.id) {
        if (existing) await appendUserTurn(session, store, prompt);
        session.dynamic_workflow_node_id = node.id;
        await store.save(session);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const writable = run.writable && parent.mode !== 'plan' && parent.permission_mode !== 'plan' && parent.read_only !== true;
        const result = await host.run({ prompt, root: run.root, sessionId: sid, writable,
          providerId: typeof parent.provider_id === 'string' ? parent.provider_id : null,
          model: actor.persona.model ?? (typeof parent.model === 'string' ? parent.model : null),
          context: null, timeoutSeconds: 300, sessions, signal,
          shouldStop: () => signal.aborted || !options.enabled('workflows') || !options.enabled('providers') });
        if (result.status === 'awaiting_user') return { status: 'awaiting_user', question: String(result.pending_question ?? '') };
        if (result.status !== 'completed' && result.status !== 'needs_review') return { status: 'paused', question: String(result.pause_reason ?? 'actor did not complete') };
        const completion = result.completion && typeof result.completion === 'object' ? result.completion as Row : {};
        const text = String(completion.summary ?? '');
        if (!request.schema) return { status: 'completed', value: text };
        let value: unknown, issues = 'Return a JSON value without Markdown.';
        try {
          value = JSON.parse(text);
          const invalid = validateSchema(request.schema, value);
          if (!invalid.length) return { status: 'completed', value };
          issues = formatSchemaIssues(invalid);
        } catch { /* The repair below belongs to this same typed ask. */ }
        if (attempt === 2) throw new TypeError('typed actor result did not conform after two repairs: ' + issues);
        session = await store.load(sid);
        await appendUserTurn(session, store, 'The typed result was rejected: ' + issues.slice(0, 2000) + '\nReturn only the corrected JSON value for the original task.');
      }
      throw new Error('typed actor did not settle');
    },
    async read(run, operation, args, signal) {
      if (!options.enabled('workflows') || !options.enabled('files')) throw new Error('workflow workspace reads require workflows and files');
      if (typeof args[0] !== 'string') throw new TypeError('workspace read requires a path or glob string');
      if (operation === 'files.read') {
        const fs = new NodeWorkspaceFileSystem({ cwd: run.root, roots: [run.root] });
        const { bytes } = await fs.readBinaryFile(args[0], 256 * 1024, { signal });
        return decodeText(bytes, detectEncoding(bytes)).text;
      }
      const env = createToolEnv({ cwd: run.root, artifactsDir: join(options.stateDir, 'dynamic-workflows'), signal });
      const result = await runTool(globTool, { pattern: args[0] }, env);
      if (!result.ok) throw new Error(result.output);
      return result.data?.files ?? [];
    },
    async answer(run, node, answer) {
      const actor = node.actorId ? run.actors[node.actorId] : undefined;
      if (!actor?.sessionId) throw new Error('actor session is unavailable');
      const store = createSessionsStore(actorDirectory(options.stateDir, run), { enabled: options.enabled });
      await answerSession(await store.load(actor.sessionId), store, answer);
    },
  };
}
