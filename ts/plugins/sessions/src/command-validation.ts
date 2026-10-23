import { isDict, pyLen, pyStrip, PyValueError } from "@xueness/contracts";
import { dict, keysAre, onlyKeys, SID, validateExpectedTurn, validateRevision, type Row } from "./queue-types.ts";
export const COMMAND_TYPES = ["send", "queue", "edit_queue", "cancel_queue", "withdraw_queue", "reorder_queue", "stop", "run", "edit_message", "fork", "approve", "reject", "approval"];
export function validateCommand(data: unknown, collection: boolean): Row {
  const types = collection ? ["create_session"] : COMMAND_TYPES;
  if (!isDict(data) || !keysAre(data, ["commandId", "type", "payload"]) || !types.includes(data.type as string) || !isDict(data.payload)) throw new PyValueError(`expected commandId, type (${types.join("/")}), and payload`);
  const p = data.payload;
  if (data.type === "stop") {
    if (!keysAre(p, ["expected_turn_id"]) || p.expected_turn_id != null && (typeof p.expected_turn_id !== "string" || !p.expected_turn_id || pyLen(p.expected_turn_id) > 128)) throw new PyValueError("stop requires expected_turn_id (observed turn or null)");
  } else if (data.type === "fork") {
    if (!onlyKeys(p, ["boundary", "revision", "title"]) || !("boundary" in p) || !("revision" in p) || typeof p.boundary !== "string" || pyLen(p.boundary) < 1 || pyLen(p.boundary) > 80 || typeof p.revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.revision) || "title" in p && typeof p.title !== "string") throw new PyValueError("fork requires boundary, revision, and optional title");
  } else if (data.type === "edit_message") {
    if (!["action", "messageIndex", "revision", "text"].every((k) => k in p) || !onlyKeys(p, ["action", "messageIndex", "revision", "text", "prepared_token"]) || p.action !== "edit") throw new PyValueError("edit_message requires action edit, messageIndex, revision, and text");
    if (typeof p.revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.revision)) throw new PyValueError("invalid message revision");
    if (typeof p.messageIndex !== "number" || !Number.isInteger(p.messageIndex) || p.messageIndex < 0) throw new PyValueError("invalid message target");
    if (typeof p.text !== "string" || !pyStrip(p.text) || pyLen(p.text) > 50000 || p.text.includes("\0")) throw new PyValueError("invalid edited message");
    if ("prepared_token" in p && (typeof p.prepared_token !== "string" || !SID.test(p.prepared_token))) throw new PyValueError("invalid prepared attachment replacement");
  } else if (["approve", "reject", "approval"].includes(String(data.type))) {
    if (typeof p.kind !== "string" || !p.kind || typeof p.tool_call_id !== "string" || !p.tool_call_id) throw new PyValueError(`${data.type} requires kind and tool_call_id`);
    if (p.decision != null && !["approve", "reject"].includes(String(p.decision))) throw new PyValueError("decision must be 'approve' or 'reject'");
    if (data.type === "reject" && p.decision != null && p.decision !== "reject") throw new PyValueError("reject cannot specify decision other than 'reject'");
    if (data.type === "approve" && p.decision != null && p.decision !== "approve") throw new PyValueError("approve cannot specify decision other than 'approve'");
  }
  return data;
}
/** New CAS fields are checked after retained-receipt replay, as in Python. */
export function validateNewCommand(data: Row): void {
  const p = data.payload as Row;
  if (data.type === "queue" && "expected_turn_id" in p) validateExpectedTurn(p.expected_turn_id);
  if (!["edit_queue", "cancel_queue", "withdraw_queue", "reorder_queue"].includes(data.type)) return;
  const fields = data.type === "edit_queue" ? ["queueId", "text", "expectedText", "expectedRevision"] : data.type === "reorder_queue" ? ["ids", "expectedIds", "expectedRevision"] : ["queueId", "expectedText", "expectedRevision"];
  if (!keysAre(p, fields)) throw new PyValueError(`${data.type} requires ${fields.sort().join(", ")}`);
  if (data.type !== "reorder_queue" && (typeof p.queueId !== "string" || !SID.test(p.queueId))) throw new PyValueError("invalid queue id");
  if (data.type === "withdraw_queue" && (typeof p.expectedText !== "string" || pyLen(p.expectedText) < 1 || pyLen(p.expectedText) > 5000 || p.expectedText.includes("\0"))) throw new PyValueError("expectedText must be 1..5000 characters");
  validateRevision(p.expectedRevision);
}
