import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonFloat } from "@xueness/contracts";
import { SCHEMA, digest } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";
import { cleanDirectory, HISTORY_ID, historyDirectory, recordLine, scanResult, signedRecord, writeBytes, type Row } from "./history-local.ts";
import { oracle } from "./oracle.ts";

const skip = pythonUnavailableReason() ?? false;

function revision(seq: unknown, state: Row, operations: unknown[], parentHash = ""): Row {
  return signedRecord({
    schema: SCHEMA, seq, sessionId: HISTORY_ID, timestamp: "2026-10-18T00:00:00+00:00", parentHash,
    stateHash: digest(state), reset: true, operations,
  });
}

function flipHexField(data: Buffer, field: string, offset = 0): Buffer {
  const text = data.toString("utf8");
  const start = text.indexOf(`"${field}":"`);
  assert.notEqual(start, -1, `missing ${field}`);
  const at = start + field.length + 4 + offset;
  const char = text[at]!;
  const changed = char === "0" ? "1" : "0";
  return Buffer.from(text.slice(0, at) + changed + text.slice(at + 1), "utf8");
}

describe("session history corruption scan", { skip }, () => {
  it("matches Python across torn tails, byte flips, seq anomalies and malformed operations", (t) => {
    const directory = historyDirectory("scan-fuzz");
    t.after(() => cleanDirectory(directory));
    const state: Row = { id: HISTORY_ID, task: "base" };
    const first = revision(1, state, [{ op: "set", path: [], value: state }]);
    const valid = recordLine(first);
    const cases: [string, Buffer][] = [
      ["valid", valid],
      ["torn-json-tail", Buffer.concat([valid, Buffer.from('{"schema":"partial')])],
      ["torn-invalid-utf8-tail", Buffer.concat([valid, Buffer.from([0xff, 0xfe, 0x80])])],
      ["flipped-record-hash", flipHexField(valid, "recordHash")],
      ["flipped-state-hash", flipHexField(valid, "stateHash")],
      ["invalid-utf8-byte", Buffer.from(valid.map((byte, index) => index === 0 ? byte ^ 0x80 : byte))],
      ["empty-object", Buffer.from("{}\n")],
      ["list-row", Buffer.from("[]\n")],
      ["null-row", Buffer.from("null\n")],
      ["string-row", Buffer.from('"record"\n')],
      ["number-row", Buffer.from("7\n")],
    ];

    for (const [label, seq] of [["negative", -1], ["zero", 0], ["float", new JsonFloat(1)], ["boolean", true], ["string", "1"]] as const) {
      cases.push([`seq-${label}`, recordLine(revision(seq, state, [{ op: "set", path: [], value: state }]))]);
    }

    const secondState = { ...state, task: "gap is legal" };
    const gap = revision(4, secondState, [{ op: "set", path: [], value: secondState }], first.recordHash as string);
    cases.push(["increasing-seq-gap", Buffer.concat([valid, recordLine(gap)])]);
    const duplicate = revision(1, secondState, [{ op: "set", path: [], value: secondState }], first.recordHash as string);
    cases.push(["duplicate-seq", Buffer.concat([valid, recordLine(duplicate)])]);

    const malformed = (name: string, operations: unknown[]) => {
      const row = revision(2, state, operations, first.recordHash as string);
      cases.push([name, Buffer.concat([valid, recordLine(row)])]);
    };
    malformed("unknown-operation-with-recomputed-hash", [{ op: "mystery", path: ["id"] }]);
    malformed("missing-parent-with-recomputed-hash", [{ op: "set", path: ["absent", "child"], value: 1 }]);
    malformed("invalid-root-operation-with-recomputed-hash", [{ op: "delete", path: [] }]);
    malformed("missing-operation-name-with-recomputed-hash", [{ path: [] }]);
    const wrongStateHash: Row = { ...first, stateHash: "0".repeat(64) };
    delete wrongStateHash.recordHash;
    cases.push(["wrong-state-hash-with-valid-record-hash", recordLine(signedRecord(wrongStateHash))]);

    const fuzz = new SessionFactory(0xc077);
    for (let index = 0; index < 36; index += 1) {
      if (index % 3 === 0) {
        const suffix = Buffer.from(`partial-${fuzz.int(1_000_000).toString(16)}`, "ascii");
        cases.push([`seeded-torn-${index}`, Buffer.concat([valid, suffix])]);
      } else if (index % 3 === 1) {
        const field = fuzz.chance(0.5) ? "recordHash" : "stateHash";
        cases.push([`seeded-flip-${index}`, flipHexField(valid, field, fuzz.int(8))]);
      } else {
        const seq = fuzz.pick([-2, 0, new JsonFloat(2), true, "2"]);
        cases.push([`seeded-seq-${index}`, recordLine(revision(seq, state, [{ op: "set", path: [], value: state }]))]);
      }
    }

    const paths = cases.map(([label, bytes], index) => {
      const path = join(directory, `${index}-${label}.jsonl`);
      writeBytes(path, bytes);
      return path;
    });
    const expected = oracle({ op: "scan", paths }) as Row[];
    const actual = paths.map(scanResult);
    assert.deepEqual(actual, expected, cases.map(([label]) => label).join(", "));

    const validSummary = { ok: true, stateHash: digest(state), records: 1, size: valid.length, seqs: [1] };
    const secondSummary = {
      ok: true, stateHash: digest(secondState), records: 2, size: valid.length + recordLine(gap).length, seqs: [1, 4],
    };
    const expectedByLabel: Record<string, Row> = {
      valid: validSummary,
      "torn-json-tail": validSummary,
      "torn-invalid-utf8-tail": validSummary,
      "flipped-record-hash": { ok: false, error: "ValueError" },
      "flipped-state-hash": { ok: false, error: "ValueError" },
      "invalid-utf8-byte": { ok: false, error: "UnicodeDecodeError" },
      "empty-object": { ok: false, error: "ValueError" },
      "list-row": { ok: false, error: "AttributeError" },
      "null-row": { ok: false, error: "AttributeError" },
      "string-row": { ok: false, error: "AttributeError" },
      "number-row": { ok: false, error: "AttributeError" },
      "seq-negative": { ok: false, error: "ValueError" },
      "seq-zero": { ok: false, error: "ValueError" },
      "seq-float": { ok: false, error: "ValueError" },
      "seq-boolean": { ok: false, error: "ValueError" },
      "seq-string": { ok: false, error: "ValueError" },
      "increasing-seq-gap": secondSummary,
      "duplicate-seq": { ok: false, error: "ValueError" },
      "unknown-operation-with-recomputed-hash": { ok: false, error: "ValueError" },
      "missing-parent-with-recomputed-hash": { ok: false, error: "KeyError" },
      "invalid-root-operation-with-recomputed-hash": { ok: false, error: "ValueError" },
      "missing-operation-name-with-recomputed-hash": { ok: false, error: "KeyError" },
      "wrong-state-hash-with-valid-record-hash": { ok: false, error: "ValueError" },
    };
    for (const [label, wanted] of Object.entries(expectedByLabel)) {
      const index = cases.findIndex(([name]) => name === label);
      assert.notEqual(index, -1, `missing case ${label}`);
      assert.deepEqual(actual[index], wanted, label);
    }
  });
});
