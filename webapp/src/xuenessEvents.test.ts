import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isXuenessEventV1,
  parseEventsEnvelope,
  pageEvents,
  errorCodeFor,
  toLegacyEvent,
  type XuenessEventV1,
} from "./xuenessEvents";

describe("xuenessEvents", () => {
  const sampleEvents: XuenessEventV1[] = [
    {
      schema: "xueness.event.v1",
      seq: 1,
      sessionId: "s1",
      type: "session.status",
      status: "completed",
      steps: 4,
      mode: "build",
    },
    {
      schema: "xueness.event.v1",
      seq: 2,
      sessionId: "s1",
      type: "turn.user",
      turnId: "t1",
      preview: "hello",
    },
    {
      schema: "xueness.event.v1",
      seq: 3,
      sessionId: "s1",
      type: "tool.call",
      turnId: "t1",
      toolCallId: "call-1",
      name: "write",
      subject: "file.txt",
    },
    {
      schema: "xueness.event.v1",
      seq: 4,
      sessionId: "s1",
      type: "tool.result",
      turnId: "t1",
      toolCallId: "call-1",
      name: "write",
      subject: "file.txt",
      ok: true,
      errorCode: "",
      error: "",
    },
    {
      schema: "xueness.event.v1",
      seq: 5,
      sessionId: "s1",
      type: "assistant.text",
      turnId: "t1",
      preview: "Done writing file",
    },
    {
      schema: "xueness.event.v1",
      seq: 6,
      sessionId: "s1",
      type: "session.completion",
      verified: true,
      summary: "Finished",
      evidenceCount: 1,
    },
    {
      schema: "xueness.event.v1",
      seq: 7,
      sessionId: "s1",
      type: "session.pending_question",
      question: "Are you sure?",
    },
  ];

  describe("pageEvents", () => {
    it("pages sequentially through events", () => {
      const page1 = pageEvents(sampleEvents, 0, 3);
      assert.equal(page1.cursor, 0);
      assert.equal(page1.nextCursor, 3);
      assert.equal(page1.head, 7);
      assert.equal(page1.hasMore, true);
      assert.deepEqual(page1.events.map((e) => e.seq), [1, 2, 3]);

      const page2 = pageEvents(sampleEvents, page1.nextCursor, 3);
      assert.equal(page2.cursor, 3);
      assert.equal(page2.nextCursor, 6);
      assert.equal(page2.head, 7);
      assert.equal(page2.hasMore, true);
      assert.deepEqual(page2.events.map((e) => e.seq), [4, 5, 6]);

      const page3 = pageEvents(sampleEvents, page2.nextCursor, 3);
      assert.equal(page3.cursor, 6);
      assert.equal(page3.nextCursor, 7);
      assert.equal(page3.head, 7);
      assert.equal(page3.hasMore, false);
      assert.deepEqual(page3.events.map((e) => e.seq), [7]);
    });

    it("clamps limit between 1 and 500", () => {
      const minPage = pageEvents(sampleEvents, 0, 0);
      assert.equal(minPage.events.length, 1);

      const negLimit = pageEvents(sampleEvents, 0, -10);
      assert.equal(negLimit.events.length, 1);

      const maxPage = pageEvents(sampleEvents, 0, 1000);
      assert.equal(maxPage.events.length, 7);
    });

    it("handles cursor out of bounds (cursor >= head)", () => {
      const res = pageEvents(sampleEvents, 10, 50);
      assert.equal(res.cursor, 10);
      assert.equal(res.nextCursor, 10);
      assert.equal(res.head, 7);
      assert.equal(res.hasMore, false);
      assert.deepEqual(res.events, []);
    });

    it("handles empty events list", () => {
      const res = pageEvents([], 0, 10);
      assert.equal(res.cursor, 0);
      assert.equal(res.nextCursor, 0);
      assert.equal(res.head, 0);
      assert.equal(res.hasMore, false);
      assert.deepEqual(res.events, []);
    });
  });

  describe("errorCodeFor", () => {
    it("returns empty string when ok is true regardless of error text", () => {
      assert.equal(errorCodeFor(true, ""), "");
      assert.equal(errorCodeFor(true, "denied"), "");
      assert.equal(errorCodeFor(true, "invalid"), "");
    });

    it("evaluates rules in deterministic top-to-bottom priority order", () => {
      // 顺序："denied" > "cancel" > "not found" / "no such" > "invalid" / "required" > tool_failed

      // 含有 "denied" 且含 "invalid" -> 应该命中 denied
      assert.equal(errorCodeFor(false, "denied: invalid permission"), "xueness.error.denied");

      // 开头为 "denied" 且含 "cancel" -> 应该命中 denied
      assert.equal(errorCodeFor(false, "Denied: cancelled by operator"), "xueness.error.denied");

      // 包含 "cancel" 且含 "not found" -> 应该命中 cancelled
      assert.equal(errorCodeFor(false, "cancelled because resource not found"), "xueness.error.cancelled");

      // 包含 "cancel" 且含 "invalid" -> 应该命中 cancelled
      assert.equal(errorCodeFor(false, "cancelled due to invalid request"), "xueness.error.cancelled");

      // 包含 "not found" 且含 "required" -> 应该命中 not_found
      assert.equal(errorCodeFor(false, "required file not found"), "xueness.error.not_found");

      // 包含 "no such" 且含 "invalid" -> 应该命中 not_found
      assert.equal(errorCodeFor(false, "no such table (invalid name)"), "xueness.error.not_found");

      // 包含 "invalid" -> invalid_argument
      assert.equal(errorCodeFor(false, "invalid token"), "xueness.error.invalid_argument");

      // 包含 "required" -> invalid_argument
      assert.equal(errorCodeFor(false, "argument is required"), "xueness.error.invalid_argument");

      // 其他任意非空错误 -> tool_failed
      assert.equal(errorCodeFor(false, "segmentation fault"), "xueness.error.tool_failed");
      assert.equal(errorCodeFor(false, ""), "xueness.error.tool_failed");
    });
  });

  describe("isXuenessEventV1", () => {
    it("validates all 7 valid event types", () => {
      for (const ev of sampleEvents) {
        assert.equal(isXuenessEventV1(ev), true, `event type ${ev.type} should be valid`);
      }
    });

    it("rejects non-objects and primitives", () => {
      assert.equal(isXuenessEventV1(null), false);
      assert.equal(isXuenessEventV1(undefined), false);
      assert.equal(isXuenessEventV1("string"), false);
      assert.equal(isXuenessEventV1(123), false);
      assert.equal(isXuenessEventV1([]), false);
    });

    it("rejects invalid seq or schema", () => {
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], schema: "wrong" }), false);
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], seq: 0 }), false);
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], seq: -1 }), false);
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], seq: 1.2 }), false);
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], seq: "1" }), false);
    });

    it("rejects missing or wrong-typed specific fields", () => {
      // session.status: steps is string
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], steps: "4" }), false);
      // turn.user: missing preview
      const { preview, ...missingPreview } = sampleEvents[1] as any;
      assert.equal(isXuenessEventV1(missingPreview), false);
      // tool.call: missing name
      const { name, ...missingName } = sampleEvents[2] as any;
      assert.equal(isXuenessEventV1(missingName), false);
      // tool.result: missing ok
      const { ok, ...missingOk } = sampleEvents[3] as any;
      assert.equal(isXuenessEventV1(missingOk), false);
      // session.completion: negative evidenceCount
      assert.equal(isXuenessEventV1({ ...sampleEvents[5], evidenceCount: -1 }), false);
      // session.pending_question: question not string
      assert.equal(isXuenessEventV1({ ...sampleEvents[6], question: 123 }), false);
      // unknown event type
      assert.equal(isXuenessEventV1({ ...sampleEvents[0], type: "unknown.type" }), false);
    });
  });

  describe("parseEventsEnvelope", () => {
    const validEnvelope = {
      schema: "xueness.events.v1",
      protocolVersion: 1,
      sessionId: "s1",
      status: "completed",
      steps: 4,
      mode: "build",
      events: sampleEvents,
      cursor: 0,
      nextCursor: 7,
      head: 7,
      hasMore: false,
    };

    it("parses valid envelope successfully", () => {
      const parsed = parseEventsEnvelope(validEnvelope);
      assert.ok(parsed !== null);
      assert.equal(parsed?.sessionId, "s1");
      assert.equal(parsed?.events.length, 7);
    });

    it("returns null for malformed envelope", () => {
      assert.equal(parseEventsEnvelope(null), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, schema: "xueness.events.v2" }), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, protocolVersion: 2 }), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, cursor: -1 }), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, head: -1 }), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, hasMore: "false" }), null);
      assert.equal(parseEventsEnvelope({ ...validEnvelope, events: "not-array" }), null);
      assert.equal(
        parseEventsEnvelope({ ...validEnvelope, events: [{ schema: "bad" }] }),
        null,
      );
    });
  });

  describe("toLegacyEvent", () => {
    it("projects supported event types to legacy XuenessEvent format", () => {
      const toolCall = sampleEvents[2];
      assert.deepEqual(toLegacyEvent(toolCall), {
        type: "tool_call",
        id: "call-1",
        name: "write",
        subject: "file.txt",
      });

      const toolResult = sampleEvents[3];
      assert.deepEqual(toLegacyEvent(toolResult), {
        type: "tool_result",
        id: "call-1",
        subject: "file.txt",
        ok: true,
        error: "",
      });

      const asst = sampleEvents[4];
      assert.deepEqual(toLegacyEvent(asst), {
        type: "assistant",
        preview: "Done writing file",
      });

      const user = sampleEvents[1];
      assert.deepEqual(toLegacyEvent(user), {
        type: "user",
        preview: "hello",
      });

      const comp = sampleEvents[5];
      assert.deepEqual(toLegacyEvent(comp), {
        type: "completion",
        verified: true,
        summary: "Finished",
      });
    });

    it("returns null for session.status and session.pending_question", () => {
      assert.equal(toLegacyEvent(sampleEvents[0]), null);
      assert.equal(toLegacyEvent(sampleEvents[6]), null);
    });
  });
});
