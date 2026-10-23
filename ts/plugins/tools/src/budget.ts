/** Per-turn tool-call budget. Process-local lock; the Python flock is not reproduced. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { isLink } from "@xueness/sessions";
import { budgetConfig, turnId } from "./flags.ts";

const SID = /^[0-9a-f]{32}$/;
const seen = new Map<string, Set<string>>();

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

function sidecar(stateDir: string, sid: string): string {
  if (isLink(stateDir)) refuse("invalid tool budget state directory");
  const directory = join(stateDir, ".tools-call-budgets");
  if (isLink(directory)) refuse("invalid tool budget storage directory");
  return join(directory, `${sid}.json`);
}

function readUsed(stateDir: string, sid: string, turn: string): number {
  const path = sidecar(stateDir, sid);
  if (isLink(path)) refuse("invalid tool budget record");
  try {
    const value = pyJsonLoads(readFileSync(path, "utf8"));
    if (!isDict(value) || typeof value.turn_id !== "string" || !value.turn_id) refuse("invalid tool call budget record");
    if (value.turn_id !== turn) return 0;
    if (!isPyIntValue(value.used) || typeof value.used !== "number" || value.used < 0) refuse("invalid current-turn tool call budget");
    return value.used;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function writeUsed(stateDir: string, sid: string, turn: string, used: number): void {
  const directory = join(stateDir, ".tools-call-budgets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(sidecar(stateDir, sid), pyJsonDumps({ turn_id: turn, used }, { ensureAscii: false }));
}

export function projectSession(stateDir: string, session: unknown): Record<string, unknown> {
  const config = budgetConfig(stateDir);
  if (!config.enabled) return { enabled: false };
  if (!isDict(session)) return { enabled: true, scope: "session", turn_id: null, used: 0, limit: config.limit, remaining: config.limit };
  const sid = typeof session.id === "string" && SID.test(session.id) ? session.id : null;
  const turn = turnId(session);
  const used = sid ? readUsed(stateDir, sid, turn) : 0;
  return { enabled: true, scope: "session", turn_id: turn, used, limit: config.limit, remaining: Math.max(0, config.limit - used) };
}

export function reserve(stateDir: unknown, session: unknown, toolCallId: unknown): Record<string, unknown> | null {
  if (typeof stateDir !== "string" || !isDict(session)) return null;
  const config = budgetConfig(stateDir);
  if (!config.enabled) return null;
  const sid = session.id;
  if (typeof sid !== "string" || !SID.test(sid)) return null;
  const turn = turnId(session);
  const key = `${stateDir}\0${sid}\0${turn}`;
  const calls = seen.get(key) ?? new Set<string>();
  if (typeof toolCallId === "string" && toolCallId && calls.has(toolCallId)) return null;
  const used = readUsed(stateDir, sid, turn);
  const status = { enabled: true, scope: "session", turn_id: turn, used, limit: config.limit, remaining: Math.max(0, config.limit - used) };
  if (used >= config.limit) {
    return { ok: false, error: "tool call budget exhausted", error_code: "tool_call_budget_exhausted", retryable: false, call_budget: status, user_reason: `本轮工具调用预算已耗尽（${used}/${config.limit}）。请开始新一轮或调整工具调用预算。` };
  }
  writeUsed(stateDir, sid, turn, used + 1);
  if (typeof toolCallId === "string" && toolCallId) calls.add(toolCallId);
  seen.set(key, calls);
  return null;
}

export function beforeToolEffect(payload: Readonly<Record<string, unknown>>): unknown {
  if (!isDict(payload)) return null;
  const denial = reserve(payload.state_dir, payload.session, payload.tool_call_id);
  return denial ? { decision: "deny", result: denial } : null;
}

export function afterToolExecution(payload: Readonly<Record<string, unknown>>): unknown {
  if (!isDict(payload) || !isDict(payload.result) || typeof payload.state_dir !== "string") return null;
  try {
    const status = projectSession(payload.state_dir, payload.session);
    if (status.enabled !== true) return null;
    return { decision: "rewrite", result: { ...payload.result, call_budget: status } };
  } catch { return null; }
}
