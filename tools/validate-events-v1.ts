import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import {
  isXuenessEventV1,
  parseEventsEnvelope,
  pageEvents,
  errorCodeFor,
  toLegacyEvent,
  type XuenessEventV1,
} from "../webapp/src/xuenessEvents";

function runValidation() {
  const root = resolve(import.meta.dirname, "..");
  const goldenPath = resolve(root, "tools/protocol-v1-golden.json");
  const raw = readFileSync(goldenPath, "utf-8");
  const golden = JSON.parse(raw);

  const events: XuenessEventV1[] = golden.expected.events;

  console.log("=== Validating Xueness Event Protocol v1 against Golden JSON ===\n");

  // 1. 断言对 expected.events 每条 isXuenessEventV1 为 true
  console.log(`Checking ${events.length} golden events with isXuenessEventV1...`);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    assert.equal(isXuenessEventV1(ev), true, `golden event #${i} (seq: ${ev.seq}) should be valid`);
  }
  console.log("PASS: All golden events are valid XuenessEventV1\n");

  // 2. 断言对若干精心构造的坏样例为 false
  console.log("Checking malformed events with isXuenessEventV1...");
  const badEvents: unknown[] = [
    null,
    undefined,
    123,
    "not-an-event",
    {},
    // 坏 schema
    { ...events[0], schema: "xueness.event.v2" },
    // seq 为 0 或负数或浮点数
    { ...events[0], seq: 0 },
    { ...events[0], seq: -1 },
    { ...events[0], seq: 1.5 },
    { ...events[0], seq: "1" },
    // sessionId 不是 string
    { ...events[0], sessionId: 123 },
    // 未知 type
    { ...events[0], type: "unknown.type" },
    // session.status 缺字段 / 类型错
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.status", steps: 0, mode: "" }, // 缺 status
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.status", status: "ok", steps: "0", mode: "" }, // steps 类型错
    // turn.user 缺 preview
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "turn.user", turnId: "t1" },
    // assistant.text 缺 turnId
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "assistant.text", preview: "hi" },
    // tool.call 缺 subject
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "tool.call", turnId: "t1", toolCallId: "c1", name: "write" },
    // tool.result 缺 ok 或 errorCode 或 error
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "tool.result", turnId: "t1", toolCallId: "c1", name: "write", subject: "", ok: "true" },
    // session.completion evidenceCount 负数或非整
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.completion", verified: true, summary: "done", evidenceCount: -1 },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.completion", verified: true, summary: "done", evidenceCount: 1.5 },
    // session.pending_question 缺 question
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.pending_question" },
  ];

  for (let i = 0; i < badEvents.length; i++) {
    assert.equal(isXuenessEventV1(badEvents[i]), false, `bad event #${i} must be rejected`);
  }
  console.log(`PASS: All ${badEvents.length} malformed event cases rejected\n`);

  // 3. 断言 pageEvents 对每个 expected.envelopes 用例产出与 eventSeqs 一致的 seq 列表、且 cursor/nextCursor/head/hasMore 全等
  console.log("Checking pageEvents against expected.envelopes...");
  const envelopesCases = golden.expected.envelopes;
  for (let i = 0; i < envelopesCases.length; i++) {
    const { request, expect: exp } = envelopesCases[i];
    const res = pageEvents(events, request.cursor, request.limit);

    assert.equal(res.cursor, exp.cursor, `envelope #${i} cursor mismatch`);
    assert.equal(res.nextCursor, exp.nextCursor, `envelope #${i} nextCursor mismatch`);
    assert.equal(res.head, exp.head, `envelope #${i} head mismatch`);
    assert.equal(res.hasMore, exp.hasMore, `envelope #${i} hasMore mismatch`);

    const seqs = res.events.map((e) => e.seq);
    assert.deepEqual(seqs, exp.eventSeqs, `envelope #${i} eventSeqs mismatch`);
  }
  console.log(`PASS: All ${envelopesCases.length} envelope cases match golden JSON exactly\n`);

  // 4. 断言 errorCodeFor 对 expected.errorCodes 每条全等
  console.log("Checking errorCodeFor against golden errorCodes...");
  const errorCases = golden.errorCodes;
  for (let i = 0; i < errorCases.length; i++) {
    const ec = errorCases[i];
    const code = errorCodeFor(ec.ok, ec.error);
    assert.equal(
      code,
      ec.expect,
      `errorCodeFor(ok=${ec.ok}, error="${ec.error}") returned "${code}", expected "${ec.expect}"`,
    );
  }
  console.log(`PASS: All ${errorCases.length} errorCode cases match golden expectations\n`);

  // 5. 断言 parseEventsEnvelope 对合法信封和坏信封行为
  console.log("Checking parseEventsEnvelope...");
  const validEnvelope = {
    schema: "xueness.events.v1",
    protocolVersion: 1,
    sessionId: golden.session.id,
    status: golden.session.status,
    steps: golden.session.steps,
    mode: golden.session.mode,
    events: events,
    cursor: 0,
    nextCursor: golden.expected.head,
    head: golden.expected.head,
    hasMore: false,
  };
  const parsed = parseEventsEnvelope(validEnvelope);
  assert.ok(parsed !== null, "valid envelope should parse successfully");
  assert.equal(parsed?.events.length, events.length);

  assert.equal(parseEventsEnvelope(null), null);
  assert.equal(parseEventsEnvelope({ ...validEnvelope, schema: "bad" }), null);
  assert.equal(parseEventsEnvelope({ ...validEnvelope, protocolVersion: 2 }), null);
  assert.equal(parseEventsEnvelope({ ...validEnvelope, cursor: -1 }), null);
  assert.equal(parseEventsEnvelope({ ...validEnvelope, events: [{ bad: true }] }), null);
  console.log("PASS: parseEventsEnvelope behaves correctly\n");

  // 6. 断言 toLegacyEvent 对 7 种事件的行为
  console.log("Checking toLegacyEvent projection for all 7 event types...");
  // 找黄金中的 7 种事件，或构造缺失的 2 种
  const statusEv = events.find((e) => e.type === "session.status")!;
  const toolCallEv = events.find((e) => e.type === "tool.call")!;
  const toolResultEv = events.find((e) => e.type === "tool.result")!;
  const asstEv = events.find((e) => e.type === "assistant.text")!;
  const userEv = events.find((e) => e.type === "turn.user")!;
  const compEv = events.find((e) => e.type === "session.completion")!;
  const pendingEv: XuenessEventV1 = {
    schema: "xueness.event.v1",
    seq: 10,
    sessionId: "test",
    type: "session.pending_question",
    question: "Do you agree?",
  };

  // session.status -> null (legacy snapshot uses session state object directly)
  assert.equal(toLegacyEvent(statusEv), null, "session.status should project to null");
  // session.pending_question -> null (legacy snapshot uses session.pending_question field directly)
  assert.equal(toLegacyEvent(pendingEv), null, "session.pending_question should project to null");

  // tool.call -> { type: "tool_call", id, name, subject }
  const legacyToolCall = toLegacyEvent(toolCallEv);
  assert.deepEqual(legacyToolCall, {
    type: "tool_call",
    id: toolCallEv.toolCallId,
    name: toolCallEv.name,
    subject: toolCallEv.subject,
  });

  // tool.result -> { type: "tool_result", id, subject, ok, error }
  const legacyToolResult = toLegacyEvent(toolResultEv);
  assert.deepEqual(legacyToolResult, {
    type: "tool_result",
    id: toolResultEv.toolCallId,
    subject: toolResultEv.subject,
    ok: toolResultEv.ok,
    error: toolResultEv.error,
  });

  // assistant.text -> { type: "assistant", preview }
  const legacyAsst = toLegacyEvent(asstEv);
  assert.deepEqual(legacyAsst, {
    type: "assistant",
    preview: asstEv.preview,
  });

  // turn.user -> { type: "user", preview }
  const legacyUser = toLegacyEvent(userEv);
  assert.deepEqual(legacyUser, {
    type: "user",
    preview: userEv.preview,
  });

  // session.completion -> { type: "completion", verified, summary }
  const legacyComp = toLegacyEvent(compEv);
  assert.deepEqual(legacyComp, {
    type: "completion",
    verified: compEv.verified,
    summary: compEv.summary,
  });

  console.log("PASS: toLegacyEvent correctly projects 5 supported types and returns null for 2 unprojectable types\n");
}

try {
  runValidation();
  console.log("RESULT: OK");
  process.exit(0);
} catch (err) {
  console.error("FAIL: Validation encountered an error:", err);
  console.log("RESULT: FAIL");
  process.exit(1);
}
