import { isDict, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import type { Row } from "@xueness/agent";

const INTERRUPTED_RESULT: Row = {
  ok: false,
  output: "[Tool execution was interrupted before resume]",
  error: {
    code: "tool_interrupted",
    message: "Tool execution was interrupted before resume",
  },
  retryable: false,
};

function toolCalls(message: Row): Row[] {
  return isDict(message) && message.role === "assistant" && Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isDict)
    : [];
}

function callId(call: Row): string | undefined {
  return typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
}

function uniqueAssistantCallIds(messages: readonly Row[]): void {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      const id = callId(call);
      if (!id) continue;
      if (seen.has(id)) throw new PyValueError(`duplicate assistant tool call id: ${id}`);
      seen.add(id);
    }
  }
}

function parsedToolResult(message: Row | undefined): Row | undefined {
  if (!message || typeof message.content !== "string") return undefined;
  try {
    const value = pyJsonLoads(message.content);
    return isDict(value) && typeof value.ok === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function approvalPlaceholder(message: Row | undefined): Row | undefined {
  if (!message || typeof message.content !== "string") return undefined;
  try {
    const value = pyJsonLoads(message.content);
    if (!isDict(value)) return undefined;
    const error = isDict(value.error) ? value.error : {};
    const data = isDict(value.data) ? value.data : {};
    return value.awaiting_approval === true || data.awaitingApproval === true || error.code === "approval_required"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function resultMap(session: Row): Row {
  if (isDict(session.results)) return session.results as Row;
  const results: Row = {};
  session.results = results;
  return results;
}

function interruptedResult(): Row {
  return {
    ...INTERRUPTED_RESULT,
    error: { ...(INTERRUPTED_RESULT.error as Row) },
  };
}

/** Restore tool-call/result pairs before resuming a leased session. */
export function hydrateSessionToolHistory(session: Row): { restored: number; interrupted: number } {
  const messages = Array.isArray(session.messages) ? session.messages as Row[] : [];
  uniqueAssistantCallIds(messages);

  const existingById = new Map<string, Row>();
  for (const message of messages) {
    if (!isDict(message)) continue;
    if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id) {
      existingById.set(message.tool_call_id, message);
    }
  }

  let results = isDict(session.results) ? session.results as Row : undefined;
  let restored = 0;
  let interrupted = 0;
  let messagesChanged = false;
  const hydrated: Row[] = [];
  const setResult = (id: string, value: Row): void => {
    results ??= resultMap(session);
    results[id] = value;
  };

  for (const message of messages) {
    hydrated.push(message);
    for (const call of toolCalls(message)) {
      const id = callId(call);
      if (!id) continue;
      const existing = existingById.get(id);
      const storedResult = results?.[id];
      if (isDict(storedResult)) {
        if (!existing) {
          hydrated.push({ role: "tool", tool_call_id: id, content: pyJsonDumps(storedResult) });
          messagesChanged = true;
          restored += 1;
        }
        continue;
      }

      if (existing) {
        const parsed = parsedToolResult(existing);
        if (parsed) {
          setResult(id, parsed);
          restored += 1;
          continue;
        }
        const approval = approvalPlaceholder(existing);
        if (approval) {
          setResult(id, approval);
          restored += 1;
          continue;
        }
        setResult(id, interruptedResult());
        interrupted += 1;
        continue;
      }

      const failed = interruptedResult();
      setResult(id, failed);
      hydrated.push({ role: "tool", tool_call_id: id, content: pyJsonDumps(failed) });
      messagesChanged = true;
      interrupted += 1;
    }
  }

  if (messagesChanged) session.messages = hydrated;
  return { restored, interrupted };
}

/** Build request-only history with each assistant's tool results in call order. */
export function projectSessionHistory(messages: readonly Row[]): Row[] {
  uniqueAssistantCallIds(messages);
  const resultsById = new Map<string, Row>();
  for (const message of messages) {
    if (!isDict(message)) continue;
    if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id) {
      resultsById.set(message.tool_call_id, message);
    }
  }

  const projected: Row[] = [];
  for (const message of messages) {
    if (!isDict(message)) {
      projected.push(message);
      continue;
    }
    if (message.role === "tool") continue;
    projected.push(message);
    for (const call of toolCalls(message)) {
      const id = callId(call);
      const result = id ? resultsById.get(id) : undefined;
      if (result) projected.push(result);
    }
  }
  return projected;
}
