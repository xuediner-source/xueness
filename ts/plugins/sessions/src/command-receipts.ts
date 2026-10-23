import { isDict, pyEquals, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { Sidecar } from "./queue-fs.ts";
import { HASH, issuedMs, size, type Row } from "./queue-types.ts";
export const MAX_COMMANDS = 256, MAX_ACK_BYTES = 65536;
const MAX_FILE_BYTES = 18 * 1024 * 1024;
export class CommandReceipts extends Sidecar {
  constructor(root: string) { super(root, "session-command-receipts", true); }
  readRecord(sid: string): Row {
    const r = this.read(sid, MAX_FILE_BYTES) ?? { schema: 1, commands: [], retiredBefore: 0 };
    const retired = Object.hasOwn(r, "retiredBefore") ? r.retiredBefore : 0;
    if (!isDict(r) || !pyEquals(r.schema, 1) || !Array.isArray(r.commands) || r.commands.length > MAX_COMMANDS || typeof retired !== "number" || !Number.isInteger(retired) || retired < 0) throw new PyValueError("invalid command receipts");
    const ids = new Set();
    for (const row of r.commands as Row[]) {
      if (!isDict(row) || typeof row.commandId !== "string" || ids.has(row.commandId) || typeof row.fingerprint !== "string" || !HASH.test(row.fingerprint)) throw new PyValueError("invalid command claim");
      issuedMs(row.commandId); ids.add(row.commandId);
      if (row.ack != null && (!isDict(row.ack) || row.ack.commandId !== row.commandId || !["accepted", "rejected", "stale", "noop", "failed"].includes(String(row.ack.status)) || size(pyJsonDumps(row.ack)) > MAX_ACK_BYTES)) throw new PyValueError("invalid command acknowledgement");
    }
    return r;
  }
  saveRecord(sid: string, record: Row): void { this.save(sid, record, MAX_FILE_BYTES, 2); }
}
export function acknowledgement(commandId: unknown, status: string, options: { result?: unknown; reason?: unknown; message?: unknown } = {}): Row {
  const body: Row = { commandId, status };
  if (options.result != null) body.result = options.result;
  if (options.reason) body.reasonCode = options.reason;
  if (options.message) body.message = options.message;
  if (size(pyJsonDumps(body)) > MAX_ACK_BYTES) { delete body.result; body.message = "Command settled; refresh the session for its current state"; }
  return body;
}
