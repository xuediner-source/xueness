import type { AgentContext, AgentEvent, AgentExtension, ModelRequest } from "@xueness/agent";
import { BATCH_CALLS_COMPACTION_REMINDER, BATCH_CALLS_POLICY } from "./policy.ts";

type Compaction = { key: string; aliases: string[] };
type PreparedReminder = { cycle: string; compactions: Set<string> };
type SessionState = { seen: Set<string>; pending: Map<string, Compaction>; prepared: PreparedReminder | null };

const states = new Map<string, SessionState>();

function sessionId(context: AgentContext): string | null {
  const id = context.session.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function stateFor(context: AgentContext): SessionState | null {
  const id = sessionId(context);
  if (!id) return null;
  let state = states.get(id);
  if (!state) states.set(id, state = { seen: new Set(), pending: new Map(), prepared: null });
  return state;
}

function requestCycle(context: AgentContext): string {
  const turn = typeof context.session.active_turn_id === "string" ? context.session.active_turn_id : "";
  const steps = typeof context.session.steps === "number" && Number.isSafeInteger(context.session.steps) ? String(context.session.steps) : "unknown";
  return `${turn}:${steps}`;
}

function appendOnce(request: ModelRequest, instruction: string): ModelRequest {
  const current = request.hostInstructions ?? [];
  return current.includes(instruction) ? request : { ...request, hostInstructions: [...current, instruction] };
}

function eventCompaction(event: AgentEvent): Compaction | null {
  if (event.type !== "context/compaction_completed" || event.error !== undefined || event.success === false) return null;
  const ids = compactionAliases(event);
  if (!ids.length) return null;
  return { key: ids[0]!, aliases: ids };
}

function compactionAliases(record: Record<string, unknown>): string[] {
  return ["operationId", "checkpointId"].flatMap((field) => {
    const value = record[field];
    return typeof value === "string" && value.trim() ? [`${field}:${value.trim()}`] : [];
  });
}

function persistedCompaction(records: unknown): Compaction | null {
  if (!Array.isArray(records)) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const candidate: unknown = records[index];
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.advisory === true || (record.kind !== "zcode" && record.kind !== "semantic")) continue;
    const ids = compactionAliases(record);
    if (ids.length) return { key: ids[0]!, aliases: ids };
  }
  return null;
}

function enqueueCompaction(state: SessionState, compaction: Compaction): void {
  const alreadySeen = compaction.aliases.some((alias) => state.seen.has(alias));
  for (const alias of compaction.aliases) state.seen.add(alias);
  if (!alreadySeen) state.pending.set(compaction.key, compaction);
}

function prepareReminder(state: SessionState, cycle: string): void {
  if (!state.pending.size) return;
  if (!state.prepared || state.prepared.cycle !== cycle) state.prepared = { cycle, compactions: new Set() };
  for (const key of state.pending.keys()) state.prepared.compactions.add(key);
}

export const batchCallsExtension: AgentExtension = {
  id: "batch_calls",
  capabilities: ["batch_calls.policy", "batch_calls.compaction"],
  prepareRequest(context, request) {
    if (!context.enabled("batch_calls")) return request;
    const cycle = requestCycle(context);
    let prepared = appendOnce(request, BATCH_CALLS_POLICY);
    const state = stateFor(context);
    if (state) {
      const persisted = persistedCompaction(context.session.compactions);
      if (persisted) enqueueCompaction(state, persisted);
      prepareReminder(state, cycle);
      if (state.prepared?.cycle === cycle && state.prepared.compactions.size) {
        prepared = appendOnce(prepared, BATCH_CALLS_COMPACTION_REMINDER);
      }
    }
    return prepared;
  },
  recordEvent(context, event) {
    if (!context.enabled("batch_calls")) return;
    const compaction = eventCompaction(event);
    if (!compaction) return;
    const state = stateFor(context);
    if (!state) return;
    enqueueCompaction(state, compaction);
  },
  modelRequestStarted(context) {
    if (!context.enabled("batch_calls")) return;
    const state = stateFor(context);
    if (!state?.prepared || state.prepared.cycle !== requestCycle(context)) return;
    for (const key of state.prepared.compactions) state.pending.delete(key);
    state.prepared = null;
  },
  close(context) {
    if (!context.enabled("batch_calls")) return;
    const id = sessionId(context);
    const state = id ? states.get(id) : undefined;
    // Preserve seen ids after consumption, and keep pending reminders after a cancelled run.
    if (state) state.prepared = null;
  },
};
