import { isDict, pyJsonDumps, pyLen, pySlice, pyStr, pyStrip, pyTruthy } from "@xueness/contracts";
import type { Row } from "./delivery.ts";
const tail = (text: string, count: number): string => Array.from(text).slice(-count).join("");
export function boundedGoalValue(value: unknown, limit = 3200): string { let raw: string; try { raw = pyJsonDumps(value, { ensureAscii: false, separators: [",", ":"] }); } catch { raw = pyStr(value); } return pyLen(raw) > limit ? pySlice(raw, limit) + "… [truncated]" : raw; }
export function currentGoalTurn(session: Row): [number, Row][] {
  if (!Array.isArray(session.messages)) return [];
  const messages = session.messages; let last = messages.findLastIndex((row) => isDict(row) && row.role === "user"); if (last < 0) last = 0;
  return messages.slice(last).flatMap((row, i) => isDict(row) ? [[i + last, row] as [number, Row]] : []);
}
export function goalEvidence(session: Row): [string, Row[], Set<string>] {
  let final = ""; let rows: Row[] = []; const calls: string[] = [];
  for (const [index, message] of currentGoalTurn(session)) {
    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls.filter(isDict)) {
        if (typeof call.id !== "string" || !call.id) continue;
        const fn = isDict(call.function) ? call.function : {}; calls.push(call.id);
        rows.push({ id: "call:" + call.id, kind: "tool_call", name: pySlice(pyStr(pyTruthy(fn.name) ? fn.name : ""), 120), arguments: boundedGoalValue(Object.hasOwn(fn, "arguments") ? fn.arguments : "", 1200) });
      }
      if (typeof message.content === "string" && pyStrip(message.content)) {
        rows.push({ id: "answer:" + (typeof message._message_id === "string" && message._message_id ? message._message_id : index), kind: "assistant_answer", content: tail(message.content, 3200) });
        if (!toolCalls.length) final = message.content;
      }
    } else if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id) { calls.push(message.tool_call_id); rows.push({ id: "tool:" + message.tool_call_id, kind: "tool_result", content: pySlice(pyStr(pyTruthy(message.content) ? message.content : ""), 3200) }); }
  }
  if (isDict(session.results)) for (const cid of new Set(calls)) if (Object.hasOwn(session.results, cid)) rows.push({ id: "result:" + cid, kind: "stored_tool_result", content: boundedGoalValue(session.results[cid]) });
  const checks = isDict(session.completion) && isDict(session.completion.delivery_checks) ? session.completion.delivery_checks : {};
  for (const [owner, record] of Object.entries(checks)) if (isDict(record)) for (const item of Array.isArray(record.items) ? record.items : []) if (isDict(item) && item.id !== "session_goal") rows.push({ id: `delivery:${owner}:${item.id ?? "unknown"}`, kind: "host_delivery_check", status: record.status ?? null, item });
  rows = rows.slice(-28); return [final, rows, new Set(rows.map((row) => String(row.id)))];
}
export function goalDeliveryFailures(session: Row): string[] {
  const completion = isDict(session.completion) ? session.completion : {}, failures: string[] = [];
  const checks = isDict(completion.delivery_checks) ? completion.delivery_checks : {};
  for (const [owner, record] of Object.entries(checks)) {
    if (!isDict(record)) continue;
    for (const item of Array.isArray(record.items) ? record.items : []) if (isDict(item) && item.id !== "session_goal" && item.passed !== true) failures.push(pyStr(item.label ?? item.id ?? owner) + ": " + (Array.isArray(item.missing) ? item.missing.slice(0, 8).map(pyStr).join("；") : "交付检查未通过"));
    if (record.status === "failed" && !pyTruthy(record.items)) failures.push(pySlice(pyStr(record.reason || `${owner} 交付检查未通过`), 500));
  }
  if (completion.delivery_status === "failed" && !failures.length) failures.push("主机交付检查未通过，请查看交付清单中的失败项。");
  return failures;
}
export function goalHasResponse(session: Row): boolean { return currentGoalTurn(session).some(([, row]) => row.role === "assistant" && (typeof row.content === "string" && !!pyStrip(row.content) || pyTruthy(row.tool_calls))) || isDict(session.streaming) && pyTruthy(session.streaming.text || session.streaming.reasoning); }
