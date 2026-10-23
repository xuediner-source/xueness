import { statSync } from "node:fs";
import { isDict, pyLen, pyStr, pyStrip, PyValueError } from "@xueness/contracts";
import { isFile, isLink, SYSTEM_PROMPT, type SessionStore } from "@xueness/sessions";
type Dict = Record<string, unknown>;
const SECRET = /(?:(?:sk|rk)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[:=]\s*['"]?[^\s,;"']{8,})/gi;
export function redactText(value: string): string { return value.split("\n\nXUENESS_MULTIMODAL_V1:", 1)[0]!.replace(SECRET, "[REDACTED]"); }
export async function portablePayload(store: SessionStore, sid: string): Promise<Dict> {
  const path = store.pathFor(sid);
  if (isLink(path) || !isFile(path)) throw new PyValueError("session not found or unsafe");
  if (statSync(path).size > 4 * 1024 * 1024) throw new PyValueError("session is too large to export");
  const s = await store.load(sid), messages: Dict[] = [];
  let size = 0;
  for (const m of (s.messages ?? []) as unknown[]) {
    if (!isDict(m) || !["user", "assistant"].includes(String(m.role)) || typeof m.content !== "string" || !m.content) continue;
    const safe = redactText(m.content);
    if (pyLen(safe) > 20000) throw new PyValueError("session transcript contains a message over 20000 characters");
    size += pyLen(safe);
    if (messages.length >= 1000 || size > 500000) throw new PyValueError("session transcript exceeds export limits");
    messages.push({ role: m.role, content: safe });
  }
  return { format: "xueness-session-portable", version: 1, task: redactText(pyStr(s.task ?? "")), title: redactText(pyStr(s.title || "")), messages };
}
export async function importPortable(store: SessionStore, data: unknown, root: string): Promise<Dict> {
  if (!isDict(data) || Object.keys(data).sort().join(",") !== "format,messages,task,title,version" || data.format !== "xueness-session-portable" || data.version !== 1) throw new PyValueError("unsupported portable session format");
  if (typeof data.task !== "string" || !pyStrip(data.task) || pyLen(data.task) > 5000) throw new PyValueError("portable session task must be 1..5000 characters");
  if (typeof data.title !== "string" || pyLen(data.title) > 120) throw new PyValueError("portable session title is invalid");
  if (!Array.isArray(data.messages) || data.messages.length > 1000) throw new PyValueError("portable session message count exceeds limit");
  let total = 0;
  const messages = data.messages.map((m) => {
    if (!isDict(m) || Object.keys(m).sort().join(",") !== "content,role" || !["user", "assistant"].includes(String(m.role)) || typeof m.content !== "string") throw new PyValueError("portable session contains an invalid message");
    total += pyLen(m.content);
    if (pyLen(m.content) > 20000 || total > 500000) throw new PyValueError("portable session transcript exceeds limits");
    return { role: m.role, content: redactText(m.content) };
  });
  const s = await store.new(redactText(data.task), root);
  s.messages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  if (data.title) s.title = redactText(data.title);
  s.status = "pending"; s.steps = 0; s.results = {}; s.pending_question = null;
  await store.save(s);
  return { id: s.id, status: s.status, messages: messages.length };
}
