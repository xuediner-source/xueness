import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyFloatRepr, pyJsonDumps, pyLstrip, pyRepr, pyRstrip, pySlice, pyStrip, pyTruthy } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const VALUES: unknown[] = [
  null, true, false, 0, -7, 2.5, 1e-7, 1e-5, 0.0001, 123456789.125, 1.5e300, -0.25,
  "", "plain", "it's", 'say "hi"', `both ' and "`, "tab\tnew\nline\r", "\u0000\u001f\u007f", "\u00a0\u00ad\u0085",
  "中文😀", "\u200b\u2028\u2029\ufeff", "\ud83d\udc68\u200d\ud83d\udc69", "back\\slash",
  [], [1, "a", null], { a: 1, "b'": [true, { c: "d" }] }, {},
];

describe("python compat", () => {
  it("slices by code point, not UTF-16 unit", () => {
    assert.equal(pySlice("😀😀😀", 2), "😀😀");
    assert.equal(pySlice("ab", 5), "ab");
  });

  it("strips Python whitespace, which differs from trim()", () => {
    assert.equal(pyStrip("\u001c\u0085 x \u3000"), "x");
    assert.equal(pyStrip("\ufeffx"), "\ufeffx");
    assert.equal(pyLstrip("\u3000 x "), "x ");
    assert.equal(pyRstrip(" x\r\n\u2029"), " x");
  });

  it("follows Python truthiness for containers", () => {
    assert.deepEqual([[], {}, [0], { a: 1 }, "", "0", 0, 0.5].map(pyTruthy), [false, false, true, true, false, true, false, true]);
  });

  it("refuses NaN under allow_nan=False", () => {
    assert.throws(() => pyJsonDumps({ a: Number.NaN }, { allowNan: false }), { name: "ValueError" });
    assert.equal(pyJsonDumps([Infinity]), "[Infinity]");
  });

  it("formats floats like repr()", () => {
    assert.deepEqual([1e16, 1.5e16, 1e-5, 0.0001, 2.5, -0, 1e300].map(pyFloatRepr), ["1e+16", "1.5e+16", "1e-05", "0.0001", "2.5", "-0.0", "1e+300"]);
  });

  it("matches Python str(), repr() and json.dumps()", { skip: pythonUnavailableReason() ?? false }, () => {
    const output = runPython(`
import json, sys
values = json.loads(sys.stdin.read())
print(json.dumps([[str(v), repr(v), json.dumps(v, ensure_ascii=False), json.dumps(v), json.dumps(v, separators=(",", ":"), ensure_ascii=False)] for v in values], ensure_ascii=True))
`, JSON.stringify(VALUES));
    const expected = JSON.parse(output) as string[][];
    VALUES.forEach((value, index) => {
      const [str, repr, dumps, asciiDumps, compact] = expected[index] as string[];
      assert.equal(typeof value === "string" ? value : pyRepr(value), str, `str #${index}`);
      assert.equal(pyRepr(value), repr, `repr #${index}`);
      assert.equal(pyJsonDumps(value), dumps, `json #${index}`);
      assert.equal(pyJsonDumps(value, { ensureAscii: true }), asciiDumps, `json ascii #${index}`);
      assert.equal(pyJsonDumps(value, { separators: [",", ":"] }), compact, `json compact #${index}`);
    });
  });
});
