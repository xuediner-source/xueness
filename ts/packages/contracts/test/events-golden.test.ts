import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  deriveEvents, errorCode, headSeq, isXuenessEventV1, pageEvents, parseEventsEnvelope, sseBody,
} from "../src/index.ts";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";

const golden = JSON.parse(readFileSync(join(PROJECT_ROOT, "tools", "protocol-v1-golden.json"), "utf8"));

describe("events v1 golden", () => {
  const events = deriveEvents(golden.session);

  it("derives the frozen event list value for value and key for key", () => {
    assert.deepStrictEqual(events, golden.expected.events);
    assert.equal(JSON.stringify(events), JSON.stringify(golden.expected.events));
    assert.equal(headSeq(events), golden.expected.head);
  });

  it("numbers seq densely from 1 and validates every event", () => {
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    for (const event of events) assert.equal(isXuenessEventV1(event), true, `seq ${event.seq}`);
  });

  it("pages exactly like the golden envelopes", () => {
    for (const { request, expect } of golden.expected.envelopes) {
      const envelope = pageEvents(golden.session, events, request.cursor, request.limit);
      assert.deepEqual(envelope.events.map((event) => event.seq), expect.eventSeqs);
      for (const key of ["cursor", "nextCursor", "head", "hasMore", "schema", "protocolVersion", "sessionId", "status", "steps", "mode"]) {
        if (key in expect) assert.deepEqual((envelope as unknown as Record<string, unknown>)[key], expect[key], key);
      }
      assert.ok(parseEventsEnvelope(envelope));
    }
  });

  it("maps every golden (ok, error) pair to its error code", () => {
    for (const { ok, error, expect } of golden.errorCodes) assert.equal(errorCode(ok, error), expect, error);
  });

  it("clamps limit to 1..500 and treats a cursor past head as an empty page", () => {
    assert.equal(pageEvents(golden.session, events, 0, 0).events.length, 1);
    assert.equal(pageEvents(golden.session, events, 0, 10_000).events.length, events.length);
    const past = pageEvents(golden.session, events, 99, 5);
    assert.deepEqual([past.events.length, past.nextCursor, past.hasMore], [0, 99, false]);
  });

  it("renders SSE frames with id, event and Python-style JSON data", () => {
    const body = sseBody(events.slice(0, 1));
    assert.equal(body, 'id: 1\nevent: session.status\ndata: {"schema": "xueness.event.v1", "seq": 1, '
      + '"sessionId": "80a6e495ec6243cc88b503521e93ff6e", "type": "session.status", "status": "completed", '
      + '"steps": 4, "mode": "build"}\n\n');
    assert.equal(sseBody([]), "");
  });
});

describe("events v1 validator", () => {
  const base = golden.expected.events[0];
  const bad: unknown[] = [
    null, undefined, 123, "not-an-event", {},
    { ...base, schema: "xueness.event.v2" }, { ...base, seq: 0 }, { ...base, seq: -1 }, { ...base, seq: 1.5 },
    { ...base, seq: "1" }, { ...base, sessionId: 123 }, { ...base, type: "unknown.type" }, { ...base, type: "constructor" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.status", steps: 0, mode: "" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.status", status: "ok", steps: "0", mode: "" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "turn.user", turnId: "t1" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "assistant.text", preview: "hi" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "tool.call", turnId: "t1", toolCallId: "c1", name: "write" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "tool.result", turnId: "t1", toolCallId: "c1", name: "write", subject: "", ok: "true" },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.completion", verified: true, summary: "done", evidenceCount: -1 },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.completion", verified: true, summary: "done", evidenceCount: 1.5 },
    { schema: "xueness.event.v1", seq: 1, sessionId: "s1", type: "session.pending_question" },
  ];

  it("rejects every malformed event the frontend validator rejects", () => {
    bad.forEach((event, index) => assert.equal(isXuenessEventV1(event), false, `bad #${index}`));
  });
});
