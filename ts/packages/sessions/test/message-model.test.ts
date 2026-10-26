// C-SES-01: canonical message & content-part model — lossless decode/encode,
// typed parts, visibility, private metadata and duplicate identity rejection.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyJsonDumps, PyJsonDecodeError, PyTypeError, PyValueError } from "@xueness/contracts";
import { MULTIMODAL_MARKER } from "../src/attachments.ts";
import {
  canonicalSessionDigest, decodeJournalMessage, decodeSessionMessages, encodeJournalMessage, roundTrips,
  visiblePayload, type CanonicalPart,
} from "../src/message-model.ts";

type Row = Record<string, unknown>;
const mid = (char: string) => char.repeat(32);

function userRow(overrides: Row = {}): Row {
  return { role: "user", content: "hello", _turn_id: "turn-1", _message_id: mid("a"), ...overrides };
}

function sessionWith(...messages: Row[]): Row {
  return { id: mid("f"), task: "canonical model", status: "pending", messages };
}

function partTypes(message: ReturnType<typeof decodeJournalMessage>["message"]): string[] {
  return message.parts.map((part: CanonicalPart) => part.type);
}

describe("decode/encode round trip is lossless", () => {
  it("keeps a plain text message byte equal", () => {
    const row = userRow({ _input_kind: "keyboard", extra: { nested: [1, 2, 3] } });
    assert.ok(roundTrips(row));
    const { message } = decodeJournalMessage(row);
    assert.equal(message.origin, "user");
    assert.equal(message.visibility, "visible");
    assert.deepEqual(partTypes(message), ["text"]);
  });

  it("keeps structured (non-string) content as a document part", () => {
    const row = userRow({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    assert.ok(roundTrips(row));
    assert.deepEqual(partTypes(decodeJournalMessage(row).message), ["document"]);
  });

  it("keeps a tool result with content and error flag", () => {
    const row: Row = {
      role: "tool", tool_call_id: "call-1", content: "boom", is_error: true,
      _turn_id: "turn-2", _message_id: mid("b"),
    };
    assert.ok(roundTrips(row));
    const part = decodeJournalMessage(row).message.parts[0]!;
    assert.equal(part.type, "tool_result");
    assert.deepEqual(part, { type: "tool_result", toolCallId: "call-1", content: "boom", hasContent: true, isError: true });
  });

  it("keeps a tool result without content (absent content stays absent)", () => {
    const row: Row = { role: "tool", tool_call_id: "call-2", _turn_id: "turn-2", _message_id: mid("c") };
    assert.ok(roundTrips(row));
    const part = decodeJournalMessage(row).message.parts[0]!;
    assert.deepEqual(part, { type: "tool_result", toolCallId: "call-2", content: null, hasContent: false, isError: false });
    assert.equal("content" in row, false);
  });

  it("keeps assistant tool calls, their raw entries and reasoning", () => {
    const call = { id: "call-3", function: { name: "read_file", arguments: '{"path":"a.txt"}' } };
    const row: Row = {
      role: "assistant", content: null, reasoning: "thinking", tool_calls: [call, { id: "call-4", function: { name: "ls", arguments: "{}" } }],
      _turn_id: "turn-3", _message_id: mid("d"),
    };
    assert.ok(roundTrips(row));
    const { message } = decodeJournalMessage(row);
    assert.deepEqual(partTypes(message), ["tool_call", "tool_call", "reasoning"].sort());
    const first = message.parts.find((part) => part.type === "tool_call")!;
    assert.equal(first.name, "read_file");
    assert.equal(first.arguments, '{"path":"a.txt"}');
  });

  it("keeps media groups (multimodal marker block) and private media references", () => {
    const encoded = pyJsonDumps([{ path: "cat.png", sha256: "ab", data: "AAE=" }], { separators: [",", ":"] });
    const row = userRow({
      content: "look" + MULTIMODAL_MARKER + encoded,
      _media_refs: [{ id: "media-1", mimeType: "image/png", sha256: "ab" }],
    });
    assert.ok(roundTrips(row));
    const { message } = decodeJournalMessage(row);
    assert.deepEqual(partTypes(message), ["text", "media_group", "media_ref"]);
    const group = message.parts.find((part) => part.type === "media_group")!;
    assert.equal(group.encoded, encoded);
    const ref = message.parts.find((part) => part.type === "media_ref")!;
    assert.equal(ref.mediaId, "media-1");
  });

  it("rejects a torn marker block instead of losing the media payload", () => {
    const row = userRow({ content: "look" + MULTIMODAL_MARKER + "{not json" });
    assert.throws(
      () => decodeJournalMessage(row),
      (error: unknown) => error instanceof PyValueError || error instanceof PyJsonDecodeError,
    );
  });

  it("keeps hidden reminders, guide origins and compaction markers hidden", () => {
    const reminder = userRow({ _hidden: true, content: "quiet nudge", _message_id: mid("e") });
    const guide = userRow({ _input_kind: "guide", content: "guide note", _message_id: mid("9") });
    const compaction: Row = {
      role: "assistant", content: null, _compaction: { marker: "compact-7", kept: 3 },
      _turn_id: "turn-1", _message_id: mid("5"),
    };
    for (const row of [reminder, guide, compaction]) assert.ok(roundTrips(row), JSON.stringify(row));
    assert.equal(decodeJournalMessage(reminder).message.visibility, "hidden");
    const reminderPart = decodeJournalMessage(reminder).message.parts[0]!;
    assert.equal(reminderPart.type, "hidden_reminder");
    assert.equal(decodeJournalMessage(guide).message.origin, "guide");
    const compacted = decodeJournalMessage(compaction).message;
    assert.equal(compacted.visibility, "hidden");
    assert.deepEqual(partTypes(compacted), ["compaction"]);
  });

  it("preserves unknown private metadata in meta and nothing else", () => {
    const row = userRow({ _revision: 4, _read: false, _unknown_private: { a: 1 }, name: "session row field" });
    const decoded = decodeJournalMessage(row);
    assert.equal(decoded.message.revision, 4);
    assert.ok(roundTrips(row));
    assert.deepEqual(Object.keys(decoded.meta).sort(), ["_read", "_revision", "_unknown_private", "name"]);
  });

  it("rejects rows without stable identities or a valid role", () => {
    assert.throws(() => decodeJournalMessage({ role: "user", content: "x", _turn_id: "turn-1" }), PyValueError);
    assert.throws(() => decodeJournalMessage({ role: "user", content: "x", _message_id: mid("a") }), PyValueError);
    assert.throws(() => decodeJournalMessage({ role: "wizard", content: "x", _message_id: mid("a"), _turn_id: "turn-1" }), PyValueError);
    assert.throws(() => decodeJournalMessage("not an object"), PyTypeError);
    assert.throws(
      () => decodeJournalMessage({ role: "tool", tool_call_id: "", _message_id: mid("a"), _turn_id: "turn-1" }),
      PyValueError,
    );
  });
});

describe("visible payload excludes private metadata", () => {
  it("strips hidden parts, reasoning, media refs and media payloads", () => {
    const encoded = pyJsonDumps([{ path: "x.png", data: "AA==" }], { separators: [",", ":"] });
    const row: Row = {
      role: "assistant", content: "answer" + MULTIMODAL_MARKER + encoded, reasoning: "private thinking",
      _media_refs: [{ id: "m", mimeType: "image/png" }], _hidden: false, _read: true,
      _turn_id: "turn-2", _message_id: mid("b"),
    };
    const payload = visiblePayload(decodeJournalMessage(row).message);
    assert.equal(payload.role, "assistant");
    assert.deepEqual(payload.parts, [
      { type: "text", text: "answer" },
      { type: "media_group", text: "", encoded: "" },
    ]);
    const hiddenRow = userRow({ _hidden: true, _message_id: mid("c") });
    assert.deepEqual(visiblePayload(decodeJournalMessage(hiddenRow).message).parts, []);
  });
});

describe("decodeSessionMessages rejects duplicate identities", () => {
  it("rejects a reused message id across the session", () => {
    const session = sessionWith(userRow(), userRow({ content: "again", _message_id: mid("a") }));
    assert.throws(() => decodeSessionMessages(session), /duplicate message identity/);
  });

  it("rejects duplicate tool call ids inside one message", () => {
    const dup = { id: "call-x", function: { name: "a", arguments: "{}" } };
    const row: Row = {
      role: "assistant", content: null, tool_calls: [dup, { ...dup }],
      _turn_id: "turn-1", _message_id: mid("d"),
    };
    assert.throws(() => decodeSessionMessages(sessionWith(row)), /duplicate tool call identity/);
  });

  it("accepts the same tool call id across messages (call then result)", () => {
    const call: Row = {
      role: "assistant", content: null, tool_calls: [{ id: "call-9", function: { name: "ls", arguments: "{}" } }],
      _turn_id: "turn-1", _message_id: mid("1"),
    };
    const result: Row = { role: "tool", tool_call_id: "call-9", content: "ok", _turn_id: "turn-1", _message_id: mid("2") };
    assert.equal(decodeSessionMessages(sessionWith(call, result)).length, 2);
  });
});

describe("canonicalSessionDigest", () => {
  it("is stable under key reordering and sensitive to content edits", () => {
    const base = sessionWith(
      userRow(),
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "n", arguments: "{}" } }], _turn_id: "turn-1", _message_id: mid("b") },
    );
    const reordered = { ...base, messages: [...base.messages as Row[]].map((row) => ({ content: row.content, role: row.role, ...row })) };
    assert.equal(canonicalSessionDigest(base), canonicalSessionDigest(reordered));
    const edited = structuredClone(base);
    ((edited.messages as Row[])[0]!).content = "edited";
    assert.notEqual(canonicalSessionDigest(base), canonicalSessionDigest(edited));
  });
});
