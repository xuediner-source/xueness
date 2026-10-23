import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyDeepCopy, pyJsonDumps } from "@xueness/contracts";
import { apply, difference, digest } from "../src/history-ops.ts";
import { mutate, storeSession } from "./fixtures.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";
import { oracle } from "./oracle.ts";
import type { Row } from "./history-local.ts";

const skip = pythonUnavailableReason() ?? false;
type Operation = { op: string; path: unknown[]; [key: string]: unknown };

/** Python set-difference deletion order is process-hash-dependent. */
function stableDeletes(operations: Operation[]): Operation[] {
  const out: Operation[] = [];
  let pending: Operation[] = [];
  const flush = () => {
    pending.sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)));
    out.push(...pending);
    pending = [];
  };
  for (const operation of operations) {
    if (operation.op === "delete") pending.push(operation);
    else {
      flush();
      out.push(operation);
    }
  }
  flush();
  return out;
}

describe("session history differences", { skip }, () => {
  it("matches Python for seeded edits, ignoring only delete order", () => {
    const f = new SessionFactory(0x51a7);
    const pairs: [Row, Row][] = [];
    for (let index = 0; index < 180; index += 1) {
      const before = storeSession(f, "0123456789abcdef0123456789abcdef");
      const after = pyDeepCopy(before);
      mutate(f, after);
      pairs.push([before, after]);
    }
    pairs.push([
      { a: 1, b: "two", c: { x: true, y: "old", z: [1, 2] }, d: ["x"], text: "a" },
      { c: { z: [1, 2], added: null }, d: ["x", "y"], text: "ab", added: false },
    ]);

    const expected = oracle({ op: "difference", pairs }) as Operation[][];
    pairs.forEach(([before, after], index) => {
      const actual = stableDeletes(difference(before, after) as Operation[]);
      // The lossless oracle wraps integral floats (e.g. 1e300) that the
      // generator may hold as JS numbers; compare their canonical encoding.
      assert.equal(pyJsonDumps(actual, { sortKeys: true }), pyJsonDumps(stableDeletes(expected[index]!), { sortKeys: true }),
        pyJsonDumps([before, after]));
      assert.equal(digest(apply(pyDeepCopy(before), actual)), digest(after), `operations ${index}`);
    });
  });
});
