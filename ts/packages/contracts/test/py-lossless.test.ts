import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JsonFloat, pyEndsWith, pyEquals, pyJsonDumps, pyJsonLoads, pyLen, pyRound, pyStartsWith, pySubstring, pyUtcIsoformat,
} from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;

// Random Python values: integral floats, -0.0, huge ints, NaN/inf, astral text
// and lone surrogates, deep nesting and empty containers.
const VALUES = String.raw`
import json, math, random, sys
rnd = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
ATOMS = ['a', 'Z', ' ', '\n', '"', '\\', '中', '😀', '\u2028', '\x7f', '\x01', '\ud800', '\udfff', 'é', '\ufeff']
def text():
    # A JS string cannot hold two adjacent lone surrogates apart from the pair
    # they form; JSON decoding never yields them in Python either.
    return ''.join(rnd.choice(ATOMS) for _ in range(rnd.randrange(6))).replace('\ud800\udfff', '\ud800-\udfff')
def scalar():
    roll = rnd.randrange(12)
    if roll == 0: return None
    if roll == 1: return rnd.random() < .5
    if roll == 2: return rnd.randrange(-10**6, 10**6)
    if roll == 3: return rnd.choice([2**53, 2**53 + 1, -2**63, 10**30, 0, -1])
    if roll == 4: return rnd.choice([0.0, -0.0, 1.0, 2.0, 1e16, 1e22, -3.0, 123456789.0])
    if roll == 5: return rnd.choice([0.1, 1e-7, 5e-324, 1.7976931348623157e308, 0.30000000000000004, 1e-5, 12.5])
    if roll == 6: return rnd.choice([math.nan, math.inf, -math.inf])
    if roll == 7: return rnd.uniform(-1e6, 1e6)
    return text()
def value(depth=0):
    if depth > 3 or rnd.random() < .45: return scalar()
    if rnd.random() < .5: return [value(depth + 1) for _ in range(rnd.randrange(4))]
    return {text() or 'k': value(depth + 1) for _ in range(rnd.randrange(4))}
`;

describe("lossless JSON round trip", { skip }, () => {
  it("re-encodes Python's journal, digest and wire forms byte for byte", () => {
    const out = runPython(VALUES + String.raw`
cases = []
for _ in range(400):
    v = value()
    cases.append([json.dumps(v), json.dumps(v, ensure_ascii=False, indent=2),
                  json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':')),
                  json.dumps(v, ensure_ascii=False, separators=(',', ':')), json.dumps(v)])
print(json.dumps(cases))
`);
    const cases = pyJsonLoads(out) as string[][];
    for (const [doc, indented, digest, compact, plain] of cases) {
      const value = pyJsonLoads(doc as string, { lossless: true });
      assert.equal(pyJsonDumps(value, { indent: 2 }), indented, doc);
      assert.equal(pyJsonDumps(value, { sortKeys: true, separators: [",", ":"] }), digest, doc);
      assert.equal(pyJsonDumps(value, { separators: [",", ":"] }), compact, doc);
      assert.equal(pyJsonDumps(value, { ensureAscii: true }), plain, doc);
    }
  });

  it("keeps integral floats and unsafe ints distinct", () => {
    const value = pyJsonLoads('{"a": 2.0, "b": 2, "c": -0.0, "d": -0, "e": 12345678901234567890, "f": 1e2}', { lossless: true }) as Record<string, unknown>;
    assert.ok(value.a instanceof JsonFloat);
    assert.equal(value.b, 2);
    assert.ok(value.c instanceof JsonFloat && Object.is(value.c.value, -0));
    assert.ok(Object.is(value.d, 0));
    assert.equal(value.e, 12345678901234567890n);
    assert.equal(pyJsonDumps(value), '{"a": 2.0, "b": 2, "c": -0.0, "d": 0, "e": 12345678901234567890, "f": 100.0}');
  });
});

