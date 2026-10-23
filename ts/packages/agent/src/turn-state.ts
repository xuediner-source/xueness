/** Compact turn lifecycle, adapted from ZCode agent/turn-state and turn-machine. */
export type TurnPhase = 'idle' | 'processing_input' | 'awaiting_model_response' | 'streaming' | 'scheduling_tools' | 'executing_tools' | 'aggregating_results' | 'awaiting_permission' | 'completing' | 'error';
export type TurnToolStatus = 'scheduled' | 'waiting_permission' | 'running' | 'completed' | 'failed';
export interface TurnToolState { id: string; name: string; status: TurnToolStatus }
export interface TurnState {
  id: string;
  traceId: string;
  phase: TurnPhase;
  startedAt: string;
  completedAt?: string;
  resultType?: 'success' | 'cancelled' | 'paused' | 'error_during_execution';
  requestCount: number;
  toolCallCount: number;
  textChars: number;
  reasoningChars: number;
  tools: TurnToolState[];
}
const transitions: Record<TurnPhase, readonly TurnPhase[]> = {
  idle: ['processing_input'],
  processing_input: ['awaiting_model_response', 'completing'],
  awaiting_model_response: ['streaming', 'completing', 'error'],
  streaming: ['scheduling_tools', 'aggregating_results', 'completing', 'error'],
  scheduling_tools: ['executing_tools', 'awaiting_permission', 'aggregating_results', 'error'],
  executing_tools: ['aggregating_results', 'awaiting_permission', 'error'],
  awaiting_permission: ['executing_tools', 'aggregating_results', 'error'],
  aggregating_results: ['awaiting_model_response', 'scheduling_tools', 'completing', 'error'],
  completing: [], error: [],
};
export const isTerminalTurnPhase = (phase: TurnPhase): boolean => phase === 'completing' || phase === 'error';
export const canTransitionTurn = (from: TurnPhase, to: TurnPhase): boolean => from === to || transitions[from].includes(to);

/** Mutates only its own compact snapshot; the driver retains execution authority. */
export class TurnMachine {
  readonly state: TurnState;
  constructor(id: string, traceId: string, now = new Date().toISOString()) {
    this.state = { id, traceId, phase: 'idle', startedAt: now, requestCount: 0, toolCallCount: 0, textChars: 0, reasoningChars: 0, tools: [] };
  }
  transition(phase: TurnPhase): void {
    if (!canTransitionTurn(this.state.phase, phase)) throw new Error(`Invalid turn phase: ${this.state.phase} -> ${phase}`);
    this.state.phase = phase;
  }
  start(): void { this.transition('processing_input'); }
  request(): void {
    if (this.state.phase === 'streaming') this.transition('aggregating_results');
    this.transition('awaiting_model_response'); this.state.requestCount += 1;
  }
  delta(text: string, reasoning = false): void {
    this.transition('streaming');
    this.state[reasoning ? 'reasoningChars' : 'textChars'] += text.length;
  }
  response(): void { this.transition('streaming'); }
  schedule(calls: readonly { id: string; name: string }[]): void {
    this.transition('scheduling_tools');
    this.state.tools = calls.map(call => ({ ...call, status: 'scheduled' }));
    this.state.toolCallCount += calls.length;
  }
  permission(id: string): void {
    const tool = this.state.tools.find(call => call.id === id);
    if (tool) tool.status = 'waiting_permission';
    this.transition('awaiting_permission');
  }
  executing(id: string): void {
    const tool = this.state.tools.find(call => call.id === id);
    if (tool) tool.status = 'running';
    this.transition('executing_tools');
  }
  result(id: string, ok: boolean): void {
    const tool = this.state.tools.find(call => call.id === id);
    if (tool) tool.status = ok ? 'completed' : 'failed';
    if (this.state.tools.every(call => call.status === 'completed' || call.status === 'failed')) this.transition('aggregating_results');
  }
  complete(result: NonNullable<TurnState['resultType']>, now = new Date().toISOString()): void {
    // Cancellation, host limits and local failures may settle from any active phase.
    this.state.phase = result === 'error_during_execution' ? 'error' : 'completing';
    this.state.resultType = result; this.state.completedAt = now;
  }
  snapshot(): TurnState { return { ...this.state, tools: this.state.tools.map(call => ({ ...call })) }; }
}
