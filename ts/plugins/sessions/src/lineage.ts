/** Canonical fork/edit-retry/rewind intents: one command, one effect, one durable lineage row. */
import { isDict, pyEquals, pyUtcNow, PyValueError } from "@xueness/contracts";
import { Sidecar } from "./queue-fs.ts";
import { acknowledgement } from "./command-receipts.ts";
import { fingerprint, HASH, issuedMs, RETENTION_MS, type Row } from "./queue-types.ts";

export const CANONICAL_HISTORY_INTENTS = ["fork", "edit_retry", "rewind"] as const;
export type CanonicalHistoryIntent = typeof CANONICAL_HISTORY_INTENTS[number];
export const MAX_LINEAGE_ROWS = 128, MAX_LINEAGE_COMMANDS = 256, MAX_LINEAGE_BYTES = 8 * 1024 * 1024;

export interface LineageCommandClaim { commandId: string; fingerprint: string; intent: CanonicalHistoryIntent; ack: Row | null }
export interface LineageRow {
  commandId: string; intent: CanonicalHistoryIntent; parentId: string; time: string;
  parentRevision?: string; childSessionId?: string; boundaryTurn?: number; boundaryEndIndex?: number;
  checkpointId?: string; messageId?: string; generation?: number; removedMessageIds?: string[]; hiddenMessageIds?: string[]; context?: Row;
}
export type LineageOutcome = { outcome: "executed" | "duplicate" | "conflict" | "unknown"; reply: [number, Row]; lineage?: LineageRow };

const INTENT = new Set<string>(CANONICAL_HISTORY_INTENTS);

function validId(value: unknown): string { issuedMs(value); return value as string; }

/** Durable per-session record of canonical history commands and their lineage rows. */
export class LineageSidecar extends Sidecar {
  constructor(root: string) { super(root, "session-lineage", true); }
  readRecord(sid: string): Row {
    const r = this.read(sid, MAX_LINEAGE_BYTES) ?? { schema: 1, commands: [], lineage: [], retiredBefore: 0 };
    const retired = Object.hasOwn(r, "retiredBefore") ? r.retiredBefore : 0;
    if (!isDict(r) || !pyEquals(r.schema, 1) || !Array.isArray(r.commands) || r.commands.length > MAX_LINEAGE_COMMANDS
      || !Array.isArray(r.lineage) || r.lineage.length > MAX_LINEAGE_ROWS || typeof retired !== "number" || !Number.isInteger(retired) || retired < 0) throw new PyValueError("invalid session lineage record");
    const ids = new Set();
    for (const claim of r.commands as Row[]) {
      if (!isDict(claim) || typeof claim.commandId !== "string" || ids.has(claim.commandId) || typeof claim.fingerprint !== "string"
        || !HASH.test(claim.fingerprint) || !INTENT.has(String(claim.intent))) throw new PyValueError("invalid lineage command claim");
      issuedMs(claim.commandId); ids.add(claim.commandId);
      if (claim.ack != null && (!isDict(claim.ack) || claim.ack.commandId !== claim.commandId || !["accepted", "rejected", "stale", "noop", "failed"].includes(String(claim.ack.status)))) throw new PyValueError("invalid lineage acknowledgement");
    }
    for (const row of r.lineage as Row[]) {
      if (!isDict(row) || typeof row.commandId !== "string" || !row.commandId || !INTENT.has(String(row.intent)) || row.parentId !== sid || typeof row.time !== "string") throw new PyValueError("invalid lineage row");
    }
    return r;
  }
  saveRecord(sid: string, record: Row): void { this.save(sid, record, MAX_LINEAGE_BYTES); }
  appendRow(sid: string, row: LineageRow): void {
    this.locked(sid, () => {
      const record = this.readRecord(sid);
      const lineage = (record.lineage as Row[]).filter((existing) => existing.commandId !== row.commandId);
      record.lineage = [...lineage, row as Row].slice(-MAX_LINEAGE_ROWS);
      this.saveRecord(sid, record);
    });
  }
}

export function validateHistoryCommandId(value: unknown): string {
  if (typeof value !== "string") throw new PyValueError("commandId must be c_<epoch-ms>_<uuid>");
  return validId(value);
}