describe("Python value equality", { skip }, () => {
  it("matches == for numbers across types, NaN identity and dict order", () => {
    const out = runPython(VALUES + String.raw`
def mutate(v):
    if isinstance(v, dict):
        items = list(v.items()); rnd.shuffle(items)
        return {k: mutate(x) for k, x in items}
    if isinstance(v, list):
        return [mutate(x) for x in v]
    if type(v) is int and rnd.random() < .3: return float(v) if abs(v) < 2**53 else v
    if type(v) is float and v.is_integer() and rnd.random() < .3: return int(v)
    if v is True and rnd.random() < .3: return 1
    if rnd.random() < .05: return scalar()
    return v
cases = []
for _ in range(500):
    a = value(); b = mutate(a) if rnd.random() < .8 else value()
    cases.append([json.dumps(a), json.dumps(b), a == b])
print(json.dumps(cases))
`);
    // The oracle compares objects decoded in one process: every NaN is json's
    // shared constant, so identity makes nested NaN equal, as in pyEquals.
    for (const [left, right, expected] of pyJsonLoads(out) as [string, string, boolean][]) {
      const a = pyJsonLoads(left, { lossless: true });
      const b = pyJsonLoads(right, { lossless: true });
      assert.equal(pyEquals(a, b), expected, `${left} == ${right}`);
    }
  });
});

describe("Python str and round helpers", { skip }, () => {
  it("count, slice and compare code points like str", () => {
    const out = runPython(VALUES + String.raw`
cases = []
for _ in range(300):
    s = (text() + text()).replace('\ud800\udfff', '\ud800-\udfff')
    p = s[:rnd.randrange(len(s) + 1)] if rnd.random() < .6 else text()
    a, b = rnd.randrange(-8, 9), rnd.randrange(-8, 9)
    cases.append([s, p, len(s), s[a:b], s[a:], s.startswith(p), s.endswith(p), a, b])
print(json.dumps(cases))
`);
    for (const [text, prefix, length, slice, tail, starts, ends, start, end] of pyJsonLoads(out) as [string, string, number, string, string, boolean, boolean, number, number][]) {
      assert.equal(pyLen(text), length);
      assert.equal(pySubstring(text, start, end), slice);
      assert.equal(pySubstring(text, start), tail);
      assert.equal(pyStartsWith(text, prefix), starts);
      assert.equal(pyEndsWith(text, prefix), ends);
    }
  });

  it("rounds like round(x, n), ties to even on the exact binary value", () => {
    const out = runPython(String.raw`
import json, random
rnd = random.Random(3)
values = [0.0625, 2.5, 0.125, 1.0005, 2.675, 0.5, 1.5, -0.5, -2.5, 1e-9, 123.4565, 5e-324, 1e300]
values += [rnd.uniform(-1000, 1000) for _ in range(300)] + [rnd.randrange(10**6) / 1000 for _ in range(200)]
print(json.dumps([[x, n, repr(round(x, n))] for x in values for n in (0, 1, 3, 6)]))
`);
    for (const [value, digits, expected] of pyJsonLoads(out) as [number, number, string][]) {
      const result = pyRound(value, digits);
      const repr = pyJsonDumps(new JsonFloat(result));
      assert.equal(repr, expected, `round(${value}, ${digits})`);
    }
  });

  it("formats UTC timestamps like datetime.isoformat", () => {
    const micros = [0n, 1n, 999_999n, 1_000_000n, 1_760_000_000_123_456n, 1_760_000_000_000_000n, 1_760_000_000_120_000n, -1n, 253_402_300_799_999_999n];
    const out = runPython(String.raw`
import json, sys
from datetime import datetime, timedelta, timezone
epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
rows = []
for m in json.loads(sys.stdin.read()):
    d = epoch + timedelta(microseconds=int(m))
    rows.append([d.isoformat(), d.isoformat(timespec='milliseconds'), d.isoformat(timespec='seconds')])
print(json.dumps(rows))
`, JSON.stringify(micros.map(String)));
    const rows = pyJsonLoads(out) as string[][];
    micros.forEach((value, index) => {
      assert.deepEqual([pyUtcIsoformat(value), pyUtcIsoformat(value, "milliseconds"), pyUtcIsoformat(value, "seconds")], rows[index]);
    });
  });
});
