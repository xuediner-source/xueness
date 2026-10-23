/** Journal-stable evidence and completion records (`core.py`). */
import { createHash } from "node:crypto";
import { isDict, pyJsonDumps, pyJsonLoads, pySlice, pyTruthy } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
type Row = Record<string, unknown>;
export type Assessment = Row & { verified: boolean; summary: string; evidence: Row[] };

export function evidenceAliases(session: Session): Record<string, string> {
  const results = isDict(session.results) ? session.results : {};
  const aliases: Record<string, string> = {};
  for (const [key, cid] of Object.entries(isDict(session.evidence_aliases) ? session.evidence_aliases : {})) {
    if (/^E[1-9][0-9]*$/.test(key) && typeof cid === "string" && isDict(results[cid]) && results[cid].ok === true && results[cid].evidence_eligible !== false) aliases[key] = cid;
  }
  const used = new Set(Object.values(aliases));
  let next = Math.max(0, ...Object.keys(aliases).map((key) => Number(key.slice(1)))) + 1;
  for (const [cid, result] of Object.entries(results)) {
    if (!used.has(cid) && isDict(result) && result.ok === true && result.evidence_eligible !== false) { aliases["E" + next++] = cid; used.add(cid); }
  }
  session.evidence_aliases = aliases;
  return aliases;
}

export function completionPayload(content: unknown, allowMarkdownEnvelope = false): [string, unknown[], boolean] {
  if (typeof content !== "string") return ["", [], false];
  const text = content.trim();
  let candidate = text;
  let prose = "";
  if (candidate.startsWith("```json") && candidate.endsWith("```")) candidate = candidate.slice(7, -3).trim();
  let report: unknown;
  try { report = pyJsonLoads(candidate); } catch {
    if (!allowMarkdownEnvelope) return [content, [], false];
    const fences = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gim)];
    if (fences.length !== 1) return [content, [], false];
    const match = fences[0]!;
    prose = [text.slice(0, match.index).trim(), text.slice(match.index! + match[0].length).trim()].filter(Boolean).join("\n\n");
    if (!prose) return [content, [], false];
    try { report = pyJsonLoads(match[1]!); } catch { return [content, [], false]; }
  }
  if (!isDict(report)) return [content, [], false];
  const fields = Object.keys(report).sort().join(",");
  if (fields !== "answer,evidence" && fields !== "evidence,summary") return [content, [], false];
  const answer = report.answer ?? report.summary;
  if (typeof answer !== "string" || !Array.isArray(report.evidence)) return [content, [], false];
  return [prose || answer, report.evidence, true];
}

const FOOTER = /^(?:Evidence|证据)[：:][ \t]*(E[1-9][0-9]*(?:[ \t]*[,，][ \t]*E[1-9][0-9]*)*)[ \t]*$/i;
export function nativeEvidence(content: string): [string, Row[]] | null {
  const lines = content.trimEnd().split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.length < 2) return null;
  const last = lines.at(-1)!;
  const match = FOOTER.exec(last);
  if (!match || Array.from(last).length > 512) return null;
  const body = lines.slice(0, -1).join("\n").trimEnd();
  if (!body || (body.split("```").length - 1) % 2 || (body.split("~~~").length - 1) % 2 || lines.slice(0, -1).some((line) => FOOTER.test(line))) return null;
  const refs = match[1]!.split(/[ \t]*[,，][ \t]*/).map((ref) => ref.toUpperCase());
  if (refs.length > 24 || new Set(refs).size !== refs.length) return null;
  return [body, refs.map((ref) => ({ evidence_id: ref, observation: pySlice(body, 2000) }))];
}

