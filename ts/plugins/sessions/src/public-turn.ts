/** Bounded lifecycle facts; no request bodies, file snapshots or task output. */
import { isDict } from '@xueness/contracts';
type Row = Record<string, unknown>;
const PHASES = new Set(['idle', 'processing_input', 'awaiting_model_response', 'streaming', 'scheduling_tools', 'executing_tools', 'aggregating_results', 'awaiting_permission', 'completing', 'error']);
const TASK_STATES = new Set(['running', 'exited', 'killed', 'timed_out', 'failed', 'lost']);
const TOOL_STATES = new Set(['scheduled', 'waiting_permission', 'running', 'completed', 'failed']);
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const metric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function publicTurnState(value: unknown): Row | null {
  if (!isDict(value) || !PHASES.has(String(value.phase)) || !text(value.id) || !text(value.traceId)) return null;
  const result: Row = { id: value.id, traceId: value.traceId, phase: value.phase };
  for (const key of ['startedAt', 'completedAt']) if (text(value[key], 40) && Number.isFinite(Date.parse(value[key] as string))) result[key] = value[key];
  for (const key of ['requestCount', 'toolCallCount', 'textChars', 'reasoningChars']) if (metric(value[key])) result[key] = value[key];
  if (['success', 'cancelled', 'paused', 'error_during_execution'].includes(String(value.resultType))) result.resultType = value.resultType;
  result.tools = (Array.isArray(value.tools) ? value.tools : []).filter(isDict).slice(-100)
    .filter(tool => text(tool.id) && text(tool.name) && TOOL_STATES.has(String(tool.status)))
    .map(tool => ({ id: tool.id, name: tool.name, status: tool.status }));
  return result;
}
export function publicBackgroundTasks(value: unknown): Row[] {
  return (Array.isArray(value) ? value : []).filter(isDict).slice(-32)
    .filter(task => text(task.id) && TASK_STATES.has(String(task.state)))
    .map(task => {
      const result: Row = { id: task.id, state: task.state, outputOpen: task.outputOpen === true };
      if (task.state === 'lost' && task.reason === 'runtime_unavailable') result.reason = task.reason;
      if (task.exitCode === null || typeof task.exitCode === 'number' && Number.isInteger(task.exitCode)) result.exitCode = task.exitCode;
      for (const key of ['stdoutBytes', 'stderrBytes', 'durationMs']) if (metric(task[key])) result[key] = task[key];
      return result;
    });
}
