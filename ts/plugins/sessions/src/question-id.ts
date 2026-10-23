import { createHash } from "node:crypto";
import { isDict, pyJsonDumps } from "@xueness/contracts";
type Row = Record<string, any>;
export function questionIdentity(s: Row, question: string): string {
  const messages = Array.isArray(s.messages) ? s.messages : [], results = isDict(s.results) ? s.results : {}; let anchor: unknown[] | null = null;
  for (let i = messages.length - 1; i >= 0 && !anchor; i--) { const m = messages[i]; for (const call of isDict(m) && Array.isArray(m.tool_calls) ? [...m.tool_calls].reverse() : []) {
    if (!isDict(call) || !isDict(call.function) || call.function.name !== "ask_user" || typeof call.id !== "string") continue; const result = results[call.id];
    if (isDict(result) && result.awaiting_user === true && result.question === question) { anchor = ["ask_user", i, call.id, question]; if (Object.hasOwn(result, "questions")) anchor.push(result.questions); break; }
  } }
  if (!anchor) { const indexes = messages.flatMap((m, i) => isDict(m) && m.role === "user" ? [i] : []); anchor = ["legacy_pending_question", messages.length, indexes.at(-1) ?? -1, s.steps ?? 0, question]; }
  return "q-" + createHash("sha256").update(pyJsonDumps([typeof s.id === "string" ? s.id : "", anchor], { ensureAscii: true, separators: [",", ":"] })).digest("hex");
}
