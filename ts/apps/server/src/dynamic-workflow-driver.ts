/** Assembly of native workflow actors, model tiers, and trajectory reads. */
import { join } from 'node:path';
import { appendUserTurn, answerSession, type AgentProvider, type Row } from '@xueness/agent';
import { formatSchemaIssues, validateSchema } from '@xueness/contracts';
import { createToolEnv, decodeText, detectEncoding, globTool, NodeWorkspaceFileSystem, runTool } from '@xueness/engine-tools';
import { ProfileStore } from '@xueness/plugin-providers';
import { createSessionsStore } from '@xueness/plugin-sessions';
import type {
  DynamicAskRequest, DynamicNode, DynamicTrajectoryEntry, DynamicTrajectoryFilter,
  DynamicWorkflowDriver, DynamicWorkflowRun,
} from '@xueness/plugin-workflows';
import type { SessionStore } from '@xueness/sessions';
import { createActorHost } from './workflow-actors.ts';

interface Options {
  stateDir: string;
  store: SessionStore;
  enabled(id: string): boolean;
  resolveProvider?(providerId: string | null, model: string | null): AgentProvider;
}

const MAX_PROMPT_CHARS = 32_000;
const actorDirectory = (state: string, run: DynamicWorkflowRun) => join(state, 'dynamic-workflows', run.id + '-sessions');

function promptFor(request: DynamicAskRequest): string {
  const roleLine = request.actor.persona.role ? `Actor role: ${request.actor.persona.role}\n` : '';
  const persona = request.actor.persona.system ? `Actor instructions:\n${request.actor.persona.system}\n\n` : (roleLine ? '\n' : '');
  const schema = request.schema ? '\n\nReturn only a JSON value conforming to this schema. Do not wrap it in Markdown:\n' + JSON.stringify(request.schema) : '';
  const prompt = roleLine + persona + request.instructions + schema;
  if (Array.from(prompt).length > MAX_PROMPT_CHARS) {
    throw new TypeError(`actor instructions and result schema exceed the ${MAX_PROMPT_CHARS} character turn limit`);
  }
  return prompt;
}

const TIER_PATTERNS: Record<string, RegExp[]> = {
  flash_lite: [/flash[-_.]?lite|haiku|mini|nano/i, /flash/i],
  flash: [/flash(?!.*lite)|sonnet|mini|haiku/i],
  pro: [/\bpro\b|opus|thinking|reasoner|gpt-5/i],
};

function resolveActorModel(
  stateDir: string,
  requested: string | undefined,
  parentProviderId: string | null,
  parentModel: string | null,
  canResolve: (providerId: string | null, model: string | null) => boolean,
): { providerId: string | null; model: string | null } {
  const spec = requested?.trim();
  if (!spec || spec === 'inherit') return { providerId: parentProviderId, model: parentModel };

  const profiles = new ProfileStore(stateDir).list();
  if (spec in TIER_PATTERNS) {
    const patterns = TIER_PATTERNS[spec]!;
    for (const pattern of patterns) {
      const sameProvider = profiles.find((p) => p.id === parentProviderId && typeof p.model === 'string' && pattern.test(p.model));
      if (sameProvider && typeof sameProvider.id === 'string' && typeof sameProvider.model === 'string' && canResolve(sameProvider.id, sameProvider.model)) {
        return { providerId: sameProvider.id, model: sameProvider.model };
      }
      const anyProfile = profiles.find((p) => typeof p.model === 'string' && pattern.test(p.model));
      if (anyProfile && typeof anyProfile.id === 'string' && typeof anyProfile.model === 'string' && canResolve(anyProfile.id, anyProfile.model)) {
        return { providerId: anyProfile.id, model: anyProfile.model };
      }
    }
    if (parentProviderId === 'magpie' && parentModel?.startsWith('agy-cli/')) {
      const magpieCandidate = spec === 'flash_lite'
        ? 'agy-cli/gemini-3.8-flash-lite'
        : spec === 'flash'
          ? 'agy-cli/gemini-3.8-flash'
          : 'agy-cli/gemini-3.1-pro-high';
      if (canResolve('magpie', magpieCandidate)) return { providerId: 'magpie', model: magpieCandidate };
    }
    return { providerId: parentProviderId, model: parentModel };
  }

  const byProfileId = profiles.find((p) => p.id === spec || p.name === spec);
  if (byProfileId && typeof byProfileId.id === 'string') {
    return { providerId: byProfileId.id, model: typeof byProfileId.model === 'string' ? byProfileId.model : parentModel };
  }
  const colonIdx = spec.indexOf(':');
  if (colonIdx > 0) {
    const prefix = spec.slice(0, colonIdx);
    const rest = spec.slice(colonIdx + 1);
    if (rest && (prefix === 'magpie' || profiles.some((p) => p.id === prefix))) {
      return { providerId: prefix, model: rest };
    }
  }
  if (spec.startsWith('agy-cli/') && canResolve('magpie', spec)) {
    return { providerId: 'magpie', model: spec };
  }
  return { providerId: parentProviderId, model: spec };
}

