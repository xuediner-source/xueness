import { decodeJournalMessage, encodeJournalMessage, roundTrips, canonicalSessionDigest } from "/workspace/xueness-021/ts/packages/sessions/src/message-model.ts";
import { digest, jsonEquals } from "/workspace/xueness-021/ts/packages/sessions/src/history-ops.ts";

const base = { role: "assistant", content: "hi", _message_id: "a".repeat(32), _turn_id: "turn-1" };
const cases: [string, any][] = [
  ["empty tool_calls", { ...base, tool_calls: [] }],
  ["empty _media_refs", { ...base, _media_refs: [] }],
  ["tool_calls present", { ...base, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }],
  ["empty string content", { ...base, content: "" }],
  ["null content", { ...base, content: null }],
  ["tool row no content", { role: "tool", tool_call_id: "c1", _message_id: "b".repeat(32), _turn_id: "turn-1" }],
  ["tool row is_error false", { role: "tool", tool_call_id: "c1", content: "x", is_error: false, _message_id: "b".repeat(32), _turn_id: "turn-1" }],
  ["hidden", { ...base, _hidden: true }],
  ["compaction", { role: "user", content: "", _compaction: { marker: "m" }, _message_id: "c".repeat(32), _turn_id: "turn-1" }],
];
for (const [name, row] of cases) {
  const d = decodeJournalMessage(structuredClone(row));
  const enc = encodeJournalMessage(d);
  console.log(name.padEnd(24), "roundTrips=", roundTrips(structuredClone(row)), "equal=", jsonEquals(enc, row), "enc=", JSON.stringify(enc));
}
console.log("--- digest key order ---");
const s1 = { messages: [{ ...base }] };
const s2 = { messages: [{ _turn_id: "turn-1", _message_id: "a".repeat(32), content: "hi", role: "assistant" }] };
console.log("digest1", canonicalSessionDigest(s1));
console.log("digest2", canonicalSessionDigest(s2));
console.log("same", canonicalSessionDigest(s1) === canonicalSessionDigest(s2));
console.log("jsonEquals reordered", jsonEquals(s1.messages[0], s2.messages[0]));