export function assess(content: string, results: Row, aliases?: Record<string, string> | null, nativeReferences = false): Assessment {
  let [answer, evidence, structured] = completionPayload(content, aliases ? !!Object.keys(aliases).length : aliases == null && !!Object.keys(results).length);
  if (nativeReferences && !structured) { const footer = nativeEvidence(content); if (footer) { [answer, evidence] = footer; structured = true; } }
  if (!structured || !evidence.length) return { verified: false, summary: answer, evidence: [] };
  const resolved: Row[] = [];
  for (const item of evidence) {
    if (!isDict(item) || typeof item.observation !== "string" || !item.observation.trim()) return { verified: false, summary: answer, error_code: "invalid_evidence_reference", evidence: [] };
    const cid = item.evidence_id ? aliases?.[String(item.evidence_id)] : item.tool_call_id;
    const result = typeof cid === "string" ? results[cid] : null;
    if (!isDict(result) || result.ok !== true || result.evidence_eligible === false) return { verified: false, summary: answer, error_code: "invalid_evidence_reference", evidence: [] };
    resolved.push({ ...item, tool_call_id: cid });
  }
  return { verified: true, summary: answer, evidence: resolved };
}

export function currentTurnToolIds(session: Session): string[] {
  const messages = (Array.isArray(session.messages) ? session.messages : []).filter(isDict);
  let lastUser = 0;
  messages.forEach((message, index) => { if (message.role === "user" && message._input_kind !== "guide" && message._input_kind !== "background_notice") lastUser = index; });
  return messages.slice(lastUser + 1).filter((message) => message.role === "assistant")
    .flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isDict)
    .map((call) => call.id).filter((id): id is string => typeof id === "string" && !!id);
}

export function currentTurnAliases(aliases: Record<string, string>, callIds: string[]): Record<string, string> {
  const allowed = new Set(callIds);
  return Object.fromEntries(Object.entries(aliases).filter(([, cid]) => allowed.has(cid)));
}

export function toolExecutionStatus(session: Session, callIds: string[]): "not_applicable" | "incomplete" | "failed" | "succeeded" {
  if (!callIds.length) return "not_applicable";
  const results = isDict(session.results) ? session.results : {};
  const actions = new Map<unknown, string>();
  for (const message of (Array.isArray(session.messages) ? session.messages : []).filter(isDict)) {
    for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isDict)) {
      const fn = isDict(call.function) ? call.function : {};
      let args = fn.arguments ?? "";
      try { args = pyJsonDumps(pyJsonLoads(args as string), { sortKeys: true }); } catch { args = String(args); }
      actions.set(call.id, pyJsonDumps([fn.name ?? null, args]));
    }
  }
  const successfulLater = new Set<string>();
  let failed = false;
  let incomplete = false;
  for (const cid of [...callIds].reverse()) {
    const result = results[cid];
    const action = actions.get(cid);
    if (isDict(result) && result.ok === true) { if (action !== undefined) successfulLater.add(action); }
    else if (isDict(result) && result.ok === false) { if (action === undefined || !successfulLater.has(action)) failed = true; }
    else incomplete = true;
  }
  return incomplete ? "incomplete" : failed ? "failed" : "succeeded";
}

export function turnId(session: Session): string {
  const users = (Array.isArray(session.messages) ? session.messages : []).filter(isDict).filter((item) => item.role === "user" && item._input_kind !== "guide" && item._input_kind !== "background_notice");
  return typeof users.at(-1)?._turn_id === "string" ? users.at(-1)!._turn_id as string : `turn-${Math.max(1, users.length)}`;
}

export function recordCompletionHistory(session: Session, completion: Row): void {
  if (!Array.isArray(session.completion_history)) session.completion_history = [];
  const record: Row = {};
  for (const key of ["turn_id", "status", "verified", "summary", "tool_execution_status", "delivery_status", "evidence_count"]) if (Object.hasOwn(completion, key)) record[key] = completion[key];
  if (typeof record.summary === "string") record.summary = pySlice(record.summary, 4000);
  if (completion.delivery_status === "passed" && pyTruthy(session.delivery_requirements)) record.delivery_plan_digest = createHash("sha256").update(pyJsonDumps(session.delivery_requirements, { sortKeys: true, ensureAscii: true }), "ascii").digest("hex");
  const history = session.completion_history as Row[];
  history.push(record); history.splice(0, Math.max(0, history.length - 200));
}