function clipText(value: unknown, max = 1500): string {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return Array.from(raw).length <= max ? raw : Array.from(raw).slice(0, max - 1).join('') + '…';
}

function collectTrajectory(messages: readonly unknown[], filter?: DynamicTrajectoryFilter): DynamicTrajectoryEntry[] {
  const entries: DynamicTrajectoryEntry[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';
    if (role === 'user') {
      entries.push({ index: entries.length, type: 'user', role: 'user', text: clipText(msg.content) });
    } else if (role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        entries.push({ index: entries.length, type: 'assistant', role: 'assistant', text: clipText(msg.content) });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const rawCall of msg.tool_calls) {
          if (!rawCall || typeof rawCall !== 'object') continue;
          const fn = (rawCall as { function?: { name?: unknown; arguments?: unknown } }).function;
          const tool = typeof fn?.name === 'string' ? fn.name : 'unknown';
          entries.push({ index: entries.length, type: 'tool_call', role: 'assistant', tool, status: 'ok', text: clipText(fn?.arguments) });
        }
      }
    } else if (role === 'tool') {
      const tool = typeof msg.name === 'string' ? msg.name : typeof msg.tool_name === 'string' ? msg.tool_name : undefined;
      const isErr = msg.is_error === true || msg.ok === false;
      entries.push({
        index: entries.length,
        type: 'tool_result',
        role: 'tool',
        ...(tool ? { tool } : {}),
        status: isErr ? 'error' : 'ok',
        text: clipText(msg.content),
      });
    }
  }
  const filtered = entries.filter((entry) => {
    if (filter?.types?.length && !filter.types.includes(entry.type)) return false;
    if (filter?.tools?.length && (!entry.tool || !filter.tools.includes(entry.tool))) return false;
    if (filter?.status && entry.status !== filter.status) return false;
    return true;
  });
  const limit = filter?.last ?? 40;
  return filtered.slice(-limit);
}

export function createDynamicWorkflowDriver(options: Options): DynamicWorkflowDriver & { answer(run: DynamicWorkflowRun, node: DynamicNode, answer: string): Promise<void> } {
  const host = createActorHost({ stateDir: options.stateDir, enabled: options.enabled, ...options.resolveProvider ? { resolveProvider: options.resolveProvider } : {} });
  const canResolve = (providerId: string | null, model: string | null): boolean => {
    try { if (!host.bucket) return false; host.bucket(providerId, model); return true; } catch { return false; }
  };
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
      const selection = resolveActorModel(
        options.stateDir,
        actor.persona.model,
        typeof parent.provider_id === 'string' ? parent.provider_id : null,
        typeof parent.model === 'string' ? parent.model : null,
        canResolve,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const writable = run.writable && parent.mode !== 'plan' && parent.permission_mode !== 'plan' && parent.read_only !== true;
        const result = await host.run({ prompt, root: run.root, sessionId: sid, writable,
          providerId: selection.providerId,
          model: selection.model,
          context: null, timeoutSeconds: 300, sessions, signal, runId: run.id,
          shouldStop: () => signal.aborted || !options.enabled('workflows') || !options.enabled('providers') });
        if (result.status === 'awaiting_user') return { status: 'awaiting_user', question: String(result.pending_question ?? '') };
        if (result.status !== 'completed' && result.status !== 'needs_review') return { status: 'paused', question: String(result.pause_reason ?? 'actor did not complete') };
        const completion = result.completion && typeof result.completion === 'object' ? result.completion as Row : {};
        const text = String(completion.summary ?? '');
        if (!request.schema) return { status: 'completed', value: text };
        let value: unknown, issues = 'Return a JSON value without Markdown.';
        try {
          const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          value = JSON.parse(stripped);
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
    async trajectory(run, filter, signal) {
      signal.throwIfAborted();
      const parent = await options.store.load(run.parentSessionId);
      const messages = Array.isArray(parent.messages) ? parent.messages : [];
      return collectTrajectory(messages, filter);
    },
    async answer(run, node, answer) {
      const actor = node.actorId ? run.actors[node.actorId] : undefined;
      if (!actor?.sessionId) throw new Error('actor session is unavailable');
      const store = createSessionsStore(actorDirectory(options.stateDir, run), { enabled: options.enabled });
      await answerSession(await store.load(actor.sessionId), store, answer);
    },
  };
}
