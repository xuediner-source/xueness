/** Sessions-owned turn snapshots and cold history hydration. */
import { randomBytes } from 'node:crypto';
import { TurnMachine, type AgentContext, type AgentExtension, type Row, type TurnState } from '@xueness/agent';
import { hydrateSessionToolHistory, projectSessionHistory } from './history-hydration.ts';

export function sessionsTurnRuntimeExtension(): AgentExtension {
  const machines = new WeakMap<AgentContext, TurnMachine>();
  const counts = new WeakMap<AgentContext, { text: number; reasoning: number }>();
  const current = (context: AgentContext): TurnMachine => {
    let machine = machines.get(context);
    if (!machine) { machine = new TurnMachine(String(context.session.active_turn_id), randomBytes(16).toString('hex')); machine.start(); machines.set(context, machine); }
    return machine;
  };
  const publish = async (context: AgentContext): Promise<void> => {
    const snapshot = current(context).snapshot();
    context.session.runtime_turn = snapshot;
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
      machine.start(); machines.set(context, machine); await publish(context);
    },
    prepareRequest(_context, request) { return { ...request, messages: projectSessionHistory(request.messages) }; },
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
      const status = context.session.status;
      machine.complete(!returned || status === 'provider_error' ? 'error_during_execution'
        : status === 'stopped' ? 'cancelled' : status === 'completed' || status === 'needs_review' ? 'success' : 'paused');
      const snapshot = machine.snapshot();
      const history = Array.isArray(context.session.runtime_turn_history) ? context.session.runtime_turn_history as TurnState[] : [];
      history.push(snapshot); history.splice(0, Math.max(0, history.length - 24)); context.session.runtime_turn_history = history;
      await publish(context);
    },
    close(context) { machines.delete(context); counts.delete(context); },
  };
}
