/**
 * Manual ZCode compaction outside a run (`POST /api/sessions/:id/compact`). The summary
 * request is the same request view a run would send (prompt view, ZCode tool contracts,
 * compaction view), built from the session's own kernel tools and model selection.
 * Returns null when the session cannot use model compaction (lightweight runtime, no
 * usable provider, compaction disabled); the route then keeps its deterministic path.
 */
import { isDict, pySlice } from "@xueness/contracts";
import { kernelAgentHooks, promptContextExtension, toolContractExtension, type AgentContext, type AgentEvent, type AgentProvider, type ModelRequest, type Row } from "@xueness/agent";
import type { Context } from "@xueness/kernel";
import { compactSessionNow, zcodeCompactionActive, zcodeCompactionExtension } from "@xueness/plugin-providers";
import { sessionsRuntimeEventsExtension, sessionsCompactPersistenceExtension, type RuntimeSelection } from "@xueness/plugin-sessions";
import type { Session, SessionStore } from "@xueness/sessions";

export interface ManualCompactDeps {
  store: SessionStore;
  stateDir: string;
  enabled(id: string): boolean;
  resolveProvider(selection: RuntimeSelection, sid: string): AgentProvider;
  kernelFor(session: Session): Promise<Context>;
  signal: AbortSignal;
  onEvent?: (sessionId: string, event: AgentEvent) => unknown;
}

export async function manualModelCompact(deps: ManualCompactDeps, session: Session, instructions: string | null, source: string): Promise<Row | null> {
  if (!deps.enabled("providers")) return null;
  const sid = String(session.id);
  const selected = isDict(session.model_selection) ? session.model_selection : {};
  const text = (key: string): string | null => typeof selected[key] === "string" ? selected[key] as string : null;
  let provider: AgentProvider;
  try { provider = deps.resolveProvider({ providerId: text("provider_id"), model: text("model"), reasoningEffort: text("reasoning_effort"), runtimeProfile: typeof session.runtime_profile === "string" ? session.runtime_profile : null }, sid); }
  catch { return null; }
  if (!zcodeCompactionActive(session, provider)) return null;
  const kernel = await deps.kernelFor(session);
  const hooks = kernelAgentHooks(kernel, { enabled: deps.enabled, extensions: [] });
  const extensions = [sessionsRuntimeEventsExtension(), sessionsCompactPersistenceExtension(), promptContextExtension(), toolContractExtension(), zcodeCompactionExtension()];
  const context: AgentContext = { session, store: deps.store, provider, stateDir: deps.stateDir, root: String(session.root), signal: deps.signal, deadline: Infinity, options: {},
    async save() { await deps.store.save(session); }, enabled: deps.enabled, emit(event) {
      for (const extension of extensions) if (deps.enabled(extension.id)) extension.recordEvent?.(context, event);
      try { deps.onEvent?.(sid, event); } catch { /* observational */ }
    } };
  for (const extension of extensions) if (deps.enabled(extension.id)) await extension.beforeRun?.(context);
  const rebuild = async (journal: Row[]): Promise<ModelRequest> => {
    const tools = (await hooks.tools(context)).filter((schema) => {
      const name = isDict(schema.function) ? schema.function.name : null;
      const owner = typeof name === "string" ? hooks.toolOwner(name) : null;
      return owner !== null && deps.enabled(owner);
    });
    let request: ModelRequest = { messages: journal, tools: [...tools], options: {}, hostInstructions: [], repair: null };
    for (const extension of extensions) if (extension.prepareRequest && deps.enabled(extension.id)) request = await extension.prepareRequest(context, request);
    return request;
  };
  const before = Array.isArray(session.messages) ? session.messages.length : 0;
  const result = await compactSessionNow(context, rebuild, instructions);
  const record = result.record;
  return { ok: true, session: sid, manual: true, source, kind: "zcode", compacted: result.compacted, ...result.reason ? { reason: result.reason } : {}, displayText: result.displayText,
    before: result.before, ...result.after ? { after: result.after } : { after: { estimatedTokens: result.before.estimatedTokens, messages: before } },
    ...result.summarizedMessageCount !== undefined ? { summarizedMessageCount: result.summarizedMessageCount } : {},
    instructions: { provided: instructions !== null, chars: instructions?.length ?? 0, digest: instructions ? pySlice(instructions, 200) : null },
    compactions: record ? [record] : [] };
}
