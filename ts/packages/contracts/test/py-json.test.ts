import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PyJsonDecodeError, pyJsonLoads, pyJsonLoadsBytes } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const DOCS: string[] = [
  "", " ", "{", "[", "[1,]", '{"a":1,}', '{"a" 1}', '{"a":}', "{,}", "[,1]", '"abc', '"a\\x"', '"\\u12"',
  '"\\u12345"', '"\\uZZZZ"', '"\\ud83d\\ude00"', '"\\ud83d"', '"\\ud83d\\u0041"', '"\\ud83d\\uZZZZ"',
  '"\\ud800\\udc00', '"\\u1234', '"\\', '"\t"', '"a\nb"', "NaN", "-Infinity", "Infinity", "[NaN, 1]", "nan",
  "-", "-a", "01", "1.", "1.e5", "1e", "1e+", "1E-2", "-0", "-0.0", "1e400", "9007199254740993", "0.1",
  "\ufeff[]", " [1] x", '{"a":1,"a":2}', '{"a":{"b":1,"b":2},"c":', '{"a":1,"a":2,', '[{"x":1,"x":2}, NaN]',
  '{"__proto__": 1, "constructor": 2}', '{"a":1, "b":[1,2,{"c":null}]}', '中文 "x"', '"中文😀\\n"', "[1,\n2,\n3 x]",
  '\n\n  {"a"\n:1 ,"b":2,}', "true", "tru", "nul", "falsey", "[true false]", '{"a":1 "b":2}', '{"a":1}}', "[]]",
  '"\u0000"', '"\\/"', '"\\b\\f\\n\\r\\t\\"\\\\"', "[1, 2", '{"a": [', '["😀😀", x]', '{"😀":1,\n "é": [1,, 2]}',
  '{"k": "v", "k": "w"}', '  {}  ', "[ ]", '{"a":-0}', "[1e5, 1E+2, -1.5e-3]", "\r\n\t[\r\n]\t",
];

type Tagged = null | boolean | string | { n: number } | Tagged[] | { d: [string, Tagged][] };

function tag(value: unknown): Tagged {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return { n: value };
  if (Array.isArray(value)) return value.map(tag);
  return { d: Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, tag(item)]) };
}

function untagPython(value: unknown): Tagged {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(untagPython);
  const record = value as { i?: string; f?: string; d?: [string, unknown][] };
  if (record.i !== undefined) return { n: Number(record.i) };
  if (record.f !== undefined) return { n: record.f === "nan" ? Number.NaN : record.f === "inf" ? Infinity : record.f === "-inf" ? -Infinity : Number(record.f) };
  return { d: (record.d ?? []).map(([key, item]) => [key, untagPython(item)]) };
}

function outcome(doc: string, strict: boolean, errorDialect: "3.11" | "3.13" = "3.13"): unknown {
  try {
    return { ok: tag(pyJsonLoads(doc, { errorDialect, ...(strict ? { rejectDuplicates: true, rejectNonFinite: true } : {}) })) };
  } catch (error) {
    if (error instanceof PyJsonDecodeError) {
      return { err: "JSONDecodeError", msg: error.message, pos: error.pos, lineno: error.lineno, colno: error.colno };
    }
    return { err: (error as Error).name, msg: (error as Error).message };
  }
}

const ORACLE = `
import json, sys
docs = json.loads(sys.stdin.read())
class DuplicateKey(ValueError):
    pass
def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKey('duplicate JSON key')
        result[key] = value
    return result
def nonfinite(_value):
    raise ValueError('nonfinite JSON number')
def tag(v):
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return {'i': str(v)}
    if isinstance(v, float):
        return {'f': repr(v)}
    if isinstance(v, list):
        return [tag(x) for x in v]
    return {'d': [[k, tag(x)] for k, x in v.items()]}
def run(doc, strict):
    try:
        value = json.loads(doc, object_pairs_hook=unique, parse_constant=nonfinite) if strict else json.loads(doc)
        return {'ok': tag(value)}
    except json.JSONDecodeError as e:
        return {'err': 'JSONDecodeError', 'msg': str(e), 'pos': e.pos, 'lineno': e.lineno, 'colno': e.colno}
    except ValueError as e:
        return {'err': type(e).__name__, 'msg': str(e)}
print(json.dumps([[run(d, False), run(d, True)] for d in docs], ensure_ascii=True))
`;

describe("pyJsonLoads", () => {
  it("keeps the first position of a repeated key and plain __proto__ keys", () => {
    const value = pyJsonLoads('{"a":1,"b":2,"a":3,"__proto__":{"x":1}}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(value), ["a", "b", "__proto__"]);
    assert.equal(value.a, 3);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
  });

  it("decodes UTF-8 bytes with an optional BOM", () => {
    assert.deepEqual(pyJsonLoadsBytes(new TextEncoder().encode("\ufeff{\"a\":\"中\"}")), { a: "中" });
    assert.throws(() => pyJsonLoadsBytes(new Uint8Array([0x22, 0xff, 0x22])));
  });

  it("matches CPython json.loads values and error coordinates", { skip: pythonUnavailableReason() ?? false }, () => {
    const errorDialect = runPython("import sys; print(int(sys.version_info >= (3, 13)))").trim() === "1" ? "3.13" : "3.11";
    const expected = JSON.parse(runPython(ORACLE, JSON.stringify(DOCS))) as [unknown, unknown][];
    DOCS.forEach((doc, index) => {
      const [loose, strict] = expected[index] as [Record<string, unknown>, Record<string, unknown>];
      for (const [mode, want] of [[false, loose], [true, strict]] as const) {
        const normalized = want.ok === undefined ? want : { ok: untagPython(want.ok) };
        assert.deepStrictEqual(outcome(doc, mode, errorDialect), normalized, `${JSON.stringify(doc)} strict=${mode}`);
      }
    });
  });

  it("retains explicit diagnostics for both supported CPython dialects", () => {
    assert.throws(() => pyJsonLoads("[1,]", { errorDialect: "3.11" }), { message: "Expecting value: line 1 column 4 (char 3)" });
    assert.throws(() => pyJsonLoads("[1,]", { errorDialect: "3.13" }), { message: "Illegal trailing comma before end of array: line 1 column 3 (char 2)" });
  });
});
