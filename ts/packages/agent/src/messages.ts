import { isDict, PyValueError } from "@xueness/contracts";
import type { Row } from "./types.ts";

/** Validate complete provider intent before it becomes durable. */
export function validateMessage(message: unknown, usedIds: Iterable<string> = []): Row {
  if (!isDict(message)) throw new PyValueError("provider message must be an object");
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") throw new PyValueError("provider message content must be a string or null");
  const calls = message.tool_calls;
  const seen = new Set(usedIds);
  if (calls !== null && calls !== undefined) {
    if (!Array.isArray(calls)) throw new PyValueError("tool_calls must be a list");
    for (const call of calls) {
      if (!isDict(call)) throw new PyValueError("tool call must be an object");
      if (typeof call.id !== "string" || !call.id) throw new PyValueError("tool call id must be a nonempty string");
      if (seen.has(call.id)) throw new PyValueError("duplicate or reused tool call id");
      seen.add(call.id);
      if (call.type !== "function") throw new PyValueError("tool call type must be 'function'");
      if (!isDict(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") throw new PyValueError("tool call function needs string name/arguments");
    }
  }
  return message;
}
