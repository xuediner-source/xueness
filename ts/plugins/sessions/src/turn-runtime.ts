/** Sessions-owned turn snapshots and cold history hydration. */
import { randomBytes } from 'node:crypto';
import { TurnCommandRouter, TurnMachine, type AgentContext, type AgentExtension, type Row, type TurnState } from '@xueness/agent';
import { hydrateSessionToolHistory, projectSessionHistory } from './history-hydration.ts';

const isDict = (value: unknown): value is Row => typeof value === 'object' && value !== null;
/** The prompt that started this run; guide inputs are tracked separately as steering commands. */
function initiatingPromptId(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isDict(message) || message.role !== 'user') continue;
    if (message._input_kind === 'guide' || message._input_kind === 'background_notice') continue;
    const id = message._message_id ?? message._input_id ?? index;
    return String(id);
  }
  return null;
}

export function sessionsTurnRuntimeExtension(): AgentExtension {
  const machines = new WeakMap<AgentContext, TurnMachine>();
  const routers = new WeakMap<AgentContext, TurnCommandRouter>();
  const guideCursor = new WeakMap<AgentContext, number>();
  const counts = new WeakMap<AgentContext, { text: number; reasoning: number }>();
  const current = (context: AgentContext): TurnMachine => {
    let machine = machines.get(context);
    if (!machine) { machine = new TurnMachine(String(context.session.active_turn_id), randomBytes(16).toString('hex')); machine.start(); machines.set(context, machine); }
    return machine;
  };
  const currentRouter = (context: AgentContext): TurnCommandRouter => {
    let router = routers.get(context);
    if (!router) { router = new TurnCommandRouter(); routers.set(context, router); }
    return router;
  };
  /** Newly delivered guide inputs become steer_guide commands admitted at this boundary (C-WFL-01). */
  const routeGuides = (context: AgentContext, boundary: 'before_model_request' | 'before_final_response'): void => {
    const messages = Array.isArray(context.session.messages) ? context.session.messages as Row[] : [];
    const cursor = guideCursor.get(context) ?? 0;
    const router = currentRouter(context);
    for (let index = cursor; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isDict(message) || message._input_kind !== 'guide') continue;
      const id = message._message_id ?? message._input_id;
      if (id === undefined || id === null) continue;
      router.enqueue({ id: String(id), kind: 'steer_guide', prompt: String(message.content ?? ''), targetTurnId: message._turn_id ? String(message._turn_id) : null });
    }
    guideCursor.set(context, messages.length);
    router.admit(boundary);
  };
  const publish = async (context: AgentContext): Promise<void> => {
    const machine = current(context);
    const snapshot = machine.snapshot();
    context.session.runtime_turn = snapshot;
    context.session.runtime_command_queue = currentRouter(context).snapshot();
    await context.save();
    context.emit({ type: 'turn_phase', turnId: snapshot.id, traceId: snapshot.traceId, phase: snapshot.phase,
      requestCount: snapshot.requestCount, toolCallCount: snapshot.toolCallCount, resultType: snapshot.resultType });
  };
  const observeCounts = (context: AgentContext, info: Row): void => {
    const diagnostic = info.diagnostics as Row | undefined, before = counts.get(context);
    if (!diagnostic || !before) return;
    const state = current(context).state;
    if (typeof diagnostic.textChars === 'number') state.textChars = before.text + diagnostic.textChars;
    if (typeof diagnostic.reasoningChars === 'number') state.reasoningChars = before.reasoning + diagnostic.reasoningChars;
  };
  return { id: 'sessions', capabilities: ['sessions.turn_runtime', 'sessions.history_hydration'],
    async beforeRun(context) {
      const result = hydrateSessionToolHistory(context.session);
      if (result.restored || result.interrupted) await context.save();
    },
    async runStarted(context) {
      const machine = new TurnMachine(String(context.session.active_turn_id), randomBytes(16).toString('hex'));
      machine.start(); machines.set(context, machine);
      // The initiating prompt belongs to exactly this execution: claimed by turnId/traceId
      // before the run proceeds, so priority changes can neither drop nor duplicate it.
      const router = new TurnCommandRouter();
      routers.set(context, router);
      const promptId = initiatingPromptId((context.session.messages ?? []) as readonly unknown[]);
      if (promptId !== null) {
        router.enqueue({ id: promptId, kind: 'user_prompt', prompt: '', targetTurnId: machine.state.id });
        router.admit('before_run');
        router.claimFor(promptId, machine.state.id, machine.state.traceId);
      }
      guideCursor.set(context, Array.isArray(context.session.messages) ? (context.session.messages as Row[]).length : 0);
      await publish(context);
    },
    prepareRequest(_context, request) { return { ...request, messages: projectSessionHistory(request.messages) }; },
    async beforeModelRequest(context) { routeGuides(context, 'before_model_request'); },
    async modelRequestStarted(context) {
      const machine = current(context);
      counts.set(context, { text: machine.state.textChars, reasoning: machine.state.reasoningChars });
      machine.request(); await publish(context);
    },
    observeDelta(context, text, reasoning) {
      current(context).delta(text, reasoning);
      context.session.runtime_turn = current(context).snapshot();
    },
    modelRequestCompleted: observeCounts,
    modelRequestFailed: observeCounts,
    async afterModelResponse(context, response) { current(context).response(); await publish(context); return response; },
    async beforeFinalResponse(context, response) { routeGuides(context, 'before_final_response'); return false; },
    async toolsScheduled(context, calls) {
      current(context).schedule(calls.map(call => ({ id: String(call.id), name: String((call.function as Row).name) })));
      await publish(context);
    },
    async toolExecutionStarted(context, call) { current(context).executing(call.id); await publish(context); },
    async permissionRequested(context, callId) { current(context).permission(callId); await publish(context); },
    async toolResultRecorded(context, call, result) {
      const error = result.error as Row | undefined, data = result.data as Row | undefined;
      if (result.awaiting_approval || data?.awaitingApproval || error?.code === 'approval_required') current(context).permission(call.id);
      else current(context).result(call.id, result.ok === true);
      await publish(context);
    },
    async settleRun(context, returned) {
      const machine = machines.get(context); if (!machine) return;
      const router = routers.get(context);
      const status = context.session.status;
      machine.complete(!returned || status === 'provider_error' ? 'error_during_execution'
        : status === 'stopped' ? 'cancelled' : status === 'completed' || status === 'needs_review' ? 'success' : 'paused');
      // Cancel, pause and failure settle distinctly above; draining the command queue
      // releases the turn's claims, resets reminder state and settles back to idle.
      if (router) router.drain();
      const snapshot = machine.snapshot();
      const history = Array.isArray(context.session.runtime_turn_history) ? context.session.runtime_turn_history as TurnState[] : [];
      history.push(snapshot); history.splice(0, Math.max(0, history.length - 24)); context.session.runtime_turn_history = history;
      if (router) context.session.runtime_command_queue = router.snapshot();
      await publish(context);
      if (router?.idle) context.emit({ type: 'turn_phase', turnId: snapshot.id, traceId: snapshot.traceId, phase: 'idle', requestCount: snapshot.requestCount, toolCallCount: snapshot.toolCallCount, resultType: snapshot.resultType, commandQueueIdle: true });
    },
    close(context) { machines.delete(context); routers.delete(context); guideCursor.delete(context); counts.delete(context); },
  };
}