export function lineageFingerprint(intent: CanonicalHistoryIntent, payload: Row): string { return fingerprint({ intent, payload }); }

/** Record linkage for an intent settled elsewhere (edit retries arrive with their own command envelope). */
export function recordLineageRow(sidecar: LineageSidecar, sid: string, row: Omit<LineageRow, "parentId" | "time">): void {
  sidecar.appendRow(sid, { ...row, parentId: sid, time: pyUtcNow() });
}

function settledAck(commandId: string, status: number, result: Row): Row {
  if (status >= 200 && status < 300) return acknowledgement(commandId, "accepted", { result });
  const body = isDict(result) ? result : {};
  const reason = body.reasonCode || body.error_code || (status === 409 ? "state_conflict" : [401, 403].includes(status) ? "forbidden" : status < 500 ? "invalid_input" : "write_failed");
  return acknowledgement(commandId, ["stale_turn", "history_changed"].includes(String(reason)) ? "stale" : status >= 500 ? "failed" : "rejected", { reason, message: body.error });
}

/**
 * Execute a canonical history intent exactly once per commandId. The claim is durable
 * before execution, replays return the recorded acknowledgement, and uncertain claims
 * (crash between claim and settle) never re-execute.
 */
export async function applyCanonicalIntent(
  sidecar: LineageSidecar, sid: string,
  command: { commandId: string; intent: CanonicalHistoryIntent; payload: Row },
  run: () => Promise<{ status: number; result: Row }>,
  lineage?: (result: Row) => Omit<LineageRow, "commandId" | "intent" | "parentId" | "time">,
): Promise<LineageOutcome> {
  validId(command.commandId);
  const fp = lineageFingerprint(command.intent, command.payload);
  return await sidecar.locked(sid, async (): Promise<LineageOutcome> => {
    const record = sidecar.readRecord(sid);
    // Claims age out like the sibling command-receipt window, so the bounded
    // command list can never permanently lock a session out of history intents.
    const floor = Math.max(typeof record.retiredBefore === "number" ? record.retiredBefore : 0, Date.now() - RETENTION_MS);
    if (issuedMs(command.commandId) <= floor) return { outcome: "conflict", reply: [200, acknowledgement(command.commandId, "stale", { reason: "command_expired", message: "commandId is older than the lineage retention window; resubmit with a new commandId" })] };
    const claims = record.commands as Row[], live = claims.filter((claim) => issuedMs(claim.commandId) > floor);
    if (live.length !== claims.length) { record.commands = live; record.retiredBefore = floor; sidecar.saveRecord(sid, record); }
    const prior = live.find((claim) => claim.commandId === command.commandId);
    if (prior) {
      if (prior.fingerprint !== fp) return { outcome: "conflict", reply: [200, acknowledgement(command.commandId, "rejected", { reason: "command_id_conflict", message: "commandId was already used for another intent payload" })] };
      if (prior.ack == null) return { outcome: "unknown", reply: [503, { error: "intent outcome unknown; query the command without resubmitting", commandId: command.commandId, reasonCode: "command_unknown" }] };
      return { outcome: "duplicate", reply: [200, { ...prior.ack, originalStatus: prior.ack.status, status: "duplicate" }] };
    }
    if (live.length >= MAX_LINEAGE_COMMANDS) return { outcome: "conflict", reply: [200, acknowledgement(command.commandId, "rejected", { reason: "command_capacity", message: "The session lineage command window is full" })] };
    const claim: LineageCommandClaim = { commandId: command.commandId, fingerprint: fp, intent: command.intent, ack: null };
    (record.commands as Row[]).push(claim as unknown as Row);
    sidecar.saveRecord(sid, record);
    const executed = await run();
    const ack = settledAck(command.commandId, executed.status, executed.result);
    claim.ack = ack;
    let row: LineageRow | undefined;
    if (executed.status >= 200 && executed.status < 300 && lineage) {
      row = { ...lineage(executed.result), commandId: command.commandId, intent: command.intent, parentId: sid, time: pyUtcNow() };
      record.lineage = [...record.lineage as Row[], row as Row].slice(-MAX_LINEAGE_ROWS);
    }
    sidecar.saveRecord(sid, record);
    return { outcome: "executed", reply: [executed.status, executed.result], ...(row ? { lineage: row } : {}) };
  });
}
