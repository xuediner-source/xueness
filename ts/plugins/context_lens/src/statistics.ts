import { isDict } from '@xueness/contracts';
import type { LensStatistics, Row } from './types.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(isDict) : [];
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Project only measurements the host already records; never infer phase times from wall-clock gaps. */
export function lensStatistics(session: Row): LensStatistics {
  const messages = [...rows(session.archived_messages), ...rows(session.messages)];
  const human = messages.filter(row => row.role === 'user' && !row._injected && row._input_kind !== 'background_notice');
  const histories = new Map(rows(session.runtime_activity_history).map(row => [String(row.startedAt), row]));
  if (isDict(session.runtime_activity)) histories.set(String(session.runtime_activity.startedAt), session.runtime_activity);
  const timing: LensStatistics['timing'] = { samples: histories.size, waitingMs: 0, thinkingMs: 0, generatingMs: 0, otherMs: 0,
    toolElapsedMs: 0, toolSamples: 0, speedTokens: 0, speedMs: 0, spans: [] };
  for (const row of histories.values()) {
    const waitingMs = positive(row.waitingSeconds) * 1000, thinkingMs = positive(row.thinkingSeconds) * 1000;
    const generatingMs = positive(row.generatingSeconds) * 1000;
    const requestMs = positive(row.modelRequestDurationMs) || positive(row.requestSeconds) * 1000;
    const otherMs = Math.max(0, requestMs - waitingMs - thinkingMs - generatingMs);
    timing.waitingMs += waitingMs; timing.thinkingMs += thinkingMs; timing.generatingMs += generatingMs; timing.otherMs += otherMs;
    if (typeof row.reportedOutputTokens === 'number' && requestMs > 0) {
      timing.speedTokens += positive(row.reportedOutputTokens); timing.speedMs += requestMs;
    }
    timing.spans.push({ step: positive(row.requestStep), waitingMs, thinkingMs, generatingMs, otherMs });
  }
  for (const row of rows(session.tool_timings)) {
    if (typeof row.seconds === 'number' && row.seconds >= 0) { timing.toolElapsedMs += row.seconds * 1000; timing.toolSamples++; }
  }
  return { steps: positive(session.steps), humanInputs: human.length,
    answers: messages.filter(row => row.role === 'assistant' && typeof row.content === 'string' && row.content.trim()).length,
    injections: messages.filter(row => row._injected === true || row._input_kind === 'background_notice').length,
    compactions: rows(session.compactions).length,
    masked: rows(session.compactions).reduce((sum, row) => sum + positive(row.masked), 0), timing };
}
