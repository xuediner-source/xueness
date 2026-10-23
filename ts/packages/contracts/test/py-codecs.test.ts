import assert from "node:assert/strict";
import { it } from "node:test";
import { pyDecodeUtf8 } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

/** Lead, continuation and boundary bytes of every UTF-8 sequence class. */
const BYTES = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff];

it("raises CPython's UnicodeDecodeError text for strict and surrogatepass UTF-8", { skip: pythonUnavailableReason() ?? false }, () => {
  const cases: number[][] = [];
  for (const a of BYTES) {
    cases.push([a]);
    for (const b of BYTES) {
      cases.push([a, b]);
      for (const c of [0x41, 0x80, 0x9f, 0xa0, 0xbf, 0xc2, 0xed]) { cases.push([a, b, c]); for (const d of [0x41, 0x80, 0xbf, 0xe0]) cases.push([0x41, a, b, c, d]); }
    }
  }
  cases.push([...Buffer.from("中文 ok"), 0xe4, 0xb8], [...Buffer.from("{\"a\": \""), 0xc3, 0x28, 0x22, 0x7d]);
  const hex = cases.map((bytes) => Buffer.from(bytes).toString("hex"));
  const expected = JSON.parse(runPython(`
import json,sys
def attempt(raw, errors):
    try: raw.decode('utf-8', errors); return None
    except UnicodeDecodeError as exc: return str(exc)
print(json.dumps([[attempt(bytes.fromhex(h), e) for e in ('strict', 'surrogatepass')] for h in json.load(sys.stdin)]))`, JSON.stringify(hex))) as (string | null)[][];
  const actual = hex.map((text) => [false, true].map((surrogatePass) => {
    try { pyDecodeUtf8(Buffer.from(text, "hex"), surrogatePass); return null; } catch (error) { return (error as Error).message; }
  }));
  assert.deepEqual(actual, expected);
});
