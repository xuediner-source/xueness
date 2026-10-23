/** Small helpers shared by history differential tests. */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pyEncodeUtf8, pyJsonDumps } from "@xueness/contracts";
import { digest, scan, type HistoryRecord } from "../src/index.ts";
import { tempDir } from "./fixtures.ts";

export type Row = Record<string, unknown>;
export const HISTORY_ID = "0123456789abcdef0123456789abcdef";

export function historyDirectory(label: string): string {
  return tempDir(`history-${label}`);
}

export function cleanDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function journalPath(directory: string, sid = HISTORY_ID): string {
  return join(directory, `${sid}.history.jsonl`);
}

export function basicSession(sid = HISTORY_ID): Row {
  return { id: sid, task: "history differential", root: "C:/workspace", status: "pending", messages: [], steps: 0 };
}

export function scanResult(path: string): Row {
  try {
    const snapshot = scan(path);
    return {
      ok: true,
      stateHash: digest(snapshot.state),
      records: snapshot.records.length,
      size: snapshot.size,
      seqs: snapshot.records.map((record: HistoryRecord) => record.seq),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).name };
  }
}

export function recordLine(row: Row): Buffer {
  return pyEncodeUtf8(`${pyJsonDumps(row, { separators: [",", ":"] })}\n`);
}

export function signedRecord(fields: Row): Row {
  const row = { ...fields };
  row.recordHash = digest(row);
  return row;
}

export function writeBytes(path: string, data: Buffer): void {
  writeFileSync(path, data);
}

