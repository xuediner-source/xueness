/** H12.02 telemetry ring buffer. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTelemetryBuffer } from "../src/telemetry-buffer.ts";

const session = {
  type: "session",
  at: "2026-10-26T00:00:00.000Z",
  session: "s1",
  task: "t",
  solverModel: "solver",
  criticModel: "critic",
};

describe("telemetry buffer (H12.02)", () => {
  it("bounds capacity and drops oldest first", () => {
    const buf = createTelemetryBuffer({ capacity: 2, redact: false });
    assert.equal(buf.push(session).ok, true);
    assert.equal(buf.push({ ...session, session: "s2" }).ok, true);
    assert.equal(buf.push({ ...session, session: "s3" }).ok, true);
    assert.equal(buf.size, 2);
    assert.deepEqual(buf.snapshot().map((e) => e.session), ["s2", "s3"]);
  });

  it("rejects invalid events without mutating the ring", () => {
    const buf = createTelemetryBuffer({ capacity: 4 });
    assert.equal(buf.push({ kind: "nope" }).ok, false);
    assert.equal(buf.size, 0);
  });

  it("exports stable JSONL and clear empties", () => {
    const buf = createTelemetryBuffer({ capacity: 4, redact: false });
    buf.push(session);
    const text = buf.exportJsonl();
    assert.match(text, /"type":"session"/);
    buf.clear();
    assert.equal(buf.size, 0);
    assert.equal(buf.exportJsonl(), "");
  });
});
