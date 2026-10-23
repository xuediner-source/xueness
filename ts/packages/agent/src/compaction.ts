/** Deterministic prompt compaction, ported from core.compact; no model calls. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyLen, pySlice, pyStr } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";

type Row = Record<string, unknown>;
export interface MessageUnit { kind: "group" | "orphan_tool" | "user" | "assistant"; msgs: [number, Row][]; ids: Set<string> }
export const MASK_KEEP_RECENT_UNITS = 4;
export const MASK_THRESHOLD = 400;
export const MASK_HEAD = 200;
export const OFFLOAD_HEAD = 400;

/** Calls and all their results are indivisible, even when interleaved. */
export function partitionUnits(rest: Row[]): MessageUnit[] {
  const units: MessageUnit[] = [];
  const owners = new Map<unknown, MessageUnit>();
  rest.forEach((message, index) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return;
    const ids = new Set(message.tool_calls.filter(isDict).map((call) => call.id).filter((id): id is string => typeof id === "string" && !!id));
    const unit: MessageUnit = { kind: "group", msgs: [[index, message]], ids };
    units.push(unit);
    for (const id of ids) owners.set(id, unit);
  });
  rest.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) return;
    const owner = message.role === "tool" ? owners.get(message.tool_call_id) : undefined;
    if (owner) owner.msgs.push([index, message]);
    else units.push({ kind: message.role === "tool" ? "orphan_tool" : message.role === "user" ? "user" : "assistant", msgs: [[index, message]], ids: new Set() });
  });
  return units.sort((a, b) => a.msgs[0]![0] - b.msgs[0]![0]);
}

function offload(session: Session, message: Row, content: string): string {
  if (session.read_only || typeof session.root !== "string" || !session.root || typeof message.tool_call_id !== "string" || !message.tool_call_id) return "";
  const safe = message.tool_call_id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  if (!safe) return "";
  try {
    const directory = join(session.root, ".xueness", "artifacts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, safe + ".txt"), content, "utf8");
  } catch { return ""; }
  return `[full output offloaded to .xueness/artifacts/${safe}.txt]`;
}

export function outputWindow(content: string, limit: number, pointer: string): string {
  const tailRoom = Math.max(0, limit - OFFLOAD_HEAD - pyLen(pointer) - 4);
  return [pySlice(content, OFFLOAD_HEAD), pointer, tailRoom ? Array.from(content).slice(-tailRoom).join("") : ""].filter(Boolean).join("\n\n");
}

const sizeOf = (value: unknown): number => pyLen(pyJsonDumps(value));
const list = (session: Session, key: string): unknown[] => {
  if (!Array.isArray(session[key])) session[key] = [];
  return session[key] as unknown[];
};

/** Preserve every human turn and call/result pairing; archive all shortened text. */
export function compact(session: Session, maxChars: number, maxTokens?: number | null, instructions?: string | null): void {
  const messages = session.messages as Row[];
  let size = sizeOf(messages);
  let estimated = Math.max(0, Math.floor(size / 4));
  const windowOversized = (): void => {
    const limit = Math.floor(maxChars / 4);
    for (const message of (session.messages as Row[]).slice(3)) {
      const content = message.content;
      if (message.role === "user" || typeof content !== "string" || pyLen(content) <= limit) continue;
      list(session, "archived_messages").push({ ...message });
      const pointer = offload(session, message, content);
      message.content = pointer ? outputWindow(content, limit, pointer) : pySlice(content, limit) + " [truncated in context]";
    }
  };
  if (size <= maxChars) {
    if (maxTokens !== null && maxTokens !== undefined && estimated > maxTokens) list(session, "compactions").push({ removed: 0, previous_chars: size, estimatedTokens: estimated, advisory: true });
    return;
  }
  if (messages.length <= 2) { windowOversized(); return; }
  const head = messages.slice(0, 2);
  const units = partitionUnits(messages.slice(2));
  if (!units.length) { windowOversized(); return; }
  const userUnits = units.filter((unit) => unit.kind === "user").length;
  let masked = 0;
  for (const unit of units.slice(0, Math.max(0, units.length - MASK_KEEP_RECENT_UNITS))) {
    for (const [, message] of unit.msgs) {
      if (message.role !== "tool" || typeof message.content !== "string" || pyLen(message.content) <= MASK_THRESHOLD) continue;
      list(session, "archived_messages").push({ ...message });
      message.content = pySlice(message.content, MASK_HEAD) + " [old output masked; full text kept in the journal archive]";
      masked += 1;
    }
  }
  const record = (removed: number): void => { list(session, "compactions").push({ removed, masked, previous_chars: size, estimatedTokens: estimated, kept_user_turns: userUnits }); };
  if (masked) {
    size = sizeOf(messages); estimated = Math.max(0, Math.floor(size / 4));
    if (size <= maxChars) { record(0); windowOversized(); return; }
  }
  const tailBudget = Math.max(80, Math.floor(maxChars / 4));
  const kept = units.map(() => false);
  let used = sizeOf(head);
  let tailKept = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    const cost = sizeOf(unit.msgs.map(([, message]) => message));
    if (unit.kind === "user") { kept[index] = true; used += cost; }
    else if (used + cost <= tailBudget || tailKept < 2) { kept[index] = true; used += cost; tailKept += 1; }
  }
  const dropped = units.flatMap((unit, index) => kept[index] ? [] : unit.msgs.map(([, message]) => message));
  if (!dropped.length) { record(0); windowOversized(); return; }
  const digest = dropped.map((message) => pyStr(Object.hasOwn(message, "role") ? message.role : "?") + ":" + pySlice(pyStr(Object.hasOwn(message, "content") ? message.content : ""), 80)).join("; ");
  const note = typeof instructions === "string" && instructions.trim() ? " operator note: " + pySlice(instructions.trim().split(/\s+/u).join(" "), 400) : "";
  const summary: Row = { role: "system", content: "Older history compacted" + note + "; consult durable journal for details: " + pySlice(digest, tailBudget) };
  const tail = units.flatMap((unit, index) => kept[index] ? unit.msgs : []).sort((a, b) => a[0] - b[0]).map(([, message]) => message);
  list(session, "archived_messages").push(...dropped);
  session.messages = [head[0], summary, head[1], ...tail];
  const positions = new Map((session.messages as Row[]).map((message, index) => [message, index]));
  if (isDict(session.message_annotations)) {
    const annotations: Row = {};
    for (const [key, value] of Object.entries(session.message_annotations)) {
      if (!/^\p{Decimal_Number}+$/u.test(key)) continue;
      const index = positions.get(messages[Number(key)]!);
      if (index !== undefined) Object.defineProperty(annotations, String(index), { value, enumerable: true, configurable: true, writable: true });
    }
    session.message_annotations = annotations;
  }
  for (const key of ["reasoning_history", "reasoning_timing"]) {
    if (!Array.isArray(session[key])) continue;
    session[key] = (session[key] as unknown[]).filter(isDict).flatMap((row) => {
      const old = row.message_index;
      const index = typeof old === "number" && Number.isInteger(old) && old >= 0 ? positions.get(messages[old]!) : undefined;
      return index === undefined ? [] : [{ ...row, message_index: index }];
    });
  }
  record(dropped.length); windowOversized();
}
