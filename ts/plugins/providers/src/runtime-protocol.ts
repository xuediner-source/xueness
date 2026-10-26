/** Explicit lightweight JSON protocol; no executable intent is mined from prose. */
import { isDict, pyJsonDumps, pyJsonLoads, pySlice, uuid4Hex } from "@xueness/contracts";
import { envelopeText, failure, finiteJsonText, strictJson } from "@xueness/providers";
type Row = Record<string, unknown>;
export const runtimeToolName = (schema: Row): string => isDict(schema.function) && typeof schema.function.name === "string" ? schema.function.name : "";

export function decodeTextResponse(response: Row, tools: Row[], id = (): string => "local-" + uuid4Hex()): Row {
  if (Array.isArray(response.tool_calls) && response.tool_calls.length) return failure(response, "wrong_protocol", "Use the configured JSON tool protocol, not native calls.");
  if (typeof response.content !== "string") return failure(response, "missing_text", "Reply with one JSON tool or answer object.");
  let object: unknown;
  try { object = strictJson(envelopeText(response.content)); }
  catch (error) { return failure(response, error instanceof Error && error.name === "DuplicateKey" ? "duplicate_json_key" : "invalid_json", "Reply with one valid JSON tool or answer object; escape newlines and quotes inside strings.", error); }
  if (!isDict(object)) return failure(response, "invalid_envelope", "Reply with one JSON tool or answer object.");
  try { finiteJsonText(object); }
  catch { return failure(response, "invalid_json_value", "Use finite JSON numbers and valid Unicode text without unpaired UTF-16 surrogates."); }
  if (Object.keys(object).sort().join(",") === "arguments,tool" && typeof object.tool === "string" && isDict(object.arguments)) {
    if (!tools.some((schema) => runtimeToolName(schema) === object.tool)) return failure(response, "tool_unavailable", "That tool is not part of the current tool view.");
    return { ...response, content: "", tool_calls: [{ id: id(), type: "function", function: { name: object.tool, arguments: pyJsonDumps(object.arguments) } }] };
  }
  const answerFields = ["answer", "summary"].filter((field) => Object.hasOwn(object, field));
  if (answerFields.length === 1 && Object.keys(object).every((field) => ["answer", "summary", "evidence"].includes(field)) && typeof object[answerFields[0]!] === "string" && (!Object.hasOwn(object, "evidence") || Array.isArray(object.evidence))) {
    return { ...response, content: pyJsonDumps({ ...object, evidence: object.evidence ?? [] }) };
  }
  return failure(response, "invalid_envelope", 'Use exactly {"tool":"NAME","arguments":{...}} or {"answer":"...","evidence":[]}.');
}

function unicodePrefix(text: string): string {
  let result = "";
  for (const char of text) { const code = char.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) break; result += char; }
  return result;
}
/** Only a decoded answer prefix is visible while the private envelope streams. */
export function streamAnswerText(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = /^\s*(?:```json\r?\n)?\{\s*"(?:answer|summary)"\s*:\s*"/.exec(content);
  if (!match) return "";
  const source = content.slice(match[0].length);
  let end = 0;
  while (end < source.length) {
    const char = source[end]!;
    if (char === '"' || char.charCodeAt(0) < 32) break;
    if (char === "\\") {
      if (end + 1 >= source.length) break;
      const escape = source[end + 1]!;
      if (escape === "u") { if (!/^[0-9a-fA-F]{4}$/.test(source.slice(end + 2, end + 6))) break; end += 6; continue; }
      if (!'"\\/bfnrt'.includes(escape)) break;
      end += 2; continue;
    }
    end += 1;
  }
  try { return unicodePrefix(pyJsonLoads('"' + source.slice(0, end) + '"') as string); } catch { return ""; }
}

export function partialAnswer(response: Row, jsonMode = false): string {
  if (typeof response.content !== "string") return "";
  if (!jsonMode) return unicodePrefix(response.content);
  let object: unknown;
  try { object = pyJsonLoads(response.content); } catch { object = null; }
  if (isDict(object) && Object.keys(object).every((key) => ["answer", "summary", "evidence"].includes(key))) {
    const value = object.answer ?? object.summary;
    if (typeof value === "string") return unicodePrefix(value);
  }
  return streamAnswerText(response.content);
}

/** Chat templates without function roles receive an explicit data transcript. */
export function textMessages(messages: Row[]): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    if (message.role === "user" && message._media_refs) { rows.push(message); continue; }
    let item = { ...message };
    const calls = item.tool_calls; delete item.tool_calls;
    if (Array.isArray(calls) && calls.length) {
      if (calls.length === 1) {
        const fn = isDict(calls[0]) && isDict(calls[0].function) ? calls[0].function : {};
        let args: unknown; try { args = pyJsonLoads((fn.arguments ?? "{}") as string); } catch { args = {}; }
        item.content = pyJsonDumps({ tool: fn.name ?? null, arguments: args });
      } else item.content = pyJsonDumps({ tool_calls: calls });
    }
    if (item.role === "tool") item = { role: "user", content: "UNTRUSTED tool result (" + String(item.tool_call_id ?? "") + "):\n" + String(item.content ?? "") };
    const last = rows.at(-1);
    if (last && !last._media_refs && last.role === item.role && typeof item.content === "string" && typeof last.content === "string") last.content += "\n\n" + item.content;
    else rows.push(item);
  }
  return rows;
}
