/**
 * Differential test: the TypeScript port against `xueness/events.py`.
 *
 * Thousands of generated sessions go through both implementations. Events,
 * envelopes and SSE bodies must match exactly, including key order.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveEvents, pageEvents, sseBody } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";

const CASES = Number(process.env.XUENESS_DIFF_CASES ?? 3000);

const ORACLE = `
import json, sys
from xueness import events
for line in sys.stdin:
    case = json.loads(line)
    derived = events.derive_events(case["session"])
    envelope = events.page_events(case["session"], derived, case["cursor"], case["limit"])
    out = {"events": derived, "envelope": envelope, "sse": events.sse_body(derived).decode("utf-8")}
    sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\\n")
`;

describe("events v1 differential vs Python", { skip: pythonUnavailableReason() ?? false }, () => {
  it(`matches Python on ${CASES} generated sessions`, () => {
    const factory = new SessionFactory(20261017);
    const cases = Array.from({ length: CASES }, () => ({
      session: factory.session(),
      cursor: factory.int(12),
      limit: factory.pick([1, 2, 3, 200, 0, -5, 1000]),
    }));
    const lines = runPython(ORACLE, cases.map((item) => JSON.stringify(item)).join("\n") + "\n").trimEnd().split("\n");
    assert.equal(lines.length, cases.length);
    cases.forEach((item, index) => {
      const expected = JSON.parse(lines[index] as string);
      const events = deriveEvents(item.session);
      const context = `case #${index}: ${JSON.stringify(item.session).slice(0, 400)}`;
      assert.deepStrictEqual(events, expected.events, context);
      assert.equal(JSON.stringify(events), JSON.stringify(expected.events), `key order, ${context}`);
      const envelope = pageEvents(item.session, events, item.cursor, item.limit);
      assert.equal(JSON.stringify(envelope), JSON.stringify(expected.envelope), `envelope, ${context}`);
      assert.equal(sseBody(events), expected.sse, `sse, ${context}`);
    });
  });
});
