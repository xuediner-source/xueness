import { createHash } from "node:crypto";
import { isDict, pyEncodeUtf8, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { PyOSError, type Session } from "@xueness/sessions";
import type { SessionsApiOptions, SessionReply } from "./http-api.ts";
export type Row = Record<string, any>;
export const SID = /^[0-9a-f]{32}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const ACTIVE = new Set(["queued", "running", "paused"]);
export const FINAL = new Set(["completed", "needs_review", "failed", "cancelled"]);
export const MAX_ITEM_BYTES = 6 * 1024 * 1024, MAX_PENDING_BYTES = 12 * 1024 * 1024, MAX_PENDING = 20, HISTORY_LIMIT = 40;
export const RETENTION_MS = 86400000;
export class QueueConflict extends PyValueError { override name = "QueueConflict"; }
export class QueueNotFound extends PyOSError { override name = "FileNotFoundError"; }
export interface SessionCommandsOptions extends SessionsApiOptions {
  executeCommand?: (type: string, payload: Row, sid: string, command: { id: string; fingerprint: string }) => Promise<SessionReply>;
  consumePrepared?: (token: string, root: string) => Promise<Row>;
  activeContext?: ReadonlyMap<string, Row>;
  requestStop?: (sid: string, turnId?: string) => void;
  validateWorkspace?: (session: Session) => void | Promise<void>;
  preparedRemote?: (prepared: Row) => unknown | Promise<unknown>;
  mediaCommand?: { id: string; fingerprint: string };
  /** A false preflight relays before publishing any durable command claim. */
  supportsCommand?: (type: string, payload: Row, sid: string, commandId: string) => boolean | Promise<boolean>;
}
export function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new PyValueError("expectedRevision must be a nonnegative safe integer");
  return value;
}
export function checkRevision(record: Row, revision: unknown): void {
  if (revision != null && record.revision !== validateRevision(revision)) throw new QueueConflict("message queue changed; refresh before modifying");
}
export function validateExpectedTurn(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 128) throw new PyValueError("expected_turn_id must be a nonempty string of at most 128 characters");
  return value;
}
export function issuedMs(id: unknown): number {
  const match = typeof id === "string" && /^c_([0-9]{13})_([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id);
  if (!match) throw new PyValueError("commandId must be c_<epoch-ms>_<uuid>");
  return Number(match[1]);
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(pyJsonDumps(value, { ensureAscii: true, sortKeys: true, separators: [",", ":"] })).digest("hex");
export const dict = (value: unknown): Row => isDict(value) ? value : {};
export const keysAre = (value: Row, names: string[]): boolean => Object.keys(value).sort().join(",") === [...names].sort().join(",");
export const onlyKeys = (value: Row, names: string[]): boolean => Object.keys(value).every((key) => names.includes(key));
export const size = (value: string): number => pyEncodeUtf8(value).length;
export const itemSize = (row: Row): number => size(row.text) + size(row.prepared?.text ?? "");
export const trimHistory = (items: Row[]): Row[] => [...items.filter((r) => ACTIVE.has(r.status)), ...items.filter((r) => !ACTIVE.has(r.status)).slice(-HISTORY_LIMIT)];
