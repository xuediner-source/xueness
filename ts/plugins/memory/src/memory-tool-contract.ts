/** Restricted memory-curation tool contract (F09.04): schemas, validation, verification. */
import { pyJsonLoads } from "@xueness/contracts";
import { redactSecrets } from "./memory-dream-service.ts";

export const MEMORY_TOOL_NAMES = ["memory_read_key", "memory_read_evidence", "memory_propose_change", "memory_submit"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export interface MemoryToolLoopLimits {
  maxRounds: number;
  maxToolCalls: number;
  maxChanges: number;
  maxEntryCodepoints: number;
  maxSummaryCodepoints: number;
  maxEvidenceReads: number;
  maxEvidenceCodepointsPerRead: number;
}

export const DEFAULT_MEMORY_TOOL_LIMITS: MemoryToolLoopLimits = {
  maxRounds: 12, maxToolCalls: 24, maxChanges: 24, maxEntryCodepoints: 2000, maxSummaryCodepoints: 1200,
  maxEvidenceReads: 12, maxEvidenceCodepointsPerRead: 8000,
};

export interface MemoryChange {
  op: "add" | "update" | "remove";
  entry: string;
  summary: string;
  evidence: string[];
}

export type MemoryToolCall =
  | { tool: "memory_read_key" }
  | { tool: "memory_read_evidence"; sessionId: string }
  | { tool: "memory_propose_change"; change: MemoryChange }
  | { tool: "memory_submit"; summary: string; sourceSessionIds: string[] };

export type MemoryToolVerdict = { ok: true; call: MemoryToolCall } | { ok: false; error: string };

const SESSION_ID = /^[a-f0-9]{32}$/;

/** OpenAI-style function schemas for the restricted loop; the only tools the model ever sees. */
export function memoryToolSchemas(): Row[] {
  return [
    { type: "function", function: { name: "memory_read_key", description: "Read the current project memory KEY.md content. Read-only evidence.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "memory_read_evidence", description: "Read transcript evidence of one selected source session. Read-only evidence.", parameters: { type: "object", properties: { sessionId: { type: "string", description: "A session id from the source catalog" } }, required: ["sessionId"], additionalProperties: false } } },
    { type: "function", function: { name: "memory_propose_change", description: "Propose one project-memory change. Every change must cite messageIds actually returned by memory_read_evidence.", parameters: { type: "object", properties: { op: { type: "string", enum: ["add", "update", "remove"] }, entry: { type: "string", description: "Entry heading line without markdown markers" }, summary: { type: "string" }, evidence: { type: "array", items: { type: "string" }, description: "messageIds supporting this change" } }, required: ["op", "entry", "summary", "evidence"], additionalProperties: false } } },
    { type: "function", function: { name: "memory_submit", description: "Submit the proposed changes for human review and finish.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } } },
  ];
}

type Row = Record<string, unknown>;

function str(value: unknown): string | null { return typeof value === "string" ? value : null; }

/**
 * Validates one model tool call against the restricted contract. `chosen` are
 * the proposal's source session ids; the loop supplies them so the schema
 * itself cannot widen the evidence surface.
 */
export function validateMemoryToolCall(name: unknown, argsJson: unknown, chosen: readonly string[], limits: MemoryToolLoopLimits): MemoryToolVerdict {
  if (typeof name !== "string" || !MEMORY_TOOL_NAMES.includes(name as MemoryToolName)) return { ok: false, error: "unknown tool; only the restricted memory tools are available" };
  let args: unknown;
  try { args = typeof argsJson === "string" && argsJson.trim() ? pyJsonLoads(argsJson) : {}; } catch { return { ok: false, error: "tool arguments must be a JSON object" }; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "tool arguments must be a JSON object" };
  const row = args as Row;
  if (name === "memory_read_key") {
    if (Object.keys(row).length) return { ok: false, error: "memory_read_key takes no arguments" };
    return { ok: true, call: { tool: "memory_read_key" } };
  }
  if (name === "memory_read_evidence") {
    const sessionId = str(row.sessionId);
    if (!sessionId || !SESSION_ID.test(sessionId) || !chosen.includes(sessionId)) return { ok: false, error: "sessionId must be one of the selected source sessions" };
    return { ok: true, call: { tool: "memory_read_evidence", sessionId } };
  }
  if (name === "memory_propose_change") {
    if (row.op !== "add" && row.op !== "update" && row.op !== "remove") return { ok: false, error: "op must be add, update or remove" };
    const entry = str(row.entry), summary = str(row.summary);
    if (!entry || !entry.trim() || entry.includes("\n") || entry.length > 200) return { ok: false, error: "entry must be a single heading line of 1..200 characters" };
    if (!summary || !summary.trim() || Array.from(summary).length > limits.maxSummaryCodepoints) return { ok: false, error: `summary must be 1..${limits.maxSummaryCodepoints} code points` };
    if (!Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.some((id) => typeof id !== "string" || !id) || new Set(row.evidence).size !== row.evidence.length) return { ok: false, error: "evidence must be 1..n unique non-empty messageIds" };
    return { ok: true, call: { tool: "memory_propose_change", change: { op: row.op, entry: entry.trim(), summary: summary.trim(), evidence: [...row.evidence] as string[] } } };
  }
  const summary = str(row.summary);
  if (!summary || !summary.trim() || Array.from(summary).length > limits.maxSummaryCodepoints) return { ok: false, error: `summary must be 1..${limits.maxSummaryCodepoints} code points` };
  const sources = row.sourceSessionIds === undefined ? [] : row.sourceSessionIds;
  if (!Array.isArray(sources) || sources.some((id) => typeof id !== "string" || !SESSION_ID.test(id) || !chosen.includes(id)) || new Set(sources).size !== sources.length) return { ok: false, error: "sourceSessionIds must be unique selected session ids" };
  return { ok: true, call: { tool: "memory_submit", summary: summary.trim(), sourceSessionIds: sources as string[] } };
}

export interface MemoryChangeVerification {
  index: number;
  change: MemoryChange;
  verified: boolean;
  reasons: string[];
}

/**
 * Verifies proposed changes against the evidence the loop actually read:
 * a change is verified only when every cited messageId was returned by a
 * `memory_read_evidence` call in this run. Unread citations are the core
 * "candidates are verifiable" invariant — no change enters review on trust.
 */
export function verifyMemoryChanges(changes: readonly MemoryChange[], readMessageIds: ReadonlySet<string>): MemoryChangeVerification[] {
  return changes.map((change, index) => {
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const id of change.evidence) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!readMessageIds.has(id)) reasons.push(`evidence messageId ${id} was never read in this run`);
    }
    return { index, change, verified: reasons.length === 0, reasons };
  });
}

const heading = (entry: string): string => `## ${entry}`;
/** Split into `## ` blocks, dropping the empty head a blank base produces. */
const blocks = (content: string): string[] => (content.trim() ? content.split(/\n(?=## )/g) : []);

/**
 * Renders accepted changes onto the base KEY.md: `add` appends a block,
 * `update` replaces the block with the same heading, `remove` deletes it.
 * The result is deterministic so the reviewed diff equals the applied bytes.
 */
export function renderKeyContent(base: string, changes: readonly MemoryChange[]): string {
  const parts = blocks(base.trim() ? base.trimEnd() : "");
  for (const change of changes) {
    const head = heading(change.entry);
    const at = parts.findIndex((block) => block.trimEnd() === head || block.startsWith(head + "\n"));
    if (change.op === "remove") { if (at >= 0) parts.splice(at, 1); continue; }
    // add and update both write the reviewed block; add merely tolerates a missing heading.
    parts[at >= 0 ? at : parts.length] = `${head}\n${redactSecrets(change.summary)}`;
  }
  return parts.join("\n").trim() ? `${parts.join("\n").trimEnd()}\n` : "";
}

/** The tool-result wire format appended to the loop transcript for one call. */
export function memoryToolResult(callId: string, ok: boolean, payload: unknown): Row {
  return { role: "tool", tool_call_id: callId, content: JSON.stringify(ok ? { ok, ...payload as Row } : { ok: false as const, error: String(payload) }) };
}
